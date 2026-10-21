using System.Text;
using DbStudio.Core.Services;
using DbStudio.Logs.Providers.Oracle;
using DbStudio.Logs.Providers.PostgreSql;
using DbStudio.Logs.Sql;
using static DbStudio.Logs.Tests.Rows;

namespace DbStudio.Logs.Tests;

public sealed class OracleLogTests
{
    private static SqlRowSet Probe(string version = "19.0.0.0.0", params (string K, string V)[] extra) =>
        Set(["k", "v"], [R("user", "APP"), R("version", version), R("sid", "77"), .. extra.Select(e => R(e.K, e.V))]);

    private static SqlRowSet AlertRows() => Set(["record_id", "originating_timestamp", "message_level", "message_type", "module_id", "process_id", "host_id", "message_text"],
        R(1203, "2026-10-18T13:02:11.213+00:00", 1, 2, null, "4711", "db01", "ORA-00600: internal error code, arguments: [kdsgrp1]"),
        R(1202, "2026-10-18T13:01:00.000+00:00", 16, 1, null, "4700", "db01", "Thread 1 advanced to log sequence 4211"),
        R(1201, "2026-10-18T13:00:00.000+00:00", 2, 1, null, "4700", "db01", "WARNING: Heavy swapping observed"));

    [Fact]
    public void Alert_sql_is_golden()
    {
        var sql = OracleLogSql.Alert(new DateTime(2026, 10, 18, 12, 0, 0), new DateTime(2026, 10, 18, 13, 0, 0), ["error", "warn"], "o'k", 500, null, 101);
        Assert.Equal("""
            SELECT record_id, originating_timestamp, message_level, message_type, module_id, process_id, host_id, message_text
            FROM v$diag_alert_ext
            WHERE component_id = 'rdbms'
              AND originating_timestamp >= FROM_TZ(TIMESTAMP '2026-10-18 12:00:00.000', 'UTC')
              AND originating_timestamp <= FROM_TZ(TIMESTAMP '2026-10-18 13:00:00.000', 'UTC')
              AND (message_level = 1 OR message_level = 2)
              AND UPPER(message_text) LIKE UPPER('%o''k%') ESCAPE '\'
              AND record_id < 500
            ORDER BY record_id DESC
            FETCH FIRST 101 ROWS ONLY
            """.ReplaceLineEndings("\n"), sql.ReplaceLineEndings("\n"));
        Assert.Contains("ORDER BY record_id\n", OracleLogSql.Alert(DateTime.MinValue, DateTime.MaxValue, null, null, null, 9, 5));
        Assert.Equal("1 = 0", OracleLogSql.LevelsSql(["unknown"]));
        Assert.Equal("(message_level > 2)", OracleLogSql.LevelsSql(["info"]));
    }

    [Theory]
    [InlineData(1L, 1L, "error")]
    [InlineData(2L, 1L, "warn")]
    [InlineData(16L, 1L, "info")]
    [InlineData(8L, 2L, "error")]
    [InlineData(null, null, "unknown")]
    public void Alert_levels(long? level, long? type, string expected) => Assert.Equal(expected, OracleLogSource.LevelOf(level, type));

    [Fact]
    public async Task Alert_query_uses_record_id_as_seq()
    {
        var runner = new FakeSqlRunner().On("session_privs", Probe(extra: ("role", "SELECT_CATALOG_ROLE"))).On("v$diag_alert_ext", AlertRows());
        var page = await new OracleLogSource(runner).QueryAsync(Target("oracle"), LogFilter.Validate(new LogQuery("alert", Limit: 2)), default);
        Assert.Equal([1202, 1203], page.Entries.Select(e => e.Seq));
        Assert.True(page.HasMore);
        Assert.Equal("error", page.Entries[1].Level);
        Assert.Equal("4711", page.Entries[1].Fields!["process_id"]);
    }

    [Fact]
    public async Task Lists_11g_and_missing_grants()
    {
        var old = await new OracleLogSource(new FakeSqlRunner().On("session_privs", Probe("11.2.0.4.0"))).ListAsync(Target("oracle"), default);
        Assert.False(old[0].Available);
        Assert.Contains("X$DBGALERTEXT", old[0].Reason);
        var app = await new OracleLogSource(new FakeSqlRunner().On("session_privs", Probe())).ListAsync(Target("oracle"), default);
        Assert.Equal("GRANT SELECT ON V_$DIAG_ALERT_EXT TO \"APP\";", app[0].Needs);
        Assert.Equal("GRANT AUDIT_VIEWER TO \"APP\";", app[1].Needs);
        Assert.False(app[2].Available);
        var dba = await new OracleLogSource(new FakeSqlRunner().On("session_privs", Probe(extra: ("role", "DBA")))).ListAsync(Target("oracle"), default);
        Assert.All(dba, s => Assert.True(s.Available));
    }

