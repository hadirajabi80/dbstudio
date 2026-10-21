using DbStudio.Core.Models;

namespace DbStudio.Logs;

/// <summary>The connection a log or activity call is about (<see cref="Profile"/> is null for the engine log).</summary>
public sealed record LogTarget(string ConnectionId, ConnectionProfile? Profile)
{
    public string ProviderId => Profile?.ProviderId ?? "engine";
    public bool ReadOnly => Profile?.ReadOnly ?? false;
    public string Name => Profile?.Name ?? "Engine";
}

/// <summary>
/// The log sources of one provider family (docs/PLAN-M2.md 8.1), registered as a keyed singleton by provider id
/// (<c>AddKeyedSingleton&lt;ILogSource&gt;("sqlserver", …)</c>). One instance serves every connection of the provider
/// and every source id it lists ("errorlog", "agentlog", "system_health"…).
/// </summary>
public interface ILogSource
{
    string ProviderId { get; }

    /// <summary>
    /// Lists the sources of a connection, probing privileges with one cheap call (the caller caches the answer for five
    /// minutes). Denied sources come back with <c>available:false</c> and <c>needs</c>; the activity entry (kind
    /// "activity", id "activity") is included when the provider has an <see cref="IActivitySource"/>.
    /// </summary>
    Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct);

    /// <summary>
    /// Range query. Entries are returned ascending by seq (the newest <c>limit</c> matching ones). Throws
    /// <c>EngineException.Privilege</c> (403, <c>detail.needs</c>) when the server denies the source, VALIDATION for an
    /// unknown source id.
    /// </summary>
    Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct);

    /// <summary>
    /// Push-only sources (Redis MONITOR, Mongo change streams): an endless feed of entries, or null when the source is
    /// polled through <see cref="QueryAsync"/> with an <c>after</c> cursor.
    /// </summary>
    IAsyncEnumerable<LogEntry>? OpenLive(LogTarget target, string sourceId, CancellationToken ct) => null;
}

/// <summary>Sessions, running operations and locks of one provider family, with Kill.</summary>
public interface IActivitySource
{
    string ProviderId { get; }

    Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct);

    /// <summary>
    /// Kills a session / operation / client. The caller has already refused read-only connections (READ_ONLY);
    /// implementations validate <c>id</c> (VALIDATION naming the field) and map denials to PRIVILEGE.
    /// </summary>
    Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct);
}
