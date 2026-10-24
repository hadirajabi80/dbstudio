using System.Diagnostics;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Logs;
using DbStudio.Logs.Providers.ClickHouse;
using DbStudio.Logs.Sql;
using DbStudio.Providers.ClickHouse.Designer;
using DbStudio.Providers.ClickHouse.Plans;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.Conformance.M15;

namespace DbStudio.Providers.ClickHouse.Tests;

/// <summary>
/// The shared provider conformance suite against ClickHouse 24.8 (skipped without Docker). ClickHouse has no transactions
/// (skipped through <see cref="ProviderFixture.SupportsTransactions"/>). Known differences (R3-2 in docs/wp-notes/WP-CH.md):
/// no foreign keys and no auto-increment, and UPDATE/DELETE are mutations without a row count — the three catalog tests
/// asserting FKs/identity and the DML row-count test cannot pass until the fixture gets SupportsForeignKeys /
/// SupportsIdentity / ReportsDmlRowCounts switches.
/// </summary>
public sealed class ChConformanceTests(ChFixture fixture) : ProviderConformanceTests<ChFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}

public sealed class ChM15ConformanceTests(ChFixture fixture) : M15ConformanceTests<ChFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new ChDdlScripter();
    protected override IDesignerDatabase Database { get; } = new ChDesignerDatabase();
    protected override IPlanReader PlanReader { get; } = new ChPlanReader();
    protected override string IntType => "Int32";
    protected override string TextType(int n) => "String";
    protected override string MoneyType => "Decimal(12, 2)";
    protected override string DateType => "Date";
}

/// <summary>ClickHouse-specific behaviour against the seeded server.</summary>
public sealed class ChProviderTests(ChFixture fixture) : IClassFixture<ChFixture>
{
    private readonly ChFixture _f = fixture;

    private void Require() => Skip.IfNot(_f.IsAvailable, _f.SkipReason ?? "ClickHouse not available.");

    private static ExecuteRequest Req(string sql, int maxRows = 1000) => new([new SqlBatch(sql, 1, 1)], maxRows, true, false, "script");

    private async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(string sql, int maxRows = 1000)
    {
        await using var s = await _f.OpenSessionAsync();
        var sink = new RecordingSink();
        var summary = await s.ExecuteAsync(Req(sql, maxRows), sink, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(60));
        return (summary, sink);
    }

    [SkippableFact]
    public async Task NestedTypes_AreJson_AndPersianTextSurvives()
    {
        Require();
        var (summary, sink) = await RunAsync("""
            SELECT tags, attributes, (1, 'x') AS t, toUInt64(18446744073709551615) AS u, toDecimal128(1.5, 2) AS d,
                   toDateTime64('2026-01-01 10:00:00.123', 3, 'Asia/Tehran') AS dt, toIPv4('1.2.3.4') AS ip, generateUUIDv4() AS g,
                   (SELECT body FROM shop.reviews WHERE id = 2) AS fa
            FROM shop.products WHERE id = 1
            """);
        Assert.True(summary.Status == ExecutionStatus.Ok, sink.Describe());
        var rs = Assert.Single(sink.ResultSets);
        var kinds = rs.Columns.Select(c => c.Kind).ToArray();
        Assert.Equal(["json", "json", "json", "int", "decimal", "datetime", "string", "guid", "string"], kinds);
        var row = Assert.Single(rs.Rows);
        Assert.Equal("[\"input\",\"usb\"]", row[0]);
        Assert.Equal("{\"layout\":\"ISO\",\"color\":\"black\"}", row[1]);
        Assert.Equal("[1,\"x\"]", row[2]);
        Assert.Equal("18446744073709551615", row[3]);
        Assert.Equal("1.50", row[4]);
        Assert.Equal("2026-01-01T10:00:00.123", row[5]);
        Assert.Equal("1.2.3.4", row[6]);
        Assert.Equal("صفحه‌کلید عالی است و کلیدها بی‌صدا هستند.", row[8]);
    }

