using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Logs;
using DbStudio.Logs.Providers.Snowflake;
using DbStudio.Providers.Snowflake.Module;
using DbStudio.Providers.Snowflake.Plans;

namespace DbStudio.Providers.Snowflake.Tests;

public sealed class PlanTests
{
    private const string Query = "SELECT c.NAME, SUM(o.TOTAL) AS TOTAL FROM CUSTOMERS c JOIN ORDERS o ON o.CUSTOMER_ID = c.ID WHERE o.ORDER_DATE >= '2026-02-01' GROUP BY c.NAME";

    [Fact]
    public void Estimated_script_explains_with_null_binds()
    {
        var r = new SnowflakePlanReader();
        var s = r.CreateScript(new ExplainInput("x1", "SELECT * FROM t WHERE id = :id AND v:a = ?;", ExplainModes.Estimated, Line: 5));
        var b = Assert.Single(s.Batches);
        Assert.Equal("EXPLAIN USING JSON\nSELECT * FROM t WHERE id = :id AND v:a = ?", b.Sql);
        Assert.Equal(4, b.Line);
        Assert.True(b.CaptureAll);
        Assert.Equal([("id", ParamKinds.Null), ("1", ParamKinds.Null)], s.Params!.Select(p => (p.Name, p.Kind)));
        var actual = r.CreateScript(new ExplainInput("x2", Query, ExplainModes.Actual));
        Assert.True(Assert.Single(actual.Batches).Visible);
    }

    [Fact]
    public void Explain_json_becomes_a_tree_with_pruning_props()
    {
        var json = (string)SnowflakeFixtures.Find("EXPLAIN USING JSON\n" + Query)!.Result!.Rows[0][0]!;
        var plan = SnowflakePlanReader.ParseExplain(json);
        Assert.Equal("json", plan.RawFormat);
        var root = plan.Root;
        Assert.Equal("Result", root.Op);
        Assert.Equal("2", root.Props!["Partitions total (query)"]);
        var join = root.Children.Single().Children.Single();
        Assert.Equal("InnerJoin", join.Op);
        Assert.Equal("joinKey: (C.ID = O.CUSTOMER_ID)", join.Predicate);
        Assert.Equal(2, join.Children.Count);
        var scan = join.Children[0].Children.Single();
        Assert.Equal(("TableScan", "SHOP.PUBLIC.ORDERS"), (scan.Op, scan.Object));
        Assert.Equal("3072", scan.Props!["Bytes assigned"]);
        Assert.Null(root.CostPct);
    }

    [Fact]
    public void Operator_stats_give_rows_time_shares_and_warnings()
    {
        var rs = SnowflakeFixtures.Find(SnowflakePlanReader.OperatorStatsSql("01b7c2d4-0306-8a21-0000-00041c2b9e5d"))!.Result!;
        var plan = SnowflakePlanReader.ParseOperatorStats(rs);
        var root = plan.Root;
        Assert.Equal("Result", root.Op);
        Assert.Equal(4, root.ActualRows);
        Assert.Equal(100, root.Cost!.Value, 3);
        var join = root.Children.Single().Children.Single();
        Assert.Equal(("Join", "INNER", "(C.ID = O.CUSTOMER_ID)"), (join.Op, join.LogicalOp!, join.Predicate!));
        var ordersScan = join.Children.Single(c => c.Op == "Filter").Children.Single();
        Assert.Equal("SHOP.PUBLIC.ORDERS", ordersScan.Object);
        Assert.Equal(40, ordersScan.CostPct);
        Assert.Contains(ordersScan.Warnings, w => w.Contains("No partition pruning"));
        Assert.Contains(ordersScan.Warnings, w => w.Contains("Spilled 100 MB to local storage"));
        Assert.Equal("100", join.Children.Single(c => c.Op == "TableScan").Props!["Scanned from cache (%)"]);
        Assert.Equal([0L], SnowflakePlanReader.ParseIds("[0]"));
        Assert.Equal([1L, 2L], SnowflakePlanReader.ParseIds("[1, 2]"));
    }
}

public sealed class LogSourceTests
{
    private static readonly LogTarget Target = new("c_sf_test", SfTestProfiles.Shop());

