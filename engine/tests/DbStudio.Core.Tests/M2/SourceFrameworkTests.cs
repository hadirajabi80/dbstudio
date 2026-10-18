using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Tests.M2;

// M2-0 (docs/PLAN-M2.md 1.1, 2.4, 9 "Acceptance M2-0"): source registry, source clients, streams, jobs, module discovery,
// D12 secret stripping, settings and JSON conventions.

/// <summary>Test double of a Redis/Mongo/Kafka provider.</summary>
internal sealed class FakeSourceProvider(string id, SourceKind kind, params FormField[] extraFields) : IDataSourceProvider
{
    public int Opens;
    public Exception? FailWith;
    public TimeSpan OpenDelay = TimeSpan.Zero;
    public readonly ConcurrentBag<FakeSourceClient> Clients = [];

    public string Id => id;
    public string DisplayName => "Fake " + id;
    public SourceKind Kind => kind;
    public ConnectionFormSpec FormSpec { get; } = new(
        [new FormField("host", "Host", "text", Required: true), new FormField("password", "Password", "password"), .. extraFields]);

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        Task.FromResult(new TestConnectionResult(true, new ServerInfo("Fake 1.0", "1.0", "fake", null, null), 1, null));

    public async Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        Interlocked.Increment(ref Opens);
        if (OpenDelay > TimeSpan.Zero) await Task.Delay(OpenDelay, ct);
        if (FailWith is not null) throw FailWith;
        var c = new FakeSourceClient(profile.Id, profile, password);
        Clients.Add(c);
        return c;
    }
}

internal sealed class FakeSourceClient(string connectionId, ConnectionProfile profile, string? password) : IDataSourceClient
{
    public bool Disposed;
    public ConnectionProfile Profile { get; } = profile;
    public string? Password { get; } = password;
    public string ConnectionId => connectionId;
    public ServerInfo Server { get; } = new("Fake 1.0", "1.0", "fake", null, null);
    public DateTimeOffset LastUsed { get; set; }
    public Task<bool> PingAsync(CancellationToken ct) => Task.FromResult(!Disposed);

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}

/// <summary>A stream factory whose streams expose their sink to the test and run until cancelled.</summary>
internal sealed class FakeStreamFactory : IStreamFactory
{
    public readonly ConcurrentDictionary<string, FakeStream> Streams = new();
    public bool Pausable;

    public Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        if (ctx.GetString("fail") is { } message) throw EngineException.Validation(message, new { field = "params.fail" });
        var s = Pausable ? new PausableFakeStream() : new FakeStream();
        s.Context = ctx;
        Streams[ctx.StreamId] = s;
        return Task.FromResult<IEngineStream>(s);
    }
}

internal class FakeStream : IEngineStream, IAsyncDisposable
{
    private readonly TaskCompletionSource<IStreamSink> _sink = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public StreamContext Context = null!;
    public bool Disposed;
    public Task<IStreamSink> Sink => _sink.Task;

    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        _sink.TrySetResult(sink);
        await Task.Delay(Timeout.Infinite, ct);
    }

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}

internal sealed class PausableFakeStream : FakeStream, IPausableEngineStream
{
    public bool SourcePaused;
    public void SetPaused(bool paused) => SourcePaused = paused;
}

/// <summary>Records events; stream.data publishing can be blocked to simulate a slow WebSocket.</summary>
internal sealed class GatedPublisher : IEventPublisher
{
    public readonly RecordingPublisher Inner = new();
    public readonly ManualResetEventSlim DataGate = new(true);

    public void Publish(EngineEvent ev)
    {
        if (ev is StreamDataEvent) DataGate.Wait(TimeSpan.FromSeconds(20));
        Inner.Publish(ev);
    }
}

public sealed class StreamManagerTests
{
    private static JsonElement Item(int i) => JsonSerializer.SerializeToElement(new { i });

