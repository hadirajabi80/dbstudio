using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DotNet.Testcontainers.Builders;
using DotNet.Testcontainers.Containers;

namespace DbStudio.Sources.Elasticsearch.Tests;

/// <summary>
/// A real cluster for the live suites: <c>DBSTUDIO_ES_URL</c> / <c>DBSTUDIO_OS_URL</c>, else a container on a random port
/// (Elasticsearch 8.15.3 with security off; OpenSearch 2 only when <c>DBSTUDIO_ES_OPENSEARCH=1</c>), seeded once with the
/// docker seed (the <c>put_index</c> mappings of seed-elasticsearch.sh + the NDJSON). Skipped when <c>DBSTUDIO_IT=0</c>
/// or Docker is unavailable.
/// </summary>
public sealed class LiveBackend
{
    public const string EsImage = "docker.elastic.co/elasticsearch/elasticsearch:8.15.3";
    public const string OsImage = "opensearchproject/opensearch:2";

    public static readonly LiveBackend Elasticsearch = new("elasticsearch");
    public static readonly LiveBackend OpenSearch = new("opensearch");

    private readonly string _flavor;
    private readonly Lazy<Task<(string? Url, string? Skip)>> _start;

    private LiveBackend(string flavor)
    {
        _flavor = flavor;
        _start = new Lazy<Task<(string?, string?)>>(StartAsync);
    }

    public Task<(string? Url, string? Skip)> GetAsync() => _start.Value;

    private async Task<(string?, string?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0") return (null, "Integration tests disabled (DBSTUDIO_IT=0).");
        var os = _flavor == "opensearch";
        var external = Environment.GetEnvironmentVariable(os ? "DBSTUDIO_OS_URL" : "DBSTUDIO_ES_URL");
        string url;
        if (!string.IsNullOrWhiteSpace(external)) url = external.TrimEnd('/');
        else
        {
            if (os && Environment.GetEnvironmentVariable("DBSTUDIO_ES_OPENSEARCH") != "1")
                return (null, "OpenSearch suite: set DBSTUDIO_ES_OPENSEARCH=1 (container) or DBSTUDIO_OS_URL.");
            // docker.elastic.co can be unreachable behind proxies: the same image is on Docker Hub (library/elasticsearch).
            var images = new[] { Environment.GetEnvironmentVariable(os ? "DBSTUDIO_OS_IMAGE" : "DBSTUDIO_ES_IMAGE"), os ? OsImage : EsImage, os ? null : EsHubImage }
                .Where(i => !string.IsNullOrWhiteSpace(i)).Distinct().ToList();
            Exception? last = null;
            string? started = null;
            foreach (var image in images)
            {
                try
                {
                    started = await StartContainerAsync(image!, os).ConfigureAwait(false);
                    break;
                }
                catch (Exception ex)
                {
                    last = ex;
                }
            }
            if (started is null) return (null, $"Docker/{_flavor} container unavailable: {last?.GetType().Name}: {last?.Message}");
            url = started;
        }
        await SeedAsync(url).ConfigureAwait(false);
        return (url, null);
    }

    public const string EsHubImage = "elasticsearch:8.15.3";

    private static async Task<string> StartContainerAsync(string image, bool os)
    {
        var builder = new ContainerBuilder(image)
            .WithPortBinding(9200, true)
            .WithEnvironment("discovery.type", "single-node")
            .WithEnvironment("cluster.routing.allocation.disk.threshold_enabled", "false")
            .WithWaitStrategy(Wait.ForUnixContainer().UntilHttpRequestIsSucceeded(r => r.ForPort(9200).ForPath("/_cluster/health")))
            .WithLabel("dbstudio.test", "es-live");
        builder = os
            ? builder.WithEnvironment("DISABLE_SECURITY_PLUGIN", "true").WithEnvironment("DISABLE_INSTALL_DEMO_CONFIG", "true")
                .WithEnvironment("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m")
            : builder.WithEnvironment("xpack.security.enabled", "false").WithEnvironment("ES_JAVA_OPTS", "-Xms512m -Xmx512m");
        IContainer container = builder.Build();
        try
        {
            await container.StartAsync().ConfigureAwait(false);
        }
        catch
        {
            await container.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
        };
        return $"http://{container.Hostname}:{container.GetMappedPublicPort(9200)}";
    }