    [Fact]
    public async Task Ora_00942_maps_to_privilege()
    {
        var runner = new FakeSqlRunner().On("session_privs", Probe(extra: ("tab", "V_$DIAG_ALERT_EXT"))).OnFail("v$diag_alert_ext", "ORA-00942", "ORA-00942: table or view does not exist", 942);
        var ex = await Assert.ThrowsAsync<EngineException>(() => new OracleLogSource(runner).QueryAsync(Target("oracle"), LogFilter.Validate(new LogQuery("alert")), default));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
    }

    [Fact]
    public void Parses_audit_rows()
    {
        var rows = Set(["event_timestamp_utc", "dbusername", "os_username", "userhost", "client_program_name", "action_name", "object_schema", "object_name", "return_code", "unified_audit_policies", "sql_text"],
            R("2026-10-18T13:00:00", "APP", "app", "web-01", "JDBC", "LOGON", null, null, 1017, "ORA_LOGON_FAILURES", null),
            R("2026-10-18T12:00:00", "ETL", "etl", "etl-02", "sqlplus", "DROP TABLE", "SHOP", "TMP_ORDERS", 0, "ORA_SECURECONFIG", "DROP TABLE shop.tmp_orders"));
        var e = OracleLogSource.ParseAudit(rows);
        Assert.Equal("DROP TABLE SHOP.TMP_ORDERS by ETL", e[0].Message);
        Assert.Equal("info", e[0].Level);
        Assert.Equal("LOGON by APP failed (ORA-01017)", e[1].Message);
        Assert.Equal("warn", e[1].Level);
    }

    [Fact]
    public void Parses_activity_with_sid_serial_and_blockers()
    {
        var rows = Set(["sid", "serial#", "username", "osuser", "machine", "program", "module", "status", "schemaname", "logon_time", "last_call_et", "sql_exec_start", "event", "wait_class", "seconds_in_wait", "blocking_session", "blocking_instance", "sql_id", "command", "sql_text", "cpu_time", "buffer_gets"],
            R(123, 4567, "APP", "app", "web-01", "JDBC", null, "ACTIVE", "SHOP", "2026-10-18T08:00:00", 48, "2026-10-18T13:00:00", "enq: TX - row lock contention", "Application", 48, 98, 1, "abc", 6, "UPDATE orders SET status = :1", 1500, 12),
            R(98, 1201, "ETL", "etl", "etl-02", "sqlplus", null, "INACTIVE", "SHOP", "2026-10-18T07:00:00", 300, null, "SQL*Net message from client", "Idle", 300, null, null, null, 0, null, null, null));
        var a = OracleLogSource.ParseActivity(rows);
        Assert.Equal("123,4567", a[0].Id);
        Assert.Equal("98,1201", a[0].BlockedBy);
        Assert.Equal(48_000, a[0].DurationMs);
        Assert.Equal("enq: TX - row lock contention", a[0].WaitType);
        Assert.Null(a[1].WaitType); // idle wait class
        Assert.Equal("ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE", a[0].Fields!["killStatement"]);
    }

    [Fact]
    public async Task Kill_builds_alter_system_and_validates()
    {
        var runner = new FakeSqlRunner().On("session_privs", Probe(extra: ("priv", "ALTER SYSTEM")));
        var src = new OracleLogSource(runner);
        Assert.True((await src.KillAsync(Target("oracle"), new LogKillRequest("123,4567", "session"), default)).Killed);
        Assert.Contains("ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE", runner.Sql);
        var ex = await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("oracle"), new LogKillRequest("123", "session"), default));
        Assert.Equal("VALIDATION", ex.Code);
    }
}

public sealed class PgLogTests
{
    private static readonly string[] ProbeColumns =
    [
        "user_name", "version_num", "is_super", "is_monitor", "read_files", "signal_backend", "read_all_stats", "logging_collector", "log_destination",
        "log_directory", "log_timezone", "log_tz_offset_s", "has_pss", "cloud_markers",
    ];

    private static SqlRowSet Probe(bool super = true, string collector = "on", string destination = "stderr", string? cloud = null, bool monitor = false, bool files = false) =>
        Set(ProbeColumns, R("app", 170002, super, monitor, files, false, false, collector, destination, "log", "UTC", 0, true, cloud));

