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
    Dialect Dialect,
    string? ExecutingSince = null,
    string? TabId = null,
    string? Label = null,
    bool Orphan = false);

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
        ExecutingSince = null;
        LastActivity = DateTimeOffset.UtcNow;
        Interlocked.Exchange(ref _busy, 0);
    }

    public bool IsReserved => Volatile.Read(ref _busy) != 0;

    /// <summary>M1.5: start of the running execution (set by ExecutionService), null when idle.</summary>
    public DateTimeOffset? ExecutingSince { get; internal set; }

    /// <summary>M1.5: tab id and title from the last ExecuteRequest.source.</summary>
    public string? TabId { get; internal set; }
    public string? Label { get; internal set; }

    /// <summary>B1 (logic-08): the UI client that created the session or touched it last; null for API callers without one.</summary>
    public string? OwnerClientId { get; internal set; }

    internal ClientPresence? Presence { get; set; }

    /// <summary>True when the session has an owner client and that client has no live WebSocket.</summary>
    public bool Orphan => OwnerClientId is { } owner && Presence is { } presence && !presence.IsLive(owner);

    /// <summary>Running an execution or export (not the idle ping).</summary>
    public bool IsRunning => IsReserved && ActiveOperation is not "ping";

    /// <summary>"Console 1" (the tab title of the last execution), else the session id.</summary>
    public string DisplayName => string.IsNullOrWhiteSpace(Label) ? $"Session {Id}" : Label!;

    public SessionInfo ToInfo()
    {
        var executing = IsRunning;
        return new SessionInfo(
            Id, Profile.Id, Session.Server, Session.CurrentDatabase, Session.TxMode, Session.TxOpen,
            IsReserved && Session.State == SessionState.Idle ? SessionState.Executing : Session.State, Dialect,
            executing ? ExecutingSince?.ToString("O") : null, TabId, Label, Orphan);
    }
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
    private readonly SettingsService? _settings;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _createGates = new(StringComparer.Ordinal);
    private readonly ClientPresence? _presence;
    private readonly TimeSpan? _orphanGraceOverride;
    private readonly CancellationTokenSource _disposing = new();
    private int _pinging;

    /// <summary>Default of settings connections.maxSessionsPerProfile.</summary>
    public const int DefaultMaxSessionsPerProfile = 8;

    /// <summary>Default of settings connections.orphanGraceSeconds.</summary>
    public const int DefaultOrphanGraceSeconds = 90;

    /// <param name="presence">Live UI clients (WebSocket hub); without it sessions are never treated as orphaned.</param>
    /// <param name="orphanGrace">Tests: overrides settings connections.orphanGraceSeconds.</param>
    public SessionManager(ProviderRegistry providers, ConnectionStore connections, IEventPublisher events, ResultStore results,
        ILogger<SessionManager>? log = null, TimeSpan? pingInterval = null, SettingsService? settings = null,
        ClientPresence? presence = null, TimeSpan? orphanGrace = null)
    {
        _settings = settings;
        _providers = providers;
        _connections = connections;
        _events = events;
        _results = results;
        _log = log ?? (ILogger)NullLogger.Instance;
        _presence = presence;
        _orphanGraceOverride = orphanGrace;
        if (_presence is not null) _presence.ClientGone += OnClientGone;
        var interval = pingInterval ?? TimeSpan.FromSeconds(60);
        _pingTimer = new Timer(_ => _ = PingIdleAsync(), null, interval, interval);
    }

    public async Task<SessionHandle> CreateAsync(string connectionId, string? database, TransactionMode txMode, bool captureServerOutput, CancellationToken ct) =>
        await CreateAsync(connectionId, database, txMode, captureServerOutput, null, ct).ConfigureAwait(false);

    /// <param name="clientId">The UI client creating the session (its owner, see <see cref="SessionHandle.OwnerClientId"/>).</param>
    public async Task<SessionHandle> CreateAsync(string connectionId, string? database, TransactionMode txMode, bool captureServerOutput,
        string? clientId, CancellationToken ct)
    {
        var profile = _connections.Get(connectionId);
        var provider = _providers.Get(profile.ProviderId);
        var id = Ids.New("s");
        var options = new SessionOptions(id, string.IsNullOrWhiteSpace(database) ? null : database, txMode, captureServerOutput);

        // M1.5: per-profile session limit (429 SESSION_LIMIT). A per-profile gate makes count + add atomic.
        var gate = _createGates.GetOrAdd(connectionId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        SessionHandle handle;
        try
        {
            var limit = MaxSessionsPerProfile();
            var open = _sessions.Values.Count(s => s.Profile.Id == connectionId);
            if (limit > 0 && open >= limit)
                throw new EngineException(429, "SESSION_LIMIT",
                    $"The connection '{profile.Name}' already has {open} open sessions (limit {limit}). Close idle tabs or raise the limit in Settings.",
                    new { connectionId, limit, open });
            var session = await provider.OpenSessionAsync(profile, _connections.GetPassword(connectionId), options, ct).ConfigureAwait(false);
            handle = new SessionHandle(id, profile, provider, session, options)
            {
                Presence = _presence,
                OwnerClientId = ClientPresence.Normalize(clientId),
            };
            _sessions[id] = handle;
        }
        finally
        {
            gate.Release();
        }
        _connections.Touch(connectionId);
        _log.LogInformation("Session {SessionId} opened on {ConnectionId} ({Provider})", id, connectionId, provider.Id);
        return handle;
    }

    /// <summary>settings connections.maxSessionsPerProfile (0 = unlimited).</summary>
    public int MaxSessionsPerProfile()
    {
        if (_settings is null) return DefaultMaxSessionsPerProfile;
        var node = _settings.Get()["connections"]?["maxSessionsPerProfile"];
        return node is null ? DefaultMaxSessionsPerProfile : (int)Math.Clamp(SettingsService.Number(node), 0, 10_000);
    }

    /// <summary>settings connections.orphanGraceSeconds: how long a session survives its owner client's disconnect (0 = forever).</summary>
    public TimeSpan OrphanGrace()
    {
        if (_orphanGraceOverride is { } fixedGrace) return fixedGrace;
        var node = _settings?.Get()["connections"]?["orphanGraceSeconds"];
        var seconds = node is null ? DefaultOrphanGraceSeconds : Math.Clamp(SettingsService.Number(node), 0, 86_400);
        return TimeSpan.FromSeconds(seconds);
    }

    /// <summary>Makes <paramref name="clientId"/> the owner of the session (the UI client that touched it last).</summary>
    public void Claim(SessionHandle h, string? clientId)
    {
        if (ClientPresence.Normalize(clientId) is { } id) h.OwnerClientId = id;
    }

    /// <summary>
    /// Sessions that may hold the lock another statement gave up waiting for: other sessions of the same connection (or of
    /// another profile on the same database file) with an open transaction or a running statement, as
    /// "Console 1 (open transaction)".
    /// <para>
    /// Tab titles repeat across windows ("Console 1" in each), so a holder that is not one of the requesting client's own
    /// sessions is qualified (design-r1-06): "Console 1 from an earlier window" when its owner client is gone (an
    /// orphan kept for the grace period), "Console 1 in another window" when another live client owns it. The plain
    /// name is kept for the requester's own sessions, and for every live holder when the requester is unknown.
    /// </para>
    /// </summary>
    /// <param name="requestingClientId">The UI client whose statement waited (the running session's owner).</param>
    public IReadOnlyList<string> DescribeLockHolders(ConnectionProfile profile, string? exceptSessionId, string? requestingClientId = null)
    {
        var requester = ClientPresence.Normalize(requestingClientId);
        var result = new List<string>();
        foreach (var s in List())
        {
            if (s.Id == exceptSessionId || !SameTarget(s.Profile, profile)) continue;
            var state = s.Session.TxOpen ? "open transaction" : s.IsRunning ? "running" : null;
            if (state is null) continue;
            var own = requester is not null && string.Equals(s.OwnerClientId, requester, StringComparison.Ordinal);
            var window = own ? ""
                : s.Orphan ? " from an earlier window"
                : requester is not null && s.OwnerClientId is not null ? " in another window"
                : "";
            var where = s.Profile.Id == profile.Id ? "" : $" on {s.Profile.Name}";
            result.Add($"{s.DisplayName}{window}{where} ({state})");
        }
        return result;
    }

    /// <summary>Same connection, or another profile of the same provider pointing at the same database file.</summary>
    private static bool SameTarget(ConnectionProfile a, ConnectionProfile b)
    {
        if (a.Id == b.Id) return true;
        if (!a.ProviderId.Equals(b.ProviderId, StringComparison.OrdinalIgnoreCase)) return false;
        var pa = a.GetString("path")?.Trim().Trim('"');
        var pb = b.GetString("path")?.Trim().Trim('"');
        if (string.IsNullOrEmpty(pa) || string.IsNullOrEmpty(pb)) return false;
        try { return string.Equals(Path.GetFullPath(pa), Path.GetFullPath(pb), StringComparison.OrdinalIgnoreCase); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }

    /// <summary>
    /// logic-21: deleting a connection closes its sessions; with open transactions that requires
    /// <paramref name="force"/>, else 409 TX_OPEN listing them.
    /// </summary>
    public void EnsureNoOpenTransactions(string connectionId, bool force)
    {
        if (force) return;
        var open = List().Where(s => s.Profile.Id == connectionId && s.Session.TxOpen).ToList();
        if (open.Count == 0) return;
        var names = string.Join(", ", open.Select(s => s.DisplayName));
        throw new EngineException(409, ErrorCodes.TxOpen,
            $"{open.Count} session(s) of this connection have an open transaction ({names}). Commit or roll back first, or delete with force=true to roll them back.",
            new { sessions = open.Select(s => new { sessionId = s.Id, label = s.Label, tabId = s.TabId }).ToList() });
    }

    private void OnClientGone(string clientId)
    {
        var grace = OrphanGrace();
        if (grace <= TimeSpan.Zero || _disposing.IsCancellationRequested) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(grace + TimeSpan.FromMilliseconds(50), _disposing.Token).ConfigureAwait(false);
                await CloseOrphansAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // shutting down
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Closing orphaned sessions of client {ClientId} failed", clientId);
            }
        });
    }

    /// <summary>
    /// logic-08: closes (rolling back) every session whose owner client has been disconnected for longer than
    /// <see cref="OrphanGrace"/>. Runs after each client disconnect (delayed by the grace period) and with the idle ping.
    /// Returns the number of sessions closed.
    /// </summary>
    public async Task<int> CloseOrphansAsync()
    {
        var grace = OrphanGrace();
        if (_presence is null || grace <= TimeSpan.Zero) return 0;
        var closed = 0;
        foreach (var h in List())
        {
            if (h.OwnerClientId is not { } owner || _presence.IsLive(owner)) continue;
            if (_presence.GoneSince(owner) is not { } gone || _presence.Now - gone < grace) continue;
            if (h.Session.TxOpen)
                _log.LogWarning("Closing session {SessionId} ({Label}): its client {ClientId} disconnected {Seconds:0} s ago; rolling back its open transaction",
                    h.Id, h.DisplayName, owner, (_presence.Now - gone).TotalSeconds);
            else
                _log.LogInformation("Closing session {SessionId}: its client {ClientId} disconnected", h.Id, owner);
            try
            {
                await CloseAsync(h.Id, force: true).ConfigureAwait(false);
                closed++;
            }
            catch (EngineException)
            {
                // already closed
            }
        }
        return closed;
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
        // TxOpen is already false when the break was detected mid-execution: LostTransaction remembers it.
        var hadTx = h.Session.TxOpen || h.Session.LostTransaction;
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
            try { await CloseOrphansAsync().ConfigureAwait(false); }
            catch (Exception ex) { _log.LogWarning(ex, "Closing orphaned sessions failed"); }
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
        if (_presence is not null) _presence.ClientGone -= OnClientGone;
        try { await _disposing.CancelAsync().ConfigureAwait(false); } catch (ObjectDisposedException) { /* disposed twice */ }
        await _pingTimer.DisposeAsync().ConfigureAwait(false);
        foreach (var h in _sessions.Values.ToList())
        {
            _sessions.TryRemove(h.Id, out _);
            try { await h.Session.DisposeAsync().ConfigureAwait(false); } catch { /* shutting down */ }
        }
    }
}
