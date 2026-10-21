using DbStudio.Core.Services;
using DbStudio.Logs.Providers.SqlServer;
using DbStudio.Logs.Sql;
using static DbStudio.Logs.Tests.Rows;

namespace DbStudio.Logs.Tests;

public sealed class SqlServerLogTests
{
    private static readonly string[] ProbeColumns =
    [
        "login_name", "engine_edition", "product_version", "is_sysadmin", "is_securityadmin", "view_server_state", "view_any_error_log",
        "alter_any_connection", "utc_offset_minutes", "has_agent",
    ];

    private static SqlRowSet Probe(bool admin = true, int edition = 3, string version = "16.0.4135.4", bool vss = true, int offset = 120, bool agent = true) =>
        Set(ProbeColumns, R("app", edition, version, admin ? 1 : 0, 0, vss ? 1 : 0, admin ? 1 : 0, admin ? 1 : 0, offset, agent ? 1 : 0));

    private static readonly SqlRowSet Archives = Set(["Archive #", "Date", "Log File Size (Byte)"],
        R(0, "2026-10-18T09:00:00", 40960), R(1, "2026-10-11T09:00:00", 81920));

    /// <summary>Recorded xp_readerrorlog rows (newest first, as 'desc' returns them).</summary>
    private static SqlRowSet ErrorLogRows() => Set(["LogDate", "ProcessInfo", "Text"],
        R("2026-10-18T14:02:11.213", "Logon", "Login failed for user 'app'. Reason: Password did not match that for the login provided. [CLIENT: 10.0.4.17]"),
        R("2026-10-18T14:02:11.213", "Logon", "Error: 18456, Severity: 14, State: 8."),
        R("2026-10-18T14:01:59.004", "Backup", "Database backed up. Database: Shop, creation date(time): 2026/10/18(02:00:01)."),
        R("2026-10-18T13:58:00.100", "spid52", "Could not allocate space for object 'dbo.Orders'.'PK_Orders' in database 'Shop' because the 'PRIMARY' filegroup is full."),
        R("2026-10-18T13:58:00.100", "spid52", "Error: 1105, Severity: 17, State: 2."),
        R("2026-10-18T13:00:00.000", "Server", "SQL Server is starting at normal priority base (=7)."));

    [Fact]
    public void Probe_parses_privileges_and_builds_grants()
    {
        var f = SqlServerLogSource.ParseFacts(Probe(admin: false, version: "15.0.2000.5", vss: false));
        Assert.False(f.ErrorLogAllowed);
        Assert.Equal("ALTER SERVER ROLE securityadmin ADD MEMBER [app];", f.ErrorLogNeeds);
        Assert.Equal("GRANT VIEW SERVER STATE TO [app];", f.ServerStateNeeds);
        Assert.Equal(TimeSpan.FromMinutes(120), f.Offset);
        var f22 = SqlServerLogSource.ParseFacts(Probe(admin: false, version: "16.0.1000.6"));
        Assert.Equal("GRANT VIEW ANY ERROR LOG TO [app];", f22.ErrorLogNeeds);
    }

