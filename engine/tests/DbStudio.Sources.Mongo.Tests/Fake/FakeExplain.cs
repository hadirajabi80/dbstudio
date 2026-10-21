using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests.Fake;

/// <summary>
/// A MongoDB 7 (classic engine, explainVersion 1) explain for the fake: COLLSCAN unless an index's first field is the
/// filter's (or the sort's) first field, then IXSCAN → FETCH; an in-memory SORT when the index does not provide the sort;
/// executionStats computed from the data. Aggregates push down $match/$sort/$limit/$skip/$project, otherwise answer with
/// <c>stages: [{ $cursor }, …]</c>.
/// </summary>
internal static class FakeExplain
{
    public static BsonDocument Explain(MongoFake fake, string db, BsonDocument command)
    {
        var inner = command["explain"].AsBsonDocument;
        var verbosity = command.GetValue("verbosity", "allPlansExecution").AsString;
        var exec = verbosity != "queryPlanner";
        var all = verbosity == "allPlansExecution";
        var serverInfo = new BsonDocument { { "host", "localhost" }, { "port", 27017 }, { "version", fake.Version }, { "gitVersion", "fakefake" } };

        if (inner.Contains("find"))
        {
            var coll = inner["find"].AsString;
            var r = Cursor(fake, db, coll, inner.GetValue("filter", new BsonDocument()).AsBsonDocument, inner.GetValue("sort", BsonNull.Value) as BsonDocument,
                inner.GetValue("skip", 0).ToInt32(), inner.GetValue("limit", 0).ToInt32(), inner.GetValue("projection", BsonNull.Value) as BsonDocument, exec, all);
            r["command"] = inner.DeepClone();
            r["serverInfo"] = serverInfo;
            r["ok"] = 1.0;
            return r;
        }

        var aggColl = inner["aggregate"].AsString;
        var pipeline = inner["pipeline"].AsBsonArray.Select(x => x.AsBsonDocument).ToList();
        var pushable = new HashSet<string> { "$match", "$sort", "$limit", "$skip", "$project" };
        BsonDocument filter = [];
        BsonDocument? sort = null;
        int skip = 0, limit = 0, consumed = 0;
        BsonDocument? projection = null;
        foreach (var st in pipeline)
        {
            var name = st.GetElement(0).Name;
            if (name == "$match" && consumed == 0) filter = st[0].AsBsonDocument;
            else if (name == "$sort" && sort is null && limit == 0) sort = st[0].AsBsonDocument;
            else if (name == "$skip" && limit == 0) skip = st[0].ToInt32();
            else if (name == "$limit" && limit == 0) limit = st[0].ToInt32();
            else if (name == "$project" && projection is null && pushable.Contains(name)) projection = st[0].AsBsonDocument;
            else break;
            consumed++;
        }
        var cursor = Cursor(fake, db, aggColl, filter, sort, skip, limit, projection, exec, all);
        if (consumed == pipeline.Count)
        {
            cursor["command"] = inner.DeepClone();
            cursor["serverInfo"] = serverInfo;
            cursor["ok"] = 1.0;
            return cursor;
        }
        var stages = new BsonArray();
        var cursorStage = new BsonDocument("$cursor", cursor);
        var docs = fake.Query(db, aggColl, new FindSpec(filter, null, sort, skip, limit > 0 ? limit : null));
        if (exec)
        {
            cursorStage["nReturned"] = (long)docs.Count;
            cursorStage["executionTimeMillisEstimate"] = 0L;
        }
        stages.Add(cursorStage);
        foreach (var st in pipeline.Skip(consumed))
        {
            var s = st.DeepClone().AsBsonDocument;
            if (exec)
            {
                docs = FakePipeline.Run(fake, db, docs, [st]);
                s["nReturned"] = (long)docs.Count;
                s["executionTimeMillisEstimate"] = 0L;
                if (st.GetElement(0).Name is "$group" or "$sort")
                {
                    s["usedDisk"] = false;
                    s["spills"] = 0L;
                }
            }
            stages.Add(s);
        }
        return new BsonDocument { { "explainVersion", "1" }, { "stages", stages }, { "serverInfo", serverInfo }, { "command", inner.DeepClone() }, { "ok", 1.0 } };
    }

