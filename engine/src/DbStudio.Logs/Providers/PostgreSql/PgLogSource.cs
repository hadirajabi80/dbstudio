using System.Globalization;
using System.Text;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.PostgreSql;

/// <summary>The SQL of the PostgreSQL log and activity sources (golden-tested). Timestamps are rendered as UTC ISO text.</summary>
public static class PgLogSql
{
    private static string Role(string role) =>
        $"CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN pg_has_role(current_user, '{role}', 'USAGE') ELSE false END";

    private static string Setting(string name) => $"(SELECT setting FROM pg_settings WHERE name = '{name}')";

    public static readonly string Probe = $"""
        SELECT current_user AS user_name,
            current_setting('server_version_num')::int AS version_num,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_super,
            {Role("pg_monitor")} AS is_monitor,
            {Role("pg_read_server_files")} AS read_files,
            {Role("pg_signal_backend")} AS signal_backend,
            {Role("pg_read_all_stats")} AS read_all_stats,
            {Setting("logging_collector")} AS logging_collector,
            {Setting("log_destination")} AS log_destination,
            {Setting("log_directory")} AS log_directory,
            {Setting("log_timezone")} AS log_timezone,
            EXTRACT(EPOCH FROM (now() AT TIME ZONE COALESCE({Setting("log_timezone")}, 'UTC')) - (now() AT TIME ZONE 'UTC'))::int AS log_tz_offset_s,
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS has_pss,
            (SELECT string_agg(name, ',') FROM pg_settings WHERE name IN ('rds.extensions', 'azure.extensions', 'cloudsql.iam_authentication', 'neon.timeline_id', 'alloydb.iam_authentication')) AS cloud_markers
        """;

    public const string ListLogFiles = """
        SELECT name, size, to_char(modification AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS modified
        FROM pg_ls_logdir()
        ORDER BY modification DESC, name DESC
        LIMIT 50
        """;

    /// <summary>One byte range of a log file (binary, so a chunk may cut a UTF-8 sequence safely).</summary>
    public static string ReadChunk(string path, long offset, long length) =>
        $"SELECT pg_read_binary_file({SqlText.PgString(path)}, {SqlText.Int(offset)}, {SqlText.Int(length)}, true) AS chunk";

    public static string StatStatements(int versionNum, int top)
    {
        var (total, mean, max) = versionNum >= 130000 ? ("total_exec_time", "mean_exec_time", "max_exec_time") : ("total_time", "mean_time", "max_time");
        return $"""
            SELECT s.queryid, s.calls, s.{total} AS total_ms, s.{mean} AS mean_ms, s.{max} AS max_ms, s.rows, s.shared_blks_read,
                r.rolname AS user_name, d.datname AS database_name, left(s.query, 8000) AS query
            FROM pg_stat_statements s
            LEFT JOIN pg_roles r ON r.oid = s.userid
            LEFT JOIN pg_database d ON d.oid = s.dbid
            ORDER BY s.{total} DESC
            LIMIT {top}
            """;
    }

    private static string Iso(string col) => $"to_char({col} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

    public static readonly string Activity = $"""
        SELECT a.pid, a.usename, host(a.client_addr) AS client_addr, a.client_hostname, a.application_name, a.datname, a.state,
            {Iso("a.backend_start")} AS backend_start, {Iso("a.xact_start")} AS xact_start, {Iso("a.query_start")} AS query_start,
            a.wait_event_type, a.wait_event, array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by,
            (EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000)::bigint AS duration_ms,
            (SELECT count(*) FROM pg_locks l WHERE l.pid = a.pid) AS lock_count,
            left(a.query, 8000) AS query
        FROM pg_stat_activity a
        WHERE a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'
        ORDER BY (a.state = 'active') DESC, a.query_start NULLS LAST
        LIMIT 1000
        """;

    public const string Locks = """
        SELECT l.pid, l.locktype, l.mode, l.granted, COALESCE(c.relname, l.locktype) AS resource, d.datname, count(*) AS lock_count
        FROM pg_locks l
        LEFT JOIN pg_class c ON c.oid = l.relation
        LEFT JOIN pg_database d ON d.oid = l.database
        WHERE l.pid <> pg_backend_pid() AND l.locktype <> 'virtualxid'
        GROUP BY l.pid, l.locktype, l.mode, l.granted, COALESCE(c.relname, l.locktype), d.datname
        ORDER BY l.pid
        LIMIT 2000
        """;

