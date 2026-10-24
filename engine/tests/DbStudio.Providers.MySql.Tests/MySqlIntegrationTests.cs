using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Core.Services;
using DbStudio.Logs;
using DbStudio.Logs.Providers.MySql;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.MySql.Plans;

namespace DbStudio.Providers.MySql.Tests;

/// <summary>
/// MySQL / MariaDB specifics against the seeded shop (plan-batch3 WP-MY tests): warnings, USE, cancel, multiple result
/// sets, CALL with OUT, DELIMITER scripts, error positions, types, catalog (events, sequences, generated, fulltext), DDL,
/// dependencies, object list, search, plans and logs. Runs once per flavor; skipped without Docker.
/// </summary>
public abstract class MySqlIntegrationTestsBase<TFixture>(TFixture fixture) : IClassFixture<TFixture> where TFixture : MySqlFixtureBase
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(90);
    protected TFixture Fixture { get; } = fixture;
    private bool Maria => Fixture.Flavor == Flavor.MariaDb;

    private void RequireAvailable() => Skip.IfNot(Fixture.IsAvailable, Fixture.SkipReason ?? "Server not available.");

    private static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession s, IReadOnlyList<QueryParam>? ps, params string[] sql)
    {
        var sink = new RecordingSink();
        var summary = await s.ExecuteAsync(new ExecuteRequest(sql.Select((x, i) => new SqlBatch(x, i + 1, 1)).ToList(), 1000, false, false, "script", ps), sink, CancellationToken.None)
            .WaitAsync(Timeout);
        return (summary, sink);
    }

    private static QueryParam P(string name, string kind, object? value, string? direction = null) => new(name, kind, value is null ? null : JsonValue.Create(value), direction);

    private static string Errors(RecordingSink sink) => string.Join("; ", sink.Errors.Select(e => e.Error.Message));

    // ------------------------------------------------------------------ execution

    [SkippableFact]
    public async Task Procedure_TwoResultSets_AndWarningsAsMessages()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        var (ok, okSink) = await RunAsync(s, null, "CALL get_customer_report(1)");
        Assert.True(ok.Status == ExecutionStatus.Ok, Errors(okSink));
        Assert.Equal(2, okSink.ResultSets.Count);
        Assert.Equal("Alice", okSink.ResultSets[0].Rows.Single()[1]);
        Assert.Equal(2, okSink.ResultSets[1].Rows.Count);

        var (missing, sink) = await RunAsync(s, null, "CALL get_customer_report(999)");
        Assert.Equal(ExecutionStatus.Ok, missing.Status);
        var warning = Assert.Single(sink.Messages, m => m.Text.Contains("Customer not found", StringComparison.Ordinal));
        Assert.Equal(MessageSeverity.Warning, warning.Severity);
        Assert.Equal(MessageSource.Server, warning.Source);

        var (_, castSink) = await RunAsync(s, null, "SELECT CAST('12abc' AS SIGNED) AS n");
        Assert.Contains(castSink.Messages, m => m.Severity == MessageSeverity.Warning && m.Text.Contains("Truncated", StringComparison.OrdinalIgnoreCase));
    }

    [SkippableFact]
    public async Task Call_WithOutParameter_ThroughUserVariables_AndBinds()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        try
        {
            var (summary, sink) = await RunAsync(s, null, "CALL add_order_line(5, 2, 3, @ins); SELECT @ins AS inserted");
            Assert.True(summary.Status == ExecutionStatus.Ok, Errors(sink));
            Assert.Equal(1L, Convert.ToInt64(sink.ResultSets.Single().Rows.Single()[0], CultureInfo.InvariantCulture));

            var (bound, boundSink) = await RunAsync(s, [P("o", "int", 5), P("p", "int", 3), P("q", "int", 1), P("ins", "int", null, "out")],
                "CALL add_order_line(:o, :p, :q, :ins)");
            Assert.True(bound.Status == ExecutionStatus.Ok, Errors(boundSink));
            var outParam = Assert.Single(bound.OutParams!);
            Assert.Equal("ins", outParam.Name);
            Assert.Equal(1L, Convert.ToInt64(outParam.Value, CultureInfo.InvariantCulture));
        }
        finally
        {
            await Fixture.RunBatchesAsync(["DELETE FROM order_lines WHERE order_id = 5"]);
        }
    }

    [SkippableFact]
    public async Task Params_NamedPositionalAndUserVariables()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(s, [P("1", "int", 2), P("name", "string", "Ali'ce")],
            "SET @offset := 10; SELECT id + @offset AS shifted, :name AS n, ? AS q FROM customers WHERE id = 1");
        Assert.True(summary.Status == ExecutionStatus.Ok, Errors(sink));
        var row = sink.ResultSets.Single().Rows.Single();
        Assert.Equal(11L, Convert.ToInt64(row[0], CultureInfo.InvariantCulture));
        Assert.Equal("Ali'ce", row[1]);
        Assert.Equal(2L, Convert.ToInt64(row[2], CultureInfo.InvariantCulture));
    }

    [SkippableFact]
    public async Task Use_ChangesTheCurrentDatabase()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        Assert.Equal("shop", s.CurrentDatabase);
        var (summary, _) = await RunAsync(s, null, "USE mysql");
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal("mysql", s.CurrentDatabase);
        await s.ChangeDatabaseAsync("shop", CancellationToken.None);
        Assert.Equal("shop", s.CurrentDatabase);
        var (_, sink) = await RunAsync(s, null, "SELECT COUNT(*) FROM customers");
        Assert.Equal(5L, Convert.ToInt64(sink.ResultSets.Single().Rows.Single()[0], CultureInfo.InvariantCulture));
    }

    [SkippableFact]
    public async Task DelimiterScript_RoutineBodiesRunWhole()
    {
        RequireAvailable();
        var name = "zz_dp_" + Guid.NewGuid().ToString("N")[..6];
        await using var s = await Fixture.OpenSessionAsync();
        try
        {
            var script = $"DELIMITER $$\nCREATE PROCEDURE {name}()\nBEGIN\n  IF 1 = 1 THEN\n    SELECT 1 AS a;\n  END IF;\n  SELECT 2 AS b;\nEND$$\nDELIMITER ;\nCALL {name}();";
            var (summary, sink) = await RunAsync(s, null, script);
            Assert.True(summary.Status == ExecutionStatus.Ok, Errors(sink));
            Assert.Equal(2, sink.ResultSets.Count);

            // Without DELIMITER the body is kept whole too.
            var (again, againSink) = await RunAsync(s, null, $"DROP PROCEDURE {name}", $"CREATE PROCEDURE {name}() BEGIN DECLARE i INT DEFAULT 0; WHILE i < 2 DO SET i = i + 1; END WHILE; SELECT i; END", $"CALL {name}()");
            Assert.True(again.Status == ExecutionStatus.Ok, Errors(againSink));
            Assert.Equal(2L, Convert.ToInt64(againSink.ResultSets.Single().Rows.Single()[0], CultureInfo.InvariantCulture));
        }
        finally
        {
            await Fixture.RunBatchesAsync([$"DROP PROCEDURE IF EXISTS {name}"]);
        }
    }

    [SkippableFact]
    public async Task Cancel_SleepStopsWithinTwoSeconds()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        var running = s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT SLEEP(60)", 1, 1)], 100, true, false, "statement"), sink, CancellationToken.None);
        await sink.FirstBatchStarted.Task.WaitAsync(Timeout);
        await Task.Delay(500);
        var sw = Stopwatch.StartNew();
        s.Cancel();
        var summary = await running.WaitAsync(Timeout);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"Cancel took {sw.Elapsed}.");
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        var (after, _) = await RunAsync(s, null, "SELECT 1");
        Assert.Equal(ExecutionStatus.Ok, after.Status);
    }

    [SkippableFact]
    public async Task Errors_CarryNumber_AndDocumentPosition()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT 1;\nSELECT * FROM customers\nWHERE id = :id AND nmae = 1", 20, 1)], 10, true, false, "script",
            [P("id", "int", 1)]), sink, CancellationToken.None).WaitAsync(Timeout);
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("1054", error.Code);
        Assert.Equal((22, 20), (error.Line, error.Col));

        var syntax = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT 1;\n\nSELECT *\nFORM customers", 3, 1)], 10, true, false, "script"), syntax, CancellationToken.None).WaitAsync(Timeout);
        var e2 = Assert.Single(syntax.Errors).Error;
        Assert.Equal("1064", e2.Code);
        Assert.Equal(6, e2.Line);
        Assert.Equal(1, e2.Col);
    }

    [SkippableFact]
    public async Task MultiStatementBatch_RowsAffectedPerStatement()
    {
        RequireAvailable();
        var t = "zz_ms_" + Guid.NewGuid().ToString("N")[..6];
        await Fixture.RunBatchesAsync([$"CREATE TABLE {t} (id INT PRIMARY KEY, v INT)"]);
        try
        {
            await using var s = await Fixture.OpenSessionAsync();
            var (summary, sink) = await RunAsync(s, null, $"INSERT INTO {t} VALUES (1, 1), (2, 2), (3, 3);\nUPDATE {t} SET v = 9 WHERE id < 3;\nSELECT COUNT(*) FROM {t};\nDELETE FROM {t} WHERE id = 3");
            Assert.True(summary.Status == ExecutionStatus.Ok, Errors(sink));
            Assert.Equal([3L, 2L, 1L], sink.Affected.Select(a => a.Count));
            Assert.Equal(["INSERT", "UPDATE", "DELETE"], sink.Affected.Select(a => a.StatementKind));
            Assert.Single(sink.ResultSets);
        }
        finally
        {
            await Fixture.RunBatchesAsync([$"DROP TABLE {t}"]);
        }
    }

    [SkippableFact]
    public async Task Types_ReadAsWireValues()
    {
        RequireAvailable();
        await using var s = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(s, null, "SELECT u_big, flags, yr, tags, meta, pos, raw, d, t, tiny, ext_id, created FROM extra_types");
        Assert.True(summary.Status == ExecutionStatus.Ok, Errors(sink));
        var rs = sink.ResultSets.Single();
        var row = rs.Rows.Single();
        string Kind(int i) => rs.Columns[i].Kind;
        Assert.Equal("18446744073709551615", row[0]);
        Assert.Equal(ColumnKinds.Int, Kind(0));
        Assert.Equal("1010", row[1]);
        Assert.Equal(2026L, Convert.ToInt64(row[2], CultureInfo.InvariantCulture));
        Assert.Equal("vip,b2b", row[3]);
        Assert.Equal(Maria ? ColumnKinds.String : ColumnKinds.Json, Kind(4)); // MariaDB JSON is LONGTEXT
        Assert.Contains("gold", Convert.ToString(row[4], CultureInfo.InvariantCulture));
        Assert.Equal(ColumnKinds.Binary, Kind(5));
        Assert.IsType<BinaryValue>(row[5]);
        Assert.Equal(ColumnKinds.Binary, Kind(6));
        Assert.Equal("2026-03-04", row[7]);
        Assert.Equal(ColumnKinds.Date, Kind(7));
        Assert.StartsWith("12:34:56.789", Convert.ToString(row[8], CultureInfo.InvariantCulture));
        Assert.Equal(-5L, Convert.ToInt64(row[9], CultureInfo.InvariantCulture));
        Assert.Equal("f47ac10b-58cc-4372-a567-0e02b2c3d479", row[10]);
        Assert.StartsWith("2026-01-05T10:00:00.123456", Convert.ToString(row[11], CultureInfo.InvariantCulture));

        var (_, rtl) = await RunAsync(s, null, "SELECT note FROM customer_notes ORDER BY id");
        Assert.Equal("مشتری ویژه؛ تماس بعد از ساعت ۵ عصر", rtl.ResultSets.Single().Rows[0][0]);
        Assert.Equal("שלום עולם", rtl.ResultSets.Single().Rows[4][0]);

        var (_, big) = await RunAsync(s, null, "SELECT CAST('12345678901234567890123456789.123456789' AS DECIMAL(65,30)) AS d");
        Assert.StartsWith("12345678901234567890123456789.123456789", (string)big.ResultSets.Single().Rows.Single()[0]!);
    }

    [SkippableFact]
    public async Task Transactions_UserTyped_AndDdlCommitsImplicitly()
    {
        RequireAvailable();
        var t = "zz_tx_" + Guid.NewGuid().ToString("N")[..6];
        await Fixture.RunBatchesAsync([$"CREATE TABLE {t} (id INT PRIMARY KEY)"]);
        try
        {
            await using (var s = await Fixture.OpenSessionAsync())
            {
                await RunAsync(s, null, "START TRANSACTION");
                Assert.True(s.TxOpen);
                await RunAsync(s, null, $"INSERT INTO {t} VALUES (1)");
                await RunAsync(s, null, "ROLLBACK");
                Assert.False(s.TxOpen);
            }
            Assert.Equal(0L, Convert.ToInt64(await Fixture.ScalarAsync($"SELECT COUNT(*) FROM {t}"), CultureInfo.InvariantCulture));

            await using (var m = await Fixture.OpenSessionAsync(TransactionMode.Manual))
            {
                await RunAsync(m, null, $"INSERT INTO {t} VALUES (2)");
                Assert.True(m.TxOpen);
                var (_, ddl) = await RunAsync(m, null, $"CREATE TABLE {t}_b (id INT)");
                Assert.Contains(ddl.Messages, x => x.Text == MySqlSession.ImplicitCommitMessage);
                Assert.False(m.TxOpen);
            }
            Assert.Equal(1L, Convert.ToInt64(await Fixture.ScalarAsync($"SELECT COUNT(*) FROM {t}"), CultureInfo.InvariantCulture));
        }
        finally
        {
            await Fixture.RunBatchesAsync([$"DROP TABLE IF EXISTS {t}", $"DROP TABLE IF EXISTS {t}_b"]);
        }
    }

    [SkippableFact]
    public async Task ReadOnlyProfile_RejectsWrites()
    {
        RequireAvailable();
        var profile = MySqlBackend.Profile(Fixture.Endpoint!, id: "c_it_my_ro");
        profile.ReadOnly = true;
        await using var s = await Fixture.Provider.OpenSessionAsync(profile, Fixture.Password, new SessionOptions("s_ro", null, TransactionMode.Auto, false), CancellationToken.None);
        var (summary, sink) = await RunAsync(s, null, "UPDATE customers SET name = name WHERE id = 1");
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        Assert.Equal("1792", sink.Errors.Single().Error.Code);
    }

    // ------------------------------------------------------------------ catalog

    [SkippableFact]
    public async Task Catalog_RoutinesTriggersEventsGeneratedAndSequences()
    {
        RequireAvailable();
        await using var c = await Fixture.OpenCatalogAsync();
        Assert.Empty(await c.ListDatabasesAsync(CancellationToken.None));
        var schemas = await c.ListSchemasAsync(null, CancellationToken.None);
        Assert.DoesNotContain(schemas, x => x.Name is "mysql" or "information_schema" or "performance_schema" or "sys");
        var shop = await c.LoadSchemaAsync(null, "shop", CancellationToken.None);
        CatalogObject Find(string n) => shop.Objects.Single(o => o.Name == n);
        Assert.Equal(ObjectTypes.Func, Find("fn_tax").Type);
        Assert.Equal("return", Find("fn_tax").Parameters[^1].Direction);
        var add = Find("add_order_line");
        Assert.Equal(ObjectTypes.Proc, add.Type);
        Assert.Equal(["in", "in", "in", "out"], add.Parameters.Select(p => p.Direction));
        Assert.Equal(ObjectTypes.Trigger, Find("trg_orders_check").Type);
        var ev = Find("ev_purge_notes");
        Assert.Equal(ObjectTypes.Proc, ev.Type);
        Assert.StartsWith("event", ev.Comment);
        var lines = Find("order_lines");
        Assert.True((lines.Columns.Single(x => x.Name == "line_total").Flags & 2) == 2);
        Assert.Equal("Registered customers", Find("customers").Comment);
        Assert.Equal("Display name", Find("customers").Columns.Single(x => x.Name == "name").Comment);
        Assert.Equal(ObjectTypes.View, Find("customer_totals").Type);
        if (Maria) Assert.Equal(ObjectTypes.Sequence, Find("order_numbers").Type);

        var products = await c.GetObjectDetailsAsync(new ObjectRef(null, "shop", "products", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(products.Indexes, i => i.Name == "ft_products_name" && i.Type == "FULLTEXT");
        var orders = await c.GetObjectDetailsAsync(new ObjectRef(null, "shop", "orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("trg_orders_check", orders.Triggers);
        Assert.Equal("'new'", orders.Columns.Single(x => x.Name == "status").Default);
        var proc = await c.GetObjectDetailsAsync(new ObjectRef(null, "shop", "add_order_line", ObjectTypes.Proc), CancellationToken.None);
        Assert.Equal(4, proc.Parameters.Count);
    }

    [SkippableFact]
    public async Task Ddl_ShowCreate_ForEveryObjectType()
    {
        RequireAvailable();
        await using var c = await Fixture.OpenCatalogAsync();
        async Task<string> Ddl(string name, string type) => (await c.GetDdlAsync(new ObjectRef(null, "shop", name, type), CancellationToken.None)).Ddl.Replace("`", "").ToUpperInvariant();
        Assert.Contains("CREATE TABLE ORDERS", await Ddl("orders", ObjectTypes.Table));
        Assert.Contains("VIEW CUSTOMER_ORDERS", await Ddl("customer_orders", ObjectTypes.View));
        Assert.Contains("PROCEDURE GET_CUSTOMER_REPORT", await Ddl("get_customer_report", ObjectTypes.Proc));
        Assert.Contains("FUNCTION FN_TAX", await Ddl("fn_tax", ObjectTypes.Func));
        Assert.Contains("TRIGGER TRG_ORDERS_CHECK", await Ddl("trg_orders_check", ObjectTypes.Trigger));
        Assert.Contains("EVENT EV_PURGE_NOTES", await Ddl("ev_purge_notes", ObjectTypes.Proc));
        if (Maria) Assert.Contains("SEQUENCE ORDER_NUMBERS", await Ddl("order_numbers", ObjectTypes.Sequence));
        foreach (var name in new[] { "get_customer_report", "trg_orders_check" })
        {
            var text = (await c.GetDdlAsync(new ObjectRef(null, "shop", name, name.StartsWith("trg", StringComparison.Ordinal) ? ObjectTypes.Trigger : ObjectTypes.Proc), CancellationToken.None)).Ddl;
            Assert.Single(MySqlSqlText.Split(text)); // runs as one statement from the console
        }
    }

    [SkippableFact]
    public async Task Dependencies_FksViewsTriggersAndBodies()
    {
        RequireAvailable();
        var browser = (IObjectBrowserProvider)Fixture.Provider;
        await using var deps = await browser.OpenDependencyReaderAsync(Fixture.Profile, Fixture.Password, CancellationToken.None);
        var customers = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "customers", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(customers.Uses, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "countries");
        Assert.Contains(customers.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "orders");
        Assert.Contains(customers.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object.Name == "customer_orders");
        Assert.Contains(customers.UsedBy, d => d.Object.Name == "get_customer_report");
        var orders = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(orders.UsedBy, d => d.Kind == DependencyKinds.Trigger && d.Object.Name == "trg_orders_check");
        var view = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "customer_orders", ObjectTypes.View), CancellationToken.None);
        Assert.Contains(view.Uses, d => d.Object.Name == "orders");
        var trigger = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "trg_orders_check", ObjectTypes.Trigger), CancellationToken.None);
        Assert.Contains(trigger.Uses, d => d.Kind == DependencyKinds.Trigger && d.Object.Name == "orders");

        await using var list = await browser.OpenObjectListReaderAsync(Fixture.Profile, Fixture.Password, CancellationToken.None);
        var items = await list.ListAsync(null, "shop", null, CancellationToken.None);
        Assert.Contains(items, i => i is { Name: "orders", Type: ObjectTypes.Table, RowCount: not null, SizeBytes: > 0 });
        Assert.Contains(items, i => i.Name == "ev_purge_notes" && i.Comment!.StartsWith("event", StringComparison.Ordinal));
        Assert.Contains(items, i => i is { Name: "trg_orders_check", Type: ObjectTypes.Trigger });
        Assert.All(await list.ListAsync(null, "shop", ObjectTypes.View, CancellationToken.None), i => Assert.Equal(ObjectTypes.View, i.Type));
    }

    [SkippableFact]
    public async Task Search_NamesCodeAndData()
    {
        RequireAvailable();
        var provider = (IDatabaseSearchProvider)Fixture.Provider;
        var service = new DatabaseSearchService((_, ct) => provider.OpenSearcherAsync(Fixture.Profile, Fixture.Password, ct));
        async Task<List<SearchItem>> Run(string term, bool data = false, bool regex = false)
        {
            var items = new List<SearchItem>();
            await service.RunAsync(new SearchRequest
            {
                Matcher = new SearchMatcher(term, matchCase: false, regex: regex),
                Targets = [new SearchTarget(Fixture.Profile.Id, null, "shop")],
                Names = !data, Columns = !data, Code = !data, Data = data,
            }, i => { lock (items) items.Add(i); }, CancellationToken.None);
            return items;
        }
        var names = await Run("customer");
        // other test classes create and drop scratch tables meanwhile
        Assert.DoesNotContain(names, i => i is SearchError e && !e.Message.Contains("doesn't exist", StringComparison.Ordinal));
        var hits = names.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "customers", Object.Type: "table" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "get_customer_report", Object.Type: "proc" });
        Assert.Contains(hits, h => h is { Match: "column", Object.Name: "orders", Column: "customer_id" });
        Assert.Contains(hits, h => h is { Match: "code", Object.Name: "get_customer_report" });

        var data = await Run("تهران", data: true);
        Assert.DoesNotContain(data, i => i is SearchError e && !e.Message.Contains("doesn't exist", StringComparison.Ordinal));
        Assert.Contains(data.OfType<SearchHit>(), h => h is { Match: "data", Object.Name: "customer_notes", Column: "note" });
        var regex = await Run("^ali", data: true, regex: true);
        Assert.Contains(regex.OfType<SearchHit>(), h => h is { Match: "data", Object.Name: "customers", Column: "name" });
    }

    // ------------------------------------------------------------------ plans

    [SkippableFact]
    public async Task Plans_EstimatedAndActual_AndFixtures()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var reader = new MySqlPlanReader(Fixture.Provider.Id);
        if (Golden.Updating)
        {
            // Refresh the parser fixtures from the live servers (review the diff).
            var dir = Path.Combine(SourceDir(), "Plans", "fixtures");
            Directory.CreateDirectory(dir);
            var (_, raw) = await RunAsync(session, null, Maria
                ? "ANALYZE FORMAT=JSON SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country_id = 1 ORDER BY o.total"
                : "EXPLAIN FORMAT=JSON SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country_id = 1 ORDER BY o.total");
            await File.WriteAllTextAsync(Path.Combine(dir, Maria ? "mariadb-analyze.json" : "mysql-estimated.json"), CapturedResultSet.Text(raw.ResultSets[0].Rows[0][0]));
            if (!Maria)
            {
                var (_, tree) = await RunAsync(session, null, "EXPLAIN ANALYZE SELECT c.name, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name");
                await File.WriteAllTextAsync(Path.Combine(dir, "mysql-analyze.txt"), CapturedResultSet.Text(tree.ResultSets[0].Rows[0][0]));
            }
        }
        var join = "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country_id = :id";
        var est = new RecordingSink();
        var estimated = await ExplainRunner.RunAsync((AdoSessionBase)session, reader,
            new ExplainInput("x_est", join, ExplainModes.Estimated, [P("id", "int", 1)], ServerVersion: session.Server.ProductVersion), est, 100, false, CancellationToken.None);
        Assert.True(estimated.Status == ExecutionStatus.Ok, Errors(est));
        Assert.Contains(estimated.Plan!.Root.DescendantsAndSelf(), n => n.Object?.StartsWith("o", StringComparison.Ordinal) == true);

        var act = new RecordingSink();
        var actual = await ExplainRunner.RunAsync((AdoSessionBase)session, reader,
            new ExplainInput("x_act", join, ExplainModes.Actual, [P("id", "int", 1)], ServerVersion: session.Server.ProductVersion), act, 100, false, CancellationToken.None);
        Assert.True(actual.Status == ExecutionStatus.Ok, Errors(act));
        Assert.Equal(4, act.ResultSets.Single().Rows.Count);
        Assert.Contains(actual.Plan!.Root.DescendantsAndSelf(), n => n.ActualRows is not null);
        Assert.Contains(actual.Plan.Warnings, w => w == MySqlPlanReader.RanTwiceWarning);

    }

    private static string SourceDir([System.Runtime.CompilerServices.CallerFilePath] string file = "") => Path.GetDirectoryName(file)!;

    // ------------------------------------------------------------------ logs and activity

    [SkippableFact]
    public async Task Logs_SourcesSlowLogInnoDbStatus_AndActivityKill()
    {
        RequireAvailable();
        var runners = new TestRunnerFactory(Fixture);
        var source = new MySqlLogSource(runners, Fixture.Provider.Id);
        var target = new LogTarget(Fixture.Profile.Id, Fixture.Profile);
        var sources = await source.ListAsync(target, CancellationToken.None);
        Assert.Equal(["error_log", "general_log", "slow_log", "innodb_status", "activity"], sources.Select(s => s.Id));
        Assert.Equal(!Maria, sources[0].Available);
        Assert.True(sources.Single(s => s.Id == "slow_log").Available);

        await using (var s = await Fixture.OpenSessionAsync()) await RunAsync(s, null, "SELECT SLEEP(0.4) AS slow_marker");
        var slow = await source.QueryAsync(target, new LogQuery("slow_log", Q: "slow_marker"), CancellationToken.None);
        Assert.Contains(slow.Entries, e => e.Message.Contains("slow_marker", StringComparison.Ordinal));
        var innodb = await source.QueryAsync(target, new LogQuery("innodb_status"), CancellationToken.None);
        Assert.Contains(innodb.Entries, e => e.Message.Contains("TRANSACTIONS", StringComparison.Ordinal));
        if (!Maria)
        {
            var errors = await source.QueryAsync(target, new LogQuery("error_log", Limit: 50), CancellationToken.None);
            Assert.NotEmpty(errors.Entries);
            Assert.True(errors.Entries.Zip(errors.Entries.Skip(1)).All(p => p.First.Seq < p.Second.Seq));
        }

        await using var victim = await Fixture.OpenSessionAsync();
        var id = ((MySqlSession)victim).ServerConnectionId;
        var activity = await source.SnapshotAsync(target, CancellationToken.None);
        Assert.Contains(activity, a => a.Id == id.ToString(CultureInfo.InvariantCulture) && a.Kind == "session" && a.State == "idle");
        var killed = await source.KillAsync(target, new LogKillRequest(id.ToString(CultureInfo.InvariantCulture), "session"), CancellationToken.None);
        Assert.True(killed.Killed, killed.Message);
        Assert.False(await victim.PingAsync(CancellationToken.None));
    }

    /// <summary>Runs log SQL on a fresh provider session per query (the engine's SessionSqlRunnerFactory keeps one).</summary>
    private sealed class TestRunnerFactory(MySqlFixtureBase fixture) : ISqlRunnerFactory, ISqlRunner
    {
        public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => Task.FromResult<ISqlRunner>(this);

        public async Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
        {
            await using var s = await fixture.OpenSessionAsync(ct: ct);
            var sink = new RecordingSink();
            await s.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "statement"), sink, ct);
            if (sink.Errors.Count > 0) throw new SqlQueryException(sink.Errors[0].Error);
            return sink.ResultSets.Select(r => new SqlRowSet(r.Columns.Select(c => c.Name).ToList(),
                r.Rows.Select(row => row.Select(v => v switch { TruncatedValue t => t.Full, BinaryValue b => (object?)b.Full, _ => v }).ToArray()).ToList())).ToList();
        }
    }
}

public sealed class MySqlIntegrationTests(MySqlFixture fixture) : MySqlIntegrationTestsBase<MySqlFixture>(fixture);

public sealed class MariaDbIntegrationTests(MariaDbFixture fixture) : MySqlIntegrationTestsBase<MariaDbFixture>(fixture);