    /// <summary>Same steps as seed-elasticsearch.sh: drop, create with the script's mappings, bulk the NDJSON.</summary>
    public static async Task SeedAsync(string url)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "docker");
        var script = await File.ReadAllTextAsync(Path.Combine(dir, "seed-elasticsearch.sh"));
        using var t = new EsTransport(EsSettings.From(Es.Profile(url), null));
        // Wait for yellow (the container may answer before the cluster is ready).
        await t.SendAsync(HttpMethod.Get, "_cluster/health?wait_for_status=yellow&timeout=60s", null, null, default, TimeSpan.FromSeconds(90));
        foreach (Match m in Regex.Matches(script, @"put_index (\S+) <<'JSON'\n(.*?)\nJSON", RegexOptions.Singleline))
        {
            var name = m.Groups[1].Value;
            await t.SendAsync(HttpMethod.Delete, name, null, null, default);
            var res = await t.SendAsync(HttpMethod.Put, name, Encoding.UTF8.GetBytes(m.Groups[2].Value), "application/json", default);
            if (!res.Ok) throw new InvalidOperationException($"seed: PUT {name} → {res.Status} {res.Text}");
        }
        var bulk = await File.ReadAllBytesAsync(Path.Combine(dir, "seed-elasticsearch.ndjson"));
        var r = await t.NdjsonAsync("_bulk?refresh=true", bulk, default, TimeSpan.FromMinutes(3));
        if (r.Bool("errors") == true) throw new InvalidOperationException("seed: bulk reported errors: " + r.GetRawText()[..Math.Min(2000, r.GetRawText().Length)]);
    }
}

public abstract class LiveSuite(LiveBackend backend, string flavor)
{
    protected async Task<EndpointHost> HostAsync()
    {
        var (url, skip) = await backend.GetAsync();
        Skip.If(url is null, skip);
        return await EndpointHost.StartAsync(url);
    }

    /// <summary>Elasticsearch SQL quotes names with "…", OpenSearch SQL with backticks.</summary>
    private string Q(string name) => flavor == "opensearch" ? $"`{name}`" : $"\"{name}\"";

    private static string U(string prefix) => $"{prefix}-{Guid.NewGuid():N}"[..Math.Min(40, prefix.Length + 33)];

    [SkippableFact]
    public async Task Cluster_indices_and_aliases_of_the_seed()
    {
        await using var h = await HostAsync();
        var c = $"es/{h.Cid}";
        var (_, cluster) = await h.Get($"{c}/cluster");
        Assert.Equal(flavor, cluster.GetProperty("flavor").GetString());
        Assert.NotEqual("red", cluster.GetProperty("status").GetString());
        var (_, nodes) = await h.Get($"{c}/nodes");
        Assert.True(nodes.GetArrayLength() >= 1);
        Assert.Contains(nodes.EnumerateArray(), n => n.GetProperty("master").GetBoolean());
        var (_, indices) = await h.Get($"{c}/indices");
        var counts = indices.EnumerateArray().ToDictionary(i => i.GetProperty("name").GetString()!, i => i.GetProperty("docsCount").GetInt64());
        Assert.Equal(200, counts["shop-customers"]);
        Assert.Equal(50, counts["shop-products"]);
        Assert.Equal(2000, counts["shop-orders"]);
        Assert.Contains("shop-sales", indices.EnumerateArray().Single(i => i.GetProperty("name").GetString() == "shop-orders").GetProperty("aliases").EnumerateArray().Select(a => a.GetString()));
        var (_, aliases) = await h.Get($"{c}/aliases");
        Assert.Contains(aliases.EnumerateArray(), a => a.GetProperty("alias").GetString() == "shop-sales");
        var (_, detail) = await h.Get($"{c}/indices/shop-orders");
        Assert.Equal(2, detail.GetProperty("shards").EnumerateArray().Count(s => s.GetProperty("prirep").GetString() == "p"));
        var (_, fields) = await h.Get($"{c}/indices/shop-orders/fields");
        var f = fields.EnumerateArray().ToDictionary(x => x.GetProperty("path").GetString()!, x => x.GetProperty("type").GetString());
        Assert.Equal("nested", f["items"]);
        Assert.Equal("integer", f["items.qty"]);
        Assert.Equal(200, (await h.Get($"{c}/templates")).Status);
        Assert.Equal(200, (await h.Get($"{c}/datastreams")).Status);
    }

