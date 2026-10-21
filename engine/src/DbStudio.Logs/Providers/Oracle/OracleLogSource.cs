using System.Globalization;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.Oracle;

/// <summary>The SQL of the Oracle log and activity sources (golden-tested).</summary>
public static class OracleLogSql
{
    /// <summary>User, version, privileges and roles in one round trip (k = kind, v = value).</summary>
    public const string Probe = """
        SELECT 'user' AS k, USER AS v FROM dual
        UNION ALL SELECT 'version', version FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1
        UNION ALL SELECT 'sid', SYS_CONTEXT('USERENV', 'SID') FROM dual
        UNION ALL SELECT 'priv', privilege FROM session_privs WHERE privilege IN ('SELECT ANY DICTIONARY', 'ALTER SYSTEM', 'AUDIT SYSTEM')
        UNION ALL SELECT 'role', role FROM session_roles WHERE role IN ('DBA', 'SELECT_CATALOG_ROLE', 'AUDIT_VIEWER', 'AUDIT_ADMIN')
        UNION ALL SELECT 'tab', table_name FROM all_tab_privs WHERE grantee IN (USER, 'PUBLIC') AND privilege IN ('SELECT', 'READ')
            AND table_name IN ('V_$DIAG_ALERT_EXT', 'V_$SESSION', 'V_$SQL', 'UNIFIED_AUDIT_TRAIL')
        """;

    /// <summary>Alert log (12c+): newest first, record_id is the seq.</summary>
    public static string Alert(DateTime fromUtc, DateTime toUtc, IReadOnlyCollection<string>? levels, string? search, long? beforeRecord, long? afterRecord, int top)
    {
        var where = new List<string>
        {
            "component_id = 'rdbms'",
            $"originating_timestamp >= FROM_TZ(TIMESTAMP '{Ts(fromUtc)}', 'UTC')",
            $"originating_timestamp <= FROM_TZ(TIMESTAMP '{Ts(toUtc)}', 'UTC')",
        };
        if (LevelsSql(levels) is { } l) where.Add(l);
        if (search is not null) where.Add($"UPPER(message_text) LIKE UPPER({SqlText.String(SqlText.LikeContains(search))}) ESCAPE '\\'");
        if (beforeRecord is { } b) where.Add($"record_id < {SqlText.Int(b)}");
        if (afterRecord is { } a) where.Add($"record_id > {SqlText.Int(a)}");
        return "SELECT record_id, originating_timestamp, message_level, message_type, module_id, process_id, host_id, message_text\n"
            + "FROM v$diag_alert_ext\nWHERE " + string.Join("\n  AND ", where)
            + $"\nORDER BY {(afterRecord is null ? "record_id DESC" : "record_id")}\nFETCH FIRST {top} ROWS ONLY";
    }

    /// <summary>message_level filter: error → 1, warn → 2, info → 8/16 (and anything above 2).</summary>
    public static string? LevelsSql(IReadOnlyCollection<string>? levels)
    {
        if (levels is null || levels.Count == 0) return null;
        var parts = new List<string>();
        if (levels.Contains(LogLevels.Error) || levels.Contains(LogLevels.Fatal)) parts.Add("message_level = 1");
        if (levels.Contains(LogLevels.Warn)) parts.Add("message_level = 2");
        if (levels.Contains(LogLevels.Info) || levels.Contains(LogLevels.Debug)) parts.Add("message_level > 2");
        return parts.Count == 0 ? "1 = 0" : "(" + string.Join(" OR ", parts) + ")";
    }

    public static string Audit(DateTime fromUtc, DateTime toUtc, string? search, int top)
    {
        var like = search is null ? "" : $"\n  AND (UPPER(sql_text) LIKE UPPER({SqlText.String(SqlText.LikeContains(search))}) ESCAPE '\\' OR UPPER(action_name) LIKE UPPER({SqlText.String(SqlText.LikeContains(search))}) ESCAPE '\\')";
        return "SELECT event_timestamp_utc, dbusername, os_username, userhost, client_program_name, action_name, object_schema, object_name, return_code, unified_audit_policies, sql_text\n"
            + "FROM unified_audit_trail\n"
            + $"WHERE event_timestamp_utc >= TIMESTAMP '{Ts(fromUtc)}' AND event_timestamp_utc <= TIMESTAMP '{Ts(toUtc)}'{like}\n"
            + $"ORDER BY event_timestamp_utc DESC\nFETCH FIRST {top} ROWS ONLY";
    }

