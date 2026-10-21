using System.Globalization;
using DbStudio.Core.Plans;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>
/// <c>explain</c> of a find or an aggregate (docs/PLAN-M2.md 6.3 "Explain"), normalised to the shared <see cref="PlanNode"/>
/// tree by <see cref="ExplainNormalizer"/>.
/// </summary>
public sealed class ExplainService
{
    public const string WriteStageNotExplained = "$out/$merge stages are not run by explain; the plan stops before them.";

    public async Task<MongoExplainResponse> ExplainAsync(MongoClientHandle h, string db, string coll, MongoExplainRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        var verbosity = req.Verbosity ?? "executionStats";
        if (verbosity is not ("queryPlanner" or "executionStats" or "allPlansExecution"))
            throw MongoValidate.Fail("verbosity", "verbosity is queryPlanner, executionStats or allPlansExecution.");
        var maxTime = MongoValidate.MaxTime(req.MaxTimeMs, 30_000);
        var extraWarnings = new List<string>();
        BsonDocument inner;
        switch (req.Kind)
        {
            case "find":
            {
                MongoValidate.Range(req.Skip, 0, int.MaxValue, "skip");
                if (req.Limit is { } l) MongoValidate.Range(l, 0, int.MaxValue, "limit");
                inner = new BsonDocument { { "find", coll }, { "filter", ShellJson.ParseDocument(req.Filter, "filter") } };
                if (DocumentsService.NullIfEmpty(ShellJson.ParseDocument(req.Projection, "projection")) is { } p) inner["projection"] = p;
                if (DocumentsService.NullIfEmpty(ShellJson.ParseDocument(req.Sort, "sort")) is { } s) inner["sort"] = s;
                if (req.Skip > 0) inner["skip"] = req.Skip;
                if (req.Limit is > 0) inner["limit"] = req.Limit.Value;
                if (DocumentsService.NullIfEmpty(ShellJson.ParseDocument(req.Collation, "collation")) is { } c) inner["collation"] = c;
                break;
            }
            case "aggregate":
            {
                var (stages, skipped, write) = AggregateService.Plan(MongoValidate.Pipeline(req.Pipeline), req.PreviewStage);
                if (write)
                {
                    stages.RemoveAt(stages.Count - 1);
                    skipped = true;
                }
                if (skipped) extraWarnings.Add(WriteStageNotExplained);
                inner = new BsonDocument { { "aggregate", coll }, { "pipeline", new BsonArray(stages) }, { "cursor", new BsonDocument() } };
                if (req.AllowDiskUse) inner["allowDiskUse"] = true;
                break;
            }
            default:
                throw MongoValidate.Fail("kind", "kind is find or aggregate.");
        }
        var cmd = new BsonDocument { { "explain", inner }, { "verbosity", verbosity } };
        if (maxTime is { } mt) cmd["maxTimeMS"] = (long)mt.TotalMilliseconds;
        var raw = await h.Gateway.RunCommandAsync(db, cmd, ct).ConfigureAwait(false);
        var result = ExplainNormalizer.Normalize(raw, $"{db}.{coll}");
        return extraWarnings.Count == 0 ? result : result with { Warnings = [.. result.Warnings, .. extraWarnings] };
    }
}

/// <summary>
/// MongoDB explain output → <see cref="PlanNode"/> tree + warnings + summary. Handles the classic shape, SBE
/// (<c>winningPlan.queryPlan</c>, 7.x), aggregates with a <c>$cursor</c> first stage (later stages become parents of the
/// cursor plan), sharded <c>shards</c> arrays, and pairs <c>executionStats.executionStages</c> with the plan by stage name.
/// </summary>
public static class ExplainNormalizer
{
    public const string CollscanWarning = "Collection scan: no index was used to find the documents.";
    public const string SortWarning = "Sort in memory: add an index that matches the sort.";

    private static readonly string[] s_childKeys = ["inputStage", "outerStage", "innerStage", "thenStage", "elseStage"];

