using System.Globalization;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.SqlServer;

/// <summary>
/// SQL Server (docs/PLAN-M2.md 8.1): <c>errorlog</c> (xp_readerrorlog, archives from sp_enumerrorlogs), <c>agentlog</c>,
/// <c>system_health</c> (XE ring buffer) and activity (sessions, requests, statement text, lock summary; KILL).
/// </summary>
public sealed class SqlServerLogSource(ISqlRunnerFactory runners) : ILogSource, IActivitySource
{
    public const string ErrorLog = "errorlog", AgentLog = "agentlog", SystemHealth = "system_health", Activity = "activity";

    public string ProviderId => "sqlserver";

    private readonly FactsCache<Facts> _facts = new();

    /// <summary>Probe result of one connection.</summary>
    public sealed record Facts(string Login, int Edition, int Major, bool Sysadmin, bool SecurityAdmin, bool ViewServerState,
        bool ViewAnyErrorLog, bool AlterAnyConnection, TimeSpan Offset, bool HasAgent)
    {
        public bool ErrorLogAllowed => Sysadmin || SecurityAdmin || ViewAnyErrorLog;
        public bool ServerStateAllowed => Sysadmin || ViewServerState;
        public bool IsAzureDb => Edition is 5 or 6 or 9;
        public string QuotedLogin => "[" + Login.Replace("]", "]]") + "]";
        public string ErrorLogNeeds => Major >= 16 ? $"GRANT VIEW ANY ERROR LOG TO {QuotedLogin};" : $"ALTER SERVER ROLE securityadmin ADD MEMBER {QuotedLogin};";
        public string ServerStateNeeds => $"GRANT VIEW SERVER STATE TO {QuotedLogin};";
        public string KillNeeds => $"GRANT ALTER ANY CONNECTION TO {QuotedLogin};";
    }

    /// <summary>SQL Server errors that mean "permission denied".</summary>
    public static readonly IReadOnlySet<string> PrivilegeCodes = new HashSet<string> { "229", "230", "262", "297", "300", "6102", "15003", "15247", "22004" };