    public const string Activity = """
        SELECT s.sid, s.serial#, s.username, s.osuser, s.machine, s.program, s.module, s.status, s.schemaname,
            s.logon_time, s.last_call_et, s.sql_exec_start, s.event, s.wait_class, s.seconds_in_wait, s.blocking_session, s.blocking_instance,
            s.sql_id, s.command, q.sql_text, q.cpu_time, q.buffer_gets
        FROM v$session s
        LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number
        WHERE s.type = 'USER' AND s.sid <> SYS_CONTEXT('USERENV', 'SID')
        ORDER BY CASE s.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et DESC
        FETCH FIRST 500 ROWS ONLY
        """;

    public static string Kill(int sid, int serial) => $"ALTER SYSTEM KILL SESSION '{sid},{serial}' IMMEDIATE";

    private static string Ts(DateTime t) => t.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
}

/// <summary>
/// Oracle (docs/PLAN-M2.md 8.1): <c>alert</c> (V$DIAG_ALERT_EXT, 12c+), <c>audit</c> (UNIFIED_AUDIT_TRAIL when granted),
/// activity (V$SESSION + V$SQL, blocking via BLOCKING_SESSION; ALTER SYSTEM KILL SESSION).
/// </summary>
public sealed class OracleLogSource(ISqlRunnerFactory runners) : ILogSource, IActivitySource
{
    public const string Alert = "alert", Audit = "audit", Activity = "activity";

    public string ProviderId => "oracle";

    private readonly FactsCache<Facts> _facts = new();

    public sealed record Facts(string User, int Major, string? Sid, IReadOnlySet<string> Privs, IReadOnlySet<string> Roles, IReadOnlySet<string> Tables)
    {
        public bool Dictionary => Privs.Contains("SELECT ANY DICTIONARY") || Roles.Contains("DBA") || Roles.Contains("SELECT_CATALOG_ROLE");
        public bool AlertAllowed => Dictionary || Tables.Contains("V_$DIAG_ALERT_EXT");
        public bool SessionsAllowed => Dictionary || Tables.Contains("V_$SESSION");
        public bool AuditAllowed => Roles.Contains("AUDIT_VIEWER") || Roles.Contains("AUDIT_ADMIN") || Roles.Contains("DBA") || Tables.Contains("UNIFIED_AUDIT_TRAIL");
        public bool AlterSystem => Privs.Contains("ALTER SYSTEM") || Roles.Contains("DBA");
        public string Quoted => "\"" + User.Replace("\"", "\"\"") + "\"";
        public string AlertNeeds => $"GRANT SELECT ON V_$DIAG_ALERT_EXT TO {Quoted};";
        public string SessionNeeds => $"GRANT SELECT ON V_$SESSION TO {Quoted}; GRANT SELECT ON V_$SQL TO {Quoted};";
        public string AuditNeeds => $"GRANT AUDIT_VIEWER TO {Quoted};";
        public string KillNeeds => $"GRANT ALTER SYSTEM TO {Quoted};";
    }

    /// <summary>ORA-00942 (table or view does not exist: no grant on a V$ view), ORA-01031 (insufficient privileges).</summary>
    public static bool IsPrivilegeError(SqlQueryException ex) =>
        ex.Code.Contains("00942", StringComparison.Ordinal) || ex.Code.Contains("01031", StringComparison.Ordinal) || ex.ProviderCode is 942 or 1031;

