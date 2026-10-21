using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using DbStudio.Sources.Mongo.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class DocumentsServiceTests
{
    private readonly DocumentsService _svc = new();
    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task Find_parses_shell_text_and_counts_exactly()
    {
        var fake = T.Shop();
        var r = await _svc.FindAsync(T.Handle(fake), "shop", "orders", new MongoFindRequest
        {
            Filter = "{ status: 'paid', total: { $gt: 500 } }", Sort = "{ total: -1 }", Projection = "{ total: 1 }", Skip = 1, Limit = 5,
        }, None);
        Assert.Equal(5, r.Docs.Count);
        Assert.Equal(new MongoCount(14, true), r.Count); // paid totals above 500: i = 48, 52, …, 100
        var first = BsonDocument.Parse(r.Docs[0]);
        Assert.Equal(["_id", "total"], first.Names);
        Assert.Equal(96 * 10.5, first["total"].AsDouble);
        Assert.Contains("\"$oid\"", r.Docs[0]);
        Assert.Contains("$numberDouble", r.Docs[0]); // canonical EJSON
    }

    [Fact]
    public async Task Unfiltered_collections_use_the_estimate_and_views_count_documents()
    {
        var fake = T.Shop();
        var r = await _svc.FindAsync(T.Handle(fake), "shop", "orders", new MongoFindRequest { Limit = 1 }, None);
        Assert.Equal(new MongoCount(100, true), r.Count);
        Assert.Equal(1, fake.CallCount("estimatedCount"));
        Assert.Equal(0, fake.CallCount("count"));
        var v = await _svc.FindAsync(T.Handle(fake), "shop", "paid_orders", new MongoFindRequest { Limit = 3 }, None);
        Assert.Equal(new MongoCount(25, true), v.Count);
        Assert.Equal(1, fake.CallCount("count"));
    }

    [Fact]
    public async Task Count_timeout_falls_back_to_an_inexact_estimate()
    {
        var fake = T.Shop();
        fake.Fail("count", MongoFake.Timeout());
        var r = await _svc.FindAsync(T.Handle(fake), "shop", "orders", new MongoFindRequest { Filter = "{ status: 'paid' }", Limit = 2 }, None);
        Assert.Equal(new MongoCount(100, false), r.Count);

        var slow = T.Shop();
        slow.CountDelay = TimeSpan.FromSeconds(5);
        var svc = new DocumentsService { CountMaxTime = TimeSpan.FromMilliseconds(50) };
        var r2 = await svc.FindAsync(T.Handle(slow), "shop", "orders", new MongoFindRequest { Filter = "{ status: 'paid' }", Limit = 2 }, None);
        Assert.False(r2.Count.Exact);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1001, 0)]
    [InlineData(10, -1)]
    public async Task Limit_and_skip_are_validated(int limit, int skip)
    {
        var ex = await Assert.ThrowsAsync<EngineException>(() =>
            _svc.FindAsync(T.Handle(T.Shop()), "shop", "orders", new MongoFindRequest { Limit = limit, Skip = skip }, None));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }

    [Fact]
    public async Task Bad_filter_text_is_a_positioned_parse_error()
    {
        var ex = await Assert.ThrowsAsync<ShellJsonException>(() =>
            _svc.FindAsync(T.Handle(T.Shop()), "shop", "orders", new MongoFindRequest { Filter = "{ status: }" }, None));
        Assert.Equal("filter", ex.Field);
        Assert.Equal(11, ex.Col);
    }

    [Fact]
    public async Task Find_truncates_but_doc_returns_everything()
    {
        var fake = new MongoFake();
        var big = new string('z', 40_000);
        fake.Seed("db", "c", [new BsonDocument { { "_id", 1 }, { "text", big } }]);
        var h = T.Handle(fake);
        var found = await _svc.FindAsync(h, "db", "c", new MongoFindRequest(), None);
        Assert.Contains("$trunc", found.Docs[0]);
        var full = await _svc.GetAsync(h, "db", "c", "{\"$numberInt\": \"1\"}", None);
        Assert.Equal(big, BsonDocument.Parse(full.Doc!)["text"].AsString);
        Assert.Null((await _svc.GetAsync(h, "db", "c", "2", None)).Doc);
    }

    [Fact]
    public async Task Insert_generates_an_id_and_reports_duplicates()
    {
        var fake = T.Shop();
        var h = T.Handle(fake);
        var r = await _svc.InsertAsync(h, "shop", "orders", new MongoInsertRequest { Doc = "{ status: 'new', at: ISODate() }" }, None);
        Assert.StartsWith("{ \"$oid\" :", r.InsertedId);
        Assert.Equal(101, fake.Snapshot("shop", "orders").Count);
        var dup = await Assert.ThrowsAsync<EngineException>(() =>
            _svc.InsertAsync(h, "shop", "customers", new MongoInsertRequest { Doc = "{ _id: 1 }" }, None));
        Assert.Equal((422, ErrorCodes.ProviderError), (dup.Status, dup.Code));
        Assert.Contains("E11000", dup.Message);
    }

    [Fact]
    public async Task Replace_by_id_adds_the_id_and_refuses_id_changes()
    {
        var fake = T.Shop();
        var h = T.Handle(fake);
        var r = await _svc.ReplaceAsync(h, "shop", "customers", new MongoReplaceRequest { Id = "1", Doc = "{ name: 'Renamed' }" }, None);
        Assert.Equal(new MongoReplaceResponse(1, 1), r);
        var doc = fake.Snapshot("shop", "customers").First(d => d["_id"] == 1);
        Assert.Equal(["_id", "name"], doc.Names);
        var same = await _svc.ReplaceAsync(h, "shop", "customers", new MongoReplaceRequest { Id = "1", Doc = "{ _id: 1, name: 'Renamed' }" }, None);
        Assert.Equal(new MongoReplaceResponse(1, 0), same);
        var ex = await Assert.ThrowsAsync<EngineException>(() =>
            _svc.ReplaceAsync(h, "shop", "customers", new MongoReplaceRequest { Id = "1", Doc = "{ _id: 2, name: 'x' }" }, None));
        Assert.Equal("doc._id", MongoSettingsBuilderTests.Field(ex));
        Assert.Contains("insert + delete", ex.Message);
        var missing = await _svc.ReplaceAsync(h, "shop", "customers", new MongoReplaceRequest { Id = "999", Doc = "{}" }, None);
        Assert.Equal(0, missing.Matched);
    }

    [Fact]
    public async Task Delete_by_ids()
    {
        var fake = T.Shop();
        var r = await _svc.DeleteAsync(T.Handle(fake), "shop", "customers", new MongoDeleteRequest { Ids = ["1", "{\"$numberInt\":\"2\"}", "999"] }, None);
        Assert.Equal(2, r.Deleted);
        Assert.Equal(18, fake.Snapshot("shop", "customers").Count);
        await Assert.ThrowsAsync<EngineException>(() => _svc.DeleteAsync(T.Handle(fake), "shop", "customers", new MongoDeleteRequest { Ids = [] }, None));
    }
}

