using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>Server topology, databases, collections, collection stats and collection DDL (docs/PLAN-M2.md 6.1, 6.2).</summary>
public sealed class ExplorerService
{
    /// <summary>Overall budget of the per-collection estimated counts of <see cref="CollectionsAsync"/>.</summary>
    public TimeSpan CountBudget { get; init; } = TimeSpan.FromSeconds(2);

    public async Task<MongoServerInfo> ServerAsync(MongoClientHandle h, CancellationToken ct)
    {
        var hello = await h.Gateway.RunCommandAsync("admin", new BsonDocument("hello", 1), ct).ConfigureAwait(false);
        var type = hello.GetValue("msg", BsonNull.Value) is BsonString { Value: "isdbgrid" } ? "sharded"
            : hello.Contains("setName") ? "replicaSet"
            : hello.Contains("serviceId") ? "loadBalanced"
            : hello.Contains("isWritablePrimary") || hello.Contains("ismaster") ? "standalone"
            : "unknown";
        var setName = hello.GetValue("setName", BsonNull.Value) is BsonString s ? s.Value : null;
        var members = new List<MongoTopologyMember>();
        if (type == "replicaSet")
        {
            try
            {
                var status = await h.Gateway.RunCommandAsync("admin", new BsonDocument("replSetGetStatus", 1), ct).ConfigureAwait(false);
                foreach (var m in status.GetValue("members", new BsonArray()).AsBsonArray.OfType<BsonDocument>())
                    members.Add(new MongoTopologyMember(m.GetValue("name", "").ToString()!, m.GetValue("stateStr", "UNKNOWN").ToString()!,
                        m.TryGetValue("health", out var hv) && BsonKit.IsNumber(hv) ? BsonKit.ToDouble(hv) >= 1 : null));
            }
            catch (Exception ex) when (ex is not OperationCanceledException && MongoErrors.Map(ex) is { Status: 403 or 422 })
            {
                members.Clear();
            }
            if (members.Count == 0)
            {
                var primary = hello.GetValue("primary", BsonNull.Value) is BsonString p ? p.Value : null;
                foreach (var host in Strings(hello, "hosts"))
                    members.Add(new MongoTopologyMember(host, host == primary ? "PRIMARY" : "SECONDARY", null));
                foreach (var host in Strings(hello, "passives")) members.Add(new MongoTopologyMember(host, "SECONDARY", null));
                foreach (var host in Strings(hello, "arbiters")) members.Add(new MongoTopologyMember(host, "ARBITER", null));
            }
        }
        else if (type == "standalone")
        {
            members.Add(new MongoTopologyMember(MongoProvider.HostOf(hello) ?? h.Server.ServerName ?? "", "STANDALONE", true));
        }
        else if (type == "sharded")
        {
            members.Add(new MongoTopologyMember(h.Server.ServerName ?? MongoProvider.FirstHost(h.Profile) ?? "", "MONGOS", true));
        }
        var hosts = members.Select(m => m.Host).Append(MongoProvider.FirstHost(h.Profile) ?? "").Append(h.Server.ServerName ?? "");
        var isAtlas = hosts.Any(x => HostName(x).EndsWith(".mongodb.net", StringComparison.OrdinalIgnoreCase));
        var wire = hello.TryGetValue("maxWireVersion", out var w) && BsonKit.IsNumber(w) ? (int)BsonKit.ToDouble(w) : 0;
        return new MongoServerInfo(h.Server, type, setName, members, isAtlas, wire);
    }

    private static string HostName(string hostPort)
    {
        var i = hostPort.LastIndexOf(':');
        return i > 0 ? hostPort[..i] : hostPort;
    }

    private static IEnumerable<string> Strings(BsonDocument d, string name) =>
        d.TryGetValue(name, out var v) && v is BsonArray a ? a.Where(x => x.IsString).Select(x => x.AsString) : [];