    public static Facts ParseFacts(SqlRowSet probe)
    {
        var r = probe.Rows.FirstOrDefault() ?? throw EngineException.SourceUnavailable("The privilege probe returned no row.");
        var version = probe.Str(r, "product_version") ?? "";
        var major = int.TryParse(version.Split('.')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var m) ? m : 0;
        return new Facts(
            probe.Str(r, "login_name") ?? "",
            (int)(probe.Long(r, "engine_edition") ?? 0),
            major,
            probe.Bool(r, "is_sysadmin"),
            probe.Bool(r, "is_securityadmin"),
            probe.Bool(r, "view_server_state"),
            probe.Bool(r, "view_any_error_log"),
            probe.Bool(r, "alter_any_connection"),
            TimeSpan.FromMinutes(probe.Long(r, "utc_offset_minutes") ?? 0),
            probe.Bool(r, "has_agent"));
    }

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            var sets = await runner.QueryAsync(SqlServerLogSql.Probe, c).ConfigureAwait(false);
            return ParseFacts(sets[0]);
        }, ct);

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        _facts.Invalidate(target.ConnectionId); // a list is the explicit "probe again" moment
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var levels = LogLevels.Standard.Where(l => l != LogLevels.Debug).ToList();
        var errorlog = new LogSourceInfo(ErrorLog, "Error log", "log", true, true, levels, true);
        var agentlog = new LogSourceInfo(AgentLog, "SQL Agent log", "log", true, true, levels, true);
        var health = new LogSourceInfo(SystemHealth, "system_health (XE)", "log", true, true, levels, true);
        var activity = new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true);

        if (f.IsAzureDb)
        {
            const string why = "Azure SQL Database has no error log files; use the Azure portal (Diagnostic settings) instead.";
            errorlog = errorlog.Unavailable(why, null);
            agentlog = agentlog.Unavailable("Azure SQL Database has no SQL Agent.", null);
            health = health.Unavailable("The system_health session is not exposed on Azure SQL Database.", null);
        }
        else
        {
            if (!f.ErrorLogAllowed) errorlog = errorlog.Unavailable("Reading the error log requires the securityadmin role (VIEW ANY ERROR LOG on SQL Server 2022).", f.ErrorLogNeeds);
            if (!f.HasAgent || f.Edition == 4) agentlog = agentlog.Unavailable(f.Edition == 4 ? "SQL Server Express has no SQL Agent." : "SQL Agent is not installed.", null);
            else if (!f.ErrorLogAllowed) agentlog = agentlog.Unavailable("Reading the Agent log requires the securityadmin role.", f.ErrorLogNeeds);
            if (!f.ServerStateAllowed) health = health.Unavailable("Reading the system_health ring buffer requires VIEW SERVER STATE.", f.ServerStateNeeds);
        }
        if (!f.ServerStateAllowed)
            activity = activity with { Reason = "Without VIEW SERVER STATE only your own sessions are visible.", Needs = f.ServerStateNeeds };

        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        if (errorlog.Available) errorlog = errorlog with { Archives = await ArchivesAsync(runner, 1, f, ct).ConfigureAwait(false) };
        if (agentlog.Available) agentlog = agentlog with { Archives = await ArchivesAsync(runner, 2, f, ct).ConfigureAwait(false) };
        return [errorlog, agentlog, health, activity];
    }

    private static async Task<IReadOnlyList<LogArchiveInfo>?> ArchivesAsync(ISqlRunner runner, int logType, Facts f, CancellationToken ct)
    {
        try
        {
            var sets = await runner.QueryAsync(SqlServerLogSql.EnumErrorLogs(logType), ct).ConfigureAwait(false);
            return sets.Count > 0 ? SqlServerLogParser.ParseArchives(sets[0], f.Offset) : null;
        }
        catch (SqlQueryException)
        {
            return null;
        }
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var limit = LogFilter.LimitOf(query);
        var fetch = Math.Min(query.Levels is { Count: > 0 } ? limit * 4 : limit, 20_000);
        var (fromUtc, toUtc) = Range(query);
        switch (query.SourceId)
        {
            case ErrorLog or AgentLog:
            {
                if (f.IsAzureDb) throw EngineException.Validation("Azure SQL Database has no error log files.", new { field = "sourceId" });
                if (!f.ErrorLogAllowed) throw EngineException.Privilege("Reading the error log requires the securityadmin role.", f.ErrorLogNeeds);
                var logType = query.SourceId == AgentLog ? 2 : 1;
                var sql = SqlServerLogSql.ReadErrorLog(query.Archive ?? 0, logType, query.Q, ToServer(fromUtc, f.Offset), ToServer(toUtc, f.Offset), fetch + 1);
                var sets = await Run(runner, sql, f.ErrorLogNeeds, ct).ConfigureAwait(false);
                var rows = sets.Count > 0 ? sets[^1] : SqlRowSet.Of([]);
                return LogFilter.Page(SqlServerLogParser.ParseErrorLog(rows, logType, f.Offset), query, sourceHasMore: rows.Rows.Count > fetch);
            }
            case SystemHealth:
            {
                if (!f.ServerStateAllowed) throw EngineException.Privilege("Reading system_health requires VIEW SERVER STATE.", f.ServerStateNeeds);
                var sets = await Run(runner, SqlServerLogSql.SystemHealth(fromUtc, toUtc, query.Q, fetch + 1), f.ServerStateNeeds, ct).ConfigureAwait(false);
                var rows = sets.Count > 0 ? sets[^1] : SqlRowSet.Of([]);
                return LogFilter.Page(SqlServerLogParser.ParseSystemHealth(rows), query, sourceHasMore: rows.Rows.Count > fetch);
            }
            default:
                throw UnknownSource(query.SourceId);
        }
    }

    internal static EngineException UnknownSource(string? id) => EngineException.Validation($"Unknown log source '{id}'.", new { field = "sourceId" });

    /// <summary>UTC bounds of a query (before cursor applied); open ends become 1900 / 9999.</summary>
    public static (DateTime FromUtc, DateTime ToUtc) Range(LogQuery q)
    {
        var from = q.From?.UtcDateTime ?? new DateTime(1900, 1, 1);
        var to = q.To?.UtcDateTime ?? new DateTime(9999, 12, 30);
        if (q.Before is { } b)
        {
            var bt = TimeSeq.ToTime(b).UtcDateTime.AddMilliseconds(1);
            if (bt < to) to = bt;
        }
        if (q.After is { } a)
        {
            var at = TimeSeq.ToTime(a).UtcDateTime;
            if (at > from) from = at;
        }
        return (from, to);
    }

    private static DateTime ToServer(DateTime utc, TimeSpan offset) =>
        utc.Year <= 1900 || utc.Year >= 9999 ? utc : DateTime.SpecifyKind(utc + offset, DateTimeKind.Unspecified);

    private async Task<IReadOnlyList<SqlRowSet>> Run(ISqlRunner runner, string sql, string needs, CancellationToken ct)
    {
        try
        {
            return await runner.QueryAsync(sql, ct).ConfigureAwait(false);
        }
        catch (SqlQueryException ex) when (PrivilegeCodes.Contains(ex.Code))
        {
            throw EngineException.Privilege(ex.Message, needs);
        }
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var sets = await Run(runner, SqlServerLogSql.Activity, f.ServerStateNeeds, ct).ConfigureAwait(false);
        return ParseActivity(sets.Count > 0 ? sets[0] : SqlRowSet.Of([]), sets.Count > 1 ? sets[1] : null, f.Offset);
    }

    public static List<ActivityRow> ParseActivity(SqlRowSet sessions, SqlRowSet? locks, TimeSpan offset)
    {
        var lockCounts = new Dictionary<string, long>();
        if (locks is not null)
            foreach (var l in locks.Rows)
            {
                var sid = locks.Str(l, "session_id") ?? "";
                lockCounts[sid] = lockCounts.GetValueOrDefault(sid) + (locks.Long(l, "lock_count") ?? 0);
            }
        var rows = new List<ActivityRow>();
        var blockers = new Dictionary<string, string>();
        foreach (var r in sessions.Rows)
        {
            var id = sessions.Str(r, "session_id") ?? "";
            var blocked = sessions.Long(r, "blocking_session_id") is > 0 and var b ? b.ToString(CultureInfo.InvariantCulture) : null;
            if (blocked is not null) blockers[id] = blocked;
            var start = sessions.Time(r, "start_time", offset) ?? sessions.Time(r, "last_request_start_time", offset);
            var running = sessions.Value(r, "start_time") is not null;
            var fields = new Dictionary<string, string> { ["killStatement"] = $"KILL {id}" };
            if (sessions.Long(r, "open_transaction_count") is > 0 and var tx) fields["openTransactions"] = tx.ToString(CultureInfo.InvariantCulture);
            if (sessions.Long(r, "wait_time") is > 0 and var wt) fields["waitTimeMs"] = wt.ToString(CultureInfo.InvariantCulture);
            if (lockCounts.TryGetValue(id, out var lc)) fields["locks"] = lc.ToString(CultureInfo.InvariantCulture);
            if (sessions.Time(r, "login_time", offset) is { } login) fields["loginTime"] = SqlServerLogParser.Iso(login)!;
            rows.Add(new ActivityRow
            {
                Id = id,
                Kind = "session",
                User = sessions.Str(r, "login_name"),
                Host = sessions.Str(r, "host_name"),
                App = sessions.Str(r, "program_name"),
                Database = sessions.Str(r, "database_name"),
                State = sessions.Str(r, "status") ?? "unknown",
                Since = SqlServerLogParser.Iso(start),
                DurationMs = running ? sessions.Long(r, "total_elapsed_time") : null,
                WaitType = sessions.Str(r, "wait_type"),
                BlockedBy = blocked,
                Command = sessions.Str(r, "command"),
                Text = sessions.Str(r, "sql_text")?.Trim(),
                Cpu = sessions.Double(r, "cpu_time"),
                Reads = sessions.Double(r, "logical_reads"),
                CanKill = true,
                Fields = fields,
            });
        }
        if (locks is not null)
            foreach (var l in locks.Rows)
            {
                var sid = locks.Str(l, "session_id") ?? "";
                var status = locks.Str(l, "request_status") ?? "";
                var type = locks.Str(l, "resource_type") ?? "";
                var mode = locks.Str(l, "request_mode") ?? "";
                var db = locks.Str(l, "database_name");
                rows.Add(new ActivityRow
                {
                    Id = $"lock:{sid}:{type}:{mode}:{status}:{db}",
                    Kind = "lock",
                    Database = db,
                    State = status,
                    BlockedBy = status == "WAIT" ? blockers.GetValueOrDefault(sid) : null,
                    CanKill = false,
                    Fields = new Dictionary<string, string>
                    {
                        ["owner"] = sid, ["resource"] = type, ["mode"] = mode,
                        ["count"] = (locks.Long(l, "lock_count") ?? 0).ToString(CultureInfo.InvariantCulture),
                    },
                });
            }
        return rows;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        if (!int.TryParse(request.Id, NumberStyles.None, CultureInfo.InvariantCulture, out var spid) || spid is < 1 or > 32767)
            throw EngineException.Validation("id must be a session id (1–32767).", new { field = "id" });
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        try
        {
            await runner.QueryAsync(SqlServerLogSql.Kill(spid), ct).ConfigureAwait(false);
            return new LogKillResult(true, $"Session {spid} was killed.");
        }
        catch (SqlQueryException ex) when (PrivilegeCodes.Contains(ex.Code))
        {
            throw EngineException.Privilege(ex.Message, f.KillNeeds);
        }
        catch (SqlQueryException ex) when (ex.Code is "6106" or "6104" or "6107")
        {
            return new LogKillResult(false, ex.Message);
        }
    }
}
