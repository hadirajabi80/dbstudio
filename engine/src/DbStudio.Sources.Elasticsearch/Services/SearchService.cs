using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>
/// <c>POST /es/{cid}/search</c>: the query DSL passes through; the engine adds <c>seq_no_primary_term</c> (optimistic
/// concurrency of the document editor), exact totals by default, the from/size/search_after overrides and a size cap.
/// </summary>
public sealed class SearchService
{
    public const int MaxSize = 10_000;

    public async Task<EsSearchResponse> SearchAsync(EsClient c, EsSearchRequest? req, CancellationToken ct)
    {
        var target = EsNames.Target(req?.Index);
        var (body, capped) = BuildBody(req!);
        var sw = Stopwatch.StartNew();
        var res = await c.Transport.JsonAsync(HttpMethod.Post, $"{EsTransport.Seg(target)}/_search", body, ct).ConfigureAwait(false);
        return MapResponse(res, sw.ElapsedMilliseconds, capped, EsJson.Element(body));
    }

    internal static (JsonObject Body, bool Capped) BuildBody(EsSearchRequest req)
    {
        JsonObject body;
        if (EsJson.Node(req.Body) is { } node)
            body = node as JsonObject ?? throw EngineException.Validation("The search body must be a JSON object ({ query, aggs, sort… }).", new { field = "body" });
        else body = new JsonObject();
        if (req.From is { } from)
        {
            if (from < 0) throw EngineException.Validation("from must be ≥ 0.", new { field = "from" });
            body["from"] = from;
        }
        if (req.Size is { } size)
        {
            if (size < 0) throw EngineException.Validation("size must be ≥ 0.", new { field = "size" });
            body["size"] = size;
        }
        var capped = false;
        if (body["size"] is JsonValue sv && sv.TryGetValue<long>(out var s) && s > MaxSize)
        {
            body["size"] = MaxSize;
            capped = true;
        }
        if (req.SearchAfter is { ValueKind: JsonValueKind.Array } after && after.GetArrayLength() > 0)
        {
            body["search_after"] = JsonNode.Parse(after.GetRawText());
            body.Remove("from");
        }
        if (req.TrackTotalHits is { } tth && tth.ValueKind is JsonValueKind.True or JsonValueKind.False or JsonValueKind.Number)
            body["track_total_hits"] = JsonNode.Parse(tth.GetRawText());
        else if (!body.ContainsKey("track_total_hits")) body["track_total_hits"] = true;
        if (!body.ContainsKey("seq_no_primary_term")) body["seq_no_primary_term"] = true;
        return (body, capped);
    }

    internal static EsSearchResponse MapResponse(JsonElement res, long elapsedMs, bool capped, JsonElement request)
    {
        var hits = res.Prop("hits") ?? default;
        long? total = null;
        var relation = "eq";
        if (hits.Prop("total") is { } tot)
        {
            if (tot.ValueKind == JsonValueKind.Number) total = tot.GetInt64();
            else
            {
                total = tot.Long("value");
                relation = tot.Str("relation") == "gte" ? "gte" : "eq";
            }
        }
        var shards = res.Prop("_shards") ?? default;
        return new EsSearchResponse(
            Took: res.Long("took") ?? 0,
            TimedOut: res.Bool("timed_out") ?? false,
            Total: total,
            TotalRelation: relation,
            MaxScore: hits.Double("max_score"),
            Hits: hits.Prop("hits").Items().Select(MapHit).ToList(),
            Aggregations: res.Prop("aggregations")?.Clone(),
            Shards: new EsShardsInfo(shards.Int("total"), shards.Int("successful"), shards.Int("skipped"), shards.Int("failed")),
            Profile: res.Prop("profile")?.Clone(),
            ElapsedMs: elapsedMs,
            Capped: capped,
            Request: request);
    }

    internal static EsHit MapHit(JsonElement h)
    {
        Dictionary<string, IReadOnlyList<string>>? highlight = null;
        if (h.Prop("highlight") is { ValueKind: JsonValueKind.Object } hl)
        {
            highlight = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
            foreach (var p in hl.EnumerateObject()) highlight[p.Name] = p.Value.EnumerateArray().Select(x => EsJson.AsString(x) ?? "").ToList();
        }
        IReadOnlyList<string>? matched = h.Prop("matched_queries") switch
        {
            { ValueKind: JsonValueKind.Array } a => a.EnumerateArray().Select(x => EsJson.AsString(x) ?? "").ToList(),
            // 8.8+: include_named_queries_score answers { name: score }
            { ValueKind: JsonValueKind.Object } o => o.EnumerateObject().Select(p => p.Name).ToList(),
            _ => null,
        };
        return new EsHit(
            Index: h.Str("_index") ?? "",
            Id: h.Str("_id") ?? "",
            Score: h.Double("_score"),
            SeqNo: h.Long("_seq_no"),
            PrimaryTerm: h.Long("_primary_term"),
            Version: h.Long("_version"),
            Routing: h.Str("_routing"),
            Source: h.Prop("_source")?.Clone(),
            Fields: h.Prop("fields")?.Clone(),
            Highlight: highlight,
            Sort: h.Prop("sort")?.Clone(),
            Explanation: h.Prop("_explanation")?.Clone(),
            MatchedQueries: matched);
    }
}

