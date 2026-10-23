using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.Snowflake;

/// <summary>The SQL of the Snowflake log and activity sources (golden-tested). Times are rendered as UTC ISO text.</summary>
public static class SnowflakeLogSql
{
    public const string Probe =
        "SELECT CURRENT_USER() AS USER_NAME, CURRENT_ROLE() AS ROLE_NAME, CURRENT_WAREHOUSE() AS WAREHOUSE_NAME, CURRENT_DATABASE() AS DATABASE_NAME";

    private static string Iso(string col) => $"TO_VARCHAR(CONVERT_TIMEZONE('UTC', {col}), 'YYYY-MM-DD\"T\"HH24:MI:SS.FF3\"Z\"')";

    private static string Ts(DateTimeOffset t) =>
        $"TO_TIMESTAMP_LTZ('{t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)}')";

    /// <summary>
    /// <c>INFORMATION_SCHEMA.QUERY_HISTORY</c> (last 7 days, at most 10,000 rows; queries the role may monitor) for an end-time
    /// window, newest first. <paramref name="running"/>: only RUNNING / QUEUED / BLOCKED / RESUMING_WAREHOUSE (activity).
    /// </summary>
    public static string QueryHistory(DateTimeOffset? from, DateTimeOffset? to, int limit, bool running = false)
    {
        var args = new List<string>();
        if (from is { } f) args.Add($"END_TIME_RANGE_START => {Ts(f)}");
        if (to is { } t) args.Add($"END_TIME_RANGE_END => {Ts(t)}");
        args.Add($"RESULT_LIMIT => {Math.Clamp(limit, 1, 10000).ToString(CultureInfo.InvariantCulture)}");
        var where = running ? "\nWHERE EXECUTION_STATUS IN ('RUNNING', 'QUEUED', 'BLOCKED', 'RESUMING_WAREHOUSE')" : "";
        return $"""
            SELECT QUERY_ID, LEFT(QUERY_TEXT, 8000) AS QUERY_TEXT, DATABASE_NAME, SCHEMA_NAME, QUERY_TYPE, SESSION_ID, USER_NAME, ROLE_NAME,
                WAREHOUSE_NAME, WAREHOUSE_SIZE, QUERY_TAG, EXECUTION_STATUS, ERROR_CODE, ERROR_MESSAGE,
                {Iso("START_TIME")} AS START_TIME, {Iso("END_TIME")} AS END_TIME, TOTAL_ELAPSED_TIME, BYTES_SCANNED, ROWS_PRODUCED,
                COMPILATION_TIME, EXECUTION_TIME, QUEUED_OVERLOAD_TIME
            FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY({string.Join(", ", args)})){where}
            ORDER BY START_TIME DESC
            """;
    }

    /// <summary><c>INFORMATION_SCHEMA.WAREHOUSE_LOAD_HISTORY</c> (5-minute intervals, last 14 days) of every warehouse the role can see.</summary>
    public static string WarehouseLoad(DateTimeOffset from, DateTimeOffset? to)
    {
        var args = $"DATE_RANGE_START => {Ts(from)}" + (to is { } t ? $", DATE_RANGE_END => {Ts(t)}" : "");
        return $"""
            SELECT {Iso("START_TIME")} AS START_TIME, {Iso("END_TIME")} AS END_TIME, WAREHOUSE_NAME, AVG_RUNNING, AVG_QUEUED_LOAD,
                AVG_QUEUED_PROVISIONING, AVG_BLOCKED
            FROM TABLE(INFORMATION_SCHEMA.WAREHOUSE_LOAD_HISTORY({args}))
            ORDER BY START_TIME DESC
            LIMIT 5000
            """;
    }

