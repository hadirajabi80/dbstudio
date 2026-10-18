using System.Collections.Concurrent;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Services;

/// <summary>Wire shape of a source client (<c>GET /sources/{cid}/client</c>, <c>GET /sources/clients</c>).</summary>
/// <param name="State">open | closed | broken.</param>
public sealed record SourceClientInfo(string ConnectionId, string State, ServerInfo? Server, DateTimeOffset OpenedAt, DateTimeOffset LastUsed);

/// <summary>
/// M2 (docs/PLAN-M2.md D2, 2.3): one long-lived <see cref="IDataSourceClient"/> per non-relational connection profile.
/// <see cref="GetAsync"/> opens lazily (one open at a time per connection), maps open failures to 503
/// SOURCE_UNAVAILABLE and publishes <c>source.client</c> events on open/close/broken. Clients unused for
/// <c>connections.sourceIdleSeconds</c> (default 600, 0 = never) are closed by a reaper unless a lease is held
/// (<see cref="AcquireLease"/>; <see cref="StreamManager"/> holds one per open stream).
/// <para>Feature code: <c>var client = (RedisClient)await clients.GetAsync(cid, ct);</c>, and on a driver failure that
/// means the connection is gone: <c>await clients.MarkBrokenAsync(cid, ex.Message);</c>.</para>
/// </summary>
public sealed class SourceClientManager : IAsyncDisposable
{
    /// <summary>Default of settings connections.sourceIdleSeconds.</summary>
    public const int DefaultIdleSeconds = 600;

    private readonly SourceRegistry _sources;
    private readonly ConnectionStore _connections;
    private readonly IEventPublisher _events;
    private readonly SettingsService? _settings;
    private readonly ILogger _log;
    private readonly TimeProvider _time;
    private readonly TimeSpan? _idleOverride;
    private readonly ConcurrentDictionary<string, Entry> _clients = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> _leases = new(StringComparer.Ordinal);
    private readonly ITimer _reaper;
    private int _reaping;
    private bool _disposed;

    private sealed record Entry(IDataSourceClient Client, DateTimeOffset OpenedAt);

    /// <param name="idleTimeout">Tests: overrides settings connections.sourceIdleSeconds (zero or less = never).</param>
    /// <param name="reapInterval">How often idle clients are looked for (default 30 s).</param>
    public SourceClientManager(SourceRegistry sources, ConnectionStore connections, IEventPublisher events, SettingsService? settings = null,
        ILogger<SourceClientManager>? log = null, TimeProvider? time = null, TimeSpan? idleTimeout = null, TimeSpan? reapInterval = null)
    {
        _sources = sources;
        _connections = connections;
        _events = events;
        _settings = settings;
        _log = log ?? (ILogger)NullLogger.Instance;
        _time = time ?? TimeProvider.System;
        _idleOverride = idleTimeout;
        var interval = reapInterval ?? TimeSpan.FromSeconds(30);
        _reaper = _time.CreateTimer(_ => _ = ReapIdleAsync(), null, interval, interval);
    }

    /// <summary>Raised after a client was closed or marked broken: (connectionId, "closed" | "broken", reason).</summary>
    public event Action<string, string, string?>? ClientClosed;

    /// <summary>
    /// The open client of the connection, opening it when needed. 404 when the connection is unknown, 400 for relational
    /// connections, 503 SOURCE_UNAVAILABLE when the driver cannot connect.
    /// </summary>
    public async Task<IDataSourceClient> GetAsync(string connectionId, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_clients.TryGetValue(connectionId, out var existing))
        {
            existing.Client.LastUsed = _time.GetUtcNow();
            return existing.Client;
        }

        var profile = _connections.Get(connectionId);
        var provider = _sources.Get(profile.ProviderId);
        if (provider.Kind == SourceKind.Relational)
            throw EngineException.Validation($"'{profile.Name}' is a {provider.DisplayName} connection: it uses sessions, not a source client.",
                new { connectionId });

