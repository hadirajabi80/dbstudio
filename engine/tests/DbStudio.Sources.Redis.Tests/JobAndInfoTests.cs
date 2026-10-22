using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class JobAndInfoTests
{
    private readonly InfoService _info = new();

    [Fact]
    public async Task Delete_pattern_job_reports_progress_and_deletes_only_matches()
    {
        await using var h = await RedisHarness.StartAsync(configure: s =>
        {
            for (var i = 0; i < 3000; i++) s.SeedString(0, $"tmp:{i}", "x");
            for (var i = 0; i < 100; i++) s.SeedString(0, $"keep:{i}", "x");
        });
        var c = await h.ClientAsync();
        var values = new ValueService();
        var id = h.Jobs.Start("redis.deletePattern", h.Cid, null, async (job, ct) => await values.DeletePatternAsync(c, 0, "tmp:*", job, ct));
        var done = await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(3000, done.Result!.Value.GetProperty("deleted").GetInt64());
        Assert.Contains(h.Events.All.OfType<JobProgressEvent>(), e => e.JobId == id && e.Done > 0);
        Assert.Equal(100, await KeyBrowser.DbSizeAsync(c, 0));
    }

    [Fact]
    public async Task Delete_pattern_job_is_cancellable()
    {
        await using var h = await RedisHarness.StartAsync(configure: s => { for (var i = 0; i < 20_000; i++) s.SeedString(0, $"tmp:{i}", "x"); });
        var c = await h.ClientAsync();
        var values = new ValueService();
        var gate = new TaskCompletionSource();
        var id = h.Jobs.Start("redis.deletePattern", h.Cid, null, async (job, ct) =>
        {
            await gate.Task;
            return await values.DeletePatternAsync(c, 0, "tmp:*", job, ct);
        });
        Assert.True(h.Jobs.Cancel(id));
        gate.SetResult();
        var done = await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == id);
        Assert.Equal(ExecutionStatus.Cancelled, done.Status);
        Assert.Equal(20_000, await KeyBrowser.DbSizeAsync(c, 0));
    }

    [Fact]
    public async Task Analysis_aggregates_namespaces_top_keys_types_and_ttl()
    {
        await using var h = await RedisHarness.StartAsync(configure: s =>
        {
            for (var i = 0; i < 500; i++) s.SeedString(0, $"user:{i % 10}:{i}", new string('u', 10), i % 2 == 0 ? TimeSpan.FromMinutes(30) : null);
            for (var i = 0; i < 50; i++) s.SeedString(0, $"session:{i}", "s", TimeSpan.FromDays(3));
            s.SeedString(0, "huge", new string('h', 100_000));
            s.SeedString(0, "plain", "p");
        });
        var c = await h.ClientAsync();
        await c.Db(0).ExecuteAsync("HSET", "user:1:profile", "a", "b");
        var analysis = new AnalysisService();
        var id = h.Jobs.Start("redis.analysis", h.Cid, null, async (job, ct) => await analysis.RunAsync(c, 0, 100_000, ":", job, ct));
        var done = await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var r = done.Result!.Value.Deserialize<RedisAnalysisResult>(CoreJson.Options)!;
        Assert.Equal(553, r.Scanned);
        Assert.Equal(553, r.TotalKeys);
        Assert.False(r.Sampled);
        var user = r.Namespaces.Single(n => n.Prefix == "user:");
        Assert.Equal(501, user.Keys);
        Assert.Equal(500, user.Types["string"]);
        Assert.Equal(1, user.Types["hash"]);
        Assert.Contains(r.Namespaces, n => n.Prefix == "user:1:");
        Assert.Equal(2, r.Namespaces.Single(n => n.Prefix == "").Keys);
        Assert.Equal("huge", r.TopKeys[0].Key);
        Assert.True(r.TopKeys.Count <= AnalysisService.TopKeys);
        Assert.Equal(552, r.ByType["string"].Keys);
        Assert.Equal(300, r.Expiring);
        Assert.Equal(250, r.Ttl.Buckets.Single(b => b.Label == "< 1 hour").Keys);
        Assert.Equal(50, r.Ttl.Buckets.Single(b => b.Label == "< 1 week").Keys);
        Assert.Equal(253, r.Ttl.NoTtl);
        Assert.Contains(h.Events.All.OfType<JobProgressEvent>(), e => e.JobId == id);
    }

    [Fact]
    public async Task Analysis_respects_the_sample_limit()
    {
        await using var h = await RedisHarness.StartAsync(configure: s => { for (var i = 0; i < 5000; i++) s.SeedString(0, $"k:{i}", "v"); });
        var c = await h.ClientAsync();
        var analysis = new AnalysisService();
        var id = h.Jobs.Start("redis.analysis", h.Cid, null, async (job, ct) => await analysis.RunAsync(c, 0, 1200, ":", job, ct));
        var r = (await h.Events.WaitAsync<JobDoneEvent>(e => e.JobId == id)).Result!.Value.Deserialize<RedisAnalysisResult>(CoreJson.Options)!;
        Assert.Equal(1200, r.Scanned);
        Assert.True(r.Sampled);
        Assert.Throws<EngineException>(() => AnalysisService.Validate(c, new RedisAnalysisRequest(0, 0, null)));
    }

    [Theory]
    [InlineData("user:1001:profile", new[] { "user:", "user:1001:" })]
    [InlineData("plain", new[] { "" })]
    [InlineData("a:b", new[] { "a:" })]
    public void Namespace_prefixes(string key, string[] expected) =>
        Assert.Equal(expected, AnalysisService.Prefixes(key, ":").Select(p => p.Prefix));

    [Fact]
    public async Task Info_is_parsed_into_sections()
    {
        await using var h = await RedisHarness.StartAsync(configure: s => s.SeedString(0, "a", "1"));
        var c = await h.ClientAsync();
        var info = await _info.InfoAsync(c);
        Assert.Equal("7.2.4", info.Sections["server"]["redis_version"]);
        Assert.Equal("1048576", info.Sections["memory"]["used_memory"]);
        Assert.Equal(1, info.DbSize);
        Assert.True(info.Clients >= 1);
        Assert.Null(info.ClusterNodes);
        var server = await _info.ServerAsync(c);
        Assert.Equal(new RedisKeyspaceDb(0, 1, 0), Assert.Single(server.Keyspace));
    }

    [Fact]
    public void Info_parser_and_cluster_nodes()
    {
        var s = InfoParser.Parse("# Server\r\nredis_version:7.4.1\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=0\r\ndb2:keys=1,expires=0,avg_ttl=0\r\n");
        Assert.Equal("7.4.1", s["server"]["redis_version"]);
        Assert.Equal([(0, 12L, 3L), (2, 1L, 0L)], InfoParser.Keyspace(s["keyspace"]));
        var nodes = InfoService.ParseClusterNodes(
            "07c3 127.0.0.1:30004@31004 slave e7d1 0 1426238317239 4 connected\n" +
            "e7d1 127.0.0.1:30001@31001 myself,master - 0 0 1 connected 0-5460\n");
        Assert.Equal("e7d1", nodes[0].MasterId);
        Assert.Equal(["0-5460"], nodes[1].Slots);
        Assert.Equal(["myself", "master"], nodes[1].Flags);
        Assert.Equal("127.0.0.1:30001", nodes[1].Address);
    }

    [Fact]
    public async Task Clients_list_and_kill()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var clients = await _info.ClientsAsync(c);
        Assert.Contains(clients, x => x.Name == "Rowlit");
        var victim = clients.First(x => x.Name == "Rowlit");
        Assert.True(victim.Fields.ContainsKey("addr"));
        await _info.KillClientAsync(c, new RedisClientKillRequest(victim.Id));
        await Assert.ThrowsAsync<EngineException>(() => _info.KillClientAsync(c, new RedisClientKillRequest("abc")));
        await Assert.ThrowsAsync<EngineException>(() => _info.KillClientAsync(c, new RedisClientKillRequest("99999")));
    }

    [Fact]
    public async Task Slowlog_get_and_reset()
    {
        await using var h = await RedisHarness.StartAsync(configure: s =>
        {
            s.Slowlog.Add([7L, 1_700_000_000L, 15_000L, new object?[] { "KEYS", "*" }, "127.0.0.1:5000", "worker"]);
            s.Slowlog.Add([6L, 1_699_999_000L, 12_000L, new object?[] { "HGETALL", "big" }, "127.0.0.1:5001", ""]);
        });
        var c = await h.ClientAsync();
        var log = await _info.SlowlogAsync(c, 128);
        Assert.Equal(2, log.Count);
        Assert.Equal(7, log[0].Id);
        Assert.Equal(["KEYS", "*"], log[0].Args);
        Assert.Equal(15_000, log[0].DurationUs);
        Assert.Equal("worker", log[0].Name);
        Assert.Null(log[1].Name);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1_700_000_000), log[0].Ts);
        await _info.ResetSlowlogAsync(c);
        Assert.Empty(await _info.SlowlogAsync(c, 10));
        await Assert.ThrowsAsync<EngineException>(() => _info.SlowlogAsync(c, 0));
    }

    [Fact]
    public async Task Config_get_and_set()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        Assert.Equal("10000", (await _info.ConfigAsync(c, "slowlog-log-slower-than")).Values["slowlog-log-slower-than"]);
        await _info.SetConfigAsync(c, new RedisConfigSetRequest("slowlog-log-slower-than", "500"));
        Assert.Equal("500", (await _info.ConfigAsync(c, "slowlog-*")).Values["slowlog-log-slower-than"]);
        await Assert.ThrowsAsync<EngineException>(() => _info.ConfigAsync(c, ""));
    }

    [Fact]
    public async Task Read_only_refuses_admin_writes()
    {
        await using var h = await RedisHarness.StartAsync(readOnly: true);
        var c = await h.ClientAsync();
        foreach (var w in new Func<Task>[]
        {
            () => _info.SetConfigAsync(c, new RedisConfigSetRequest("maxmemory", "1")),
            () => _info.ResetSlowlogAsync(c),
            () => _info.KillClientAsync(c, new RedisClientKillRequest("1")),
            () => _info.PublishAsync(c, new RedisPublishRequest("ch", "m")),
        })
        {
            var ex = await Assert.ThrowsAsync<EngineException>(w);
            Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
        }
        Assert.NotNull(await _info.SlowlogAsync(c, 10));
    }

    [Fact]
    public async Task Pubsub_channels_with_subscriber_counts()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var info = await h.Streams.OpenAsync("redis.subscribe", h.Cid, JsonSerializer.SerializeToElement(new { channels = new[] { "alpha", "beta" }, patterns = new[] { "g*" } }),
            "ui1", CancellationToken.None);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        RedisPubSubChannels ch;
        do
        {
            ch = await _info.ChannelsAsync(c, null);
            if (ch.Channels.Count >= 2 && ch.Patterns >= 1) break; // SUBSCRIBE and PSUBSCRIBE land separately
            await Task.Delay(20);
        } while (DateTime.UtcNow < deadline);
        Assert.Contains(ch.Channels, x => x.Channel == "alpha" && x.Subscribers == 1);
        Assert.Equal(1, ch.Patterns);
        Assert.Equal(["beta"], (await _info.ChannelsAsync(c, "b*")).Channels.Select(x => x.Channel));
        await h.Streams.CloseAsync(info.StreamId);
    }

    [Fact]
    public async Task Publish_requires_channel_and_message()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Assert.ThrowsAsync<EngineException>(() => _info.PublishAsync(c, new RedisPublishRequest("", "m")));
        await Assert.ThrowsAsync<EngineException>(() => _info.PublishAsync(c, new RedisPublishRequest("c", null)));
        Assert.Equal(0, (await _info.PublishAsync(c, new RedisPublishRequest("nobody", "m"))).Receivers);
    }
}