    private static StreamManager Create(IEventPublisher events, FakeStreamFactory factory, StreamManagerOptions? options = null,
        ClientPresence? presence = null, SourceClientManager? clients = null) =>
        new(events, kind => kind == "test.kind" ? factory : null, presence: presence, clients: clients,
            options: options ?? new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(50) });

    private static async Task WaitUntil(Func<bool> condition, int timeoutMs = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task Batches_items_by_count_and_time_with_monotonic_seq()
    {
        var events = new RecordingPublisher();
        var factory = new FakeStreamFactory();
        // A long flush window: on a slow runner the 450 pushes still land in full 200-item batches.
        await using var streams = Create(events, factory, new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(300) });

        var info = await streams.OpenAsync("test.kind", "c_1", null, "ui-1", CancellationToken.None);
        Assert.StartsWith("st_", info.StreamId);
        var sink = await factory.Streams[info.StreamId].Sink;
        for (var i = 0; i < 450; i++) Assert.True(sink.Push(Item(i)));

        await WaitUntil(() => events.All.OfType<StreamDataEvent>().Sum(e => e.Items.Count) == 450);
        var batches = events.All.OfType<StreamDataEvent>().Where(e => e.StreamId == info.StreamId).ToList();
        Assert.All(batches, b => Assert.InRange(b.Items.Count, 1, 200));
        Assert.Equal(200, batches[0].Items.Count); // flushed on count, not on the timer
        Assert.Equal(Enumerable.Range(1, batches.Count).Select(i => (long)i), batches.Select(b => b.Seq));
        Assert.Equal(Enumerable.Range(0, 450), batches.SelectMany(b => b.Items).Select(e => e.GetProperty("i").GetInt32()));

        // A single item is flushed by the timer.
        sink.Push(Item(450));
        await WaitUntil(() => events.All.OfType<StreamDataEvent>().Sum(e => e.Items.Count) == 451);
        Assert.Equal(451, streams.Get(info.StreamId)!.Delivered);

        Assert.True(await streams.CloseAsync(info.StreamId));
        var ended = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "ended");
        Assert.Equal("closed", ended.Reason);
        Assert.True(factory.Streams[info.StreamId].Disposed);
        Assert.Null(streams.Get(info.StreamId));
        Assert.False(await streams.CloseAsync(info.StreamId));
    }

    [Fact]
    public async Task Full_queue_drops_oldest_and_reports_the_dropped_count()
    {
        var events = new GatedPublisher();
        var factory = new FakeStreamFactory();
        await using var streams = Create(events, factory, new StreamManagerOptions
        {
            FlushInterval = TimeSpan.FromMilliseconds(20), MaxQueuedItems = 100, DropReportInterval = TimeSpan.FromMilliseconds(20),
        });
        var info = await streams.OpenAsync("test.kind", "c_1", null, "ui-1", CancellationToken.None);
        var sink = await factory.Streams[info.StreamId].Sink;

        events.DataGate.Reset(); // the WebSocket stops draining
        for (var i = 0; i < 1000; i++) sink.Push(Item(i));
        await WaitUntil(() => streams.Get(info.StreamId)!.Dropped > 0);
        events.DataGate.Set();

        await WaitUntil(() => events.Inner.All.OfType<StreamDataEvent>().Sum(e => e.Items.Count) + streams.Get(info.StreamId)!.Dropped == 1000);
        var dropped = streams.Get(info.StreamId)!.Dropped;
        Assert.InRange(dropped, 700, 999);
        var delivered = events.Inner.All.OfType<StreamDataEvent>().SelectMany(e => e.Items).Select(e => e.GetProperty("i").GetInt32()).ToList();
        Assert.Equal(999, delivered[^1]); // the newest items survive
        Assert.Equal(delivered.OrderBy(i => i), delivered);

        var report = await events.Inner.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "open" && e.Dropped > 0);
        Assert.True(report.Dropped <= dropped);

        await streams.CloseAsync(info.StreamId);
        var ended = await events.Inner.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "ended");
        Assert.Equal(dropped, ended.Dropped);
    }

    [Fact]
    public async Task Pause_drops_unless_the_stream_pauses_its_source()
    {
        var events = new RecordingPublisher();
        var factory = new FakeStreamFactory();
        await using var streams = Create(events, factory);
        var info = await streams.OpenAsync("test.kind", "c_1", null, "ui-1", CancellationToken.None);
        var sink = await factory.Streams[info.StreamId].Sink;

        Assert.Equal("paused", streams.Pause(info.StreamId).State);
        Assert.True(sink.Paused);
        Assert.False(sink.Push(Item(1)));
        Assert.Equal(1, streams.Get(info.StreamId)!.Dropped);
        await events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "paused");
        Assert.Equal("open", streams.Resume(info.StreamId).State);
        Assert.True(sink.Push(Item(2)));
        await WaitUntil(() => streams.Get(info.StreamId)!.Delivered == 1);

        factory.Pausable = true;
        var p = await streams.OpenAsync("test.kind", "c_1", null, "ui-1", CancellationToken.None);
        streams.Pause(p.StreamId);
        Assert.True(((PausableFakeStream)factory.Streams[p.StreamId]).SourcePaused);
        Assert.True((await factory.Streams[p.StreamId].Sink).Push(Item(3)));
        Assert.Equal(0, streams.Get(p.StreamId)!.Dropped);

        Assert.Equal(ErrorCodes.NotFound, Assert.Throws<EngineException>(() => streams.Pause("st_nope")).Code);
    }

    [Fact]
    public async Task Streams_of_a_gone_client_close_after_the_grace_period()
    {
        var events = new RecordingPublisher();
        var factory = new FakeStreamFactory();
        var presence = new ClientPresence();
        await using var streams = Create(events, factory, new StreamManagerOptions { OrphanGrace = TimeSpan.FromMilliseconds(80) }, presence);

        presence.Connected("ui-gone");
        presence.Connected("ui-back");
        var gone = await streams.OpenAsync("test.kind", "c_1", null, "ui-gone", CancellationToken.None);
        var back = await streams.OpenAsync("test.kind", "c_1", null, "ui-back", CancellationToken.None);

        presence.Disconnected("ui-gone");
        presence.Disconnected("ui-back");
        presence.Connected("ui-back"); // reconnects within the grace period

        var ended = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == gone.StreamId && e.State == "ended");
        Assert.Equal("client-gone", ended.Reason);
        await Task.Delay(200);
        Assert.NotNull(streams.Get(back.StreamId));
        Assert.Single(streams.List());
        Assert.Single(streams.List("ui-back"));
    }

    [Fact]
    public async Task Limits_per_client_and_engine_wide()
    {
        var events = new RecordingPublisher();
        var factory = new FakeStreamFactory();
        await using var streams = Create(events, factory, new StreamManagerOptions { MaxStreamsPerClient = 2, MaxStreams = 3 });

        var a1 = await streams.OpenAsync("test.kind", "c_1", null, "a", CancellationToken.None);
        await streams.OpenAsync("test.kind", "c_1", null, "a", CancellationToken.None);
        var perClient = await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("test.kind", "c_1", null, "a", CancellationToken.None));
        Assert.Equal((429, ErrorCodes.StreamLimit), (perClient.Status, perClient.Code));

        await streams.OpenAsync("test.kind", "c_1", null, "b", CancellationToken.None);
        var engine = await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("test.kind", "c_1", null, "b", CancellationToken.None));
        Assert.Equal(ErrorCodes.StreamLimit, engine.Code);

        await streams.CloseAsync(a1.StreamId);
        await streams.OpenAsync("test.kind", "c_1", null, "a", CancellationToken.None);
        Assert.Equal(3, streams.Count);

        // Validation: unknown kind, missing connection, factory errors (which do not leak a reserved slot).
        Assert.Equal(ErrorCodes.Validation, (await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("nope", "c_1", null, "c", CancellationToken.None))).Code);
        Assert.Equal(ErrorCodes.Validation, (await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("test.kind", "", null, "c", CancellationToken.None))).Code);
    }

    [Fact]
    public async Task Factory_errors_propagate_and_params_are_readable()
    {
        var events = new RecordingPublisher();
        var factory = new FakeStreamFactory();
        await using var streams = Create(events, factory, new StreamManagerOptions { MaxStreams = 1 });
        var bad = JsonSerializer.SerializeToElement(new { fail = "params.topic is required." });
        var ex = await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync("test.kind", "c_1", bad, "a", CancellationToken.None));
        Assert.Equal("params.topic is required.", ex.Message);

        var p = JsonSerializer.SerializeToElement(new { topic = "orders", partitions = new[] { "0", "1" }, limit = 5, live = true });
        var info = await streams.OpenAsync("test.kind", "c_1", p, "a", CancellationToken.None); // the failed open freed its slot
        var ctx = factory.Streams[info.StreamId].Context;
        Assert.Equal("orders", ctx.GetString("topic", required: true));
        Assert.Equal(["0", "1"], ctx.GetStrings("partitions"));
        Assert.Equal(5, ctx.GetInt("limit", 0));
        Assert.True(ctx.GetBool("live", false));
        Assert.Equal("a", ctx.OwnerClientId);
        Assert.Throws<EngineException>(() => ctx.GetString("missing", required: true));
    }

    [Fact]
    public async Task Stream_errors_end_with_state_error()
    {
        var events = new RecordingPublisher();
        await using var streams = new StreamManager(events, _ => new ThrowingFactory());
        var info = await streams.OpenAsync("x", "engine", null, null, CancellationToken.None);
        var ev = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "error");
        Assert.Equal("boom", ev.Reason);
    }

    private sealed class ThrowingFactory : IStreamFactory, IEngineStream
    {
        public Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct) => Task.FromResult<IEngineStream>(this);

        public async Task RunAsync(IStreamSink sink, CancellationToken ct)
        {
            await Task.Yield();
            throw new InvalidOperationException("boom");
        }
    }
}

