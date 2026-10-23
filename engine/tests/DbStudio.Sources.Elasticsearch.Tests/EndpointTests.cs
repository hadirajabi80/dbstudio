using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch.Tests;

/// <summary>The /es/{cid}/… endpoints over FakeEs on a TestServer (envelope, READ_ONLY, 409 conflicts, jobs, stream).</summary>
public sealed class EndpointTests : IAsyncLifetime
{
    private EndpointHost _h = null!;

    public async Task InitializeAsync()
    {
        _h = await EndpointHost.StartAsync();
        var orders = _h.Fake.Add("shop-orders", ("o1", new { status = "paid", total = 10.5 }), ("o2", new { status = "shipped", total = 3 }), ("o/3", new { status = "paid", total = 7 }));
        orders.Aliases.Add("shop-sales");
        orders.Mappings = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse("""{"properties":{"status":{"type":"keyword"},"total":{"type":"double"}}}""")!;
        _h.Fake.Add("shop-products", ("p1", new { name = "Oak Lamp" }));
        _h.Fake.Add(".internal", ("x", new { a = 1 }));
    }

    public async Task DisposeAsync() => await _h.DisposeAsync();

    private string C => $"es/{_h.Cid}";
    private string Ro => $"es/{_h.ReadOnlyCid}";

