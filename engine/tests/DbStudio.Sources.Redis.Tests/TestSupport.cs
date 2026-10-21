using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Tests.Fake;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DbStudio.Sources.Redis.Tests;

/// <summary>Records engine events and lets tests await one that matches.</summary>
internal sealed class RecordingPublisher : IEventPublisher
{
    private readonly ConcurrentQueue<EngineEvent> _events = new();

    /// <summary>Reset to hold back stream.data events (simulates a slow WebSocket consumer).</summary>
    public ManualResetEventSlim DataGate { get; } = new(true);

    public IReadOnlyList<EngineEvent> All => _events.ToList();

    public void Publish(EngineEvent ev)
    {
        if (ev is StreamDataEvent) DataGate.Wait(TimeSpan.FromSeconds(20));
        JsonSerializer.SerializeToUtf8Bytes(ev, ev.GetType(), CoreJson.Options);
        _events.Enqueue(ev);
    }

    public async Task<T> WaitAsync<T>(Func<T, bool>? predicate = null, int timeoutMs = 10_000) where T : EngineEvent
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            var hit = _events.OfType<T>().FirstOrDefault(e => predicate?.Invoke(e) ?? true);
            if (hit is not null) return hit;
            await Task.Delay(10);
        }
        throw new TimeoutException($"No {typeof(T).Name} event within {timeoutMs} ms.");
    }
}

/// <summary>A fake server plus the real engine services around one Redis connection profile.</summary>
internal sealed class RedisHarness : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-redis-tests", Guid.NewGuid().ToString("N"));

    private RedisHarness(FakeRedisServer server) => Server = server;

    public FakeRedisServer Server { get; }
    public RecordingPublisher Events { get; } = new();
    public SourceRegistry Registry { get; private set; } = null!;
    public ConnectionStore Store { get; private set; } = null!;
    public SourceClientManager Clients { get; private set; } = null!;
    public StreamManager Streams { get; private set; } = null!;
    public JobManager Jobs { get; private set; } = null!;
    public ConnectionProfile Profile { get; private set; } = null!;
    public string Cid => Profile.Id;

    public static async Task<RedisHarness> StartAsync(bool readOnly = false, string? password = null, string? user = null,
        Action<FakeRedisServer>? configure = null, StreamManagerOptions? streamOptions = null, Dictionary<string, JsonNode?>? extraProps = null,
        string version = "7.2.4", bool jsonModule = true)
    {
        var server = new FakeRedisServer(password, version, jsonModule);
        configure?.Invoke(server);
        var h = new RedisHarness(server);
        Directory.CreateDirectory(h._dir);
        h.Registry = new SourceRegistry(new ProviderRegistry([]), [new RedisProvider()]);
        h.Store = new ConnectionStore(new AppPaths(h._dir), new InMemorySecretStore(), h.Registry);
        var props = new Dictionary<string, JsonNode?>
        {
            ["mode"] = "standalone", ["host"] = server.Host, ["port"] = server.Port, ["db"] = 0, ["keyDelimiter"] = ":", ["connectTimeout"] = 5,
        };
        if (user is not null) props["user"] = user;
        foreach (var (k, v) in extraProps ?? []) props[k] = v;
        h.Profile = h.Store.Create(new ConnectionProfile { Name = "Redis test", ProviderId = "redis", ReadOnly = readOnly, Props = props }, password);
        h.Clients = new SourceClientManager(h.Registry, h.Store, h.Events);
        h.Streams = new StreamManager(h.Events, kind => kind switch
        {
            "redis.monitor" => new Services.MonitorStreamFactory(h.Clients),
            "redis.subscribe" => new Services.PubSubStreamFactory(h.Clients),
            _ => null,
        }, h.Store, clients: h.Clients, options: streamOptions ?? new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(30) });
        h.Jobs = new JobManager(h.Events);
        await Task.CompletedTask;
        return h;
    }

    public async Task<RedisClient> ClientAsync() => (RedisClient)await Clients.GetAsync(Cid, CancellationToken.None);

    public async ValueTask DisposeAsync()
    {
        await Streams.DisposeAsync();
        await Jobs.DisposeAsync();
        await Clients.DisposeAsync();
        await Server.DisposeAsync();
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>An in-process Kestrel host with the Redis module's endpoints and an error envelope like the Host's.</summary>
internal sealed class RedisApi : IAsyncDisposable
{
    private readonly WebApplication _app;

    private RedisApi(WebApplication app, HttpClient http)
    {
        _app = app;
        Http = http;
    }

    public HttpClient Http { get; }

    public static async Task<RedisApi> StartAsync(RedisHarness h)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseKestrel(k => k.Listen(IPAddress.Loopback, 0));
        builder.Services.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
        builder.Services.AddSingleton(h.Clients);
        builder.Services.AddSingleton(h.Jobs);
        builder.Services.AddSingleton(h.Streams);
        var module = new RedisModule();
        module.ConfigureServices(builder.Services);
        var app = builder.Build();
        app.Use(async (ctx, next) =>
        {
            try
            {
                await next(ctx);
            }
            catch (EngineException ex)
            {
                ctx.Response.StatusCode = ex.Status;
                await ctx.Response.WriteAsJsonAsync(new { error = new { code = ex.Code, message = ex.Message, detail = ex.Detail } }, CoreJson.Options);
            }
            catch (BadHttpRequestException ex)
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { error = new { code = "VALIDATION", message = ex.Message } }, CoreJson.Options);
            }
        });
        module.MapEndpoints(app.MapGroup("/api/v1"));
        await app.StartAsync();
        var address = app.Urls.First();
        return new RedisApi(app, new HttpClient { BaseAddress = new Uri(address) });
    }

    public static async Task<JsonElement> JsonOf(HttpResponseMessage res) =>
        res.Content.Headers.ContentLength == 0 ? default : await res.Content.ReadFromJsonAsync<JsonElement>();

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}

internal static class Seed
{
    /// <summary>A small keyspace with one key of each type (db 0).</summary>
    public static async Task BasicAsync(RedisClient c, int db = 0)
    {
        var d = c.Db(db);
        await d.ExecuteAsync("SET", "greeting", "hello");
        await d.ExecuteAsync("SET", "config:json", "{\"a\":1,\"b\":[1,2]}");
        await d.ExecuteAsync("HSET", "user:1001:profile", "name", "Alice", "email", "alice@example.com", "tier", "gold");
        await d.ExecuteAsync("RPUSH", "queue:jobs", "j1", "j2", "j3");
        await d.ExecuteAsync("SADD", "tags", "red", "green", "blue");
        await d.ExecuteAsync("ZADD", "leaderboard", "10", "alice", "30", "carol", "20", "bob");
        await d.ExecuteAsync("XADD", "events", "1-0", "type", "login", "user", "1001");
        await d.ExecuteAsync("XADD", "events", "2-0", "type", "logout", "user", "1001");
        await d.ExecuteAsync("XADD", "events", "3-0", "type", "login", "user", "1002");
        await d.ExecuteAsync("JSON.SET", "doc:1", "$", "{\"name\":\"Widget\",\"price\":9.5,\"tags\":[\"a\",\"b\"]}");
    }
}
