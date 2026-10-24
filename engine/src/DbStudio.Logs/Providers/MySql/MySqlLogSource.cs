using System.Globalization;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.MySql;

/// <summary>The SQL of the MySQL / MariaDB log and activity sources. Timestamps travel as UNIX epochs (time-zone free).</summary>
public static class MySqlLogSql
{
    public const string Probe =
        "SELECT VERSION() AS version, @@version_comment AS comment, CURRENT_USER() AS user_name, @@log_output AS log_output, " +
        "@@general_log AS general_log, @@slow_query_log AS slow_log, CONNECTION_ID() AS connection_id";

    public const string ErrorLogProbe = "SELECT 1 FROM performance_schema.error_log LIMIT 1";
    public const string GeneralLogProbe = "SELECT 1 FROM mysql.general_log LIMIT 1";
    public const string SlowLogProbe = "SELECT 1 FROM mysql.slow_log LIMIT 1";
    public const string ProcessProbe = "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST";

    private static string Window(string column, DateTimeOffset? from, DateTimeOffset? to)
    {
        var parts = new List<string>();
        if (from is { } f) parts.Add($"{column} >= FROM_UNIXTIME({Epoch(f)})");
        if (to is { } t) parts.Add($"{column} <= FROM_UNIXTIME({Epoch(t)})");
        return parts.Count == 0 ? "" : " WHERE " + string.Join(" AND ", parts);
    }

    public static string Epoch(DateTimeOffset t) => (t.ToUnixTimeMilliseconds() / 1000.0).ToString("0.000", CultureInfo.InvariantCulture);

    public static string ErrorLog(DateTimeOffset? from, DateTimeOffset? to, int limit) =>
        "SELECT UNIX_TIMESTAMP(LOGGED) AS ts, THREAD_ID AS thread_id, PRIO AS prio, ERROR_CODE AS error_code, SUBSYSTEM AS subsystem, DATA AS data " +
        "FROM performance_schema.error_log" + Window("LOGGED", from, to) + $" ORDER BY LOGGED DESC LIMIT {limit}";

    public static string GeneralLog(DateTimeOffset? from, DateTimeOffset? to, int limit) =>
        "SELECT UNIX_TIMESTAMP(event_time) AS ts, user_host, thread_id, command_type, CONVERT(argument USING utf8mb4) AS argument " +
        "FROM mysql.general_log" + Window("event_time", from, to) + $" ORDER BY event_time DESC LIMIT {limit}";

    public static string SlowLog(DateTimeOffset? from, DateTimeOffset? to, int limit) =>
        "SELECT UNIX_TIMESTAMP(start_time) AS ts, user_host, TIME_TO_SEC(query_time) AS query_s, TIME_TO_SEC(lock_time) AS lock_s, rows_sent, rows_examined, db, " +
        "CONVERT(sql_text USING utf8mb4) AS sql_text FROM mysql.slow_log" + Window("start_time", from, to) + $" ORDER BY start_time DESC LIMIT {limit}";

    public const string InnoDbStatus = "SHOW ENGINE INNODB STATUS";

    public const string Activity =
        "SELECT ID AS id, USER AS user_name, HOST AS host, DB AS db, COMMAND AS command, TIME AS time_s, STATE AS state, LEFT(INFO, 8000) AS info " +
        "FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY COMMAND = 'Sleep', TIME DESC LIMIT 1000";

    /// <summary>MySQL 8: waiting / blocking connection ids from performance_schema.data_lock_waits.</summary>
    public const string LockWaitsMySql =
        "SELECT rt.PROCESSLIST_ID AS waiting, bt.PROCESSLIST_ID AS blocking, rl.OBJECT_SCHEMA AS object_schema, rl.OBJECT_NAME AS object_name, " +
        "rl.LOCK_MODE AS lock_mode, rl.LOCK_TYPE AS lock_type " +
        "FROM performance_schema.data_lock_waits w " +
        "JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID " +
        "JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID " +
        "LEFT JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID LIMIT 2000";

    /// <summary>MariaDB: INNODB_LOCK_WAITS joined to INNODB_TRX / INNODB_LOCKS.</summary>
    public const string LockWaitsMariaDb =
        "SELECT r.trx_mysql_thread_id AS waiting, b.trx_mysql_thread_id AS blocking, l.lock_table AS object_name, l.lock_mode AS lock_mode, l.lock_type AS lock_type " +
        "FROM information_schema.INNODB_LOCK_WAITS w " +
        "JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id " +
        "JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id " +
        "LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = w.requested_lock_id LIMIT 2000";