public sealed class AggregateServiceTests
{
    private readonly AggregateService _svc = new();

    private static MongoAggregateRequest Req(int? preview = null, int limit = 20, int skip = 0, params string[] stages) =>
        new() { Pipeline = [.. stages], PreviewStage = preview, Limit = limit, Skip = skip, MaxTimeMs = 10_000 };

    [Fact]
    public async Task Full_runs_page_and_flag_truncation()
    {
        var r = await _svc.RunAsync(T.Handle(T.Shop()), "shop", "orders", Req(null, 10, 5, "{ $match: { status: 'paid' } }", "{ $sort: { total: 1 } }"),
            CancellationToken.None);
        Assert.Equal(10, r.Docs.Count);
        Assert.True(r.Truncated);
        Assert.Equal(24 * 10.5, BsonDocument.Parse(r.Docs[0])["total"].AsDouble); // skipped 4, 8, 12, 16, 20
        Assert.Null(r.WriteStageSkipped);
        var all = await _svc.RunAsync(T.Handle(T.Shop()), "shop", "orders", Req(null, 100, 0, "{ $match: { status: 'paid' } }"), CancellationToken.None);
        Assert.False(all.Truncated);
        Assert.Equal(25, all.Docs.Count);
    }

    [Fact]
    public async Task Preview_runs_up_to_the_stage()
    {
        var h = T.Handle(T.Shop());
        var stages = new[] { "{ $match: { status: 'paid' } }", "{ $group: { _id: '$customerId', n: { $sum: 1 } } }", "{ $count: 'groups' }" };
        var p0 = await _svc.RunAsync(h, "shop", "orders", Req(0, 10, 0, stages), CancellationToken.None);
        Assert.Equal(10, p0.Docs.Count);
        Assert.True(BsonDocument.Parse(p0.Docs[0]).Contains("status"));
        var p1 = await _svc.RunAsync(h, "shop", "orders", Req(1, 10, 0, stages), CancellationToken.None);
        Assert.True(BsonDocument.Parse(p1.Docs[0]).Contains("n"));
        var p2 = await _svc.RunAsync(h, "shop", "orders", Req(2, 10, 0, stages), CancellationToken.None);
        Assert.Equal(5, BsonDocument.Parse(Assert.Single(p2.Docs))["groups"].AsInt32);
        await Assert.ThrowsAsync<EngineException>(() => _svc.RunAsync(h, "shop", "orders", Req(3, 10, 0, stages), CancellationToken.None));
    }

