using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>Object browser (WP3): the T-SQL parses on old compatibility levels; live checks against the seeded shop.</summary>
public sealed class SqlServerDependencyQueryTests
{
    public static TheoryData<string> QueryNames => new(SqlServerDependencyQueries.All.Keys);

    /// <summary>Parsed with the SQL Server 2008 grammar (compatibility level 100): no STRING_AGG, CONCAT_WS, TRY_CAST…</summary>
    [Theory]
    [MemberData(nameof(QueryNames))]
    public void Query_ParsesWithTheSql2008Grammar(string name)
    {
        var parser = new TSql100Parser(true);
        var fragment = parser.Parse(new StringReader(SqlServerDependencyQueries.All[name]), out var errors);
        Assert.True(errors.Count == 0, $"{name}: {string.Join("; ", errors.Select(e => $"{e.Line}:{e.Column} {e.Message}"))}");
        var script = Assert.IsType<TSqlScript>(fragment);
        Assert.Single(Assert.Single(script.Batches).Statements);
        Assert.DoesNotContain("STRING_AGG", SqlServerDependencyQueries.All[name], StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [MemberData(nameof(QueryNames))]
    public void Query_ParsesWithTheCurrentGrammar(string name)
    {
        var parser = ScriptDomDiagnostics.CreateParser();
        parser.Parse(new StringReader(SqlServerDependencyQueries.All[name]), out var errors);
        Assert.Empty(errors);
    }

    [Fact]
    public void ReferenceQueries_SkipUnresolvedAndCrossDatabaseRows_AndAvoidNameFunctionsOnTheOtherSide()
    {
        Assert.Contains("d.referenced_id IS NOT NULL", SqlServerDependencyQueries.Uses);
        foreach (var q in new[] { SqlServerDependencyQueries.Uses, SqlServerDependencyQueries.UsedBy, SqlServerDependencyQueries.ForeignKeysIn, SqlServerDependencyQueries.ForeignKeysOut })
        {
            Assert.DoesNotContain("OBJECT_NAME(", q);
            Assert.DoesNotContain("OBJECT_SCHEMA_NAME(", q);
        }
    }
}

public sealed class SqlServerDependencyTests(SqlServerFixture fixture) : IClassFixture<SqlServerFixture>
{
    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "SQL Server not available.");

    private async Task<DependencyGraph> DepsAsync(string schema, string name, string type)
    {
        await using var r = await new SqlServerProvider().OpenDependencyReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        return await r.GetDependenciesAsync(new ObjectRef(null, schema, name, type), CancellationToken.None);
    }

    private async Task ExecAsync(string sql)
    {
        await using var s = await fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 10, true, false, "script"), sink, CancellationToken.None);
    }

    [SkippableFact]
    public async Task Table_FksBothWays_ViewsRoutinesAndTriggers()
    {
        RequireAvailable();
        await ExecAsync("CREATE OR ALTER TRIGGER dbo.trg_Orders_Wp3 ON dbo.Orders AFTER INSERT, UPDATE AS SET NOCOUNT ON;");
        try
        {
            var g = await DepsAsync("dbo", "Orders", ObjectTypes.Table);
            Assert.Contains(g.Uses, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "Customers" && d.Detail == "FK_Orders_Customers: CustomerId → Id");
            Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "OrderLines");
            Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object is { Schema: "Sales", Name: "Invoices" });
            Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "CustomerOrders", Type: ObjectTypes.View });
            Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "GetCustomerReport", Type: ObjectTypes.Proc });
            Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "OrdersOf", Type: ObjectTypes.TableFunc });
            var trg = Assert.Single(g.UsedBy, d => d.Kind == DependencyKinds.Trigger);
            Assert.Equal("trg_Orders_Wp3", trg.Object.Name);
            Assert.Equal("AFTER INSERT, UPDATE", trg.Detail);

            var t = await DepsAsync("dbo", "trg_Orders_Wp3", ObjectTypes.Trigger);
            Assert.Contains(t.Uses, d => d.Kind == DependencyKinds.Trigger && d.Object.Name == "Orders");
        }
        finally
        {
            await ExecAsync("DROP TRIGGER dbo.trg_Orders_Wp3;");
        }
    }

    [SkippableFact]
    public async Task View_And_Procedure_Uses()
    {
        RequireAvailable();
        var v = await DepsAsync("dbo", "CustomerOrders", ObjectTypes.View);
        Assert.Equal(["Customers", "Orders"], v.Uses.Select(d => d.Object.Name).Order());
        var p = await DepsAsync("dbo", "GetCustomerReport", ObjectTypes.Proc);
        Assert.Contains(p.Uses, d => d.Object.Name == "OrderLines");
        var missing = await Assert.ThrowsAsync<EngineException>(() => DepsAsync("dbo", "NoSuchThing", ObjectTypes.Table));
        Assert.Equal(404, missing.Status);
    }

    [SkippableFact]
    public async Task ObjectList_RowsSizesComments()
    {
        RequireAvailable();
        await using var r = await new SqlServerProvider().OpenObjectListReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        var all = await r.ListAsync(null, null, null, CancellationToken.None);
        var customers = Assert.Single(all, o => o.Name == "Customers");
        Assert.Equal(5, customers.RowCount);
        Assert.True(customers.SizeBytes > 0);
        Assert.Equal("Registered customers", customers.Comment);
        Assert.NotNull(customers.Modified);
        Assert.Contains(all, o => o is { Schema: "Sales", Name: "Invoices" });
        var procs = await r.ListAsync(null, "dbo", ObjectTypes.Proc, CancellationToken.None);
        Assert.All(procs, o => Assert.Equal(ObjectTypes.Proc, o.Type));
        Assert.Contains(procs, o => o.Name == "GetCustomer");
    }
}