    public static string Kill(long id, bool queryOnly) => (queryOnly ? "KILL QUERY " : "KILL ") + id.ToString(CultureInfo.InvariantCulture);
}

/// <summary>
/// MySQL / MariaDB logs and activity (plan-batch3 WP-MY), registered under "mysql" and "mariadb":
/// <c>error_log</c> (performance_schema.error_log, MySQL 8.0.22+), <c>general_log</c> / <c>slow_log</c> (mysql.* tables
/// when log_output includes TABLE), <c>innodb_status</c> (SHOW ENGINE INNODB STATUS) and activity (PROCESSLIST, lock
/// waits; KILL / KILL QUERY). Denied sources come back unavailable with the GRANT that would allow them.
/// </summary>
public sealed class MySqlLogSource(ISqlRunnerFactory runners, string providerId = "mysql") : ILogSource, IActivitySource
{
    public const string ErrorLog = "error_log", GeneralLog = "general_log", SlowLog = "slow_log", InnoDbStatus = "innodb_status", Activity = "activity";

    public string ProviderId => providerId;

    private readonly FactsCache<Facts> _facts = new();

    public sealed record Facts(string Version, bool MariaDb, string User, string LogOutput, bool GeneralOn, bool SlowOn,
        bool ErrorLogReadable, bool GeneralReadable, bool SlowReadable, bool InnoDbReadable)
    {
        /// <summary>'shop'@'%' as GRANT target.</summary>
        public string Grantee
        {
            get
            {
                var at = User.LastIndexOf('@');
                return at < 0 ? $"'{User}'" : $"'{User[..at]}'@'{User[(at + 1)..]}'";
            }
        }
        public bool TableOutput => LogOutput.Contains("TABLE", StringComparison.OrdinalIgnoreCase);
        public string ErrorLogNeeds => $"GRANT SELECT ON performance_schema.error_log TO {Grantee};";
        public string LogTablesNeeds => $"GRANT SELECT ON mysql.general_log TO {Grantee}; GRANT SELECT ON mysql.slow_log TO {Grantee};";
        public string ProcessNeeds => $"GRANT PROCESS ON *.* TO {Grantee};";
        public string KillNeeds => MariaDb ? $"GRANT CONNECTION ADMIN ON *.* TO {Grantee};" : $"GRANT CONNECTION_ADMIN ON *.* TO {Grantee};";
    }

    /// <summary>1142 table access denied, 1227 needs a privilege, 1044 db access denied, 1095 not your thread.</summary>
    public static bool IsPrivilegeError(SqlQueryException ex) =>
        ex.ProviderCode is 1142 or 1227 or 1044 or 1095 or 1045 || ex.Code is "1142" or "1227" or "1044" or "1095";