    [Fact]
    public async Task Lists_sources_with_archives_when_allowed()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe()).On("sp_enumerrorlogs 1", Archives).On("sp_enumerrorlogs 2", Archives);
        var list = await new SqlServerLogSource(runner).ListAsync(Target("sqlserver"), default);
        Assert.Equal(["errorlog", "agentlog", "system_health", "activity"], list.Select(s => s.Id));
        Assert.All(list, s => Assert.True(s.Available));
        Assert.Equal([0, 1], list[0].Archives!.Select(a => a.Index));
        Assert.Equal(40960, list[0].Archives![0].SizeBytes);
        Assert.Equal("activity", list[3].Kind);
    }

    [Fact]
    public async Task Lists_privilege_hints_when_denied()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe(admin: false, vss: false));
        var list = await new SqlServerLogSource(runner).ListAsync(Target("sqlserver"), default);
        Assert.False(list[0].Available);
        Assert.Equal("GRANT VIEW ANY ERROR LOG TO [app];", list[0].Needs);
        Assert.False(list[2].Available);
        Assert.Equal("GRANT VIEW SERVER STATE TO [app];", list[2].Needs);
        Assert.True(list[3].Available); // own sessions are still visible
        Assert.NotNull(list[3].Reason);
        Assert.DoesNotContain(runner.Sql, s => s.Contains("sp_enumerrorlogs", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Azure_sql_database_has_no_error_log()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe(edition: 5));
        var list = await new SqlServerLogSource(runner).ListAsync(Target("sqlserver"), default);
        Assert.False(list[0].Available);
        Assert.Null(list[0].Needs);
        Assert.Contains("Azure", list[0].Reason);
    }

    [Fact]
    public void Error_log_sql_is_golden()
    {
        var sql = SqlServerLogSql.ReadErrorLog(2, 1, "it's", new DateTime(2026, 10, 18, 13, 0, 0), new DateTime(2026, 10, 18, 14, 0, 0, 500), 1001);
        Assert.Equal("""
            SET NOCOUNT ON;
            DECLARE @from datetime = '2026-10-18T13:00:00.000', @to datetime = '2026-10-18T14:00:00.500';
            IF OBJECT_ID(N'tempdb..#dbstudio_log') IS NOT NULL DROP TABLE #dbstudio_log;
            CREATE TABLE #dbstudio_log (id int IDENTITY(1,1) NOT NULL, LogDate datetime NULL, ProcessInfo nvarchar(100) NULL, [Text] nvarchar(max) NULL);
            INSERT INTO #dbstudio_log (LogDate, ProcessInfo, [Text]) EXEC master.dbo.xp_readerrorlog 2, 1, N'it''s', NULL, @from, @to, N'desc';
            SELECT TOP (1001) LogDate, ProcessInfo, [Text] FROM #dbstudio_log ORDER BY id;
            DROP TABLE #dbstudio_log;
            """, sql);
        var agent = SqlServerLogSql.ReadErrorLog(0, 2, null, new DateTime(1900, 1, 1), new DateTime(9999, 12, 30), 10);
        Assert.Contains("ErrorLevel int NULL", agent);
        Assert.Contains("xp_readerrorlog 0, 2, NULL, NULL", agent);
    }

    [Fact]
    public void Parses_error_log_rows_merging_error_lines()
    {
        var entries = SqlServerLogParser.ParseErrorLog(ErrorLogRows(), 1, TimeSpan.FromHours(2));
        Assert.Equal(4, entries.Count);
        Assert.Equal("SQL Server is starting at normal priority base (=7).", entries[0].Message);
        Assert.Equal("info", entries[0].Level);
        var full = entries[1];
        Assert.Equal("error", full.Level); // severity 17
        Assert.StartsWith("Could not allocate space", full.Message);
        Assert.Equal("1105", full.Fields!["error"]);
        Assert.Equal("Error: 1105, Severity: 17, State: 2.", full.Detail);
        var login = entries[3];
        Assert.Equal("warn", login.Level);
        Assert.Equal("18456", login.Fields!["error"]);
        Assert.Equal("2026-10-18T14:02:11.213+02:00", login.Ts);
        Assert.True(entries.Zip(entries.Skip(1)).All(p => p.First.Seq < p.Second.Seq));
    }

    [Theory]
    [InlineData("Login failed for user 'x'.", null, "warn")]
    [InlineData("Error: 823, Severity: 24, State: 2.", null, "fatal")]
    [InlineData("Error: 50000, Severity: 10, State: 1.", null, "info")]
    [InlineData("Stack Dump being sent to C:\\dump", null, "fatal")]
    [InlineData("Recovery is complete.", null, "info")]
    [InlineData("anything", 16, "error")]
    public void Error_log_levels(string text, int? severity, string level) => Assert.Equal(level, SqlServerLogParser.LevelOf(text, severity));

    [Fact]
    public void Agent_log_levels_come_from_error_level()
    {
        var rows = Set(["LogDate", "ErrorLevel", "Text"], R("2026-10-18T10:00:00", 1, "[298] SQLServer Error: 18456"), R("2026-10-18T09:00:00", 2, "[396] idle CPU"));
        var entries = SqlServerLogParser.ParseErrorLog(rows, 2, TimeSpan.Zero);
        Assert.Equal(["warn", "error"], entries.Select(e => e.Level));
        Assert.All(entries, e => Assert.Equal("SQLAgent", e.Source));
    }

    [Fact]
    public async Task Query_converts_times_to_server_local_and_pages()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe()).On("xp_readerrorlog", ErrorLogRows());
        var src = new SqlServerLogSource(runner);
        var q = LogFilter.Validate(new LogQuery("errorlog", From: DateTimeOffset.Parse("2026-10-18T11:00:00Z"), To: DateTimeOffset.Parse("2026-10-18T12:30:00Z"), Q: "Login", Limit: 3));
        var page = await src.QueryAsync(Target("sqlserver"), q, default);
        var sql = runner.Sql.Single(s => s.Contains("xp_readerrorlog", StringComparison.Ordinal));
        Assert.Contains("@from datetime = '2026-10-18T13:00:00.000', @to datetime = '2026-10-18T14:30:00.000'", sql);
        Assert.Contains("N'Login'", sql);
        Assert.Contains("TOP (4)", sql);
        Assert.Single(page.Entries); // engine-side q filter keeps only the login line
        Assert.Equal("warn", page.Entries[0].Level);
    }

    [Fact]
    public async Task Denied_error_log_maps_to_privilege()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe(admin: true)).OnFail("xp_readerrorlog", "15003", "Only members of the securityadmin role can execute this stored procedure.");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new SqlServerLogSource(runner).QueryAsync(Target("sqlserver"), LogFilter.Validate(new LogQuery("errorlog")), default));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
        Assert.Equal(403, ex.Status);
    }

    [Fact]
    public void System_health_sql_is_golden()
    {
        var sql = SqlServerLogSql.SystemHealth(new DateTime(2026, 10, 18, 12, 0, 0), new DateTime(2026, 10, 18, 13, 0, 0), "50%", 11);
        Assert.Contains("WHERE s.name = N'system_health' AND t.target_name = N'ring_buffer'", sql);
        Assert.Contains("SELECT TOP (11) ev.ts, ev.name, CAST(ev.data AS nvarchar(max)) AS event_xml", sql);
        Assert.Contains("ev.name IN (N'error_reported', N'wait_info', N'wait_info_external', N'xml_deadlock_report', N'security_error_ring_buffer_recorded', N'connectivity_ring_buffer_recorded')", sql);
        Assert.Contains("AND ev.ts >= '2026-10-18T12:00:00.000' AND ev.ts <= '2026-10-18T13:00:00.000'", sql);
        Assert.Contains("LIKE N'%50[%]%'", sql);
    }

    [Fact]
    public void Parses_xe_error_reported()
    {
        var e = SqlServerLogParser.ParseXeEvent("error_reported", Fixture("sqlserver-xe-error.xml"));
        Assert.Equal("warn", e.Level); // severity 13: user-correctable
        Assert.Equal("Error 1205, severity 13: Transaction (Process ID 73) was deadlocked on lock resources.", e.Message);
        Assert.Equal("SERVER", e.Fields!["category"]);
        Assert.Equal("73", e.Fields!["session_id"]);
        Assert.Equal("UPDATE dbo.Orders SET Status = 2", e.Detail);
        Assert.Equal("2026-10-18T12:01:02.345Z", e.Ts);
    }

    [Fact]
    public void Parses_xe_deadlock_report()
    {
        var e = SqlServerLogParser.ParseXeEvent("xml_deadlock_report", Fixture("sqlserver-xe-deadlock.xml"));
        Assert.Equal("error", e.Level);
        Assert.Equal("Deadlock between 2 processes (sessions 61, 57); victim session 61", e.Message);
        Assert.Equal("61", e.Fields!["victim"]);
        Assert.StartsWith("<deadlock>", e.Detail);
    }

    [Fact]
    public void Parses_xe_wait_info_and_connectivity()
    {
        var w = SqlServerLogParser.ParseXeEvent("wait_info",
            """<event name="wait_info" package="sqlos" timestamp="2026-10-18T12:00:00.000Z"><data name="wait_type"><value>131</value><text>LCK_M_U</text></data><data name="duration"><value>45012</value></data><action name="session_id" package="sqlserver"><value>61</value></action></event>""");
        Assert.Equal("Long wait LCK_M_U 45012 ms (session 61)", w.Message);
        Assert.Equal("warn", w.Level);
        var c = SqlServerLogParser.ParseXeEvent("connectivity_ring_buffer_recorded",
            """<event name="connectivity_ring_buffer_recorded" timestamp="2026-10-18T12:00:00.000Z"><data name="type"><text>Error</text></data><data name="remote_host"><value>10.0.0.5</value></data><data name="remote_port"><value>50001</value></data><data name="os_error"><value>10054</value></data><data name="sni_error"><value>0</value></data></event>""");
        Assert.Equal("Connectivity Error from 10.0.0.5:50001, OS error 10054", c.Message);
        Assert.Equal("warn", c.Level);
        var broken = SqlServerLogParser.ParseXeEvent("error_reported", "<event name=\"error_reported\"");
        Assert.Equal("unknown", broken.Level);
    }

    [Fact]
    public void Parses_activity_with_blocking_chain_and_locks()
    {
        var sessions = Set(["session_id", "login_name", "host_name", "program_name", "database_name", "status", "login_time", "start_time", "total_elapsed_time",
                "wait_type", "wait_time", "blocking_session_id", "command", "cpu_time", "logical_reads", "open_transaction_count", "last_request_start_time", "sql_text"],
            R(57, "etl", "etl-02", "SSIS", "Shop", "running", "2026-10-18T08:00:00", "2026-10-18T13:58:00", 95000, null, 0, 0, "UPDATE", 81234, 552301, 1, null, "UPDATE dbo.Orders SET Status = 2"),
            R(61, "app", "web-02", "Shop.Web", "Shop", "suspended", "2026-10-18T09:00:00", "2026-10-18T13:59:00", 64000, "LCK_M_U", 64000, 57, "UPDATE", 12, 40, 1, null, "UPDATE dbo.Orders SET ShippedAt = 1"),
            R(80, "sa", "dba", "DbStudio", "master", "sleeping", "2026-10-18T13:00:00", null, null, null, null, null, null, 3, 4, 0, "2026-10-18T13:30:00", "SELECT 1"));
        var locks = Set(["session_id", "resource_type", "database_name", "request_mode", "request_status", "lock_count"],
            R(57, "OBJECT", "Shop", "IX", "GRANT", 3), R(61, "KEY", "Shop", "U", "WAIT", 1));
        var rows = SqlServerLogSource.ParseActivity(sessions, locks, TimeSpan.Zero);
        Assert.Equal(5, rows.Count);
        var blocked = rows.Single(r => r.Id == "61");
        Assert.Equal("57", blocked.BlockedBy);
        Assert.Equal("LCK_M_U", blocked.WaitType);
        Assert.Equal(64000, blocked.DurationMs);
        Assert.Equal("KILL 61", blocked.Fields!["killStatement"]);
        Assert.Equal("3", rows.Single(r => r.Id == "57").Fields!["locks"]);
        Assert.Null(rows.Single(r => r.Id == "80").DurationMs);
        var waitLock = rows.Single(r => r.Kind == "lock" && r.State == "WAIT");
        Assert.Equal("57", waitLock.BlockedBy);
        Assert.False(waitLock.CanKill);
    }

    [Fact]
    public async Task Kill_validates_and_maps_errors()
    {
        var runner = new FakeSqlRunner().On("SUSER_SNAME()", Probe()).OnFail("KILL 66", "6106", "Process ID 66 is not an active process ID.");
        var src = new SqlServerLogSource(runner);
        var ok = await src.KillAsync(Target("sqlserver"), new LogKillRequest("57", "session"), default);
        Assert.True(ok.Killed);
        Assert.Contains("KILL 57;", runner.Sql);
        var gone = await src.KillAsync(Target("sqlserver"), new LogKillRequest("66", "session"), default);
        Assert.False(gone.Killed);
        var bad = await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("sqlserver"), new LogKillRequest("57; DROP TABLE x", "session"), default));
        Assert.Equal(ErrorCodes.Validation, bad.Code);
        var denied = new FakeSqlRunner().On("SUSER_SNAME()", Probe()).OnFail("KILL", "6102", "User does not have permission to use the KILL statement.");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new SqlServerLogSource(denied).KillAsync(Target("sqlserver"), new LogKillRequest("57", "session"), default));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
    }
}
