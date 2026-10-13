using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>Oracle specific behaviour (docs/PLAN.md 6, WP-B acceptance). Skipped without Docker.</summary>
public sealed class OracleIntegrationTests(OracleFixture fixture) : IClassFixture<OracleFixture>
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(90);

    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "Oracle not available.");

    private static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession session, bool capture, params SqlBatch[] batches)
    {
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(batches, 1000, true, capture, "script"), sink, CancellationToken.None).WaitAsync(Timeout);
        return (summary, sink);
    }

    [SkippableFact]
    public async Task DbmsOutput_LinesAreCaptured_InOrder_AcrossChunks()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync(captureServerOutput: true);
        var (summary, sink) = await RunAsync(session, true,
            new SqlBatch("BEGIN\n  DBMS_OUTPUT.PUT_LINE('hello');\n  DBMS_OUTPUT.PUT_LINE('world');\nEND;", 1, 1),
            new SqlBatch("BEGIN FOR i IN 1..2500 LOOP DBMS_OUTPUT.PUT_LINE('line ' || i); END LOOP; END;", 5, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var first = sink.Messages.Where(m => m.BatchIndex == 0 && m.Source == MessageSource.DbmsOutput).Select(m => m.Text).ToList();
        Assert.Equal(new[] { "hello", "world" }, first);
        var second = sink.Messages.Where(m => m.BatchIndex == 1 && m.Source == MessageSource.DbmsOutput).ToList();
        Assert.Equal(2500, second.Count);
        Assert.Equal("line 2500", second[^1].Text);
    }

    [SkippableFact]
    public async Task DbmsOutput_FromProcedure_ViaExecRewrite()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync(captureServerOutput: true);
        var (summary, sink) = await RunAsync(session, true, new SqlBatch("EXEC PRINT_CUSTOMER(1);", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(new[] { "Customer: Alice", "Email: alice@example.com" },
            sink.Messages.Where(m => m.Source == MessageSource.DbmsOutput).Select(m => m.Text));
    }

    [SkippableFact]
    public async Task DbmsOutput_NotCaptured_WhenDisabled()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync(captureServerOutput: false);
        var (summary, sink) = await RunAsync(session, false, new SqlBatch("BEGIN DBMS_OUTPUT.PUT_LINE('quiet'); END;", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.DoesNotContain(sink.Messages, m => m.Source == MessageSource.DbmsOutput);
    }

    [SkippableFact]
    public async Task CreateProcedure_WithTypo_ReportsAllErrorsAsDocumentDiagnostics()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        // Document: the CREATE starts on line 10; the missing ';' after NULL is reported on line 13 ("END").
        const string sql = "CREATE OR REPLACE PROCEDURE ZZ_BAD_PROC AS\nBEGIN\n  NULL\nEND;";
        var (summary, sink) = await RunAsync(session, false, new SqlBatch(sql, 10, 1));
        try
        {
            Assert.Equal(ExecutionStatus.Error, summary.Status);
            Assert.Equal(BatchStatus.Error, Assert.Single(sink.BatchesEnded).Status);
            var diag = Assert.Single(sink.DiagnosticsEvents).Diagnostics;
            Assert.NotEmpty(diag);
            Assert.All(diag, d => Assert.InRange(d.Line, 10, 13));
            Assert.Contains(diag, d => d.Code == "PLS-00103");
            Assert.Contains(sink.Errors, e => e.Error.Code == "PLS-00103" && e.Error.Line is >= 12 and <= 13);

            await using var reader = await fixture.OpenCatalogAsync();
            var errors = await reader.GetCompileErrorsAsync(new ObjectRef(null, "SHOP", "ZZ_BAD_PROC", ObjectTypes.Proc), CancellationToken.None);
            Assert.NotEmpty(errors);
            Assert.All(errors, e => Assert.Equal("error", e.Severity));
        }
        finally
        {
            await RunAsync(session, false, new SqlBatch("DROP PROCEDURE ZZ_BAD_PROC", 1, 1));
        }
    }

    [SkippableFact]
    public async Task ImplicitResultSets_ViaDbmsSqlReturnResult()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, false, new SqlBatch("BEGIN CUSTOMER_REPORT(1); END;", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(2, sink.ResultSets.Count);
        Assert.Equal("Alice", sink.ResultSets[0].Rows[0][1]);
        Assert.Equal(2, sink.ResultSets[1].RowCount);
    }

    [SkippableFact]
    public async Task BindVariables_AreRejected_WithNames()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, false,
            new SqlBatch("SELECT * FROM CUSTOMERS\nWHERE ID = :id AND NAME = :name AND ':x' IS NOT NULL", 3, 1));
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal(ErrorCodes.BindVarsUnsupported, error.Code);
        Assert.Equal("id,name", error.Detail);
        Assert.Equal(4, error.Line);
        Assert.Equal(SessionState.Idle, session.State);
    }

    [SkippableFact]
    public async Task AutoMode_CommitsAfterEachBatch()
    {
        RequireAvailable();
        var table = "ZZ_AUTO_" + Guid.NewGuid().ToString("N")[..6].ToUpperInvariant();
        await using var session = await fixture.OpenSessionAsync();
        try
        {
            var (summary, sink) = await RunAsync(session, false,
                new SqlBatch($"CREATE TABLE {table} (ID NUMBER)", 1, 1),
                new SqlBatch($"INSERT INTO {table} VALUES (1);", 2, 1),
                new SqlBatch($"BEGIN INSERT INTO {table} VALUES (2); END;", 3, 1));
            Assert.Equal(ExecutionStatus.Ok, summary.Status);
            Assert.Contains(sink.Affected, a => a.BatchIndex == 1 && a.Count == 1);
            Assert.False(session.TxOpen);
            // A different session sees both rows: they were committed.
            Assert.Equal(2m, decimal.Parse(ValueConverter.ToInvariantString(await fixture.ScalarAsync($"SELECT COUNT(*) FROM {table}"))));
        }
        finally
        {
            await RunAsync(session, false, new SqlBatch($"DROP TABLE {table} PURGE", 1, 1));
        }
    }

    [SkippableFact]
    public async Task ChangeDatabase_SetsCurrentSchema()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        Assert.Equal("SHOP", session.CurrentDatabase);

        await session.ChangeDatabaseAsync("SYS", CancellationToken.None);
        Assert.Equal("SYS", session.CurrentDatabase);
        var (_, sink) = await RunAsync(session, false, new SqlBatch("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM dual", 1, 1));
        Assert.Equal("SYS", sink.ResultSets[0].Rows[0][0]);

        await session.ChangeDatabaseAsync("shop", CancellationToken.None);   // lower case folds to SHOP
        Assert.Equal("SHOP", session.CurrentDatabase);

        var (s2, _) = await RunAsync(session, false, new SqlBatch("ALTER SESSION SET CURRENT_SCHEMA = SYSTEM", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, s2.Status);
        Assert.Equal("SYSTEM", session.CurrentDatabase);
    }

    [SkippableFact]
    public async Task Catalog_PackageMembers_WithOverloads_SequenceSynonym()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var shop = await reader.LoadSchemaAsync(null, "SHOP", CancellationToken.None);

        var api = shop.Objects.Single(o => o.Name == "ORDER_API");
        Assert.Equal(ObjectTypes.Package, api.Type);
        Assert.Equal("VALID", api.Status);
        var create = Assert.Single(api.Members, m => m.Name == "CREATE_ORDER");
        Assert.Equal(ObjectTypes.Proc, create.Kind);
        Assert.Equal(new[] { "P_CUST", "P_TOTAL" }, create.Parameters.Select(p => p.Name));
        Assert.All(create.Parameters, p => Assert.Equal("in", p.Direction));
        var totals = api.Members.Where(m => m.Name == "GET_TOTAL").OrderBy(m => m.Overload).ToList();
        Assert.Equal(2, totals.Count);
        Assert.Equal(new[] { 1, 2 }, totals.Select(t => t.Overload));
        Assert.All(totals, t => Assert.Equal(ObjectTypes.Func, t.Kind));
        Assert.All(totals, t => Assert.Contains(t.Parameters, p => p.Direction == "return" && p.TypeText == "NUMBER"));
        Assert.Equal(2, totals[0].Parameters.Count);
        Assert.Equal(3, totals[1].Parameters.Count);

        Assert.Equal(ObjectTypes.Sequence, shop.Objects.Single(o => o.Name == "ORDERS_SEQ").Type);
        var cust = shop.Objects.Single(o => o.Name == "CUST");
        Assert.Equal(new SynonymTarget(null, "SHOP", "CUSTOMERS", ObjectTypes.Table), cust.Target);

        var fn = shop.Objects.Single(o => o.Name == "FN_TAX");
        Assert.Equal(ObjectTypes.Func, fn.Type);
        Assert.Equal(new[] { "in", "return" }, fn.Parameters.Select(p => p.Direction));

        var customers = shop.Objects.Single(o => o.Name == "CUSTOMERS");
        Assert.Equal("Registered customers", customers.Comment);
        Assert.Equal("VARCHAR2(100)", customers.Columns.Single(c => c.Name == "NAME").TypeText);
        Assert.Equal("NUMBER(10)", customers.Columns.Single(c => c.Name == "ID").TypeText);

        // FK direction: ORDER_LINES → ORDERS / PRODUCTS.
        var lines = shop.Objects.Single(o => o.Name == "ORDER_LINES");
        Assert.Equal(new[] { "ORDERS", "PRODUCTS" }, lines.ForeignKeys.Select(f => f.RefTable).OrderBy(x => x));
        Assert.DoesNotContain(shop.Objects.Single(o => o.Name == "ORDERS").ForeignKeys, f => f.RefTable == "ORDER_LINES");
    }

    [SkippableFact]
    public async Task Catalog_PublicSynonym_ResolvedOnDemand()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var dual = await reader.ResolvePublicSynonymAsync("dual", CancellationToken.None);
        Assert.NotNull(dual);
        Assert.Equal(("PUBLIC", "DUAL"), (dual!.Schema, dual.Name));
        Assert.Equal(("SYS", "DUAL"), (dual.Target!.Schema, dual.Target.Name));

        var shopCustomers = await reader.ResolvePublicSynonymAsync("SHOP_CUSTOMERS", CancellationToken.None);
        Assert.Equal(new SynonymTarget(null, "SHOP", "CUSTOMERS", ObjectTypes.Table), shopCustomers!.Target);

        Assert.Null(await reader.ResolvePublicSynonymAsync("NO_SUCH_SYNONYM_XYZ", CancellationToken.None));
    }

    [SkippableFact]
    public async Task Catalog_Ddl_ForPackageSequenceSynonym()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        var pkg = await reader.GetDdlAsync(new ObjectRef(null, "SHOP", "ORDER_API", ObjectTypes.Package), CancellationToken.None);
        Assert.Contains("PACKAGE", pkg.Ddl);
        Assert.Contains("PACKAGE BODY", pkg.Ddl);
        Assert.Contains("GET_TOTAL", pkg.Ddl);
        var seq = await reader.GetDdlAsync(new ObjectRef(null, "SHOP", "ORDERS_SEQ", ObjectTypes.Sequence), CancellationToken.None);
        Assert.Contains("CREATE SEQUENCE", seq.Ddl);
        var syn = await reader.GetDdlAsync(new ObjectRef(null, "SHOP", "CUST", ObjectTypes.Synonym), CancellationToken.None);
        Assert.Contains("SYNONYM", syn.Ddl);
    }

    [SkippableFact]
    public async Task Catalog_SchemasAndCurrent()
    {
        RequireAvailable();
        await using var reader = await fixture.OpenCatalogAsync();
        Assert.Empty(await reader.ListDatabasesAsync(CancellationToken.None));
        Assert.Equal("SHOP", await reader.GetCurrentDatabaseAsync(CancellationToken.None));
        var schemas = await reader.ListSchemasAsync(null, CancellationToken.None);
        Assert.Contains(schemas, s => s.Name == "SHOP");
        Assert.DoesNotContain(schemas, s => s.Name is "SYS" or "XDB" or "MDSYS");
    }

    [SkippableFact]
    public async Task Execute_TypedValues_MapToWire()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, false, new SqlBatch(
            "SELECT 1/3 AS third, DATE '2026-10-14' AS d, TIMESTAMP '2026-10-14 10:00:00.5 +02:00' AS tz, " +
            "INTERVAL '1-2' YEAR TO MONTH AS ym, HEXTORAW('0102') AS r, TO_CLOB('long text') AS c, CAST(NULL AS NUMBER) AS n FROM dual", 1, 1));
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var rs = Assert.Single(sink.ResultSets);
        var row = rs.Rows[0];
        Assert.StartsWith("0.3333333333333333333333333333333333333", (string)row[0]!);   // full NUMBER precision
        Assert.Equal("2026-10-14T00:00:00", row[1]);
        Assert.StartsWith("2026-10-14T10:00:00.5+02:00", (string)row[2]!);
        Assert.Equal("long text", row[5]);
        Assert.Null(row[6]);
        Assert.Equal(new[] { "decimal", "datetime", "datetimeoffset", "string", "binary", "string", "decimal" }, rs.Columns.Select(c => c.Kind));
        Assert.Equal("NUMBER", rs.Columns[0].DbType);
    }

    [SkippableFact]
    public async Task Error_InvalidIdentifier_PointsAtIdentifier()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (_, sink) = await RunAsync(session, false, new SqlBatch("SELECT ID,\n       NO_SUCH_COL\nFROM CUSTOMERS", 5, 1));
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("ORA-00904", error.Code);
        Assert.Equal(904, error.ProviderCode);
        Assert.Equal((6, 8), (error.Line, error.Col));
    }

    [SkippableFact]
    public async Task Error_PlSqlBlock_MapsLineAndColumn()
    {
        RequireAvailable();
        await using var session = await fixture.OpenSessionAsync();
        var (_, sink) = await RunAsync(session, false, new SqlBatch("BEGIN\n  no_such_proc_xyz;\nEND;", 20, 1));
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("ORA-06550", error.Code);
        Assert.Equal(21, error.Line);
        Assert.Equal(3, error.Col);
    }
}
