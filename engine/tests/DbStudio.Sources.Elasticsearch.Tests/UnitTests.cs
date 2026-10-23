using System.Text;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Elasticsearch.Services;

namespace DbStudio.Sources.Elasticsearch.Tests;

public sealed class SettingsTests
{
    [Fact]
    public void Parses_urls_auth_and_options()
    {
        var p = Es.Profile("localhost:9200, https://b.example:9243/es/", props: [("auth", "basic"), ("user", "elastic"), ("tlsSkipVerify", true), ("connectTimeout", 3), ("flavor", "OpenSearch")]);
        var s = EsSettings.From(p, "pw");
        Assert.Equal(["http://localhost:9200/", "https://b.example:9243/es/"], s.Urls.Select(u => u.ToString()));
        Assert.Equal("basic", s.Auth);
        Assert.Equal("pw", s.Password);
        Assert.True(s.TlsSkipVerify);
        Assert.Equal(TimeSpan.FromSeconds(3), s.ConnectTimeout);
        Assert.Equal("opensearch", s.Flavor);
    }

    [Theory]
    [InlineData("", "url")]
    [InlineData("ftp://x", "url")]
    [InlineData("http://u:p@x:9200", "url")]
    [InlineData("http://x:9200/?a=1", "url")]
    public void Rejects_bad_urls(string url, string field)
    {
        var ex = Assert.Throws<EngineException>(() => EsSettings.From(Es.Profile(url), null));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        Assert.Contains(field, JsonSerializer.Serialize(ex.Detail));
    }

    [Fact]
    public void Auth_requires_its_secret()
    {
        Assert.Throws<EngineException>(() => EsSettings.From(Es.Profile(props: [("auth", "apiKey")]), null));
        Assert.Throws<EngineException>(() => EsSettings.From(Es.Profile(props: [("auth", "bearer")]), null));
        Assert.Throws<EngineException>(() => EsSettings.From(Es.Profile(props: [("auth", "basic")]), null));
        Assert.Throws<EngineException>(() => EsSettings.From(Es.Profile(props: [("auth", "kerberos")]), null));
    }

    [Fact]
    public void Auth_headers()
    {
        var basic = EsTransport.AuthHeader(EsSettings.From(Es.Profile(props: [("auth", "basic"), ("user", "elastic")]), "secret"))!;
        Assert.Equal("Basic", basic.Scheme);
        Assert.Equal("elastic:secret", Encoding.UTF8.GetString(Convert.FromBase64String(basic.Parameter!)));
        var pair = EsTransport.AuthHeader(EsSettings.From(Es.Profile(props: [("auth", "apiKey"), ("apiKey", "id1:key1")]), null))!;
        Assert.Equal("ApiKey", pair.Scheme);
        Assert.Equal("id1:key1", Encoding.UTF8.GetString(Convert.FromBase64String(pair.Parameter!)));
        var encoded = EsTransport.AuthHeader(EsSettings.From(Es.Profile(props: [("auth", "apiKey"), ("apiKey", "aWQxOmtleTE=")]), null))!;
        Assert.Equal("aWQxOmtleTE=", encoded.Parameter);
        var bearer = EsTransport.AuthHeader(EsSettings.From(Es.Profile(props: [("auth", "bearer"), ("token", "tok")]), null))!;
        Assert.Equal("Bearer tok", bearer.ToString());
        Assert.Null(EsTransport.AuthHeader(EsSettings.From(Es.Profile(), null)));
    }

    [Fact]
    public async Task Sends_the_auth_header()
    {
        var fake = new FakeEs();
        await using var c = await Es.ClientAsync(fake, Es.Profile(props: [("auth", "bearer"), ("token", "tok")]));
        Assert.All(fake.Requests, r => Assert.Equal("Bearer tok", r.Authorization));
    }
}

public sealed class TransportTests
{
    [Fact]
    public async Task Fails_over_to_the_next_url_and_sticks_to_it()
    {
        var fake = new FakeEs();
        fake.Down.Add("a:9200");
        await using var c = await Es.ClientAsync(fake, Es.Profile("http://a:9200,http://b:9200"));
        Assert.Equal("b:9200", c.Transport.CurrentUrl.Authority);
        var before = fake.Requests.Count;
        await c.Transport.GetAsync("_cluster/health", default);
        Assert.Equal("b:9200", fake.Requests.Last().Uri.Authority);
        Assert.Equal(before + 1, fake.Requests.Count); // no retry against a once it moved on
    }

