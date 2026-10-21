using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

/// <summary>
/// Against a real server (docs/PLAN-M2.md 5.6): <c>redis/redis-stack:7.4.0-v1</c> from engine/tests/docker/compose.yml
/// (<c>16379:6379</c>). Runs only with <c>DBSTUDIO_IT=1</c>; host/port/password from <c>DBSTUDIO_REDIS_HOST</c>,
/// <c>DBSTUDIO_REDIS_PORT</c> (default localhost:16379), <c>DBSTUDIO_REDIS_PASSWORD</c>.
/// </summary>
public sealed class LiveRedisTests
{
    private static async Task<RedisClient> ConnectAsync()
    {
        Skip.IfNot(Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "1", "DBSTUDIO_IT=1 runs the Docker suites");
        var profile = new ConnectionProfile
        {
            Id = "c_live", Name = "live", ProviderId = "redis",
            Props = new Dictionary<string, JsonNode?>
            {
                ["host"] = Environment.GetEnvironmentVariable("DBSTUDIO_REDIS_HOST") ?? "localhost",
                ["port"] = int.Parse(Environment.GetEnvironmentVariable("DBSTUDIO_REDIS_PORT") ?? "16379"),
                ["db"] = 15,
            },
        };
        return await RedisProvider.ConnectAsync(profile, Environment.GetEnvironmentVariable("DBSTUDIO_REDIS_PASSWORD"), CancellationToken.None);
    }

    [SkippableFact]
    public async Task Every_type_round_trips_on_redis_stack()
    {
        await using var c = await ConnectAsync();
        await c.Db(15).ExecuteAsync("FLUSHDB");
        await Seed.BasicAsync(c, 15);
        var values = new ValueService();
        foreach (var (key, type) in new[] { ("greeting", "string"), ("user:1001:profile", "hash"), ("queue:jobs", "list"), ("tags", "set"), ("leaderboard", "zset"), ("events", "stream"), ("doc:1", "rejson") })
            Assert.Equal(type, (await values.GetAsync(c, 15, key, new RedisKeyQuery())).Type);
        var scan = await new KeyBrowser().ScanAsync(c, new RedisScanRequest(15, "*", "rejson", "0", 100), CancellationToken.None);
        Assert.Equal("doc:1", Assert.Single(scan.Keys).Key);
        await values.SetJsonAsync(c, 15, "doc:1", new RedisJsonSetRequest("$.price", JsonDocument.Parse("1").RootElement));
        Assert.Contains("ReJSON", await c.ModulesAsync(), StringComparer.OrdinalIgnoreCase);
        await c.Db(15).ExecuteAsync("FLUSHDB");
    }
}