public sealed class SourceClientManagerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-core-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private (SourceRegistry Registry, ConnectionStore Store, FakeSourceProvider Redis, InMemorySecretStore Secrets) Setup()
    {
        var redis = new FakeSourceProvider("redis", SourceKind.KeyValue, new FormField("saslPassword", "SASL password", "password"));
        var registry = new SourceRegistry(new ProviderRegistry([new SqliteProvider()]), [redis]);
        var secrets = new InMemorySecretStore();
        return (registry, new ConnectionStore(new AppPaths(_dir), secrets, registry), redis, secrets);
    }

    private static ConnectionProfile Redis(string name = "cache") =>
        new() { Name = name, ProviderId = "redis", Props = new() { ["host"] = "localhost" } };

    [Fact]
    public async Task Opens_once_per_connection_and_publishes_client_events()
    {
        var (registry, store, redis, _) = Setup();
        var events = new RecordingPublisher();
        await using var clients = new SourceClientManager(registry, store, events);
        var c = store.Create(Redis(), "pw");
        redis.OpenDelay = TimeSpan.FromMilliseconds(50);

        var all = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => clients.GetAsync(c.Id, CancellationToken.None)));
        Assert.Equal(1, redis.Opens);
        Assert.All(all, x => Assert.Same(all[0], x));
        Assert.Equal("pw", ((FakeSourceClient)all[0]).Password);
        await events.WaitAsync<SourceClientChangedEvent>(e => e.ConnectionId == c.Id && e.State == "open");
        var info = Assert.Single(clients.List());
        Assert.Equal(("open", "Fake 1.0"), (info.State, info.Server!.Version));

        Assert.True(await clients.MarkBrokenAsync(c.Id, "socket closed"));
        Assert.True(((FakeSourceClient)all[0]).Disposed);
        await events.WaitAsync<SourceClientChangedEvent>(e => e.ConnectionId == c.Id && e.State == "broken");
        Assert.Empty(clients.List());
        await clients.GetAsync(c.Id, CancellationToken.None);
        Assert.Equal(2, redis.Opens);
        Assert.True(await clients.CloseAsync(c.Id));
        Assert.False(await clients.CloseAsync(c.Id));
    }

    [Fact]
    public async Task Failures_map_to_source_unavailable_and_relational_is_rejected()
    {
        var (registry, store, redis, _) = Setup();
        await using var clients = new SourceClientManager(registry, store, NullEventPublisher.Instance);
        var c = store.Create(Redis(), null);
        redis.FailWith = new IOException("Connection refused (localhost:6379)");
        var ex = await Assert.ThrowsAsync<EngineException>(() => clients.GetAsync(c.Id, CancellationToken.None));
        Assert.Equal((503, ErrorCodes.SourceUnavailable, "Connection refused (localhost:6379)"), (ex.Status, ex.Code, ex.Message));

        var lite = store.Create(new ConnectionProfile { Name = "lite", ProviderId = "sqlite", Props = new() { ["path"] = "x.db" } }, null);
        Assert.Equal(ErrorCodes.Validation, (await Assert.ThrowsAsync<EngineException>(() => clients.GetAsync(lite.Id, CancellationToken.None))).Code);
        Assert.Equal(ErrorCodes.NotFound, (await Assert.ThrowsAsync<EngineException>(() => clients.GetAsync("c_nope", CancellationToken.None))).Code);
    }

    [Fact]
    public async Task Idle_clients_are_reaped_unless_leased_and_their_streams_end()
    {
        var (registry, store, _, _) = Setup();
        var events = new RecordingPublisher();
        await using var clients = new SourceClientManager(registry, store, events, idleTimeout: TimeSpan.FromMilliseconds(1),
            reapInterval: TimeSpan.FromHours(1));
        var factory = new FakeStreamFactory();
        await using var streams = new StreamManager(events, _ => factory, store, clients: clients);
        var a = store.Create(Redis("a"), null);
        var b = store.Create(Redis("b"), null);
        await clients.GetAsync(a.Id, CancellationToken.None);
        await clients.GetAsync(b.Id, CancellationToken.None);
        var stream = await streams.OpenAsync("redis.monitor", b.Id, null, null, CancellationToken.None); // holds a lease on b

        await Task.Delay(20);
        Assert.Equal(1, await clients.ReapIdleAsync());
        Assert.Null(clients.Info(a.Id));
        Assert.NotNull(clients.Info(b.Id));

        await clients.CloseAsync(b.Id); // Disconnect ends the streams on it
        var ended = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == stream.StreamId && e.State == "ended");
        Assert.Equal("source-closed", ended.Reason);
        Assert.Equal(ErrorCodes.NotFound, (await Assert.ThrowsAsync<EngineException>(() =>
            streams.OpenAsync("redis.monitor", "c_unknown", null, null, CancellationToken.None))).Code);
    }

    [Fact]
    public void ConnectionStore_strips_every_password_typed_field_and_keeps_extra_secrets()
    {
        var (_, store, _, secrets) = Setup();
        var file = Path.Combine(_dir, "connections.json");
        var c = store.Create(new ConnectionProfile
        {
            Name = "kafka-ish", ProviderId = "redis",
            Props = new() { ["host"] = "h", ["password"] = "leak1", ["saslPassword"] = "sasl-secret" },
        }, "main-secret");
        var text = File.ReadAllText(file);
        Assert.DoesNotContain("leak1", text);
        Assert.DoesNotContain("sasl-secret", text);
        Assert.DoesNotContain("main-secret", text);
        Assert.False(store.Get(c.Id).Props.ContainsKey("saslPassword"));
        Assert.Equal("sasl-secret", store.GetSecret(c.Id, "saslPassword"));
        Assert.Equal("sasl-secret", store.WithSecrets(store.Get(c.Id)).GetString("saslPassword"));

        // "" / missing keep, a value replaces, JSON null clears.
        store.Update(c.Id, new ConnectionProfile { Name = "k", ProviderId = "redis", Props = new() { ["host"] = "h", ["saslPassword"] = "" } }, null);
        Assert.Equal("sasl-secret", store.GetSecret(c.Id, "saslPassword"));
        store.Update(c.Id, new ConnectionProfile { Name = "k", ProviderId = "redis", Props = new() { ["host"] = "h", ["saslPassword"] = "new" } }, null);
        Assert.Equal("new", store.GetSecret(c.Id, "saslPassword"));
        Assert.DoesNotContain("new\"", File.ReadAllText(file));
        store.Update(c.Id, new ConnectionProfile { Name = "k", ProviderId = "redis", Props = new() { ["host"] = "h", ["saslPassword"] = null } }, null);
        Assert.Null(store.GetSecret(c.Id, "saslPassword"));

        store.Update(c.Id, new ConnectionProfile { Name = "k", ProviderId = "redis", Props = new() { ["host"] = "h", ["saslPassword"] = "again" } }, null);
        store.Delete(c.Id);
        Assert.False(secrets.Has(ConnectionStore.SecretKey(c.Id, "saslPassword")));
        Assert.False(secrets.Has(c.Id));
    }
}