    [Fact]
    public async Task Sources_are_listed_and_need_a_warehouse()
    {
        var runner = new FixtureSqlRunner();
        var src = new SnowflakeLogSource(runner);
        var list = await src.ListAsync(Target, CancellationToken.None);
        Assert.Equal(["query_history", "warehouse_load", "login_history", "activity"], list.Select(s => s.Id));
        Assert.All(list, s => Assert.True(s.Available));

        var noWh = SnowflakeLogSource.Sources(new SnowflakeLogSource.Facts("SHOP", "SYSADMIN", null, "SHOP"));
        Assert.False(noWh[0].Available);
        Assert.Equal("GRANT USAGE ON WAREHOUSE <warehouse> TO ROLE SYSADMIN;", noWh[0].Needs);
        Assert.True(noWh[3].Available);
    }

    [Fact]
    public async Task Query_history_entries_have_levels_fields_and_errors()
    {
        var runner = new FixtureSqlRunner();
        var src = new SnowflakeLogSource(runner);
        var res = await src.QueryAsync(Target, LogFilter.Validate(new LogQuery("query_history")), CancellationToken.None);
        Assert.Equal(3, res.Entries.Count);
        Assert.True(res.Entries[0].Seq < res.Entries[1].Seq);
        Assert.Equal("USE WAREHOUSE COMPUTE_WH", res.Entries[0].Message);
        var failed = res.Entries[^1];
        Assert.Equal(LogLevels.Error, failed.Level);
        Assert.StartsWith("SQL compilation error", failed.Detail);
        Assert.Equal("1003", failed.Fields!["errorCode"]);
        var ok = res.Entries[1];
        Assert.Equal(("info", "COMPUTE_WH", "1205", "5632"), (ok.Level, ok.Source, ok.Fields!["elapsedMs"], ok.Fields["bytesScanned"]));
        Assert.Contains("RESULT_LIMIT =>", runner.Sent[^1]);

        var errorsOnly = await src.QueryAsync(Target, LogFilter.Validate(new LogQuery("query_history", Levels: ["error"])), CancellationToken.None);
        Assert.Single(errorsOnly.Entries);

        var load = await src.QueryAsync(Target, LogFilter.Validate(new LogQuery("warehouse_load")), CancellationToken.None);
        Assert.Contains(load.Entries, e => e.Level == LogLevels.Warn && e.Message.StartsWith("ETL_WH: running 1.8, queued 0.4"));
        var logins = await src.QueryAsync(Target, LogFilter.Validate(new LogQuery("login_history")), CancellationToken.None);
        Assert.Contains(logins.Entries, e => e.Level == LogLevels.Error && e.Message.Contains("INCORRECT_USERNAME_PASSWORD"));
    }

    [Fact]
    public void Query_history_sql_has_the_window()
    {
        var sql = SnowflakeLogSql.QueryHistory(new DateTimeOffset(2026, 10, 23, 10, 0, 0, TimeSpan.Zero), null, 100);
        Assert.Contains("END_TIME_RANGE_START => TO_TIMESTAMP_LTZ('2026-10-23T10:00:00.000Z')", sql);
        Assert.Contains("RESULT_LIMIT => 100", sql);
        Assert.DoesNotContain("EXECUTION_STATUS IN", sql);
    }

    [Fact]
    public async Task Activity_lists_running_queries_transactions_and_locks_and_kills()
    {
        var runner = new FixtureSqlRunner();
        var src = new SnowflakeLogSource(runner);
        var rows = await src.SnapshotAsync(Target, CancellationToken.None);
        Assert.Contains(rows, r => r is { Kind: "op", State: "running", CanKill: true } && r.Text == "SELECT SYSTEM$WAIT(120)");
        Assert.Contains(rows, r => r is { Kind: "op", WaitType: "queued" });
        Assert.Contains(rows, r => r is { Kind: "session", Id: "1729695481203000000" });
        Assert.Contains(rows, r => r is { Kind: "lock", WaitType: "lock" });

        var kill = await src.KillAsync(Target, new LogKillRequest("01b7c2d4-0306-8a21-0000-00041c2b9f01", "op"), CancellationToken.None);
        Assert.True(kill.Killed);
        Assert.Contains("SYSTEM$CANCEL_QUERY('01b7c2d4-0306-8a21-0000-00041c2b9f01')", runner.Sent[^1]);
        var abort = await src.KillAsync(Target, new LogKillRequest("1729695481203000000", "session"), CancellationToken.None);
        Assert.Contains("Aborted", abort.Message);
        await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target, new LogKillRequest("'; DROP TABLE x; --", "op"), CancellationToken.None));
    }

    [Fact]
    public async Task Missing_warehouse_and_privilege_errors_map()
    {
        var runner = new FixtureSqlRunner
        {
            Override = sql => sql.Contains("QUERY_HISTORY", StringComparison.Ordinal)
                ? throw new DbStudio.Logs.Sql.SqlQueryException(new ErrorInfo("003001", "SQL access control error: Insufficient privileges to operate on warehouse 'X'", ProviderCode: 3001))
                : null,
        };
        var src = new SnowflakeLogSource(runner);
        var ex = await Assert.ThrowsAsync<EngineException>(() => src.QueryAsync(Target, LogFilter.Validate(new LogQuery("query_history")), CancellationToken.None));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
    }
}