    private static BsonDocument Cursor(MongoFake fake, string db, string coll, BsonDocument filter, BsonDocument? sort, int skip, int limit,
        BsonDocument? projection, bool exec, bool all)
    {
        var docs = fake.Snapshot(db, coll);
        var c = fake.Collection(db, coll);
        var indexes = c.Indexes.ToList();
        var firstField = FirstField(filter);
        var sortField = sort is { ElementCount: > 0 } ? sort.GetElement(0).Name : null;

        BsonDocument? index = firstField is null ? null : indexes.FirstOrDefault(i => i["key"].AsBsonDocument.GetElement(0).Name == firstField);
        var byFilter = index is not null;
        if (index is null && sortField is not null) index = indexes.FirstOrDefault(i => i["key"].AsBsonDocument.GetElement(0).Name == sortField);
        var keyNames = index?["key"].AsBsonDocument.Names.ToList() ?? [];
        var sortCovered = sortField is null || (index is not null && (keyNames[0] == sortField || (byFilter && keyNames.Count > 1 && keyNames[1] == sortField)));

        var matched = docs.Where(d => FakeQuery.Matches(d, filter)).ToList();
        BsonDocument plan, stats;
        long keysExamined = 0, docsExamined;
        if (index is not null)
        {
            var candidates = byFilter ? docs.Where(d => FakeQuery.FieldMatches(d, firstField!, filter[firstField!])).ToList() : docs;
            keysExamined = candidates.Count;
            docsExamined = candidates.Count;
            var bounds = new BsonDocument();
            foreach (var k in keyNames)
                bounds[k] = new BsonArray { byFilter && k == firstField ? Bounds(filter[k]) : "[MinKey, MaxKey]" };
            var ix = new BsonDocument
            {
                { "stage", "IXSCAN" }, { "keyPattern", index["key"] }, { "indexName", index["name"] }, { "isMultiKey", false },
                { "multiKeyPaths", new BsonDocument(keyNames.Select(k => new BsonElement(k, new BsonArray()))) },
                { "isUnique", index.GetValue("unique", false).ToBoolean() }, { "isSparse", index.GetValue("sparse", false).ToBoolean() },
                { "isPartial", false }, { "indexVersion", 2 }, { "direction", "forward" }, { "indexBounds", bounds },
            };
            var rest = new BsonDocument(filter.Where(e => !byFilter || e.Name != firstField));
            plan = new BsonDocument("stage", "FETCH");
            if (rest.ElementCount > 0) plan["filter"] = rest;
            plan["inputStage"] = ix;
            var ixStats = Stats(ix, candidates.Count, keysExamined, 0);
            ixStats["keysExamined"] = keysExamined;
            ixStats["seeks"] = 1;
            stats = Stats(plan, matched.Count, 0, docsExamined);
            stats["inputStage"] = ixStats;
        }
        else
        {
            docsExamined = docs.Count;
            plan = new BsonDocument("stage", "COLLSCAN");
            if (filter.ElementCount > 0) plan["filter"] = filter;
            plan["direction"] = "forward";
            stats = Stats(plan, matched.Count, 0, docsExamined);
        }

        IEnumerable<BsonDocument> ordered = FakeQuery.Sort(matched, sort);
        if (!sortCovered)
        {
            var sortStage = new BsonDocument { { "stage", "SORT" }, { "sortPattern", sort! }, { "memLimit", 104857600 } };
            if (limit > 0) sortStage["limitAmount"] = limit + skip;
            sortStage["type"] = "simple";
            sortStage["inputStage"] = plan;
            var n = limit > 0 ? Math.Min(matched.Count, limit + skip) : matched.Count;
            var s = Stats(sortStage, n, 0, 0);
            s["usedDisk"] = false;
            s["inputStage"] = stats;
            plan = sortStage;
            stats = s;
        }
        var final = ordered.ToList();
        if (skip > 0)
        {
            final = final.Skip(skip).ToList();
            plan = new BsonDocument { { "stage", "SKIP" }, { "skipAmount", skip }, { "inputStage", plan } };
            var s = Stats(plan, final.Count, 0, 0);
            s["inputStage"] = stats;
            stats = s;
        }
        if (limit > 0 && sortCovered)
        {
            final = final.Take(limit).ToList();
            plan = new BsonDocument { { "stage", "LIMIT" }, { "limitAmount", limit }, { "inputStage", plan } };
            var s = Stats(plan, final.Count, 0, 0);
            s["inputStage"] = stats;
            stats = s;
        }
        else if (limit > 0) final = final.Take(limit).ToList();
        if (projection is { ElementCount: > 0 })
        {
            plan = new BsonDocument { { "stage", "PROJECTION_SIMPLE" }, { "transformBy", projection }, { "inputStage", plan } };
            var s = Stats(plan, final.Count, 0, 0);
            s["inputStage"] = stats;
            stats = s;
        }
        if (index is not null) fake.Calls.AddOrUpdate("ixops:" + index["name"].AsString, 1, (_, n) => n + 1);

        var result = new BsonDocument
        {
            { "explainVersion", "1" },
            {
                "queryPlanner", new BsonDocument
                {
                    { "namespace", $"{db}.{coll}" }, { "indexFilterSet", false }, { "parsedQuery", filter }, { "queryHash", "5F5FC979" },
                    { "planCacheKey", "C1E1E7B0" }, { "maxIndexedOrSolutionsReached", false }, { "maxIndexedAndSolutionsReached", false },
                    { "maxScansToExplodeReached", false }, { "winningPlan", plan }, { "rejectedPlans", new BsonArray() },
                }
            },
        };
        if (exec)
            result["executionStats"] = new BsonDocument
            {
                { "executionSuccess", true }, { "nReturned", final.Count }, { "executionTimeMillis", 1 }, { "totalKeysExamined", keysExamined },
                { "totalDocsExamined", docsExamined }, { "executionStages", stats }, { "allPlansExecution", new BsonArray() },
            };
        return result;
    }

