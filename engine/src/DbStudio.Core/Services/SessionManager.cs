using System.Collections.Concurrent;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Services;

/// <summary>Wire shape of a session (ui/src/api/types.ts SessionInfo).</summary>
public sealed record SessionInfo(
    string SessionId,
    string ConnectionId,
    ServerInfo ServerInfo,
    string? Database,
    TransactionMode TxMode,
    bool TxOpen,
    SessionState State,
    Dialect Dialect);

/// <summary>A tab session: the provider session plus engine bookkeeping (busy flag, reopen data).</summary>
public sealed class SessionHandle
{
    private int _busy;

    internal SessionHandle(string id, ConnectionProfile profile, IDbProvider provider, IDbSession session, SessionOptions options)
    {
        Id = id;
        Profile = profile;
        Provider = provider;
        Session = session;
        Options = options;
    }

    public string Id { get; }
    public ConnectionProfile Profile { get; internal set; }
    public IDbProvider Provider { get; }
    public IDbSession Session { get; internal set; }
    public SessionOptions Options { get; internal set; }
    public Dialect Dialect => Provider.Dialect;
    public DateTimeOffset LastActivity { get; internal set; } = DateTimeOffset.UtcNow;

    /// <summary>Id of the execution or export currently using the session, else null.</summary>
    public string? ActiveOperation { get; private set; }

    /// <summary>Reserves the session for one execution/export. Returns false when already reserved.</summary>
    public bool TryReserve(string operationId)
    {
        if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0) return false;
        if (Session.State == SessionState.Executing)
        {
            Interlocked.Exchange(ref _busy, 0);
            return false;
        }
        ActiveOperation = operationId;
        return true;
    }

    public void Release()
    {
        ActiveOperation = null;
        LastActivity = DateTimeOffset.UtcNow;
        Interlocked.Exchange(ref _busy, 0);
    }

    public bool IsReserved => Volatile.Read(ref _busy) != 0;

    public SessionInfo ToInfo() => new(
        Id, Profile.Id, Session.Server, Session.CurrentDatabase, Session.TxMode, Session.TxOpen,
        IsReserved && Session.State == SessionState.Idle ? SessionState.Executing : Session.State, Dialect);
}

/// <summary>
/// Owns all tab sessions (docs/PLAN.md 2.3): one physical connection each, idle ping every 60 s, transparent reopen
/// of broken sessions when no transaction was open, rollback on close.
/// </summary>
public sealed class SessionManager : IAsyncDisposable
{
    private readonly ProviderRegistry _providers;
    private readonly ConnectionStore _connections;
    private readonly IEventPublisher _events;
    private readonly ResultStore _results;
    private readonly ILogger _log;
    private readonly ConcurrentDictionary<string, SessionHandle> _sessions = new(StringComparer.Ordinal);
    private readonly Timer _pingTimer;
    private int _pinging;

    public SessionManager(ProviderRegistry providers, ConnectionStore connections, IEventPublisher events, ResultStore results,
        ILogger<SessionManager>? log = null, TimeSpan? pingInterval = null)
    {
        _providers = providers;
        _connections = connections;
        _events = events;
        _results = results;
        _log = log ?? (ILogger)NullLogger.Instance;
        var interval = pingInterval ?? TimeSpan.FromSeconds(60);
        _pingTimer = new Timer(_ => _ = PingIdleAsync(), null, interval, interval);
    }

    public async Task<SessionHandle> CreateAsync(string connectionId, string? database, TransactionMode txMode, bool captureServerOutput, CancellationToken ct)
    {
        var profile = _connections.Get(connectionId);
        var provider = _providers.Get(profile.ProviderId);
        var id = Ids.New("s");
        var options = new SessionOptions(id, string.IsNullOrWhiteSpace(database) ? null : database, txMode, captureServerOutput);
        var session = await provider.OpenSessionAsync(profile, _connections.GetPassword(connectionId), options, ct).ConfigureAwait(false);
        var handle = new SessionHandle(id, profile, provider, session, options);
        _sessions[id] = handle;
        _connections.Touch(connectionId);
        _log.LogInformation("Session {SessionId} opened on {ConnectionId} ({Provider})", id, connectionId, provider.Id);
        return handle;
    }

