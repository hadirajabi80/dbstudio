using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>Samples documents: <c>$sample</c> without a filter, else a find with a limit.</summary>
internal static class Sampling
{
    public static IAsyncEnumerable<BsonDocument> SampleAsync(MongoClientHandle h, string db, string coll, BsonDocument filter, int size, CancellationToken ct) =>
        filter.ElementCount == 0
            ? h.Gateway.AggregateStreamAsync(db, coll, [new BsonDocument("$sample", new BsonDocument("size", size))], new AggregateSpec(true), ct)
            : h.Gateway.FindStreamAsync(db, coll, new FindSpec(filter, Limit: size), ct);
}

/// <summary>
/// Schema analysis (docs/PLAN-M2.md 6.5): a job over a sample that returns the field tree with type distributions,
/// probabilities, examples and min/max/distinct statistics.
/// </summary>
public sealed class SchemaService
{
    public static (int SampleSize, BsonDocument Filter) Parse(MongoSchemaRequest req) =>
        (MongoValidate.Range(req.SampleSize ?? 1000, 1, 100_000, "sampleSize"), ShellJson.ParseDocument(req.Filter, "filter"));

    public async Task<MongoSchemaResult> AnalyzeAsync(MongoClientHandle h, string db, string coll, int sampleSize, BsonDocument filter, JobContext? job,
        CancellationToken ct)
    {
        var acc = new SchemaAccumulator("");
        var n = 0;
        await foreach (var doc in Sampling.SampleAsync(h, db, coll, filter, sampleSize, ct).ConfigureAwait(false))
        {
            acc.Add(doc);
            n++;
            if (n % 100 == 0) job?.Report(n, sampleSize);
        }
        job?.Report(n, sampleSize, force: true);
        return new MongoSchemaResult(n, acc.Build());
    }

    /// <summary>Pure analysis of a set of documents (tests).</summary>
    public static MongoSchemaResult Analyze(IEnumerable<BsonDocument> docs)
    {
        var acc = new SchemaAccumulator("");
        var n = 0;
        foreach (var d in docs)
        {
            acc.Add(d);
            n++;
        }
        return new MongoSchemaResult(n, acc.Build());
    }

    private sealed class SchemaAccumulator(string prefix)
    {
        private readonly List<FieldAcc> _order = [];
        private readonly Dictionary<string, FieldAcc> _fields = new(StringComparer.Ordinal);
        public long Docs;

        public void Add(BsonDocument doc)
        {
            Docs++;
            foreach (var el in doc)
            {
                if (!_fields.TryGetValue(el.Name, out var f))
                {
                    f = new FieldAcc(prefix.Length == 0 ? el.Name : prefix + "." + el.Name);
                    _fields[el.Name] = f;
                    _order.Add(f);
                }
                f.Add(el.Value);
            }
        }

        public List<MongoSchemaField> Build() => _order.Select(f => f.Build(Docs)).ToList();
    }

    private sealed class FieldAcc(string path)
    {
        private const int MaxDistinct = 10_000;
        private readonly List<string> _typeOrder = [];
        private readonly Dictionary<string, long> _types = new(StringComparer.Ordinal);
        private readonly List<BsonValue> _examples = [];
        private readonly HashSet<BsonValue> _distinct = [];
        private readonly Dictionary<int, (BsonValue Min, BsonValue Max, long Count)> _ranges = [];
        private SchemaAccumulator? _nested;
        private long _count;

        public void Add(BsonValue v)
        {
            _count++;
            var alias = BsonKit.TypeAlias(v);
            if (!_types.TryGetValue(alias, out var c)) _typeOrder.Add(alias);
            _types[alias] = c + 1;
            switch (v)
            {
                case BsonDocument d:
                    (_nested ??= new SchemaAccumulator(path)).Add(d);
                    return;
                case BsonArray a:
                    foreach (var el in a)
                        if (el is BsonDocument ed) (_nested ??= new SchemaAccumulator(path)).Add(ed);
                    return;
                case BsonNull or BsonUndefined:
                    return;
            }
            if (_distinct.Count < MaxDistinct) _distinct.Add(v);
            if (_examples.Count < 5 && !_examples.Any(x => BsonKit.ValueEquals(x, v) && x.BsonType == v.BsonType)) _examples.Add(v);
            if (BsonKit.IsNumber(v) || v.BsonType is BsonType.DateTime or BsonType.String)
            {
                var rank = BsonKit.Rank(v);
                if (_ranges.TryGetValue(rank, out var r))
                    _ranges[rank] = (BsonKit.Compare(v, r.Min) < 0 ? v : r.Min, BsonKit.Compare(v, r.Max) > 0 ? v : r.Max, r.Count + 1);
                else _ranges[rank] = (v, v, 1);
            }
        }

