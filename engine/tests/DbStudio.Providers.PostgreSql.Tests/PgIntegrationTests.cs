using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.PostgreSql.Plans;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>PostgreSQL-specific behaviour against the seeded shop (docs/PLAN-PG.md 2.9); skipped without Docker.</summary>
public sealed class PgIntegrationTests(PgFixture fixture) : IClassFixture<PgFixture>
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "PostgreSQL not available.");

    private static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession s, IReadOnlyList<QueryParam>? ps, params string[] sql)
    {
        var sink = new RecordingSink();
        var summary = await s.ExecuteAsync(new ExecuteRequest(sql.Select((x, i) => new SqlBatch(x, i + 1, 1)).ToList(), 1000, false, false, "script", ps), sink, CancellationToken.None)
            .WaitAsync(Timeout);
        return (summary, sink);
    }

    private static QueryParam P(string name, string kind, object? value) => new(name, kind, value is null ? null : JsonValue.Create(value));

    [SkippableFact]
    public async Task Notices_ArriveAsMessages_WithContext()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(s, null, "CALL get_customer_report(1)", "CALL get_customer_report(999)");
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var notice = Assert.Single(sink.Messages, m => m.Text.StartsWith("Report for customer Alice", StringComparison.Ordinal));
        Assert.Equal(MessageSeverity.Info, notice.Severity);
        Assert.Contains("CONTEXT: PL/pgSQL function get_customer_report", notice.Text);
        Assert.Contains(sink.Messages, m => m.Severity == MessageSeverity.Warning && m.Text.StartsWith("Customer 999 not found", StringComparison.Ordinal));
    }

    [SkippableFact]
    public async Task Errors_CarrySqlState_AndDocumentPosition_ThroughTheRewrite()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT 1;\nSELECT * FROM public.customers\nWHERE id = :id AND nmae = 1", 20, 1)], 10, true, false, "script",
            [P("id", "int", 1)]), sink, CancellationToken.None).WaitAsync(Timeout);
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("42703", error.Code);
        Assert.Equal((22, 20), (error.Line, error.Col));
    }

    [SkippableFact]
    public async Task ManualMode_FailedStatement_KeepsTheTransactionUsable()
    {
        RequireAvailable();
        const string table = "zz_pg_sp";
        await fixture.RunBatchesAsync([$"DROP TABLE IF EXISTS {table}", $"CREATE TABLE {table} (id int PRIMARY KEY)"]);
        try
        {
            await using (var s = await fixture.OpenSessionAsync(TransactionMode.Manual))
            {
                var (_, sink) = await RunAsync(s, null, $"INSERT INTO {table} VALUES (1)", $"INSERT INTO {table} VALUES (1)", $"INSERT INTO {table} VALUES (3)");
                Assert.Equal([BatchStatus.Ok, BatchStatus.Error, BatchStatus.Ok], sink.BatchesEnded.Select(b => b.Status));
                Assert.Contains(sink.Messages, m => m.Text == PgSession.SavepointRolledBackMessage);
                Assert.True(s.TxOpen);
                await s.CommitAsync(CancellationToken.None);
            }
            Assert.Equal(2L, Convert.ToInt64(await fixture.ScalarAsync($"SELECT count(*) FROM {table}")));
        }
        finally
        {
            await fixture.RunBatchesAsync([$"DROP TABLE {table}"]);
        }
    }

    [SkippableFact]
    public async Task UserTypedBegin_IsReflectedInTxOpen()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        await RunAsync(s, null, "BEGIN");
        Assert.True(s.TxOpen);
        await RunAsync(s, null, "COMMIT");
        Assert.False(s.TxOpen);
    }

    [SkippableFact]
    public async Task Cancel_PgSleep_IsQuick_AndSessionReusable()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        var running = s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT pg_sleep(60)", 1, 1)], 10, true, false, "script"), sink, CancellationToken.None);
        await sink.FirstBatchStarted.Task.WaitAsync(Timeout);
        await Task.Delay(300);
        var sw = Stopwatch.StartNew();
        s.Cancel();
        var summary = await running.WaitAsync(Timeout);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), sw.Elapsed.ToString());
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.Equal(ExecutionStatus.Ok, (await RunAsync(s, null, "SELECT 1")).Summary.Status);
    }

    [SkippableFact]
    public async Task Binds_UuidJsonbEnum_WithStringKind_AndQuestionMarkStaysAnOperator()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(s, [P("u", "string", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"), P("j", "string", "{\"tier\":\"gold\"}"), P("st", "string", "new"), P("1", "int", 1)],
            "SELECT $1::int AS one, (SELECT count(*) FROM extra_types WHERE meta @> :j AND meta ? 'tier') AS j, (SELECT count(*) FROM orders WHERE status = @st) AS e, " +
            "'3f2504e0-4f89-11d3-9a0c-0305e82c3301'::uuid = :u AS u");
        Assert.True(summary.Status == ExecutionStatus.Ok, sink.Describe());
        var row = sink.ResultSets.Single().Rows.Single();
        Assert.Equal(1, Convert.ToInt32(row[0]));
        Assert.Equal(1L, Convert.ToInt64(row[1]));
        Assert.Equal(6L, Convert.ToInt64(row[2]));
        Assert.Equal(true, row[3]);
    }

    [SkippableFact]
    public async Task Call_ReturnsInOutRow_TwoResultSets_TableStatement_RowsAffected()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync(TransactionMode.Manual);
        var (summary, sink) = await RunAsync(s, null, "CALL add_order_line(2, 4, 2, 0)", "SELECT 1 AS a; SELECT 2 AS b", "TABLE countries", "UPDATE products SET price = price WHERE id <= 2");
        Assert.True(summary.Status == ExecutionStatus.Ok, sink.Describe());
        Assert.Equal("inserted", sink.ResultSets[0].Columns.Single().Name);
        Assert.Equal(1, Convert.ToInt32(sink.ResultSets[0].Rows.Single()[0]));
        Assert.Equal(["a", "b"], sink.ResultSets.Skip(1).Take(2).Select(r => r.Columns[0].Name));
        Assert.Equal(3, sink.ResultSets[3].Rows.Count);
        Assert.Contains(sink.Affected, r => r.Count == 2 && r.StatementKind == "UPDATE");
        await s.RollbackAsync(CancellationToken.None);
    }

    [SkippableFact]
    public async Task Values_ArraysIntervalsTimestamptzBytea()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var (_, sink) = await RunAsync(s, null, "SELECT tags, meta, span, created IS NOT NULL AS c, pos, ip, raw, flags, '2026-01-05 10:00:00+00'::timestamptz AS ts FROM extra_types");
        var rs = sink.ResultSets.Single();
        var row = rs.Rows.Single();
        Assert.Equal("{vip,b2b}", row[0]);
        Assert.Equal(ColumnKinds.Json, rs.Columns[1].Kind);
        Assert.Equal("1 year 2 days 03:04:05", row[2]);
        Assert.Equal("(1.5,2)", row[4]);
        Assert.Equal("1010", row[7]);
        Assert.Equal("2026-01-05T10:00:00+00:00", row[8]);
        Assert.IsType<BinaryValue>(row[6]);
    }

    [SkippableFact]
    public async Task Copy_ToStdout_IsRejectedWithoutBreakingTheSession()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(s, null, "COPY (SELECT 1) TO STDOUT");
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        Assert.Equal(ErrorCodes.NotSupported, sink.Errors.Single().Error.Code);
        Assert.Equal(ExecutionStatus.Ok, (await RunAsync(s, null, "SELECT 1")).Summary.Status);
    }

    [SkippableFact]
    public async Task Catalog_PostgreSqlObjects()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var schemas = await reader.ListSchemasAsync(null, CancellationToken.None);
        Assert.Contains(schemas, x => x.Name == "public" && x.SearchPathIndex is not null);
        Assert.Contains(schemas, x => x.Name == "sales");
        Assert.DoesNotContain(schemas, x => x.Name is "pg_catalog" or "information_schema");
        Assert.Contains("shop", await reader.ListDatabasesAsync(CancellationToken.None));

        var pub = await reader.LoadSchemaAsync(null, "public", CancellationToken.None);
        CatalogObject O(string n) => pub.Objects.First(o => o.Name == n);
        Assert.Equal(1, O("extra_types").Columns[0].Flags & 1); // serial
        Assert.Equal(2, O("order_lines").Columns.Single(c => c.Name == "line_total").Flags & 2);
        Assert.Equal(["new", "paid", "shipped", "cancelled"], O("order_status").Columns.Select(c => c.Name));
        Assert.StartsWith("domain over text", O("email_address").Comment);
        Assert.Equal(ObjectTypes.MView, O("customer_totals").Type);
        Assert.Equal(["id", "order_date", "total"], O("orders_of").Columns.Select(c => c.Name));
        Assert.Equal(ObjectTypes.TableFunc, O("orders_of").Type);
        Assert.Equal(2, pub.Objects.Count(o => o.Name == "fn_tax"));
        Assert.Equal(ObjectTypes.Trigger, O("trg_orders_check").Type);
        Assert.Equal(ObjectTypes.Sequence, O("order_numbers").Type);
        Assert.Equal("Registered customers", O("customers").Comment);

        var sales = await reader.LoadSchemaAsync(null, "sales", CancellationToken.None);
        var fk = sales.Objects.Single(o => o.Name == "invoices").ForeignKeys.Single();
        Assert.Equal(("public", "orders"), (fk.RefSchema, fk.RefTable));
        var details = await reader.GetObjectDetailsAsync(new ObjectRef(null, "public", "orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(details.ReferencedBy, r => r.Schema == "sales" && r.Table == "invoices");
        Assert.Contains("trg_orders_check", details.Triggers);
        Assert.Contains(details.Indexes, i => i.Name == "ix_orders_customer" && i.Columns.SequenceEqual(["customer_id", "total"]));

        foreach (var (name, type, expect) in new[]
                 {
                     ("customers", ObjectTypes.Table, "GENERATED BY DEFAULT AS IDENTITY"), ("customer_orders", ObjectTypes.View, "CREATE OR REPLACE VIEW"),
                     ("customer_totals", ObjectTypes.MView, "CREATE MATERIALIZED VIEW"), ("fn_tax", ObjectTypes.Func, "CREATE OR REPLACE FUNCTION"),
                     ("add_order_line", ObjectTypes.Proc, "CREATE OR REPLACE PROCEDURE"), ("trg_orders_check", ObjectTypes.Trigger, "CREATE TRIGGER"),
                     ("order_numbers", ObjectTypes.Sequence, "CREATE SEQUENCE"), ("order_status", ObjectTypes.Type, "AS ENUM"),
                     ("email_address", ObjectTypes.Type, "CREATE DOMAIN"), ("orders", ObjectTypes.Table, "CREATE INDEX ix_orders_open"),
                 })
        {
            var ddl = await reader.GetDdlAsync(new ObjectRef(null, "public", name, type), CancellationToken.None);
            Assert.Contains(expect, ddl.Ddl);
        }
    }

    [SkippableFact]
    public async Task Diagnostics_PrepareOnly()
    {
        RequireAvailable();
        var d = fixture.Provider.Diagnostics!;
        var result = await d.AnalyzeAsync("SELECT 1;\nSELECT * FROM nope;\nSELECT $1;\nSELECT pg_sleep(5) FROM customers;\nCREATE TABLE x(", fixture.Profile, fixture.Password, CancellationToken.None);
        var one = Assert.Single(result);
        Assert.Equal(("42P01", 2, 15), (one.Code, one.Line, one.Col));
    }

    [SkippableFact]
    public async Task Explain_EstimatedAndActualTrees()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        foreach (var mode in new[] { ExplainModes.Estimated, ExplainModes.Actual })
        {
            var sink = new RecordingSink();
            var outcome = await ExplainRunner.RunAsync((AdoSessionBase)s, new PgPlanReader(),
                new ExplainInput("x_pg", "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id = 1", mode, ServerVersion: s.Server.ProductVersion),
                sink, 100, false, CancellationToken.None);
            Assert.True(outcome.Status == ExecutionStatus.Ok, sink.Describe());
            Assert.True(outcome.Plan!.Root.DescendantsAndSelf().Count() >= 3);
            Assert.Contains(outcome.Plan.Root.DescendantsAndSelf(), n => n.Object?.Contains("customers", StringComparison.Ordinal) == true);
            Assert.Equal("json", outcome.Plan.RawFormat);
        }
    }

    [SkippableFact]
    public async Task Describe_MarksKeysAndTables()
    {
        RequireAvailable();
        await using var s = await fixture.OpenSessionAsync();
        var cols = await ((AdoSessionBase)s).DescribeAsync("SELECT id, name FROM customers WHERE id = :id", null, CancellationToken.None);
        Assert.True(cols[0].IsKey);
        Assert.Equal("customers", cols[0].Table);
    }
}
