using System.Text.RegularExpressions;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests.Fake;

/// <summary>Query semantics of the fake: filters, projections and sorts over BsonDocuments (server-like, not exhaustive).</summary>
internal static class FakeQuery
{
    public static bool Matches(BsonDocument doc, BsonDocument filter)
    {
        foreach (var el in filter)
        {
            switch (el.Name)
            {
                case "$and":
                    if (!Clauses(el).All(c => Matches(doc, c))) return false;
                    break;
                case "$or":
                    if (!Clauses(el).Any(c => Matches(doc, c))) return false;
                    break;
                case "$nor":
                    if (Clauses(el).Any(c => Matches(doc, c))) return false;
                    break;
                case "$expr":
                    if (!FakeExpr.Truthy(FakeExpr.Eval(el.Value, doc))) return false;
                    break;
                case "$comment":
                    break;
                default:
                    if (el.Name.StartsWith('$')) throw MongoFake.Command(2, "BadValue", $"unknown top level operator: {el.Name}");
                    if (!FieldMatches(doc, el.Name, el.Value)) return false;
                    break;
            }
        }
        return true;
    }

    private static IEnumerable<BsonDocument> Clauses(BsonElement el)
    {
        if (el.Value is not BsonArray { Count: > 0 } arr) throw MongoFake.Command(2, "BadValue", $"{el.Name} must be a nonempty array");
        return arr.Select(x => x as BsonDocument ?? throw MongoFake.Command(2, "BadValue", $"{el.Name} argument's entries must be objects"));
    }

    private static bool IsOperatorDoc(BsonValue v) =>
        v is BsonDocument { ElementCount: > 0 } d && d.GetElement(0).Name.StartsWith('$') && d.GetElement(0).Name is not ("$ref" or "$id" or "$db");

    public static bool FieldMatches(BsonDocument doc, string path, BsonValue cond)
    {
        if (IsOperatorDoc(cond))
        {
            var cd = cond.AsBsonDocument;
            foreach (var op in cd)
            {
                if (op.Name == "$options") continue;
                if (!Operator(doc, path, op.Name, op.Value, cd)) return false;
            }
            return true;
        }
        if (cond is BsonRegularExpression re) return Values(doc, path).Any(v => RegexMatch(v, re));
        return Eq(doc, path, cond);
    }

    private static List<BsonValue> Values(BsonDocument doc, string path) => BsonKit.PathValues(doc, path, expandLeafArrays: true);

    private static List<BsonValue> Raw(BsonDocument doc, string path) => BsonKit.PathValues(doc, path, expandLeafArrays: false);

    private static bool Eq(BsonDocument doc, string path, BsonValue cond)
    {
        var values = Values(doc, path);
        if (cond.IsBsonNull) return values.Count == 0 || values.Any(v => v.IsBsonNull || v.IsBsonUndefined);
        return values.Any(v => BsonKit.ValueEquals(v, cond));
    }

    private static bool Compare(BsonDocument doc, string path, BsonValue cond, Func<int, bool> ok) =>
        Values(doc, path).Any(v => v is not BsonArray && BsonKit.Rank(v) == BsonKit.Rank(cond) && ok(BsonKit.Compare(v, cond)));