    public static string Signal(int pid, bool terminate) => $"SELECT {(terminate ? "pg_terminate_backend" : "pg_cancel_backend")}({pid}) AS ok";
}

/// <summary>
/// PostgreSQL (docs/PLAN-M2.md 8.1): <c>serverlog</c> (pg_ls_logdir + pg_read_binary_file, read backwards in chunks, stderr /
/// csvlog / jsonlog), <c>pg_stat_statements</c> and activity (pg_stat_activity, pg_blocking_pids, pg_locks; cancel /
/// terminate).
/// </summary>
public sealed class PgLogSource(ISqlRunnerFactory runners) : ILogSource, IActivitySource
{
    public const string ServerLog = "serverlog", StatStatements = "pg_stat_statements", Activity = "activity";

    /// <summary>Bytes read per round trip and per query (the query reports <c>truncated</c> past the budget).</summary>
    public int ChunkBytes { get; init; } = 1 << 20;
    public long ReadBudgetBytes { get; init; } = 8L << 20;

    public string ProviderId => "postgresql";

    private readonly FactsCache<Facts> _facts = new();

    public sealed record Facts(string User, int VersionNum, bool Super, bool Monitor, bool ReadFiles, bool Signal, bool ReadAllStats,
        bool Collector, string Destination, string? LogDirectory, TimeSpan LogOffset, bool HasPss, string? CloudMarkers)
    {
        public string Quoted => "\"" + User.Replace("\"", "\"\"") + "\"";
        public bool FilesAllowed => Super || (Monitor && ReadFiles);
        public string FilesNeeds => $"GRANT pg_monitor, pg_read_server_files TO {Quoted};";
        public string SignalNeeds => $"GRANT pg_signal_backend TO {Quoted};";
        public string StatsNeeds => $"GRANT pg_read_all_stats TO {Quoted};";

        public PgLogParser.Format Format =>
            Destination.Contains("jsonlog", StringComparison.OrdinalIgnoreCase) ? PgLogParser.Format.Json
            : Destination.Contains("csvlog", StringComparison.OrdinalIgnoreCase) ? PgLogParser.Format.Csv
            : PgLogParser.Format.Stderr;

        public bool Matches(string fileName) => Format switch
        {
            PgLogParser.Format.Json => fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase),
            PgLogParser.Format.Csv => fileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase),
            _ => !fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase) && !fileName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase),
        };
    }

    public static Facts ParseFacts(SqlRowSet p)
    {
        var r = p.Rows.FirstOrDefault() ?? throw EngineException.SourceUnavailable("The privilege probe returned no row.");
        return new Facts(p.Str(r, "user_name") ?? "", (int)(p.Long(r, "version_num") ?? 0), p.Bool(r, "is_super"), p.Bool(r, "is_monitor"),
            p.Bool(r, "read_files"), p.Bool(r, "signal_backend"), p.Bool(r, "read_all_stats"), p.Str(r, "logging_collector") == "on",
            p.Str(r, "log_destination") ?? "stderr", p.Str(r, "log_directory"), TimeSpan.FromSeconds(p.Long(r, "log_tz_offset_s") ?? 0),
            p.Bool(r, "has_pss"), p.Str(r, "cloud_markers"));
    }

    /// <summary>"42501" insufficient_privilege.</summary>
    public static bool IsPrivilegeError(SqlQueryException ex) => ex.Code is "42501" || ex.Message.Contains("permission denied", StringComparison.OrdinalIgnoreCase);

    private Task<Facts> FactsAsync(LogTarget target, CancellationToken ct) =>
        _facts.GetAsync(target.ConnectionId, async c =>
        {
            var runner = await runners.GetAsync(target, c).ConfigureAwait(false);
            return ParseFacts((await runner.QueryAsync(PgLogSql.Probe, c).ConfigureAwait(false))[0]);
        }, ct);

    public static LogSourceInfo ServerLogInfo(Facts f)
    {
        var info = new LogSourceInfo(ServerLog, "Server log", "log", true, true, LogLevels.Standard, true);
        if (!string.IsNullOrEmpty(f.CloudMarkers) && !f.Super)
            return info.Unavailable("This managed PostgreSQL service does not allow reading log files through SQL; use the provider's log console.", null);
        if (!f.FilesAllowed)
            return info.Unavailable("Reading server log files requires superuser or the pg_monitor and pg_read_server_files roles.", f.FilesNeeds);
        if (!f.Collector)
            return info.Unavailable("logging_collector is off: the server writes its log to stderr, which SQL cannot read.",
                "ALTER SYSTEM SET logging_collector = on; -- then restart the server");
        return info;
    }

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        _facts.Invalidate(target.ConnectionId);
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var pss = new LogSourceInfo(StatStatements, "pg_stat_statements (top statements)", "log", false, true, [LogLevels.Info, LogLevels.Warn], true);
        if (!f.HasPss) pss = pss.Unavailable("The pg_stat_statements extension is not installed in this database.", "CREATE EXTENSION pg_stat_statements; -- needs shared_preload_libraries = 'pg_stat_statements'");
        else if (!f.Super && !f.ReadAllStats) pss = pss with { Reason = "Without pg_read_all_stats other users' statements show as <insufficient privilege>.", Needs = f.StatsNeeds };
        var activity = new LogSourceInfo(Activity, "Activity", "activity", false, false, [], true);
        if (!f.Super && !f.ReadAllStats && !f.Monitor)
            activity = activity with { Reason = "Without pg_read_all_stats the statements of other users are hidden.", Needs = f.StatsNeeds };
        return [ServerLogInfo(f), pss, activity];
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        switch (query.SourceId)
        {
            case ServerLog:
            {
                var info = ServerLogInfo(f);
                if (!info.Available)
                {
                    if (info.Needs is not null && !f.FilesAllowed) throw EngineException.Privilege(info.Reason!, info.Needs);
                    throw EngineException.Validation(info.Reason!, new { field = "sourceId" });
                }
                return await ReadServerLogAsync(runner, f, query, ct).ConfigureAwait(false);
            }
            case StatStatements:
            {
                if (!f.HasPss) throw EngineException.Validation("pg_stat_statements is not installed.", new { field = "sourceId" });
                var limit = LogFilter.LimitOf(query);
                var rows = await Run(runner, PgLogSql.StatStatements(f.VersionNum, limit), f.StatsNeeds, ct).ConfigureAwait(false);
                return LogFilter.Page(ParseStatStatements(rows), query with { From = null, To = null });
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

    /// <summary>Joins the log directory and a file name from pg_ls_logdir (names with path separators are refused).</summary>
    public static string PathOf(string? logDirectory, string name)
    {
        if (name.Contains('/') || name.Contains('\\') || name.Contains("..", StringComparison.Ordinal))
            throw EngineException.Validation($"Unexpected log file name '{name}'.");
        var dir = string.IsNullOrEmpty(logDirectory) ? "log" : logDirectory.TrimEnd('/', '\\');
        return dir + "/" + name;
    }

    /// <summary>
    /// Reads the newest log files backwards in <see cref="ChunkBytes"/> pieces, cutting on entry boundaries, until the
    /// page is full, the entries are older than <c>from</c>/<c>after</c>, or the read budget is used (truncated).
    /// </summary>
    public async Task<LogQueryResponse> ReadServerLogAsync(ISqlRunner runner, Facts f, LogQuery query, CancellationToken ct)
    {
        var limit = LogFilter.LimitOf(query);
        var files = (await Run(runner, PgLogSql.ListLogFiles, f.FilesNeeds, ct).ConfigureAwait(false)).Rows
            .Select(r => (Name: SqlCells.Str(r[0]) ?? "", Size: SqlCells.Long(r[1]) ?? 0))
            .Where(x => x.Name.Length > 0 && f.Matches(x.Name)).ToList();
        var stopBefore = query.After is { } a ? TimeSeq.ToTime(a) : query.From;
        var collected = new List<PgLogParser.PgEntry>();
        long budget = ReadBudgetBytes;
        var truncated = false;
        var done = false;
        foreach (var (name, size) in files)
        {
            if (done) break;
            var path = PathOf(f.LogDirectory, name);
            var pos = size;
            byte[] carry = [];
            while (pos > 0 || carry.Length > 0)
            {
                if (budget <= 0) { truncated = true; done = true; break; }
                var start = Math.Max(0, pos - ChunkBytes);
                byte[] data;
                if (pos > start)
                {
                    var rows = await Run(runner, PgLogSql.ReadChunk(path, start, pos - start), f.FilesNeeds, ct).ConfigureAwait(false);
                    var chunk = rows.Rows.FirstOrDefault()?[0] as byte[] ?? [];
                    budget -= chunk.Length;
                    data = Concat(chunk, carry);
                }
                else data = carry;
                pos = start;
                int cut = 0;
                if (start > 0)
                {
                    cut = FirstEntryStart(data, f.Format);
                    if (cut < 0) { carry = data; continue; } // no entry start yet: read further back
                }
                carry = data[..cut];
                var text = Encoding.UTF8.GetString(data, cut, data.Length - cut);
                var parsed = PgLogParser.Parse(text, f.Format, f.LogOffset);
                collected.InsertRange(0, parsed);
                if (start == 0) carry = [];
                var matched = collected.Count(e => (query.Levels is null || LogLevels.Matches(PgLogParser.LevelOf(e.Severity), query.Levels)));
                var oldest = parsed.FirstOrDefault(e => e.Ts is not null)?.Ts;
                if (stopBefore is { } sb && oldest is { } o && o < sb) { done = true; break; }
                if (matched > limit * 2 && query.Before is null && query.After is null) { done = true; break; }
                if (query.Before is { } bf && collected.Count(e => e.Ts is { } t && t < TimeSeq.ToTime(bf)) > limit * 2) { done = true; break; }
            }
        }
        var entries = PgLogParser.ToEntries(collected, new TimeSeq());
        return LogFilter.Page(entries, query, truncated, sourceHasMore: truncated);
    }

    private static byte[] Concat(byte[] a, byte[] b)
    {
        if (b.Length == 0) return a;
        var r = new byte[a.Length + b.Length];
        a.CopyTo(r, 0);
        b.CopyTo(r, a.Length);
        return r;
    }

    /// <summary>Byte index of the first line in <paramref name="data"/> (after the first newline) that starts an entry, or -1.</summary>
    public static int FirstEntryStart(byte[] data, PgLogParser.Format format)
    {
        var i = Array.IndexOf(data, (byte)'\n');
        while (i >= 0 && i + 1 < data.Length)
        {
            var lineStart = i + 1;
            var end = Array.IndexOf(data, (byte)'\n', lineStart);
            var len = Math.Min((end < 0 ? data.Length : end) - lineStart, 256);
            var head = Encoding.UTF8.GetString(data, lineStart, Math.Max(0, len));
            if (PgLogParser.IsEntryStart(head, format)) return lineStart;
            i = end;
        }
        return -1;
    }

    public static List<LogEntry> ParseStatStatements(SqlRowSet rows)
    {
        var list = new List<LogEntry>();
        var n = rows.Rows.Count;
        for (var i = 0; i < n; i++)
        {
            var r = rows.Rows[i];
            var mean = rows.Double(r, "mean_ms") ?? 0;
            var fields = new Dictionary<string, string>
            {
                ["calls"] = (rows.Long(r, "calls") ?? 0).ToString(CultureInfo.InvariantCulture),
                ["totalMs"] = (rows.Double(r, "total_ms") ?? 0).ToString("0.###", CultureInfo.InvariantCulture),
                ["meanMs"] = mean.ToString("0.###", CultureInfo.InvariantCulture),
                ["maxMs"] = (rows.Double(r, "max_ms") ?? 0).ToString("0.###", CultureInfo.InvariantCulture),
                ["rows"] = (rows.Long(r, "rows") ?? 0).ToString(CultureInfo.InvariantCulture),
            };
            if (rows.Str(r, "queryid") is { } qid) fields["queryid"] = qid;
            if (rows.Str(r, "user_name") is { } u) fields["user"] = u;
            if (rows.Str(r, "database_name") is { } d) fields["database"] = d;
            var query = rows.Str(r, "query") ?? "";
            var first = query.ReplaceLineEndings(" ");
            if (first.Length > 300) first = first[..300] + "…";
            // Rank order: the top statement gets the highest seq so "newest last" reads as "heaviest last".
            list.Add(new LogEntry(null, mean >= 1000 ? LogLevels.Warn : LogLevels.Info, "pg_stat_statements",
                $"{fields["calls"]} calls, {fields["totalMs"]} ms total, {fields["meanMs"]} ms mean: {first}", n - i, query, fields));
        }
        return list;
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var sessions = await Run(runner, PgLogSql.Activity, f.StatsNeeds, ct).ConfigureAwait(false);
        SqlRowSet? locks = null;
        try { locks = await Run(runner, PgLogSql.Locks, f.StatsNeeds, ct).ConfigureAwait(false); }
        catch (EngineException) { }
        return ParseActivity(sessions, locks);
    }

    public static List<ActivityRow> ParseActivity(SqlRowSet s, SqlRowSet? locks)
    {
        var list = new List<ActivityRow>();
        var blockedBy = new Dictionary<string, string>();
        foreach (var r in s.Rows)
        {
            var pid = s.Str(r, "pid") ?? "";
            var state = s.Str(r, "state") ?? "unknown";
            var blockers = s.Str(r, "blocked_by");
            var first = string.IsNullOrEmpty(blockers) ? null : blockers.Split(',')[0];
            if (first is not null) blockedBy[pid] = first;
            var fields = new Dictionary<string, string>
            {
                ["killStatement"] = PgLogSql.Signal(int.TryParse(pid, out var p) ? p : 0, true).Replace(" AS ok", ""),
                ["cancelStatement"] = PgLogSql.Signal(int.TryParse(pid, out var p2) ? p2 : 0, false).Replace(" AS ok", ""),
            };
            if (!string.IsNullOrEmpty(blockers)) fields["blockedByAll"] = blockers;
            if (s.Str(r, "lock_count") is { } lc) fields["locks"] = lc;
            if (s.Str(r, "xact_start") is { } xs) fields["xactStart"] = xs;
            if (s.Str(r, "backend_start") is { } bs) fields["backendStart"] = bs;
            if (s.Str(r, "wait_event_type") is { } wet) fields["waitEventType"] = wet;
            var waitEvent = s.Str(r, "wait_event");
            list.Add(new ActivityRow
            {
                Id = pid,
                Kind = "session",
                User = s.Str(r, "usename"),
                Host = s.Str(r, "client_hostname") ?? s.Str(r, "client_addr"),
                App = s.Str(r, "application_name"),
                Database = s.Str(r, "datname"),
                State = state,
                Since = s.Str(r, "query_start"),
                DurationMs = state is "active" or "idle in transaction" or "idle in transaction (aborted)" ? s.Long(r, "duration_ms") : null,
                WaitType = waitEvent is null ? null : $"{s.Str(r, "wait_event_type")}:{waitEvent}",
                BlockedBy = first,
                Text = s.Str(r, "query"),
                CanKill = true,
                Fields = fields,
            });
        }
        if (locks is not null)
            foreach (var l in locks.Rows)
            {
                var pid = locks.Str(l, "pid") ?? "";
                var granted = locks.Bool(l, "granted");
                list.Add(new ActivityRow
                {
                    Id = $"lock:{pid}:{locks.Str(l, "locktype")}:{locks.Str(l, "mode")}:{(granted ? "GRANT" : "WAIT")}:{locks.Str(l, "resource")}",
                    Kind = "lock",
                    Database = locks.Str(l, "datname"),
                    State = granted ? "GRANT" : "WAIT",
                    BlockedBy = granted ? null : blockedBy.GetValueOrDefault(pid),
                    CanKill = false,
                    Fields = new Dictionary<string, string>
                    {
                        ["owner"] = pid, ["resource"] = locks.Str(l, "resource") ?? "", ["mode"] = locks.Str(l, "mode") ?? "",
                        ["count"] = locks.Str(l, "lock_count") ?? "0",
                    },
                });
            }
        return list;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        if (!int.TryParse(request.Id, NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid < 1)
            throw EngineException.Validation("id must be a backend pid.", new { field = "id" });
        var terminate = request.Mode is null or "terminate";
        if (request.Mode is not (null or "terminate" or "cancel"))
            throw EngineException.Validation("mode must be 'cancel' or 'terminate'.", new { field = "mode" });
        var f = await FactsAsync(target, ct).ConfigureAwait(false);
        var runner = await runners.GetAsync(target, ct).ConfigureAwait(false);
        var rows = await Run(runner, PgLogSql.Signal(pid, terminate), f.SignalNeeds, ct).ConfigureAwait(false);
        var ok = rows.Rows.Count > 0 && SqlCells.Bool(rows.Rows[0][0]);
        return new LogKillResult(ok, ok
            ? terminate ? $"Backend {pid} was terminated." : $"The query of backend {pid} was cancelled."
            : $"Backend {pid} was not signalled (it is gone or belongs to a superuser).");
    }
}
