using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class EndpointTests
{
    private static async Task<(RedisHarness H, RedisApi Api)> StartAsync(bool readOnly = false)
    {
        var h = await RedisHarness.StartAsync(readOnly: readOnly);
        await Seed.BasicAsync(await h.ClientAsync());
        return (h, await RedisApi.StartAsync(h));
    }

    private static string K(string key) => Uri.EscapeDataString(key);

    [Fact]
    public async Task Server_scan_and_get_round_trip_over_http()
    {
        var (h, api) = await StartAsync();
        await using var _ = h;
        await using var __ = api;
        var server = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/server"));
        Assert.Equal("standalone", server.GetProperty("mode").GetString());
        Assert.Equal(16, server.GetProperty("databases").GetInt32());
        var scan = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/scan", new { db = 0, pattern = "*", cursor = "0", count = 100 });
        var sj = await RedisApi.JsonOf(scan);
        Assert.Equal("0", sj.GetProperty("cursor").GetString());
        Assert.Equal(8, sj.GetProperty("keys").GetArrayLength());
        var hash = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/keys/{K("user:1001:profile")}?db=0"));
        Assert.Equal("hash", hash.GetProperty("type").GetString());
        Assert.Equal(3, hash.GetProperty("fields").GetArrayLength());
        Assert.True(hash.TryGetProperty("objectEncoding", out var enc1));
    }

    [Fact]
    public async Task Keys_with_slashes_and_percent_signs_are_decoded_exactly_once()
    {
        var (h, api) = await StartAsync();
        await using var _ = h;
        await using var __ = api;
        foreach (var key in new[] { "path/to/key", "100%", "a%2Fb", "sp ace?&#" })
        {
            var create = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys", new { key, db = 0, type = "string", value = key });
            Assert.Equal(HttpStatusCode.NoContent, create.StatusCode);
            var got = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/keys/{K(key)}?db=0"));
            Assert.Equal(key, got.GetProperty("key").GetString());
            Assert.Equal(key, got.GetProperty("value").GetString());
            var put = await api.Http.PutAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/{K(key)}/ttl?db=0", new { seconds = 50 });
            Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
            var del = await api.Http.DeleteAsync($"/api/v1/redis/{h.Cid}/keys/{K(key)}?db=0");
            Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);
        }
    }

    [Fact]
    public async Task Edits_over_http_and_stream_add_returns_the_id()
    {
        var (h, api) = await StartAsync();
        await using var _ = h;
        await using var __ = api;
        var hset = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/{K("user:1001:profile")}/hash?db=0", new { set = new Dictionary<string, string> { ["x"] = "y" } });
        Assert.Equal(HttpStatusCode.NoContent, hset.StatusCode);
        var xadd = await RedisApi.JsonOf(await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/events/stream?db=0", new { add = new Dictionary<string, string> { ["a"] = "b" } }));
        Assert.Contains("-", xadd.GetProperty("id").GetString());
        var json = await api.Http.PutAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/{K("doc:1")}/json?db=0", new { path = "$.name", value = "Gadget" });
        Assert.Equal(HttpStatusCode.NoContent, json.StatusCode);
        var doc = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/keys/{K("doc:1")}?db=0"));
        Assert.Equal("Gadget", doc.GetProperty("json").GetProperty("name").GetString());
        var zset = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/leaderboard/zset?db=0", new { add = new[] { new { member = "zed", score = 1.5 } } });
        Assert.Equal(HttpStatusCode.NoContent, zset.StatusCode);
        var rename = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/greeting/rename?db=0", new { newKey = "hi", overwrite = false });
        Assert.Equal(HttpStatusCode.NoContent, rename.StatusCode);
    }

    [Fact]
    public async Task Errors_use_the_envelope_with_status_codes()
    {
        var (h, api) = await StartAsync(readOnly: true);
        await using var _ = h;
        await using var __ = api;
        var missing = await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/keys/nope?db=0");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        var ro = await api.Http.DeleteAsync($"/api/v1/redis/{h.Cid}/keys/greeting?db=0");
        Assert.Equal(HttpStatusCode.Forbidden, ro.StatusCode);
        Assert.Equal("READ_ONLY", (await RedisApi.JsonOf(ro)).GetProperty("error").GetProperty("code").GetString());
        var blocked = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/commands", new { db = 0, raw = new[] { "MONITOR" } });
        Assert.Equal(HttpStatusCode.BadRequest, blocked.StatusCode);
        var badDb = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/scan", new { db = 77 });
        Assert.Equal("VALIDATION", (await RedisApi.JsonOf(badDb)).GetProperty("error").GetProperty("code").GetString());
        var unknown = await api.Http.GetAsync("/api/v1/redis/c_nope/server");
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        var dp = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/delete-pattern", new { db = 0, pattern = "*" });
        Assert.Equal(HttpStatusCode.Forbidden, dp.StatusCode);
    }

    [Fact]
    public async Task Jobs_start_with_202_and_finish_with_job_done()
    {
        var (h, api) = await StartAsync();
        await using var _ = h;
        await using var __ = api;
        var res = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/analysis", new { db = 0, sampleLimit = 1000, delimiter = ":" });
        Assert.Equal(HttpStatusCode.Accepted, res.StatusCode);
        var jobId = (await RedisApi.JsonOf(res)).GetProperty("jobId").GetString();
        var done = await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == jobId);
        Assert.Equal(8, done.Result!.Value.GetProperty("scanned").GetInt64());
        var del = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/delete-pattern", new { db = 0, pattern = "user:*" });
        Assert.Equal(HttpStatusCode.Accepted, del.StatusCode);
        var delId = (await RedisApi.JsonOf(del)).GetProperty("jobId").GetString();
        var deleted = await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == delId);
        Assert.Equal(1, deleted.Result!.Value.GetProperty("deleted").GetInt64());
        var missingPattern = await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/delete-pattern", new { db = 0 });
        Assert.Equal(HttpStatusCode.BadRequest, missingPattern.StatusCode);
    }

    [Fact]
    public async Task Commands_info_slowlog_clients_and_config_over_http()
    {
        var (h, api) = await StartAsync();
        await using var _ = h;
        await using var __ = api;
        var cmd = await RedisApi.JsonOf(await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/commands", new { db = 0, raw = new[] { "GET greeting", "SELECT 1" } }));
        Assert.Equal("hello", cmd.GetProperty("results")[0].GetProperty("value").GetString());
        Assert.Equal(1, cmd.GetProperty("db").GetInt32());
        var info = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/info"));
        Assert.True(info.GetProperty("sections").TryGetProperty("server", out var srv1));
        Assert.Equal(JsonValueKind.Array, (await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/slowlog?count=10"))).ValueKind);
        Assert.True((await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/clients"))).GetArrayLength() >= 1);
        var cfg = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/config?pattern=maxmemory"));
        Assert.Equal("0", cfg.GetProperty("values").GetProperty("maxmemory").GetString());
        var pub = await RedisApi.JsonOf(await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/publish", new { channel = "c", message = "m" }));
        Assert.Equal(0, pub.GetProperty("receivers").GetInt64());
        var channels = await RedisApi.JsonOf(await api.Http.GetAsync($"/api/v1/redis/{h.Cid}/pubsub/channels"));
        Assert.Equal(JsonValueKind.Array, channels.GetProperty("channels").ValueKind);
        var memory = await RedisApi.JsonOf(await api.Http.PostAsJsonAsync($"/api/v1/redis/{h.Cid}/keys/memory", new { db = 0, keys = new[] { "greeting" } }));
        Assert.True(memory.GetProperty("sizes").GetProperty("greeting").GetInt64() > 0);
    }
}

public sealed class CatalogTests
{
    [Fact]
    public void Catalog_loads_with_flags_and_key_positions()
    {
        var cat = RedisCommandCatalog.Instance;
        Assert.True(cat.All.Count > 200);
        Assert.True(cat.Get("GET")!.IsReadOnly);
        Assert.False(cat.Get("SET")!.IsReadOnly);
        Assert.Equal(1, cat.Get("GET")!.FirstKeyIndex);
        Assert.Equal(2, cat.Find(["OBJECT", "ENCODING", "k"])!.FirstKeyIndex);
        Assert.Equal("CONFIG GET", cat.Find(["config", "get", "x"])!.Name);
        Assert.True(cat.Get("MONITOR")!.IsRefused);
        Assert.True(cat.Get("BLPOP")!.IsBlocking);
        Assert.True(cat.Get("MULTI")!.IsTransaction);
        Assert.Contains("CONFIG", cat.Containers.ToList());
        Assert.Equal("FOO", cat.DisplayName(["foo"]));
    }

    [Fact]
    public void Every_entry_is_complete_and_unique()
    {
        var cat = RedisCommandCatalog.Instance;
        Assert.Equal(cat.All.Count, cat.All.Select(c => c.Name).Distinct().Count());
        foreach (var c in cat.All)
        {
            Assert.False(string.IsNullOrWhiteSpace(c.Summary), c.Name);
            Assert.StartsWith(c.Name, c.Syntax);
            Assert.NotEmpty(c.Flags);
            Assert.True(c.Flags.Contains("readonly") || c.Flags.Contains("write") || c.Flags.Contains("blocked"), c.Name);
        }
    }

    [Fact]
    public void Ui_copy_of_the_command_table_is_identical()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "ui", "package.json"))) dir = dir.Parent;
        if (dir is null) return; // not running inside the repository
        var engine = Path.Combine(dir.FullName, "engine", "src", "DbStudio.Sources.Redis", "Commands", "redis-commands.json");
        var ui = Path.Combine(dir.FullName, "ui", "src", "redis", "redis-commands.json");
        Assert.True(File.Exists(ui), "ui/src/redis/redis-commands.json is missing");
        Assert.Equal(File.ReadAllText(engine).ReplaceLineEndings(), File.ReadAllText(ui).ReplaceLineEndings());
    }
}