    public static Facts ParseFacts(SqlRowSet probe)
    {
        string user = "", version = "";
        string? sid = null;
        var privs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var roles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in probe.Rows)
        {
            var v = probe.Str(r, "v") ?? "";
            switch (probe.Str(r, "k")?.ToLowerInvariant())
            {
                case "user": user = v; break;
                case "version": version = v; break;
                case "sid": sid = v; break;
                case "priv": privs.Add(v); break;
                case "role": roles.Add(v); break;
                case "tab": tables.Add(v); break;
            }
        }
        var major = int.TryParse(version.Split('.')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var m) ? m : 0;
        return new Facts(user, major, sid, privs, roles, tables);
    }

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            return ParseFacts((await runner.QueryAsync(OracleLogSql.Probe, c).ConfigureAwait(false))[0]);
        }, ct);

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        _facts.Invalidate(target.ConnectionId);
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var levels = new List<string> { LogLevels.Info, LogLevels.Warn, LogLevels.Error };
        var alert = new LogSourceInfo(Alert, "Alert log", "log", true, true, levels, true);
        if (f.Major is > 0 and < 12)
            alert = alert.Unavailable("Oracle 11g exposes the alert log only through X$DBGALERTEXT, which only SYS can read.", null);
        else if (!f.AlertAllowed)
            alert = alert.Unavailable("Reading the alert log requires SELECT on V_$DIAG_ALERT_EXT (or SELECT ANY DICTIONARY).", f.AlertNeeds);
        var audit = new LogSourceInfo(Audit, "Unified audit trail", "log", true, true, [LogLevels.Info, LogLevels.Warn], true);
        if (!f.AuditAllowed) audit = audit.Unavailable("Reading UNIFIED_AUDIT_TRAIL requires the AUDIT_VIEWER role.", f.AuditNeeds);
        var activity = new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true);
        if (!f.SessionsAllowed) activity = activity.Unavailable("Reading sessions requires SELECT on V_$SESSION and V_$SQL.", f.SessionNeeds);
        return [alert, audit, activity];
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var limit = LogFilter.LimitOf(query);
        var (fromUtc, toUtc) = (query.From?.UtcDateTime ?? new DateTime(1970, 1, 1), query.To?.UtcDateTime ?? new DateTime(9999, 12, 30));
        switch (query.SourceId)
        {
            case Alert:
            {
                if (!f.AlertAllowed) throw EngineException.Privilege("Reading the alert log requires SELECT on V_$DIAG_ALERT_EXT.", f.AlertNeeds);
                var sql = OracleLogSql.Alert(fromUtc, toUtc, query.Levels, query.Q, query.Before, query.After, limit + 1);
                var rows = await Run(runner, sql, f.AlertNeeds, ct).ConfigureAwait(false);
                var entries = ParseAlert(rows);
                // record_id is the seq, so the cursors were applied server-side; Page sorts and trims.
                return LogFilter.Page(entries, query with { From = null, To = null, Q = null }, sourceHasMore: rows.Rows.Count > limit);
            }
            case Audit:
            {
                if (!f.AuditAllowed) throw EngineException.Privilege("Reading the unified audit trail requires AUDIT_VIEWER.", f.AuditNeeds);
                var (from, to) = SqlServer.SqlServerLogSource.Range(query);
                var rows = await Run(runner, OracleLogSql.Audit(from.Year <= 1900 ? fromUtc : from, to, query.Q, limit + 1), f.AuditNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseAudit(rows), query, sourceHasMore: rows.Rows.Count > limit);
            }
            default:
                throw SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
        }
    }

    private static async Task<SqlRowSet> Run(ISqlRunner runner, string sql, string needs, CancellationToken ct)
    {
        try
        {
            var sets = await runner.QueryAsync(sql, ct).ConfigureAwait(false);
            return sets.Count > 0 ? sets[0] : SqlRowSet.Of([]);
        }
        catch (SqlQueryException ex) when (IsPrivilegeError(ex))
        {
            throw EngineException.Privilege(ex.Message, needs);
        }
    }

    /// <summary>message_level 1 → error, 2 → warn, 8/16 → info; message_type 2 (incident error) → error.</summary>
    public static string LevelOf(long? messageLevel, long? messageType) =>
        messageType == 2 || messageLevel == 1 ? LogLevels.Error : messageLevel == 2 ? LogLevels.Warn : messageLevel is null ? LogLevels.Unknown : LogLevels.Info;

    public static List<LogEntry> ParseAlert(SqlRowSet rows)
    {
        var list = new List<LogEntry>(rows.Rows.Count);
        foreach (var r in rows.Rows)
        {
            var ts = rows.Time(r, "originating_timestamp", TimeSpan.Zero);
            var fields = new Dictionary<string, string>();
            foreach (var c in new[] { "module_id", "process_id", "host_id", "message_type", "message_level" })
                if (rows.Str(r, c) is { Length: > 0 } v) fields[c] = v;
            var text = (rows.Str(r, "message_text") ?? "").TrimEnd();
            list.Add(new LogEntry(SqlServer.SqlServerLogParser.Iso(ts), LevelOf(rows.Long(r, "message_level"), rows.Long(r, "message_type")),
                rows.Str(r, "module_id") is { Length: > 0 } module ? module : "rdbms", text, rows.Long(r, "record_id") ?? 0, null, fields));
        }
        return list;
    }

    public static List<LogEntry> ParseAudit(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>(rows.Rows.Count);
        for (var i = rows.Rows.Count - 1; i >= 0; i--)
        {
            var r = rows.Rows[i];
            var ts = rows.Time(r, "event_timestamp_utc", TimeSpan.Zero);
            var rc = rows.Long(r, "return_code") ?? 0;
            var obj = string.Join('.', new[] { rows.Str(r, "object_schema"), rows.Str(r, "object_name") }.Where(s => !string.IsNullOrEmpty(s)));
            var message = $"{rows.Str(r, "action_name")}{(obj.Length > 0 ? " " + obj : "")} by {rows.Str(r, "dbusername")}" + (rc != 0 ? $" failed (ORA-{rc:00000})" : "");
            var fields = new Dictionary<string, string>();
            foreach (var c in new[] { "dbusername", "os_username", "userhost", "client_program_name", "action_name", "unified_audit_policies" })
                if (rows.Str(r, c) is { Length: > 0 } v) fields[c] = v;
            fields["return_code"] = rc.ToString(CultureInfo.InvariantCulture);
            list.Add(new LogEntry(SqlServer.SqlServerLogParser.Iso(ts), rc != 0 ? LogLevels.Warn : LogLevels.Info, "audit", message, seq.Next(ts),
                rows.Str(r, "sql_text"), fields));
        }
        return list;
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        return ParseActivity(await Run(runner, OracleLogSql.Activity, f.SessionNeeds, ct).ConfigureAwait(false));
    }

    public static List<ActivityRow> ParseActivity(SqlRowSet s)
    {
        var bySid = s.Rows.ToDictionary(r => s.Str(r, "sid") ?? "", r => $"{s.Str(r, "sid")},{s.Str(r, "serial#")}", StringComparer.Ordinal);
        var list = new List<ActivityRow>();
        foreach (var r in s.Rows)
        {
            var id = $"{s.Str(r, "sid")},{s.Str(r, "serial#")}";
            var active = s.Str(r, "status") == "ACTIVE";
            var blocker = s.Str(r, "blocking_session");
            var waitClass = s.Str(r, "wait_class");
            var fields = new Dictionary<string, string> { ["killStatement"] = OracleLogSql.Kill(0, 0).Replace("'0,0'", $"'{id}'") };
            foreach (var c in new[] { "osuser", "module", "sql_id", "schemaname", "seconds_in_wait" })
                if (s.Str(r, c) is { Length: > 0 } v) fields[c] = v;
            list.Add(new ActivityRow
            {
                Id = id,
                Kind = "session",
                User = s.Str(r, "username"),
                Host = s.Str(r, "machine"),
                App = s.Str(r, "program"),
                Database = s.Str(r, "schemaname"),
                State = s.Str(r, "status") ?? "UNKNOWN",
                Since = SqlServer.SqlServerLogParser.Iso(s.Time(r, "sql_exec_start", TimeSpan.Zero) ?? s.Time(r, "logon_time", TimeSpan.Zero)),
                DurationMs = active ? s.Long(r, "last_call_et") * 1000 : null,
                WaitType = waitClass is null or "Idle" ? null : s.Str(r, "event"),
                BlockedBy = blocker is { Length: > 0 } ? bySid.GetValueOrDefault(blocker, blocker) : null,
                Command = s.Str(r, "command"),
                Text = s.Str(r, "sql_text"),
                Cpu = s.Double(r, "cpu_time") is { } cpu ? cpu / 1000.0 : null,
                Reads = s.Double(r, "buffer_gets"),
                CanKill = true,
                Fields = fields,
            });
        }
        return list;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var parts = (request.Id ?? "").Split(',');
        if (parts.Length != 2 || !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var sid)
            || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var serial))
            throw EngineException.Validation("id must be 'sid,serial#'.", new { field = "id" });
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        try
        {
            await runner.QueryAsync(OracleLogSql.Kill(sid, serial), ct).ConfigureAwait(false);
            return new LogKillResult(true, $"Session {sid},{serial} was killed.");
        }
        catch (SqlQueryException ex) when (IsPrivilegeError(ex))
        {
            throw EngineException.Privilege(ex.Message, f.KillNeeds);
        }
        catch (SqlQueryException ex) when (ex.Code.Contains("00030", StringComparison.Ordinal) || ex.Code.Contains("00031", StringComparison.Ordinal))
        {
            // ORA-00030: user session ID does not exist; ORA-00031: session marked for kill.
            return new LogKillResult(ex.Code.Contains("00031", StringComparison.Ordinal), ex.Message);
        }
    }
}
