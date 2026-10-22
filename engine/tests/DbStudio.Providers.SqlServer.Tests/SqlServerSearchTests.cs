using DbStudio.Core.Models;
using DbStudio.Core.Search;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>Find in database: the catalog and data queries parse on SQL Server 2008 (no STRING_AGG, CONCAT, TRY_CAST…).</summary>
public sealed class SqlServerSearchQueryTests
{
    public static TheoryData<string> QueryNames => new(SqlServerSearchQueries.All.Keys);

    private static void Parses(string sql, TSqlParser parser)
    {
        parser.Parse(new StringReader(sql), out var errors);
        Assert.True(errors.Count == 0, string.Join("; ", errors.Select(e => $"{e.Line}:{e.Column} {e.Message}")) + Environment.NewLine + sql);
    }

    [Theory]
    [MemberData(nameof(QueryNames))]
    public void CatalogQuery_ParsesWithTheSql2008AndTheCurrentGrammar(string name)
    {
        var sql = SqlServerSearchQueries.All[name];
        Parses(sql, new TSql100Parser(true));
        Parses(sql, ScriptDomDiagnostics.CreateParser());
        Assert.DoesNotContain("STRING_AGG", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DataQuery_ParsesWithTheSql2008Grammar()
    {
        var q = SearchSql.BuildDataQuery(Dialect.TSql, "my]schema", "Order Lines", ["Id"],
            [("Id", "int"), ("Name", "nvarchar(50)"), ("Doc", "xml"), ("Ref", "uniqueidentifier"), ("Memo", "ntext")], new SearchMatcher("50%_[x]"), 20)!;
        Parses(q.Sql, new TSql100Parser(true));
        Assert.StartsWith("SELECT TOP (20) [Id], [Name], CAST([Doc] AS nvarchar(max))", q.Sql);
        Assert.Equal("%50!%!_![x]%", q.Parameters[0].Value);
    }
}

public sealed class SqlServerSearchTests(SqlServerFixture fixture) : IClassFixture<SqlServerFixture>
{
    private void RequireAvailable()
    {
        if (fixture.SetupError is not null) throw fixture.SetupError;
        Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "SQL Server not available.");
    }

    private async Task<List<SearchItem>> SearchAsync(SearchRequest request)
    {
        var provider = new SqlServerProvider();
        var service = new DatabaseSearchService((_, ct) => provider.OpenSearcherAsync(fixture.Profile!, fixture.Password, ct));
        var items = new List<SearchItem>();
        await service.RunAsync(request, i => { lock (items) items.Add(i); }, CancellationToken.None);
        return items;
    }

    private SearchRequest Request(string term, SearchTarget target, bool data = false, bool regex = false, bool matchCase = false) => new()
    {
        Matcher = new SearchMatcher(term, matchCase: matchCase, regex: regex),
        Targets = [target],
        Names = !data, Columns = !data, Code = !data, Data = data,
    };

    [SkippableFact]
    public async Task NamesColumnsAndCode_InOneSchema()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("customer", new SearchTarget(fixture.Profile!.Id, "shop", "dbo")));
        Assert.DoesNotContain(items, i => i is SearchError);
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "Customers", Object.Type: "table", Database: "shop", Schema: "dbo" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "CustomerOrders", Object.Type: "view" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "GetCustomer", Object.Type: "proc" });
        Assert.Contains(hits, h => h is { Match: "column", Object.Name: "Orders", Column: "CustomerId", DataType: "int" });
        var line = Assert.Single(hits, h => h is { Match: "code", Object.Name: "GetCustomer" } && h.Text.Contains("FROM dbo.Customers"));
        Assert.Equal(4, line.Line);
        Assert.IsType<SearchDone>(items[^1]);
    }

    [SkippableFact]
    public async Task WholeConnection_FindsTheShopDatabase_NotTheSystemOnes_AndMatchCase()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("OrderLines", new SearchTarget(fixture.Profile!.Id)));
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Database: "shop", Object.Name: "OrderLines" });
        Assert.DoesNotContain(hits, h => h.Database is "master" or "msdb" or "model" or "tempdb");

        items = await SearchAsync(Request("CUSTOMERS", new SearchTarget(fixture.Profile!.Id, "shop", "dbo"), matchCase: true));
        Assert.DoesNotContain(items.OfType<SearchHit>(), h => h.Match == "name");
    }

    [SkippableFact]
    public async Task Data_RowsWithTheirKey_AndRegexIsANotice()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("alice", new SearchTarget(fixture.Profile!.Id, "shop", "dbo"), data: true));
        var hits = items.OfType<SearchHit>().Where(h => h.Object.Name == "Customers").ToList();
        Assert.Equal(["Email", "Name"], hits.Select(h => h.Column!).Order());
        Assert.All(hits, h => Assert.Equal(new SearchKeyValue("Id", 1L), Assert.Single(h.Key!)));
        Assert.DoesNotContain(items, i => i is SearchError);

        items = await SearchAsync(Request("ali.e", new SearchTarget(fixture.Profile!.Id, "shop", "dbo"), data: true, regex: true));
        Assert.Contains(items, i => i is SearchError { Notice: true });
        Assert.Empty(items.OfType<SearchHit>());
    }

    [SkippableFact]
    public async Task Data_ChosenTables_Only()
    {
        RequireAvailable();
        var target = new SearchTarget(fixture.Profile!.Id, "shop", null, [new ObjectRef("shop", "dbo", "Products", "table")]);
        var items = await SearchAsync(Request("o", target, data: true));
        Assert.NotEmpty(items.OfType<SearchHit>());
        Assert.All(items.OfType<SearchHit>(), h => Assert.Equal("Products", h.Object.Name));
    }
}
