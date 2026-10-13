using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.SqlServer.TSql;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>SQL Server specific behaviour (docs/PLAN.md 6, WP-B acceptance). Skipped without Docker.</summary>
public sealed class SqlServerIntegrationTests(SqlServerFixture fixture) : IClassFixture<SqlServerFixture>
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "SQL Server not available.");

    private static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession session, int maxRows, bool stopOnError, params SqlBatch[] batches)
    {
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(batches, maxRows, stopOnError, false, "script"), sink, CancellationToken.None).WaitAsync(Timeout);
        return (summary, sink);
    }

    [SkippableFact]
    public async Task Print_TwoResultSets_And_Raiserror16_ContinuesBatch_WithAbsoluteLine()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        const string sql = "PRINT 'before';\nSELECT 1 AS a;\nRAISERROR('boom', 16, 1);\nSELECT 2 AS b;\nPRINT 'after';";
        var (summary, sink) = await RunAsync(session, 100, true, new SqlBatch(sql, 20, 1));

        Assert.Equal(2, sink.ResultSets.Count);                    // the batch continued after the error
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        var error = Assert.Single(sink.Errors);
        Assert.Equal("50000", error.Error.Code);
        Assert.Equal("boom", error.Error.Message);
        Assert.Equal(22, error.Error.Line);                        // line 3 of a batch starting at document line 20
        Assert.Equal(BatchStatus.Error, Assert.Single(sink.BatchesEnded).Status);

        var texts = sink.Messages.Where(m => m.Source == MessageSource.Server).Select(m => m.Text).ToList();
        Assert.Contains("before", texts);
        Assert.Contains("after", texts);
        Assert.Equal(20, sink.Messages.First(m => m.Text == "before").Line);

        // Ordering: "before" precedes the first result set, the error precedes the second.
        var events = sink.Events;
        int Index(Func<object, bool> p) => events.Select((e, i) => (e, i)).First(x => p(x.e)).i;
        Assert.True(Index(e => e is RecordingSink.MessageEvent { Text: "before" }) < Index(e => e is RecordingSink.RecordedResultSet { Id: 0 }));
        Assert.True(Index(e => e is RecordingSink.ErrorEvent) < Index(e => e is RecordingSink.RecordedResultSet { Id: 1 }));
    }

    [SkippableFact]
    public async Task StoredProcedure_PrintAndTwoResultSets()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, 100, true, new SqlBatch("EXEC dbo.GetCustomerReport @Id = 1", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(2, sink.ResultSets.Count);
        Assert.Equal(2, sink.ResultSets[1].RowCount);
        Assert.Contains(sink.Messages, m => m.Text == "Report for customer 1" && m.Source == MessageSource.Server);
    }

    [SkippableFact]
    public async Task GoBatches_ShareTempTable()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, 100, true,
            new SqlBatch("CREATE TABLE #t (id INT);\nINSERT INTO #t VALUES (1), (2), (3);", 1, 1),
            new SqlBatch("SELECT COUNT(*) AS n FROM #t;", 4, 1),
            new SqlBatch("DROP TABLE #t;", 6, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(3, Convert.ToInt32(Assert.Single(sink.ResultSets).Rows[0][0]));
        Assert.Contains(sink.Affected, a => a.BatchIndex == 0 && a.Count == 3 && a.StatementKind == "INSERT");
    }

    [SkippableFact]
    public async Task RowsAffected_PerStatement_ExcludesSelectCounts()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, 100, true, new SqlBatch(
            "DECLARE @t TABLE (id INT);\nINSERT INTO @t VALUES (1), (2);\nSELECT * FROM @t;\nUPDATE @t SET id = id + 10 WHERE id = 1;\nDELETE FROM @t;", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(new long[] { 2, 1, 2 }, sink.Affected.Select(a => a.Count));
        Assert.Equal(new[] { "INSERT", "UPDATE", "DELETE" }, sink.Affected.Select(a => a.StatementKind));
        Assert.Equal(5, summary.RowsAffected);
    }

    [SkippableFact]
    public async Task Cancel_Waitfor_ReturnsWithinOneSecond()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        var running = session.ExecuteAsync(new ExecuteRequest([new SqlBatch("WAITFOR DELAY '00:01:00'", 1, 1)], 100, true, false, "statement"),
            sink, CancellationToken.None);
        await sink.FirstBatchStarted.Task.WaitAsync(Timeout);
        await Task.Delay(300);
        var sw = Stopwatch.StartNew();
        session.Cancel();
        var summary = await running.WaitAsync(TimeSpan.FromSeconds(10));
        sw.Stop();
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1), $"Cancel took {sw.Elapsed.TotalMilliseconds:F0} ms.");
        Assert.Empty(sink.Errors);
    }

    [SkippableFact]
    public async Task UseStatement_And_ChangeDatabase_UpdateCurrentDatabase()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        Assert.Equal("shop", session.CurrentDatabase, StringComparer.OrdinalIgnoreCase);

        var (summary, _) = await RunAsync(session, 10, true, new SqlBatch("USE master;", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal("master", session.CurrentDatabase, StringComparer.OrdinalIgnoreCase);

        await session.ChangeDatabaseAsync("shop", CancellationToken.None);
        Assert.Equal("shop", session.CurrentDatabase, StringComparer.OrdinalIgnoreCase);
        await Assert.ThrowsAnyAsync<Exception>(() => session.ChangeDatabaseAsync("no_such_db_xyz", CancellationToken.None));
        Assert.Equal(SessionState.Idle, session.State);
    }

    [SkippableFact]
    public async Task SyntaxError_InSecondBatch_ReportsAbsoluteLine()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, 10, false,
            new SqlBatch("SELECT 1 AS a", 1, 1),
            new SqlBatch("SELECT 2 AS b\nFROM", 3, 1));
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        var error = Assert.Single(sink.Errors);
        Assert.Equal(1, error.BatchIndex);
        Assert.Equal(4, error.Error.Line);
    }

    [SkippableFact]
    public async Task Catalog_SynonymProcFunctionSequenceTypeAndCrossSchemaFk()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var dbo = await reader.LoadSchemaAsync("shop", "dbo", CancellationToken.None);

        var cust = dbo.Objects.Single(o => o.Name == "Cust");
        Assert.Equal(ObjectTypes.Synonym, cust.Type);
        Assert.Equal(new SynonymTarget(null, "dbo", "Customers", ObjectTypes.Table), cust.Target);

        var getCustomer = dbo.Objects.Single(o => o.Name == "GetCustomer");
        Assert.Equal(ObjectTypes.Proc, getCustomer.Type);
        Assert.Equal(new ParamInfo("@Id", "int", "in", false), Assert.Single(getCustomer.Parameters));

        var addLines = dbo.Objects.Single(o => o.Name == "AddOrderLines");
        Assert.Equal(new[] { "in", "in", "out" }, addLines.Parameters.Select(p => p.Direction));

        var fnTax = dbo.Objects.Single(o => o.Name == "fnTax");
        Assert.Equal(ObjectTypes.Func, fnTax.Type);
        Assert.Contains(fnTax.Parameters, p => p.Direction == "return" && p.TypeText == "decimal(12,2)");

        var ordersOf = dbo.Objects.Single(o => o.Name == "OrdersOf");
        Assert.Equal(ObjectTypes.TableFunc, ordersOf.Type);
        Assert.Equal(3, ordersOf.Columns.Count);

        Assert.Equal(ObjectTypes.Sequence, dbo.Objects.Single(o => o.Name == "OrderNumbers").Type);
        var idList = dbo.Objects.Single(o => o.Name == "IdList");
        Assert.Equal(ObjectTypes.Type, idList.Type);
        Assert.Equal("Id", Assert.Single(idList.Columns).Name);

        var customers = dbo.Objects.Single(o => o.Name == "Customers");
        Assert.Equal("Registered customers", customers.Comment);
        Assert.Equal("Display name", customers.Columns.Single(c => c.Name == "Name").Comment);
        Assert.Equal("nvarchar(100)", customers.Columns.Single(c => c.Name == "Name").TypeText);

        var sales = await reader.LoadSchemaAsync("shop", "Sales", CancellationToken.None);
        var fk = Assert.Single(sales.Objects.Single(o => o.Name == "Invoices").ForeignKeys);
        Assert.Equal(("dbo", "Orders"), (fk.RefSchema, fk.RefTable));

        var schemas = await reader.ListSchemasAsync("shop", CancellationToken.None);
        Assert.Contains(schemas, s => s.Name == "Sales");
        Assert.DoesNotContain(schemas, s => s.Name is "sys" or "db_owner" or "INFORMATION_SCHEMA");
        Assert.Contains("shop", await reader.ListDatabasesAsync(CancellationToken.None), StringComparer.OrdinalIgnoreCase);
    }

    [SkippableFact]
    public async Task Catalog_TableDdl_IsValidTsql_And_ProcDdlIsStored()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var table = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", "OrderLines", ObjectTypes.Table), CancellationToken.None);
        Assert.Equal("generated", table.Source);
        Assert.Contains("CONSTRAINT [PK_OrderLines] PRIMARY KEY", table.Ddl);
        Assert.Contains("CONSTRAINT [DF_OrderLines_Qty] DEFAULT ((1))", table.Ddl);
        Assert.Contains("REFERENCES [dbo].[Orders] ([Id])", table.Ddl);
        Assert.Empty(ScriptDomDiagnostics.Analyze(table.Ddl));

        var orders = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", "Orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId]", orders.Ddl);
        Assert.Contains("INCLUDE ([Total])", orders.Ddl);
        Assert.Empty(ScriptDomDiagnostics.Analyze(orders.Ddl));

        var customers = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", "Customers", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("IDENTITY(1,1)", customers.Ddl);

        var proc = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", "GetCustomerReport", ObjectTypes.Proc), CancellationToken.None);
        Assert.Equal("stored", proc.Source);
        Assert.Contains("CREATE PROCEDURE dbo.GetCustomerReport", proc.Ddl);

        var synonym = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", "Cust", ObjectTypes.Synonym), CancellationToken.None);
        Assert.Equal("CREATE SYNONYM [dbo].[Cust] FOR [dbo].[Customers];\n", synonym.Ddl);

        foreach (var (name, type) in new[] { ("OrderNumbers", ObjectTypes.Sequence), ("IdList", ObjectTypes.Type) })
        {
            var ddl = await reader.GetDdlAsync(new ObjectRef("shop", "dbo", name, type), CancellationToken.None);
            Assert.Empty(ScriptDomDiagnostics.Analyze(ddl.Ddl));
        }
    }

    [SkippableFact]
    public async Task Catalog_ObjectDetails_IndexesTriggersParametersRowCount()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var orders = await reader.GetObjectDetailsAsync(new ObjectRef("shop", "dbo", "Orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(orders.Indexes, i => i.IsPrimaryKey && i.Name == "PK_Orders");
        Assert.Contains(orders.Indexes, i => i.Name == "IX_Orders_CustomerId" && !i.Unique);
        Assert.Equal(6, orders.RowCountEstimate);
        Assert.Contains(orders.ReferencedBy, r => r.Schema == "Sales" && r.Table == "Invoices");
        Assert.NotNull(orders.Created);

        var proc = await reader.GetObjectDetailsAsync(new ObjectRef("shop", "dbo", "GetCustomerReport", ObjectTypes.Proc), CancellationToken.None);
        Assert.Equal(new[] { "@Id", "@IncludeLines" }, proc.Parameters.Select(p => p.Name));
    }

    [SkippableFact]
    public async Task Execute_TypedValues_MapToWire()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, 10, true, new SqlBatch(
            "SELECT CAST('2026-10-14' AS date) AS d, CAST('10:00:00.5' AS time) AS t, CAST(12345678901234567890.123456789 AS decimal(38,9)) AS big, " +
            "CAST(0x0102 AS varbinary(10)) AS bin, CAST(1 AS bit) AS flag, NEWID() AS g, CAST('2026-10-14T10:00:00+02:00' AS datetimeoffset) AS dto", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var rs = Assert.Single(sink.ResultSets);
        var row = rs.Rows[0];
        Assert.Equal("2026-10-14", row[0]);
        Assert.Equal("10:00:00.5", row[1]);
        Assert.Equal("12345678901234567890.123456789", row[2]);
        Assert.Equal(true, row[4]);
        Assert.Equal(ColumnKindsOf(rs), new[] { "date", "time", "decimal", "binary", "bool", "guid", "datetimeoffset" });
        Assert.StartsWith("2026-10-14T10:00:00", (string)row[6]!);
    }

    private static string[] ColumnKindsOf(RecordingSink.RecordedResultSet rs) => rs.Columns.Select(c => c.Kind).ToArray();
}