    public static MongoExplainResponse Normalize(BsonDocument explain, string? ns = null)
    {
        BsonDocument? qp = null, es = null;
        var later = new List<BsonDocument>();
        if (explain.TryGetValue("stages", out var st) && st is BsonArray stages && stages.Count > 0)
        {
            var first = stages[0].AsBsonDocument;
            if (first.TryGetValue("$cursor", out var cur) && cur is BsonDocument cursor)
            {
                qp = Doc(cursor, "queryPlanner");
                es = Doc(cursor, "executionStats");
                later.AddRange(stages.Skip(1).OfType<BsonDocument>());
            }
            else
            {
                later.AddRange(stages.OfType<BsonDocument>());
            }
        }
        else if (explain.Contains("queryPlanner"))
        {
            qp = Doc(explain, "queryPlanner");
            es = Doc(explain, "executionStats");
        }
        else if (explain.TryGetValue("shards", out var sh) && sh is BsonDocument shards && shards.ElementCount > 0
                 && shards.GetElement(0).Value is BsonDocument firstShard)
        {
            return Normalize(firstShard, ns);
        }

        ns = qp?.GetValue("namespace", BsonNull.Value) is BsonString n ? n.Value : ns;
        PlanNode? root = null;
        if (qp is not null && Doc(qp, "winningPlan") is { } winning)
        {
            var plan = Doc(winning, "queryPlan") ?? winning;
            root = Build(plan, Doc(es, "executionStages"), ns);
            if (root.ActualRows is null && es is not null)
            {
                // SBE execution trees do not mirror the query plan: put the totals on the plan root.
                root.ActualRows = Num(es, "nReturned");
                root.SetProp("docsExamined", Str(es, "totalDocsExamined"));
                root.SetProp("keysExamined", Str(es, "totalKeysExamined"));
                root.SetProp("executionTimeMillisEstimate", Str(es, "executionTimeMillis"));
            }
        }
        var planNodes = root?.DescendantsAndSelf().ToList() ?? [];

        var aggSort = false;
        foreach (var stage in later)
        {
            var name = stage.Names.FirstOrDefault(x => x.StartsWith('$')) ?? stage.Names.FirstOrDefault() ?? "stage";
            var node = new PlanNode { Op = name };
            if (stage.TryGetValue(name, out var body))
            {
                var text = Ejson.Compact(body);
                node.Predicate = text.Length > 500 ? text[..500] + "…" : text;
            }
            node.ActualRows = Num(stage, "nReturned");
            node.SetProp("executionTimeMillisEstimate", Str(stage, "executionTimeMillisEstimate"));
            node.SetProp("usedDisk", Str(stage, "usedDisk"));
            node.SetProp("spills", Str(stage, "spills"));
            node.SetProp("totalOutputDataSizeBytes", Str(stage, "totalOutputDataSizeBytes"));
            if (name == "$sort")
            {
                aggSort = true;
                node.Warnings.Add("In-memory sort");
            }
            if (root is not null) node.Children.Add(root);
            root = node;
        }
        root ??= new PlanNode { Op = "EXPLAIN" };

        var id = 0;
        foreach (var node in root.DescendantsAndSelf()) node.Id = ++id;

        var rejected = qp is not null && qp.TryGetValue("rejectedPlans", out var rp) && rp is BsonArray ra ? ra.Count : 0;
        root.SetProp("rejectedPlans", rejected.ToString(CultureInfo.InvariantCulture));

        double? nReturned = later.Count > 0 && later[^1].Contains("nReturned") ? Num(later[^1], "nReturned") : Num(es, "nReturned");
        var docsExamined = Num(es, "totalDocsExamined");
        var keysExamined = Num(es, "totalKeysExamined");
        var time = Num(es, "executionTimeMillis");
        if (later.Count > 0 && Num(later[^1], "executionTimeMillisEstimate") is { } lt) time = Math.Max(time ?? 0, lt);
        var indexes = planNodes.Select(x => x.Object).Where((o, i) => o is not null && planNodes[i].Op != "COLLSCAN" && planNodes[i].Op != "SHARD")
            .Select(o => o!).Distinct(StringComparer.Ordinal).ToList();
        var collscan = planNodes.Any(x => x.Op == "COLLSCAN");
        var sortInMemory = aggSort || planNodes.Any(x => x.Op == "SORT");

        var warnings = new List<string>();
        if (collscan) warnings.Add(CollscanWarning);
        if (docsExamined is { } de && nReturned is { } nr)
        {
            var ratio = de / Math.Max(1, nr);
            if (ratio > 10)
                warnings.Add(string.Create(CultureInfo.InvariantCulture, $"Examined {de:N0} documents to return {nr:N0} ({ratio:N0}×)."));
        }
        if (sortInMemory) warnings.Add(SortWarning);
        if (rejected > 0) warnings.Add($"{rejected} rejected plan(s).");

        var summary = new MongoExplainSummary(L(nReturned), L(docsExamined), L(keysExamined), L(time), indexes, collscan, sortInMemory, rejected);
        return new MongoExplainResponse(Ejson.Relaxed(explain, indent: true), root, warnings, summary);
    }