public sealed class SourceRegistryTests
{
    [Fact]
    public void Describe_lists_relational_and_source_providers_in_display_order_with_kinds()
    {
        var registry = new SourceRegistry(new ProviderRegistry([new SqliteProvider()]),
            [new FakeSourceProvider("kafka", SourceKind.Stream), new FakeSourceProvider("redis", SourceKind.KeyValue),
             new FakeSourceProvider("mongodb", SourceKind.Document), new FakeSourceProvider("sqlite", SourceKind.KeyValue)]);

        var list = registry.Describe();
        Assert.Equal(["sqlite", "redis", "mongodb", "kafka"], list.Select(p => p.Id));
        Assert.Equal(SourceKind.Relational, list[0].Kind); // a module cannot shadow a relational id
        Assert.Equal(Dialect.Sqlite, list[0].Dialect);
        Assert.All(list.Skip(1), p => Assert.Null(p.Dialect));
        Assert.Equal(SourceKind.KeyValue, registry.KindOf("REDIS"));
        Assert.True(registry.IsRelational("sqlite"));
        Assert.False(registry.IsRelational("kafka"));
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => registry.Get("nope")).Code);

        var json = JsonSerializer.Serialize(list, CoreJson.Options);
        Assert.Contains("\"kind\":\"keyvalue\"", json);
        Assert.Contains("\"kind\":\"relational\"", json);
        Assert.Contains("\"dialect\":null", json);
        Assert.Contains("\"dialect\":\"sqlite\"", json);
    }

    [Fact]
    public async Task Relational_adapter_tests_through_the_provider_and_refuses_clients()
    {
        var registry = new SourceRegistry(new ProviderRegistry([new SqliteProvider()]), []);
        var sqlite = registry.Get("sqlite");
        var profile = new ConnectionProfile { ProviderId = "sqlite", Props = new() { ["path"] = ":memory:" } };
        Assert.True((await sqlite.TestAsync(profile, null, CancellationToken.None)).Ok);
        await Assert.ThrowsAsync<EngineException>(() => sqlite.OpenAsync(profile, null, CancellationToken.None));
    }
}