    [Fact]
    public async Task All_nodes_down_is_source_unavailable()
    {
        var fake = new FakeEs();
        fake.Down.Add("a:9200");
        fake.Down.Add("b:9200");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new EsProvider(_ => fake).OpenAsync(Es.Profile("http://a:9200,http://b:9200"), null, default));
        Assert.Equal(ErrorCodes.SourceUnavailable, ex.Code);
        Assert.Contains("a:9200, b:9200", ex.Message);
        var test = await new EsProvider(_ => fake).TestAsync(Es.Profile("http://a:9200"), null, default);
        Assert.False(test.Ok);
        Assert.Contains("Cannot reach", test.Error!.Message);
    }

    [Fact]
    public async Task Detects_elasticsearch_and_opensearch()
    {
        var es = new FakeEs();
        await using (var c = await Es.ClientAsync(es))
        {
            Assert.Equal("elasticsearch", c.Flavor);
            Assert.Equal("8.15.3", c.Version);
            Assert.Equal(8, c.Major);
            Assert.Equal("Elasticsearch 8.15.3 (cluster fake-cluster, green, 1 node)", c.Server.Version);
            Assert.Equal("fake-cluster", c.Server.ServerName);
        }
        var os = new FakeEs { Flavor = "opensearch", Version = "2.17.1" };
        await using (var c = await Es.ClientAsync(os))
        {
            Assert.Equal("opensearch", c.Flavor);
            Assert.StartsWith("OpenSearch 2.17.1", c.Server.Version);
        }
        // The profile overrides detection.
        await using (var c = await Es.ClientAsync(new FakeEs(), Es.Profile(props: [("flavor", "opensearch")])))
            Assert.True(c.IsOpenSearch);
        Assert.Equal("opensearch", EsProvider.DetectFlavor(Es.J("""{"tagline":"The OpenSearch Project: https://opensearch.org/","version":{"number":"1.3.0"}}""")));
    }

    [Fact]
    public async Task Test_connection_reports_auth_failure()
    {
        var fake = new FakeEs();
        fake.On("GET", "/", _ => (401, new { error = new { type = "security_exception", reason = "missing authentication credentials for REST request [/]" }, status = 401 }));
        var r = await new EsProvider(_ => fake).TestAsync(Es.Profile(), null, default);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.ProviderError, r.Error!.Code);
        Assert.Contains("Authentication failed: security_exception: missing authentication credentials", r.Error.Message);
    }
}

public sealed class ErrorMappingTests
{
    private static EsResponse Res(int status, string body) => new(status, "x", "application/json", Encoding.UTF8.GetBytes(body), 1);

    [Fact]
    public void Maps_root_cause_and_status()
    {
        var ex = EsErrors.FromResponse(Res(400, """{"error":{"root_cause":[{"type":"parsing_exception","reason":"[bogus] query malformed"}],"type":"x_content_parse_exception","reason":"[1:10] failed"},"status":400}"""));
        Assert.Equal(422, ex.Status);
        Assert.Equal(ErrorCodes.ProviderError, ex.Code);
        Assert.Equal("x_content_parse_exception: [1:10] failed", ex.Message);
        var d = Assert.IsType<EsErrorDetail>(ex.Detail);
        Assert.Equal(400, d.Status);
        Assert.Equal("x_content_parse_exception", d.EsType);
        Assert.Equal("parsing_exception: [bogus] query malformed", d.RootCause);
    }

    [Fact]
    public void Maps_not_found_conflict_privilege_and_plain_bodies()
    {
        Assert.Equal((404, ErrorCodes.NotFound), Pair(EsErrors.FromResponse(Res(404, """{"error":{"type":"index_not_found_exception","reason":"no such index [x]"},"status":404}"""))));
        var conflict = EsErrors.FromResponse(Res(409, """{"error":{"type":"version_conflict_engine_exception","reason":"[1]: version conflict"},"status":409}"""));
        Assert.Equal((409, ErrorCodes.ProviderError), Pair(conflict));
        Assert.Equal("version_conflict_engine_exception", ((EsErrorDetail)conflict.Detail!).EsType);
        var priv = EsErrors.FromResponse(Res(403, """{"error":{"type":"security_exception","reason":"action [indices:admin/create] is unauthorized"},"status":403}"""));
        Assert.Equal((403, ErrorCodes.Privilege), Pair(priv));
        Assert.Contains(EsErrors.PrivilegeNeeds, JsonSerializer.Serialize(priv.Detail));
        Assert.Equal("old style", EsErrors.FromResponse(Res(500, """{"error":"old style","status":500}""")).Message);
        Assert.Equal("Bad Gateway text", EsErrors.FromResponse(new EsResponse(502, "Bad Gateway", "text/plain", Encoding.UTF8.GetBytes("Bad Gateway text"), 1)).Message);
        Assert.Equal("Elasticsearch answered 503 x", EsErrors.FromResponse(Res(503, "")).Message);
    }