    [Fact]
    public void Parses_stderr_with_default_prefix_and_secondary_lines()
    {
        var entries = PgLogParser.ParseStderr(Rows.Fixture("pg-stderr.log"), TimeSpan.Zero);
        Assert.Equal(5, entries.Count);
        Assert.Equal("database system is ready to accept connections", entries[0].Message);
        Assert.Equal("LOG", entries[0].Severity);
        var err = entries[2];
        Assert.Equal("ERROR", err.Severity);
        Assert.Equal("duplicate key value violates unique constraint \"orders_pkey\"", err.Message);
        Assert.Equal("Key (id)=(1042) already exists.", err.Fields["detail"]);
        Assert.Equal("INSERT INTO orders (id, customer_id)\nVALUES (1042, 7);", err.Detail);
        Assert.Equal("app", err.Fields["user"]);
        Assert.Equal("shop", err.Fields["database"]);
        Assert.Equal("4321", err.Fields["pid"]);
        Assert.Equal(new DateTimeOffset(2026, 10, 18, 13, 2, 11, 213, TimeSpan.Zero), err.Ts);
        Assert.Equal("FATAL", entries[3].Severity);
        Assert.Equal(new DateTimeOffset(2026, 10, 18, 15, 5, 0, TimeSpan.FromHours(2)), entries[4].Ts);
    }

    [Fact]
    public void Parses_csvlog_with_multiline_fields()
    {
        var entries = PgLogParser.ParseCsv(Rows.Fixture("pg-csvlog.csv"), TimeSpan.Zero);
        Assert.Equal(2, entries.Count);
        Assert.Equal("ERROR", entries[0].Severity);
        Assert.Equal("relation \"x\" does not exist", entries[0].Message);
        Assert.Equal("select *\nfrom x", entries[0].Detail);
        Assert.Equal("42P01", entries[0].Fields["sqlstate"]);
        Assert.Equal("psql", entries[0].Fields["application"]);
        Assert.Equal("LOG", entries[1].Severity);
    }

    [Fact]
    public void Parses_jsonlog()
    {
        var entries = PgLogParser.ParseJson(Rows.Fixture("pg-jsonlog.json"), TimeSpan.Zero);
        Assert.Equal(2, entries.Count);
        Assert.Equal("WARNING", entries[1].Severity);
        Assert.Equal("there is no transaction in progress", entries[1].Message);
        Assert.Equal("4390", entries[1].Fields["pid"]);
        Assert.Equal("select * from x", entries[0].Detail);
        Assert.Equal(new DateTimeOffset(2026, 10, 18, 13, 2, 11, 213, TimeSpan.Zero), entries[0].Ts);
    }

    [Theory]
    [InlineData("DEBUG2", "debug")]
    [InlineData("LOG", "info")]
    [InlineData("NOTICE", "info")]
    [InlineData("WARNING", "warn")]
    [InlineData("ERROR", "error")]
    [InlineData("PANIC", "fatal")]
    public void Pg_levels(string severity, string level) => Assert.Equal(level, PgLogParser.LevelOf(severity));

    [Fact]
    public void Parses_zones()
    {
        Assert.Equal(TimeSpan.FromHours(-5), PgLogParser.ParseTime("2026-10-18 13:00:00", "-05", TimeSpan.Zero)!.Value.Offset);
        Assert.Equal(TimeSpan.FromHours(3), PgLogParser.ParseTime("2026-10-18 13:00:00", "MSK", TimeSpan.FromHours(3))!.Value.Offset);
        Assert.Equal(TimeSpan.Zero, PgLogParser.ParseTime("2026-10-18 13:00:00.5 UTC", TimeSpan.FromHours(3))!.Value.Offset);
    }

    [Fact]
    public void Server_log_availability()
    {
        Assert.True(PgLogSource.ServerLogInfo(PgLogSource.ParseFacts(Probe())).Available);
        var app = PgLogSource.ServerLogInfo(PgLogSource.ParseFacts(Probe(super: false)));
        Assert.False(app.Available);
        Assert.Equal("GRANT pg_monitor, pg_read_server_files TO \"app\";", app.Needs);
        Assert.True(PgLogSource.ServerLogInfo(PgLogSource.ParseFacts(Probe(super: false, monitor: true, files: true))).Available);
        var cloud = PgLogSource.ServerLogInfo(PgLogSource.ParseFacts(Probe(super: false, cloud: "rds.extensions")));
        Assert.False(cloud.Available);
        Assert.Null(cloud.Needs);
        Assert.Contains("logging_collector", PgLogSource.ServerLogInfo(PgLogSource.ParseFacts(Probe(collector: "off"))).Reason);
    }