    private static PlanNode Build(BsonDocument plan, BsonDocument? exec, string? ns)
    {
        var stage = plan.GetValue("stage", "UNKNOWN").ToString()!;
        var node = new PlanNode { Op = stage };
        var stats = exec is not null && exec.GetValue("stage", BsonNull.Value) is BsonString es && es.Value == stage ? exec : null;

        if (plan.GetValue("indexName", BsonNull.Value) is BsonString idx) node.Object = idx.Value;
        else if (stage == "COLLSCAN") node.Object = ns;

        if (plan.TryGetValue("filter", out var filter) && filter is BsonDocument { ElementCount: > 0 }) node.Predicate = Ejson.Compact(filter);
        else if (plan.TryGetValue("indexBounds", out var bounds) && bounds is BsonDocument bd) node.Predicate = BoundsSummary(bd);

        if (plan.TryGetValue("keyPattern", out var kp)) node.SetProp("keyPattern", Ejson.Compact(kp));
        if (plan.TryGetValue("indexBounds", out var ib)) node.SetProp("indexBounds", Ejson.Compact(ib));
        node.SetProp("isMultiKey", Str(plan, "isMultiKey"));
        node.SetProp("direction", Str(plan, "direction"));
        node.SetProp("memLimit", Str(plan, "memLimit"));
        node.SetProp("limitAmount", Str(plan, "limitAmount"));
        if (plan.TryGetValue("sortPattern", out var sp)) node.SetProp("sortPattern", Ejson.Compact(sp));
        if (plan.TryGetValue("transformBy", out var tb)) node.SetProp("transformBy", Ejson.Compact(tb));

        if (stats is not null)
        {
            node.ActualRows = Num(stats, "nReturned");
            node.SetProp("docsExamined", Str(stats, "docsExamined"));
            node.SetProp("keysExamined", Str(stats, "keysExamined"));
            node.SetProp("executionTimeMillisEstimate", Str(stats, "executionTimeMillisEstimate"));
            node.SetProp("works", Str(stats, "works"));
            node.SetProp("advanced", Str(stats, "advanced"));
            node.SetProp("memLimit", Str(stats, "memLimit"));
            node.SetProp("usedDisk", Str(stats, "usedDisk"));
        }

        if (stage == "COLLSCAN") node.Warnings.Add("Collection scan");
        if (stage == "SORT") node.Warnings.Add("In-memory sort");

        foreach (var key in s_childKeys)
            if (plan.TryGetValue(key, out var child) && child is BsonDocument cd)
                node.Children.Add(Build(cd, Doc(stats, key), ns));
        if (plan.TryGetValue("inputStages", out var many) && many is BsonArray arr)
        {
            var execs = stats?.GetValue("inputStages", BsonNull.Value) as BsonArray;
            for (var i = 0; i < arr.Count; i++)
                if (arr[i] is BsonDocument cd)
                    node.Children.Add(Build(cd, execs is not null && i < execs.Count ? execs[i] as BsonDocument : null, ns));
        }
        if (plan.TryGetValue("shards", out var shards) && shards is BsonArray sarr)
        {
            var execShards = stats?.GetValue("shards", BsonNull.Value) as BsonArray;
            for (var i = 0; i < sarr.Count; i++)
            {
                if (sarr[i] is not BsonDocument s) continue;
                var shardNode = new PlanNode { Op = "SHARD", Object = s.GetValue("shardName", "").ToString() };
                var wp = Doc(s, "winningPlan");
                var sub = Doc(wp, "queryPlan") ?? wp;
                var ex = execShards is not null && i < execShards.Count ? Doc(execShards[i] as BsonDocument, "executionStages") : null;
                if (sub is not null) shardNode.Children.Add(Build(sub, ex, ns));
                node.Children.Add(shardNode);
            }
        }
        return node;
    }

    /// <summary><c>{ status: ['["paid", "paid"]'], createdAt: ['[MaxKey, MinKey]'] }</c> → <c>status ["paid", "paid"]; createdAt [MaxKey, MinKey]</c>.</summary>
    internal static string BoundsSummary(BsonDocument bounds) =>
        string.Join("; ", bounds.Select(e => e.Value is BsonArray a
            ? $"{e.Name} {string.Join(" ∪ ", a.Select(x => x.IsString ? x.AsString : Ejson.Compact(x)))}"
            : $"{e.Name} {Ejson.Compact(e.Value)}"));

    private static BsonDocument? Doc(BsonDocument? d, string name) => d is not null && d.TryGetValue(name, out var v) && v is BsonDocument x ? x : null;

    private static double? Num(BsonDocument? d, string name) => d is not null && d.TryGetValue(name, out var v) && BsonKit.IsNumber(v) ? BsonKit.ToDouble(v) : null;

    private static long? L(double? v) => v is null ? null : (long)Math.Round(v.Value);

    private static string? Str(BsonDocument? d, string name)
    {
        if (d is null || !d.TryGetValue(name, out var v)) return null;
        return v.BsonType switch
        {
            BsonType.Boolean => v.AsBoolean ? "true" : "false",
            BsonType.String => v.AsString,
            BsonType.Int32 or BsonType.Int64 => v.ToInt64().ToString(CultureInfo.InvariantCulture),
            BsonType.Double => v.AsDouble.ToString("0.###", CultureInfo.InvariantCulture),
            BsonType.Null => null,
            _ => Ejson.Compact(v),
        };
    }
}
