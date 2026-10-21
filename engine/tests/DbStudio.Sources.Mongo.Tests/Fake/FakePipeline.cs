using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests.Fake;

/// <summary>Minimal aggregation expressions: field paths, $$ROOT, literals and a few operators.</summary>
internal static class FakeExpr
{
    public static bool Truthy(BsonValue? v) => v switch
    {
        null or BsonNull or BsonUndefined => false,
        BsonBoolean b => b.Value,
        _ when BsonKit.IsNumber(v) => BsonKit.ToDouble(v) != 0,
        _ => true,
    };

    /// <summary>Evaluates; null = missing.</summary>
    public static BsonValue? Eval(BsonValue expr, BsonDocument root)
    {
        switch (expr)
        {
            case BsonString s when s.Value.StartsWith("$$", StringComparison.Ordinal):
            {
                var rest = s.Value[2..];
                var dot = rest.IndexOf('.');
                var name = dot < 0 ? rest : rest[..dot];
                if (name is not ("ROOT" or "CURRENT")) throw MongoFake.Command(17276, "Location17276", $"Use of undefined variable: {name}");
                return dot < 0 ? root : BsonKit.GetPath(root, rest[(dot + 1)..]);
            }
            case BsonString s when s.Value.StartsWith('$'):
                return BsonKit.GetPath(root, s.Value[1..]);
            case BsonArray a:
                return new BsonArray(a.Select(x => Eval(x, root) ?? BsonNull.Value));
            case BsonDocument d when d.ElementCount == 1 && d.GetElement(0).Name.StartsWith('$'):
                return Operator(d.GetElement(0).Name, d[0], root);
            case BsonDocument d:
            {
                var r = new BsonDocument();
                foreach (var el in d)
                {
                    var v = Eval(el.Value, root);
                    if (v is not null) r[el.Name] = v;
                }
                return r;
            }
            default:
                return expr;
        }
    }

    private static List<BsonValue?> Args(BsonValue arg, BsonDocument root) =>
        arg is BsonArray a ? a.Select(x => Eval(x, root)).ToList() : [Eval(arg, root)];

    private static BsonValue Num(double d, bool integral)
    {
        if (!integral) return new BsonDouble(d);
        var l = (long)d;
        return l is >= int.MinValue and <= int.MaxValue ? new BsonInt32((int)l) : new BsonInt64(l);
    }

    private static BsonValue? Operator(string op, BsonValue arg, BsonDocument root)
    {
        switch (op)
        {
            case "$literal": return arg;
            case "$concat":
            {
                var parts = Args(arg, root);
                if (parts.Any(p => p is null or BsonNull)) return BsonNull.Value;
                return new BsonString(string.Concat(parts.Select(p => p!.AsString)));
            }
            case "$add" or "$subtract" or "$multiply" or "$divide":
            {
                var a = Args(arg, root);
                if (a.Any(x => x is null or BsonNull)) return BsonNull.Value;
                if (op == "$add" && a.Any(x => x is BsonDateTime))
                    return new BsonDateTime(a.Sum(x => x is BsonDateTime dt ? dt.MillisecondsSinceEpoch : (long)BsonKit.ToDouble(x!)));
                var integral = op != "$divide" && a.All(x => x!.BsonType is BsonType.Int32 or BsonType.Int64);
                var values = a.Select(x => BsonKit.ToDouble(x!)).ToList();
                var r = op switch
                {
                    "$add" => values.Sum(),
                    "$subtract" => values[0] - values[1],
                    "$multiply" => values.Aggregate(1d, (x, y) => x * y),
                    _ => values[0] / values[1],
                };
                return Num(r, integral);
            }
            case "$size":
                return Eval(arg is BsonArray { Count: 1 } one ? one[0] : arg, root) is BsonArray arr
                    ? new BsonInt32(arr.Count)
                    : throw MongoFake.Command(17124, "Location17124", "The argument to $size must be an array");
            case "$toUpper": return Eval(arg, root) is BsonString u ? new BsonString(u.Value.ToUpperInvariant()) : new BsonString("");
            case "$toLower": return Eval(arg, root) is BsonString lo ? new BsonString(lo.Value.ToLowerInvariant()) : new BsonString("");
            case "$toString": return Eval(arg, root) is { } ts and not BsonNull ? new BsonString(ts.IsString ? ts.AsString : ts.ToString()!) : BsonNull.Value;
            case "$ifNull":
            {
                foreach (var v in Args(arg, root))
                    if (v is not null and not BsonNull) return v;
                return BsonNull.Value;
            }
            case "$eq" or "$ne" or "$gt" or "$gte" or "$lt" or "$lte":
            {
                var a = Args(arg, root);
                var c = BsonKit.Compare(a[0] ?? BsonNull.Value, a[1] ?? BsonNull.Value);
                return op switch
                {
                    "$eq" => c == 0, "$ne" => c != 0, "$gt" => c > 0, "$gte" => c >= 0, "$lt" => c < 0, _ => c <= 0,
                };
            }
            case "$and": return Args(arg, root).All(Truthy);
            case "$or": return Args(arg, root).Any(Truthy);
            case "$not": return !Truthy(Args(arg, root)[0]);
            case "$cond":
            {
                if (arg is BsonDocument cd) return Truthy(Eval(cd["if"], root)) ? Eval(cd["then"], root) : Eval(cd["else"], root);
                var a = arg.AsBsonArray;
                return Truthy(Eval(a[0], root)) ? Eval(a[1], root) : Eval(a[2], root);
            }
            case "$arrayElemAt":
            {
                var a = Args(arg, root);
                if (a[0] is not BsonArray arr2) return BsonNull.Value;
                var i = a[1]!.ToInt32();
                if (i < 0) i += arr2.Count;
                return i >= 0 && i < arr2.Count ? arr2[i] : null;
            }
            default:
                throw MongoFake.Command(168, "InvalidPipelineOperator", $"Unrecognized expression '{op}'");
        }
    }
}