    private static BsonDocument Stats(BsonDocument planStage, long nReturned, long keys, long docs)
    {
        var s = new BsonDocument { { "stage", planStage["stage"] } };
        foreach (var e in planStage)
            if (e.Name is not ("stage" or "inputStage")) s[e.Name] = e.Value;
        s["nReturned"] = nReturned;
        s["executionTimeMillisEstimate"] = 0;
        s["works"] = Math.Max(keys, docs) + nReturned + 1;
        s["advanced"] = nReturned;
        s["needTime"] = Math.Max(0, Math.Max(keys, docs) - nReturned);
        s["needYield"] = 0;
        s["saveState"] = 0;
        s["restoreState"] = 0;
        s["isEOF"] = 1;
        if (planStage["stage"] == "COLLSCAN" || planStage["stage"] == "FETCH") s["docsExamined"] = docs;
        return s;
    }

    private static string? FirstField(BsonDocument filter)
    {
        foreach (var e in filter)
        {
            if (!e.Name.StartsWith('$')) return e.Name;
            if (e.Name == "$and" && e.Value is BsonArray { Count: > 0 } a && a[0] is BsonDocument d) return FirstField(d);
        }
        return null;
    }

    private static string Bounds(BsonValue cond)
    {
        if (cond is BsonDocument d && d.ElementCount > 0 && d.GetElement(0).Name.StartsWith('$'))
        {
            var op = d.GetElement(0);
            var v = Ejson.Relaxed(op.Value);
            return op.Name switch
            {
                "$gt" => $"({v}, inf.0]",
                "$gte" => $"[{v}, inf.0]",
                "$lt" => $"[-inf.0, {v})",
                "$lte" => $"[-inf.0, {v}]",
                _ => "[MinKey, MaxKey]",
            };
        }
        var s = Ejson.Relaxed(cond);
        return $"[{s}, {s}]";
    }
}
