using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>Indexes view (docs/PLAN-M2.md 6.5): list with sizes and usage, create (job when it outlives 2 s), drop.</summary>
public sealed class IndexesService
{
    /// <summary>A create that finishes within this time answers <c>{ name, jobId: null }</c>.</summary>
    public TimeSpan InlineWait { get; init; } = TimeSpan.FromSeconds(2);

    public TimeSpan ProgressInterval { get; init; } = TimeSpan.FromMilliseconds(500);

    public async Task<IReadOnlyList<MongoIndexInfo>> ListAsync(MongoClientHandle h, string db, string coll, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        var specs = await h.Gateway.ListIndexesAsync(db, coll, ct).ConfigureAwait(false);

        BsonDocument? sizes = null;
        try
        {
            var stats = await ExplorerService.StorageStatsAsync(h, db, coll, ct).ConfigureAwait(false);
            sizes = stats.GetValue("indexSizes", BsonNull.Value) as BsonDocument;
        }
        catch (Exception ex) when (ex is not OperationCanceledException && !MongoErrors.IsConnectionFailure(ex))
        {
            sizes = null;
        }

        Dictionary<string, MongoIndexUsage>? usage = null;
        try
        {
            var rows = await h.Gateway.AggregateAsync(db, coll, [new BsonDocument("$indexStats", new BsonDocument())], new AggregateSpec(), ct)
                .ConfigureAwait(false);
            usage = new Dictionary<string, MongoIndexUsage>(StringComparer.Ordinal);
            foreach (var r in rows)
            {
                if (r.GetValue("name", BsonNull.Value) is not BsonString name || r.GetValue("accesses", BsonNull.Value) is not BsonDocument acc) continue;
                var ops = acc.TryGetValue("ops", out var o) && BsonKit.IsNumber(o) ? (long)BsonKit.ToDouble(o) : 0;
                var since = acc.TryGetValue("since", out var s) && s is BsonDateTime dt
                    ? DateTimeOffset.FromUnixTimeMilliseconds(dt.MillisecondsSinceEpoch).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture)
                    : "";
                usage[name.Value] = usage.TryGetValue(name.Value, out var prev) ? prev with { Ops = prev.Ops + ops } : new MongoIndexUsage(ops, since);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException && !MongoErrors.IsConnectionFailure(ex))
        {
            usage = null; // not permitted ($indexStats needs the indexStats action) or a view
        }

        return specs.Select(s => ToInfo(s, sizes, usage)).ToList();
    }

    public static MongoIndexInfo ToInfo(BsonDocument spec, BsonDocument? sizes, IReadOnlyDictionary<string, MongoIndexUsage>? usage)
    {
        var name = spec.GetValue("name", "").ToString()!;
        var key = new List<MongoIndexKeyPart>();
        var keyDoc = spec.GetValue("key", new BsonDocument()).AsBsonDocument;
        foreach (var el in keyDoc)
        {
            if (el.Name is "_fts" or "_ftsx")
            {
                if (el.Name == "_fts" && spec.GetValue("weights", BsonNull.Value) is BsonDocument weights)
                    key.AddRange(weights.Select(w => new MongoIndexKeyPart(w.Name, JsonValue.Create("text"))));
                continue;
            }
            key.Add(new MongoIndexKeyPart(el.Name, KeyType(el.Value)));
        }
        long? ttl = spec.TryGetValue("expireAfterSeconds", out var e) && BsonKit.IsNumber(e) ? (long)BsonKit.ToDouble(e) : null;
        long? size = sizes is not null && sizes.TryGetValue(name, out var sz) && BsonKit.IsNumber(sz) ? (long)BsonKit.ToDouble(sz) : null;
        return new MongoIndexInfo(name, key,
            spec.TryGetValue("unique", out var u) && u.ToBoolean(),
            spec.TryGetValue("sparse", out var sp) && sp.ToBoolean(),
            ttl,
            spec.TryGetValue("partialFilterExpression", out var pf) ? Ejson.Canonical(pf) : null,
            spec.TryGetValue("collation", out var co) ? Ejson.Canonical(co) : null,
            size,
            usage is null ? null : usage.GetValueOrDefault(name));
    }

    private static JsonNode KeyType(BsonValue v) => v switch
    {
        BsonString s => JsonValue.Create(s.Value),
        _ when BsonKit.IsNumber(v) => JsonValue.Create(BsonKit.ToDouble(v) < 0 ? -1 : 1),
        _ => JsonValue.Create(v.ToString() ?? "1"),
    };