    public async Task<IReadOnlyList<MongoDatabaseInfo>> DatabasesAsync(MongoClientHandle h, CancellationToken ct)
    {
        var only = h.DefaultDatabase;
        IReadOnlyList<BsonDocument> list;
        try
        {
            list = await h.Gateway.ListDatabasesAsync(false, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (MongoErrors.IsUnauthorized(ex))
        {
            try
            {
                list = await h.Gateway.ListDatabasesAsync(true, ct).ConfigureAwait(false);
            }
            catch (Exception ex2) when (MongoErrors.IsUnauthorized(ex2) && only is not null)
            {
                return [new MongoDatabaseInfo(only, null, false)];
            }
        }
        var result = list.Select(d => new MongoDatabaseInfo(
                d.GetValue("name", "").ToString()!,
                d.TryGetValue("sizeOnDisk", out var size) && BsonKit.IsNumber(size) ? (long)BsonKit.ToDouble(size) : null,
                d.TryGetValue("empty", out var e) && e.IsBoolean && e.AsBoolean))
            .Where(d => d.Name.Length > 0)
            .ToList();
        if (only is not null)
        {
            result = result.Where(d => d.Name == only).ToList();
            if (result.Count == 0) result.Add(new MongoDatabaseInfo(only, null, false));
        }
        return result.OrderBy(d => d.Name, StringComparer.Ordinal).ToList();
    }

    public async Task<IReadOnlyList<MongoCollectionInfo>> CollectionsAsync(MongoClientHandle h, string db, CancellationToken ct)
    {
        MongoValidate.Db(db);
        var list = await h.Gateway.ListCollectionsAsync(db, null, ct).ConfigureAwait(false);
        var items = list
            .Select(d => (Name: d.GetValue("name", "").ToString()!, Type: d.GetValue("type", "collection").ToString()!,
                Options: d.GetValue("options", new BsonDocument()) as BsonDocument ?? [], Info: d.GetValue("info", new BsonDocument()) as BsonDocument ?? []))
            .Where(c => c.Name.Length > 0 && !c.Name.StartsWith("system.", StringComparison.Ordinal))
            .OrderBy(c => c.Name, StringComparer.Ordinal)
            .ToList();

        var counts = new long?[items.Count];
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(CountBudget);
        using var gate = new SemaphoreSlim(16);
        var tasks = items.Select(async (c, i) =>
        {
            if (c.Type != "collection") return;
            try
            {
                await gate.WaitAsync(cts.Token).ConfigureAwait(false);
                try
                {
                    counts[i] = await h.Gateway.EstimatedCountAsync(db, c.Name, CountBudget, cts.Token).ConfigureAwait(false);
                }
                finally
                {
                    gate.Release();
                }
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                counts[i] = null;
            }
        }).ToList();
        await Task.WhenAny(Task.WhenAll(tasks), Task.Delay(CountBudget + TimeSpan.FromMilliseconds(100), ct)).ConfigureAwait(false);
        await cts.CancelAsync().ConfigureAwait(false);

        return items.Select((c, i) => new MongoCollectionInfo(c.Name, c.Type is "view" or "timeseries" ? c.Type : "collection",
            tasks[i].IsCompletedSuccessfully ? counts[i] : null,
            c.Info.TryGetValue("readOnly", out var ro) && ro.IsBoolean && ro.AsBoolean,
            c.Options.TryGetValue("viewOn", out var vo) && vo.IsString ? vo.AsString : null)).ToList();
    }

    /// <summary>Storage statistics (<c>$collStats.storageStats</c>, summed over shards; falls back to the collStats command).</summary>
    internal static async Task<BsonDocument> StorageStatsAsync(MongoClientHandle h, string db, string coll, CancellationToken ct)
    {
        try
        {
            var rows = await h.Gateway.AggregateAsync(db, coll,
                [new BsonDocument("$collStats", new BsonDocument("storageStats", new BsonDocument()))], new AggregateSpec(), ct).ConfigureAwait(false);
            if (rows.Count == 1) return rows[0].GetValue("storageStats", new BsonDocument()).AsBsonDocument;
            if (rows.Count > 1)
            {
                var sum = new BsonDocument();
                var indexSizes = new BsonDocument();
                foreach (var s in rows.Select(r => r.GetValue("storageStats", new BsonDocument()).AsBsonDocument))
                {
                    foreach (var f in new[] { "count", "size", "storageSize", "totalIndexSize" })
                        sum[f] = (sum.Contains(f) ? sum[f].ToInt64() : 0) + (s.TryGetValue(f, out var v) && BsonKit.IsNumber(v) ? (long)BsonKit.ToDouble(v) : 0);
                    sum["nindexes"] = Math.Max(sum.Contains("nindexes") ? sum["nindexes"].ToInt32() : 0, s.GetValue("nindexes", 0).ToInt32());
                    if (s.TryGetValue("indexSizes", out var isz) && isz is BsonDocument isd)
                        foreach (var e in isd)
                            indexSizes[e.Name] = (indexSizes.Contains(e.Name) ? indexSizes[e.Name].ToInt64() : 0) + (long)BsonKit.ToDouble(e.Value);
                }
                sum["indexSizes"] = indexSizes;
                return sum;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException && !MongoErrors.IsConnectionFailure(ex))
        {
            // $collStats not available (old server, privilege): use the command.
        }
        return await h.Gateway.RunCommandAsync(db, new BsonDocument("collStats", coll), ct).ConfigureAwait(false);
    }

    public async Task<MongoCollectionStats> StatsAsync(MongoClientHandle h, string db, string coll, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        if (await h.CollectionTypeAsync(db, coll, ct).ConfigureAwait(false) == "view")
        {
            var n = await h.Gateway.CountDocumentsAsync(db, coll, new BsonDocument(), TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            return new MongoCollectionStats(n, 0, null, null, 0, null);
        }
        var s = await StorageStatsAsync(h, db, coll, ct).ConfigureAwait(false);
        long? L(string f) => s.TryGetValue(f, out var v) && BsonKit.IsNumber(v) ? (long)BsonKit.ToDouble(v) : null;
        var count = L("count") ?? 0;
        var size = L("size") ?? 0;
        double? avg = s.TryGetValue("avgObjSize", out var a) && BsonKit.IsNumber(a) ? BsonKit.ToDouble(a) : count > 0 ? (double)size / count : null;
        return new MongoCollectionStats(count, size, avg, L("storageSize"), (int)(L("nindexes") ?? 0), L("totalIndexSize"));
    }

    public async Task CreateCollectionAsync(MongoClientHandle h, string db, MongoCreateCollectionRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        h.EnsureWritable("create a collection");
        var name = MongoValidate.Coll(req.Name, "name", forCreate: true);
        var o = req.Options ?? new MongoCreateCollectionOptions();
        var options = new BsonDocument();
        if (!string.IsNullOrWhiteSpace(o.ViewOn))
        {
            options["viewOn"] = MongoValidate.Coll(o.ViewOn, "options.viewOn");
            options["pipeline"] = new BsonArray(MongoValidate.Pipeline(o.Pipeline, "options.pipeline"));
        }
        else if (o.Pipeline is { Count: > 0 })
        {
            throw MongoValidate.Fail("options.viewOn", "A view needs its source collection (viewOn).");
        }
        if (o.Capped == true)
        {
            if (options.Contains("viewOn")) throw MongoValidate.Fail("options.capped", "A view cannot be capped.");
            if (o.Size is not > 0) throw MongoValidate.Fail("options.size", "A capped collection needs a size in bytes (> 0).");
            options["capped"] = true;
            options["size"] = o.Size.Value;
            if (o.Max is { } max)
            {
                if (max <= 0) throw MongoValidate.Fail("options.max", "max must be greater than 0.");
                options["max"] = max;
            }
        }
        if (o.Timeseries is { } ts)
        {
            if (options.Contains("viewOn") || o.Capped == true)
                throw MongoValidate.Fail("options.timeseries", "A time series collection cannot be a view or capped.");
            var t = new BsonDocument("timeField", MongoValidate.FieldPath(ts.TimeField, "options.timeseries.timeField"));
            if (!string.IsNullOrWhiteSpace(ts.MetaField)) t["metaField"] = MongoValidate.FieldPath(ts.MetaField, "options.timeseries.metaField");
            if (!string.IsNullOrWhiteSpace(ts.Granularity))
            {
                if (ts.Granularity is not ("seconds" or "minutes" or "hours"))
                    throw MongoValidate.Fail("options.timeseries.granularity", "granularity is seconds, minutes or hours.");
                t["granularity"] = ts.Granularity;
            }
            options["timeseries"] = t;
        }
        if (!string.IsNullOrWhiteSpace(o.Validator))
        {
            if (options.Contains("viewOn")) throw MongoValidate.Fail("options.validator", "A view cannot have a validator.");
            var validator = ShellJson.ParseDocument(o.Validator, "options.validator");
            if (validator.ElementCount > 0) options["validator"] = validator;
        }
        await h.Gateway.CreateCollectionAsync(db, name, options, ct).ConfigureAwait(false);
        h.ForgetTypes(db);
    }

    public async Task RenameCollectionAsync(MongoClientHandle h, string db, string coll, MongoRenameCollectionRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("rename a collection");
        var newName = MongoValidate.Coll(req.NewName, "newName", forCreate: true);
        if (newName == coll) throw MongoValidate.Fail("newName", "The new name is the current name.");
        await h.Gateway.RenameCollectionAsync(db, coll, newName, req.DropTarget, ct).ConfigureAwait(false);
        h.ForgetTypes(db);
    }

    public async Task DropCollectionAsync(MongoClientHandle h, string db, string coll, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("drop a collection");
        await h.Gateway.DropCollectionAsync(db, coll, ct).ConfigureAwait(false);
        h.ForgetTypes(db);
    }

    public async Task DropDatabaseAsync(MongoClientHandle h, string db, CancellationToken ct)
    {
        MongoValidate.Db(db);
        h.EnsureWritable("drop a database");
        await h.Gateway.DropDatabaseAsync(db, ct).ConfigureAwait(false);
        h.ForgetTypes(db);
    }
}
