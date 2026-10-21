using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

/// <summary>The module's endpoints on a TestServer with the Core singletons and a MongoProvider over a <see cref="MongoFake"/>.</summary>
internal sealed class EndpointHost : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly string _dir;

    public MongoFake Fake { get; }
    public HttpClient Http { get; }
    public RecordingPublisher Events { get; }
    public string Cid { get; }
    public IServiceProvider Services => _app.Services;
    public int Opens;

    private EndpointHost(WebApplication app, string dir, MongoFake fake, RecordingPublisher events, string cid)
    {
        _app = app;
        _dir = dir;
        Fake = fake;
        Events = events;
        Cid = cid;
        Http = app.GetTestClient();
        Http.DefaultRequestHeaders.Add("X-DbStudio-Client", "ui-test");
    }

    public static async Task<EndpointHost> StartAsync(MongoFake? fake = null, bool readOnly = false, string? database = null)
    {
        fake ??= T.Shop();
        var dir = T.TempDir();
        var events = new RecordingPublisher();
        EndpointHost? host = null;
        var provider = new MongoProvider((_, _, _) =>
        {
            if (host is not null) Interlocked.Increment(ref host.Opens);
            return Task.FromResult<IMongoGateway>(fake);
        });
        var registry = new SourceRegistry(new ProviderRegistry([]), [provider]);
        var store = new ConnectionStore(new AppPaths(dir), new InMemorySecretStore(), registry);
        var profile = T.Profile(readOnly: readOnly, database: database, id: "");
        var created = store.Create(profile, null);

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseTestServer();
        var s = builder.Services;
        s.AddSingleton(registry);
        s.AddSingleton(store);
        s.AddSingleton<IEventPublisher>(events);
        s.AddSingleton(sp => new SourceClientManager(registry, store, events));
        s.AddSingleton(sp => new JobManager(events));
        s.AddSingleton(sp => new StreamManager(events, kind => sp.GetKeyedService<IStreamFactory>(kind), store, clients: sp.GetRequiredService<SourceClientManager>(),
            options: new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(20) }));
        MongoModule.AddServices(s);
        var app = builder.Build();
        app.Use(async (ctx, next) =>
        {
            try
            {
                await next(ctx);
            }
            catch (EngineException e)
            {
                ctx.Response.StatusCode = e.Status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                await ctx.Response.WriteAsync(JsonSerializer.Serialize(new { error = new { code = e.Code, message = e.Message, detail = e.Detail } }, CoreJson.Options));
            }
        });
        new MongoModule().MapEndpoints(app.MapGroup("/api/v1"));
        await app.StartAsync();
        host = new EndpointHost(app, dir, fake, events, created.Id);
        return host;
    }

    public string Url(string path) => $"/api/v1/mongo/{Cid}{path}";

    public Task<HttpResponseMessage> Post(string path, object body) =>
        Http.PostAsync(Url(path), new StringContent(JsonSerializer.Serialize(body, CoreJson.Options), Encoding.UTF8, "application/json"));

    public Task<HttpResponseMessage> Put(string path, object body) =>
        Http.PutAsync(Url(path), new StringContent(JsonSerializer.Serialize(body, CoreJson.Options), Encoding.UTF8, "application/json"));

    public Task<HttpResponseMessage> Delete(string path, object? body = null) =>
        Http.SendAsync(new HttpRequestMessage(HttpMethod.Delete, Url(path))
        {
            Content = body is null ? null : new StringContent(JsonSerializer.Serialize(body, CoreJson.Options), Encoding.UTF8, "application/json"),
        });

    public static async Task<JsonElement> Json(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement.Clone();

    public static async Task<(int Status, string Code, JsonElement Error)> Error(HttpResponseMessage r)
    {
        var e = (await Json(r)).GetProperty("error");
        return ((int)r.StatusCode, e.GetProperty("code").GetString()!, e);
    }

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed class EndpointTests
{
    [Fact]
    public async Task Server_databases_collections_and_stats()
    {
        await using var host = await EndpointHost.StartAsync();
        var server = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/server")));
        Assert.Equal("replicaSet", server.GetProperty("type").GetString());
        Assert.Equal("MongoDB 7.0.14 (replica set rs0)", server.GetProperty("server").GetProperty("version").GetString());
        Assert.Equal("PRIMARY", server.GetProperty("members")[0].GetProperty("state").GetString());
        var dbs = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/databases")));
        Assert.Equal("shop", dbs[0].GetProperty("name").GetString());
        var colls = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/collections")));
        Assert.Equal(["customers", "orders", "paid_orders", "products"], colls.EnumerateArray().Select(c => c.GetProperty("name").GetString()));
        Assert.Equal("view", colls[2].GetProperty("type").GetString());
        var stats = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/coll/orders/stats")));
        Assert.Equal(100, stats.GetProperty("count").GetInt64());
        Assert.Equal(1, host.Opens); // one shared client
    }

    [Fact]
    public async Task Find_doc_insert_replace_delete_round_trip()
    {
        await using var host = await EndpointHost.StartAsync();
        var find = await host.Post("/db/shop/coll/customers/find", new { filter = "{ tier: 'gold' }", sort = "{ _id: 1 }", skip = 0, limit = 2 });
        Assert.Equal(HttpStatusCode.OK, find.StatusCode);
        var body = await EndpointHost.Json(find);
        Assert.Equal(2, body.GetProperty("docs").GetArrayLength());
        Assert.Equal(6, body.GetProperty("count").GetProperty("value").GetInt64());
        Assert.True(body.GetProperty("count").GetProperty("exact").GetBoolean());

        var ins = await EndpointHost.Json(await host.Post("/db/shop/coll/customers/docs", new { doc = "{ _id: 77, name: 'Zed', email: 'z@x' }" }));
        Assert.Equal("{ \"$numberInt\" : \"77\" }", ins.GetProperty("insertedId").GetString());
        var doc = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/coll/customers/doc?_id=" + Uri.EscapeDataString("{\"$numberInt\":\"77\"}"))));
        Assert.Contains("Zed", doc.GetProperty("doc").GetString());
        var rep = await EndpointHost.Json(await host.Put("/db/shop/coll/customers/docs", new Dictionary<string, object> { ["_id"] = "77", ["doc"] = "{ name: 'Zed 2' }", ["replace"] = true }));
        Assert.Equal(1, rep.GetProperty("modified").GetInt64());
        var del = await EndpointHost.Json(await host.Delete("/db/shop/coll/customers/docs", new { ids = new[] { "77" } }));
        Assert.Equal(1, del.GetProperty("deleted").GetInt64());
    }

    [Fact]
    public async Task Parse_errors_are_400_with_position()
    {
        await using var host = await EndpointHost.StartAsync();
        var r = await host.Post("/db/shop/coll/orders/find", new { filter = "{ status: 'paid', }x", limit = 5 });
        var (status, code, error) = await EndpointHost.Error(r);
        Assert.Equal((400, "VALIDATION"), (status, code));
        var detail = error.GetProperty("detail");
        Assert.Equal("filter", detail.GetProperty("field").GetString());
        Assert.Equal(19, detail.GetProperty("offset").GetInt32());
        Assert.Equal(1, detail.GetProperty("line").GetInt32());
        var bad = await EndpointHost.Error(await host.Post("/db/shop/coll/orders/find", new { filter = "{}", limit = 5000 }));
        Assert.Equal("limit", bad.Error.GetProperty("detail").GetProperty("field").GetString());
        var badJson = await host.Http.PostAsync(host.Url("/db/shop/coll/orders/find"), new StringContent("{ not json", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, badJson.StatusCode);
    }

    [Fact]
    public async Task Driver_errors_are_mapped()
    {
        await using var host = await EndpointHost.StartAsync();
        host.Fake.Fail("find", MongoFake.Unauthorized("shop", "find", "orders"), times: 1);
        var denied = await EndpointHost.Error(await host.Post("/db/shop/coll/orders/find", new { limit = 5 }));
        Assert.Equal((403, "PRIVILEGE"), (denied.Status, denied.Code));
        Assert.Equal("find on shop.orders", denied.Error.GetProperty("detail").GetProperty("needs").GetString());

        var op = await EndpointHost.Error(await host.Post("/db/shop/coll/orders/find", new { filter = "{ a: { $foo: 1 } }", limit = 5 }));
        Assert.Equal((422, "PROVIDER_ERROR"), (op.Status, op.Code));
        Assert.Equal(2, op.Error.GetProperty("detail").GetProperty("providerCode").GetInt32());

        host.Fake.Fail("find", new TimeoutException("A timeout occurred after 10000ms selecting a server."), times: 1);
        var gone = await EndpointHost.Error(await host.Post("/db/shop/coll/orders/find", new { limit = 5 }));
        Assert.Equal((503, "SOURCE_UNAVAILABLE"), (gone.Status, gone.Code));
        await host.Events.WaitAsync<SourceClientChangedEvent>(e => e.State == "broken");
        Assert.Equal(HttpStatusCode.OK, (await host.Post("/db/shop/coll/orders/find", new { limit = 5 })).StatusCode); // reopened
        Assert.Equal(2, host.Opens);
    }

    [Fact]
    public async Task Read_only_profiles_refuse_every_write()
    {
        await using var host = await EndpointHost.StartAsync(readOnly: true);
        var writes = new (string Action, Func<Task<HttpResponseMessage>> Call)[]
        {
            ("insert documents", () => host.Post("/db/shop/coll/orders/docs", new { doc = "{}" })),
            ("replace a document", () => host.Put("/db/shop/coll/customers/docs", new Dictionary<string, object> { ["_id"] = "1", ["doc"] = "{}", ["replace"] = true })),
            ("delete documents", () => host.Delete("/db/shop/coll/customers/docs", new { ids = new[] { "1" } })),
            ("create an index", () => host.Post("/db/shop/coll/orders/indexes", new { key = new[] { new { field = "total", type = 1 } } })),
            ("drop an index", () => host.Delete("/db/shop/coll/orders/indexes/status_1_createdAt_-1")),
            ("change validation", () => host.Put("/db/shop/coll/orders/validation", new { validator = "{}", level = "strict", action = "error" })),
            ("change the profiling level", () => host.Put("/db/shop/profiling", new { level = 1, slowms = 50 })),
            ("import documents", () => host.Post("/db/shop/coll/orders/import", new { format = "jsonl", upload = "{a:1}" })),
            ("create a collection", () => host.Post("/db/shop/collections", new { name = "x" })),
            ("rename a collection", () => host.Post("/db/shop/coll/orders/rename", new { newName = "orders2", dropTarget = false })),
            ("drop a collection", () => host.Delete("/db/shop/coll/orders")),
            ("drop a database", () => host.Delete("/db/shop")),
            ("run $out/$merge", () => host.Post("/db/shop/coll/orders/aggregate", new { pipeline = new[] { "{ $out: 'x' }" }, limit = 10, skip = 0, allowDiskUse = false, maxTimeMs = 1000 })),
        };
        foreach (var (action, call) in writes)
        {
            var (status, code, error) = await EndpointHost.Error(await call());
            Assert.Equal((403, "READ_ONLY"), (status, code));
            Assert.Equal(action, error.GetProperty("detail").GetProperty("action").GetString());
        }
        Assert.Equal(100, host.Fake.Snapshot("shop", "orders").Count);
        Assert.Equal(2, host.Fake.Collection("shop", "orders").Indexes.Count);
        // Reads and previews still work.
        Assert.Equal(HttpStatusCode.OK, (await host.Post("/db/shop/coll/orders/import/preview", new { format = "jsonl", upload = "{a:1}" })).StatusCode);
        var preview = await EndpointHost.Json(await host.Post("/db/shop/coll/orders/aggregate",
            new { pipeline = new[] { "{ $match: {} }", "{ $out: 'x' }" }, previewStage = 1, limit = 5, skip = 0, allowDiskUse = false, maxTimeMs = 1000 }));
        Assert.True(preview.GetProperty("writeStageSkipped").GetBoolean());
    }

    [Fact]
    public async Task Browser_mode_export_returns_the_file_as_octet_stream()
    {
        await using var host = await EndpointHost.StartAsync();
        var r = await host.Post("/db/shop/coll/orders/export", new { format = "csv", filter = "{ status: 'paid' }", fields = new[] { "status", "total" }, path = (string?)null });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("application/octet-stream", r.Content.Headers.ContentType!.MediaType);
        Assert.Equal("attachment; filename=\"orders.csv\"", r.Headers.TryGetValues("Content-Disposition", out var cd) ? cd.First() : r.Content.Headers.ContentDisposition!.ToString());
        var text = await r.Content.ReadAsStringAsync();
        Assert.StartsWith("status,total\r\npaid,42\r\n", text);
        Assert.Equal(26, text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries).Length);
    }

    [Fact]
    public async Task Export_to_a_path_and_import_are_jobs()
    {
        await using var host = await EndpointHost.StartAsync();
        var file = Path.Combine(T.TempDir(), "orders.jsonl");
        var exp = await host.Post("/db/shop/coll/orders/export", new { format = "jsonl", filter = "{}", path = file });
        Assert.Equal(HttpStatusCode.Accepted, exp.StatusCode);
        var jobId = (await EndpointHost.Json(exp)).GetProperty("jobId").GetString()!;
        var done = await host.Events.JobDone(jobId);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(100, done.Result!.Value.GetProperty("docs").GetInt64());
        Assert.Equal(file, done.Result.Value.GetProperty("path").GetString());
        Assert.Equal("mongo.export", done.Kind);

        var imp = await host.Post("/db/shop/coll/copy/import", new { format = "jsonl", path = file, mode = "insert", upsertKey = "_id", batchSize = 30, stopOnError = false });
        Assert.Equal(HttpStatusCode.Accepted, imp.StatusCode);
        var importDone = await host.Events.JobDone((await EndpointHost.Json(imp)).GetProperty("jobId").GetString()!);
        Assert.Equal(100, importDone.Result!.Value.GetProperty("inserted").GetInt64());
        Assert.Equal(100, host.Fake.Snapshot("shop", "copy").Count);
        Assert.Equal(host.Fake.Snapshot("shop", "orders"), host.Fake.Snapshot("shop", "copy")); // relaxed EJSON keeps these types
    }

    [Fact]
    public async Task Schema_job_indexes_validation_explain_fields()
    {
        await using var host = await EndpointHost.StartAsync();
        var schema = await host.Post("/db/shop/coll/customers/schema", new { sampleSize = 100 });
        Assert.Equal(HttpStatusCode.Accepted, schema.StatusCode);
        var done = await host.Events.JobDone((await EndpointHost.Json(schema)).GetProperty("jobId").GetString()!);
        var phone = done.Result!.Value.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("path").GetString() == "phone");
        Assert.Equal(["long", "string"], phone.GetProperty("types").EnumerateArray().Select(t => t.GetProperty("bsonType").GetString()));

        var idx = await EndpointHost.Json(await host.Post("/db/shop/coll/orders/indexes", new { key = new object[] { new { field = "customerId", type = 1 }, new { field = "total", type = -1 } }, options = new { } }));
        Assert.Equal("customerId_1_total_-1", idx.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, idx.GetProperty("jobId").ValueKind);
        var list = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/coll/orders/indexes")));
        Assert.Equal(3, list.GetArrayLength());
        Assert.Equal(-1, list[2].GetProperty("key")[1].GetProperty("type").GetInt32());
        Assert.Equal(HttpStatusCode.NoContent, (await host.Delete("/db/shop/coll/orders/indexes/customerId_1_total_-1")).StatusCode);
        Assert.Equal(400, (await EndpointHost.Error(await host.Delete("/db/shop/coll/orders/indexes/_id_"))).Status);

        var val = await EndpointHost.Json(await host.Put("/db/shop/coll/customers/validation", new { validator = "{ email: { $exists: true } }", level = "moderate", action = "warn" }));
        Assert.Equal("moderate", val.GetProperty("level").GetString());
        Assert.Equal("warn", (await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/coll/customers/validation")))).GetProperty("action").GetString());

        var explain = await EndpointHost.Json(await host.Post("/db/shop/coll/orders/explain", new { kind = "find", verbosity = "executionStats", filter = "{ total: { $gt: 1000 } }" }));
        Assert.Equal("COLLSCAN", explain.GetProperty("root").GetProperty("op").GetString());
        Assert.Equal(ExplainNormalizerTexts.Collscan, explain.GetProperty("warnings")[0].GetString());
        Assert.True(explain.GetProperty("summary").GetProperty("collscan").GetBoolean());

        var fields = await EndpointHost.Json(await host.Post("/db/shop/coll/orders/fields", new { }));
        Assert.Contains("items.sku", fields.GetProperty("fields").EnumerateArray().Select(f => f.GetProperty("path").GetString()));
    }

    [Fact]
    public async Task Profiling_level_reads_sets_and_validates()
    {
        await using var host = await EndpointHost.StartAsync();
        var off = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/profiling")));
        Assert.Equal((0, 100), (off.GetProperty("level").GetInt32(), off.GetProperty("slowms").GetInt32()));

        var on = await EndpointHost.Json(await host.Put("/db/shop/profiling", new { level = 1, slowms = 50, sampleRate = 0.5 }));
        Assert.Equal((1, 50, 0.5), (on.GetProperty("level").GetInt32(), on.GetProperty("slowms").GetInt32(), on.GetProperty("sampleRate").GetDouble()));
        var again = await EndpointHost.Json(await host.Http.GetAsync(host.Url("/db/shop/profiling")));
        Assert.Equal(1, again.GetProperty("level").GetInt32());

        foreach (var (body, field) in new (object, string)[]
        {
            (new { level = 3 }, "level"), (new { }, "level"), (new { level = 1, slowms = -1 }, "slowms"), (new { level = 1, sampleRate = 2.0 }, "sampleRate"),
        })
        {
            var (status, code, error) = await EndpointHost.Error(await host.Put("/db/shop/profiling", body));
            Assert.Equal((400, "VALIDATION"), (status, code));
            Assert.Equal(field, error.GetProperty("detail").GetProperty("field").GetString());
        }
        Assert.Equal(400, (await EndpointHost.Error(await host.Http.GetAsync(host.Url("/db/bad.name/profiling")))).Status);
    }

    [Fact]
    public async Task Change_stream_through_the_stream_manager()
    {
        await using var host = await EndpointHost.StartAsync();
        var streams = host.Services.GetRequiredService<StreamManager>();
        var bad = await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("mongo.changes", host.Cid, JsonSerializer.SerializeToElement(new { }), "ui-test", default));
        Assert.Equal("params.db", MongoSettingsBuilderTests.Field(bad));
        var info = await streams.OpenAsync("mongo.changes", host.Cid, JsonSerializer.SerializeToElement(new { db = "shop", coll = "orders", fullDocument = "updateLookup" }),
            "ui-test", default);
        var until = DateTime.UtcNow.AddSeconds(10);
        while (host.Fake.Watchers == 0 && DateTime.UtcNow < until) await Task.Delay(10);
        await host.Post("/db/shop/coll/orders/docs", new { doc = "{ status: 'new' }" });
        var data = await host.Events.WaitAsync<StreamDataEvent>(e => e.StreamId == info.StreamId);
        Assert.Equal("insert", data.Items[0].GetProperty("operationType").GetString());
        Assert.Equal("orders", data.Items[0].GetProperty("ns").GetProperty("coll").GetString());
        Assert.True(await streams.CloseAsync(info.StreamId));
    }
}

internal static class ExplainNormalizerTexts
{
    public const string Collscan = DbStudio.Sources.Mongo.Services.ExplainNormalizer.CollscanWarning;
}
