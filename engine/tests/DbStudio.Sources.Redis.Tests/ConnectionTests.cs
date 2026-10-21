using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class ConnectionTests
{
    private static ConnectionProfile Profile(int port, string? user = null, Dictionary<string, JsonNode?>? props = null)
    {
        var p = new ConnectionProfile { Id = "c_t", Name = "t", ProviderId = "redis", Props = new() { ["host"] = "127.0.0.1", ["port"] = port, ["connectTimeout"] = 2 } };
        if (user is not null) p.Props["user"] = user;
        foreach (var (k, v) in props ?? []) p.Props[k] = v;
        return p;
    }

    [Fact]
    public async Task Connects_to_the_fake_and_reads_server_facts()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        Assert.Equal("Redis 7.2.4", c.Server.Version);
        Assert.Equal("7.2.4", c.Server.ProductVersion);
        Assert.Equal("default", c.Server.User);
        Assert.Equal("0", c.Server.Database);
        Assert.Equal(16, c.Databases);
        Assert.False(c.IsCluster);
        Assert.True(await c.PingAsync(CancellationToken.None));
        Assert.True(c.Supports(6));
    }

    [Fact]
    public async Task Test_connection_reports_success_and_elapsed_time()
    {
        await using var server = new Fake.FakeRedisServer();
        var r = await new RedisProvider().TestAsync(Profile(server.Port), null, CancellationToken.None);
        Assert.True(r.Ok, r.Error?.Message);
        Assert.Equal("Redis 7.2.4", r.ServerInfo!.Version);
    }

    [Fact]
    public async Task Test_connection_to_a_closed_port_fails_with_source_unavailable()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        var r = await new RedisProvider().TestAsync(Profile(port), null, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.SourceUnavailable, r.Error!.Code);
        Assert.DoesNotContain("abortConnect", r.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Password_is_sent_with_auth()
    {
        await using var h = await RedisHarness.StartAsync(password: "s3cret");
        var c = await h.ClientAsync();
        Assert.True(await c.PingAsync(CancellationToken.None));
        Assert.Contains("AUTH", h.Server.Received);
    }

    [Fact]
    public async Task Wrong_password_fails_the_test()
    {
        await using var server = new Fake.FakeRedisServer("right");
        var r = await new RedisProvider().TestAsync(Profile(server.Port), "wrong", CancellationToken.None);
        Assert.False(r.Ok);
    }

    [Fact]
    public async Task Acl_user_authenticates_with_user_and_password()
    {
        await using var h = await RedisHarness.StartAsync(password: "pw", user: "app",
            configure: s => s.Users["app"] = ("pw", null));
        var c = await h.ClientAsync();
        Assert.Equal("app", c.Server.User);
        Assert.True(await c.PingAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Database_index_outside_the_server_range_is_rejected()
    {
        await using var server = new Fake.FakeRedisServer();
        var r = await new RedisProvider().TestAsync(Profile(server.Port, props: new() { ["db"] = 20 }), null, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.Validation, r.Error!.Code);
    }

    [Fact]
    public void Settings_parse_standalone_host_port_and_defaults()
    {
        var s = RedisSettings.From(Profile(6390), null);
        Assert.Equal(RedisMode.Standalone, s.Mode);
        Assert.Equal(("127.0.0.1", 6390), s.Endpoints[0]);
        Assert.Equal(":", s.KeyDelimiter);
        Assert.Equal(500, s.ScanCount);
        var hp = RedisSettings.From(new ConnectionProfile { ProviderId = "redis", Props = new() { ["host"] = "cache.local:7000" } }, null);
        Assert.Equal(("cache.local", 7000), hp.Endpoints[0]);
    }

    [Fact]
    public void Settings_parse_cluster_nodes_and_sentinels()
    {
        var cluster = RedisSettings.From(new ConnectionProfile
        {
            ProviderId = "redis", Props = new() { ["mode"] = "cluster", ["nodes"] = new JsonArray("a:7000", "b:7001,c") },
        }, null);
        Assert.Equal(RedisMode.Cluster, cluster.Mode);
        Assert.Equal([("a", 7000), ("b", 7001), ("c", 6379)], cluster.Endpoints);
        Assert.Equal(0, cluster.Database);
        var sentinel = RedisSettings.From(new ConnectionProfile
        {
            ProviderId = "redis", Props = new() { ["mode"] = "sentinel", ["sentinels"] = "s1,s2:26380", ["serviceName"] = "" },
        }, "pw");
        Assert.Equal(RedisMode.Sentinel, sentinel.Mode);
        Assert.Equal("mymaster", sentinel.ServiceName);
        Assert.Equal([("s1", 26379), ("s2", 26380)], sentinel.Endpoints);
        var o = sentinel.BuildConfiguration();
        Assert.Equal("mymaster", o.ServiceName);
        Assert.Equal("pw", o.Password);
    }

    [Fact]
    public void Settings_validation_names_the_field()
    {
        var ex = Assert.Throws<EngineException>(() => RedisSettings.From(new ConnectionProfile { ProviderId = "redis", Props = new() { ["mode"] = "cluster" } }, null));
        Assert.Contains("nodes", ex.Detail!.ToString());
        Assert.Throws<EngineException>(() => RedisSettings.From(new ConnectionProfile { ProviderId = "redis", Props = new() { ["host"] = "" } }, null));
        Assert.Throws<EngineException>(() => RedisSettings.From(new ConnectionProfile { ProviderId = "redis", Props = new() { ["mode"] = "bogus", ["host"] = "x" } }, null));
    }

    [Fact]
    public void Tls_options_set_ssl_and_skip_verify()
    {
        var s = RedisSettings.From(Profile(6380, props: new() { ["tls"] = true, ["tlsSkipVerify"] = true, ["user"] = "u" }), "p");
        var o = s.BuildConfiguration();
        Assert.True(o.Ssl);
        Assert.Equal("127.0.0.1", o.SslHost);
        Assert.Equal("u", o.User);
        Assert.Equal("DbStudio", o.ClientName);
        Assert.True(o.AllowAdmin);
    }

    [Fact]
    public async Task Client_manager_opens_the_redis_client_once_and_publishes_source_client()
    {
        await using var h = await RedisHarness.StartAsync();
        var a = await h.ClientAsync();
        var b = await h.ClientAsync();
        Assert.Same(a, b);
        await h.Events.WaitAsync<SourceClientChangedEvent>(e => e.State == "open");
    }

    [Fact]
    public async Task Modules_are_detected_with_module_list()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var info = await new InfoService().ServerAsync(c);
        Assert.Contains("ReJSON", info.Modules);
        Assert.True(await c.HasJsonModuleAsync());
        Assert.Equal("standalone", info.Mode);
    }
}
