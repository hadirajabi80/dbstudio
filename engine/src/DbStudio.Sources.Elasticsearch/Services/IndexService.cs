using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>Indices, aliases, data streams, templates, index details and fields; create / delete / actions / settings / mappings / aliases.</summary>
public sealed class IndexService
{
    private const string IndexCols = "health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size";

    public async Task<IReadOnlyList<EsIndexSummary>> ListAsync(EsClient c, bool includeHidden, CancellationToken ct)
    {
        var t = c.Transport;
        var catTask = CatIndicesAsync(t, ct);
        var aliasesTask = AliasesAsync(c, ct);
        var settingsTask = t.TryGetAsync("*/_settings/index.hidden,index.creation_date?expand_wildcards=all&flat_settings=true", ct);
        var streamsTask = DataStreamsAsync(c, ct);
        var cat = await catTask.ConfigureAwait(false);
        var aliases = await aliasesTask.ConfigureAwait(false);
        var settings = await settingsTask.ConfigureAwait(false);
        var streams = await streamsTask.ConfigureAwait(false);
        var byIndex = aliases.GroupBy(a => a.Index).ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(a => a.Alias).OrderBy(x => x, StringComparer.Ordinal).ToList());
        var backing = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var ds in streams) foreach (var i in ds.Indices) backing[i] = ds.Name;
        var list = cat.Items().Select(r => MapIndex(r, byIndex, settings, backing)).Where(i => includeHidden || !i.Hidden).ToList();
        var counts = await TopLevelCountsAsync(c, list.Where(i => i.Status == "open").Select(i => i.Name).ToList(), ct).ConfigureAwait(false);
        return list.Select(i => counts.TryGetValue(i.Name, out var n) ? i with { DocsCount = n } : i).OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// `_cat/indices` docs.count counts Lucene documents (nested objects included): one `_msearch` of size-0 searches gives
    /// the document counts users expect. Best effort (cat counts stay on any failure); at most 500 indices.
    /// </summary>
    internal static async Task<Dictionary<string, long>> TopLevelCountsAsync(EsClient c, IReadOnlyList<string> names, CancellationToken ct)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        if (names.Count == 0 || names.Count > 500) return result;
        var sb = new System.Text.StringBuilder();
        foreach (var n in names)
        {
            sb.Append(JsonSerializer.Serialize(new { index = n, ignore_unavailable = true })).Append('\n');
            sb.Append("""{"size":0,"track_total_hits":true}""").Append('\n');
        }
        try
        {
            var res = await c.Transport.NdjsonAsync("_msearch", System.Text.Encoding.UTF8.GetBytes(sb.ToString()), ct).ConfigureAwait(false);
            var i = 0;
            foreach (var r in res.Prop("responses").Items())
            {
                if (i >= names.Count) break;
                if (r.Path("hits.total") is { } tot && (tot.ValueKind == JsonValueKind.Number ? tot.GetInt64() : tot.Long("value")) is { } count) result[names[i]] = count;
                i++;
            }
        }
        catch (EngineException ex) when (ex.Code != ErrorCodes.SourceUnavailable) { /* keep the cat counts */ }
        return result;
    }

    /// <summary>`_cat/indices` incl. hidden indices; servers older than 7.7 reject expand_wildcards there (retry without).</summary>
    private static async Task<JsonElement> CatIndicesAsync(EsTransport t, CancellationToken ct)
    {
        var res = await t.SendAsync(HttpMethod.Get, $"_cat/indices?format=json&bytes=b&expand_wildcards=all&s=index&h={IndexCols}", null, null, ct).ConfigureAwait(false);
        if (res.Ok) return res.Json();
        if (res.Status != 400) throw EsErrors.FromResponse(res);
        return await t.GetAsync($"_cat/indices?format=json&bytes=b&s=index&h={IndexCols}", ct).ConfigureAwait(false);
    }

    internal static EsIndexSummary MapIndex(JsonElement r, IReadOnlyDictionary<string, IReadOnlyList<string>> aliases, JsonElement? settings,
        IReadOnlyDictionary<string, string> backing)
    {
        var name = r.Str("index") ?? "";
        var s = settings?.Prop(name)?.Prop("settings");
        var hiddenSetting = s?.Str("index.hidden") == "true";
        long? created = s?.Long("index.creation_date");
        var dataStream = backing.GetValueOrDefault(name);
        var dot = name.StartsWith('.');
        var health = r.Str("health");
        return new EsIndexSummary(
            Name: name,
            Uuid: r.Str("uuid"),
            Health: health is "green" or "yellow" or "red" ? health : null,
            Status: r.Str("status") == "close" ? "close" : "open",
            Primaries: r.Int("pri"),
            Replicas: r.Int("rep"),
            DocsCount: r.Long("docs.count"),
            DocsDeleted: r.Long("docs.deleted"),
            StoreBytes: r.Long("store.size"),
            PriStoreBytes: r.Long("pri.store.size"),
            Hidden: hiddenSetting || dot,
            System: dot && dataStream is null,
            Aliases: aliases.GetValueOrDefault(name) ?? [],
            DataStream: dataStream,
            CreatedAt: EsJson.Iso(created));
    }

    public async Task<IReadOnlyList<EsAlias>> AliasesAsync(EsClient c, CancellationToken ct)
    {
        var rows = await c.Transport.GetAsync("_cat/aliases?format=json&expand_wildcards=all&h=alias,index,filter,routing.index,routing.search,is_write_index", ct)
            .ConfigureAwait(false);
        return rows.Items().Select(r => new EsAlias(
            r.Str("alias") ?? "", r.Str("index") ?? "", (r.Str("filter") ?? "-") is not ("-" or ""),
            Dash(r.Str("routing.index")), Dash(r.Str("routing.search")),
            r.Str("is_write_index") switch { "true" => true, "false" => false, _ => null }))
            .OrderBy(a => a.Alias, StringComparer.Ordinal).ThenBy(a => a.Index, StringComparer.Ordinal).ToList();
    }

    private static string? Dash(string? s) => s is null or "-" or "" ? null : s;

    public async Task<IReadOnlyList<EsDataStream>> DataStreamsAsync(EsClient c, CancellationToken ct)
    {
        var res = await c.Transport.TryGetAsync("_data_stream?expand_wildcards=all", ct).ConfigureAwait(false);
        if (res is not { } body) return [];
        return body.Prop("data_streams").Items().Select(d => new EsDataStream(
            d.Str("name") ?? "",
            d.Str("status")?.ToLowerInvariant(),
            d.Str("template"),
            d.Long("generation") ?? 0,
            d.Path("timestamp_field.name") is { } tf ? EsJson.AsString(tf) : null,
            d.Prop("indices").Items().Select(i => i.Str("index_name") ?? "").Where(x => x.Length > 0).ToList()))
            .OrderBy(d => d.Name, StringComparer.Ordinal).ToList();
    }

    public async Task<IReadOnlyList<EsTemplate>> TemplatesAsync(EsClient c, CancellationToken ct)
    {
        var t = c.Transport;
        var idxTask = t.TryGetAsync("_index_template", ct);
        var compTask = t.TryGetAsync("_component_template", ct);
        var legacyTask = t.TryGetAsync("_template", ct);
        var list = new List<EsTemplate>();
        if (await idxTask.ConfigureAwait(false) is { } idx)
        {
            foreach (var e in idx.Prop("index_templates").Items())
            {
                var b = e.Prop("index_template") ?? default;
                list.Add(new EsTemplate(e.Str("name") ?? "", "index", Strings(b.Prop("index_patterns")), b.Long("priority"), b.Long("version"),
                    b.Prop("data_stream") is not null, Strings(b.Prop("composed_of")), b.Clone()));
            }
        }
        if (await compTask.ConfigureAwait(false) is { } comp)
        {
            foreach (var e in comp.Prop("component_templates").Items())
            {
                var b = e.Prop("component_template") ?? default;
                list.Add(new EsTemplate(e.Str("name") ?? "", "component", [], null, b.Long("version"), false, [], b.Clone()));
            }
        }
        if (await legacyTask.ConfigureAwait(false) is { ValueKind: JsonValueKind.Object } legacy)
        {
            foreach (var p in legacy.EnumerateObject())
            {
                var b = p.Value;
                list.Add(new EsTemplate(p.Name, "legacy", Strings(b.Prop("index_patterns")), b.Long("order"), b.Long("version"), false, [], b.Clone()));
            }
        }
        return list.OrderBy(x => x.Kind, StringComparer.Ordinal).ThenBy(x => x.Name, StringComparer.Ordinal).ToList();
    }

    private static List<string> Strings(JsonElement? e) =>
        e is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray().Select(x => EsJson.AsString(x) ?? "").ToList()
        : e is { ValueKind: JsonValueKind.String } s ? [s.GetString()!] : [];

    public async Task<EsIndexDetail> DetailAsync(EsClient c, string index, CancellationToken ct)
    {
        var t = c.Transport;
        var body = await t.GetAsync($"{EsTransport.Seg(index)}?expand_wildcards=all", ct).ConfigureAwait(false);
        if (body.ValueKind != JsonValueKind.Object || !body.EnumerateObject().Any()) throw EngineException.NotFound($"Index '{index}'");
        var first = body.EnumerateObject().First();
        var name = first.Name;
        var e = first.Value;
        var seg = EsTransport.Seg(name);
        var catTask = t.TryGetAsync($"_cat/indices/{seg}?format=json&bytes=b&expand_wildcards=all&h={IndexCols}", ct);
        var shardsTask = t.TryGetAsync($"_cat/shards/{seg}?format=json&bytes=b&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason", ct);
        var statsTask = t.TryGetAsync($"{seg}/_stats?expand_wildcards=all", ct);
        var settingsCreated = e.Path("settings.index.creation_date") is { } cd ? EsJson.AsLong(cd) : null;
        var hidden = e.Path("settings.index.hidden") is { } hd && EsJson.AsString(hd) == "true";
        var aliasNames = e.Prop("aliases") is { ValueKind: JsonValueKind.Object } al
            ? (IReadOnlyList<string>)al.EnumerateObject().Select(p => p.Name).OrderBy(x => x, StringComparer.Ordinal).ToList() : [];
        EsIndexSummary? summary = null;
        if (await catTask.ConfigureAwait(false) is { } cat && cat.Items().FirstOrDefault() is { ValueKind: JsonValueKind.Object } row)
        {
            var settingsDoc = JsonSerializer.SerializeToElement(new Dictionary<string, object>
            {
                [name] = new { settings = new Dictionary<string, string?> { ["index.hidden"] = hidden ? "true" : "false", ["index.creation_date"] = settingsCreated?.ToString() } },
            });
            var dsName = e.Prop("data_stream") is { } ds ? EsJson.AsString(ds) : null;
            summary = MapIndex(row, new Dictionary<string, IReadOnlyList<string>> { [name] = aliasNames }, settingsDoc,
                dsName is null ? new Dictionary<string, string>() : new Dictionary<string, string> { [name] = dsName });
            if (summary.Status == "open" && (await TopLevelCountsAsync(c, [name], ct).ConfigureAwait(false)).TryGetValue(name, out var count))
                summary = summary with { DocsCount = count };
        }
        var shards = (await shardsTask.ConfigureAwait(false)).Items().Select(s => new EsShard(
            s.Int("shard"), s.Str("prirep") is "r" or "replica" ? "r" : "p", s.Str("state") ?? "", s.Long("docs"), s.Long("store"), s.Str("ip"), s.Str("node"),
            s.Str("unassigned.reason"))).OrderBy(s => s.Shard).ThenBy(s => s.Prirep, StringComparer.Ordinal).ToList();
        EsIndexStats? stats = null;
        if (await statsTask.ConfigureAwait(false) is { } st)
        {
            var one = st.Path($"indices") is { } byName && byName.Prop(name) is { } own ? own : st.Prop("_all") ?? default;
            stats = new EsIndexStats(one.Prop("primaries")?.Clone(), one.Prop("total")?.Clone());
        }
        return new EsIndexDetail(name, e.Prop("mappings")?.Clone(), e.Prop("settings")?.Clone(), e.Prop("aliases")?.Clone(), summary, shards, stats);
    }

    // ---- fields (flattened mapping)

    private static readonly HashSet<string> Aggregatable = new(StringComparer.Ordinal)
    {
        "keyword", "constant_keyword", "wildcard", "long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long",
        "date", "date_nanos", "boolean", "ip", "geo_point", "geo_shape", "version", "flattened", "aggregate_metric_double", "histogram",
    };

    private static readonly HashSet<string> NotSearchable = new(StringComparer.Ordinal) { "object", "binary", "alias", "dense_vector", "sparse_vector" };

    public async Task<IReadOnlyList<EsField>> FieldsAsync(EsClient c, string target, CancellationToken ct)
    {
        var body = await c.Transport.GetAsync($"{EsTransport.Seg(target)}/_mapping?expand_wildcards=open", ct).ConfigureAwait(false);
        return FlattenMappings(body);
    }

    /// <summary>`GET {target}/_mapping` → one field per path (first index wins on conflicts), sorted by path.</summary>
    internal static IReadOnlyList<EsField> FlattenMappings(JsonElement body)
    {
        var fields = new Dictionary<string, EsField>(StringComparer.Ordinal);
        if (body.ValueKind != JsonValueKind.Object) return [];
        foreach (var idx in body.EnumerateObject())
        {
            var mappings = idx.Value.Prop("mappings");
            if (mappings is not { } m) continue;
            // ES 6 typed mappings: { mappings: { _doc: { properties } } }
            if (m.Prop("properties") is null && m.ValueKind == JsonValueKind.Object && m.EnumerateObject().FirstOrDefault(p => p.Value.Prop("properties") is not null) is { Value.ValueKind: JsonValueKind.Object } typed)
                m = typed.Value;
            Walk(m.Prop("properties"), "", fields);
            if (m.Prop("runtime") is { ValueKind: JsonValueKind.Object } runtime)
            {
                foreach (var p in runtime.EnumerateObject())
                {
                    var type = p.Value.Str("type") ?? "keyword";
                    fields.TryAdd(p.Name, new EsField(p.Name, type, null, true, true));
                }
            }
        }
        return fields.Values.OrderBy(f => f.Path, StringComparer.Ordinal).ToList();
    }

    private static void Walk(JsonElement? props, string prefix, Dictionary<string, EsField> fields)
    {
        if (props is not { ValueKind: JsonValueKind.Object } p) return;
        foreach (var f in p.EnumerateObject())
        {
            var path = prefix + f.Name;
            var def = f.Value;
            var type = def.Str("type") ?? (def.Prop("properties") is not null ? "object" : "object");
            var indexed = def.Bool("index") ?? true;
            var aggregatable = Aggregatable.Contains(type) && (def.Bool("doc_values") ?? true) || (type == "text" && def.Bool("fielddata") == true);
            fields.TryAdd(path, new EsField(path, type, null, indexed && !NotSearchable.Contains(type) && type != "nested", aggregatable));
            if (def.Prop("fields") is { ValueKind: JsonValueKind.Object } multi)
            {
                foreach (var sub in multi.EnumerateObject())
                {
                    var subType = sub.Value.Str("type") ?? "keyword";
                    var subPath = $"{path}.{sub.Name}";
                    fields.TryAdd(subPath, new EsField(subPath, subType, path, (sub.Value.Bool("index") ?? true) && !NotSearchable.Contains(subType),
                        Aggregatable.Contains(subType) && (sub.Value.Bool("doc_values") ?? true)));
                }
            }
            Walk(def.Prop("properties"), path + ".", fields);
        }
    }

    // ---- writes

    public async Task CreateAsync(EsClient c, EsCreateIndexRequest? req, CancellationToken ct)
    {
        c.EnsureWritable("create index");
        var name = EsNames.Index(req?.Name);
        JsonObject body;
        if (EsJson.Node(req?.Body) is { } node)
        {
            body = node as JsonObject ?? throw EngineException.Validation("The index body must be a JSON object ({ settings, mappings, aliases }).", new { field = "body" });
        }
        else body = new JsonObject();
        if (req?.Shards is not null || req?.Replicas is not null)
        {
            var settings = body["settings"] as JsonObject ?? new JsonObject();
            body["settings"] = settings;
            // settings may be nested under "index"
            var target = settings["index"] as JsonObject ?? settings;
            if (req.Shards is { } sh)
            {
                if (sh < 1 || sh > 1024) throw EngineException.Validation("Shards must be between 1 and 1024.", new { field = "shards" });
                target["number_of_shards"] = sh;
            }
            if (req.Replicas is { } rp)
            {
                if (rp < 0 || rp > 64) throw EngineException.Validation("Replicas must be between 0 and 64.", new { field = "replicas" });
                target["number_of_replicas"] = rp;
            }
        }
        await c.Transport.JsonAsync(HttpMethod.Put, EsTransport.Seg(name), body, ct).ConfigureAwait(false);
    }

    public async Task DeleteAsync(EsClient c, string index, CancellationToken ct)
    {
        c.EnsureWritable("delete index");
        var name = EsNames.Index(index, "index");
        await c.Transport.JsonAsync(HttpMethod.Delete, EsTransport.Seg(name), null, ct).ConfigureAwait(false);
    }

    public async Task<JsonElement> ActionAsync(EsClient c, string index, string action, CancellationToken ct)
    {
        var target = EsNames.Target(index);
        var (path, write) = action.ToLowerInvariant() switch
        {
            "open" => ("_open", true),
            "close" => ("_close", true),
            "refresh" => ("_refresh", false),
            "flush" => ("_flush", true),
            "forcemerge" => ("_forcemerge", true),
            "clearcache" => ("_cache/clear", false),
            _ => throw EngineException.Validation($"Unknown index action '{action}' (open, close, refresh, flush, forcemerge, clearcache).", new { field = "action" }),
        };
        if (write) c.EnsureWritable($"{action} index");
        if (write && action is "open" or "close") EsNames.Index(index, "index");
        return await c.Transport.JsonAsync(HttpMethod.Post, $"{EsTransport.Seg(target)}/{path}", null, ct, TimeSpan.FromMinutes(5)).ConfigureAwait(false);
    }

    public async Task UpdateSettingsAsync(EsClient c, string index, EsSettingsUpdate? req, CancellationToken ct)
    {
        c.EnsureWritable("change index settings");
        var target = EsNames.Target(index);
        if (EsJson.Node(req?.Settings) is not JsonObject settings) throw EngineException.Validation("settings must be a JSON object.", new { field = "settings" });
        await c.Transport.JsonAsync(HttpMethod.Put, $"{EsTransport.Seg(target)}/_settings", settings, ct).ConfigureAwait(false);
    }

    public async Task UpdateMappingsAsync(EsClient c, string index, EsMappingsUpdate? req, CancellationToken ct)
    {
        c.EnsureWritable("change mappings");
        var target = EsNames.Target(index);
        if (EsJson.Node(req?.Mappings) is not JsonObject mappings) throw EngineException.Validation("mappings must be a JSON object ({ properties }).", new { field = "mappings" });
        await c.Transport.JsonAsync(HttpMethod.Put, $"{EsTransport.Seg(target)}/_mapping", mappings, ct).ConfigureAwait(false);
    }

    public async Task UpdateAliasesAsync(EsClient c, EsAliasesRequest? req, CancellationToken ct)
    {
        c.EnsureWritable("change aliases");
        var actions = new JsonArray();
        foreach (var (a, i) in (req?.Actions ?? []).Select((a, i) => (a, i)))
        {
            if (a.Add is { } add)
            {
                var o = new JsonObject
                {
                    ["index"] = EsNames.Target(add.Index, $"actions[{i}].add.index"),
                    ["alias"] = EsNames.Index(add.Alias, $"actions[{i}].add.alias"),
                };
                if (EsJson.Node(add.Filter) is { } filter) o["filter"] = filter;
                if (!string.IsNullOrWhiteSpace(add.Routing)) o["routing"] = add.Routing.Trim();
                if (add.IsWriteIndex is { } w) o["is_write_index"] = w;
                actions.Add(new JsonObject { ["add"] = o });
            }
            else if (a.Remove is { } remove)
            {
                actions.Add(new JsonObject
                {
                    ["remove"] = new JsonObject
                    {
                        ["index"] = EsNames.Target(remove.Index, $"actions[{i}].remove.index"),
                        ["alias"] = EsNames.Target(remove.Alias, $"actions[{i}].remove.alias"),
                    },
                });
            }
            else throw EngineException.Validation("Each action is { add } or { remove }.", new { field = $"actions[{i}]" });
        }
        if (actions.Count == 0) throw EngineException.Validation("No alias actions.", new { field = "actions" });
        await c.Transport.JsonAsync(HttpMethod.Post, "_aliases", new JsonObject { ["actions"] = actions }, ct).ConfigureAwait(false);
    }
}