    /// <summary><c>INFORMATION_SCHEMA.LOGIN_HISTORY_BY_USER</c> of the current user (last 7 days).</summary>
    public static string LoginHistory(int limit) => $"""
        SELECT EVENT_ID, {Iso("EVENT_TIMESTAMP")} AS EVENT_TIMESTAMP, EVENT_TYPE, USER_NAME, CLIENT_IP, REPORTED_CLIENT_TYPE,
            REPORTED_CLIENT_VERSION, FIRST_AUTHENTICATION_FACTOR, SECOND_AUTHENTICATION_FACTOR, IS_SUCCESS, ERROR_CODE, ERROR_MESSAGE
        FROM TABLE(INFORMATION_SCHEMA.LOGIN_HISTORY_BY_USER(RESULT_LIMIT => {Math.Clamp(limit, 1, 10000).ToString(CultureInfo.InvariantCulture)}))
        ORDER BY EVENT_TIMESTAMP DESC
        """;

    public const string ShowTransactions = "SHOW TRANSACTIONS";
    public const string ShowLocks = "SHOW LOCKS";

    public static string CancelQuery(string queryId) => $"SELECT SYSTEM$CANCEL_QUERY({SqlText.String(queryId)}) AS RESULT";
    public static string AbortTransaction(long id) => $"SELECT SYSTEM$ABORT_TRANSACTION({SqlText.Int(id)}) AS RESULT";
}

/// <summary>
/// Snowflake (plan-batch3 WP-SF): <c>query_history</c> (INFORMATION_SCHEMA.QUERY_HISTORY: statements with status, error,
/// duration, bytes scanned), <c>warehouse_load</c> (WAREHOUSE_LOAD_HISTORY), <c>login_history</c> (LOGIN_HISTORY_BY_USER) and
/// activity: running and queued statements (cancel = <c>SYSTEM$CANCEL_QUERY</c>), open transactions (SHOW TRANSACTIONS,
/// abort = <c>SYSTEM$ABORT_TRANSACTION</c>) and locks (SHOW LOCKS). The INFORMATION_SCHEMA table functions need a current
/// database and a running warehouse; without them the sources are listed as unavailable with the statement to fix it.
/// </summary>
public sealed partial class SnowflakeLogSource(ISqlRunnerFactory runners) : ILogSource, IActivitySource
{
    public const string QueryHistory = "query_history", WarehouseLoad = "warehouse_load", LoginHistory = "login_history", Activity = "activity";

    public string ProviderId => "snowflake";

    private readonly FactsCache<Facts> _facts = new();

    public sealed record Facts(string User, string? Role, string? Warehouse, string? Database)
    {
        public string? Unavailable =>
            Database is null ? "INFORMATION_SCHEMA table functions need a current database: set one in the connection or run USE DATABASE."
            : Warehouse is null ? "Query history needs a running warehouse: set one in the connection (or USE WAREHOUSE)." : null;

        public string? Needs => Warehouse is null && Role is not null ? $"GRANT USAGE ON WAREHOUSE <warehouse> TO ROLE {Role};" : null;
        public string MonitorNeeds => $"GRANT MONITOR ON WAREHOUSE {Warehouse ?? "<warehouse>"} TO ROLE {Role ?? "<role>"};";
    }