public sealed class JobManagerTests
{
    [Fact]
    public async Task Jobs_report_progress_and_finish_with_a_result_or_cancelled()
    {
        var events = new RecordingPublisher();
        await using var jobs = new JobManager(events);
        var id = jobs.Start("test.job", "c_1", "ui-1", async (ctx, ct) =>
        {
            ctx.Report(1, 2, "half", force: true);
            await Task.Delay(1, ct);
            return new { scanned = 2 };
        });
        Assert.StartsWith("j_", id);
        var done = await events.WaitAsync<JobDoneEvent>(e => e.JobId == id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(2, done.Result!.Value.GetProperty("scanned").GetInt32());
        var progress = await events.WaitAsync<JobProgressEvent>(e => e.JobId == id);
        Assert.Equal((1L, 2L, "half"), (progress.Done, progress.Total!.Value, progress.Message));

        var started = new TaskCompletionSource();
        var slow = jobs.Start("test.slow", null, null, async (_, ct) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct);
            return null;
        });
        await started.Task;
        Assert.Single(jobs.List());
        Assert.True(jobs.Cancel(slow));
        Assert.Equal(ExecutionStatus.Cancelled, (await events.WaitAsync<JobDoneEvent>(e => e.JobId == slow)).Status);
        Assert.False(jobs.Cancel("j_nope"));