    [Fact]
    public async Task Previews_never_run_write_stages()
    {
        var fake = T.Shop();
        var r = await _svc.RunAsync(T.Handle(fake, readOnly: true), "shop", "orders",
            Req(1, 10, 0, "{ $match: { status: 'paid' } }", "{ $out: 'paid_copy' }"), CancellationToken.None);
        Assert.True(r.WriteStageSkipped);
        Assert.Equal(10, r.Docs.Count);
        Assert.Empty(fake.Snapshot("shop", "paid_copy"));
    }

    [Fact]
    public async Task Full_runs_with_out_are_read_only_guarded_and_return_nothing()
    {
        var fake = T.Shop();
        var stages = new[] { "{ $match: { status: 'paid' } }", "{ $out: 'paid_copy' }" };
        var ro = await Assert.ThrowsAsync<EngineException>(() => _svc.RunAsync(T.Handle(fake, readOnly: true), "shop", "orders", Req(null, 10, 0, stages),
            CancellationToken.None));
        Assert.Equal(ErrorCodes.ReadOnly, ro.Code);
        Assert.Contains("run $out/$merge", ro.Message);
        var r = await _svc.RunAsync(T.Handle(fake), "shop", "orders", Req(null, 10, 0, stages), CancellationToken.None);
        Assert.Empty(r.Docs);
        Assert.False(r.Truncated);
        Assert.Equal(25, fake.Snapshot("shop", "paid_copy").Count);
    }

    [Theory]
    [InlineData("{ $match: {}, $sort: { a: 1 } }", "pipeline[0]")]
    [InlineData("{ match: {} }", "pipeline[0]")]
    [InlineData("[1]", "pipeline[0]")]
    public async Task Stages_must_be_single_dollar_key_documents(string stage, string field)
    {
        var ex = await Assert.ThrowsAnyAsync<Exception>(() => _svc.RunAsync(T.Handle(T.Shop()), "shop", "orders", Req(null, 10, 0, stage), CancellationToken.None));
        var mapped = MongoErrors.Map(ex)!;
        Assert.Equal(ErrorCodes.Validation, mapped.Code);
        Assert.Equal(field, MongoSettingsBuilderTests.Field(mapped));
    }

    [Fact]
    public async Task Write_stage_in_the_middle_is_rejected()
    {
        var ex = await Assert.ThrowsAsync<EngineException>(() => _svc.RunAsync(T.Handle(T.Shop()), "shop", "orders",
            Req(null, 10, 0, "{ $out: 'x' }", "{ $match: {} }"), CancellationToken.None));
        Assert.Equal("pipeline[0]", MongoSettingsBuilderTests.Field(ex));
    }
}