    /// <summary>Validates the request and builds the index spec <c>{ key, name, … }</c> (name generated like the server's).</summary>
    public static BsonDocument BuildSpec(MongoCreateIndexRequest req)
    {
        if (req.Key is not { Count: > 0 }) throw MongoValidate.Fail("key", "An index needs at least one field.");
        var key = new BsonDocument();
        for (var i = 0; i < req.Key.Count; i++)
        {
            var part = req.Key[i];
            var field = MongoValidate.FieldPath(part.Field, $"key[{i}].field");
            if (key.Contains(field)) throw MongoValidate.Fail($"key[{i}].field", $"'{field}' appears twice in the index key.");
            key[field] = ParseKeyType(part.Type, $"key[{i}].type");
        }
        var o = req.Options ?? new MongoCreateIndexOptions();
        var name = string.IsNullOrWhiteSpace(o.Name) ? GenerateName(key) : o.Name.Trim();
        if (name == "_id_") throw MongoValidate.Fail("options.name", "The name _id_ is reserved.");
        var spec = new BsonDocument { { "key", key }, { "name", name } };
        if (o.Unique == true) spec["unique"] = true;
        if (o.Sparse == true) spec["sparse"] = true;
        if (o.ExpireAfterSeconds is { } ttl)
        {
            if (ttl < 0 || ttl > int.MaxValue) throw MongoValidate.Fail("options.expireAfterSeconds", "expireAfterSeconds must be between 0 and 2147483647.");
            if (key.ElementCount != 1) throw MongoValidate.Fail("options.expireAfterSeconds", "TTL indexes have exactly one field.");
            spec["expireAfterSeconds"] = (int)ttl;
        }
        if (!string.IsNullOrWhiteSpace(o.PartialFilterExpression))
        {
            var pf = ShellJson.ParseDocument(o.PartialFilterExpression, "options.partialFilterExpression");
            if (pf.ElementCount > 0)
            {
                if (o.Sparse == true) throw MongoValidate.Fail("options.partialFilterExpression", "An index cannot be both sparse and partial.");
                spec["partialFilterExpression"] = pf;
            }
        }
        if (!string.IsNullOrWhiteSpace(o.Collation))
        {
            var c = ShellJson.ParseDocument(o.Collation, "options.collation");
            if (c.ElementCount > 0)
            {
                if (!c.Contains("locale")) throw MongoValidate.Fail("options.collation", "A collation needs a locale.");
                spec["collation"] = c;
            }
        }
        return spec;
    }

    private static BsonValue ParseKeyType(JsonNode? type, string field)
    {
        if (type is JsonValue v)
        {
            if (v.GetValueKind() == JsonValueKind.Number && double.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && (d == 1 || d == -1)) return new BsonInt32((int)d);
            if (v.GetValueKind() == JsonValueKind.String)
            {
                var s = v.GetValue<string>();
                if (s is "1" or "-1") return new BsonInt32(int.Parse(s, CultureInfo.InvariantCulture));
                if (s is "text" or "2dsphere" or "2d" or "hashed") return new BsonString(s);
            }
        }
        throw MongoValidate.Fail(field, "The index type is 1, -1, \"text\", \"2dsphere\", \"2d\" or \"hashed\".");
    }

    /// <summary>The server's default name: <c>a_1_b_-1</c>, <c>name_text_description_text</c>.</summary>
    public static string GenerateName(BsonDocument key) =>
        string.Join('_', key.Select(e => $"{e.Name}_{(e.Value.IsString ? e.Value.AsString : e.Value.ToInt32().ToString(CultureInfo.InvariantCulture))}"));

    /// <summary>
    /// Starts the build; returns the job id when it outlives <see cref="InlineWait"/> (the job reports progress from
    /// <c>$currentOp</c>), else null after the build finished. <paramref name="startJob"/> wraps JobManager.Start.
    /// </summary>
    public async Task<MongoCreateIndexResponse> CreateAsync(MongoClientHandle h, string db, string coll, MongoCreateIndexRequest req,
        Func<Func<JobContext, CancellationToken, Task<object?>>, string> startJob, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("create an index");
        var spec = BuildSpec(req);
        var name = spec["name"].AsString;
        var build = h.Gateway.CreateIndexAsync(db, coll, spec, CancellationToken.None);
        var first = await Task.WhenAny(build, Task.Delay(InlineWait, ct)).ConfigureAwait(false);
        if (first == build)
        {
            await build.ConfigureAwait(false);
            return new MongoCreateIndexResponse(name, null);
        }
        var jobId = startJob(async (ctx, jobCt) =>
        {
            ctx.Report(0, null, $"Building index {name}", force: true);
            while (!build.IsCompleted)
            {
                await Task.WhenAny(build, Task.Delay(ProgressInterval, jobCt)).ConfigureAwait(false);
                jobCt.ThrowIfCancellationRequested();
                if (build.IsCompleted) break;
                try
                {
                    var op = await h.Gateway.RunCommandAsync("admin", new BsonDocument
                    {
                        { "currentOp", 1 }, { "$all", true }, { "command.createIndexes", coll },
                    }, jobCt).ConfigureAwait(false);
                    var inprog = op.GetValue("inprog", new BsonArray()).AsBsonArray.OfType<BsonDocument>()
                        .FirstOrDefault(x => x.Contains("progress") || x.Contains("msg"));
                    if (inprog is not null)
                    {
                        var p = inprog.GetValue("progress", BsonNull.Value) as BsonDocument;
                        long done = p is not null && p.TryGetValue("done", out var dn) && BsonKit.IsNumber(dn) ? (long)BsonKit.ToDouble(dn) : ctx.Done;
                        long? total = p is not null && p.TryGetValue("total", out var tt) && BsonKit.IsNumber(tt) ? (long)BsonKit.ToDouble(tt) : null;
                        ctx.Report(done, total, inprog.GetValue("msg", BsonNull.Value) is BsonString m ? m.Value : null);
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // currentOp needs the inprog privilege: keep waiting without progress.
                }
            }
            await build.ConfigureAwait(false);
            return new MongoCreateIndexResult(name);
        });
        return new MongoCreateIndexResponse(name, jobId);
    }

    public async Task DropAsync(MongoClientHandle h, string db, string coll, string name, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        if (string.IsNullOrWhiteSpace(name)) throw MongoValidate.Fail("name", "An index name is required.");
        if (name == "_id_") throw MongoValidate.Fail("name", "The _id_ index cannot be dropped.");
        h.EnsureWritable("drop an index");
        await h.Gateway.DropIndexAsync(db, coll, name, ct).ConfigureAwait(false);
    }
}