        var gate = _gates.GetOrAdd(connectionId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_clients.TryGetValue(connectionId, out existing))
            {
                existing.Client.LastUsed = _time.GetUtcNow();
                return existing.Client;
            }
            IDataSourceClient client;
            try
            {
                client = await provider.OpenAsync(_connections.WithSecrets(profile), _connections.GetPassword(connectionId), ct).ConfigureAwait(false);
            }
            catch (EngineException)
            {
                throw;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _log.LogInformation("Source client {ConnectionId} ({Provider}) could not connect: {Message}", connectionId, provider.Id, ex.Message);
                throw EngineException.SourceUnavailable(ex.Message, new { connectionId, providerId = provider.Id });
            }
            var now = _time.GetUtcNow();
            client.LastUsed = now;
            _clients[connectionId] = new Entry(client, now);
            _connections.Touch(connectionId);
            _log.LogInformation("Source client {ConnectionId} opened ({Provider})", connectionId, provider.Id);
            _events.Publish(new SourceClientChangedEvent(connectionId, "open"));
            return client;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>The open client, or null (never opens).</summary>
    public IDataSourceClient? Peek(string connectionId) => _clients.TryGetValue(connectionId, out var e) ? e.Client : null;

    public SourceClientInfo? Info(string connectionId) =>
        _clients.TryGetValue(connectionId, out var e) ? ToInfo(connectionId, e) : null;

    public IReadOnlyList<SourceClientInfo> List() =>
        _clients.Select(kv => ToInfo(kv.Key, kv.Value)).OrderBy(i => i.ConnectionId, StringComparer.Ordinal).ToList();

    /// <summary>Disconnect: disposes the client (streams on it end). Returns false when none was open.</summary>
    public Task<bool> CloseAsync(string connectionId, string? reason = null) => RemoveAsync(connectionId, "closed", reason ?? "disconnected");

    /// <summary>The driver reported a lost connection: dispose the client; the next <see cref="GetAsync"/> reopens it.</summary>
    public Task<bool> MarkBrokenAsync(string connectionId, string? reason = null) => RemoveAsync(connectionId, "broken", reason);

    /// <summary>Keeps the connection's client from being reaped while the lease is held (streams, jobs).</summary>
    public IDisposable AcquireLease(string connectionId)
    {
        _leases.AddOrUpdate(connectionId, 1, (_, n) => n + 1);
        return new Lease(this, connectionId);
    }

    private sealed class Lease(SourceClientManager owner, string connectionId) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) != 0) return;
            owner._leases.AddOrUpdate(connectionId, 0, (_, n) => Math.Max(0, n - 1));
        }
    }

    /// <summary>settings connections.sourceIdleSeconds (zero = never close).</summary>
    public TimeSpan IdleTimeout()
    {
        if (_idleOverride is { } fixedTimeout) return fixedTimeout;
        var node = _settings?.Get()["connections"]?["sourceIdleSeconds"];
        var seconds = node is null ? DefaultIdleSeconds : Math.Clamp(SettingsService.Number(node), 0, 86_400);
        return TimeSpan.FromSeconds(seconds);
    }

    /// <summary>Closes clients idle for longer than <see cref="IdleTimeout"/> that hold no lease. Public for tests.</summary>
    public async Task<int> ReapIdleAsync()
    {
        if (_disposed || Interlocked.Exchange(ref _reaping, 1) != 0) return 0;
        try
        {
            var timeout = IdleTimeout();
            if (timeout <= TimeSpan.Zero) return 0;
            var now = _time.GetUtcNow();
            var closed = 0;
            foreach (var (cid, entry) in _clients.ToArray())
            {
                if (_leases.GetValueOrDefault(cid) > 0 || now - entry.Client.LastUsed < timeout) continue;
                if (await RemoveAsync(cid, "closed", "idle").ConfigureAwait(false)) closed++;
            }
            return closed;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Closing idle source clients failed");
            return 0;
        }
        finally
        {
            Interlocked.Exchange(ref _reaping, 0);
        }
    }

    private async Task<bool> RemoveAsync(string connectionId, string state, string? reason)
    {
        if (!_clients.TryRemove(connectionId, out var entry)) return false;
        try
        {
            await entry.Client.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Disposing source client {ConnectionId} failed", connectionId);
        }
        _log.LogInformation("Source client {ConnectionId} {State} ({Reason})", connectionId, state, reason ?? "-");
        _events.Publish(new SourceClientChangedEvent(connectionId, state));
        try
        {
            ClientClosed?.Invoke(connectionId, state, reason);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "ClientClosed handler failed for {ConnectionId}", connectionId);
        }
        return true;
    }

    private static SourceClientInfo ToInfo(string connectionId, Entry e) =>
        new(connectionId, "open", e.Client.Server, e.OpenedAt, e.Client.LastUsed);

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _reaper.DisposeAsync().ConfigureAwait(false);
        foreach (var cid in _clients.Keys.ToArray()) await RemoveAsync(cid, "closed", "shutdown").ConfigureAwait(false);
    }
}