        var failing = jobs.Start("test.fail", null, null, (_, _) => throw EngineException.Privilege("denied", "VIEW SERVER STATE"));
        var failed = await events.WaitAsync<JobDoneEvent>(e => e.JobId == failing);
        Assert.Equal((ExecutionStatus.Error, "denied"), (failed.Status, failed.Error));
    }
}

/// <summary>Discovered by <see cref="EngineModulesTests"/>.</summary>
public sealed class DiscoverableTestModule : IEngineModule
{
    public static int Mapped;

    public void ConfigureServices(IServiceCollection services) => services.AddKeyedSingleton<IStreamFactory, FakeStreamFactory>("test.discovered");

    public void MapEndpoints(RouteGroupBuilder api)
    {
        api.MapGet("/test-module", () => "ok");
        Interlocked.Increment(ref Mapped);
    }
}

public abstract class AbstractTestModule : IEngineModule
{
    public abstract void ConfigureServices(IServiceCollection services);
    public abstract void MapEndpoints(RouteGroupBuilder api);
}

public sealed class NoDefaultCtorTestModule(int x) : IEngineModule
{
    public int X => x;
    public void ConfigureServices(IServiceCollection services) { }
    public void MapEndpoints(RouteGroupBuilder api) { }
}

public sealed class EngineModulesTests
{
    [Fact]
    public void Discovers_concrete_modules_once_and_wires_services_and_endpoints()
    {
        var modules = EngineModules.Discover(typeof(EngineModulesTests).Assembly, typeof(EngineModulesTests).Assembly);
        var module = Assert.Single(modules, m => m is DiscoverableTestModule);
        Assert.DoesNotContain(modules, m => m is AbstractTestModule or NoDefaultCtorTestModule);

        var builder = WebApplication.CreateSlimBuilder();
        foreach (var m in modules) m.ConfigureServices(builder.Services);
        var app = builder.Build();
        Assert.IsType<FakeStreamFactory>(app.Services.GetRequiredKeyedService<IStreamFactory>("test.discovered"));
        var before = DiscoverableTestModule.Mapped;
        module.MapEndpoints(app.MapGroup("/api/v1"));
        Assert.Equal(before + 1, DiscoverableTestModule.Mapped);
    }

