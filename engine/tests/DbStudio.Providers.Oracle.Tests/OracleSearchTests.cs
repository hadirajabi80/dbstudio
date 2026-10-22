using DbStudio.Core.Models;
using DbStudio.Core.Search;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>Find in database on the seeded SHOP schema.</summary>
public sealed class OracleSearchTests(OracleFixture fixture) : IClassFixture<OracleFixture>
{
    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "Oracle not available.");

    private async Task<List<SearchItem>> SearchAsync(SearchRequest request)
    {
        var provider = new OracleProvider();
        var service = new DatabaseSearchService((_, ct) => provider.OpenSearcherAsync(fixture.Profile!, fixture.Password, ct));
        var items = new List<SearchItem>();
        await service.RunAsync(request, i => { lock (items) items.Add(i); }, CancellationToken.None);
        return items;
    }

    private SearchRequest Request(string term, SearchTarget target, bool data = false, bool regex = false) => new()
    {
        Matcher = new SearchMatcher(term, regex: regex),
        Targets = [target],
        Names = !data, Columns = !data, Code = !data, Data = data,
    };

    [Fact]
    public void Queries_BindByNameWithColons()
    {
        Assert.All(OracleSearchQueries.All.Values, q => Assert.Contains(":owner", q));
        Assert.Contains("UPPER(text) LIKE UPPER(:p) ESCAPE '!'", OracleSearchQueries.Source(true, false));
        Assert.Equal("VARCHAR2(10)", OracleSearcher.TypeText("VARCHAR2", 10, null, null));
        Assert.Equal("NUMBER(10,2)", OracleSearcher.TypeText("NUMBER", 22, 10, 2));
        Assert.Equal("DATE", OracleSearcher.TypeText("DATE", 7, null, null));
    }

    [SkippableFact]
    public async Task NamesColumnsCodeAndViewText()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("cust", new SearchTarget(fixture.Profile!.Id, null, "SHOP")));
        Assert.DoesNotContain(items, i => i is SearchError);
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "CUSTOMERS", Object.Type: "table", Schema: "SHOP" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "CUSTOMER_ORDERS", Object.Type: "view" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "CUST", Object.Type: "synonym" });
        Assert.Contains(hits, h => h is { Match: "column", Object.Name: "ORDERS", Column: "CUSTOMER_ID" });
        Assert.Contains(hits, h => h is { Match: "code", Object.Name: "ORDER_API", Object.Type: "package" } && h.Line > 0);
        Assert.Contains(hits, h => h is { Match: "code", Object.Name: "CUSTOMER_ORDERS", Object.Type: "view" });
        Assert.IsType<SearchDone>(items[^1]);
    }

    [SkippableFact]
    public async Task Data_LikeAndRegexp()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("alice", new SearchTarget(fixture.Profile!.Id, null, "SHOP"), data: true));
        Assert.DoesNotContain(items, i => i is SearchError);
        var hits = items.OfType<SearchHit>().Where(h => h.Object.Name == "CUSTOMERS").ToList();
        Assert.Equal(["EMAIL", "NAME"], hits.Select(h => h.Column!).Order());
        Assert.All(hits, h => Assert.Equal("ID", Assert.Single(h.Key!).Column));

        items = await SearchAsync(Request("^ch.e$", new SearchTarget(fixture.Profile!.Id, null, "SHOP"), data: true, regex: true));
        Assert.Contains(items.OfType<SearchHit>(), h => h is { Object.Name: "CUSTOMERS", Column: "NAME", Text: "Chie" });
    }
}