        public MongoSchemaField Build(long parentCount)
        {
            var types = _typeOrder.Select(t => new MongoSchemaType(t, _types[t], Math.Round(_types[t] * 100.0 / Math.Max(1, _count), 1))).ToList();
            MongoSchemaStats? stats = null;
            if (_ranges.Count > 0)
            {
                var best = _ranges.OrderByDescending(kv => kv.Value.Count).First().Value;
                stats = new MongoSchemaStats(Example(best.Min), Example(best.Max), _distinct.Count);
            }
            return new MongoSchemaField(path, types, Math.Round(_count / (double)Math.Max(1, parentCount), 4),
                _nested?.Build() ?? [], _examples.Select(Example).ToList(), stats);
        }

        private static JsonNode? Example(BsonValue v) =>
            Ejson.ToJsonNode(v is BsonString { Value.Length: > 100 } s ? new BsonString(s.Value[..100]) : v);
    }
}

/// <summary>
/// Field paths for query-bar autocomplete (docs/PLAN-M2.md 6.3): dotted paths (subdocuments and documents inside arrays)
/// with their BSON types and, for enumerable fields, the sampled distinct values. Cached 60 s per sample key.
/// </summary>
public sealed class FieldsService
{
    private readonly ConcurrentDictionary<string, (MongoFieldsResponse Value, DateTimeOffset Expires)> _cache = new(StringComparer.Ordinal);

    public TimeSpan CacheDuration { get; init; } = TimeSpan.FromSeconds(60);
    public Func<DateTimeOffset> Clock { get; init; } = () => DateTimeOffset.UtcNow;

    public async Task<MongoFieldsResponse> FieldsAsync(MongoClientHandle h, string db, string coll, MongoFieldsRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        var size = MongoValidate.Range(req.SampleSize ?? 500, 1, 10_000, "sampleSize");
        var filter = ShellJson.ParseDocument(req.Filter, "filter");
        var key = string.Join('\0', h.ConnectionId, db, coll, Ejson.Canonical(filter), size.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var now = Clock();
        if (_cache.TryGetValue(key, out var hit) && hit.Expires > now) return hit.Value;

        var docs = new List<BsonDocument>();
        await foreach (var d in Sampling.SampleAsync(h, db, coll, filter, size, ct).ConfigureAwait(false)) docs.Add(d);
        var result = Collect(docs);
        if (_cache.Count > 256)
            foreach (var kv in _cache.Where(kv => kv.Value.Expires <= now).ToList()) _cache.TryRemove(kv.Key, out _);
        _cache[key] = (result, now + CacheDuration);
        return result;
    }

    public static MongoFieldsResponse Collect(IReadOnlyList<BsonDocument> docs)
    {
        var fields = new Dictionary<string, PathAcc>(StringComparer.Ordinal);
        var order = new List<PathAcc>();

        void Visit(BsonDocument doc, string prefix)
        {
            foreach (var el in doc)
            {
                var path = prefix.Length == 0 ? el.Name : prefix + "." + el.Name;
                if (!fields.TryGetValue(path, out var acc))
                {
                    acc = new PathAcc(path);
                    fields[path] = acc;
                    order.Add(acc);
                }
                acc.Add(el.Value);
                if (el.Value is BsonDocument sub) Visit(sub, path);
                else if (el.Value is BsonArray arr)
                    foreach (var item in arr)
                        if (item is BsonDocument d) Visit(d, path);
            }
        }

        foreach (var d in docs) Visit(d, "");
        return new MongoFieldsResponse(docs.Count, order.Select(a => a.Build()).ToList());
    }

    private sealed class PathAcc(string path)
    {
        private readonly List<string> _types = [];
        private readonly List<BsonValue> _distinct = [];
        private bool _enumerable = path != "_id";
        private long _occurrences;

        public void Add(BsonValue v)
        {
            var alias = BsonKit.TypeAlias(v);
            if (!_types.Contains(alias)) _types.Add(alias);
            if (v.IsBsonNull || v.IsBsonUndefined) return;
            _occurrences++;
            if (!_enumerable) return;
            if (v.BsonType is not (BsonType.String or BsonType.Boolean or BsonType.Int32 or BsonType.Int64))
            {
                _enumerable = false;
                return;
            }
            if (!_distinct.Any(x => x.BsonType == v.BsonType && BsonKit.ValueEquals(x, v)))
            {
                _distinct.Add(v);
                if (_distinct.Count > 20) _enumerable = false;
            }
        }

        public MongoFieldPath Build()
        {
            var enumerable = _enumerable && _distinct.Count > 0 && _distinct.Count <= 20 && _distinct.Count * 2 < _occurrences;
            return new MongoFieldPath(path, _types,
                enumerable ? _distinct.OrderBy(v => v, Comparer<BsonValue>.Create(BsonKit.Compare)).Select(v => Ejson.Canonical(v)).ToList() : null);
        }
    }
}