    public static Facts ParseFacts(SqlRowSet p)
    {
        var r = p.Rows.FirstOrDefault() ?? throw EngineException.SourceUnavailable("The probe returned no row.");
        return new Facts(p.Str(r, "USER_NAME") ?? "", Blank(p.Str(r, "ROLE_NAME")), Blank(p.Str(r, "WAREHOUSE_NAME")), Blank(p.Str(r, "DATABASE_NAME")));
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    /// <summary>003001 insufficient privileges, 002003 does not exist or not authorized, 000606 no warehouse.</summary>
    public static bool IsPrivilegeError(SqlQueryException ex) =>
        ex.ProviderCode is 3001 or 2003 || ex.Message.Contains("insufficient privileges", StringComparison.OrdinalIgnoreCase);

    public static bool IsNoWarehouse(SqlQueryException ex) => ex.ProviderCode == 606 || ex.Message.Contains("No active warehouse", StringComparison.OrdinalIgnoreCase);

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            return ParseFacts((await runner.QueryAsync(SnowflakeLogSql.Probe, c).ConfigureAwait(false))[0]);
        }, ct);

    public static IReadOnlyList<LogSourceInfo> Sources(Facts f)
    {
        var history = new LogSourceInfo(QueryHistory, "Query history", "log", true, true, [LogLevels.Info, LogLevels.Warn, LogLevels.Error, LogLevels.Fatal], true);
        var load = new LogSourceInfo(WarehouseLoad, "Warehouse load", "log", false, true, [LogLevels.Info, LogLevels.Warn], true);
        var logins = new LogSourceInfo(LoginHistory, "Login history (you)", "log", false, true, [LogLevels.Info, LogLevels.Error], true);
        var activity = new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true,
            Reason: "Running statements need a warehouse; transactions and locks are listed without one.");
        if (f.Unavailable is { } reason)
        {
            history = history.Unavailable(reason, f.Needs);
            load = load.Unavailable(reason, f.Needs);
            logins = logins.Unavailable(reason, f.Needs);
        }
        else
        {
            history = history with { Reason = "Shows the statements of warehouses your role may monitor (QUERY_HISTORY: last 7 days).", Needs = f.MonitorNeeds };
        }
        return [history, load, logins, activity];
    }

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        _facts.Invalidate(target.ConnectionId);
        return Sources(await FactsAsync(target, ct).ConfigureAwait(false));
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        if (query.SourceId is not (QueryHistory or WarehouseLoad or LoginHistory))
            throw EngineException.Validation($"Unknown log source '{query.SourceId}'.", new { field = "sourceId" });
        if (f.Unavailable is { } reason) throw EngineException.Validation(reason, new { field = "sourceId" });
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var limit = LogFilter.LimitOf(query);
        switch (query.SourceId)
        {
            case QueryHistory:
            {
                // Seq cursors are time based: "before" pages to older entries, "after" tails newer ones.
                var to = query.Before is { } b ? TimeSeq.ToTime(b) : query.To;
                var from = query.After is { } a ? TimeSeq.ToTime(a) : query.From;
                var rows = await Run(runner, SnowflakeLogSql.QueryHistory(from, to, Math.Min(10000, limit * 2 + 50)), f, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseQueryHistory(rows), query, sourceHasMore: rows.Rows.Count >= limit * 2 + 50);
            }
            case WarehouseLoad:
            {
                var from = query.From ?? DateTimeOffset.UtcNow.AddDays(-1);
                var rows = await Run(runner, SnowflakeLogSql.WarehouseLoad(from, query.To), f, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseWarehouseLoad(rows), query);
            }
            default:
            {
                var rows = await Run(runner, SnowflakeLogSql.LoginHistory(Math.Min(10000, limit + 50)), f, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseLoginHistory(rows), query);
            }
        }
    }

    private static async Task<SqlRowSet> Run(ISqlRunner runner, string sql, Facts f, CancellationToken ct)
    {
        try
        {
            var sets = await runner.QueryAsync(sql, ct).ConfigureAwait(false);
            return sets.Count > 0 ? sets[0] : new SqlRowSet([], []);
        }
        catch (SqlQueryException ex) when (IsNoWarehouse(ex))
        {
            throw EngineException.Validation("This source needs a running warehouse: set one in the connection or run USE WAREHOUSE.", new { field = "sourceId" });
        }
        catch (SqlQueryException ex) when (IsPrivilegeError(ex))
        {
            throw EngineException.Privilege(ex.Message, f.MonitorNeeds);
        }
    }

    /// <summary>EXECUTION_STATUS → level: SUCCESS info, RUNNING/QUEUED/BLOCKED warn, FAILED_WITH_ERROR error, FAILED_WITH_INCIDENT fatal.</summary>
    public static string LevelOf(string? status) => (status ?? "").ToUpperInvariant() switch
    {
        "SUCCESS" => LogLevels.Info,
        "FAILED_WITH_ERROR" => LogLevels.Error,
        "FAILED_WITH_INCIDENT" => LogLevels.Fatal,
        "RUNNING" or "QUEUED" or "BLOCKED" or "RESUMING_WAREHOUSE" or "QUEUED_REPAIRING_WAREHOUSE" => LogLevels.Warn,
        _ => LogLevels.Unknown,
    };

    public static List<LogEntry> ParseQueryHistory(SqlRowSet rs)
    {
        var rows = rs.Rows.Select(r => (Row: r, Time: rs.Time(r, "START_TIME", TimeSpan.Zero))).OrderBy(x => x.Time ?? DateTimeOffset.MinValue).ToList();
        var seq = new TimeSeq();
        var list = new List<LogEntry>(rows.Count);
        foreach (var (r, time) in rows)
        {
            var status = rs.Str(r, "EXECUTION_STATUS");
            var error = rs.Str(r, "ERROR_MESSAGE");
            var text = rs.Str(r, "QUERY_TEXT") ?? "";
            var elapsed = rs.Long(r, "TOTAL_ELAPSED_TIME");
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            void F(string key, string? value) { if (!string.IsNullOrEmpty(value)) fields[key] = value; }
            F("queryId", rs.Str(r, "QUERY_ID"));
            F("status", status);
            F("type", rs.Str(r, "QUERY_TYPE"));
            F("user", rs.Str(r, "USER_NAME"));
            F("role", rs.Str(r, "ROLE_NAME"));
            F("warehouse", rs.Str(r, "WAREHOUSE_NAME"));
            F("size", rs.Str(r, "WAREHOUSE_SIZE"));
            F("database", rs.Str(r, "DATABASE_NAME"));
            F("schema", rs.Str(r, "SCHEMA_NAME"));
            F("session", rs.Str(r, "SESSION_ID"));
            F("tag", rs.Str(r, "QUERY_TAG"));
            F("elapsedMs", elapsed?.ToString(CultureInfo.InvariantCulture));
            F("bytesScanned", rs.Long(r, "BYTES_SCANNED")?.ToString(CultureInfo.InvariantCulture));
            F("rows", rs.Long(r, "ROWS_PRODUCED")?.ToString(CultureInfo.InvariantCulture));
            F("queuedMs", rs.Long(r, "QUEUED_OVERLOAD_TIME")?.ToString(CultureInfo.InvariantCulture));
            F("errorCode", rs.Str(r, "ERROR_CODE"));
            var message = OneLine(text, 300);
            var detail = error is null ? (text.Length > 300 || text.Contains('\n') ? text : null) : $"{error}\n\n{text}";
            list.Add(new LogEntry(time is { } t ? TimeSeq.Iso(t) : null, LevelOf(status), rs.Str(r, "WAREHOUSE_NAME") ?? rs.Str(r, "QUERY_TYPE") ?? "query",
                message, seq.Next(time), detail, fields));
        }
        return list;
    }

    public static List<LogEntry> ParseWarehouseLoad(SqlRowSet rs)
    {
        var rows = rs.Rows.Select(r => (Row: r, Time: rs.Time(r, "START_TIME", TimeSpan.Zero))).OrderBy(x => x.Time ?? DateTimeOffset.MinValue).ToList();
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var (r, time) in rows)
        {
            var running = rs.Double(r, "AVG_RUNNING") ?? 0;
            var queued = (rs.Double(r, "AVG_QUEUED_LOAD") ?? 0) + (rs.Double(r, "AVG_QUEUED_PROVISIONING") ?? 0);
            var blocked = rs.Double(r, "AVG_BLOCKED") ?? 0;
            var wh = rs.Str(r, "WAREHOUSE_NAME") ?? "warehouse";
            var msg = string.Create(CultureInfo.InvariantCulture, $"{wh}: running {running:0.##}, queued {queued:0.##}, blocked {blocked:0.##}");
            list.Add(new LogEntry(time is { } t ? TimeSeq.Iso(t) : null, queued > 0 || blocked > 0 ? LogLevels.Warn : LogLevels.Info, wh, msg, seq.Next(time),
                null, new Dictionary<string, string> { ["warehouse"] = wh, ["end"] = rs.Str(r, "END_TIME") ?? "" }));
        }
        return list;
    }

    public static List<LogEntry> ParseLoginHistory(SqlRowSet rs)
    {
        var rows = rs.Rows.Select(r => (Row: r, Time: rs.Time(r, "EVENT_TIMESTAMP", TimeSpan.Zero))).OrderBy(x => x.Time ?? DateTimeOffset.MinValue).ToList();
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var (r, time) in rows)
        {
            var ok = (rs.Str(r, "IS_SUCCESS") ?? "").Trim().ToUpperInvariant() is "YES" or "TRUE" or "Y";
            var client = rs.Str(r, "REPORTED_CLIENT_TYPE");
            var msg = ok
                ? $"{rs.Str(r, "USER_NAME")} logged in from {rs.Str(r, "CLIENT_IP")} ({client}, {rs.Str(r, "FIRST_AUTHENTICATION_FACTOR")})"
                : $"Login of {rs.Str(r, "USER_NAME")} from {rs.Str(r, "CLIENT_IP")} failed: {rs.Str(r, "ERROR_MESSAGE")}";
            list.Add(new LogEntry(time is { } t ? TimeSeq.Iso(t) : null, ok ? LogLevels.Info : LogLevels.Error, client ?? "login", msg, seq.Next(time), null,
                new Dictionary<string, string> { ["client"] = $"{client} {rs.Str(r, "REPORTED_CLIENT_VERSION")}".Trim(), ["ip"] = rs.Str(r, "CLIENT_IP") ?? "" }));
        }
        return list;
    }

    private static string OneLine(string text, int max)
    {
        var s = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return s.Length <= max ? s : s[..max] + "…";
    }

    // ------------------------------------------------------------------ activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var rows = new List<ActivityRow>();
        if (f.Unavailable is null)
        {
            try
            {
                var running = (await runner.QueryAsync(SnowflakeLogSql.QueryHistory(null, null, 1000, running: true), ct).ConfigureAwait(false)).FirstOrDefault();
                if (running is not null) rows.AddRange(ParseRunning(running, target.ReadOnly));
            }
            catch (SqlQueryException) { /* no warehouse / privilege: transactions and locks only */ }
        }
        try
        {
            var tx = (await runner.QueryAsync(SnowflakeLogSql.ShowTransactions, ct).ConfigureAwait(false)).FirstOrDefault();
            if (tx is not null) rows.AddRange(ParseTransactions(tx, target.ReadOnly));
        }
        catch (SqlQueryException) { /* not allowed */ }
        try
        {
            var locks = (await runner.QueryAsync(SnowflakeLogSql.ShowLocks, ct).ConfigureAwait(false)).FirstOrDefault();
            if (locks is not null) rows.AddRange(ParseLocks(locks));
        }
        catch (SqlQueryException) { /* not allowed */ }
        return rows;
    }

    public static IEnumerable<ActivityRow> ParseRunning(SqlRowSet rs, bool readOnly)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var r in rs.Rows)
        {
            var id = rs.Str(r, "QUERY_ID");
            if (string.IsNullOrEmpty(id)) continue;
            var start = rs.Time(r, "START_TIME", TimeSpan.Zero);
            var status = rs.Str(r, "EXECUTION_STATUS") ?? "RUNNING";
            yield return new ActivityRow
            {
                Id = id,
                Kind = "op",
                User = rs.Str(r, "USER_NAME"),
                App = rs.Str(r, "QUERY_TAG"),
                Database = rs.Str(r, "DATABASE_NAME"),
                State = status.ToLowerInvariant(),
                Since = start is { } s ? TimeSeq.Iso(s) : null,
                DurationMs = rs.Long(r, "TOTAL_ELAPSED_TIME") ?? (start is { } s2 ? Math.Max(0, (long)(now - s2).TotalMilliseconds) : null),
                WaitType = status is "QUEUED" or "BLOCKED" or "RESUMING_WAREHOUSE" ? status.ToLowerInvariant() : null,
                Command = rs.Str(r, "QUERY_TYPE"),
                Text = rs.Str(r, "QUERY_TEXT"),
                Reads = rs.Double(r, "BYTES_SCANNED"),
                CanKill = !readOnly,
                Fields = new Dictionary<string, string>
                {
                    ["warehouse"] = rs.Str(r, "WAREHOUSE_NAME") ?? "", ["role"] = rs.Str(r, "ROLE_NAME") ?? "", ["session"] = rs.Str(r, "SESSION_ID") ?? "",
                },
            };
        }
    }

    public static IEnumerable<ActivityRow> ParseTransactions(SqlRowSet rs, bool readOnly)
    {
        foreach (var r in rs.Rows)
        {
            var id = rs.Str(r, "id");
            if (string.IsNullOrEmpty(id)) continue;
            var started = rs.Time(r, "started_on", TimeSpan.Zero);
            yield return new ActivityRow
            {
                Id = id,
                Kind = "session",
                User = rs.Str(r, "user"),
                State = (rs.Str(r, "state") ?? "running").ToLowerInvariant(),
                Since = started is { } s ? TimeSeq.Iso(s) : null,
                DurationMs = started is { } s2 ? Math.Max(0, (long)(DateTimeOffset.UtcNow - s2).TotalMilliseconds) : null,
                Command = "TRANSACTION",
                Text = rs.Str(r, "name"),
                CanKill = !readOnly,
                Fields = new Dictionary<string, string> { ["session"] = rs.Str(r, "session") ?? "", ["scope"] = rs.Str(r, "scope") ?? "" },
            };
        }
    }

    public static IEnumerable<ActivityRow> ParseLocks(SqlRowSet rs)
    {
        var i = 0;
        foreach (var r in rs.Rows)
        {
            i++;
            var status = rs.Str(r, "status") ?? "";
            yield return new ActivityRow
            {
                Id = $"lock-{rs.Str(r, "transaction")}-{i}",
                Kind = "lock",
                State = status.ToLowerInvariant(),
                Since = rs.Str(r, "acquired_on"),
                WaitType = status.Equals("WAITING", StringComparison.OrdinalIgnoreCase) ? "lock" : null,
                Command = rs.Str(r, "type"),
                Text = rs.Str(r, "resource"),
                CanKill = false,
                Fields = new Dictionary<string, string>
                {
                    ["transaction"] = rs.Str(r, "transaction") ?? "", ["session"] = rs.Str(r, "session") ?? "", ["queryId"] = rs.Str(r, "query_id") ?? "",
                },
            };
        }
    }

    [GeneratedRegex(@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex QueryIdPattern();

    public static bool IsQueryId(string id) => QueryIdPattern().IsMatch(id);

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var id = request.Id?.Trim() ?? "";
        string sql;
        if (IsQueryId(id)) sql = SnowflakeLogSql.CancelQuery(id);
        else if (long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var tx)) sql = SnowflakeLogSql.AbortTransaction(tx);
        else throw EngineException.Validation("id must be a query id (01b2…-…) or a transaction id.", new { field = "id" });
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        try
        {
            var rs = (await runner.QueryAsync(sql, ct).ConfigureAwait(false)).FirstOrDefault();
            var text = rs is { Rows.Count: > 0 } ? rs.Str(rs.Rows[0], "RESULT") : null;
            return new LogKillResult(true, text);
        }
        catch (SqlQueryException ex) when (IsPrivilegeError(ex))
        {
            throw EngineException.Privilege(ex.Message, "Cancelling another user's statement needs OPERATE on its warehouse or ownership of the role.");
        }
    }
}
