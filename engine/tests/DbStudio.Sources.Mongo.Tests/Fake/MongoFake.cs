using System.Collections.Concurrent;
using System.Net;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using MongoDB.Bson;
using MongoDB.Driver;
using MongoDB.Driver.Core.Clusters;
using MongoDB.Driver.Core.Connections;
using MongoDB.Driver.Core.Servers;

namespace DbStudio.Sources.Mongo.Tests.Fake;

/// <summary>
/// In-memory <see cref="IMongoGateway"/> (docs/PLAN-M2.md D11): databases → collections (documents, index specs, options,
/// views), server-like filters / projections / sorts / pipelines, a realistic MongoDB 7 explain, change streams fed by
/// writes, canned hello / buildInfo / collStats, and failure injection (<see cref="Fail"/>) for privilege and timeout tests.
/// </summary>
internal sealed class MongoFake : IMongoGateway
{
    internal sealed class Coll(string name)
    {
        public string Name { get; set; } = name;
        public string Type { get; set; } = "collection";
        public List<BsonDocument> Docs { get; } = [];
        public List<BsonDocument> Indexes { get; } = [new BsonDocument { { "v", 2 }, { "key", new BsonDocument("_id", 1) }, { "name", "_id_" } }];
        public BsonDocument Options { get; set; } = [];
    }

    private readonly object _lock = new();
    private readonly Dictionary<string, (int Level, int Slowms, double SampleRate)> _profiling = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, Coll>> _dbs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (Func<Exception> Make, int Remaining)> _failures = new(StringComparer.Ordinal);
    private readonly List<(string Db, string? Coll, bool Lookup, Channel<BsonDocument> Channel)> _watchers = [];
    private int _clock = 1;

    public ConcurrentDictionary<string, int> Calls { get; } = new(StringComparer.Ordinal);
    public bool Standalone { get; set; }
    public string Version { get; set; } = "7.0.14";
    public string SetName { get; set; } = "rs0";
    public string Host { get; set; } = "localhost:27017";
    public bool Disposed { get; private set; }

    /// <summary>When set, createIndex waits for this before finishing (long-build tests).</summary>
    public TaskCompletionSource? IndexBuildGate { get; set; }
    public (long Done, long Total)? IndexBuildProgress { get; set; }

    /// <summary>Delays countDocuments by this much (and honours maxTime like the server).</summary>
    public TimeSpan CountDelay { get; set; }

    public IMongoClient? Client => null;

    // ---------------------------------------------------------------- failures

    internal static readonly ConnectionId Connection = new(new ServerId(new ClusterId(), new DnsEndPoint("localhost", 27017)));

    public static MongoCommandException Command(int code, string codeName, string message) =>
        new(Connection, message, new BsonDocument("fake", 1),
            new BsonDocument { { "ok", 0 }, { "errmsg", message }, { "code", code }, { "codeName", codeName } });