    [Fact]
    public void Walks_referenced_DbStudio_assemblies()
    {
        // The test assembly references Core and the SQLite provider; neither defines a module today, and walking them must not fail.
        var modules = EngineModules.Discover(typeof(EngineModulesTests).Assembly);
        Assert.All(modules, m => Assert.StartsWith("DbStudio.", m.GetType().Assembly.GetName().Name));
    }
}

public sealed class M2SettingsAndJsonTests
{
    [Fact]
    public void Settings_have_M2_defaults_and_accept_pgsql()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dbstudio-core-tests", Guid.NewGuid().ToString("N"));
        var s = new SettingsService(new AppPaths(dir));
        var d = s.Get();
        Assert.Equal(600, d["connections"]!["sourceIdleSeconds"]!.GetValue<int>());
        Assert.Equal(50_000, d["streams"]!["maxQueuedItems"]!.GetValue<int>());
        Assert.Equal(2000, d["logs"]!["tailIntervalMs"]!.GetValue<int>());

        var updated = s.Update(new JsonObject { ["editor"] = new JsonObject { ["blankLineSplitsStatementsByDialect"] = new JsonObject { ["pgsql"] = false } } });
        Assert.False(updated["editor"]!["blankLineSplitsStatementsByDialect"]!["pgsql"]!.GetValue<bool>());
        Assert.Throws<EngineException>(() => s.Update(new JsonObject { ["streams"] = new JsonObject { ["maxQueuedItems"] = 5 } }));
        Assert.Throws<EngineException>(() => s.Update(new JsonObject { ["logs"] = new JsonObject { ["tailIntervalMs"] = "fast" } }));
        try { Directory.Delete(dir, true); } catch (IOException) { }
    }

    [Fact]
    public void Wire_tokens_for_pgsql_and_source_kinds()
    {
        Assert.Equal("\"pgsql\"", JsonSerializer.Serialize(Dialect.PgSql, CoreJson.Options));
        Assert.Equal(Dialect.PgSql, JsonSerializer.Deserialize<Dialect>("\"pgsql\"", CoreJson.Options));
        Assert.Equal("\"keyvalue\"", JsonSerializer.Serialize(SourceKind.KeyValue, CoreJson.Options));
        Assert.Equal(SourceKind.Document, JsonSerializer.Deserialize<SourceKind>("\"document\"", CoreJson.Options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<SourceKind>("\"graph\"", CoreJson.Options));
        Assert.True(DialectInfo.HasDatabases(Dialect.PgSql));
        Assert.False(DialectInfo.HasDatabases(Dialect.Sqlite));
        Assert.Equal("public", DialectInfo.DefaultSchemaFallback(Dialect.PgSql));

        var ev = new StreamDataEvent("st_1", [JsonSerializer.SerializeToElement(new { a = 1 })], 3);
        var json = JsonSerializer.Serialize<EngineEvent>(ev, CoreJson.Options);
        Assert.Contains("\"type\":\"stream.data\"", JsonSerializer.Serialize(ev, ev.GetType(), CoreJson.Options));
        Assert.Contains("\"seq\":3", JsonSerializer.Serialize(ev, ev.GetType(), CoreJson.Options));
        Assert.Contains("\"items\":[{\"a\":1}]", JsonSerializer.Serialize(ev, ev.GetType(), CoreJson.Options));
        Assert.NotEmpty(json);
    }
}
