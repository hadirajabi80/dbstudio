using DbStudio.Core.Models;
using DbStudio.Core.Search;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>Find in database on the seeded shop database (public + sales).</summary>
public sealed class PgSearchTests(PgFixture fixture) : IClassFixture<PgFixture>
{
    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "PostgreSQL not available.");

    private async Task<List<SearchItem>> SearchAsync(SearchRequest request)
    {
        var provider = new PostgreSqlProvider();
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

    [Fact]
    public void Queries_UsePositionalParametersOnly() =>
        Assert.All(PgSearchQueries.All.Values, q => Assert.DoesNotContain("@", q));

    [SkippableFact]
    public async Task NamesColumnsAndCode_InOneSchema()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("customer", new SearchTarget(fixture.Profile!.Id, null, "public")));
        Assert.DoesNotContain(items, i => i is SearchError);
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "customers", Object.Type: "table", Schema: "public" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "customer_orders", Object.Type: "view" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "customer_totals", Object.Type: "mview" });
        Assert.Contains(hits, h => h is { Match: "name", Object.Name: "get_customer_report", Object.Type: "proc" });
        Assert.Contains(hits, h => h is { Match: "column", Object.Name: "orders", Column: "customer_id", DataType: "integer" });
        Assert.Contains(hits, h => h is { Match: "code", Object.Name: "get_customer_report" } && h.Text.Contains("FROM public.customers"));
        Assert.Contains(hits, h => h is { Match: "code", Object.Name: "customer_orders", Object.Type: "view" });
        Assert.IsType<SearchDone>(items[^1]);
    }

    [SkippableFact]
    public async Task WholeConnection_SearchesEveryDatabaseAndSchema()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("invoices", new SearchTarget(fixture.Profile!.Id)));
        Assert.Contains(items.OfType<SearchHit>(), h => h is { Match: "name", Database: "shop", Schema: "sales", Object.Name: "invoices" });
        items = await SearchAsync(Request("INVOICES", new SearchTarget(fixture.Profile!.Id, "shop", "sales"), matchCase: true));
        Assert.DoesNotContain(items.OfType<SearchHit>(), h => h.Match == "name");
    }

    [SkippableFact]
    public async Task Data_LikeAndRegex_InAReadOnlyTransaction()
    {
        RequireAvailable();
        var items = await SearchAsync(Request("alice", new SearchTarget(fixture.Profile!.Id, null, "public"), data: true));
        Assert.DoesNotContain(items, i => i is SearchError);
        var hit = Assert.Single(items.OfType<SearchHit>(), h => h.Object.Name == "customers");
        Assert.Equal(("name", "Alice"), (hit.Column, hit.Text));
        Assert.Equal(new SearchKeyValue("id", 1L), Assert.Single(hit.Key!));
        Assert.All(items.OfType<SearchHit>(), h => Assert.Equal("table", h.Object.Type)); // views are not read

        items = await SearchAsync(Request("^gold$|\"tier\"", new SearchTarget(fixture.Profile!.Id, null, "public"), data: true, regex: true));
        Assert.Contains(items.OfType<SearchHit>(), h => h is { Object.Name: "extra_types", Column: "meta" });
    }
}
