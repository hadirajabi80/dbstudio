using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.ClickHouse;

/// <summary>The SQL of the ClickHouse log and activity sources (golden-tested). Times are rendered as UTC text.</summary>
public static partial class ChLogSql
{
    /// <summary>A ClickHouse string literal (backslash and quote escaped).</summary>
    public static string Literal(string? s)
    {
        if (s is null) return "NULL";
        var sb = new StringBuilder(s.Length + 2).Append('\'');
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '\'': sb.Append("\\'"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\0': sb.Append("\\0"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.Append('\'').ToString();
    }

    /// <summary>toDateTime64('2026-10-18 13:02:11.213000', 6, 'UTC').</summary>
    public static string Time(DateTime utc)
    {
        // DateTime64 covers 1900-01-01 … 2299-12-31; open query ends (1900 / 9999) are clamped into it.
        var min = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var max = new DateTime(2299, 12, 31, 0, 0, 0, DateTimeKind.Utc);
        var t = utc < min ? min : utc > max ? max : utc;
        return $"toDateTime64('{t.ToString("yyyy-MM-dd HH:mm:ss.ffffff", CultureInfo.InvariantCulture)}', 6, 'UTC')";
    }

    private static string Iso(string col) => $"toString(toTimeZone({col}, 'UTC'))";

    public const string Probe = """
        SELECT currentUser() AS user_name, version() AS version,
            arrayStringConcat(arrayFilter(x -> x IN ('query_log', 'text_log', 'part_log', 'errors', 'processes', 'mutations', 'merges'),
                groupArray(name)), ',') AS tables
        FROM system.tables WHERE database = 'system'
        """;

    private static string Range(string col, DateTime from, DateTime to) =>
        $"{col} >= {Time(from)} AND {col} <= {Time(to)}";

    private static string Contains(string col, string? q) => string.IsNullOrEmpty(q) ? "" : $" AND positionCaseInsensitiveUTF8({col}, {Literal(q)}) > 0";

    public static string QueryLog(DateTime from, DateTime to, string? q, int limit) => $"""
        SELECT {Iso("event_time_microseconds")} AS ts, toString(type) AS type, query_id, user, current_database AS db, query_duration_ms,
            read_rows, read_bytes, result_rows, written_rows, memory_usage, exception_code, exception, left(query, 8000) AS query,
            toString(query_kind) AS kind
        FROM system.query_log
        WHERE type != 'QueryStart' AND event_date >= toDate({Time(from)}) AND {Range("event_time_microseconds", from, to)}{Contains("query", q)}
        ORDER BY event_time_microseconds DESC
        LIMIT {limit.ToString(CultureInfo.InvariantCulture)}
        """;

    public static string TextLog(DateTime from, DateTime to, string? q, int limit) => $"""
        SELECT {Iso("event_time_microseconds")} AS ts, toString(level) AS level, logger_name, message, query_id, thread_name
        FROM system.text_log
        WHERE event_date >= toDate({Time(from)}) AND {Range("event_time_microseconds", from, to)}{Contains("message", q)}
        ORDER BY event_time_microseconds DESC
        LIMIT {limit.ToString(CultureInfo.InvariantCulture)}
        """;

    public static string PartLog(DateTime from, DateTime to, string? q, int limit) => $"""
        SELECT {Iso("event_time_microseconds")} AS ts, toString(event_type) AS event_type, database, table, part_name, partition_id,
            rows, size_in_bytes, duration_ms, error, exception, merged_from
        FROM system.part_log
        WHERE event_date >= toDate({Time(from)}) AND {Range("event_time_microseconds", from, to)}{Contains("concat(database, '.', table, ' ', part_name, ' ', exception)", q)}
        ORDER BY event_time_microseconds DESC
        LIMIT {limit.ToString(CultureInfo.InvariantCulture)}
        """;

    public const string Errors = """
        SELECT toString(toTimeZone(last_error_time, 'UTC')) AS ts, name, code, value, last_error_message, remote
        FROM system.errors
        ORDER BY last_error_time DESC
        LIMIT 1000
        """;

    public const string Processes = """
        SELECT query_id, user, address AS host, client_name, current_database AS db, elapsed, read_rows, read_bytes, memory_usage,
            left(query, 8000) AS query, toString(query_kind) AS kind, is_cancelled
        FROM system.processes
        WHERE query_id != queryID()
        ORDER BY elapsed DESC
        LIMIT 1000
        """;