public sealed class ExplainTests
{
    private static BsonDocument Fixture(string name) =>
        BsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "explain", name + ".json")));

    [Fact]
    public void Collscan_fixture()
    {
        var r = ExplainNormalizer.Normalize(Fixture("collscan"));
        Assert.Equal("COLLSCAN", r.Root.Op);
        Assert.Equal("shop.customers", r.Root.Object);
        Assert.Equal(1, r.Root.Id);
        Assert.Equal(12, r.Root.ActualRows);
        Assert.Null(r.Root.EstRows);
        Assert.Null(r.Root.Cost);
        Assert.Equal("""{"tier":{"$eq":"gold"}}""", r.Root.Predicate);
        Assert.Equal("200", r.Root.Props!["docsExamined"]);
        Assert.Equal("201", r.Root.Props["works"]);
        Assert.Equal("0", r.Root.Props["rejectedPlans"]);
        Assert.Contains("Collection scan", r.Root.Warnings);
        Assert.Equal(
        [
            "Collection scan: no index was used to find the documents.",
            "Examined 200 documents to return 12 (17×).",
        ], r.Warnings);
        Assert.Equal(new MongoExplainSummary(12, 200, 0, 3, [], true, false, 0) with { Indexes = r.Summary.Indexes }, r.Summary);
        Assert.Empty(r.Summary.Indexes);
        Assert.Contains("\"queryPlanner\"", r.Raw);
        Assert.Contains("\n", r.Raw);
    }

    [Fact]
    public void Ixscan_fetch_fixture()
    {
        var r = ExplainNormalizer.Normalize(Fixture("ixscan-fetch"));
        Assert.Equal(["LIMIT", "FETCH", "IXSCAN"], r.Root.DescendantsAndSelf().Select(n => n.Op));
        Assert.Equal([1, 2, 3], r.Root.DescendantsAndSelf().Select(n => n.Id));
        var ix = r.Root.DescendantsAndSelf().Last();
        Assert.Equal("status_1_createdAt_-1", ix.Object);
        Assert.Equal(31, ix.ActualRows);
        Assert.Equal("31", ix.Props!["keysExamined"]);
        Assert.Equal("""{"status":1,"createdAt":-1}""", ix.Props["keyPattern"]);
        Assert.Equal("false", ix.Props["isMultiKey"]);
        Assert.Equal("forward", ix.Props["direction"]);
        Assert.Equal("""status ["paid", "paid"]; createdAt [MaxKey, MinKey]""", ix.Predicate);
        Assert.Equal("""{"total":{"$gt":100}}""", r.Root.Children[0].Predicate);
        Assert.Equal(["1 rejected plan(s)."], r.Warnings);
        Assert.Equal(["status_1_createdAt_-1"], r.Summary.Indexes);
        Assert.False(r.Summary.Collscan);
        Assert.Equal(1, r.Summary.RejectedPlans);
        Assert.Equal(20, r.Summary.NReturned);
        Assert.Equal("1", r.Root.Props!["rejectedPlans"]);
    }

    [Fact]
    public void Sort_in_memory_fixture()
    {
        var r = ExplainNormalizer.Normalize(Fixture("sort-in-memory"));
        Assert.Equal("SORT", r.Root.Op);
        Assert.Contains("In-memory sort", r.Root.Warnings);
        Assert.Equal("104857600", r.Root.Props!["memLimit"]);
        Assert.Equal("false", r.Root.Props["usedDisk"]);
        Assert.Equal(
        [
            "Collection scan: no index was used to find the documents.",
            "Examined 2,000 documents to return 10 (200×).",
            "Sort in memory: add an index that matches the sort.",
        ], r.Warnings);
        Assert.True(r.Summary.SortInMemory);
        Assert.Equal(1640, r.Root.Children[0].ActualRows);
    }

    [Fact]
    public void Aggregate_cursor_fixture_stacks_later_stages_above_the_cursor_plan()
    {
        var r = ExplainNormalizer.Normalize(Fixture("aggregate-cursor-group"));
        Assert.Equal(["$sort", "$group", "PROJECTION_SIMPLE", "FETCH", "IXSCAN"], r.Root.DescendantsAndSelf().Select(n => n.Op));
        var group = r.Root.Children[0];
        Assert.Equal(180, group.ActualRows);
        Assert.Equal("""{"_id":"$customerId","spent":{"$sum":"$total"}}""", group.Predicate);
        Assert.Equal("3", group.Props!["executionTimeMillisEstimate"]);
        Assert.Equal(500, group.Children[0].ActualRows);
        Assert.Equal(180, r.Summary.NReturned);
        Assert.Equal(500, r.Summary.DocsExamined);
        Assert.Equal(6, r.Summary.ExecutionTimeMs);
        Assert.Equal(["status_1_createdAt_-1"], r.Summary.Indexes);
        Assert.Contains("Sort in memory: add an index that matches the sort.", r.Warnings);
    }

    [Fact]
    public void Sbe_query_plan_fixture()
    {
        var r = ExplainNormalizer.Normalize(Fixture("sbe-queryplan"));
        Assert.Equal(["GROUP", "FETCH", "IXSCAN"], r.Root.DescendantsAndSelf().Select(n => n.Op));
        Assert.Equal(4, r.Root.ActualRows); // SBE stages do not mirror the plan: totals on the root
        Assert.Equal("500", r.Root.Props!["docsExamined"]);
        Assert.Null(r.Root.Children[0].ActualRows);
        Assert.Equal(1, r.Summary.RejectedPlans);
        Assert.Equal(["Examined 500 documents to return 4 (125×).", "1 rejected plan(s)."], r.Warnings);
    }

    [Fact]
    public void Query_planner_only_has_no_actual_rows()
    {
        var d = Fixture("ixscan-fetch");
        d.Remove("executionStats");
        var r = ExplainNormalizer.Normalize(d);
        Assert.All(r.Root.DescendantsAndSelf(), n => Assert.Null(n.ActualRows));
        Assert.Null(r.Summary.NReturned);
        Assert.Null(r.Summary.DocsExamined);
    }

    [Fact]
    public async Task Find_explain_over_the_fake_uses_the_index_and_reports_collscan_otherwise()
    {
        var svc = new ExplainService();
        var h = T.Handle(T.Shop());
        var ix = await svc.ExplainAsync(h, "shop", "orders", new MongoExplainRequest
        {
            Kind = "find", Verbosity = "executionStats", Filter = "{ status: 'paid', total: { $gt: 100 } }", Limit = 20,
        }, CancellationToken.None);
        Assert.Contains("IXSCAN", ix.Root.DescendantsAndSelf().Select(n => n.Op));
        Assert.Equal(["status_1_createdAt_-1"], ix.Summary.Indexes);
        Assert.Equal(20, ix.Summary.NReturned);
        Assert.Equal(25, ix.Summary.KeysExamined);

        var scan = await svc.ExplainAsync(h, "shop", "orders", new MongoExplainRequest
        {
            Kind = "find", Verbosity = "executionStats", Filter = "{ total: { $gt: 1000 } }", Sort = "{ total: -1 }",
        }, CancellationToken.None);
        Assert.True(scan.Summary.Collscan);
        Assert.True(scan.Summary.SortInMemory);
        Assert.Equal(ExplainNormalizer.CollscanWarning, scan.Warnings[0]);
        Assert.Equal("Examined 100 documents to return 5 (20×).", scan.Warnings[1]);
        Assert.Equal(ExplainNormalizer.SortWarning, scan.Warnings[2]);
    }

    [Fact]
    public async Task Aggregate_explain_over_the_fake_and_write_stage_note()
    {
        var svc = new ExplainService();
        var r = await svc.ExplainAsync(T.Handle(T.Shop()), "shop", "orders", new MongoExplainRequest
        {
            Kind = "aggregate", Verbosity = "executionStats",
            Pipeline = ["{ $match: { status: 'paid' } }", "{ $group: { _id: '$customerId', n: { $sum: 1 } } }", "{ $out: 'x' }"],
        }, CancellationToken.None);
        Assert.Equal("$group", r.Root.Op);
        Assert.Equal(5, r.Root.ActualRows);
        Assert.Equal("FETCH", r.Root.Children[0].Op);
        Assert.Contains(ExplainService.WriteStageNotExplained, r.Warnings);
        var qp = await svc.ExplainAsync(T.Handle(T.Shop()), "shop", "orders", new MongoExplainRequest { Kind = "find", Verbosity = "queryPlanner" },
            CancellationToken.None);
        Assert.Null(qp.Root.ActualRows);
        await Assert.ThrowsAsync<EngineException>(() => svc.ExplainAsync(T.Handle(T.Shop()), "shop", "orders", new MongoExplainRequest { Kind = "update" },
            CancellationToken.None));
    }
}
