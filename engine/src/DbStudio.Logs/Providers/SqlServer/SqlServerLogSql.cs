using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.SqlServer;

/// <summary>The T-SQL of the SQL Server log and activity sources (golden-tested).</summary>
public static class SqlServerLogSql
{
    /// <summary>One cheap probe: login, edition, version, role memberships, permissions, server UTC offset, Agent.</summary>
    public const string Probe = """
        SET NOCOUNT ON;
        SELECT SUSER_SNAME() AS login_name,
            CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
            CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(32)) AS product_version,
            CAST(IS_SRVROLEMEMBER('sysadmin') AS int) AS is_sysadmin,
            CAST(IS_SRVROLEMEMBER('securityadmin') AS int) AS is_securityadmin,
            CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS int) AS view_server_state,
            CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW ANY ERROR LOG') AS int) AS view_any_error_log,
            CAST(HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY CONNECTION') AS int) AS alter_any_connection,
            DATEDIFF(minute, GETUTCDATE(), GETDATE()) AS utc_offset_minutes,
            CASE WHEN OBJECT_ID(N'msdb.dbo.sysjobs') IS NULL THEN 0 ELSE 1 END AS has_agent;
        """;

    /// <summary><c>sp_enumerrorlogs</c> (1 = SQL Server error log, 2 = SQL Agent log).</summary>
    public static string EnumErrorLogs(int logType) => $"SET NOCOUNT ON;\nEXEC master.dbo.sp_enumerrorlogs {logType};";

    /// <summary>
    /// <c>xp_readerrorlog</c> into a temp table (keeps the file order through an identity column), newest first, TOP n.
    /// <paramref name="logType"/>: 1 = error log (LogDate, ProcessInfo, Text), 2 = Agent log (LogDate, ErrorLevel, Text).
    /// <paramref name="from"/>/<paramref name="to"/> are server local times.
    /// </summary>
    public static string ReadErrorLog(int archive, int logType, string? search, DateTime from, DateTime to, int top)
    {
        var columns = logType == 2
            ? "LogDate datetime NULL, ErrorLevel int NULL, [Text] nvarchar(max) NULL"
            : "LogDate datetime NULL, ProcessInfo nvarchar(100) NULL, [Text] nvarchar(max) NULL";
        var names = logType == 2 ? "LogDate, ErrorLevel, [Text]" : "LogDate, ProcessInfo, [Text]";
        return $"""
            SET NOCOUNT ON;
            DECLARE @from datetime = '{SqlText.IsoLocal(from)}', @to datetime = '{SqlText.IsoLocal(to)}';
            IF OBJECT_ID(N'tempdb..#dbstudio_log') IS NOT NULL DROP TABLE #dbstudio_log;
            CREATE TABLE #dbstudio_log (id int IDENTITY(1,1) NOT NULL, {columns});
            INSERT INTO #dbstudio_log ({names}) EXEC master.dbo.xp_readerrorlog {archive}, {logType}, {SqlText.NString(search)}, NULL, @from, @to, N'desc';
            SELECT TOP ({top}) {names} FROM #dbstudio_log ORDER BY id;
            DROP TABLE #dbstudio_log;
            """;
    }

    /// <summary>XE events the system_health source shows (sp_server_diagnostics results are left out: large and periodic).</summary>
    public static readonly IReadOnlyList<string> SystemHealthEvents =
    [
        "error_reported", "wait_info", "wait_info_external", "xml_deadlock_report",
        "security_error_ring_buffer_recorded", "connectivity_ring_buffer_recorded",
    ];

    /// <summary>system_health ring buffer events (UTC timestamps), newest first, one XML document per event.</summary>
    public static string SystemHealth(DateTime fromUtc, DateTime toUtc, string? search, int top)
    {
        var names = string.Join(", ", SystemHealthEvents.Select(SqlText.NString));
        var like = search is null ? "" : $"\n  AND CAST(ev.data AS nvarchar(max)) LIKE {SqlText.NString(SqlText.TSqlLikeContains(search))}";
        return $"""
            SET NOCOUNT ON;
            WITH src AS (
              SELECT CAST(t.target_data AS xml) AS d
              FROM sys.dm_xe_session_targets t
              JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
              WHERE s.name = N'system_health' AND t.target_name = N'ring_buffer'
            ), ev AS (
              SELECT x.e.value('(@timestamp)[1]', 'datetime2(3)') AS ts, x.e.value('(@name)[1]', 'nvarchar(128)') AS name, x.e.query('.') AS data
              FROM src CROSS APPLY src.d.nodes('/RingBufferTarget/event') AS x(e)
            )
            SELECT TOP ({top}) ev.ts, ev.name, CAST(ev.data AS nvarchar(max)) AS event_xml
            FROM ev
            WHERE ev.name IN ({names})
              AND ev.ts >= '{SqlText.IsoLocal(fromUtc)}' AND ev.ts <= '{SqlText.IsoLocal(toUtc)}'{like}
            ORDER BY ev.ts DESC;
            """;
    }

    /// <summary>Sessions + requests + current statement, then a lock summary (two result sets).</summary>
    public const string Activity = """
        SET NOCOUNT ON;
        SELECT s.session_id, s.login_name, s.host_name, s.program_name,
            DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
            COALESCE(r.status, s.status) AS status, s.login_time, r.start_time, r.total_elapsed_time,
            r.wait_type, r.wait_time, r.blocking_session_id, r.command,
            COALESCE(r.cpu_time, s.cpu_time) AS cpu_time, COALESCE(r.logical_reads, s.logical_reads) AS logical_reads,
            s.open_transaction_count, s.last_request_start_time,
            CASE WHEN r.sql_handle IS NULL THEN t2.text
                 ELSE SUBSTRING(t.text, r.statement_start_offset / 2 + 1,
                    (CASE r.statement_end_offset WHEN -1 THEN DATALENGTH(t.text) ELSE r.statement_end_offset END - r.statement_start_offset) / 2 + 1)
            END AS sql_text
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
        LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
        OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t2
        WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
        ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, r.total_elapsed_time DESC, s.session_id;
        SELECT l.request_session_id AS session_id, l.resource_type, DB_NAME(l.resource_database_id) AS database_name,
            l.request_mode, l.request_status, COUNT(*) AS lock_count
        FROM sys.dm_tran_locks l
        WHERE l.request_session_id <> @@SPID AND l.resource_type <> N'DATABASE'
        GROUP BY l.request_session_id, l.resource_type, l.resource_database_id, l.request_mode, l.request_status
        ORDER BY l.request_session_id;
        """;

    public static string Kill(int spid) => $"KILL {spid};";
}