    public static MongoCommandException Unauthorized(string db, string command, string? coll = null) =>
        Command(13, "Unauthorized", $"Command {command} failed: not authorized on {db} to execute command {{ {command}: {(coll is null ? "1" : $"\"{coll}\"")}, $db: \"{db}\" }}.");

    public static MongoExecutionTimeoutException Timeout() =>
        new(Connection, "Command failed: operation exceeded time limit.",
            new BsonDocument { { "ok", 0 }, { "errmsg", "operation exceeded time limit" }, { "code", 50 }, { "codeName", "MaxTimeMSExpired" } });

    /// <summary>Makes operation <paramref name="op"/> throw (e.g. "listDatabases", "find", "count", "indexStats", "watch").</summary>
    public void Fail(string op, Func<Exception> make, int times = int.MaxValue) => _failures[op] = (make, times);

    public void Fail(string op, Exception ex, int times = int.MaxValue) => Fail(op, () => ex, times);

    public void ClearFailures() => _failures.Clear();

    private void Check(string op)
    {
        Calls.AddOrUpdate(op, 1, (_, n) => n + 1);
        if (_failures.TryGetValue(op, out var f) && f.Remaining > 0)
        {
            _failures[op] = (f.Make, f.Remaining - 1);
            throw f.Make();
        }
    }

    public int CallCount(string op) => Calls.GetValueOrDefault(op);

    // ---------------------------------------------------------------- seeding

    public Coll Collection(string db, string name, bool create = true)
    {
        lock (_lock)
        {
            if (!_dbs.TryGetValue(db, out var colls))
            {
                if (!create) throw Command(26, "NamespaceNotFound", $"ns does not exist: {db}.{name}");
                _dbs[db] = colls = new Dictionary<string, Coll>(StringComparer.Ordinal);
            }
            if (!colls.TryGetValue(name, out var c))
            {
                if (!create) throw Command(26, "NamespaceNotFound", $"ns does not exist: {db}.{name}");
                colls[name] = c = new Coll(name);
            }
            return c;
        }
    }

    private Coll? Find(string db, string name)
    {
        lock (_lock) return _dbs.TryGetValue(db, out var colls) && colls.TryGetValue(name, out var c) ? c : null;
    }

    public MongoFake Seed(string db, string coll, IEnumerable<BsonDocument> docs)
    {
        var c = Collection(db, coll);
        lock (_lock)
            foreach (var d in docs)
            {
                if (!d.Contains("_id")) d.InsertAt(0, new BsonElement("_id", ObjectId.GenerateNewId()));
                c.Docs.Add(d);
            }
        return this;
    }

    public MongoFake Seed(string db, string coll, params string[] shellDocs) =>
        Seed(db, coll, shellDocs.Select(s => ShellJson.ParseDocument(s, "seed")));

    public void View(string db, string name, string source, params BsonDocument[] pipeline)
    {
        var c = Collection(db, name);
        c.Type = "view";
        c.Options = new BsonDocument { { "viewOn", source }, { "pipeline", new BsonArray(pipeline) } };
    }

    public void Index(string db, string coll, BsonDocument spec)
    {
        var c = Collection(db, coll);
        lock (_lock)
        {
            var s = new BsonDocument("v", 2);
            s.AddRange(spec);
            c.Indexes.Add(s);
        }
    }

    /// <summary>The documents of a collection or view (deep copies).</summary>
    public List<BsonDocument> Snapshot(string db, string coll)
    {
        var c = Find(db, coll);
        if (c is null) return [];
        if (c.Type == "view")
            return FakePipeline.Run(this, db, Snapshot(db, c.Options["viewOn"].AsString),
                c.Options["pipeline"].AsBsonArray.Select(x => x.AsBsonDocument).ToList());
        lock (_lock) return c.Docs.Select(d => d.DeepClone().AsBsonDocument).ToList();
    }

    internal void ReplaceContents(string db, string coll, List<BsonDocument> docs)
    {
        var c = Collection(db, coll);
        lock (_lock)
        {
            c.Docs.Clear();
            foreach (var d in docs)
            {
                var copy = d.DeepClone().AsBsonDocument;
                if (!copy.Contains("_id")) copy.InsertAt(0, new BsonElement("_id", ObjectId.GenerateNewId()));
                c.Docs.Add(copy);
            }
        }
    }

    internal void MergeInto(string db, string coll, List<BsonDocument> docs)
    {
        var c = Collection(db, coll);
        lock (_lock)
            foreach (var d in docs)
            {
                var copy = d.DeepClone().AsBsonDocument;
                if (!copy.Contains("_id")) copy.InsertAt(0, new BsonElement("_id", ObjectId.GenerateNewId()));
                var i = c.Docs.FindIndex(x => BsonKit.ValueEquals(x["_id"], copy["_id"]));
                if (i >= 0) c.Docs[i] = copy;
                else c.Docs.Add(copy);
            }
    }

    private Coll Writable(string db, string coll)
    {
        var c = Collection(db, coll);
        if (c.Type == "view") throw Command(166, "CommandNotSupportedOnView", $"Namespace {db}.{coll} is a view, not a collection");
        return c;
    }

    // ---------------------------------------------------------------- commands

    public BsonDocument HelloReply()
    {
        var d = new BsonDocument { { "helloOk", true }, { "isWritablePrimary", true } };
        if (!Standalone)
        {
            d["hosts"] = new BsonArray { Host };
            d["setName"] = SetName;
            d["setVersion"] = 1;
            d["secondary"] = false;
            d["primary"] = Host;
            d["me"] = Host;
        }
        d["maxBsonObjectSize"] = 16777216;
        d["maxWireVersion"] = 21;
        d["minWireVersion"] = 0;
        d["ok"] = 1.0;
        return d;
    }

    public Task<BsonDocument> RunCommandAsync(string db, BsonDocument command, CancellationToken ct)
    {
        var name = command.GetElement(0).Name;
        Check(name);
        switch (name)
        {
            case "hello" or "isMaster" or "ismaster":
                return Task.FromResult(HelloReply());
            case "ping":
                return Task.FromResult(new BsonDocument("ok", 1.0));
            case "buildInfo":
                return Task.FromResult(new BsonDocument { { "version", Version }, { "gitVersion", "fakefake" }, { "versionArray", new BsonArray { 7, 0, 14, 0 } }, { "ok", 1.0 } });
            case "replSetGetStatus":
                if (Standalone) throw Command(76, "NoReplicationEnabled", "not running with --replSet");
                return Task.FromResult(new BsonDocument
                {
                    { "set", SetName },
                    { "members", new BsonArray { new BsonDocument { { "_id", 0 }, { "name", Host }, { "health", 1.0 }, { "state", 1 }, { "stateStr", "PRIMARY" } } } },
                    { "ok", 1.0 },
                });
            case "collStats":
                return Task.FromResult(CollStats(db, command[0].AsString));
            case "collMod":
            {
                var c = Writable(db, command[0].AsString);
                lock (_lock)
                    foreach (var f in new[] { "validator", "validationLevel", "validationAction" })
                        if (command.TryGetValue(f, out var v))
                        {
                            if (f == "validator" && v is BsonDocument { ElementCount: 0 }) c.Options.Remove("validator");
                            else c.Options[f] = v;
                        }
                return Task.FromResult(new BsonDocument("ok", 1.0));
            }
            case "explain":
                return Task.FromResult(FakeExplain.Explain(this, db, command));
            case "profile":
            {
                lock (_lock)
                {
                    var (was, slowms, rate) = _profiling.TryGetValue(db, out var cur) ? cur : (0, 100, 1.0);
                    var level = command[0].ToInt32();
                    if (level is not (-1 or 0 or 1 or 2)) throw Command(2, "BadValue", "Invalid profiling level");
                    if (level >= 0)
                        _profiling[db] = (level, command.GetValue("slowms", slowms).ToInt32(), command.GetValue("sampleRate", rate).ToDouble());
                    return Task.FromResult(new BsonDocument { { "was", was }, { "slowms", slowms }, { "sampleRate", rate }, { "ok", 1.0 } });
                }
            }
            case "currentOp":
            {
                var inprog = new BsonArray();
                if (IndexBuildGate is { Task.IsCompleted: false } && IndexBuildProgress is { } p)
                    inprog.Add(new BsonDocument
                    {
                        { "type", "op" }, { "desc", "IndexBuildsCoordinatorMongod-0" },
                        { "command", new BsonDocument("createIndexes", command.GetValue("command.createIndexes", "x")) },
                        { "msg", $"Index Build: scanning collection {p.Done}/{p.Total} {p.Done * 100 / Math.Max(1, p.Total)}%" },
                        { "progress", new BsonDocument { { "done", p.Done }, { "total", p.Total } } },
                    });
                return Task.FromResult(new BsonDocument { { "inprog", inprog }, { "ok", 1.0 } });
            }
            case "createIndexes":
                return CreateIndexAsync(db, command[0].AsString, command["indexes"][0].AsBsonDocument, ct).ContinueWith(_ => new BsonDocument("ok", 1.0), ct);
            default:
                throw Command(59, "CommandNotFound", $"no such command: '{name}'");
        }
    }

    internal BsonDocument CollStats(string db, string coll)
    {
        var c = Find(db, coll) ?? throw Command(26, "NamespaceNotFound", $"Collection [{db}.{coll}] not found.");
        if (c.Type == "view") throw Command(166, "CommandNotSupportedOnView", $"Namespace {db}.{coll} is a view, not a collection");
        lock (_lock)
        {
            long size = c.Docs.Sum(d => (long)d.ToBson().Length);
            var indexSizes = new BsonDocument();
            foreach (var i in c.Indexes) indexSizes[i["name"].AsString] = 4096L + 16L * c.Docs.Count;
            return new BsonDocument
            {
                { "ns", $"{db}.{coll}" }, { "count", (long)c.Docs.Count }, { "size", size },
                { "avgObjSize", c.Docs.Count == 0 ? 0 : size / c.Docs.Count }, { "storageSize", Math.Max(4096L, size / 2) },
                { "nindexes", c.Indexes.Count }, { "totalIndexSize", indexSizes.Sum(e => e.Value.ToInt64()) }, { "indexSizes", indexSizes }, { "ok", 1.0 },
            };
        }
    }

    public Task<IReadOnlyList<BsonDocument>> ListDatabasesAsync(bool authorizedOnly, CancellationToken ct)
    {
        Check(authorizedOnly ? "listDatabases.authorized" : "listDatabases");
        lock (_lock)
            return Task.FromResult<IReadOnlyList<BsonDocument>>(_dbs.Select(kv => new BsonDocument
            {
                { "name", kv.Key },
                { "sizeOnDisk", (double)Math.Max(8192, kv.Value.Values.Sum(c => c.Docs.Sum(d => (long)d.ToBson().Length))) },
                { "empty", kv.Value.Count == 0 },
            }).ToList());
    }

    public Task<IReadOnlyList<BsonDocument>> ListCollectionsAsync(string db, BsonDocument? filter, CancellationToken ct)
    {
        Check("listCollections");
        lock (_lock)
        {
            if (!_dbs.TryGetValue(db, out var colls)) return Task.FromResult<IReadOnlyList<BsonDocument>>([]);
            var list = colls.Values
                .Where(c => filter is null || !filter.TryGetValue("name", out var n) || n.AsString == c.Name)
                .Select(c => new BsonDocument
                {
                    { "name", c.Name }, { "type", c.Type }, { "options", c.Options.DeepClone() },
                    { "info", c.Type == "view" ? new BsonDocument("readOnly", true) : new BsonDocument { { "readOnly", false }, { "uuid", new BsonBinaryData(Guid.Empty, GuidRepresentation.Standard) } } },
                })
                .ToList();
            return Task.FromResult<IReadOnlyList<BsonDocument>>(list);
        }
    }

    // ---------------------------------------------------------------- reads

    public List<BsonDocument> Query(string db, string coll, FindSpec spec)
    {
        IEnumerable<BsonDocument> docs = Snapshot(db, coll).Where(d => FakeQuery.Matches(d, spec.Filter));
        docs = FakeQuery.Sort(docs, spec.Sort);
        if (spec.Skip > 0) docs = docs.Skip(spec.Skip);
        if (spec.Limit is > 0) docs = docs.Take(spec.Limit.Value);
        if (spec.Projection is { ElementCount: > 0 } p) docs = docs.Select(d => FakeQuery.Project(d, p));
        return docs.ToList();
    }

    public Task<IReadOnlyList<BsonDocument>> FindAsync(string db, string coll, FindSpec spec, CancellationToken ct)
    {
        Check("find");
        return Task.FromResult<IReadOnlyList<BsonDocument>>(Query(db, coll, spec));
    }

    public async IAsyncEnumerable<BsonDocument> FindStreamAsync(string db, string coll, FindSpec spec, [EnumeratorCancellation] CancellationToken ct)
    {
        Check("find");
        foreach (var d in Query(db, coll, spec))
        {
            ct.ThrowIfCancellationRequested();
            yield return d;
        }
        await Task.CompletedTask;
    }

    public async Task<long> CountDocumentsAsync(string db, string coll, BsonDocument filter, TimeSpan? maxTime, CancellationToken ct)
    {
        Check("count");
        if (CountDelay > TimeSpan.Zero)
        {
            if (maxTime is { } mt && mt < CountDelay)
            {
                await Task.Delay(mt, ct);
                throw Timeout();
            }
            await Task.Delay(CountDelay, ct);
        }
        return Snapshot(db, coll).Count(d => FakeQuery.Matches(d, filter));
    }

    public Task<long> EstimatedCountAsync(string db, string coll, TimeSpan? maxTime, CancellationToken ct)
    {
        Check("estimatedCount");
        var c = Find(db, coll);
        if (c?.Type == "view") throw Command(166, "CommandNotSupportedOnView", $"Namespace {db}.{coll} is a view, not a collection");
        lock (_lock) return Task.FromResult((long)(c?.Docs.Count ?? 0));
    }

    private List<BsonDocument> RunPipeline(string db, string coll, IReadOnlyList<BsonDocument> pipeline)
    {
        if (pipeline.Count > 0 && pipeline[0].GetElement(0).Name == "$collStats")
        {
            Check("collStats");
            var s = CollStats(db, coll);
            return [new BsonDocument { { "ns", s["ns"] }, { "host", Host }, { "localTime", DateTime.UtcNow }, { "storageStats", s } }];
        }
        if (pipeline.Count > 0 && pipeline[0].GetElement(0).Name == "$indexStats")
        {
            Check("indexStats");
            var c = Find(db, coll);
            if (c?.Type == "view") throw Command(166, "CommandNotSupportedOnView", "$indexStats is not supported on views");
            lock (_lock)
                return (c?.Indexes ?? []).Select(i => new BsonDocument
                {
                    { "name", i["name"] }, { "key", i["key"] }, { "host", Host },
                    { "accesses", new BsonDocument { { "ops", (long)Calls.GetValueOrDefault("ixops:" + i["name"].AsString) }, { "since", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc) } } },
                    { "spec", i.DeepClone() },
                }).ToList();
        }
        return FakePipeline.Run(this, db, Snapshot(db, coll), pipeline);
    }

    public Task<IReadOnlyList<BsonDocument>> AggregateAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec, CancellationToken ct)
    {
        Check("aggregate");
        return Task.FromResult<IReadOnlyList<BsonDocument>>(RunPipeline(db, coll, pipeline));
    }

    public async IAsyncEnumerable<BsonDocument> AggregateStreamAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec,
        [EnumeratorCancellation] CancellationToken ct)
    {
        Check("aggregate");
        foreach (var d in RunPipeline(db, coll, pipeline))
        {
            ct.ThrowIfCancellationRequested();
            yield return d;
        }
        await Task.CompletedTask;
    }

    // ---------------------------------------------------------------- writes

    private static string KeyOf(BsonDocument doc, BsonDocument key) =>
        string.Join("|", key.Names.Select(n => Ejson.Canonical(new BsonDocument("k", BsonKit.GetPath(doc, n) ?? BsonNull.Value))));

    /// <summary>The unique-index violation of <paramref name="doc"/> against the others, or null.</summary>
    private static string? Duplicate(Coll c, BsonDocument doc, BsonDocument? ignore, string ns)
    {
        foreach (var index in c.Indexes)
        {
            var isId = index["name"].AsString == "_id_";
            if (!isId && !(index.TryGetValue("unique", out var u) && u.ToBoolean())) continue;
            var key = index["key"].AsBsonDocument;
            if (index.TryGetValue("sparse", out var sp) && sp.ToBoolean() && key.Names.All(n => BsonKit.GetPath(doc, n) is null)) continue;
            var k = KeyOf(doc, key);
            if (c.Docs.Any(o => !ReferenceEquals(o, ignore) && KeyOf(o, key) == k))
                return $"E11000 duplicate key error collection: {ns} index: {index["name"].AsString} dup key: {{ {string.Join(", ", key.Names.Select(n => $"{n}: {Ejson.Relaxed(BsonKit.GetPath(doc, n) ?? BsonNull.Value)}"))} }}";
        }
        return null;
    }

    public Task<InsertManyResult> InsertManyAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, bool ordered, CancellationToken ct)
    {
        Check("insert");
        var c = Writable(db, coll);
        var errors = new List<WriteFailure>();
        long inserted = 0;
        var events = new List<BsonDocument>();
        lock (_lock)
        {
            for (var i = 0; i < docs.Count; i++)
            {
                var d = docs[i].DeepClone().AsBsonDocument;
                if (!d.Contains("_id")) d.InsertAt(0, new BsonElement("_id", ObjectId.GenerateNewId()));
                if (Duplicate(c, d, null, $"{db}.{coll}") is { } dup)
                {
                    errors.Add(new WriteFailure(i, 11000, dup));
                    if (ordered) break;
                    continue;
                }
                c.Docs.Add(d);
                inserted++;
                events.Add(Change("insert", db, coll, d["_id"], d, null));
            }
        }
        Publish(events);
        return Task.FromResult(new InsertManyResult(inserted, errors));
    }

    public Task<ReplaceResult> ReplaceOneAsync(string db, string coll, BsonDocument filter, BsonDocument doc, bool upsert, CancellationToken ct)
    {
        Check("replace");
        var c = Writable(db, coll);
        BsonDocument ev;
        ReplaceResult result;
        lock (_lock)
        {
            var i = c.Docs.FindIndex(d => FakeQuery.Matches(d, filter));
            if (i < 0)
            {
                if (!upsert) return Task.FromResult(new ReplaceResult(0, 0, null));
                var n = doc.DeepClone().AsBsonDocument;
                if (!n.Contains("_id")) n.InsertAt(0, new BsonElement("_id", filter.GetValue("_id", ObjectId.GenerateNewId())));
                c.Docs.Add(n);
                ev = Change("insert", db, coll, n["_id"], n, null);
                result = new ReplaceResult(0, 0, n["_id"]);
            }
            else
            {
                var old = c.Docs[i];
                var n = doc.DeepClone().AsBsonDocument;
                if (!n.Contains("_id")) n.InsertAt(0, new BsonElement("_id", old["_id"]));
                if (Duplicate(c, n, old, $"{db}.{coll}") is { } dup) throw Command(11000, "DuplicateKey", dup);
                var modified = !n.Equals(old);
                c.Docs[i] = n;
                ev = Change("replace", db, coll, n["_id"], n, null);
                result = new ReplaceResult(1, modified ? 1 : 0, null);
            }
        }
        Publish([ev]);
        return Task.FromResult(result);
    }

    public Task<BulkUpsertResult> BulkUpsertAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, string key, bool ordered, CancellationToken ct)
    {
        Check("bulkUpsert");
        var c = Writable(db, coll);
        long upserted = 0, matched = 0, modified = 0;
        var errors = new List<WriteFailure>();
        var events = new List<BsonDocument>();
        lock (_lock)
        {
            for (var i = 0; i < docs.Count; i++)
            {
                var d = docs[i].DeepClone().AsBsonDocument;
                var k = BsonKit.GetPath(d, key) ?? BsonNull.Value;
                var at = c.Docs.FindIndex(x => FakeQuery.FieldMatches(x, key, k));
                if (at >= 0)
                {
                    if (!d.Contains("_id")) d.InsertAt(0, new BsonElement("_id", c.Docs[at]["_id"]));
                    if (Duplicate(c, d, c.Docs[at], $"{db}.{coll}") is { } dup)
                    {
                        errors.Add(new WriteFailure(i, 11000, dup));
                        if (ordered) break;
                        continue;
                    }
                    matched++;
                    if (!d.Equals(c.Docs[at])) modified++;
                    c.Docs[at] = d;
                    events.Add(Change("replace", db, coll, d["_id"], d, null));
                }
                else
                {
                    if (!d.Contains("_id")) d.InsertAt(0, new BsonElement("_id", ObjectId.GenerateNewId()));
                    if (Duplicate(c, d, null, $"{db}.{coll}") is { } dup)
                    {
                        errors.Add(new WriteFailure(i, 11000, dup));
                        if (ordered) break;
                        continue;
                    }
                    c.Docs.Add(d);
                    upserted++;
                    events.Add(Change("insert", db, coll, d["_id"], d, null));
                }
            }
        }
        Publish(events);
        return Task.FromResult(new BulkUpsertResult(upserted, matched, modified, errors));
    }

    public Task<long> DeleteManyAsync(string db, string coll, BsonDocument filter, CancellationToken ct)
    {
        Check("delete");
        var c = Writable(db, coll);
        List<BsonDocument> gone;
        lock (_lock)
        {
            gone = c.Docs.Where(d => FakeQuery.Matches(d, filter)).ToList();
            c.Docs.RemoveAll(d => gone.Contains(d));
        }
        Publish(gone.Select(d => Change("delete", db, coll, d["_id"], null, null)).ToList());
        return Task.FromResult((long)gone.Count);
    }

    /// <summary>An update (for change-stream tests): sets fields like <c>$set</c>.</summary>
    public void Update(string db, string coll, BsonValue id, BsonDocument set, params string[] unset)
    {
        var c = Writable(db, coll);
        BsonDocument ev;
        lock (_lock)
        {
            var d = c.Docs.First(x => BsonKit.ValueEquals(x["_id"], id));
            foreach (var e in set) BsonKit.SetPath(d, e.Name, e.Value);
            foreach (var u in unset) BsonKit.RemovePath(d, u);
            ev = Change("update", db, coll, id, null, new BsonDocument { { "updatedFields", set }, { "removedFields", new BsonArray(unset) }, { "truncatedArrays", new BsonArray() } });
        }
        Publish([ev]);
    }

    // ---------------------------------------------------------------- indexes / DDL

    public Task<IReadOnlyList<BsonDocument>> ListIndexesAsync(string db, string coll, CancellationToken ct)
    {
        Check("listIndexes");
        var c = Find(db, coll) ?? throw Command(26, "NamespaceNotFound", $"ns does not exist: {db}.{coll}");
        if (c.Type == "view") throw Command(166, "CommandNotSupportedOnView", $"Namespace {db}.{coll} is a view, not a collection");
        lock (_lock) return Task.FromResult<IReadOnlyList<BsonDocument>>(c.Indexes.Select(i => i.DeepClone().AsBsonDocument).ToList());
    }

    public async Task<string> CreateIndexAsync(string db, string coll, BsonDocument indexSpec, CancellationToken ct)
    {
        Check("createIndex");
        var c = Writable(db, coll);
        if (IndexBuildGate is { } gate) await gate.Task.WaitAsync(ct);
        lock (_lock)
        {
            var name = indexSpec["name"].AsString;
            var existing = c.Indexes.FirstOrDefault(i => i["name"].AsString == name);
            if (existing is not null)
            {
                if (existing["key"].Equals(indexSpec["key"])) return name;
                throw Command(85, "IndexOptionsConflict", $"An existing index has the same name as the requested index. Requested index: {indexSpec}");
            }
            var spec = new BsonDocument("v", 2);
            spec.AddRange(indexSpec);
            if (spec.TryGetValue("unique", out var u) && u.ToBoolean())
            {
                var keys = c.Docs.Select(d => KeyOf(d, spec["key"].AsBsonDocument)).ToList();
                if (keys.Count != keys.Distinct().Count()) throw Command(11000, "DuplicateKey", $"Index build failed: E11000 duplicate key error collection: {db}.{coll} index: {name}");
            }
            if (spec["key"].AsBsonDocument.Any(e => e.Value is BsonString { Value: "text" }))
            {
                var key = new BsonDocument { { "_fts", "text" }, { "_ftsx", 1 } };
                var weights = new BsonDocument();
                foreach (var e in spec["key"].AsBsonDocument)
                    if (e.Value is BsonString { Value: "text" }) weights[e.Name] = 1;
                spec["key"] = key;
                spec["weights"] = weights;
                spec["default_language"] = "english";
                spec["language_override"] = "language";
                spec["textIndexVersion"] = 3;
            }
            c.Indexes.Add(spec);
            return name;
        }
    }

    public Task DropIndexAsync(string db, string coll, string name, CancellationToken ct)
    {
        Check("dropIndex");
        var c = Writable(db, coll);
        lock (_lock)
            if (c.Indexes.RemoveAll(i => i["name"].AsString == name) == 0) throw Command(27, "IndexNotFound", $"index not found with name [{name}]");
        return Task.CompletedTask;
    }

    public Task CreateCollectionAsync(string db, string name, BsonDocument options, CancellationToken ct)
    {
        Check("create");
        if (Find(db, name) is not null) throw Command(48, "NamespaceExists", $"Collection {db}.{name} already exists.");
        var c = Collection(db, name);
        c.Options = options.DeepClone().AsBsonDocument;
        if (options.Contains("viewOn")) c.Type = "view";
        else if (options.Contains("timeseries")) c.Type = "timeseries";
        if (c.Type != "collection") c.Indexes.Clear();
        return Task.CompletedTask;
    }

    public Task DropCollectionAsync(string db, string coll, CancellationToken ct)
    {
        Check("drop");
        lock (_lock)
            if (_dbs.TryGetValue(db, out var colls)) colls.Remove(coll);
        return Task.CompletedTask;
    }

    public Task DropDatabaseAsync(string db, CancellationToken ct)
    {
        Check("dropDatabase");
        lock (_lock) _dbs.Remove(db);
        return Task.CompletedTask;
    }

    public Task RenameCollectionAsync(string db, string coll, string newName, bool dropTarget, CancellationToken ct)
    {
        Check("rename");
        lock (_lock)
        {
            if (!_dbs.TryGetValue(db, out var colls) || !colls.TryGetValue(coll, out var c))
                throw Command(26, "NamespaceNotFound", $"Source collection {db}.{coll} does not exist");
            if (colls.ContainsKey(newName) && !dropTarget) throw Command(48, "NamespaceExists", $"target namespace exists");
            colls.Remove(coll);
            c.Name = newName;
            colls[newName] = c;
        }
        return Task.CompletedTask;
    }

    // ---------------------------------------------------------------- change streams

    private BsonDocument Change(string op, string db, string coll, BsonValue id, BsonDocument? full, BsonDocument? update)
    {
        var t = Interlocked.Increment(ref _clock);
        var ev = new BsonDocument
        {
            { "_id", new BsonDocument("_data", $"8266{t:X8}") },
            { "operationType", op },
            { "clusterTime", new BsonTimestamp(1_760_000_000 + t, 1) },
            { "wallTime", new BsonDateTime(1_760_000_000_000L + t * 1000L) },
            { "ns", new BsonDocument { { "db", db }, { "coll", coll } } },
            { "documentKey", new BsonDocument("_id", id) },
        };
        if (full is not null) ev["fullDocument"] = full.DeepClone();
        if (update is not null) ev["updateDescription"] = update;
        return ev;
    }

    private void Publish(IReadOnlyList<BsonDocument> events)
    {
        if (events.Count == 0) return;
        List<(string Db, string? Coll, bool Lookup, Channel<BsonDocument> Channel)> watchers;
        lock (_watchers) watchers = _watchers.ToList();
        foreach (var ev in events)
        {
            var ns = ev["ns"].AsBsonDocument;
            foreach (var w in watchers)
            {
                if (w.Db != ns["db"].AsString || (w.Coll is not null && w.Coll != ns["coll"].AsString)) continue;
                var copy = ev.DeepClone().AsBsonDocument;
                if (w.Lookup && copy["operationType"] == "update")
                {
                    var current = Snapshot(ns["db"].AsString, ns["coll"].AsString)
                        .FirstOrDefault(d => BsonKit.ValueEquals(d["_id"], copy["documentKey"]["_id"]));
                    copy["fullDocument"] = (BsonValue?)current ?? BsonNull.Value;
                }
                w.Channel.Writer.TryWrite(copy);
            }
        }
    }

    /// <summary>Number of open change streams.</summary>
    public int Watchers
    {
        get
        {
            lock (_watchers) return _watchers.Count;
        }
    }

    public async IAsyncEnumerable<BsonDocument> WatchAsync(string db, string? coll, bool fullDocumentUpdateLookup, [EnumeratorCancellation] CancellationToken ct)
    {
        Check("watch");
        if (Standalone) throw Command(40573, "Location40573", "The $changeStream stage is only supported on replica sets");
        var channel = Channel.CreateUnbounded<BsonDocument>();
        var entry = (db, coll, fullDocumentUpdateLookup, channel);
        lock (_watchers) _watchers.Add(entry);
        try
        {
            await foreach (var ev in channel.Reader.ReadAllAsync(ct)) yield return ev;
        }
        finally
        {
            lock (_watchers) _watchers.Remove(entry);
        }
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}