    public const string Mutations = """
        SELECT database, table, mutation_id, command, toString(toTimeZone(create_time, 'UTC')) AS created, parts_to_do, is_done,
            latest_fail_reason
        FROM system.mutations
        WHERE NOT is_done
        ORDER BY create_time
        LIMIT 500
        """;

    public const string Merges = """
        SELECT database, table, elapsed, progress, num_parts, result_part_name, total_size_bytes_compressed, rows_read, rows_written,
            memory_usage, is_mutation, toString(merge_type) AS merge_type
        FROM system.merges
        ORDER BY elapsed DESC
        LIMIT 500
        """;

    public static string KillQuery(string queryId) => $"KILL QUERY WHERE query_id = {Literal(queryId)} SYNC";

    public static string KillMutation(string database, string table, string mutationId) =>
        $"KILL MUTATION WHERE database = {Literal(database)} AND table = {Literal(table)} AND mutation_id = {Literal(mutationId)} SYNC";

    [GeneratedRegex(@"^mutation:(?<db>[^.:]+)\.(?<table>[^:]+):(?<id>[A-Za-z0-9_.\-]+)$", RegexOptions.CultureInvariant)]
    public static partial Regex MutationId();
}

/// <summary>
/// ClickHouse logs (plan-batch3 WP-CH): <c>query_log</c> (finished and failed queries), <c>text_log</c> (server log, when
/// enabled), <c>part_log</c> (part creation/merge/mutation/removal), <c>errors</c> (error counters with the last message);
/// activity: <c>system.processes</c> (KILL QUERY), unfinished <c>system.mutations</c> (KILL MUTATION) and <c>system.merges</c>.
/// </summary>
public sealed class ChLogSource(ISqlRunnerFactory runners) : ILogSource, IActivitySource
{
    public const string QueryLog = "query_log", TextLog = "text_log", PartLog = "part_log", Errors = "errors", Activity = "activity";

    public string ProviderId => "clickhouse";

    private readonly FactsCache<Facts> _facts = new();

    public sealed record Facts(string User, string Version, IReadOnlySet<string> Tables)
    {
        public string Needs(string table) => $"GRANT SELECT ON system.{table} TO {User};";
    }

