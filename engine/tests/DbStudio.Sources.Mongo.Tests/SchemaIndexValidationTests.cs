using DbStudio.Core.Models;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using DbStudio.Sources.Mongo.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class SchemaTests
{
    private static MongoSchemaResult Analyze(params string[] docs) => SchemaService.Analyze(docs.Select(d => ShellJson.ParseDocument(d, "doc")));

    [Fact]
    public void Mixed_types_and_probabilities()
    {
        var r = Analyze("{ a: 1, b: 'x' }", "{ a: 'one', b: null }", "{ a: 2.5 }", "{ a: 3 }");
        Assert.Equal(4, r.Sampled);
        var a = r.Fields.Single(f => f.Path == "a");
        Assert.Equal(1.0, a.Probability);
        Assert.Equal(["int", "string", "double"], a.Types.Select(t => t.BsonType));
        Assert.Equal([2L, 1L, 1L], a.Types.Select(t => t.Count));
        Assert.Equal([50.0, 25.0, 25.0], a.Types.Select(t => t.Pct));
        var b = r.Fields.Single(f => f.Path == "b");
        Assert.Equal(0.5, b.Probability);
        Assert.Equal(["string", "null"], b.Types.Select(t => t.BsonType));
    }

    [Fact]
    public void Nested_documents_and_documents_inside_arrays()
    {
        var r = Analyze("{ address: { city: 'Paris', zip: 1 }, items: [{ sku: 'a' }, { sku: 'b', qty: 2 }] }", "{ address: { city: 'Rome' }, items: [] }");
        var address = r.Fields.Single(f => f.Path == "address");
        Assert.Equal(["address.city", "address.zip"], address.Nested.Select(n => n.Path));
        Assert.Equal(0.5, address.Nested.Single(n => n.Path == "address.zip").Probability);
        var items = r.Fields.Single(f => f.Path == "items");
        Assert.Equal("array", Assert.Single(items.Types).BsonType);
        var sku = items.Nested.Single(n => n.Path == "items.sku");
        Assert.Equal(1.0, sku.Probability); // 2 of the 2 documents inside the arrays
        Assert.Equal(0.5, items.Nested.Single(n => n.Path == "items.qty").Probability);
        Assert.Empty(sku.Nested);
    }

    [Fact]
    public void Stats_and_examples()
    {
        var r = Analyze("{ n: 5, s: 'pear', d: ISODate('2024-01-02') }", "{ n: 1, s: 'apple', d: ISODate('2024-03-01') }", "{ n: 5.5, s: 'apple' }",
            $"{{ long: '{new string('x', 150)}' }}");
        var n = r.Fields.Single(f => f.Path == "n");
        Assert.Equal(1, n.Stats!.Min!.GetValue<int>());
        Assert.Equal(5.5, n.Stats.Max!.GetValue<double>());
        Assert.Equal(3, n.Stats.Distinct);
        var s = r.Fields.Single(f => f.Path == "s");
        Assert.Equal("apple", s.Stats!.Min!.GetValue<string>());
        Assert.Equal(2, s.Stats.Distinct);
        Assert.Equal(["pear", "apple"], s.Examples.Select(e => e!.GetValue<string>()));
        var d = r.Fields.Single(f => f.Path == "d");
        Assert.Equal("2024-01-02T00:00:00Z", d.Stats!.Min!["$date"]!.GetValue<string>());
        Assert.Equal(100, r.Fields.Single(f => f.Path == "long").Examples[0]!.GetValue<string>().Length);
    }

    [Fact]
    public async Task Job_analysis_reports_progress_and_uses_sample_without_filter()
    {
        var fake = T.Shop();
        var events = new RecordingPublisher();
        await using var jobs = new JobManager(events);
        var svc = new SchemaService();
        var h = T.Handle(fake);
        var id = jobs.Start("mongo.schema", "c_mongo", null, async (ctx, ct) => await svc.AnalyzeAsync(h, "shop", "orders", 50, [], ctx, ct));
        var done = await events.JobDone(id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var result = done.Result!.Value;
        Assert.Equal(50, result.GetProperty("sampled").GetInt32());
        var fields = result.GetProperty("fields").EnumerateArray().Select(f => f.GetProperty("path").GetString()).ToList();
        Assert.Equal(["_id", "customerId", "status", "total", "createdAt", "items"], fields);
        Assert.Contains(events.All.OfType<JobProgressEvent>(), e => e.JobId == id && e.Done == 50);
        Assert.Equal(1, fake.CallCount("aggregate"));
        await svc.AnalyzeAsync(h, "shop", "orders", 10, new BsonDocument("status", "paid"), null, CancellationToken.None);
        Assert.Equal(1, fake.CallCount("find"));
    }

    [Fact]
    public void Sample_size_is_validated() =>
        Assert.Throws<EngineException>(() => SchemaService.Parse(new MongoSchemaRequest { SampleSize = 100_001 }));
}

public sealed class FieldsTests
{
    [Fact]
    public void Paths_types_and_enumerable_values()
    {
        var docs = Enumerable.Range(0, 30).Select(i => ShellJson.ParseDocument(
            $"{{ _id: {i}, status: '{(i % 3 == 0 ? "paid" : "open")}', email: 'u{i}@x', vip: {(i % 2 == 0 ? "true" : "false")}, " +
            $"address: {{ city: 'Paris' }}, items: [{{ sku: 'S{i % 2}' }}], mixed: {(i % 2 == 0 ? "1" : "1.5")} }}", "d")).ToList();
        var r = FieldsService.Collect(docs);
        Assert.Equal(30, r.Sampled);
        Assert.Equal(["_id", "status", "email", "vip", "address", "address.city", "items", "items.sku", "mixed"], r.Fields.Select(f => f.Path));
        Assert.Null(r.Fields.Single(f => f.Path == "_id").Values);
        Assert.Equal(["\"open\"", "\"paid\""], r.Fields.Single(f => f.Path == "status").Values);
        Assert.Null(r.Fields.Single(f => f.Path == "email").Values); // 30 distinct
        Assert.Equal(["false", "true"], r.Fields.Single(f => f.Path == "vip").Values);
        Assert.Equal(["object"], r.Fields.Single(f => f.Path == "address").Types);
        Assert.Equal(["\"S0\"", "\"S1\""], r.Fields.Single(f => f.Path == "items.sku").Values);
        Assert.Equal(["int", "double"], r.Fields.Single(f => f.Path == "mixed").Types);
        Assert.Null(r.Fields.Single(f => f.Path == "mixed").Values);
    }

    [Fact]
    public async Task Results_are_cached_for_60_seconds()
    {
        var fake = T.Shop();
        var now = DateTimeOffset.UtcNow;
        var svc = new FieldsService { Clock = () => now };
        var h = T.Handle(fake);
        var a = await svc.FieldsAsync(h, "shop", "orders", new MongoFieldsRequest(), CancellationToken.None);
        var b = await svc.FieldsAsync(h, "shop", "orders", new MongoFieldsRequest { Filter = " " }, CancellationToken.None);
        Assert.Same(a, b);
        Assert.Equal(1, fake.CallCount("aggregate"));
        await svc.FieldsAsync(h, "shop", "orders", new MongoFieldsRequest { SampleSize = 10 }, CancellationToken.None);
        Assert.Equal(2, fake.CallCount("aggregate"));
        now = now.AddSeconds(61);
        await svc.FieldsAsync(h, "shop", "orders", new MongoFieldsRequest(), CancellationToken.None);
        Assert.Equal(3, fake.CallCount("aggregate"));
        Assert.Equal(["\"cancelled\"", "\"paid\"", "\"pending\"", "\"shipped\""], a.Fields.Single(f => f.Path == "status").Values);
    }
}

public sealed class IndexesTests
{
    private readonly IndexesService _svc = new() { InlineWait = TimeSpan.FromMilliseconds(200), ProgressInterval = TimeSpan.FromMilliseconds(20) };

    private static MongoCreateIndexRequest Req(params (string Field, JsonNode Type)[] key) =>
        new() { Key = key.Select(k => new MongoIndexKeyPartRequest { Field = k.Field, Type = k.Type }).ToList(), Options = new MongoCreateIndexOptions() };

    [Fact]
    public async Task List_with_sizes_usage_and_text_expansion()
    {
        var fake = T.Shop();
        await fake.CreateIndexAsync("shop", "products", new BsonDocument { { "key", new BsonDocument { { "name", "text" }, { "description", "text" } } }, { "name", "name_text_description_text" } }, default);
        fake.Index("shop", "orders", new BsonDocument { { "key", new BsonDocument("createdAt", 1) }, { "name", "ttl" }, { "expireAfterSeconds", 3600 }, { "partialFilterExpression", new BsonDocument("status", "paid") } });
        var list = await _svc.ListAsync(T.Handle(fake), "shop", "orders", CancellationToken.None);
        Assert.Equal(["_id_", "status_1_createdAt_-1", "ttl"], list.Select(i => i.Name));
        var compound = list[1];
        Assert.Equal(["status", "createdAt"], compound.Key.Select(k => k.Field));
        Assert.Equal([1, -1], compound.Key.Select(k => k.Type.GetValue<int>()));
        Assert.NotNull(compound.Size);
        Assert.Equal(0, compound.Usage!.Ops);
        Assert.Equal("2026-01-01T00:00:00.000Z", compound.Usage.Since);
        Assert.Equal(3600, list[2].TtlSeconds);
        Assert.Equal("{ \"status\" : \"paid\" }", list[2].PartialFilter);
        var text = (await _svc.ListAsync(T.Handle(fake), "shop", "products", CancellationToken.None)).Single(i => i.Name.Contains("text"));
        Assert.Equal([("name", "text"), ("description", "text")], text.Key.Select(k => (k.Field, k.Type.GetValue<string>())));
    }

    [Fact]
    public async Task Usage_is_null_when_indexStats_is_denied()
    {
        var fake = T.Shop();
        fake.Fail("indexStats", MongoFake.Unauthorized("shop", "aggregate", "orders"));
        var list = await _svc.ListAsync(T.Handle(fake), "shop", "orders", CancellationToken.None);
        Assert.All(list, i => Assert.Null(i.Usage));
    }

    [Fact]
    public async Task Create_generates_server_names_and_validates()
    {
        var fake = T.Shop();
        var h = T.Handle(fake);
        var r = await _svc.CreateAsync(h, "shop", "orders", Req(("customerId", 1), ("total", -1)), _ => throw new InvalidOperationException(), default);
        Assert.Equal(new MongoCreateIndexResponse("customerId_1_total_-1", null), r);
        Assert.Contains(fake.Collection("shop", "orders").Indexes, i => i["name"] == "customerId_1_total_-1");
        Assert.Equal("name_text_description_text", IndexesService.GenerateName(new BsonDocument { { "name", "text" }, { "description", "text" } }));
        var req = Req(("createdAt", 1));
        req.Options = new MongoCreateIndexOptions { ExpireAfterSeconds = 60, PartialFilterExpression = "{ status: 'paid' }", Unique = true, Name = "my_ttl" };
        var spec = IndexesService.BuildSpec(req);
        Assert.Equal(60, spec["expireAfterSeconds"].AsInt32);
        Assert.Equal("my_ttl", spec["name"].AsString);
        Assert.True(spec["unique"].AsBoolean);
        Assert.Equal(new BsonDocument("status", "paid"), spec["partialFilterExpression"]);
        Assert.Equal("key[0].type", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => IndexesService.BuildSpec(Req(("a", "bogus"))))));
        Assert.Equal("key", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => IndexesService.BuildSpec(new MongoCreateIndexRequest()))));
    }

    [Fact]
    public async Task Long_builds_become_jobs_with_progress()
    {
        var fake = T.Shop();
        fake.IndexBuildGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fake.IndexBuildProgress = (40, 100);
        var events = new RecordingPublisher();
        await using var jobs = new JobManager(events);
        var r = await _svc.CreateAsync(T.Handle(fake), "shop", "orders", Req(("total", 1)), work => jobs.Start("mongo.createIndex", "c_mongo", null, work), default);
        Assert.Equal("total_1", r.Name);
        Assert.NotNull(r.JobId);
        await events.WaitAsync<JobProgressEvent>(e => e.JobId == r.JobId && e.Done == 40 && e.Total == 100);
        fake.IndexBuildGate.SetResult();
        var done = await events.JobDone(r.JobId!);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal("total_1", done.Result!.Value.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Drop_refuses_the_id_index_and_read_only()
    {
        var fake = T.Shop();
        var ex = await Assert.ThrowsAsync<EngineException>(() => _svc.DropAsync(T.Handle(fake), "shop", "orders", "_id_", default));
        Assert.Equal((ErrorCodes.Validation, "name"), (ex.Code, MongoSettingsBuilderTests.Field(ex)));
        var ro = await Assert.ThrowsAsync<EngineException>(() => _svc.DropAsync(T.Handle(fake, readOnly: true), "shop", "orders", "status_1_createdAt_-1", default));
        Assert.Equal(ErrorCodes.ReadOnly, ro.Code);
        await _svc.DropAsync(T.Handle(fake), "shop", "orders", "status_1_createdAt_-1", default);
        Assert.Single(fake.Collection("shop", "orders").Indexes);
        var ro2 = await Assert.ThrowsAsync<EngineException>(() => _svc.CreateAsync(T.Handle(fake, readOnly: true), "shop", "orders", Req(("a", 1)), _ => "", default));
        Assert.Contains("create an index", ro2.Message);
    }
}

public sealed class ValidationAndExplorerTests
{
    [Fact]
    public async Task Validation_get_and_put()
    {
        var fake = T.Shop();
        var svc = new ValidationService();
        var h = T.Handle(fake);
        var empty = await svc.GetAsync(h, "shop", "customers", default);
        Assert.Null(empty.Validator);
        Assert.Equal(("strict", "error"), (empty.Level, empty.Action));
        var set = await svc.SetAsync(h, "shop", "customers", new MongoValidation
        {
            Validator = "{ $jsonSchema: { bsonType: 'object', required: ['email'] } }", Level = "moderate", Action = "warn",
        }, default);
        Assert.Equal(("moderate", "warn"), (set.Level, set.Action));
        Assert.Contains("$jsonSchema", set.Validator);
        var cleared = await svc.SetAsync(h, "shop", "customers", new MongoValidation { Validator = "", Level = "off", Action = "error" }, default);
        Assert.Null(cleared.Validator);
        await Assert.ThrowsAsync<EngineException>(() => svc.SetAsync(h, "shop", "customers", new MongoValidation { Level = "lax" }, default));
        var ro = await Assert.ThrowsAsync<EngineException>(() => svc.SetAsync(T.Handle(fake, readOnly: true), "shop", "customers", new MongoValidation(), default));
        Assert.Contains("change validation", ro.Message);
    }

    [Fact]
    public async Task Server_topology()
    {
        var svc = new ExplorerService();
        var rs = await svc.ServerAsync(T.Handle(T.Shop()), default);
        Assert.Equal(("replicaSet", "rs0", 21), (rs.Type, rs.SetName, rs.MaxWireVersion));
        Assert.Equal(new MongoTopologyMember("localhost:27017", "PRIMARY", true), Assert.Single(rs.Members));
        Assert.False(rs.IsAtlas);
        var fake = T.Shop();
        fake.Fail("replSetGetStatus", MongoFake.Unauthorized("admin", "replSetGetStatus"));
        fake.Host = "cluster0-shard-00-00.abcd.mongodb.net:27017";
        var atlas = await svc.ServerAsync(T.Handle(fake), default);
        Assert.Equal("PRIMARY", Assert.Single(atlas.Members).State);
        Assert.Null(atlas.Members[0].Health);
        Assert.True(atlas.IsAtlas);
        var standalone = await svc.ServerAsync(T.Handle(new MongoFake { Standalone = true }), default);
        Assert.Equal("standalone", standalone.Type);
        Assert.Null(standalone.SetName);
    }

    [Fact]
    public async Task Databases_with_privilege_fallbacks()
    {
        var svc = new ExplorerService();
        var fake = T.Shop();
        fake.Seed("crm", "leads", "{ a: 1 }");
        var all = await svc.DatabasesAsync(T.Handle(fake), default);
        Assert.Equal(["crm", "shop"], all.Select(d => d.Name));
        Assert.NotNull(all[0].SizeOnDisk);
        fake.Fail("listDatabases", MongoFake.Unauthorized("admin", "listDatabases"));
        Assert.Equal(["shop"], (await svc.DatabasesAsync(T.Handle(fake, database: "shop"), default)).Select(d => d.Name));
        Assert.Equal(1, fake.CallCount("listDatabases.authorized"));
        fake.Fail("listDatabases.authorized", MongoFake.Unauthorized("admin", "listDatabases"));
        var only = Assert.Single(await svc.DatabasesAsync(T.Handle(fake, database: "shop"), default));
        Assert.Equal(new MongoDatabaseInfo("shop", null, false), only);
        var denied = await Assert.ThrowsAsync<MongoDB.Driver.MongoCommandException>(() => svc.DatabasesAsync(T.Handle(fake), default));
        Assert.Equal(ErrorCodes.Privilege, MongoErrors.Map(denied)!.Code);
    }

    [Fact]
    public async Task Collections_with_types_counts_and_budget()
    {
        var fake = T.Shop();
        fake.Seed("shop", "system.views", "{ a: 1 }");
        var svc = new ExplorerService();
        var list = await svc.CollectionsAsync(T.Handle(fake), "shop", default);
        Assert.Equal(["customers", "orders", "paid_orders", "products"], list.Select(c => c.Name));
        Assert.Equal(new MongoCollectionInfo("orders", "collection", 100, false, null), list[1]);
        Assert.Equal(new MongoCollectionInfo("paid_orders", "view", null, true, "orders"), list[2]);
        fake.Fail("estimatedCount", MongoFake.Timeout());
        Assert.All(await svc.CollectionsAsync(T.Handle(fake), "shop", default), c => Assert.Null(c.Count));
    }

    [Fact]
    public async Task Stats_for_collections_and_views()
    {
        var svc = new ExplorerService();
        var fake = T.Shop();
        var s = await svc.StatsAsync(T.Handle(fake), "shop", "orders", default);
        Assert.Equal(100, s.Count);
        Assert.Equal(2, s.Indexes);
        Assert.True(s.Size > 0);
        Assert.NotNull(s.AvgObjSize);
        var v = await svc.StatsAsync(T.Handle(fake), "shop", "paid_orders", default);
        Assert.Equal(new MongoCollectionStats(25, 0, null, null, 0, null), v);
        fake.Fail("collStats", MongoFake.Command(13, "Unauthorized", "not authorized on shop to execute command { aggregate: \"orders\" }"), times: 1);
        Assert.Equal(100, (await svc.StatsAsync(T.Handle(fake), "shop", "orders", default)).Count); // falls back to the command
    }

    [Fact]
    public async Task Collection_ddl()
    {
        var fake = T.Shop();
        var svc = new ExplorerService();
        var h = T.Handle(fake);
        await svc.CreateCollectionAsync(h, "shop", new MongoCreateCollectionRequest
        {
            Name = "events", Options = new MongoCreateCollectionOptions { Capped = true, Size = 4096, Max = 100, Validator = "{ a: { $exists: true } }" },
        }, default);
        var events = fake.Collection("shop", "events");
        Assert.True(events.Options["capped"].AsBoolean);
        Assert.Equal(new BsonDocument("a", new BsonDocument("$exists", true)), events.Options["validator"]);
        await svc.CreateCollectionAsync(h, "shop", new MongoCreateCollectionRequest
        {
            Name = "big", Options = new MongoCreateCollectionOptions { ViewOn = "orders", Pipeline = ["{ $match: { total: { $gt: 900 } } }"] },
        }, default);
        Assert.Equal(15, fake.Snapshot("shop", "big").Count);
        await svc.CreateCollectionAsync(h, "shop", new MongoCreateCollectionRequest
        {
            Name = "metrics", Options = new MongoCreateCollectionOptions { Timeseries = new MongoTimeseriesOptions { TimeField = "ts", MetaField = "host", Granularity = "minutes" } },
        }, default);
        Assert.Equal("timeseries", fake.Collection("shop", "metrics").Type);
        await Assert.ThrowsAsync<EngineException>(() => svc.CreateCollectionAsync(h, "shop", new MongoCreateCollectionRequest
        {
            Name = "c", Options = new MongoCreateCollectionOptions { Capped = true },
        }, default));
        await Assert.ThrowsAsync<EngineException>(() => svc.CreateCollectionAsync(h, "shop", new MongoCreateCollectionRequest { Name = "a$b" }, default));
        await svc.RenameCollectionAsync(h, "shop", "events", new MongoRenameCollectionRequest { NewName = "events2" }, default);
        Assert.Contains("events2", (await svc.CollectionsAsync(h, "shop", default)).Select(c => c.Name));
        await svc.DropCollectionAsync(h, "shop", "events2", default);
        await svc.DropDatabaseAsync(h, "shop", default);
        Assert.Empty(await svc.CollectionsAsync(h, "shop", default));
        Assert.Equal("db", MongoSettingsBuilderTests.Field(await Assert.ThrowsAsync<EngineException>(() => svc.CollectionsAsync(h, "bad.name", default))));
    }
}