    [SkippableFact]
    public async Task Search_aggregations_persian_text_and_nested()
    {
        await using var h = await HostAsync();
        var c = $"es/{h.Cid}";
        var (s, agg) = await h.Post($"{c}/search", new { index = "shop-sales", body = new { size = 0, aggs = new { by_status = new { terms = new { field = "status" } } } } });
        Assert.Equal(200, s);
        Assert.Equal(2000, agg.GetProperty("total").GetInt64());
        var buckets = agg.GetProperty("aggregations").GetProperty("by_status").GetProperty("buckets").EnumerateArray().ToList();
        Assert.Equal(4, buckets.Count);
        Assert.Equal(2000, buckets.Sum(b => b.GetProperty("doc_count").GetInt64()));

        var (_, fa) = await h.Post($"{c}/search", new { index = "shop-customers", body = new { query = new { match = new { name = "رضایی" } } } });
        Assert.Equal("c0ffee000000000000000002", fa.GetProperty("hits")[0].GetProperty("id").GetString());
        var (_, nested) = await h.Post($"{c}/search", new { index = "shop-orders", body = new { query = new { nested = new { path = "items", query = new { term = new Dictionary<string, object> { ["items.sku"] = "SKU-0001" } } } } }, size = 1 });
        Assert.True(nested.GetProperty("total").GetInt64() > 0);
        // keyset paging through search_after
        var (_, p1) = await h.Post($"{c}/search", new { index = "shop-products", body = new { sort = new object[] { new { sku = "asc" } } }, size = 20 });
        var last = p1.GetProperty("hits")[19].GetProperty("sort");
        var (_, p2) = await h.Post($"{c}/search", new { index = "shop-products", body = new { sort = new object[] { new { sku = "asc" } } }, size = 20, searchAfter = last });
        Assert.Equal("SKU-0021", p2.GetProperty("hits")[0].GetProperty("source").GetProperty("sku").GetString());
        var (bad, err) = await h.Post($"{c}/search", new { index = "shop-orders", body = new { query = new { bogus_query = new { } } } });
        Assert.Equal(422, bad);
        Assert.NotNull(err.GetProperty("error").GetProperty("detail").GetProperty("esType").GetString());
    }