    private static (int, string) Pair(EngineException ex) => (ex.Status, ex.Code);
}

public sealed class SearchMappingTests
{
    [Fact]
    public void Builds_the_body_with_defaults_overrides_and_cap()
    {
        var (body, capped) = SearchService.BuildBody(new EsSearchRequest { Index = "x", Body = Es.J("""{"query":{"match_all":{}},"size":50000}"""), From = 20 });
        Assert.True(capped);
        Assert.Equal(10_000, body["size"]!.GetValue<int>());
        Assert.Equal(20, body["from"]!.GetValue<int>());
        Assert.True(body["track_total_hits"]!.GetValue<bool>());
        Assert.True(body["seq_no_primary_term"]!.GetValue<bool>());

        var (after, c2) = SearchService.BuildBody(new EsSearchRequest { Index = "x", Size = 25, From = 5, SearchAfter = Es.J("""[123,"id-9"]"""), TrackTotalHits = Es.J("1000") });
        Assert.False(c2);
        Assert.Null(after["from"]);
        Assert.Equal(25, after["size"]!.GetValue<int>());
        Assert.Equal("""[123,"id-9"]""", after["search_after"]!.ToJsonString());
        Assert.Equal(1000, after["track_total_hits"]!.GetValue<int>());
        Assert.Throws<EngineException>(() => SearchService.BuildBody(new EsSearchRequest { Body = Es.J("[1]") }));
    }

    [Fact]
    public void Maps_hits_totals_aggregations_and_extras()
    {
        var res = Es.J("""
        {"took":5,"timed_out":false,"_shards":{"total":2,"successful":2,"skipped":0,"failed":0},
         "hits":{"total":{"value":10000,"relation":"gte"},"max_score":1.5,"hits":[
           {"_index":"shop-orders","_id":"a/b","_score":1.5,"_seq_no":7,"_primary_term":1,"_routing":"r1","_source":{"status":"paid"},
            "highlight":{"status":["<em>paid</em>"]},"sort":[1,"x"],"_explanation":{"value":1.5},"matched_queries":{"q1":1.0}},
           {"_index":"shop-orders","_id":"2","_score":null,"_source":{"status":"shipped"},"matched_queries":["q2"]}]},
         "aggregations":{"by_status":{"buckets":[{"key":"paid","doc_count":3}]}}}
        """);
        var r = SearchService.MapResponse(res, 9, false, Es.J("{}"));
        Assert.Equal(10000, r.Total);
        Assert.Equal("gte", r.TotalRelation);
        Assert.Equal(2, r.Hits.Count);
        var h = r.Hits[0];
        Assert.Equal(("a/b", 7L, 1L, "r1"), (h.Id, h.SeqNo!.Value, h.PrimaryTerm!.Value, h.Routing!));
        Assert.Equal(["<em>paid</em>"], h.Highlight!["status"]);
        Assert.Equal(["q1"], h.MatchedQueries!);
        Assert.Equal(1.5, h.Explanation!.Value.GetProperty("value").GetDouble());
        Assert.Null(r.Hits[1].Score);
        Assert.Equal(["q2"], r.Hits[1].MatchedQueries!);
        Assert.Equal(3, r.Aggregations!.Value.GetProperty("by_status").GetProperty("buckets")[0].GetProperty("doc_count").GetInt32());
        Assert.Equal(new EsShardsInfo(2, 2, 0, 0), r.Shards);
        // ES 6 numeric totals; track_total_hits=false → no total
        Assert.Equal(42, SearchService.MapResponse(Es.J("""{"hits":{"total":42,"hits":[]}}"""), 1, false, Es.J("{}")).Total);
        Assert.Null(SearchService.MapResponse(Es.J("""{"hits":{"hits":[]}}"""), 1, false, Es.J("{}")).Total);
    }
}