/// <summary>Documents by id: get, index/replace (optimistic concurrency), create with an auto id, delete.</summary>
public sealed class DocumentService
{
    public async Task<EsDoc> GetAsync(EsClient c, string index, string id, string? routing, CancellationToken ct)
    {
        var target = EsNames.Target(index);
        EsNames.DocId(id);
        var q = string.IsNullOrEmpty(routing) ? "" : $"?routing={Uri.EscapeDataString(routing)}";
        var res = await c.Transport.SendAsync(HttpMethod.Get, $"{EsTransport.Seg(target)}/_doc/{EsTransport.Seg(id)}{q}", null, null, ct).ConfigureAwait(false);
        if (res.Status == 404)
        {
            var body = TryJson(res);
            if (body?.Prop("found") is { ValueKind: JsonValueKind.False })
                return new EsDoc(body.Value.Str("_index") ?? target, id, false, null, null, null, routing, null);
        }
        if (!res.Ok) throw EsErrors.FromResponse(res);
        var d = res.Json();
        return new EsDoc(d.Str("_index") ?? target, d.Str("_id") ?? id, d.Bool("found") ?? true, d.Long("_seq_no"), d.Long("_primary_term"), d.Long("_version"),
            d.Str("_routing"), d.Prop("_source")?.Clone());
    }

    private static JsonElement? TryJson(EsResponse res)
    {
        try { return res.Json(); }
        catch (JsonException) { return null; }
    }

    public async Task<EsWriteResult> PutAsync(EsClient c, string index, string? id, EsPutDocRequest? req, CancellationToken ct)
    {
        c.EnsureWritable(id is null ? "create document" : "save document");
        var target = EsNames.Index(index, "index");
        if (id is not null) EsNames.DocId(id);
        if (EsJson.Node(req?.Source) is not JsonObject source) throw EngineException.Validation("The document (_source) must be a JSON object.", new { field = "source" });
        var q = new List<string>();
        if (req!.IfSeqNo is { } seq && req.IfPrimaryTerm is { } term)
        {
            q.Add($"if_seq_no={seq}");
            q.Add($"if_primary_term={term}");
        }
        else if (req.IfSeqNo is not null || req.IfPrimaryTerm is not null)
        {
            throw EngineException.Validation("ifSeqNo and ifPrimaryTerm go together.", new { field = "ifSeqNo" });
        }
        if (!string.IsNullOrWhiteSpace(req.Routing)) q.Add($"routing={Uri.EscapeDataString(req.Routing.Trim())}");
        if (req.Create && id is not null) q.Add("op_type=create");
        q.Add($"refresh={Refresh(req.Refresh)}");
        var path = id is null ? $"{EsTransport.Seg(target)}/_doc" : $"{EsTransport.Seg(target)}/_doc/{EsTransport.Seg(id)}";
        var res = await c.Transport.JsonAsync(id is null ? HttpMethod.Post : HttpMethod.Put, $"{path}?{string.Join('&', q)}", source, ct).ConfigureAwait(false);
        return MapWrite(res, target, id);
    }

    public async Task<EsWriteResult> DeleteAsync(EsClient c, string index, string id, long? ifSeqNo, long? ifPrimaryTerm, string? routing, CancellationToken ct)
    {
        c.EnsureWritable("delete document");
        var target = EsNames.Index(index, "index");
        EsNames.DocId(id);
        var q = new List<string> { "refresh=wait_for" };
        if (ifSeqNo is { } seq && ifPrimaryTerm is { } term)
        {
            q.Add($"if_seq_no={seq}");
            q.Add($"if_primary_term={term}");
        }
        if (!string.IsNullOrWhiteSpace(routing)) q.Add($"routing={Uri.EscapeDataString(routing.Trim())}");
        var res = await c.Transport.SendAsync(HttpMethod.Delete, $"{EsTransport.Seg(target)}/_doc/{EsTransport.Seg(id)}?{string.Join('&', q)}", null, null, ct)
            .ConfigureAwait(false);
        if (res.Status == 404 && TryJson(res) is { } nf && nf.Str("result") == "not_found") return MapWrite(nf, target, id);
        if (!res.Ok) throw EsErrors.FromResponse(res);
        return MapWrite(res.Json(), target, id);
    }

    private static string Refresh(string? r) => r?.Trim().ToLowerInvariant() switch
    {
        null or "" or "wait_for" => "wait_for",
        "true" => "true",
        "false" => "false",
        _ => throw EngineException.Validation("refresh is 'true', 'false' or 'wait_for'.", new { field = "refresh" }),
    };

    private static EsWriteResult MapWrite(JsonElement r, string index, string? id) =>
        new(r.Str("_index") ?? index, r.Str("_id") ?? id ?? "", r.Str("result") ?? "", r.Long("_seq_no"), r.Long("_primary_term"), r.Long("_version"));
}