    [SkippableFact]
    public async Task Document_edit_with_optimistic_concurrency()
    {
        await using var h = await HostAsync();
        var c = $"es/{h.Cid}";
        var index = U("it-docs");
        Assert.Equal(204, (await h.Post($"{c}/indices", new { name = index, shards = 1, replicas = 0 })).Status);
        var (_, created) = await h.Put($"{c}/indices/{index}/docs/a%2Fb", new { source = new { name = "مریم", n = 1 }, create = true });
        Assert.Equal("created", created.GetProperty("result").GetString());
        var (_, doc) = await h.Get($"{c}/indices/{index}/docs/a%2Fb");
        Assert.Equal("مریم", doc.GetProperty("source").GetProperty("name").GetString());
        var seq = doc.GetProperty("seqNo").GetInt64();
        var term = doc.GetProperty("primaryTerm").GetInt64();
        Assert.Equal(200, (await h.Put($"{c}/indices/{index}/docs/a%2Fb", new { source = new { name = "x", n = 2 }, ifSeqNo = seq, ifPrimaryTerm = term })).Status);
        var (conflict, err) = await h.Put($"{c}/indices/{index}/docs/a%2Fb", new { source = new { name = "stale" }, ifSeqNo = seq, ifPrimaryTerm = term });
        Assert.Equal(409, conflict);
        Assert.Equal("version_conflict_engine_exception", err.GetProperty("error").GetProperty("detail").GetProperty("esType").GetString());
        var (_, auto) = await h.Post($"{c}/indices/{index}/docs", new { source = new { n = 3 } });
        Assert.False(string.IsNullOrEmpty(auto.GetProperty("id").GetString()));
        Assert.False((await h.Get($"{c}/indices/{index}/docs/nope")).Body.GetProperty("found").GetBoolean());
        Assert.Equal("deleted", (await h.Delete($"{c}/indices/{index}/docs/a%2Fb")).Body.GetProperty("result").GetString());
        Assert.Equal(200, (await h.Post($"{c}/indices/{index}/actions/refresh")).Status);
        Assert.Equal(204, (await h.Put($"{c}/indices/{index}/settings", new { settings = new { index = new { number_of_replicas = 0 } } })).Status);
        Assert.Equal(204, (await h.Put($"{c}/indices/{index}/mappings", new { mappings = new { properties = new { added = new { type = "keyword" } } } })).Status);
        Assert.Equal(204, (await h.Post($"{c}/aliases", new { actions = new[] { new { add = new { index, alias = index + "-alias" } } } })).Status);
        Assert.Contains((await h.Get($"{c}/aliases")).Body.EnumerateArray(), a => a.GetProperty("alias").GetString() == index + "-alias");
        Assert.Equal(204, (await h.Delete($"{c}/indices/{index}")).Status);
        Assert.Equal(404, (await h.Get($"{c}/indices/{index}")).Status);
    }