    public SessionHandle Get(string sessionId) =>
        _sessions.TryGetValue(sessionId, out var h) ? h : throw EngineException.NotFound($"Session '{sessionId}'");

    public IReadOnlyList<SessionHandle> List() => _sessions.Values.OrderBy(s => s.Id, StringComparer.Ordinal).ToList();

    public void PublishChanged(SessionHandle h)
    {
        var info = h.ToInfo();
        _events.Publish(new SessionChangedEvent(info.SessionId, info.State, info.TxOpen, info.Database, info.TxMode));
    }

    /// <summary>Closes a session. With an open transaction requires <paramref name="force"/> (rolls back).</summary>
    public async Task CloseAsync(string sessionId, bool force)
    {
        var h = Get(sessionId);
        if (h.Session.TxOpen && !force)
            throw new EngineException(409, ErrorCodes.TxOpen, "The session has an open transaction. Commit, roll back or close with force=true.");
        if (!_sessions.TryRemove(sessionId, out _)) return;
        h.Session.Cancel();
        try
        {
            await h.Session.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Error closing session {SessionId}", sessionId);
        }
        _results.ReleaseSession(sessionId);
        _events.Publish(new SessionChangedEvent(sessionId, SessionState.Closed, false, h.Session.CurrentDatabase, h.Session.TxMode));
    }

    /// <summary>Closes every session of a connection (profile deleted).</summary>
    public async Task CloseAllForConnectionAsync(string connectionId)
    {
        foreach (var h in _sessions.Values.Where(s => s.Profile.Id == connectionId).ToList())
            await CloseAsync(h.Id, force: true).ConfigureAwait(false);
    }

    /// <summary>
    /// Reopens a broken session in place when no transaction was open. Returns a message for the user when it did,
    /// throws SESSION_BROKEN when the transaction was lost or reconnecting failed.
    /// </summary>
    public async Task<string?> EnsureUsableAsync(SessionHandle h, CancellationToken ct)
    {
        if (h.Session.State != SessionState.Broken) return null;
        var hadTx = h.Session.TxOpen;
        var old = h.Session;
        try { await old.DisposeAsync().ConfigureAwait(false); } catch { /* already broken */ }
        IDbSession fresh;
        try
        {
            var profile = _connections.Find(h.Profile.Id) ?? h.Profile;
            var options = h.Options with { Database = old.CurrentDatabase ?? h.Options.Database, TxMode = old.TxMode };
            fresh = await h.Provider.OpenSessionAsync(profile, _connections.GetPassword(profile.Id), options, ct).ConfigureAwait(false);
            h.Profile = profile;
            h.Options = options;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new EngineException(409, ErrorCodes.SessionBroken, $"The connection was lost and could not be reopened: {ex.Message}");
        }
        h.Session = fresh;
        PublishChanged(h);
        if (hadTx)
            throw new EngineException(409, ErrorCodes.SessionBroken, "The connection was lost; the open transaction was rolled back by the server. The session has been reconnected.");
        return "The connection was lost and has been reopened.";
    }

    private async Task PingIdleAsync()
    {
        if (Interlocked.Exchange(ref _pinging, 1) == 1) return;
        try
        {
            foreach (var h in _sessions.Values)
            {
                if (h.IsReserved || h.Session.State != SessionState.Idle) continue;
                if (DateTimeOffset.UtcNow - h.LastActivity < TimeSpan.FromSeconds(30)) continue;
                if (!h.TryReserve("ping")) continue;
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                bool ok;
                try { ok = await h.Session.PingAsync(cts.Token).ConfigureAwait(false); }
                catch { ok = false; }
                finally { h.Release(); }
                if (!ok && h.Session.State == SessionState.Broken)
                {
                    _log.LogWarning("Session {SessionId} is broken", h.Id);
                    PublishChanged(h);
                }
            }
        }
        finally
        {
            Interlocked.Exchange(ref _pinging, 0);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _pingTimer.DisposeAsync().ConfigureAwait(false);
        foreach (var h in _sessions.Values.ToList())
        {
            _sessions.TryRemove(h.Id, out _);
            try { await h.Session.DisposeAsync().ConfigureAwait(false); } catch { /* shutting down */ }
        }
    }
}