    [Fact]
    public async Task Cluster_nodes_and_indices()
    {
        var (s, cluster) = await _h.Get($"{C}/cluster");
        Assert.Equal(200, s);
        Assert.Equal("fake-cluster", cluster.GetProperty("clusterName").GetString());
        Assert.Equal("elasticsearch", cluster.GetProperty("flavor").GetString());
        Assert.Equal("green", cluster.GetProperty("status").GetString());
        Assert.Equal(12345, cluster.GetProperty("storeBytes").GetInt64());
        var (_, nodes) = await _h.Get($"{C}/nodes");
        Assert.True(nodes[0].GetProperty("master").GetBoolean());
        Assert.Contains("ml", nodes[0].GetProperty("roles").EnumerateArray().Select(r => r.GetString()));

        var (_, visible) = await _h.Get($"{C}/indices");
        Assert.Equal(["shop-orders", "shop-products"], visible.EnumerateArray().Select(i => i.GetProperty("name").GetString()));
        var o = visible[0];
        Assert.Equal(3, o.GetProperty("docsCount").GetInt64());
        Assert.Equal(["shop-sales"], o.GetProperty("aliases").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal("2025-01-01T00:00:00.000Z", o.GetProperty("createdAt").GetString());
        var (_, all) = await _h.Get($"{C}/indices?hidden=true");
        var internalIndex = all.EnumerateArray().Single(i => i.GetProperty("name").GetString() == ".internal");
        Assert.True(internalIndex.GetProperty("hidden").GetBoolean());
        Assert.True(internalIndex.GetProperty("system").GetBoolean());
    }

    [Fact]
    public async Task Aliases_datastreams_templates_detail_and_fields()
    {
        var (_, aliases) = await _h.Get($"{C}/aliases");
        Assert.Equal("shop-sales", aliases[0].GetProperty("alias").GetString());
        Assert.Equal(JsonValueKind.Array, (await _h.Get($"{C}/datastreams")).Body.ValueKind);
        Assert.Equal(200, (await _h.Get($"{C}/templates")).Status);

        var (s, detail) = await _h.Get($"{C}/indices/shop-sales");
        Assert.Equal(200, s);
        Assert.Equal("shop-orders", detail.GetProperty("name").GetString());
        Assert.Equal("keyword", detail.GetProperty("mappings").GetProperty("properties").GetProperty("status").GetProperty("type").GetString());
        Assert.Equal("STARTED", detail.GetProperty("shards")[0].GetProperty("state").GetString());
        Assert.Equal(3, detail.GetProperty("stats").GetProperty("primaries").GetProperty("docs").GetProperty("count").GetInt32());
        Assert.Equal("open", detail.GetProperty("summary").GetProperty("status").GetString());

        var (_, fields) = await _h.Get($"{C}/indices/shop-*/fields");
        Assert.Equal(["status", "total"], fields.EnumerateArray().Select(f => f.GetProperty("path").GetString()));
        var (nf, err) = await _h.Get($"{C}/indices/nope");
        Assert.Equal(404, nf);
        Assert.Equal("NOT_FOUND", err.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("index_not_found_exception", err.GetProperty("error").GetProperty("detail").GetProperty("esType").GetString());
    }

    [Fact]
    public async Task Search_with_paging_and_aggregations()
    {
        var (s, r) = await _h.Post($"{C}/search", new { index = "shop-*", body = new { query = new { match_all = new { } }, aggs = new { by_status = new { terms = new { field = "status" } } } }, size = 2, from = 0 });
        Assert.Equal(200, s);
        Assert.Equal(4, r.GetProperty("total").GetInt64());
        Assert.Equal(2, r.GetProperty("hits").GetArrayLength());
        Assert.True(r.GetProperty("hits")[0].GetProperty("seqNo").ValueKind == JsonValueKind.Number);
        Assert.Equal("paid", r.GetProperty("aggregations").GetProperty("by_status").GetProperty("buckets")[0].GetProperty("key").GetString());
        Assert.True(r.GetProperty("request").GetProperty("seq_no_primary_term").GetBoolean());
        var (bad, err) = await _h.Post($"{C}/search", new { index = "shop-orders", body = new { query = new { bogus = new { } } } });
        Assert.Equal(422, bad);
        Assert.Equal("PROVIDER_ERROR", err.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("malformed", err.GetProperty("error").GetProperty("detail").GetProperty("rootCause").GetString());
        Assert.Equal(400, (await _h.Post($"{C}/search", new { index = "" })).Status);
    }

    [Fact]
    public async Task Documents_with_optimistic_concurrency()
    {
        var (s, doc) = await _h.Get($"{C}/indices/shop-orders/docs/o%2F3");
        Assert.Equal(200, s);
        Assert.Equal("o/3", doc.GetProperty("id").GetString());
        Assert.True(doc.GetProperty("found").GetBoolean());
        var seq = doc.GetProperty("seqNo").GetInt64();
        var term = doc.GetProperty("primaryTerm").GetInt64();

        var (ok, saved) = await _h.Put($"{C}/indices/shop-orders/docs/o%2F3", new { source = new { status = "refunded", total = 7 }, ifSeqNo = seq, ifPrimaryTerm = term });
        Assert.Equal(200, ok);
        Assert.Equal("updated", saved.GetProperty("result").GetString());
        Assert.Contains("refresh=wait_for", _h.Fake.Requests.Last().PathAndQuery);

        var (conflict, err) = await _h.Put($"{C}/indices/shop-orders/docs/o%2F3", new { source = new { status = "stale" }, ifSeqNo = seq, ifPrimaryTerm = term });
        Assert.Equal(409, conflict);
        Assert.Equal("version_conflict_engine_exception", err.GetProperty("error").GetProperty("detail").GetProperty("esType").GetString());
        Assert.Equal("refunded", _h.Fake.Indices["shop-orders"].Docs["o/3"].Source["status"]!.GetValue<string>());

        var (created, auto) = await _h.Post($"{C}/indices/shop-orders/docs", new { source = new { status = "new" } });
        Assert.True(created == 200, auto.ToString());
        Assert.Equal("created", auto.GetProperty("result").GetString());
        var (_, missing) = await _h.Get($"{C}/indices/shop-orders/docs/zzz");
        Assert.False(missing.GetProperty("found").GetBoolean());
        var (_, del) = await _h.Delete($"{C}/indices/shop-orders/docs/o1");
        Assert.Equal("deleted", del.GetProperty("result").GetString());
        var (_, gone) = await _h.Delete($"{C}/indices/shop-orders/docs/o1");
        Assert.Equal("not_found", gone.GetProperty("result").GetString());
        Assert.Equal(400, (await _h.Put($"{C}/indices/shop-orders/docs/x", new { source = new[] { 1 } })).Status);
    }

    [Fact]
    public async Task Index_management()
    {
        Assert.Equal(204, (await _h.Post($"{C}/indices", new { name = "logs-1", shards = 2, replicas = 0, body = new { mappings = new { properties = new { msg = new { type = "text" } } } } })).Status);
        var body = System.Text.Json.Nodes.JsonNode.Parse(_h.Fake.Requests.Last().Body!)!;
        Assert.Equal(2, body["settings"]!["number_of_shards"]!.GetValue<int>());
        Assert.True(_h.Fake.Indices.ContainsKey("logs-1"));
        var (dup, err) = await _h.Post($"{C}/indices", new { name = "logs-1" });
        Assert.Equal(422, dup);
        Assert.Contains("resource_already_exists_exception", err.GetProperty("error").GetProperty("message").GetString());
        Assert.Equal(400, (await _h.Post($"{C}/indices", new { name = "Bad" })).Status);
        Assert.Equal(200, (await _h.Post($"{C}/indices/logs-1/actions/refresh")).Status);
        Assert.Equal(400, (await _h.Post($"{C}/indices/logs-1/actions/explode")).Status);
        Assert.Equal(204, (await _h.Post($"{C}/aliases", new { actions = new[] { new { add = new { index = "logs-1", alias = "logs" } } } })).Status);
        Assert.Contains("logs", _h.Fake.Indices["logs-1"].Aliases);
        Assert.Equal(400, (await _h.Delete($"{C}/indices/logs-*")).Status);
        Assert.Equal(400, (await _h.Delete($"{C}/indices/_all")).Status);
        Assert.Equal(204, (await _h.Delete($"{C}/indices/logs-1")).Status);
        Assert.False(_h.Fake.Indices.ContainsKey("logs-1"));
    }

    [Fact]
    public async Task Read_only_connections_answer_READ_ONLY_for_writes()
    {
        var writes = new (HttpMethod Method, string Path, object? Body)[]
        {
            (HttpMethod.Put, $"{Ro}/indices/shop-orders/docs/o1", new { source = new { a = 1 } }),
            (HttpMethod.Post, $"{Ro}/indices/shop-orders/docs", new { source = new { a = 1 } }),
            (HttpMethod.Delete, $"{Ro}/indices/shop-orders/docs/o1", null),
            (HttpMethod.Post, $"{Ro}/indices", new { name = "x" }),
            (HttpMethod.Delete, $"{Ro}/indices/shop-orders", null),
            (HttpMethod.Post, $"{Ro}/indices/shop-orders/actions/close", new { }),
            (HttpMethod.Put, $"{Ro}/indices/shop-orders/settings", new { settings = new { number_of_replicas = 1 } }),
            (HttpMethod.Put, $"{Ro}/indices/shop-orders/mappings", new { mappings = new { properties = new { } } }),
            (HttpMethod.Post, $"{Ro}/aliases", new { actions = new[] { new { add = new { index = "shop-orders", alias = "x" } } } }),
            (HttpMethod.Post, $"{Ro}/reindex", new { source = "shop-orders", dest = "copy" }),
            (HttpMethod.Post, $"{Ro}/import", new { index = "shop-orders", format = "ndjson", upload = "{}" }),
            (HttpMethod.Post, $"{Ro}/tasks/node1:1/cancel", new { }),
            (HttpMethod.Post, $"{Ro}/console", new { method = "PUT", path = "/x" }),
        };
        foreach (var (m, p, b) in writes)
        {
            var (s, body) = await _h.Send(m, p, b);
            Assert.True(s == 403, $"{m} {p} → {s} {body}");
            Assert.Equal("READ_ONLY", body.GetProperty("error").GetProperty("code").GetString());
        }
        Assert.Equal(200, (await _h.Post($"{Ro}/search", new { index = "shop-orders" })).Status);
        Assert.Equal(200, (await _h.Post($"{Ro}/indices/shop-orders/actions/refresh")).Status);
        Assert.Equal(200, (await _h.Post($"{Ro}/sql", new { query = "SELECT 1" })).Status);
        Assert.Equal(200, (await _h.Post($"{Ro}/console", new { method = "GET", path = "_cat/indices" })).Status);
        Assert.Equal(200, (await _h.Post($"{Ro}/export", new { index = "shop-orders", format = "ndjson" })).Status);
    }

    [Fact]
    public async Task Console_and_sql_endpoints()
    {
        var (s, r) = await _h.Post($"{C}/console", new { method = "GET", path = "_cat/indices?format=json" });
        Assert.Equal(200, s);
        Assert.Equal(200, r.GetProperty("status").GetInt32());
        Assert.Contains("shop-orders", r.GetProperty("body").GetString());
        var (_, err) = await _h.Post($"{C}/console", new { method = "GET", path = "/missing-index" });
        Assert.Equal(404, err.GetProperty("status").GetInt32());
        Assert.Equal(400, (await _h.Post($"{C}/console", new { method = "GET", path = "http://other/" })).Status);
        var (_, sql) = await _h.Post($"{C}/sql", new { query = "SELECT status FROM x" });
        Assert.Equal("status", sql.GetProperty("columns")[0].GetProperty("name").GetString());
        Assert.Equal(204, (await _h.Post($"{C}/sql/close", new { cursor = "c1" })).Status);
        Assert.Equal(JsonValueKind.Object, (await _h.Post($"{C}/sql/translate", new { query = "SELECT 1" })).Body.GetProperty("dsl").ValueKind);
    }

    [Fact]
    public async Task Reindex_import_and_export_jobs_report_progress()
    {
        var (s, started) = await _h.Post($"{C}/reindex", new { source = "shop-orders", dest = "orders-copy" });
        Assert.Equal(202, s);
        var job = started.GetProperty("jobId").GetString()!;
        var done = await _h.Events.DoneAsync(job);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(3, done.Result!.Value.GetProperty("created").GetInt64());
        Assert.Contains(_h.Events.Of<JobProgressEvent>(), e => e.JobId == job && e.Done == 3);
        Assert.Equal(3, _h.Fake.Indices["orders-copy"].Docs.Count);
        Assert.Equal(400, (await _h.Post($"{C}/reindex", new { source = "a", dest = "a" })).Status);

        var (_, imp) = await _h.Post($"{C}/import", new { index = "imported", format = "csv", upload = "id,name\n1,a\n2,b\n", idField = "id" });
        var impDone = await _h.Events.DoneAsync(imp.GetProperty("jobId").GetString()!);
        Assert.Equal(ExecutionStatus.Ok, impDone.Status);
        Assert.Equal(2, impDone.Result!.Value.GetProperty("indexed").GetInt64());
        Assert.True(_h.Fake.Indices["imported"].Docs.ContainsKey("2"));

        var path = Path.Combine(Path.GetTempPath(), $"es-export-{Guid.NewGuid():N}.ndjson");
        try
        {
            var (es, exp) = await _h.Post($"{C}/export", new { index = "shop-orders", format = "ndjson", path });
            Assert.Equal(202, es);
            var expDone = await _h.Events.DoneAsync(exp.GetProperty("jobId").GetString()!);
            Assert.Equal(ExecutionStatus.Ok, expDone.Status);
            Assert.Equal(3, expDone.Result!.Value.GetProperty("docs").GetInt64());
            Assert.Equal(3, File.ReadAllLines(path).Length);
        }
        finally { File.Delete(path); }

        // Browser mode: the file is the response.
        using var res = await _h.Http.PostAsync($"{C}/export", new StringContent("""{"index":"shop-orders","format":"csv"}""", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal("application/octet-stream", res.Content.Headers.ContentType!.MediaType);
        Assert.Contains("shop-orders.csv", res.Content.Headers.ContentDisposition!.ToString());
        Assert.StartsWith("_id,", (await res.Content.ReadAsStringAsync()).TrimStart('﻿'));
    }

    [Fact]
    public async Task Tasks_list_cancel_and_stream()
    {
        await _h.Post($"{C}/reindex", new { source = "shop-orders", dest = "orders-copy2" });
        await Task.Delay(100);
        var (_, tasks) = await _h.Get($"{C}/tasks?actions=*reindex");
        Assert.Contains("reindex", tasks[0].GetProperty("action").GetString());
        Assert.Contains("actions=%2Areindex", _h.Fake.Requests.Last(r => r.PathAndQuery.StartsWith("/_tasks?", StringComparison.Ordinal)).PathAndQuery);
        Assert.Equal(204, (await _h.Post($"{C}/tasks/node1:1/cancel")).Status);
        Assert.Equal(400, (await _h.Post($"{C}/tasks/bad/cancel")).Status);

        var (s, st) = await _h.Post("streams", new { kind = "es.tasks", connectionId = _h.Cid, @params = new { intervalMs = 1000 } });
        Assert.Equal(202, s);
        var streamId = st.GetProperty("streamId").GetString();
        var until = DateTime.UtcNow.AddSeconds(10);
        StreamDataEvent? data = null;
        while (DateTime.UtcNow < until && (data = _h.Events.Of<StreamDataEvent>().FirstOrDefault(e => e.StreamId == streamId)) is null) await Task.Delay(20);
        Assert.NotNull(data);
        Assert.True(data!.Items[0].GetProperty("tasks").GetArrayLength() >= 1);
        Assert.Equal(400, (await _h.Post("streams", new { kind = "es.tasks", connectionId = _h.Cid, @params = new { intervalMs = 10 } })).Status);
    }

    [Fact]
    public async Task Test_connection_and_unknown_connection()
    {
        var (_, ok) = await _h.Post("connections/test", new { profile = Es.Profile(), password = (string?)null });
        Assert.True(ok.GetProperty("ok").GetBoolean());
        Assert.Contains("Elasticsearch 8.15.3", ok.GetProperty("serverInfo").GetProperty("version").GetString());
        Assert.Equal(404, (await _h.Get("es/c_nope/cluster")).Status);
    }
}