    [Fact]
    public void Golden_sql()
    {
        Assert.Equal("SELECT pg_read_binary_file('log/postgresql-2026-10-18.log', 1048576, 4096, true) AS chunk", PgLogSql.ReadChunk("log/postgresql-2026-10-18.log", 1 << 20, 4096));
        Assert.Contains("total_exec_time", PgLogSql.StatStatements(160000, 10));
        Assert.Contains("total_time", PgLogSql.StatStatements(120000, 10));
        Assert.Contains("array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by", PgLogSql.Activity);
        Assert.Contains("CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_read_server_files') THEN pg_has_role", PgLogSql.Probe);
        Assert.Equal("SELECT pg_cancel_backend(42) AS ok", PgLogSql.Signal(42, false));
        Assert.Throws<EngineException>(() => PgLogSource.PathOf("log", "../../etc/passwd"));
        Assert.Equal("/var/log/pg/a.log", PgLogSource.PathOf("/var/log/pg/", "a.log"));
    }

    /// <summary>A fake server log file served by pg_ls_logdir + pg_read_binary_file with small chunks.</summary>
    private static FakeSqlRunner FileRunner(string content, string destination = "stderr", string name = "postgresql-2026-10-18.log")
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new FakeSqlRunner().On("current_user AS user_name", Probe(destination: destination))
            .On("pg_ls_logdir", Set(["name", "size", "modified"], R(name, (long)bytes.Length, "2026-10-18T13:10:00Z"), R("old.csv", 10L, "2026-10-17T00:00:00Z")))
            .On(s => s.Contains("pg_read_binary_file", StringComparison.Ordinal), sql =>
            {
                var parts = sql.Split(',');
                var offset = int.Parse(parts[1].Trim());
                var length = int.Parse(parts[2].Trim());
                return [Set(["chunk"], R(bytes.AsSpan(offset, length).ToArray()))];
            });
    }

    [Fact]
    public async Task Reads_the_server_log_backwards_across_chunk_boundaries()
    {
        var content = Rows.Fixture("pg-stderr.log");
        var runner = FileRunner(content);
        var src = new PgLogSource(runner) { ChunkBytes = 64 };
        var page = await src.QueryAsync(Target("postgresql"), LogFilter.Validate(new LogQuery("serverlog", Limit: 10)), default);
        Assert.Equal(5, page.Entries.Count);
        Assert.Equal("INSERT INTO orders (id, customer_id)\nVALUES (1042, 7);", page.Entries[2].Detail);
        Assert.DoesNotContain(runner.Sql, s => s.Contains("old.csv", StringComparison.Ordinal)); // stderr destination skips csv files
        Assert.True(runner.Sql.Count(s => s.Contains("pg_read_binary_file", StringComparison.Ordinal)) > 3);
        var errors = await src.QueryAsync(Target("postgresql"), LogFilter.Validate(new LogQuery("serverlog", Levels: ["error"])), default);
        Assert.Equal(["error", "fatal"], errors.Entries.Select(e => e.Level));
    }

    [Fact]
    public async Task Read_budget_reports_truncated()
    {
        var content = string.Concat(Enumerable.Range(0, 200).Select(i => $"2026-10-18 13:{i / 60:00}:{i % 60:00}.000 UTC [{i}] LOG:  line {i}\n"));
        var src = new PgLogSource(FileRunner(content)) { ChunkBytes = 512, ReadBudgetBytes = 2048 };
        var page = await src.QueryAsync(Target("postgresql"), LogFilter.Validate(new LogQuery("serverlog", Q: "no such text")), default);
        Assert.True(page.Truncated);
        Assert.Empty(page.Entries);
    }

    [Fact]
    public async Task Tail_cursor_stops_reading_at_older_entries()
    {
        var content = string.Concat(Enumerable.Range(0, 100).Select(i => $"2026-10-18 13:{i / 60:00}:{i % 60:00}.{i:000} UTC [{i}] LOG:  line {i}\n"));
        var runner = FileRunner(content);
        var src = new PgLogSource(runner) { ChunkBytes = 256 };
        var all = await src.QueryAsync(Target("postgresql"), LogFilter.Validate(new LogQuery("serverlog", Limit: 5000)), default);
        var cursor = all.Entries[^3].Seq;
        runner.Sql.Clear();
        var tail = await src.QueryAsync(Target("postgresql"), LogFilter.Validate(new LogQuery("serverlog", After: cursor)), default);
        Assert.Equal(2, tail.Entries.Count);
        Assert.True(runner.Sql.Count(s => s.Contains("pg_read_binary_file", StringComparison.Ordinal)) <= 2);
    }

    [Fact]
    public void Parses_activity_and_locks()
    {
        var s = Set(["pid", "usename", "client_addr", "client_hostname", "application_name", "datname", "state", "backend_start", "xact_start", "query_start", "wait_event_type", "wait_event", "blocked_by", "duration_ms", "lock_count", "query"],
            R(4321, "app", "10.0.0.5", null, "shop-api", "shop", "idle in transaction", "2026-10-18T10:00:00.000Z", "2026-10-18T13:00:00.000Z", "2026-10-18T13:00:00.000Z", "Client", "ClientRead", "", 180000L, 3L, "UPDATE stock SET qty = qty - 1"),
            R(4390, "app", "10.0.0.6", null, "shop-api", "shop", "active", null, null, "2026-10-18T13:02:00.000Z", "Lock", "transactionid", "4321", 41000L, 2L, "UPDATE stock SET qty = qty - 3"),
            R(4410, "postgres", "127.0.0.1", null, "psql", "shop", "idle", null, null, "2026-10-18T13:02:00.000Z", null, null, "", 99999L, 0L, "select 1"));
        var locks = Set(["pid", "locktype", "mode", "granted", "resource", "datname", "lock_count"], R(4390, "transactionid", "ShareLock", false, "transactionid", null, 1L));
        var rows = PgLogSource.ParseActivity(s, locks);
        Assert.Equal("4321", rows[1].BlockedBy);
        Assert.Equal("Lock:transactionid", rows[1].WaitType);
        Assert.Equal(180000, rows[0].DurationMs);
        Assert.Null(rows[2].DurationMs); // idle
        Assert.Equal("SELECT pg_terminate_backend(4390)", rows[1].Fields!["killStatement"]);
        Assert.Equal("SELECT pg_cancel_backend(4390)", rows[1].Fields!["cancelStatement"]);
        var lockRow = rows.Single(r => r.Kind == "lock");
        Assert.Equal("WAIT", lockRow.State);
        Assert.Equal("4321", lockRow.BlockedBy);
    }

    [Fact]
    public async Task Kill_cancel_and_terminate()
    {
        var runner = new FakeSqlRunner().On("current_user AS user_name", Probe()).On("pg_cancel_backend", Set(["ok"], R(true))).On("pg_terminate_backend", Set(["ok"], R(false)));
        var src = new PgLogSource(runner);
        var c = await src.KillAsync(Target("postgresql"), new LogKillRequest("4390", "session", "cancel"), default);
        Assert.True(c.Killed);
        Assert.Contains("cancelled", c.Message);
        var t = await src.KillAsync(Target("postgresql"), new LogKillRequest("4390", "session"), default);
        Assert.False(t.Killed);
        Assert.Contains(runner.Sql, x => x == "SELECT pg_terminate_backend(4390) AS ok");
        await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("postgresql"), new LogKillRequest("4390", "session", "explode"), default));
        var denied = new FakeSqlRunner().On("current_user AS user_name", Probe(super: false)).OnFail("pg_terminate_backend", "42501", "permission denied to terminate process");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new PgLogSource(denied).KillAsync(Target("postgresql"), new LogKillRequest("1", "session"), default));
        Assert.Equal("GRANT pg_signal_backend TO \"app\";", ex.Detail?.GetType().GetProperty("needs")?.GetValue(ex.Detail));
    }

    [Fact]
    public void Parses_pg_stat_statements_rank_order()
    {
        var rows = Set(["queryid", "calls", "total_ms", "mean_ms", "max_ms", "rows", "shared_blks_read", "user_name", "database_name", "query"],
            R("1", 10L, 22044.1, 2204.4, 5000.0, 10L, 0L, "app", "shop", "UPDATE stock SET qty = qty - $1"),
            R("2", 18234L, 9123.4, 0.5, 3.0, 1L, 0L, "app", "shop", "SELECT 1"));
        var e = PgLogSource.ParseStatStatements(rows);
        Assert.Equal("warn", e[0].Level);
        Assert.True(e[0].Seq > e[1].Seq);
        Assert.StartsWith("10 calls, 22044.1 ms total", e[0].Message);
    }
}
