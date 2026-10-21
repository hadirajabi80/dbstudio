using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>Object browser (WP3) dictionary SQL: owner-bound, no SYS noise; live checks against the seeded SHOP schema.</summary>
public sealed class OracleDependencyQueryTests
{
    public static TheoryData<string> QueryNames => new(OracleDependencyQueries.All.Keys);

    [Theory]
    [MemberData(nameof(QueryNames))]
    public void EveryDictionaryQuery_IsBoundToAnOwner(string name)
    {
        var sql = OracleDependencyQueries.All[name];
        if (!Regex.IsMatch(sql, @"\ball_\w+", RegexOptions.IgnoreCase)) return;
        Assert.Matches(new Regex(@"(?:owner|table_owner)\s*=\s*:owner\b", RegexOptions.IgnoreCase), sql);
        Assert.DoesNotContain(";", sql); // ODP.NET rejects a trailing semicolon in SQL
    }

    [Fact]
    public void Uses_SkipsSysAndPublic() => Assert.Contains("referenced_owner NOT IN ('SYS','PUBLIC')", OracleDependencyQueries.Uses);

    [Theory]
    [InlineData("PACKAGE BODY", ObjectTypes.Package)]
    [InlineData("TYPE BODY", ObjectTypes.Type)]
    [InlineData("TABLE", ObjectTypes.Table)]
    [InlineData("TRIGGER", ObjectTypes.Trigger)]
    [InlineData("JAVA CLASS", null)]
    public void Bodies_MapToTheirSpec(string oracle, string? expected) => Assert.Equal(expected, OracleDependencyReader.MapType(oracle));
}

public sealed class OracleDependencyTests(OracleFixture fixture) : IClassFixture<OracleFixture>
{
    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "Oracle not available.");

    private async Task<DependencyGraph> DepsAsync(string name, string type)
    {
        await using var r = await new OracleProvider().OpenDependencyReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        return await r.GetDependenciesAsync(new ObjectRef(null, fixture.ShopSchema, name, type), CancellationToken.None);
    }

    [SkippableFact]
    public async Task Table_FksViewsAndPackage()
    {
        RequireAvailable();
        var g = await DepsAsync("ORDERS", ObjectTypes.Table);
        Assert.Contains(g.Uses, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "CUSTOMERS" && d.Detail == "FK_ORDERS_CUSTOMERS: CUSTOMER_ID → ID");
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "ORDER_LINES");
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "CUSTOMER_ORDERS", Type: ObjectTypes.View });
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "ORDER_API", Type: ObjectTypes.Package });
        Assert.Contains(g.UsedBy, d => d.Object is { Name: "CUSTOMER_REPORT", Type: ObjectTypes.Proc });
    }

    [SkippableFact]
    public async Task Package_UsesTablesSequenceAndFunction_NotItself()
    {
        RequireAvailable();
        var g = await DepsAsync("ORDER_API", ObjectTypes.Package);
        Assert.Contains(g.Uses, d => d.Object is { Name: "ORDERS", Type: ObjectTypes.Table });
        Assert.Contains(g.Uses, d => d.Object is { Name: "ORDERS_SEQ", Type: ObjectTypes.Sequence });
        Assert.Contains(g.Uses, d => d.Object is { Name: "FN_TAX", Type: ObjectTypes.Func });
        Assert.DoesNotContain(g.Uses, d => d.Object.Name == "ORDER_API");
        Assert.DoesNotContain(g.Uses, d => d.Object.Schema is "SYS" or "PUBLIC");
        var f = await DepsAsync("FN_TAX", ObjectTypes.Func);
        Assert.Contains(f.UsedBy, d => d.Object is { Name: "ORDER_API", Type: ObjectTypes.Package });
    }

    [SkippableFact]
    public async Task ObjectList_HasTablesWithRowEstimates()
    {
        RequireAvailable();
        await using var r = await new OracleProvider().OpenObjectListReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        var all = await r.ListAsync(null, fixture.ShopSchema, null, CancellationToken.None);
        Assert.Contains(all, o => o is { Name: "CUSTOMERS", Type: ObjectTypes.Table });
        Assert.Contains(all, o => o is { Name: "ORDER_API", Type: ObjectTypes.Package });
        Assert.Single(all, o => o.Name == "ORDER_API"); // spec and body: one row
        Assert.All(all, o => Assert.NotNull(o.Created));
    }
}