public sealed class ConsoleTests
{
    [Theory]
    [InlineData("_cat/indices?v", "/_cat/indices?v")]
    [InlineData("  /shop-orders/_search  ", "/shop-orders/_search")]
    [InlineData("", "/")]
    [InlineData("/_search?q=a b", "/_search?q=a b")]
    public void Sanitizes_paths(string raw, string expected) => Assert.Equal(expected, ConsoleService.SanitizePath(raw));

    [Theory]
    [InlineData("http://evil:9200/_cat")]
    [InlineData("//evil/_cat")]
    [InlineData("/../etc")]
    [InlineData("/a/%2e%2e/b")]
    [InlineData("/a/./b")]
    [InlineData("/_cat\r\nHost: x")]
    [InlineData("/a\\b")]
    [InlineData("/_search#frag")]
    public void Rejects_unsafe_paths(string raw) =>
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => ConsoleService.SanitizePath(raw)).Code);

    [Theory]
    [InlineData("GET", "/_cat/indices", true)]
    [InlineData("HEAD", "/shop", true)]
    [InlineData("POST", "/shop/_search", true)]
    [InlineData("POST", "/shop/_search/template", true)]
    [InlineData("POST", "/_msearch", true)]
    [InlineData("POST", "/shop/_count", true)]
    [InlineData("POST", "/_sql?format=txt", true)]
    [InlineData("POST", "/_plugins/_sql", true)]
    [InlineData("POST", "/shop/_explain/1", true)]
    [InlineData("POST", "/_analyze", true)]
    [InlineData("POST", "/shop/_validate/query", true)]
    [InlineData("POST", "/_search/scroll", true)]
    [InlineData("POST", "/shop/_doc", false)]
    [InlineData("POST", "/shop/_update/1", false)]
    [InlineData("POST", "/shop/_delete_by_query", false)]
    [InlineData("POST", "/_bulk", false)]
    [InlineData("POST", "/_reindex", false)]
    [InlineData("POST", "/shop/_close", false)]
    [InlineData("PUT", "/shop", false)]
    [InlineData("DELETE", "/shop", false)]
    [InlineData("POST", "/_plugins/_security/api/x", false)]
    public void Read_only_matrix(string method, string path, bool allowed) => Assert.Equal(allowed, ConsoleService.IsReadOnlyRequest(method, path));

    [Fact]
    public void Ndjson_bodies_are_compacted_one_value_per_line()
    {
        Assert.True(ConsoleService.IsNdjson("/_bulk"));
        Assert.True(ConsoleService.IsNdjson("/shop/_bulk?refresh=true"));
        Assert.True(ConsoleService.IsNdjson("/shop/_msearch/template"));
        Assert.False(ConsoleService.IsNdjson("/shop/_search"));
        var text = "{ \"index\": { \"_id\": \"1\" } }\n{\n  \"name\": \"علی\"\n}\n";
        Assert.Equal("{\"index\":{\"_id\":\"1\"}}\n{\"name\":\"علی\"}\n", ConsoleService.NormalizeNdjson(text));
    }

    [Fact]
    public async Task Runs_requests_and_returns_es_errors_in_the_body()
    {
        var fake = new FakeEs();
        fake.Add("shop", ("1", new { name = "a" }));
        await using var c = await Es.ClientAsync(fake);
        var svc = new ConsoleService();
        var ok = await svc.RunAsync(c, new EsConsoleRequest { Method = "get", Path = "_cat/indices" }, default);
        Assert.Equal(200, ok.Status);
        Assert.Contains("\n  ", ok.Body); // pretty printed
        Assert.Contains("\"index\": \"shop\"", ok.Body);
        var missing = await svc.RunAsync(c, new EsConsoleRequest { Method = "GET", Path = "/nope" }, default);
        Assert.Equal(404, missing.Status);
        Assert.Contains("index_not_found_exception", missing.Body);
        await svc.RunAsync(c, new EsConsoleRequest { Method = "POST", Path = "/shop/_bulk", Body = "{\"index\":{\"_id\":\"2\"}}\n{\"name\":\"b\"}" }, default);
        Assert.Equal("application/x-ndjson", fake.Requests.Last().ContentType);
        Assert.Equal(2, fake.Indices["shop"].Docs.Count);
        Assert.Equal(ErrorCodes.Validation, (await Assert.ThrowsAsync<EngineException>(() => svc.RunAsync(c, new EsConsoleRequest { Method = "PATCH", Path = "/" }, default))).Code);
    }

    [Fact]
    public async Task Read_only_connections_refuse_writes()
    {
        var fake = new FakeEs();
        fake.Add("shop");
        var p = Es.Profile(readOnly: true);
        await using var c = await Es.ClientAsync(fake, p);
        var svc = new ConsoleService();
        Assert.Equal(200, (await svc.RunAsync(c, new EsConsoleRequest { Method = "POST", Path = "/shop/_search", Body = "{}" }, default)).Status);
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.RunAsync(c, new EsConsoleRequest { Method = "DELETE", Path = "/shop" }, default));
        Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
        Assert.Contains("DELETE /shop", ex.Message);
        Assert.True(fake.Indices.ContainsKey("shop"));
    }

    [Fact]
    public async Task Truncates_large_answers()
    {
        var fake = new FakeEs();
        fake.On("GET", "/big", _ => (200, new string('x', EsTransport.MaxConsoleBytes + 100)));
        await using var c = await Es.ClientAsync(fake);
        var r = await new ConsoleService().RunAsync(c, new EsConsoleRequest { Method = "GET", Path = "/big" }, default);
        Assert.True(r.Truncated);
        Assert.Equal(EsTransport.MaxConsoleBytes, r.Body.Length);
    }
}

