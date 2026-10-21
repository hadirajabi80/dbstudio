using System.Collections.Concurrent;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Logs.Providers.Mongo;
using DbStudio.Logs.Providers.Redis;
using DbStudio.Logs.Sql;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Logs;

/// <summary>
/// Entry point of the logs package: resolves the connection (or <c>engine</c>), dispatches to the provider's keyed
/// <see cref="ILogSource"/> / <see cref="IActivitySource"/>, caches source lists for five minutes and maps driver errors.
/// </summary>
public sealed class LogService
{
    public static readonly TimeSpan ListTtl = TimeSpan.FromMinutes(5);

    private readonly Func<string, ILogSource?> _logSources;
    private readonly Func<string, IActivitySource?> _activitySources;
    private readonly Func<string, Core.Models.ConnectionProfile> _profiles;
    private readonly ConcurrentDictionary<string, (string Stamp, DateTimeOffset Expires, IReadOnlyList<LogSourceInfo> Sources)> _lists = new(StringComparer.Ordinal);

    public EngineLogSource Engine { get; }

    public LogService(Func<string, ILogSource?> logSources, Func<string, IActivitySource?> activitySources,
        Func<string, Core.Models.ConnectionProfile> profiles, EngineLogSource engine)
    {
        _logSources = logSources;
        _activitySources = activitySources;
        _profiles = profiles;
        Engine = engine;
    }

    public static LogService FromServices(IServiceProvider sp) => new(
        id => sp.GetKeyedService<ILogSource>(id),
        id => sp.GetKeyedService<IActivitySource>(id),
        id => sp.GetRequiredService<ConnectionStore>().Get(id),
        sp.GetRequiredService<EngineLogSource>());

    public static bool IsEngine(string cid) => string.Equals(cid, StreamManager.EngineConnectionId, StringComparison.Ordinal);

    /// <summary>404 for an unknown connection id; <c>engine</c> has no profile.</summary>
    public LogTarget Target(string cid) => IsEngine(cid) ? new LogTarget(StreamManager.EngineConnectionId, null) : new LogTarget(cid, _profiles(cid));

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(string cid, bool refresh, CancellationToken ct)
    {
        var target = Target(cid);
        if (target.Profile is null) return [EngineLogSource.Info];
        var source = _logSources(target.ProviderId);
        if (source is null) return []; // SQLite (and any provider without server logs): the UI shows the engine log only
        var stamp = JsonSerializer.Serialize(target.Profile, CoreJson.Options);
        if (!refresh && _lists.TryGetValue(cid, out var hit) && hit.Stamp == stamp && hit.Expires > DateTimeOffset.UtcNow) return hit.Sources;
        var list = await Guard(() => source.ListAsync(target, ct)).ConfigureAwait(false);
        _lists[cid] = (stamp, DateTimeOffset.UtcNow + ListTtl, list);
        return list;
    }

    /// <summary>Forgets a connection's cached list (after a privilege error the next list probes again).</summary>
    public void Invalidate(string cid) => _lists.TryRemove(cid, out _);

    public async Task<LogQueryResponse> QueryAsync(string cid, LogQuery? query, CancellationToken ct)
    {
        var q = LogFilter.Validate(query);
        var target = Target(cid);
        if (q.SourceId == EngineLogSource.SourceId) return await Engine.QueryAsync(q, ct).ConfigureAwait(false);
        var source = _logSources(target.ProviderId) ?? throw SqlSourceMissing(q.SourceId);
        try
        {
            return await Guard(() => source.QueryAsync(target, q, ct)).ConfigureAwait(false);
        }
        catch (EngineException ex) when (ex.Code == ErrorCodes.Privilege)
        {
            Invalidate(cid);
            throw;
        }
    }

    private static EngineException SqlSourceMissing(string? id) => EngineException.Validation($"Unknown log source '{id}'.", new { field = "sourceId" });

    /// <summary>A push feed for live-only sources (MONITOR, change streams), or null when the source is polled.</summary>
    public IAsyncEnumerable<LogEntry>? OpenLive(string cid, string sourceId, CancellationToken ct)
    {
        if (sourceId == EngineLogSource.SourceId) return null;
        var target = Target(cid);
        return _logSources(target.ProviderId)?.OpenLive(target, sourceId, ct);
    }

    /// <summary>The newest seq of a source (start cursor of a tail): only later entries are streamed.</summary>
    public async Task<long> NewestSeqAsync(string cid, string sourceId, CancellationToken ct)
    {
        if (sourceId == EngineLogSource.SourceId) return Engine.NewestSeq();
        var page = await QueryAsync(cid, new LogQuery(sourceId, Limit: 1), ct).ConfigureAwait(false);
        return page.Entries.Count > 0 ? page.Entries[^1].Seq : 0;
    }

    public IActivitySource Activity(LogTarget target) =>
        (target.Profile is null ? null : _activitySources(target.ProviderId))
        ?? throw EngineException.Validation($"Activity is not available for '{target.Name}'.", new { field = "connectionId" });

    public async Task<ActivitySnapshot> SnapshotAsync(string cid, CancellationToken ct)
    {
        var target = Target(cid);
        var source = Activity(target);
        var rows = await Guard(() => source.SnapshotAsync(target, ct)).ConfigureAwait(false);
        return new ActivitySnapshot(TimeSeq.Iso(DateTimeOffset.UtcNow), rows);
    }

    public async Task<LogKillResult> KillAsync(string cid, LogKillRequest? request, CancellationToken ct)
    {
        if (request is null) throw EngineException.Validation("A kill body is required.");
        if (string.IsNullOrWhiteSpace(request.Id)) throw EngineException.Validation("id is required.", new { field = "id" });
        if (request.Kind is not ("session" or "op" or "client"))
            throw EngineException.Validation("kind must be session, op or client (locks cannot be killed).", new { field = "kind" });
        var target = Target(cid);
        var source = Activity(target);
        if (target.ReadOnly) throw EngineException.ReadOnly(target.Name, "Kill");
        return await Guard(() => source.KillAsync(target, request with { Id = request.Id.Trim() }, ct)).ConfigureAwait(false);
    }

    /// <summary>Maps driver-level errors that escaped a source to engine errors.</summary>
    internal static async Task<T> Guard<T>(Func<Task<T>> call)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (SqlQueryException ex)
        {
            throw new EngineException(400, ErrorCodes.ProviderError, ex.Message, new { code = ex.Code });
        }
        catch (RedisReplyException ex)
        {
            throw ex.IsPermission ? EngineException.Privilege(ex.Message, null) : new EngineException(400, ErrorCodes.ProviderError, ex.Message);
        }
        catch (MongoCommandFailure ex)
        {
            throw ex.IsUnauthorized ? EngineException.Privilege(ex.Message, null) : new EngineException(400, ErrorCodes.ProviderError, ex.Message, new { code = ex.Code, codeName = ex.CodeName });
        }
        catch (Exception ex) when (ex is IOException or System.Net.Sockets.SocketException)
        {
            throw EngineException.SourceUnavailable(ex.Message);
        }
    }
}