    public static Facts ParseFacts(SqlRowSet p)
    {
        var r = p.Rows.FirstOrDefault() ?? throw EngineException.SourceUnavailable("The privilege probe returned no row.");
        var tables = (p.Str(r, "tables") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        return new Facts(p.Str(r, "user_name") ?? "default", p.Str(r, "version") ?? "", tables);
    }

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            return ParseFacts((await runner.QueryAsync(ChLogSql.Probe, c).ConfigureAwait(false))[0]);
        }, ct);

    /// <summary>ACCESS_DENIED (497) and friends.</summary>
    public static bool IsPrivilegeError(SqlQueryException ex) =>
        ex.Code is "497" or "516" || ex.Message.Contains("Not enough privileges", StringComparison.OrdinalIgnoreCase);

    public static IReadOnlyList<LogSourceInfo> Sources(Facts f)
    {
        LogSourceInfo S(string id, string title, bool tail, bool range, IReadOnlyList<string> levels, string table, string reason, string? needs = null)
        {
            var info = new LogSourceInfo(id, title, "log", tail, range, levels, true);
            return f.Tables.Contains(table) ? info : info.Unavailable(reason, needs);
        }
        return
        [
            S(QueryLog, "Query log", true, true, [LogLevels.Info, LogLevels.Warn, LogLevels.Error], "query_log",
                "system.query_log does not exist yet: it is created on the first flush (log_queries = 1 and query_log in the server config).",
                "SET log_queries = 1; SYSTEM FLUSH LOGS;"),
            S(TextLog, "Server log (text_log)", true, true, LogLevels.Standard, "text_log",
                "system.text_log is not enabled in the server configuration (<text_log> in config.xml)."),
            S(PartLog, "Part log", true, true, [LogLevels.Info, LogLevels.Error], "part_log",
                "system.part_log is not enabled in the server configuration (<part_log> in config.xml)."),
            S(Errors, "Error counters", false, false, [LogLevels.Error], "errors", "system.errors is not available on this server."),
            new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true),
        ];
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
        if (!info.Available) throw EngineException.Validation(info.Reason!, new { field = "sourceId" });
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var limit = LogFilter.LimitOf(query);
        var (from, to) = SqlServer.SqlServerLogSource.Range(query);
        // One more than the page so "older entries exist" is known; the filter runs again on the parsed entries.
        var fetch = Math.Min(limit * 2 + 1, 10_001);
        switch (query.SourceId)
        {
            case QueryLog:
            {
                var rows = await Run(runner, ChLogSql.QueryLog(from, to, query.Q, fetch), f.Needs("query_log"), ct).ConfigureAwait(false);
                return LogFilter.Page(ParseQueryLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            case TextLog:
            {
                var rows = await Run(runner, ChLogSql.TextLog(from, to, query.Q, fetch), f.Needs("text_log"), ct).ConfigureAwait(false);
                return LogFilter.Page(ParseTextLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            case PartLog:
            {
                var rows = await Run(runner, ChLogSql.PartLog(from, to, query.Q, fetch), f.Needs("part_log"), ct).ConfigureAwait(false);
                return LogFilter.Page(ParsePartLog(rows), query, sourceHasMore: rows.Rows.Count >= fetch);
            }
            default:
            {
                var rows = await Run(runner, ChLogSql.Errors, f.Needs("errors"), ct).ConfigureAwait(false);
                return LogFilter.Page(ParseErrors(rows), query with { From = null, To = null });
            }
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

    private static IEnumerable<object?[]> Ascending(SqlRowSet rows) => rows.Rows.Reverse();

    private static string Oneline(string? text, int max = 300)
    {
        var s = (text ?? "").ReplaceLineEndings(" ");
        return s.Length > max ? s[..max] + "…" : s;
    }

    public static List<LogEntry> ParseQueryLog(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var r in Ascending(rows))
        {
            var ts = rows.Time(r, "ts", TimeSpan.Zero);
            var type = rows.Str(r, "type") ?? "";
            var duration = rows.Long(r, "query_duration_ms") ?? 0;
            var failed = type.StartsWith("Exception", StringComparison.Ordinal);
            var level = failed ? LogLevels.Error : duration >= 1000 ? LogLevels.Warn : LogLevels.Info;
            var fields = new Dictionary<string, string>
            {
                ["type"] = type,
                ["durationMs"] = duration.ToString(CultureInfo.InvariantCulture),
                ["readRows"] = (rows.Long(r, "read_rows") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["readBytes"] = (rows.Long(r, "read_bytes") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["resultRows"] = (rows.Long(r, "result_rows") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["writtenRows"] = (rows.Long(r, "written_rows") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["memoryUsage"] = (rows.Long(r, "memory_usage") ?? 0).ToString(CultureInfo.InvariantCulture),
            };
            if (rows.Str(r, "query_id") is { Length: > 0 } qid) fields["queryId"] = qid;
            if (rows.Str(r, "user") is { Length: > 0 } u) fields["user"] = u;
            if (rows.Str(r, "db") is { Length: > 0 } db) fields["database"] = db;
            if (rows.Str(r, "kind") is { Length: > 0 } k) fields["kind"] = k;
            var query = rows.Str(r, "query") ?? "";
            var exception = rows.Str(r, "exception");
            var message = failed
                ? $"Failed after {duration} ms: {Oneline(exception, 200)} — {Oneline(query, 200)}"
                : $"{duration} ms, {fields["readRows"]} rows read, {fields["resultRows"]} returned: {Oneline(query)}";
            list.Add(new LogEntry(ts is { } t ? TimeSeq.Iso(t) : null, level, "query_log", message, seq.Next(ts),
                failed ? $"{exception}\n\n{query}" : query, fields));
        }
        return list;
    }

    public static string TextLevel(string? level) => level switch
    {
        "Fatal" or "Critical" => LogLevels.Fatal,
        "Error" => LogLevels.Error,
        "Warning" => LogLevels.Warn,
        "Notice" or "Information" => LogLevels.Info,
        "Debug" or "Trace" or "Test" => LogLevels.Debug,
        _ => LogLevels.Unknown,
    };

    public static List<LogEntry> ParseTextLog(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var r in Ascending(rows))
        {
            var ts = rows.Time(r, "ts", TimeSpan.Zero);
            var fields = new Dictionary<string, string>();
            if (rows.Str(r, "query_id") is { Length: > 0 } qid) fields["queryId"] = qid;
            if (rows.Str(r, "thread_name") is { Length: > 0 } th) fields["thread"] = th;
            var message = rows.Str(r, "message") ?? "";
            list.Add(new LogEntry(ts is { } t ? TimeSeq.Iso(t) : null, TextLevel(rows.Str(r, "level")), rows.Str(r, "logger_name") ?? "server",
                Oneline(message, 2000), seq.Next(ts), message.Length > 2000 || message.Contains('\n') ? message : null, fields.Count == 0 ? null : fields));
        }
        return list;
    }

    public static List<LogEntry> ParsePartLog(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var r in Ascending(rows))
        {
            var ts = rows.Time(r, "ts", TimeSpan.Zero);
            var type = rows.Str(r, "event_type") ?? "";
            var error = rows.Long(r, "error") ?? 0;
            var table = $"{rows.Str(r, "database")}.{rows.Str(r, "table")}";
            var fields = new Dictionary<string, string>
            {
                ["event"] = type,
                ["table"] = table,
                ["part"] = rows.Str(r, "part_name") ?? "",
                ["partitionId"] = rows.Str(r, "partition_id") ?? "",
                ["rows"] = (rows.Long(r, "rows") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["bytes"] = (rows.Long(r, "size_in_bytes") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["durationMs"] = (rows.Long(r, "duration_ms") ?? 0).ToString(CultureInfo.InvariantCulture),
            };
            if (rows.Str(r, "merged_from") is { Length: > 2 } mf) fields["mergedFrom"] = mf;
            var exception = rows.Str(r, "exception");
            var message = error != 0
                ? $"{type} {table} {fields["part"]} failed: {Oneline(exception, 300)}"
                : $"{type} {table} {fields["part"]}: {fields["rows"]} rows, {fields["bytes"]} bytes in {fields["durationMs"]} ms";
            list.Add(new LogEntry(ts is { } t ? TimeSeq.Iso(t) : null, error != 0 ? LogLevels.Error : LogLevels.Info, "part_log", message, seq.Next(ts),
                string.IsNullOrEmpty(exception) ? null : exception, fields));
        }
        return list;
    }

    public static List<LogEntry> ParseErrors(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var r in Ascending(rows))
        {
            var ts = rows.Time(r, "ts", TimeSpan.Zero);
            var name = rows.Str(r, "name") ?? "";
            var count = rows.Long(r, "value") ?? 0;
            var last = rows.Str(r, "last_error_message") ?? "";
            var fields = new Dictionary<string, string>
            {
                ["code"] = rows.Str(r, "code") ?? "",
                ["count"] = count.ToString(CultureInfo.InvariantCulture),
                ["remote"] = rows.Bool(r, "remote") ? "true" : "false",
            };
            list.Add(new LogEntry(ts is { } t ? TimeSeq.Iso(t) : null, LogLevels.Error, name,
                $"{name} ({fields["code"]}) × {count}: {Oneline(last)}", seq.Next(ts), last, fields));
        }
        return list;
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var processes = await Run(runner, ChLogSql.Processes, f.Needs("processes"), ct).ConfigureAwait(false);
        SqlRowSet? mutations = null, merges = null;
        try { mutations = await Run(runner, ChLogSql.Mutations, f.Needs("mutations"), ct).ConfigureAwait(false); }
        catch (EngineException) { }
        try { merges = await Run(runner, ChLogSql.Merges, f.Needs("merges"), ct).ConfigureAwait(false); }
        catch (EngineException) { }
        return ParseActivity(processes, mutations, merges);
    }

    public static List<ActivityRow> ParseActivity(SqlRowSet processes, SqlRowSet? mutations, SqlRowSet? merges)
    {
        var list = new List<ActivityRow>();
        foreach (var r in processes.Rows)
        {
            var qid = processes.Str(r, "query_id") ?? "";
            var elapsed = processes.Double(r, "elapsed") ?? 0;
            list.Add(new ActivityRow
            {
                Id = qid,
                Kind = "op",
                User = processes.Str(r, "user"),
                Host = processes.Str(r, "host"),
                App = processes.Str(r, "client_name"),
                Database = processes.Str(r, "db"),
                State = processes.Bool(r, "is_cancelled") ? "cancelling" : "running",
                DurationMs = (long)(elapsed * 1000),
                Command = processes.Str(r, "kind"),
                Text = processes.Str(r, "query"),
                Reads = processes.Double(r, "read_rows"),
                CanKill = true,
                Fields = new Dictionary<string, string>
                {
                    ["killStatement"] = ChLogSql.KillQuery(qid),
                    ["readBytes"] = (processes.Long(r, "read_bytes") ?? 0).ToString(CultureInfo.InvariantCulture),
                    ["memoryUsage"] = (processes.Long(r, "memory_usage") ?? 0).ToString(CultureInfo.InvariantCulture),
                },
            });
        }
        if (mutations is not null)
            foreach (var r in mutations.Rows)
            {
                var db = mutations.Str(r, "database") ?? "";
                var table = mutations.Str(r, "table") ?? "";
                var id = mutations.Str(r, "mutation_id") ?? "";
                var fail = mutations.Str(r, "latest_fail_reason");
                list.Add(new ActivityRow
                {
                    Id = $"mutation:{db}.{table}:{id}",
                    Kind = "op",
                    Database = db,
                    State = string.IsNullOrEmpty(fail) ? "mutating" : "failing",
                    Since = mutations.Str(r, "created"),
                    Command = "MUTATION",
                    Text = $"ALTER TABLE {db}.{table} {mutations.Str(r, "command")}",
                    WaitType = string.IsNullOrEmpty(fail) ? null : fail,
                    CanKill = true,
                    Fields = new Dictionary<string, string>
                    {
                        ["table"] = $"{db}.{table}",
                        ["mutationId"] = id,
                        ["partsToDo"] = (mutations.Long(r, "parts_to_do") ?? 0).ToString(CultureInfo.InvariantCulture),
                        ["killStatement"] = ChLogSql.KillMutation(db, table, id),
                    },
                });
            }
        if (merges is not null)
            foreach (var r in merges.Rows)
            {
                var db = merges.Str(r, "database") ?? "";
                var table = merges.Str(r, "table") ?? "";
                var part = merges.Str(r, "result_part_name") ?? "";
                var progress = merges.Double(r, "progress") ?? 0;
                list.Add(new ActivityRow
                {
                    Id = $"merge:{db}.{table}:{part}",
                    Kind = "op",
                    Database = db,
                    State = merges.Bool(r, "is_mutation") ? "mutating part" : "merging",
                    DurationMs = (long)((merges.Double(r, "elapsed") ?? 0) * 1000),
                    Command = "MERGE",
                    Text = $"{db}.{table}: {merges.Str(r, "num_parts")} parts → {part} ({progress * 100:0.#} %)",
                    CanKill = false,
                    Fields = new Dictionary<string, string>
                    {
                        ["table"] = $"{db}.{table}",
                        ["progress"] = progress.ToString("0.###", CultureInfo.InvariantCulture),
                        ["bytesCompressed"] = (merges.Long(r, "total_size_bytes_compressed") ?? 0).ToString(CultureInfo.InvariantCulture),
                        ["rowsRead"] = (merges.Long(r, "rows_read") ?? 0).ToString(CultureInfo.InvariantCulture),
                        ["memoryUsage"] = (merges.Long(r, "memory_usage") ?? 0).ToString(CultureInfo.InvariantCulture),
                    },
                });
            }
        return list;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var id = request.Id?.Trim();
        if (string.IsNullOrEmpty(id) || id.Length > 512) throw EngineException.Validation("id must be a query id or mutation:<db>.<table>:<mutation_id>.", new { field = "id" });
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        if (id.StartsWith("mutation:", StringComparison.Ordinal))
        {
            var m = ChLogSql.MutationId().Match(id);
            if (!m.Success) throw EngineException.Validation("id must be mutation:<db>.<table>:<mutation_id>.", new { field = "id" });
            var rows = await Run(runner, ChLogSql.KillMutation(m.Groups["db"].Value, m.Groups["table"].Value, m.Groups["id"].Value),
                $"GRANT KILL MUTATION ON {m.Groups["db"].Value}.* TO {f.User};", ct).ConfigureAwait(false);
            var ok = rows.Rows.Count > 0;
            return new LogKillResult(ok, ok ? $"Mutation {m.Groups["id"].Value} of {m.Groups["db"].Value}.{m.Groups["table"].Value} was killed."
                : "The mutation was not found (it finished or was already killed).");
        }
        if (id.StartsWith("merge:", StringComparison.Ordinal))
            throw EngineException.Validation("Merges cannot be killed (SYSTEM STOP MERGES stops new ones).", new { field = "id" });
        var killed = await Run(runner, ChLogSql.KillQuery(id), $"GRANT KILL QUERY ON *.* TO {f.User};", ct).ConfigureAwait(false);
        var found = killed.Rows.Count > 0;
        return new LogKillResult(found, found ? $"Query {id} was killed." : $"Query {id} was not running.");
    }
}
