using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class KeyBrowserTests
{
    private readonly KeyBrowser _browser = new();

    private static void Seed50k(Fake.FakeRedisServer s)
    {
        for (var i = 0; i < 50_000; i++)
            s.SeedString(0, i % 5 == 0 ? $"session:{i}" : $"user:{i / 100}:{i}", "v", i % 7 == 0 ? TimeSpan.FromHours(1) : null);
    }

    [Fact]
    public async Task Scan_pages_through_50k_keys_with_a_pattern_without_duplicates()
    {
        await using var h = await RedisHarness.StartAsync(configure: Seed50k);
        var c = await h.ClientAsync();
        var cursor = "0";
        var seen = new HashSet<string>();
        var pages = 0;
        do
        {
            var r = await _browser.ScanAsync(c, new RedisScanRequest(0, "session:*", null, cursor, 2000), CancellationToken.None);
            foreach (var k in r.Keys) Assert.True(seen.Add(k.Key));
            Assert.All(r.Keys, k => Assert.StartsWith("session:", k.Key));
            Assert.Equal(50_000, r.DbSize);
            cursor = r.Cursor;
            pages++;
        } while (cursor != "0" && pages < 200);
        Assert.Equal(10_000, seen.Count);
        Assert.True(pages > 1);
    }

    [Fact]
    public async Task One_scan_request_stays_within_its_budget()
    {
        await using var h = await RedisHarness.StartAsync(configure: Seed50k);
        var c = await h.ClientAsync();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        // A pattern that matches nothing makes the request iterate until its budget / iteration cap.
        var r = await _browser.ScanAsync(c, new RedisScanRequest(0, "nomatch:*", null, "0", 100), CancellationToken.None);
        Assert.Empty(r.Keys);
        Assert.NotEqual("0", r.Cursor);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"took {sw.Elapsed}");
        Assert.True(r.Scanned > 0);
    }

    [Fact]
    public async Task Scan_reports_type_and_ttl_per_key()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Seed.BasicAsync(c);
        await c.Db(0).ExecuteAsync("EXPIRE", "greeting", 3600);
        var r = await _browser.ScanAsync(c, new RedisScanRequest(0, "*", null, "0", 500), CancellationToken.None);
        var byKey = r.Keys.ToDictionary(k => k.Key);
        Assert.Equal("string", byKey["greeting"].Type);
        Assert.InRange(byKey["greeting"].Ttl, 3590, 3600);
        Assert.Equal(-1, byKey["tags"].Ttl);
        Assert.Equal("hash", byKey["user:1001:profile"].Type);
        Assert.Equal("list", byKey["queue:jobs"].Type);
        Assert.Equal("set", byKey["tags"].Type);
        Assert.Equal("zset", byKey["leaderboard"].Type);
        Assert.Equal("stream", byKey["events"].Type);
        Assert.Equal("rejson", byKey["doc:1"].Type);
        Assert.Equal("0", r.Cursor);
    }

    [Theory]
    [InlineData("hash", "user:1001:profile")]
    [InlineData("zset", "leaderboard")]
    [InlineData("rejson", "doc:1")]
    [InlineData("stream", "events")]
    public async Task Type_filter_uses_scan_type(string type, string expected)
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Seed.BasicAsync(c);
        var r = await _browser.ScanAsync(c, new RedisScanRequest(0, "*", type, "0", 500), CancellationToken.None);
        Assert.Equal(expected, Assert.Single(r.Keys).Key);
        Assert.Contains("SCAN", h.Server.Received);
    }

    [Fact]
    public async Task Type_filter_falls_back_to_type_per_key_on_redis_5()
    {
        await using var h = await RedisHarness.StartAsync(version: "5.0.14");
        var c = await h.ClientAsync();
        await Seed.BasicAsync(c);
        var r = await _browser.ScanAsync(c, new RedisScanRequest(0, "*", "list", "0", 500), CancellationToken.None);
        Assert.Equal("queue:jobs", Assert.Single(r.Keys).Key);
    }

    [Fact]
    public async Task Scan_validates_its_input()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Assert.ThrowsAsync<EngineException>(() => _browser.ScanAsync(c, new RedisScanRequest(0, "*", "bogus", "0", 10), CancellationToken.None));
        await Assert.ThrowsAsync<EngineException>(() => _browser.ScanAsync(c, new RedisScanRequest(0, "*", null, "abc", 10), CancellationToken.None));
        await Assert.ThrowsAsync<EngineException>(() => _browser.ScanAsync(c, new RedisScanRequest(0, "*", null, "0", 0), CancellationToken.None));
        var ex = await Assert.ThrowsAsync<EngineException>(() => _browser.ScanAsync(c, new RedisScanRequest(99, "*", null, "0", 10), CancellationToken.None));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }

    [Fact]
    public async Task Scan_uses_the_requested_database()
    {
        await using var h = await RedisHarness.StartAsync(configure: s => { s.SeedString(3, "only-in-3", "x"); s.SeedString(0, "only-in-0", "y"); });
        var c = await h.ClientAsync();
        var r3 = await _browser.ScanAsync(c, new RedisScanRequest(3, "*", null, "0", 100), CancellationToken.None);
        Assert.Equal("only-in-3", Assert.Single(r3.Keys).Key);
        var r0 = await _browser.ScanAsync(c, new RedisScanRequest(0, "*", null, "0", 100), CancellationToken.None);
        Assert.Equal("only-in-0", Assert.Single(r0.Keys).Key);
    }

    [Fact]
    public async Task Memory_returns_sizes_and_null_for_missing_keys()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Seed.BasicAsync(c);
        var r = await _browser.MemoryAsync(c, new RedisMemoryRequest(0, ["greeting", "user:1001:profile", "missing"]));
        Assert.True(r.Sizes["greeting"] > 0);
        Assert.True(r.Sizes["user:1001:profile"] > r.Sizes["greeting"]);
        Assert.Null(r.Sizes["missing"]);
        await Assert.ThrowsAsync<EngineException>(() => _browser.MemoryAsync(c, new RedisMemoryRequest(0, Enumerable.Range(0, 101).Select(i => $"k{i}").ToList())));
    }

    [Fact]
    public async Task Memory_is_allowed_on_read_only_connections()
    {
        await using var h = await RedisHarness.StartAsync(readOnly: true, configure: s => s.SeedString(0, "a", "1"));
        var c = await h.ClientAsync();
        var r = await _browser.MemoryAsync(c, new RedisMemoryRequest(0, ["a"]));
        Assert.NotNull(r.Sizes["a"]);
    }

    [Fact]
    public async Task Acl_noperm_maps_to_privilege()
    {
        await using var h = await RedisHarness.StartAsync(password: "pw", user: "limited",
            configure: s => s.Users["limited"] = ("pw", ["GET", "MODULE"]));
        var c = await h.ClientAsync();
        var ex = await Assert.ThrowsAsync<EngineException>(() => _browser.ScanAsync(c, new RedisScanRequest(0, "*", null, "0", 10), CancellationToken.None));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
        Assert.Equal(403, ex.Status);
    }
}