public sealed class FieldsAndSqlTests
{
    [Fact]
    public void Flattens_mappings_with_multi_fields_objects_nested_and_runtime()
    {
        var body = Es.J("""
        {"shop-a":{"mappings":{"properties":{
            "name":{"type":"text","fields":{"keyword":{"type":"keyword","ignore_above":256}}},
            "address":{"properties":{"city":{"type":"keyword"},"geo":{"type":"geo_point"}}},
            "items":{"type":"nested","properties":{"qty":{"type":"integer"}}},
            "blob":{"type":"binary"},
            "secret":{"type":"keyword","index":false,"doc_values":false}},
          "runtime":{"day":{"type":"keyword"}}}},
         "shop-b":{"mappings":{"properties":{"name":{"type":"keyword"},"extra":{"type":"date"}}}}}
        """);
        var f = IndexService.FlattenMappings(body).ToDictionary(x => x.Path);
        Assert.Equal(["address", "address.city", "address.geo", "blob", "day", "extra", "items", "items.qty", "name", "name.keyword", "secret"], f.Keys.ToArray());
        Assert.Equal(("text", true, false), (f["name"].Type, f["name"].Searchable, f["name"].Aggregatable));
        Assert.Equal(("keyword", "name", true), (f["name.keyword"].Type, f["name.keyword"].Parent, f["name.keyword"].Aggregatable));
        Assert.Equal("object", f["address"].Type);
        Assert.False(f["address"].Searchable);
        Assert.Equal("nested", f["items"].Type);
        Assert.True(f["items.qty"].Aggregatable);
        Assert.False(f["blob"].Searchable);
        Assert.False(f["secret"].Searchable);
        Assert.False(f["secret"].Aggregatable);
        Assert.True(f["day"].Aggregatable);
    }

    [Fact]
    public void Normalizes_sql_answers_of_both_flavors()
    {
        var es = SqlService.Normalize(Es.J("""{"columns":[{"name":"status","type":"keyword"},{"name":"n","type":"long"}],"rows":[["paid",2],["shipped",1]],"cursor":"abc"}"""), 4);
        Assert.Equal(["status", "n"], es.Columns.Select(c => c.Name));
        Assert.Equal(2, es.Rows.Count);
        Assert.Equal("abc", es.Cursor);
        var os = SqlService.Normalize(Es.J("""{"schema":[{"name":"status","type":"keyword"},{"name":"COUNT(*)","alias":"n","type":"long"}],"datarows":[["paid",2]],"total":1,"size":1,"status":200}"""), 4);
        Assert.Equal(["status", "n"], os.Columns.Select(c => c.Name));
        Assert.Equal(2, os.Rows[0][1].GetInt32());
        Assert.Null(os.Cursor);
        // A cursor page of Elasticsearch has no columns.
        Assert.Empty(SqlService.Normalize(Es.J("""{"rows":[["x",1]]}"""), 1).Columns);
    }