    private async Task<bool> CanReadAsync(ISqlRunner runner, string probe, CancellationToken ct)
    {
        try
        {
            await runner.QueryAsync(probe, ct).ConfigureAwait(false);
            return true;
        }
        catch (SqlQueryException)
        {
            return false;
        }
    }

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            var p = (await runner.QueryAsync(MySqlLogSql.Probe, c).ConfigureAwait(false))[0];
            var r = p.Rows.FirstOrDefault() ?? throw EngineException.SourceUnavailable("The privilege probe returned no row.");
            var version = p.Str(r, "version") ?? "";
            var maria = version.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) || (p.Str(r, "comment")?.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) ?? false);
            var errorLog = !maria && await CanReadAsync(runner, MySqlLogSql.ErrorLogProbe, c).ConfigureAwait(false);
            var general = await CanReadAsync(runner, MySqlLogSql.GeneralLogProbe, c).ConfigureAwait(false);
            var slow = await CanReadAsync(runner, MySqlLogSql.SlowLogProbe, c).ConfigureAwait(false);
            var innodb = await CanReadAsync(runner, MySqlLogSql.InnoDbStatus, c).ConfigureAwait(false);
            return new Facts(version, maria, p.Str(r, "user_name") ?? "", p.Str(r, "log_output") ?? "FILE", p.Bool(r, "general_log"), p.Bool(r, "slow_log"),
                errorLog, general, slow, innodb);
        }, ct);

    public static IReadOnlyList<LogSourceInfo> Sources(Facts f)
    {
        var levels = LogLevels.Standard;
        var error = new LogSourceInfo(ErrorLog, "Error log", "log", true, true, levels, true);
        if (f.MariaDb) error = error.Unavailable("MariaDB keeps its error log in a file only (log_error); SQL cannot read it.", null);
        else if (!f.ErrorLogReadable) error = error.Unavailable("Reading performance_schema.error_log needs MySQL 8.0.22+ and SELECT on it.", f.ErrorLogNeeds);

        var general = new LogSourceInfo(GeneralLog, "General query log", "log", true, true, [LogLevels.Info], true);
        if (!f.TableOutput) general = general.Unavailable("log_output does not include TABLE: the general log goes to a file.", "SET GLOBAL log_output = 'TABLE,FILE';");
        else if (!f.GeneralReadable) general = general.Unavailable("Reading mysql.general_log needs SELECT on it.", f.LogTablesNeeds);
        else if (!f.GeneralOn) general = general with { Reason = "general_log is OFF: no new entries are written.", Needs = "SET GLOBAL general_log = 'ON';" };

        var slow = new LogSourceInfo(SlowLog, "Slow query log", "log", true, true, [LogLevels.Info, LogLevels.Warn], true);
        if (!f.TableOutput) slow = slow.Unavailable("log_output does not include TABLE: the slow log goes to a file.", "SET GLOBAL log_output = 'TABLE,FILE';");
        else if (!f.SlowReadable) slow = slow.Unavailable("Reading mysql.slow_log needs SELECT on it.", f.LogTablesNeeds);
        else if (!f.SlowOn) slow = slow with { Reason = "slow_query_log is OFF: no new entries are written.", Needs = "SET GLOBAL slow_query_log = 'ON';" };

        var innodb = new LogSourceInfo(InnoDbStatus, "InnoDB status", "log", false, false, [LogLevels.Info], true);
        if (!f.InnoDbReadable) innodb = innodb.Unavailable("SHOW ENGINE INNODB STATUS needs the PROCESS privilege.", f.ProcessNeeds);

        var activity = new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true);
        if (!f.InnoDbReadable) activity = activity with { Reason = "Without PROCESS only your own connections are listed.", Needs = f.ProcessNeeds };
        return [error, general, slow, innodb, activity];
    }

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        _facts.Invalidate(target.ConnectionId);
        return Sources(await FactsAsync(target, ct).ConfigureAwait(false));
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var info = Sources(f).FirstOrDefault(s => s.Id == query.SourceId && s.Kind == "log") ?? throw SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
        if (!info.Available)
        {
            var reason = info.Reason ?? "The source is not available.";
            var privilege = info.Needs?.StartsWith("GRANT", StringComparison.Ordinal) == true;
            if (privilege) throw EngineException.Privilege(reason, info.Needs);
            throw EngineException.Validation(reason, new { field = "sourceId" });
        }
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var limit = LogFilter.LimitOf(query);
        var fetch = Math.Min(LogFilter.MaxLimit * 2, limit * 2 + 1);
        var from = query.After is { } a ? TimeSeq.ToTime(a) : query.From;
        var to = query.Before is { } b ? TimeSeq.ToTime(b).AddMilliseconds(1) : query.To;
        switch (query.SourceId)
        {
            case ErrorLog:
            {
                var rows = await Run(runner, MySqlLogSql.ErrorLog(from, to, fetch), f.ErrorLogNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseErrorLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            case GeneralLog:
            {
                var rows = await Run(runner, MySqlLogSql.GeneralLog(from, to, fetch), f.LogTablesNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseGeneralLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            case SlowLog:
            {
                var rows = await Run(runner, MySqlLogSql.SlowLog(from, to, fetch), f.LogTablesNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseSlowLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            case InnoDbStatus:
            {
                var rows = await Run(runner, MySqlLogSql.InnoDbStatus, f.ProcessNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseInnoDbStatus(rows, DateTimeOffset.UtcNow), query with { From = null, To = null });
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

    private static DateTimeOffset? EpochOf(SqlRowSet s, object?[] r)
    {
        var d = s.Double(r, "ts");
        return d is null ? null : DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Round(d.Value * 1000));
    }

    /// <summary>Rows newest first → entries ascending with timestamp seqs.</summary>
    private static List<LogEntry> Ascending(SqlRowSet s, Func<object?[], DateTimeOffset?, LogEntry> make)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>(s.Rows.Count);
        foreach (var r in s.Rows.Reverse())
        {
            var ts = EpochOf(s, r);
            var e = make(r, ts);
            list.Add(e with { Seq = seq.Next(ts), Ts = ts is { } t ? TimeSeq.Iso(t) : null });
        }
        return list;
    }

    public static List<LogEntry> ParseErrorLog(SqlRowSet s) => Ascending(s, (r, _) =>
    {
        var prio = s.Str(r, "prio") ?? "";
        var level = prio.ToUpperInvariant() switch { "ERROR" => LogLevels.Error, "WARNING" => LogLevels.Warn, "NOTE" => LogLevels.Info, "SYSTEM" => LogLevels.Info, _ => LogLevels.Unknown };
        var fields = new Dictionary<string, string>();
        if (s.Str(r, "error_code") is { } code) fields["code"] = code;
        if (s.Str(r, "subsystem") is { } sub) fields["subsystem"] = sub;
        if (s.Str(r, "thread_id") is { } th) fields["thread"] = th;
        return new LogEntry(null, level, s.Str(r, "subsystem") ?? "server", s.Str(r, "data") ?? "", 0, null, fields);
    });

    public static List<LogEntry> ParseGeneralLog(SqlRowSet s) => Ascending(s, (r, _) =>
    {
        var fields = new Dictionary<string, string>();
        if (s.Str(r, "user_host") is { } uh) fields["user"] = uh;
        if (s.Str(r, "thread_id") is { } th) fields["thread"] = th;
        var command = s.Str(r, "command_type") ?? "";
        var arg = s.Str(r, "argument") ?? "";
        var first = arg.ReplaceLineEndings(" ");
        if (first.Length > 300) first = first[..300] + "…";
        return new LogEntry(null, LogLevels.Info, command, first, 0, arg.Length > 300 || arg.Contains('\n') ? arg : null, fields);
    });

    public static List<LogEntry> ParseSlowLog(SqlRowSet s) => Ascending(s, (r, _) =>
    {
        var seconds = s.Double(r, "query_s") ?? 0;
        var fields = new Dictionary<string, string>
        {
            ["queryS"] = seconds.ToString("0.###", CultureInfo.InvariantCulture),
            ["lockS"] = (s.Double(r, "lock_s") ?? 0).ToString("0.###", CultureInfo.InvariantCulture),
            ["rowsSent"] = (s.Long(r, "rows_sent") ?? 0).ToString(CultureInfo.InvariantCulture),
            ["rowsExamined"] = (s.Long(r, "rows_examined") ?? 0).ToString(CultureInfo.InvariantCulture),
        };
        if (s.Str(r, "user_host") is { } uh) fields["user"] = uh;
        if (s.Str(r, "db") is { Length: > 0 } db) fields["database"] = db;
        var sql = s.Str(r, "sql_text") ?? "";
        var first = sql.ReplaceLineEndings(" ");
        if (first.Length > 300) first = first[..300] + "…";
        return new LogEntry(null, seconds >= 10 ? LogLevels.Warn : LogLevels.Info, "slow_log", $"{fields["queryS"]} s, {fields["rowsExamined"]} rows examined: {first}", 0, sql, fields);
    });

    /// <summary>SHOW ENGINE INNODB STATUS: one entry per "-----\nSECTION\n-----" section of the Status text.</summary>
    public static List<LogEntry> ParseInnoDbStatus(SqlRowSet s, DateTimeOffset now)
    {
        var text = s.Rows.FirstOrDefault() is { } r ? s.Str(r, "Status") ?? SqlCells.Str(r.LastOrDefault()) ?? "" : "";
        var lines = text.Replace("\r", "").Split('\n');
        var list = new List<LogEntry>();
        string? title = null;
        var body = new List<string>();
        var seq = 1;
        void Flush()
        {
            if (title is null) return;
            var detail = string.Join("\n", body).Trim();
            var level = title.Contains("DEADLOCK", StringComparison.OrdinalIgnoreCase) ? LogLevels.Warn : LogLevels.Info;
            list.Add(new LogEntry(TimeSeq.Iso(now), level, "innodb", title, seq++, detail.Length == 0 ? null : detail));
        }
        for (var i = 0; i < lines.Length; i++)
        {
            var l = lines[i];
            if (l.StartsWith("---", StringComparison.Ordinal) && i + 2 < lines.Length && lines[i + 2].StartsWith("---", StringComparison.Ordinal) && lines[i + 1].Trim().Length > 0
                && lines[i + 1].Trim().ToUpperInvariant() == lines[i + 1].Trim())
            {
                Flush();
                title = lines[i + 1].Trim();
                body.Clear();
                i += 2;
                continue;
            }
            if (title is not null) body.Add(l);
        }
        Flush();
        if (list.Count == 0 && text.Length > 0) list.Add(new LogEntry(TimeSeq.Iso(now), LogLevels.Info, "innodb", "InnoDB status", 1, text));
        return list;
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var sessions = await Run(runner, MySqlLogSql.Activity, f.ProcessNeeds, ct).ConfigureAwait(false);
        SqlRowSet? waits = null;
        try { waits = await Run(runner, f.MariaDb ? MySqlLogSql.LockWaitsMariaDb : MySqlLogSql.LockWaitsMySql, f.ProcessNeeds, ct).ConfigureAwait(false); }
        catch (Exception ex) when (ex is EngineException or SqlQueryException) { }
        return ParseActivity(sessions, waits);
    }

    public static List<ActivityRow> ParseActivity(SqlRowSet s, SqlRowSet? waits)
    {
        var blockedBy = new Dictionary<string, string>();
        if (waits is not null)
            foreach (var w in waits.Rows)
                if (waits.Str(w, "waiting") is { } waiting && waits.Str(w, "blocking") is { } blocking) blockedBy.TryAdd(waiting, blocking);
        var list = new List<ActivityRow>();
        foreach (var r in s.Rows)
        {
            var id = s.Str(r, "id") ?? "";
            var command = s.Str(r, "command") ?? "";
            var seconds = s.Long(r, "time_s");
            var state = command.Equals("Sleep", StringComparison.OrdinalIgnoreCase) ? "idle" : string.IsNullOrEmpty(s.Str(r, "state")) ? command.ToLowerInvariant() : "active";
            var fields = new Dictionary<string, string>
            {
                ["killStatement"] = MySqlLogSql.Kill(long.TryParse(id, out var n) ? n : 0, false),
                ["cancelStatement"] = MySqlLogSql.Kill(long.TryParse(id, out var n2) ? n2 : 0, true),
            };
            if (s.Str(r, "state") is { Length: > 0 } st) fields["state"] = st;
            list.Add(new ActivityRow
            {
                Id = id,
                Kind = "session",
                User = s.Str(r, "user_name"),
                Host = s.Str(r, "host"),
                Database = s.Str(r, "db"),
                State = state,
                DurationMs = seconds is { } sec ? sec * 1000 : null,
                Command = command,
                WaitType = blockedBy.ContainsKey(id) ? "Lock wait" : null,
                BlockedBy = blockedBy.GetValueOrDefault(id),
                Text = s.Str(r, "info"),
                CanKill = !command.Equals("Daemon", StringComparison.OrdinalIgnoreCase) && !command.Equals("Binlog Dump", StringComparison.OrdinalIgnoreCase),
                Fields = fields,
            });
        }
        if (waits is not null)
            foreach (var w in waits.Rows)
            {
                var waiting = waits.Str(w, "waiting") ?? "";
                var obj = string.Join(".", new[] { waits.Str(w, "object_schema"), waits.Str(w, "object_name") }.Where(x => !string.IsNullOrEmpty(x)));
                list.Add(new ActivityRow
                {
                    Id = $"lock:{waiting}:{waits.Str(w, "blocking")}:{obj}:{waits.Str(w, "lock_mode")}",
                    Kind = "lock",
                    State = "WAIT",
                    BlockedBy = waits.Str(w, "blocking"),
                    CanKill = false,
                    Fields = new Dictionary<string, string>
                    {
                        ["owner"] = waiting, ["resource"] = obj, ["mode"] = waits.Str(w, "lock_mode") ?? "", ["type"] = waits.Str(w, "lock_type") ?? "",
                    },
                });
            }
        return list;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        if (!long.TryParse(request.Id, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id < 1)
            throw EngineException.Validation("id must be a connection id.", new { field = "id" });
        if (request.Mode is not (null or "terminate" or "cancel"))
            throw EngineException.Validation("mode must be 'cancel' or 'terminate'.", new { field = "mode" });
        var queryOnly = request.Mode == "cancel";
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        try
        {
            await runner.QueryAsync(MySqlLogSql.Kill(id, queryOnly), ct).ConfigureAwait(false);
        }
        catch (SqlQueryException ex) when (ex.ProviderCode == 1094 || ex.Code == "1094")
        {
            return new LogKillResult(false, $"Connection {id} is gone.");
        }
        catch (SqlQueryException ex) when (IsPrivilegeError(ex))
        {
            throw EngineException.Privilege(ex.Message, f.KillNeeds);
        }
        return new LogKillResult(true, queryOnly ? $"The statement of connection {id} was cancelled." : $"Connection {id} was killed.");
    }
}