    private static bool Operator(BsonDocument doc, string path, string op, BsonValue arg, BsonDocument all)
    {
        switch (op)
        {
            case "$eq": return Eq(doc, path, arg);
            case "$ne": return !Eq(doc, path, arg);
            case "$gt": return Compare(doc, path, arg, c => c > 0);
            case "$gte": return Compare(doc, path, arg, c => c >= 0);
            case "$lt": return Compare(doc, path, arg, c => c < 0);
            case "$lte": return Compare(doc, path, arg, c => c <= 0);
            case "$in": return In(doc, path, arg);
            case "$nin": return !In(doc, path, arg);
            case "$exists": return Raw(doc, path).Count > 0 == FakeExpr.Truthy(arg);
            case "$type":
            {
                var wanted = (arg is BsonArray a ? a.ToList() : [arg]).Select(TypeName).ToList();
                return Values(doc, path).Any(v => wanted.Any(w => TypeMatches(v, w)));
            }
            case "$size":
                return Raw(doc, path).Any(v => v is BsonArray arr && arr.Count == arg.ToInt32());
            case "$all":
            {
                if (arg is not BsonArray need) throw MongoFake.Command(2, "BadValue", "$all needs an array");
                if (need.Count == 0) return false;
                return Raw(doc, path).Any(v =>
                {
                    var arr = v as BsonArray ?? [v];
                    return need.All(n => n is BsonDocument nd && nd.Contains("$elemMatch")
                        ? arr.Any(el => ElemMatches(el, nd["$elemMatch"].AsBsonDocument))
                        : arr.Any(el => BsonKit.ValueEquals(el, n)) || BsonKit.ValueEquals(v, n));
                });
            }
            case "$elemMatch":
                if (arg is not BsonDocument spec) throw MongoFake.Command(2, "BadValue", "$elemMatch needs an Object");
                return Raw(doc, path).Any(v => v is BsonArray arr && arr.Any(el => ElemMatches(el, spec)));
            case "$not":
                if (arg is BsonRegularExpression nre) return !Values(doc, path).Any(v => RegexMatch(v, nre));
                if (arg is not BsonDocument nd2 || !IsOperatorDoc(nd2)) throw MongoFake.Command(2, "BadValue", "$not needs a regex or a document");
                return !FieldMatches(doc, path, nd2);
            case "$regex":
            {
                var options = all.TryGetValue("$options", out var o) ? o.AsString : "";
                var re = arg is BsonRegularExpression r ? new BsonRegularExpression(r.Pattern, r.Options + options) : new BsonRegularExpression(arg.AsString, options);
                return Values(doc, path).Any(v => RegexMatch(v, re));
            }
            case "$mod":
            {
                var m = arg.AsBsonArray;
                var d = m[0].ToInt64();
                var rem = m[1].ToInt64();
                return Values(doc, path).Any(v => BsonKit.IsNumber(v) && (long)BsonKit.ToDouble(v) % d == rem);
            }
            default:
                throw MongoFake.Command(2, "BadValue", $"unknown operator: {op}");
        }
    }

    private static bool In(BsonDocument doc, string path, BsonValue arg)
    {
        if (arg is not BsonArray arr) throw MongoFake.Command(2, "BadValue", "$in needs an array");
        return arr.Any(e => e is BsonRegularExpression re ? Values(doc, path).Any(v => RegexMatch(v, re)) : Eq(doc, path, e));
    }

    private static bool ElemMatches(BsonValue el, BsonDocument spec)
    {
        if (IsOperatorDoc(spec)) return FieldMatches(new BsonDocument("v", el), "v", spec);
        return el is BsonDocument ed && Matches(ed, spec);
    }

    private static string TypeName(BsonValue t) =>
        t.IsString ? t.AsString : BsonKit.TypeAliasOfNumber(t.ToInt32()) ?? throw MongoFake.Command(2, "BadValue", "Invalid numerical type code");

    private static bool TypeMatches(BsonValue v, string alias) => alias == "number" ? BsonKit.IsNumber(v) : BsonKit.TypeAlias(v) == alias;

    public static bool RegexMatch(BsonValue v, BsonRegularExpression re)
    {
        if (!v.IsString) return v is BsonRegularExpression same && same.Pattern == re.Pattern;
        var options = RegexOptions.None;
        foreach (var c in re.Options)
            options |= c switch
            {
                'i' => RegexOptions.IgnoreCase,
                'm' => RegexOptions.Multiline,
                's' => RegexOptions.Singleline,
                'x' => RegexOptions.IgnorePatternWhitespace,
                _ => RegexOptions.None,
            };
        return Regex.IsMatch(v.AsString, re.Pattern, options);
    }

    // ---------------------------------------------------------------- projection