    [Fact]
    public async Task Sql_goes_to_the_flavor_endpoint()
    {
        var es = new FakeEs();
        await using (var c = await Es.ClientAsync(es))
        {
            var r = await new SqlService().QueryAsync(c, new EsSqlRequest { Query = "SELECT status, COUNT(*) n FROM \"shop-orders\" GROUP BY status;" }, default);
            Assert.Equal("c1", r.Cursor);
            Assert.StartsWith("/_sql?format=json", es.Requests.Last().PathAndQuery);
            Assert.DoesNotContain(";", es.Requests.Last().Body);
        }
        var os = new FakeEs { Flavor = "opensearch", Version = "2.17.1" };
        await using (var c = await Es.ClientAsync(os))
        {
            var r = await new SqlService().QueryAsync(c, new EsSqlRequest { Query = "SELECT 1" }, default);
            Assert.Equal("n", r.Columns[1].Name);
            Assert.StartsWith("/_plugins/_sql?format=jdbc", os.Requests.Last().PathAndQuery);
        }
    }

    [Fact]
    public void Maps_nodes_and_tasks()
    {
        var n = ClusterService.MapNode(Es.J("""{"id":"abc","name":"n1","node.role":"dim","master":"*","heap.percent":"40","disk.used":"100","load_1m":"-"}"""));
        Assert.Equal(["data", "ingest", "master"], n.Roles);
        Assert.True(n.Master);
        Assert.Equal(40, n.HeapPercent);
        Assert.Equal(100, n.DiskUsedBytes);
        Assert.Null(n.Load1m);
        var tasks = TaskService.Map(Es.J("""{"nodes":{"n1":{"tasks":{"n1:5":{"node":"n1","id":5,"type":"transport","action":"indices:data/write/reindex","start_time_in_millis":1735689600000,"running_time_in_nanos":2500000000,"cancellable":true,"status":{"total":10}}}}}}"""));
        var t = Assert.Single(tasks);
        Assert.Equal(("n1:5", 2500L, true, "2025-01-01T00:00:00.000Z"), (t.Id, t.RunningTimeMs, t.Cancellable, t.StartTime));
        Assert.Equal("n1:7", TaskService.Map(Es.J("""{"tasks":[{"node":"n1","id":7,"action":"a","type":"t"}]}"""))[0].Id);
    }

    [Theory]
    [InlineData("shop-orders", true)]
    [InlineData("Shop", false)]
    [InlineData("_shop", false)]
    [InlineData("a*", false)]
    [InlineData("a,b", false)]
    [InlineData("_all", false)]
    [InlineData("..", false)]
    [InlineData("has space", false)]
    public void Validates_index_names(string name, bool ok)
    {
        if (ok) Assert.Equal(name, EsNames.Index(name));
        else Assert.Throws<EngineException>(() => EsNames.Index(name));
    }

    [Fact]
    public void Validates_task_ids()
    {
        Assert.Equal("oTUltX4IQMOUUVeiohTt8A:12345", EsNames.TaskId("oTUltX4IQMOUUVeiohTt8A:12345"));
        Assert.Throws<EngineException>(() => EsNames.TaskId("x"));
        Assert.Throws<EngineException>(() => EsNames.TaskId("a/b:1"));
        Assert.Throws<EngineException>(() => EsNames.TaskId("n:1a"));
    }
}

public sealed class ImportExportUnitTests
{
    private static JobsService.ImportPlan Plan(string format, string upload, int batch = 1000, string? idField = null, char delimiter = ',') =>
        new("shop", format, null, upload, idField, batch, null, delimiter, true);

    private static async Task<List<JobsService.ImportDoc>> Read(JobsService.ImportPlan plan)
    {
        var list = new List<JobsService.ImportDoc>();
        await foreach (var d in JobsService.ReadDocsAsync(new MemoryStream(Encoding.UTF8.GetBytes(plan.Upload!)), plan, default)) list.Add(d);
        return list;
    }