    [SkippableFact]
    public async Task Use_SwitchesDatabase_AndSetPersistsInTheSession()
    {
        Require();
        await using var s = await _f.OpenSessionAsync();
        var sink = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch("USE system", 1, 1), new SqlBatch("SET max_threads = 3", 2, 1),
            new SqlBatch("SELECT currentDatabase(), getSetting('max_threads')", 3, 1)], 100, true, false, "script"), sink, CancellationToken.None);
        Assert.Empty(sink.Errors);
        Assert.Equal("system", s.CurrentDatabase);
        var row = sink.ResultSets.Single().Rows.Single();
        Assert.Equal("system", row[0]);
        Assert.Equal("3", Convert.ToString(row[1], System.Globalization.CultureInfo.InvariantCulture));
    }

    [SkippableFact]
    public async Task RowCap_StopsTheServerQuickly()
    {
        Require();
        var sw = Stopwatch.StartNew();
        var (summary, sink) = await RunAsync("SELECT number FROM numbers(100000000000)", maxRows: 500);
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var rs = sink.ResultSets.Single();
        Assert.True(rs.Truncated);
        Assert.Equal(500, rs.Rows.Count);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), $"took {sw.Elapsed}");
    }

    [SkippableFact]
    public async Task Cancel_KillsTheQueryOnTheServer()
    {
        Require();
        await using var s = await _f.OpenSessionAsync();
        var sink = new RecordingSink();
        var run = s.ExecuteAsync(Req("SELECT sum(number) FROM numbers_mt(10000000000000) SETTINGS max_threads = 2"), sink, CancellationToken.None);
        await sink.FirstBatchStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(800);
        var sw = Stopwatch.StartNew();
        s.Cancel();
        var summary = await run.WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"cancel took {sw.Elapsed}");
        var left = await _f.ScalarAsync("SELECT count() FROM system.processes WHERE query LIKE '%numbers_mt(10000000000000)%' AND query NOT LIKE '%system.processes%'");
        Assert.Equal(0L, Convert.ToInt64(left, System.Globalization.CultureInfo.InvariantCulture));
    }

    [SkippableFact]
    public async Task Mutation_IsReported()
    {
        Require();
        var t = "zz_mut_" + Guid.NewGuid().ToString("N")[..8];
        await _f.RunBatchesAsync([$"CREATE TABLE shop.{t} (id UInt32, v String) ENGINE = MergeTree ORDER BY id", $"INSERT INTO shop.{t} VALUES (1, 'a'), (2, 'b')"]);
        try
        {
            var (summary, sink) = await RunAsync($"ALTER TABLE shop.{t} UPDATE v = 'z' WHERE id = 1");
            Assert.Equal(ExecutionStatus.Ok, summary.Status);
            Assert.Contains(sink.Messages, m => m.Text.Contains("Mutation", StringComparison.Ordinal) && m.Text.Contains(t, StringComparison.Ordinal));
        }
        finally
        {
            await _f.RunBatchesAsync([$"DROP TABLE shop.{t}"]);
        }
    }

    [SkippableFact]
    public async Task Catalog_TypesOfObjects_KeysAndDdl()
    {
        Require();
        await using var reader = await _f.OpenCatalogAsync();
        var schema = await reader.LoadSchemaAsync(null, "shop", CancellationToken.None);
        Assert.Equal(ObjectTypes.MView, schema.Objects.Single(o => o.Name == "daily_sales").Type);
        Assert.Equal(ObjectTypes.View, schema.Objects.Single(o => o.Name == "orders_since").Type);
        var dict = schema.Objects.Single(o => o.Name == "product_dict");
        Assert.Equal(ObjectTypes.Type, dict.Type);
        Assert.StartsWith("Dictionary", dict.Comment);
        Assert.Contains(schema.Objects, o => o.Name == "tax" && o.Type == ObjectTypes.Func);
        var lines = schema.Objects.Single(o => o.Name == "order_lines");
        Assert.Equal(["order_id", "product_id"], lines.PrimaryKey);
        var orders = schema.Objects.Single(o => o.Name == "orders");
        Assert.Equal(2, orders.Columns.Single(c => c.Name == "order_month").Flags & 2);
        Assert.DoesNotContain(schema.Objects, o => o.Name.StartsWith(".inner", StringComparison.Ordinal));

        var details = await reader.GetObjectDetailsAsync(new ObjectRef(null, "shop", "orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(details.Indexes, i => i.Name == "ix_orders_customer" && i.Type!.StartsWith("minmax", StringComparison.Ordinal));
        Assert.Equal(6, details.RowCountEstimate);
        var ddl = await reader.GetDdlAsync(new ObjectRef(null, "shop", "product_dict", ObjectTypes.Type), CancellationToken.None);
        Assert.Contains("CREATE DICTIONARY", ddl.Ddl);
        var schemas = await reader.ListSchemasAsync(null, CancellationToken.None);
        Assert.Contains(schemas, s => s.Name == "shop");
        Assert.DoesNotContain(schemas, s => s.Name == "system");
    }

    [SkippableFact]
    public async Task Dependencies_AndObjectList()
    {
        Require();
        var provider = (IObjectBrowserProvider)_f.Provider;
        await using (var deps = await provider.OpenDependencyReaderAsync(_f.Profile, _f.Password, CancellationToken.None))
        {
            var orders = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "orders", ObjectTypes.Table), CancellationToken.None);
            Assert.Contains(orders.UsedBy, d => d.Object.Name == "daily_sales");
            Assert.Contains(orders.UsedBy, d => d.Object.Name == "customer_orders");
            var mv = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "daily_sales", ObjectTypes.MView), CancellationToken.None);
            Assert.Contains(mv.Uses, d => d.Object.Name == "daily_sales_agg");
            Assert.Contains(mv.Uses, d => d.Object.Name == "orders");
            var dict = await deps.GetDependenciesAsync(new ObjectRef(null, "shop", "product_dict", ObjectTypes.Type), CancellationToken.None);
            Assert.Contains(dict.Uses, d => d.Object.Name == "products");
        }
        await using var list = await provider.OpenObjectListReaderAsync(_f.Profile, _f.Password, CancellationToken.None);
        var items = await list.ListAsync(null, "shop", null, CancellationToken.None);
        var o = items.Single(i => i.Name == "orders");
        Assert.Equal(6, o.RowCount);
        Assert.True(o.SizeBytes > 0);
        Assert.StartsWith("MergeTree", o.Comment);
    }

    [SkippableFact]
    public async Task Search_NamesColumnsCodeAndData()
    {
        Require();
        await using var searcher = await ((IDatabaseSearchProvider)_f.Provider).OpenSearcherAsync(_f.Profile, _f.Password, CancellationToken.None);
        var names = await searcher.NamesAsync(null, "shop", SearchSql.LikePattern(Dialect.ClickHouse, "order"), false, CancellationToken.None);
        Assert.Contains(names, n => n.Name == "order_lines");
        var cols = await searcher.ColumnsAsync(null, "shop", SearchSql.LikePattern(Dialect.ClickHouse, "email"), false, CancellationToken.None);
        Assert.Contains(cols, c => c.Object == "customers");
        var code = new List<SearchCodeRow>();
        await foreach (var c in searcher.CodeAsync(null, "shop", SearchSql.LikePattern(Dialect.ClickHouse, "daily_sales_agg"), false, CancellationToken.None)) code.Add(c);
        Assert.Contains(code, c => c.Name == "daily_sales");
        var q = SearchSql.BuildDataQuery(Dialect.ClickHouse, "shop", "reviews", ["id"], [("id", "UInt32"), ("body", "String")], new SearchMatcher("کلید"), 10)!;
        var rows = new List<object?[]>();
        await foreach (var r in searcher.QueryAsync(null, q, CancellationToken.None)) rows.Add(r);
        Assert.Single(rows);
    }

    [SkippableFact]
    public async Task Admin_PartsMutationsMerges()
    {
        Require();
        var store = new TestConnections(_f.Profile, _f.Password);
        var admin = new Endpoints.ChAdminService(store.Store, (ClickHouseProvider)_f.Provider);
        var parts = await admin.PartsAsync(store.Id, "shop", "orders", CancellationToken.None);
        Assert.Equal("toYYYYMM(order_date)", parts.PartitionKey);
        Assert.Contains(parts.Partitions, p => p.PartitionId == "202601");
        Assert.Equal(6, parts.Partitions.Sum(p => p.Rows));
        Assert.NotNull(parts.Ttl);
        _ = await admin.MutationsAsync(store.Id, "shop", null, CancellationToken.None);
        _ = await admin.MergesAsync(store.Id, null, null, CancellationToken.None);
        var opt = await admin.OptimizeAsync(store.Id, new Endpoints.ChOptimizeRequest("shop", "daily_sales_agg", null, true), CancellationToken.None);
        Assert.True(opt.Ok);
    }

    /// <summary>A connection store in a temp folder holding one profile (for the admin service).</summary>
    private sealed class TestConnections
    {
        public TestConnections(ConnectionProfile profile, string? password)
        {
            var dir = Path.Combine(Path.GetTempPath(), "rowlit-ch-" + Guid.NewGuid().ToString("N")[..8]);
            Store = new Core.Services.ConnectionStore(new Core.Services.AppPaths(dir), new Core.Services.InMemorySecretStore(),
                new Core.Services.ProviderRegistry([new ClickHouseProvider()]));
            Id = Store.Create(new ConnectionProfile { Name = profile.Name, ProviderId = profile.ProviderId, Props = new(profile.Props) }, password).Id;
        }

        public Core.Services.ConnectionStore Store { get; }
        public string Id { get; }
    }

    [SkippableFact]
    public async Task Logs_QueryLogAndActivity()
    {
        Require();
        await _f.RunBatchesAsync(["SELECT 42 AS answer_for_the_log", "SYSTEM FLUSH LOGS"]);
        var runners = new FixtureRunners(_f);
        var source = new ChLogSource(runners);
        var target = new LogTarget(_f.Profile.Id, _f.Profile);
        var sources = await source.ListAsync(target, CancellationToken.None);
        Assert.True(sources.Single(s => s.Id == "query_log").Available);
        var page = await source.QueryAsync(target, new LogQuery("query_log", Q: "answer_for_the_log", Limit: 50), CancellationToken.None);
        Assert.Contains(page.Entries, e => e.Message.Contains("answer_for_the_log", StringComparison.Ordinal));
        var activity = await source.SnapshotAsync(target, CancellationToken.None);
        Assert.NotNull(activity);
        var gone = await source.KillAsync(target, new LogKillRequest(Guid.NewGuid().ToString(), "op"), CancellationToken.None);
        Assert.False(gone.Killed);
    }

    [SkippableFact]
    public async Task Explain_Actual_AddsQueryLogStats()
    {
        Require();
        await using var s = await _f.OpenSessionAsync();
        var sink = new RecordingSink();
        var outcome = await ExplainRunner.RunAsync((Core.Services.AdoSessionBase)s, new ChPlanReader(),
            new ExplainInput("x_ch", "SELECT count() FROM shop.orders WHERE id = 2", ExplainModes.Actual), sink, 100, false, CancellationToken.None);
        Assert.True(outcome.Status == ExecutionStatus.Ok, sink.Describe());
        Assert.Equal(1, outcome.ResultSets);
        var read = outcome.Plan!.Root.DescendantsAndSelf().First(n => n.Op == "ReadFromMergeTree");
        Assert.Contains("PrimaryKey", read.Props!["indexes"]);
        Assert.True(outcome.Plan.Root.Props?.ContainsKey("readRows") == true || outcome.Plan.Warnings.Contains(ChPlanReader.StatsMissingWarning));
        Assert.True(outcome.Plan.Root.Props?.ContainsKey("pipeline"));
    }

    /// <summary>Log SQL runs on a fresh provider session, like SessionSqlRunnerFactory.</summary>
    private sealed class FixtureRunners(ChFixture f) : ISqlRunnerFactory, ISqlRunner
    {
        public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => Task.FromResult<ISqlRunner>(this);

        public async Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
        {
            await using var s = await f.OpenSessionAsync(ct: ct);
            var sink = new RecordingSink();
            await s.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "statement"), sink, ct);
            if (sink.Errors.Count > 0) throw new SqlQueryException(sink.Errors[0].Error);
            return sink.ResultSets.Select(r => new SqlRowSet(r.Columns.Select(c => c.Name).ToList(), r.Rows)).ToList();
        }
    }
}