/// <summary>The fake's aggregation stages.</summary>
internal static class FakePipeline
{
    public static List<BsonDocument> Run(MongoFake fake, string db, IEnumerable<BsonDocument> input, IReadOnlyList<BsonDocument> pipeline)
    {
        var docs = input.ToList();
        foreach (var stage in pipeline)
        {
            if (stage.ElementCount != 1) throw MongoFake.Command(40323, "Location40323", "A pipeline stage specification object must contain exactly one field.");
            var name = stage.GetElement(0).Name;
            var spec = stage[0];
            docs = name switch
            {
                "$match" => docs.Where(d => FakeQuery.Matches(d, spec.AsBsonDocument)).ToList(),
                "$project" => docs.Select(d => FakeQuery.Project(d, spec.AsBsonDocument)).ToList(),
                "$addFields" or "$set" => docs.Select(d => AddFields(d, spec.AsBsonDocument)).ToList(),
                "$unset" => docs.Select(d => Unset(d, spec)).ToList(),
                "$group" => Group(docs, spec.AsBsonDocument),
                "$sort" => FakeQuery.Sort(docs, spec.AsBsonDocument).ToList(),
                "$limit" => docs.Take(spec.ToInt32()).ToList(),
                "$skip" => docs.Skip(spec.ToInt32()).ToList(),
                "$unwind" => Unwind(docs, spec),
                "$count" => docs.Count == 0 ? [] : [new BsonDocument(spec.AsString, docs.Count)],
                "$sample" => docs.Take(spec["size"].ToInt32()).ToList(),
                "$sortByCount" => Group(docs, new BsonDocument { { "_id", spec }, { "count", new BsonDocument("$sum", 1) } })
                    .OrderByDescending(d => d["count"].ToInt64()).ToList(),
                "$replaceRoot" => docs.Select(d => ReplaceRoot(d, spec["newRoot"])).ToList(),
                "$replaceWith" => docs.Select(d => ReplaceRoot(d, spec)).ToList(),
                "$lookup" => Lookup(fake, db, docs, spec.AsBsonDocument),
                "$out" => Out(fake, db, docs, spec),
                "$merge" => Merge(fake, db, docs, spec),
                _ => throw MongoFake.Command(40324, "Location40324", $"Unrecognized pipeline stage name: '{name}'"),
            };
        }
        return docs;
    }

    private static BsonDocument AddFields(BsonDocument doc, BsonDocument spec)
    {
        var copy = doc.DeepClone().AsBsonDocument;
        foreach (var el in spec)
        {
            var v = FakeExpr.Eval(el.Value, doc);
            if (v is null) BsonKit.RemovePath(copy, el.Name);
            else BsonKit.SetPath(copy, el.Name, v);
        }
        return copy;
    }

    private static BsonDocument Unset(BsonDocument doc, BsonValue spec)
    {
        var copy = doc.DeepClone().AsBsonDocument;
        foreach (var f in spec is BsonArray a ? a.Select(x => x.AsString) : [spec.AsString]) BsonKit.RemovePath(copy, f);
        return copy;
    }

    private static BsonDocument ReplaceRoot(BsonDocument doc, BsonValue expr) =>
        FakeExpr.Eval(expr, doc) as BsonDocument
        ?? throw MongoFake.Command(40228, "Location40228", "'newRoot' expression must evaluate to an object");

    private static List<BsonDocument> Unwind(List<BsonDocument> docs, BsonValue spec)
    {
        var path = (spec is BsonDocument sd ? sd["path"].AsString : spec.AsString).TrimStart('$');
        var preserve = spec is BsonDocument p && p.GetValue("preserveNullAndEmptyArrays", false).ToBoolean();
        var indexField = spec is BsonDocument q && q.TryGetValue("includeArrayIndex", out var iv) ? iv.AsString : null;
        var result = new List<BsonDocument>();
        foreach (var d in docs)
        {
            var v = BsonKit.GetPath(d, path);
            if (v is BsonArray { Count: > 0 } arr)
            {
                for (var i = 0; i < arr.Count; i++)
                {
                    var copy = d.DeepClone().AsBsonDocument;
                    BsonKit.SetPath(copy, path, arr[i]);
                    if (indexField is not null) copy[indexField] = (long)i;
                    result.Add(copy);
                }
            }
            else if (v is not null and not BsonArray and not BsonNull)
            {
                result.Add(d);
            }
            else if (preserve)
            {
                var copy = d.DeepClone().AsBsonDocument;
                if (v is BsonArray) BsonKit.RemovePath(copy, path);
                if (indexField is not null) copy[indexField] = BsonNull.Value;
                result.Add(copy);
            }
        }
        return result;
    }