    [Fact]
    public async Task Reads_ndjson_with_bulk_action_lines_and_meta()
    {
        var docs = await Read(Plan("ndjson", "{\"a\":1}\n\n{\"index\":{\"_id\":\"x9\"}}\n{\"a\":2}\n{\"_index\":\"o\",\"_id\":\"m1\",\"_source\":{\"a\":3}}\n"));
        Assert.Equal(3, docs.Count);
        Assert.Null(docs[0].Id);
        Assert.Equal("x9", docs[1].Id);
        Assert.Equal(("m1", 3), (docs[2].Id!, docs[2].Source["a"]!.GetValue<int>()));
        await Assert.ThrowsAsync<EngineException>(() => Read(Plan("ndjson", "{\"a\":1}\nnot json\n")));
    }

    [Fact]
    public async Task Reads_json_arrays_single_objects_and_csv()
    {
        Assert.Equal(3, (await Read(Plan("json", "\uFEFF  [ {\"a\":1}, {\"a\":2}, {\"a\":\"علی\"} ]"))).Count);
        Assert.Single(await Read(Plan("json", "{\"a\":1}")));
        Assert.Empty(await Read(Plan("json", "   ")));
        var csv = await Read(Plan("csv", "name,qty,price,active,zip,address.city\n\"Smith, J\",3,4.50,true,01234,Berlin\r\n\"say \"\"hi\"\"\",,1e3,false,9,\"multi\nline\"\n"));
        Assert.Equal(2, csv.Count);
        var a = csv[0].Source;
        Assert.Equal("Smith, J", a["name"]!.GetValue<string>());
        Assert.Equal(3, a["qty"]!.GetValue<long>());
        Assert.Equal(4.5, a["price"]!.GetValue<double>());
        Assert.True(a["active"]!.GetValue<bool>());
        Assert.Equal("01234", a["zip"]!.GetValue<string>());
        Assert.Equal("Berlin", a["address.city"]!.GetValue<string>());
        var b = csv[1].Source;
        Assert.Equal("say \"hi\"", b["name"]!.GetValue<string>());
        Assert.False(b.ContainsKey("qty"));
        Assert.Equal("multi\nline", b["address.city"]!.GetValue<string>());
        var tsv = await Read(Plan("csv", "a\tb\n1\tx\n", delimiter: '\t'));
        Assert.Equal("x", tsv[0].Source["b"]!.GetValue<string>());
    }

    [Fact]
    public async Task Imports_in_bulk_chunks_with_id_field_and_errors()
    {
        var fake = new FakeEs();
        await using var c = await Es.ClientAsync(fake);
        var lines = string.Join('\n', Enumerable.Range(1, 25).Select(i => i == 7 ? "{\"sku\":\"S7\",\"bad\":true}" : $"{{\"sku\":\"S{i}\",\"n\":{i}}}"));
        var r = await new JobsService().ImportAsync(c, Plan("ndjson", lines, batch: 10, idField: "sku"), null, default);
        Assert.Equal(24, r.Indexed);
        Assert.Equal(1, r.Failed);
        Assert.Contains("S7: document_parsing_exception", Assert.Single(r.Errors));
        Assert.Equal(3, fake.Requests.Count(q => q.PathAndQuery.StartsWith("/shop/_bulk", StringComparison.Ordinal)));
        Assert.True(fake.Indices["shop"].Docs.ContainsKey("S25"));
        Assert.All(fake.Requests.Where(q => q.PathAndQuery.Contains("_bulk")), q => Assert.Equal("application/x-ndjson", q.ContentType));
    }

    [Fact]
    public async Task Import_cuts_bulk_requests_by_size()
    {
        var fake = new FakeEs();
        await using var c = await Es.ClientAsync(fake);
        var big = new string('x', 1024 * 1024);
        var lines = string.Join('\n', Enumerable.Range(1, 12).Select(i => $"{{\"i\":{i},\"t\":\"{big}\"}}"));
        var r = await new JobsService().ImportAsync(c, Plan("ndjson", lines, batch: 1000), null, default);
        Assert.Equal(12, r.Indexed);
        var bulks = fake.Requests.Where(q => q.PathAndQuery.Contains("_bulk")).ToList();
        Assert.True(bulks.Count >= 3);
        Assert.All(bulks, b => Assert.True(Encoding.UTF8.GetByteCount(b.Body!) <= JobsService.MaxBulkBytes));
    }