public sealed class ModuleTests
{
    [Fact]
    public async Task Warehouses_roles_and_objects_parse()
    {
        var g = new SnowflakeGatewayFake();
        var wh = await SnowflakeObjects.WarehousesAsync(g, CancellationToken.None);
        Assert.Equal(2, wh.Count);
        Assert.Equal(("COMPUTE_WH", "SUSPENDED", "X-Small", 600, true, true), (wh[0].Name, wh[0].State, wh[0].Size!, wh[0].AutoSuspendSeconds!.Value, wh[0].AutoResume, wh[0].IsCurrent));
        Assert.Equal((2, 1, 3), (wh[1].Running!.Value, wh[1].Queued!.Value, wh[1].MaxClusters!.Value));

        var roles = await SnowflakeObjects.RolesAsync(g, CancellationToken.None);
        Assert.Equal(["ANALYST", "PUBLIC", "SYSADMIN"], roles.Select(r => r.Name));
        Assert.True(roles.Single(r => r.Name == "SYSADMIN").IsCurrent);
        Assert.Equal("Read-only analysts", roles[0].Comment);

        var tasks = await SnowflakeObjects.ObjectsAsync(g, "SHOP", "PUBLIC", "tasks", CancellationToken.None);
        var task = Assert.Single(tasks.Items);
        Assert.Equal(("NIGHTLY_TOTALS", "started", "ETL_WH"), (task.Name, task.State!, task.Details["warehouse"]));
        var stages = await SnowflakeObjects.ObjectsAsync(g, "SHOP", "PUBLIC", "Stages", CancellationToken.None);
        Assert.Equal("s3://rowlit-demo/events/", stages.Items[0].Details["url"]);
        var streams = await SnowflakeObjects.ObjectsAsync(g, "SHOP", "PUBLIC", "streams", CancellationToken.None);
        Assert.Equal("SHOP.PUBLIC.ORDERS", streams.Items[0].Details["table_name"]);
        var pipes = await SnowflakeObjects.ObjectsAsync(g, "SHOP", "PUBLIC", "pipes", CancellationToken.None);
        Assert.Empty(pipes.Items);
        Assert.Contains("Insufficient privileges", pipes.Note);
        Assert.Throws<EngineException>(() => SnowflakeObjects.KindOf("tables"));
        Assert.Equal("fileformats", SnowflakeObjects.KindOf("FILE_FORMATS"));
    }

    [Fact]
    public async Task Object_ddl_and_actions()
    {
        var g = new SnowflakeGatewayFake();
        var ddl = await SnowflakeObjects.DdlAsync(g, "SHOP", "PUBLIC", "tasks", "NIGHTLY_TOTALS", CancellationToken.None);
        Assert.StartsWith("create or replace task SHOP.PUBLIC.NIGHTLY_TOTALS", ddl.Ddl);
        var stage = await SnowflakeObjects.DdlAsync(g, "SHOP", "PUBLIC", "stages", "UPLOADS", CancellationToken.None);
        Assert.Contains("--   FIELD_DELIMITER = |", stage.Ddl);
        Assert.DoesNotContain("TYPE = CSV", stage.Ddl); // defaults are left out
        Assert.Equal("ALTER TASK \"SHOP\".\"PUBLIC\".\"NIGHTLY_TOTALS\" RESUME", SnowflakeObjects.ObjectActionSql("tasks", "SHOP", "PUBLIC", "NIGHTLY_TOTALS", "Resume"));
        Assert.Equal("EXECUTE TASK \"SHOP\".\"PUBLIC\".\"T\"", SnowflakeObjects.ObjectActionSql("tasks", "SHOP", "PUBLIC", "T", "execute"));
        Assert.Equal("ALTER WAREHOUSE \"COMPUTE_WH\" RESUME IF SUSPENDED", SnowflakeObjects.WarehouseActionSql("COMPUTE_WH", "resume"));
        Assert.Throws<EngineException>(() => SnowflakeObjects.ObjectActionSql("stages", "SHOP", "PUBLIC", "X", "drop"));
        Assert.Throws<EngineException>(() => SnowflakeObjects.WarehouseActionSql("X", "drop"));
    }
}