    private static List<BsonDocument> Group(List<BsonDocument> docs, BsonDocument spec)
    {
        if (!spec.TryGetValue("_id", out var idExpr)) throw MongoFake.Command(15955, "Location15955", "a group specification must include an _id");
        var groups = new List<(BsonValue Id, List<BsonDocument> Docs)>();
        var index = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var d in docs)
        {
            var id = FakeExpr.Eval(idExpr, d) ?? BsonNull.Value;
            var key = Ejson.Canonical(new BsonDocument("k", id));
            if (!index.TryGetValue(key, out var gi))
            {
                gi = groups.Count;
                index[key] = gi;
                groups.Add((id, []));
            }
            groups[gi].Docs.Add(d);
        }
        var result = new List<BsonDocument>();
        foreach (var (id, members) in groups)
        {
            var row = new BsonDocument("_id", id);
            foreach (var acc in spec)
            {
                if (acc.Name == "_id") continue;
                var a = acc.Value.AsBsonDocument;
                var op = a.GetElement(0).Name;
                var expr = a[0];
                var values = members.Select(m => FakeExpr.Eval(expr, m)).ToList();
                row[acc.Name] = op switch
                {
                    "$sum" => Sum(values),
                    "$avg" => values.Where(v => v is not null && BsonKit.IsNumber(v)).Select(v => BsonKit.ToDouble(v!)).DefaultIfEmpty(double.NaN)
                        .Average() is var avg && double.IsNaN(avg) ? BsonNull.Value : new BsonDouble(avg),
                    "$min" => values.Where(v => v is not null and not BsonNull).DefaultIfEmpty(BsonNull.Value)
                        .Min(Comparer<BsonValue?>.Create((x, y) => BsonKit.Compare(x!, y!)))!,
                    "$max" => values.Where(v => v is not null and not BsonNull).DefaultIfEmpty(BsonNull.Value)
                        .Max(Comparer<BsonValue?>.Create((x, y) => BsonKit.Compare(x!, y!)))!,
                    "$first" => values.FirstOrDefault() ?? BsonNull.Value,
                    "$last" => values.LastOrDefault() ?? BsonNull.Value,
                    "$push" => new BsonArray(values.Where(v => v is not null).Select(v => v!)),
                    "$addToSet" => new BsonArray(values.Where(v => v is not null).Select(v => v!)
                        .DistinctBy(v => Ejson.Canonical(new BsonDocument("k", v)))),
                    "$count" => new BsonInt32(members.Count),
                    _ => throw MongoFake.Command(15952, "Location15952", $"unknown group operator '{op}'"),
                };
            }
            result.Add(row);
        }
        return result;
    }

    private static BsonValue Sum(IEnumerable<BsonValue?> values)
    {
        long l = 0;
        double d = 0;
        var isDouble = false;
        foreach (var v in values)
        {
            if (v is null || !BsonKit.IsNumber(v)) continue;
            if (v.BsonType is BsonType.Int32 or BsonType.Int64) l += v.ToInt64();
            else
            {
                isDouble = true;
                d += BsonKit.ToDouble(v);
            }
        }
        if (isDouble) return new BsonDouble(d + l);
        return l is >= int.MinValue and <= int.MaxValue ? new BsonInt32((int)l) : new BsonInt64(l);
    }

    private static List<BsonDocument> Lookup(MongoFake fake, string db, List<BsonDocument> docs, BsonDocument spec)
    {
        var foreign = fake.Snapshot(db, spec["from"].AsString);
        var local = spec["localField"].AsString;
        var foreignField = spec["foreignField"].AsString;
        var asField = spec["as"].AsString;
        return docs.Select(d =>
        {
            var copy = d.DeepClone().AsBsonDocument;
            var keys = BsonKit.PathValues(d, local);
            if (keys.Count == 0) keys = [BsonNull.Value];
            copy[asField] = new BsonArray(foreign.Where(f => keys.Any(k => FakeQuery.FieldMatches(f, foreignField, k))));
            return copy;
        }).ToList();
    }

    private static List<BsonDocument> Out(MongoFake fake, string db, List<BsonDocument> docs, BsonValue spec)
    {
        var (targetDb, target) = spec is BsonDocument d ? (d.GetValue("db", db).AsString, d["coll"].AsString) : (db, spec.AsString);
        fake.ReplaceContents(targetDb, target, docs);
        return [];
    }

    private static List<BsonDocument> Merge(MongoFake fake, string db, List<BsonDocument> docs, BsonValue spec)
    {
        var into = spec is BsonDocument d ? d["into"] : spec;
        var (targetDb, target) = into is BsonDocument id ? (id.GetValue("db", db).AsString, id["coll"].AsString) : (db, into.AsString);
        fake.MergeInto(targetDb, target, docs);
        return [];
    }
}