    [Fact]
    public async Task Exports_by_scroll_in_three_formats()
    {
        var fake = new FakeEs();
        fake.Add("shop", Enumerable.Range(1, 2500).Select(i => ($"d{i:0000}", (object)new { n = i, name = i == 1 ? "علی, \"q\"" : $"n{i}", address = new { city = "Berlin" }, tags = new[] { "a", "b" } })).ToArray());
        await using var c = await Es.ClientAsync(fake);
        var svc = new JobsService();

        var nd = new MemoryStream();
        Assert.Equal(2500, await svc.ExportAsync(c, JobsService.ParseExport(new EsExportRequest { Index = "shop", Format = "ndjson" }), nd, null, default));
        var ndLines = Encoding.UTF8.GetString(nd.ToArray()).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2500, ndLines.Length);
        Assert.Contains("علی", ndLines[0]);
        Assert.Contains(fake.Requests, r => r.Method == "DELETE" && r.PathAndQuery == "/_search/scroll");

        var js = new MemoryStream();
        await svc.ExportAsync(c, JobsService.ParseExport(new EsExportRequest { Index = "shop", Format = "json", Max = 3, IncludeMeta = true }), js, null, default);
        var arr = JsonDocument.Parse(js.ToArray()).RootElement;
        Assert.Equal(3, arr.GetArrayLength());
        Assert.Equal("d0001", arr[0].GetProperty("_id").GetString());

        var csv = new MemoryStream();
        await svc.ExportAsync(c, JobsService.ParseExport(new EsExportRequest { Index = "shop", Format = "csv", Max = 2 }), csv, null, default);
        var csvText = Encoding.UTF8.GetString(csv.ToArray()).TrimStart('\uFEFF');
        var rows = csvText.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("_id,n,name,address.city,tags", rows[0].TrimEnd('\r'));
        Assert.Equal("d0001,1,\"علی, \"\"q\"\"\",Berlin,\"[\"\"a\"\",\"\"b\"\"]\"", rows[1].TrimEnd('\r'));
        Assert.Equal(3, rows.Length);
    }

    [Fact]
    public void Validates_plans()
    {
        Assert.Throws<EngineException>(() => JobsService.ParseImport(new EsImportRequest { Index = "shop", Format = "xml", Upload = "" }));
        Assert.Throws<EngineException>(() => JobsService.ParseImport(new EsImportRequest { Index = "shop" }));
        Assert.Throws<EngineException>(() => JobsService.ParseImport(new EsImportRequest { Index = "shop", Path = "Z:/does/not/exist.ndjson" }));
        Assert.Throws<EngineException>(() => JobsService.ReindexBody(new EsReindexRequest { Source = "a", Dest = "a" }));
        Assert.Throws<EngineException>(() => JobsService.ReindexBody(new EsReindexRequest { Source = "a", Dest = "B" }));
        var (body, q) = JobsService.ReindexBody(new EsReindexRequest { Source = "a,b", Dest = "c", Conflicts = "proceed", MaxDocs = 5, Slices = 2, Script = "ctx._source.x = 1", Query = Es.J("""{"term":{"s":"x"}}""") });
        Assert.Equal("""{"source":{"index":["a","b"],"query":{"term":{"s":"x"}}},"dest":{"index":"c"},"conflicts":"proceed","max_docs":5,"script":{"source":"ctx._source.x = 1","lang":"painless"}}""", body.ToJsonString());
        Assert.Contains("slices=2", q);
        Assert.Contains("wait_for_completion=false", q);
    }
}

public sealed class ModuleTests
{
    [Fact]
    public void Module_registers_provider_services_and_stream()
    {
        var modules = EngineModules.Discover(typeof(ElasticsearchModule).Assembly);
        var module = Assert.Single(modules, m => m is ElasticsearchModule);
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        module.ConfigureServices(services);
        Assert.Contains(services, d => d.ServiceType == typeof(Core.Providers.IDataSourceProvider));
        Assert.Contains(services, d => d.ServiceType == typeof(IStreamFactory) && Equals(d.ServiceKey, "es.tasks"));
        var p = new EsProvider();
        Assert.Equal(("elasticsearch", SourceKind.Search), (p.Id, p.Kind));
        Assert.Equal(["url", "auth", "user", "password", "apiKey", "token", "tlsSkipVerify", "caFile", "connectTimeout", "flavor"], p.FormSpec.Fields.Select(f => f.Key));
        Assert.Equal(["password", "password", "password"], p.FormSpec.Fields.Where(f => f.Key is "password" or "apiKey" or "token").Select(f => f.Type));
    }
}