    [SkippableFact]
    public async Task Console_sql_and_tasks()
    {
        await using var h = await HostAsync();
        var c = $"es/{h.Cid}";
        var (_, cat) = await h.Post($"{c}/console", new { method = "GET", path = "_cat/indices?v" });
        Assert.Equal(200, cat.GetProperty("status").GetInt32());
        Assert.Contains("shop-orders", cat.GetProperty("body").GetString());
        var (_, missing) = await h.Post($"{c}/console", new { method = "GET", path = "/no-such-index/_search" });
        Assert.Equal(404, missing.GetProperty("status").GetInt32());
        var (_, search) = await h.Post($"{c}/console", new { method = "POST", path = "/shop-products/_search", body = "{\n  \"size\": 1,\n  \"query\": { \"term\": { \"sku\": \"SKU-0001\" } }\n}" });
        Assert.Contains("Oak Lamp", search.GetProperty("body").GetString());
        Assert.Equal(403, (await h.Post($"es/{h.ReadOnlyCid}/console", new { method = "DELETE", path = "/shop-orders" })).Status);

        var (ss, sql) = await h.Post($"{c}/sql", new { query = $"SELECT status, COUNT(*) AS n FROM {Q("shop-orders")} GROUP BY status ORDER BY status" });
        Assert.True(ss == 200, sql.ToString());
        Assert.Equal(4, sql.GetProperty("rows").GetArrayLength());
        Assert.Equal("n", sql.GetProperty("columns")[1].GetProperty("name").GetString());
        var (pageS, page) = await h.Post($"{c}/sql", new { query = $"SELECT sku FROM {Q("shop-products")} ORDER BY sku", fetchSize = 20 });
        Assert.True(pageS == 200, page.ToString());
        Assert.Equal(20, page.GetProperty("rows").GetArrayLength());
        if (page.GetProperty("cursor").GetString() is { } cursor)
        {
            var (_, next) = await h.Post($"{c}/sql", new { cursor });
            Assert.Equal(20, next.GetProperty("rows").GetArrayLength());
            await h.Post($"{c}/sql/close", new { cursor = next.GetProperty("cursor").GetString() ?? cursor });
        }
        Assert.Equal(200, (await h.Post($"{c}/sql/translate", new { query = $"SELECT sku FROM {Q("shop-products")} WHERE stock > 10" })).Status);

        var (_, tasks) = await h.Get($"{c}/tasks?detailed=true");
        Assert.Contains(tasks.EnumerateArray(), t => t.GetProperty("action").GetString()!.StartsWith("cluster:monitor/tasks/lists", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task Reindex_export_and_import_jobs()
    {
        await using var h = await HostAsync();
        var c = $"es/{h.Cid}";
        var copy = U("it-copy");
        var (s, started) = await h.Post($"{c}/reindex", new { source = "shop-orders", dest = copy, query = new { term = new { status = "paid" } } });
        Assert.Equal(202, s);
        var jobId = started.GetProperty("jobId").GetString()!;
        var done = await h.Events.DoneAsync(jobId, 120_000);
        Assert.True(done.Status == ExecutionStatus.Ok, done.Error);
        var created = done.Result!.Value.GetProperty("created").GetInt64();
        Assert.True(created > 0);
        Assert.Contains(h.Events.Of<JobProgressEvent>(), e => e.JobId == jobId);
        var (_, count) = await h.Post($"{c}/search", new { index = copy, body = new { size = 0 } });
        Assert.Equal(created, count.GetProperty("total").GetInt64());

        var file = Path.Combine(Path.GetTempPath(), $"{copy}.ndjson");
        try
        {
            var (_, exp) = await h.Post($"{c}/export", new { index = "shop-products", format = "ndjson", path = file, includeMeta = true });
            var expDone = await h.Events.DoneAsync(exp.GetProperty("jobId").GetString()!, 60_000);
            Assert.True(expDone.Status == ExecutionStatus.Ok, expDone.Error);
            Assert.Equal(50, expDone.Result!.Value.GetProperty("docs").GetInt64());
            var target = U("it-import");
            var (_, imp) = await h.Post($"{c}/import", new { index = target, format = "ndjson", path = file, batchSize = 7 });
            var impDone = await h.Events.DoneAsync(imp.GetProperty("jobId").GetString()!, 60_000);
            Assert.True(impDone.Status == ExecutionStatus.Ok, impDone.Error);
            Assert.Equal(50, impDone.Result!.Value.GetProperty("indexed").GetInt64());
            var (_, doc) = await h.Get($"{c}/indices/{target}/docs/ab0de0000000000000000001");
            Assert.Equal("SKU-0001", doc.GetProperty("source").GetProperty("sku").GetString());
            var (_, csvImp) = await h.Post($"{c}/import", new { index = target, format = "csv", upload = "sku,name,stock\nX-1,علی,3\n", idField = "sku" });
            Assert.Equal(1, (await h.Events.DoneAsync(csvImp.GetProperty("jobId").GetString()!, 60_000)).Result!.Value.GetProperty("indexed").GetInt64());
            await h.Delete($"{c}/indices/{target}");
        }
        finally
        {
            File.Delete(file);
            await h.Delete($"{c}/indices/{copy}");
        }
        using var res = await h.Http.PostAsync($"{c}/export", new StringContent("""{"index":"shop-customers","format":"csv","max":5}""", Encoding.UTF8, "application/json"));
        var csv = (await res.Content.ReadAsStringAsync()).TrimStart('﻿').Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(6, csv.Length);
        Assert.StartsWith("_id,", csv[0]);
    }

    [SkippableFact]
    public async Task Test_connection_reads_the_server()
    {
        var (url, skip) = await backend.GetAsync();
        Skip.If(url is null, skip);
        var r = await new EsProvider().TestAsync(Es.Profile(url!), null, default);
        Assert.True(r.Ok, r.Error?.Message);
        Assert.StartsWith(flavor == "opensearch" ? "OpenSearch " : "Elasticsearch ", r.ServerInfo!.Version);
        var bad = await new EsProvider().TestAsync(Es.Profile("http://127.0.0.1:1"), null, default);
        Assert.False(bad.Ok);
    }
}

public sealed class ElasticsearchLiveTests() : LiveSuite(LiveBackend.Elasticsearch, "elasticsearch");

public sealed class OpenSearchLiveTests() : LiveSuite(LiveBackend.OpenSearch, "opensearch");