    public static BsonDocument Project(BsonDocument doc, BsonDocument projection)
    {
        if (projection.ElementCount == 0) return doc;
        bool? inclusion = null;
        foreach (var el in projection)
        {
            if (el.Name == "_id") continue;
            var include = !IsFalse(el.Value);
            if (inclusion is null) inclusion = include;
            else if (inclusion != include)
                throw MongoFake.Command(31254, "Location31254", $"Cannot do {(include ? "inclusion" : "exclusion")} on field {el.Name} in {(include ? "exclusion" : "inclusion")} projection");
        }
        var excludeId = projection.TryGetValue("_id", out var idSpec) && IsFalse(idSpec);
        if (inclusion != true)
        {
            var copy = doc.DeepClone().AsBsonDocument;
            foreach (var el in projection)
                if (el.Name != "_id" || excludeId)
                    BsonKit.RemovePath(copy, el.Name);
            return copy;
        }
        var tree = new BsonDocument();
        foreach (var el in projection)
        {
            if (el.Name == "_id") continue;
            BsonKit.SetPath(tree, el.Name, el.Value);
        }
        var result = new BsonDocument();
        if (!excludeId && doc.TryGetValue("_id", out var id))
            result["_id"] = idSpec is not null && !IsTrue(idSpec) && !IsFalse(idSpec) ? FakeExpr.Eval(idSpec, doc) ?? BsonNull.Value : id;
        Include(doc, doc, tree, result);
        return result;
    }

    private static bool IsFalse(BsonValue v) => (v.IsBoolean && !v.AsBoolean) || (BsonKit.IsNumber(v) && BsonKit.ToDouble(v) == 0);

    private static bool IsTrue(BsonValue v) => (v.IsBoolean && v.AsBoolean) || (BsonKit.IsNumber(v) && BsonKit.ToDouble(v) != 0);

    private static void Include(BsonDocument root, BsonDocument doc, BsonDocument tree, BsonDocument result)
    {
        foreach (var el in doc)
        {
            if (el.Name == "_id" || !tree.TryGetValue(el.Name, out var spec)) continue;
            if (IsTrue(spec)) result[el.Name] = el.Value.DeepClone();
            else if (spec is BsonDocument sub && !IsOperatorDoc(sub))
            {
                if (el.Value is BsonDocument d)
                {
                    var r = new BsonDocument();
                    Include(root, d, sub, r);
                    result[el.Name] = r;
                }
                else if (el.Value is BsonArray arr)
                {
                    var mapped = new BsonArray();
                    foreach (var item in arr.OfType<BsonDocument>())
                    {
                        var r = new BsonDocument();
                        Include(root, item, sub, r);
                        mapped.Add(r);
                    }
                    result[el.Name] = mapped;
                }
            }
        }
        foreach (var el in tree)
        {
            if (el.Name == "_id" || IsTrue(el.Value) || (el.Value is BsonDocument sd && !IsOperatorDoc(sd))) continue;
            var v = FakeExpr.Eval(el.Value, root);
            if (v is not null) result[el.Name] = v;
        }
    }

    // ---------------------------------------------------------------- sort

    public static IEnumerable<BsonDocument> Sort(IEnumerable<BsonDocument> docs, BsonDocument? sort)
    {
        if (sort is not { ElementCount: > 0 }) return docs;
        var keys = sort.Select(e => (e.Name, Asc: BsonKit.ToDouble(e.Value) >= 0)).ToList();
        return docs.OrderBy(d => d, Comparer<BsonDocument>.Create((a, b) =>
        {
            foreach (var (name, asc) in keys)
            {
                var c = BsonKit.Compare(SortKey(a, name, asc), SortKey(b, name, asc));
                if (c != 0) return asc ? c : -c;
            }
            return 0;
        }));
    }

    private static BsonValue SortKey(BsonDocument doc, string path, bool asc)
    {
        var values = BsonKit.PathValues(doc, path, expandLeafArrays: true).Where(v => v is not BsonArray).ToList();
        if (values.Count == 0) return BsonNull.Value;
        return asc ? values.Min(Comparer<BsonValue>.Create(BsonKit.Compare))! : values.Max(Comparer<BsonValue>.Create(BsonKit.Compare))!;
    }
}
