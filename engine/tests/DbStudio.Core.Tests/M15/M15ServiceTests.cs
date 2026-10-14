using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Filters;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Sample;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite.Designer;
using DbStudio.Providers.Sqlite.Params;
using DbStudio.Providers.Sqlite.Plans;

namespace DbStudio.Core.Tests.M15;

internal static class M15
{
    public static ProviderFeatures Features() =>
        new([new SqliteDdlScripter()], [new SqliteDesignerDatabase()], [new SqlitePlanReader()], [SqliteParamBinder.Instance]);

    public static QueryParam P(string name, string kind, object? value, string? direction = null) =>
        new(name, kind, value is null ? null : JsonValue.Create(value), direction);

    public static async Task<SessionHandle> SeededSessionAsync(EngineEnv env, string file = "db.sqlite")
    {
        var conn = env.AddSqlite(file);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var (_, done) = await env.RunAsync(h.Id,
            "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2), created DATE, flag BOOLEAN)",
            "INSERT INTO items VALUES (1, 'apple', 1.25, '2026-01-01', 1), (2, 'pear', 2.50, '2026-02-01', 0), (3, 'plum', 4.00, '2026-03-01', 1)");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        return h;
    }

    public static async Task<(ExecDoneEvent Done, List<EngineEvent> Events)> RunWithParamsAsync(EngineEnv env, string sid, IReadOnlyList<QueryParam> ps, params string[] sql)
    {
        var started = env.Executions.Start(sid, new ExecuteCommand(sql.Select((s, i) => new SqlBatch(s, i + 1, 1)).ToList(), 1000, true, "statement", Params: ps));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        var events = env.Events.All.Where(e => e switch
        {
            ExecRowsEvent r => r.ExecutionId == started.ExecutionId,
            ExecErrorEvent er => er.ExecutionId == started.ExecutionId,
            ExecResultSetEvent rs => rs.ExecutionId == started.ExecutionId,
            ExecPlanEvent p => p.ExecutionId == started.ExecutionId,
            _ => false,
        }).ToList();
        return (done, events);
    }
}

public sealed class ParamExecutionTests
{
    [Fact]
    public async Task NamedAndPositionalParams_BindTyped()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var (done, events) = await M15.RunWithParamsAsync(env, h.Id,
            [M15.P("min", "decimal", "2"), M15.P("1", "string", "p%"), M15.P("d", "date", "2026-01-15")],
            "SELECT id FROM items WHERE price > :min AND name LIKE ? AND created > @d ORDER BY id");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var rows = events.OfType<ExecRowsEvent>().SelectMany(r => r.Rows).Select(r => Convert.ToInt64(r[0])).ToList();
        Assert.Equal([2L, 3L], rows);
    }

    [Fact]
    public async Task PositionalParams_AreConsumedInOrderAcrossBatches()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var (done, events) = await M15.RunWithParamsAsync(env, h.Id,
            [M15.P("1", "int", 1), M15.P("2", "int", 3), M15.P("3", "string", "pear")],
            "SELECT name FROM items WHERE id = ? OR id = ? ORDER BY id",
            "SELECT id FROM items WHERE name = ?");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var sets = events.OfType<ExecRowsEvent>().ToList();
        Assert.Equal(["apple", "plum"], sets[0].Rows.Select(r => (string)r[0]!).ToList());
        Assert.Equal(2L, Convert.ToInt64(sets[1].Rows[0][0]));
    }

    [Fact]
    public async Task ParamsBindDmlInOneTransaction_AndOnlyReferencedOnes()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var (done, _) = await M15.RunWithParamsAsync(env, h.Id,
            [M15.P("p1", "string", "APPLE"), M15.P("p2", "int", 1), M15.P("p3", "bool", false), M15.P("p4", "int", 3)],
            "UPDATE items SET name = @p1 WHERE id = @p2",
            "UPDATE items SET flag = @p3 WHERE id = @p4");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(2, done.RowsAffected);
        var (_, events) = await M15.RunWithParamsAsync(env, h.Id, [], "SELECT name, flag FROM items WHERE id IN (1, 3) ORDER BY id");
        var rows = events.OfType<ExecRowsEvent>().SelectMany(r => r.Rows).ToList();
        Assert.Equal("APPLE", rows[0][0]);
        Assert.Equal(0L, Convert.ToInt64(rows[1][1]));
    }

    [Fact]
    public async Task NullAndBinaryParams()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var (done, events) = await M15.RunWithParamsAsync(env, h.Id,
            [M15.P("n", "null", null), M15.P("b", "binary", Convert.ToBase64String([1, 2, 3])), M15.P("g", "guid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301")],
            "SELECT :n IS NULL, length(:b), typeof(:b), :g");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var row = events.OfType<ExecRowsEvent>().Single().Rows[0];
        Assert.Equal(1L, Convert.ToInt64(row[0]));
        Assert.Equal(3L, Convert.ToInt64(row[1]));
        Assert.Equal("blob", row[2]);
        Assert.Equal("3f2504e0-4f89-11d3-9a0c-0305e82c3301", row[3]);
    }

    [Theory]
    [InlineData("int", "abc")]
    [InlineData("date", "13/45/2026")]
    [InlineData("guid", "nope")]
    [InlineData("wat", "1")]
    public void InvalidParams_AreRejectedSynchronously(string kind, string value)
    {
        var ex = Assert.Throws<EngineException>(() => ParamValues.Validate([M15.P("x", kind, value)]));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }

    [Fact]
    public void DuplicateParamNames_AreRejected()
    {
        var ex = Assert.Throws<EngineException>(() => ParamValues.Validate([M15.P("x", "int", 1), M15.P(":X", "int", 2)]));
        Assert.Contains("twice", ex.Message);
    }

    [Fact]
    public async Task RefCursor_OnSqlite_IsAnError()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var (done, events) = await M15.RunWithParamsAsync(env, h.Id, [M15.P("c", "refcursor", null)], "SELECT :c");
        Assert.Equal(ExecutionStatus.Error, done.Status);
        Assert.Contains("REF CURSOR", events.OfType<ExecErrorEvent>().Single().Message);
    }

    [Fact]
    public void ToClr_ConvertsKinds()
    {
        Assert.Equal(42L, ParamValues.ToClr(M15.P("a", "int", "42")));
        Assert.Equal(12.5m, ParamValues.ToClr(M15.P("a", "decimal", 12.5)));
        Assert.Equal(true, ParamValues.ToClr(M15.P("a", "bool", "yes")));
        Assert.Equal(new DateTime(2026, 1, 2), ParamValues.ToClr(M15.P("a", "date", "2026-01-02")));
        Assert.Equal(TimeSpan.FromHours(10.5), ParamValues.ToClr(M15.P("a", "time", "10:30:00")));
        Assert.Equal(new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.FromHours(2)), ParamValues.ToClr(M15.P("a", "datetimeoffset", "2026-01-02T03:04:05+02:00")));
        Assert.Equal(new byte[] { 0xCA, 0xFE }, ParamValues.ToClr(M15.P("a", "binary", "0xCAFE")));
        Assert.Null(ParamValues.ToClr(M15.P("a", "string", null)));
    }
}

public sealed class SqliteBinderTests
{
    [Fact]
    public void FindsNamedNumberedAndUnnamedPlaceholders_OutsideStringsAndComments()
    {
        var ph = SqliteParamBinder.Instance.FindPlaceholders("SELECT :a, @b, $c, ?7, ? FROM t WHERE x = ':no' -- ?\n /* @no */");
        Assert.Equal(["a", "b", "c", "7", null], ph.Select(p => p.Name).ToList());
    }

    [Fact]
    public void Bind_RewritesUnnamedPlaceholders_AndReportsMissing()
    {
        using var conn = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=:memory:");
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT ?, :x, ?, :y";
        var bound = SqliteParamBinder.Instance.Bind(cmd, [M15.P("1", "int", 1), M15.P("x", "int", 2)], new ParamBindCursor());
        Assert.Equal("SELECT @__p1, :x, @__p2, :y", cmd.CommandText);
        Assert.Equal(2, bound.Bound.Count);
        Assert.Equal(["?2", "y"], bound.Missing);
    }
}

public sealed class DescribeServiceTests
{
    [Fact]
    public async Task Describe_SingleTable_IsEditableWithKey()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var svc = new DescribeService(env.Sessions, env.Catalog);
        var r = await svc.DescribeAsync(h.Id, "SELECT id, name, price * 2 AS doubled FROM items WHERE id > :min", [M15.P("min", "int", 0)], CancellationToken.None);
        Assert.Equal(["id", "name", "doubled"], r.Columns.Select(c => c.Name).ToList());
        Assert.Equal("int", r.Columns[0].Kind);
        Assert.Equal("items", r.Table?.Name);
        Assert.True(r.Editable);
        Assert.Equal(["id"], r.KeyColumns);
        Assert.Contains("Computed columns are read-only.", r.Warnings);
    }

    [Fact]
    public async Task Describe_WithoutParams_BindsNull_AndDoesNotExecute()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var svc = new DescribeService(env.Sessions, env.Catalog);
        var r = await svc.DescribeAsync(h.Id, "SELECT name FROM items WHERE id = ? AND name = :n", null, CancellationToken.None);
        Assert.Single(r.Columns);
        Assert.False(r.Editable); // the key column is not selected
    }

    [Fact]
    public async Task Describe_RejectsNonQueries()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var svc = new DescribeService(env.Sessions, env.Catalog);
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.DescribeAsync(h.Id, "DELETE FROM items", null, CancellationToken.None));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        await Assert.ThrowsAsync<EngineException>(() => svc.DescribeAsync(h.Id, "SELECT 1; SELECT 2", null, CancellationToken.None));
    }

    [Fact]
    public async Task Describe_Join_IsNotEditable()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        await env.RunAsync(h.Id, "CREATE TABLE tags (item_id INTEGER, tag TEXT)");
        var svc = new DescribeService(env.Sessions, env.Catalog);
        var r = await svc.DescribeAsync(h.Id, "SELECT i.id, t.tag FROM items i JOIN tags t ON t.item_id = i.id", null, CancellationToken.None);
        Assert.False(r.Editable);
        Assert.Null(r.Table);
        Assert.Contains(r.Warnings, w => w.Contains("several tables"));
    }

    [Fact]
    public async Task Describe_MatchesColumnsOfARealRun()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        const string sql = "SELECT id, name, price, created, flag FROM items";
        var described = await new DescribeService(env.Sessions, env.Catalog).DescribeAsync(h.Id, sql, null, CancellationToken.None);
        var (_, events) = await M15.RunWithParamsAsync(env, h.Id, [], sql);
        var run = events.OfType<ExecResultSetEvent>().Single().Columns;
        Assert.Equal(run.Select(c => (c.Name, c.Kind, c.DbType)), described.Columns.Select(c => (c.Name, c.Kind, c.DbType)));
    }
}

public sealed class ExplainServiceTests
{
    [Fact]
    public async Task Estimated_PublishesPlan_WithoutResultSets()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var started = env.Executions.StartExplain(h.Id, new ExplainCommand("SELECT * FROM items WHERE name = :n", ExplainModes.Estimated, 100, [M15.P("n", "string", "x")]), new SqlitePlanReader());
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(0, done.ResultSets);
        var plan = await env.Events.WaitAsync<ExecPlanEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal("estimated", plan.Mode);
        Assert.Contains(plan.Root.DescendantsAndSelf(), n => n.Op.StartsWith("SCAN items", StringComparison.Ordinal));
        Assert.Equal("text", plan.RawFormat);
        Assert.DoesNotContain(env.Events.All, e => e is ExecResultSetEvent rs && rs.ExecutionId == started.ExecutionId);
        var entry = (await env.History.SearchAsync(h.Profile.Id, null, 10, null)).First();
        Assert.Equal("explain", entry.Label);
    }

    [Fact]
    public async Task Actual_StreamsResultSet_ThenPlan()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var started = env.Executions.StartExplain(h.Id, new ExplainCommand("SELECT id FROM items WHERE id = 2", ExplainModes.Actual, 100), new SqlitePlanReader());
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(1, done.ResultSets);
        var plan = await env.Events.WaitAsync<ExecPlanEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Contains(plan.Root.DescendantsAndSelf(), n => n.LogicalOp == "Seek");
        Assert.Single(plan.Warnings);
        var rs = env.Events.All.OfType<ExecResultSetEvent>().Single(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(0, rs.ResultSetId);
        Assert.Equal(0, rs.BatchIndex);
    }

    [Fact]
    public async Task InvalidStatement_ReportsErrorOnBatchZero()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var started = env.Executions.StartExplain(h.Id, new ExplainCommand("SELECT * FROM nope", ExplainModes.Estimated, 100, Line: 7), new SqlitePlanReader());
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(ExecutionStatus.Error, done.Status);
        var err = env.Events.All.OfType<ExecErrorEvent>().Single(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(0, err.BatchIndex);
        Assert.Equal(7, err.Line);
        Assert.DoesNotContain(env.Events.All, e => e is ExecPlanEvent p && p.ExecutionId == started.ExecutionId);
    }

    [Fact]
    public async Task Actual_OnReadOnlyConnection_RejectsDml()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite("ro.sqlite", readOnly: true);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var ex = Assert.Throws<EngineException>(() => env.Executions.StartExplain(h.Id, new ExplainCommand("DELETE FROM t", ExplainModes.Actual, 10), new SqlitePlanReader()));
        Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
    }

    [Fact]
    public void PlanEvent_Serializes()
    {
        var root = new PlanNode { Id = 1, Op = "SCAN t", Cost = 2, Children = [new PlanNode { Id = 2, Op = "x", Cost = 1 }] };
        PlanTree.ComputeCostPercentages(root);
        var json = JsonSerializer.Serialize(new ExecPlanEvent("x_1", Dialect.Sqlite, "estimated", root, "raw", "text", []), CoreJson.Options);
        Assert.Contains("\"type\":\"exec.plan\"", json);
        Assert.Contains("\"dialect\":\"sqlite\"", json);
        Assert.Contains("\"costPct\":50", json);
        Assert.DoesNotContain("\"props\"", json);
    }
}

public sealed class DesignerServiceTests
{
    [Fact]
    public async Task ScriptAndApply_PublishesCatalogChange()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        await env.Catalog.GetSnapshotAsync(h.Profile.Id, null, ["main"], null, CancellationToken.None); // load into cache
        var svc = new DesignerService(env.Connections, env.Providers, M15.Features(), env.Catalog);
        var original = await svc.GetTableAsync(h.Profile.Id, null, null, "items", CancellationToken.None);
        var desired = original with { Columns = [.. original.Columns, new TableColumnModel { Id = "n1", Name = "note", Type = "TEXT" }] };
        var script = await svc.ScriptTableAsync(h.Profile.Id, null, original, desired, CancellationToken.None);
        Assert.False(script.RebuildRequired);
        var result = await svc.ApplyAsync(h.Profile.Id, new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), script.Transactional), CancellationToken.None);
        Assert.Equal(1, result.Executed);
        await env.Events.WaitAsync<CatalogChangedEvent>(e => e.ConnectionId == h.Profile.Id);
        var after = await svc.GetTableAsync(h.Profile.Id, null, null, "items", CancellationToken.None);
        Assert.Equal("note", after.Columns[^1].Name);
    }

    [Fact]
    public async Task Apply_OnReadOnlyConnection_IsRejected()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite("ro.sqlite", readOnly: true);
        var svc = new DesignerService(env.Connections, env.Providers, M15.Features(), env.Catalog);
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.ApplyAsync(conn.Id, new DdlApplyRequest(null, ["CREATE TABLE x (a)"], true), CancellationToken.None));
        Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
    }

    [Fact]
    public async Task Apply_Failure_RollsBack_AndReportsIndex()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var svc = new DesignerService(env.Connections, env.Providers, M15.Features(), env.Catalog);
        var ex = await Assert.ThrowsAsync<DdlFailedException>(() => svc.ApplyAsync(h.Profile.Id,
            new DdlApplyRequest(null, ["CREATE TABLE a1 (x)", "BEGIN", "CREATE TABLE a2 (x)", "CREATE TABLE a1 (x)", "COMMIT"], true), CancellationToken.None));
        Assert.Equal(3, ex.FailedIndex);
        Assert.Equal(2, ex.Executed);
        Assert.True(ex.RolledBack);
        Assert.Equal(409, ex.Status);
        Assert.Equal("DDL_FAILED", ex.Code);
        var tables = await svc.GetTableAsync(h.Profile.Id, null, null, "items", CancellationToken.None);
        Assert.NotNull(tables);
        await Assert.ThrowsAsync<EngineException>(() => svc.GetTableAsync(h.Profile.Id, null, null, "a1", CancellationToken.None));
    }

    [Fact]
    public async Task Script_InvalidModel_IsValidationError()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var svc = new DesignerService(env.Connections, env.Providers, M15.Features(), env.Catalog);
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.ScriptTableAsync(conn.Id, null, null, new TableModel { Name = "t" }, CancellationToken.None));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }
}

public sealed class FilterStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-filters", Guid.NewGuid().ToString("N"));

    private static JsonObject Model(string logic = "and") => new() { ["root"] = new JsonObject { ["id"] = "g", ["logic"] = logic, ["items"] = new JsonArray() } };

    [Fact]
    public void Crud_PersistsAcrossInstances_AndFiltersBySignature()
    {
        var paths = new AppPaths(_dir);
        var store = new FilterStore(paths);
        var a = store.Create(new SavedFilterInput("c1", "Id:int|Name:string", "Big", Model()));
        store.Create(new SavedFilterInput("c1", "Other:int", "Other", Model("or")));
        store.Create(new SavedFilterInput("c2", "Id:int|Name:string", "Elsewhere", Model()));
        Assert.StartsWith("f_", a.Id);

        var reloaded = new FilterStore(paths);
        Assert.Equal(2, reloaded.List("c1", null).Count);
        var bySig = Assert.Single(reloaded.List("c1", "Id:int|Name:string"));
        Assert.Equal("Big", bySig.Name);

        var updated = reloaded.Update(a.Id, new SavedFilterPatch("Bigger", null, "2026-10-14T10:00:00Z"));
        Assert.Equal("Bigger", updated.Name);
        Assert.Equal("2026-10-14T10:00:00.000Z", updated.LastUsedAt);
        Assert.True(reloaded.Delete(a.Id));
        Assert.False(reloaded.Delete(a.Id));
        Assert.Equal(1, reloaded.DeleteForConnection("c2"));
        Assert.Single(new FilterStore(paths).List("c1", null));
    }

    [Fact]
    public void Validation()
    {
        var store = new FilterStore(new AppPaths(_dir));
        Assert.Throws<EngineException>(() => store.Create(new SavedFilterInput(null, "s", "n", Model())));
        Assert.Throws<EngineException>(() => store.Create(new SavedFilterInput("c", "s", " ", Model())));
        Assert.Throws<EngineException>(() => store.Create(new SavedFilterInput("c", "s", "n", new JsonObject { ["root"] = new JsonObject { ["logic"] = "xor", ["items"] = new JsonArray() } })));
        Assert.Throws<EngineException>(() => store.Update("f_missing", new SavedFilterPatch("x", null, null)));
        Assert.Throws<EngineException>(() => store.List("", null));
    }

    [Fact]
    public void CorruptFile_StartsEmpty()
    {
        var paths = new AppPaths(_dir);
        File.WriteAllText(Path.Combine(paths.DataDir, "filters.json"), "{ not json");
        var store = new FilterStore(paths);
        Assert.Empty(store.List("c1", null));
        store.Create(new SavedFilterInput("c1", "", "x", Model()));
        Assert.True(File.Exists(Path.Combine(paths.DataDir, "filters.json.corrupt")));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}

public sealed class HistoryFilterTests
{
    [Fact]
    public async Task StatusRangeAndPinnedFilters()
    {
        await using var env = new EngineEnv();
        var t0 = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var ok = await env.History.AddAsync("c1", null, "SELECT 1", t0, 1, ExecutionStatus.Ok, null, 1, null, "statement");
        await env.History.AddAsync("c1", null, "SELECT x", t0.AddDays(1), 1, ExecutionStatus.Error, null, null, "no such column", "statement");
        await env.History.AddAsync("c1", null, "SELECT 2", t0.AddDays(2), 1, ExecutionStatus.Cancelled, null, null, null, "filter");
        await env.History.AddAsync("c2", null, "SELECT 3", t0.AddDays(3), 1, ExecutionStatus.Ok, null, 1, null, "explain");
        await env.History.SetPinnedAsync(ok, true);

        async Task<List<string>> Q(string? conn, HistoryFilter f) => (await env.History.SearchAsync(conn, null, 100, null, f)).Select(e => e.Sql).ToList();
        Assert.Equal(["SELECT x"], await Q("c1", new HistoryFilter(["error"])));
        Assert.Equal(["SELECT 2", "SELECT x"], await Q("c1", new HistoryFilter(["error", "cancelled"])));
        Assert.Equal(["SELECT 2", "SELECT x"], await Q(null, new HistoryFilter(From: t0.AddDays(1), To: t0.AddDays(2))));
        Assert.Equal(["SELECT 1"], await Q(null, new HistoryFilter(PinnedOnly: true)));
        Assert.Equal(["SELECT 3", "SELECT 1"], await Q(null, new HistoryFilter(["ok"])));
        Assert.Equal(4, (await env.History.SearchAsync(null, null, 100, null)).Count);
    }
}

public sealed class SettingsM15Tests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-settings15", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Defaults_ContainM15Keys()
    {
        var s = new SettingsService(new AppPaths(_dir)).Get();
        Assert.Equal("upper", s["format"]!["keywordCase"]!.GetValue<string>());
        Assert.Equal(8, s["connections"]!["maxSessionsPerProfile"]!.GetValue<int>());
        Assert.Equal(1000, s["grid"]!["pageSize"]!.GetValue<int>());
        Assert.IsType<JsonArray>(s["snippets"]);
        Assert.IsType<JsonObject>(s["editor"]!["blankLineSplitsStatementsByDialect"]);
    }

    [Fact]
    public void Update_MergesAndValidates()
    {
        var svc = new SettingsService(new AppPaths(_dir));
        var s = svc.Update(JsonNode.Parse("""
            { "format": { "indent": 2, "commaStyle": "leading" },
              "snippets": [ { "id": "s_1", "name": "Count", "prefix": "selc", "dialects": ["tsql"], "body": "SELECT COUNT(*) FROM ${1:t}$0" } ],
              "grid": { "density": "compact" },
              "connections": { "maxSessionsPerProfile": 2 },
              "editor": { "blankLineSplitsStatementsByDialect": { "plsql": false } } }
            """)!.AsObject());
        Assert.Equal(2, s["format"]!["indent"]!.GetValue<int>());
        Assert.Equal(120, s["format"]!["lineWidth"]!.GetValue<int>());
        Assert.Equal("compact", s["grid"]!["density"]!.GetValue<string>());
        Assert.Single(s["snippets"]!.AsArray());
        Assert.False(s["editor"]!["blankLineSplitsStatementsByDialect"]!["plsql"]!.GetValue<bool>());

        Assert.Throws<EngineException>(() => svc.Update(JsonNode.Parse("""{ "format": { "commaStyle": "middle" } }""")!.AsObject()));
        Assert.Throws<EngineException>(() => svc.Update(JsonNode.Parse("""{ "grid": { "pageSize": 0 } }""")!.AsObject()));
        Assert.Throws<EngineException>(() => svc.Update(JsonNode.Parse("""{ "snippets": [ { "id": "a", "name": "", "prefix": "p", "body": "" } ] }""")!.AsObject()));
        Assert.Throws<EngineException>(() => svc.Update(JsonNode.Parse("""{ "snippets": [ { "id": "a", "name": "n", "prefix": "p", "body": "", "dialects": ["mysql"] } ] }""")!.AsObject()));
        Assert.Throws<EngineException>(() => svc.Update(JsonNode.Parse("""{ "editor": { "blankLineSplitsStatementsByDialect": { "mysql": true } } }""")!.AsObject()));
        // The failed updates left the stored settings untouched.
        Assert.Equal(2, svc.Get()["connections"]!["maxSessionsPerProfile"]!.GetValue<int>());
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}

public sealed class SessionLimitTests
{
    [Fact]
    public async Task ExceedingTheLimit_Returns429SessionLimit()
    {
        await using var env = new EngineEnv();
        var settings = new SettingsService(env.Paths);
        settings.Update(JsonNode.Parse("""{ "connections": { "maxSessionsPerProfile": 2 } }""")!.AsObject());
        await using var sessions = new SessionManager(env.Providers, env.Connections, env.Events, env.Results, settings: settings);
        var conn = env.AddSqlite();
        var other = env.AddSqlite("other.sqlite");
        await sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var second = await sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var ex = await Assert.ThrowsAsync<EngineException>(() => sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None));
        Assert.Equal(429, ex.Status);
        Assert.Equal("SESSION_LIMIT", ex.Code);
        Assert.Contains("\"limit\":2", JsonSerializer.Serialize(ex.Detail, CoreJson.Options));
        await sessions.CreateAsync(other.Id, null, TransactionMode.Auto, false, CancellationToken.None); // per profile
        await sessions.CloseAsync(second.Id, false);
        await sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
    }

    [Fact]
    public async Task SessionInfo_ReportsExecutingSinceAndTab()
    {
        await using var env = new EngineEnv();
        var h = await M15.SeededSessionAsync(env);
        var started = env.Executions.Start(h.Id, new ExecuteCommand([new SqlBatch("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) FROM c", 1, 1)],
            10, true, "statement", false, "t1", "query1.sql"));
        await Task.Delay(50);
        var info = h.ToInfo();
        Assert.Equal("t1", info.TabId);
        Assert.Equal("query1.sql", info.Label);
        env.Executions.Cancel(h.Id);
        await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Null(h.ToInfo().ExecutingSince);
    }
}

public sealed class SampleDatabaseTests
{
    [Fact]
    public async Task Ensure_CreatesFixtureAndProfile_Idempotently()
    {
        await using var env = new EngineEnv();
        var sample = new SampleDatabase(env.Paths, env.Connections);
        var first = await sample.EnsureAsync(false, CancellationToken.None);
        Assert.True(first.Created);
        Assert.Equal(Path.Combine(env.Paths.DataDir, "sample", "shop.sqlite"), first.Path);
        Assert.Equal(SampleDatabase.ProfileName, first.Profile.Name);
        var again = await sample.EnsureAsync(false, CancellationToken.None);
        Assert.False(again.Created);
        Assert.Equal(first.ConnectionId, again.ConnectionId);
        Assert.Single(env.Connections.List());

        var h = await env.Sessions.CreateAsync(first.ConnectionId, null, TransactionMode.Auto, false, CancellationToken.None);
        var (_, events) = await M15.RunWithParamsAsync(env, h.Id, [],
            "SELECT (SELECT count(*) FROM Countries), (SELECT count(*) FROM Customers), (SELECT count(*) FROM Products), (SELECT count(*) FROM Orders), " +
            "(SELECT count(*) FROM OrderLines), (SELECT count(*) FROM sqlite_master WHERE type = 'trigger'), (SELECT count(*) FROM CustomerOrderTotals), " +
            "(SELECT count(*) FROM Orders o WHERE abs(o.Total - (SELECT round(coalesce(sum(Qty * UnitPrice * (1 - Discount)), 0), 2) FROM OrderLines l WHERE l.OrderId = o.Id)) > 0.01)",
            "PRAGMA foreign_key_check");
        var sets = events.OfType<ExecRowsEvent>().ToList();
        var counts = sets[0].Rows[0].Select(v => Convert.ToInt64(v)).ToList();
        Assert.Equal([SampleDatabase.CountryCount, SampleDatabase.CustomerCount, SampleDatabase.ProductCount, SampleDatabase.OrderCount], counts.Take(4));
        Assert.InRange(counts[4], SampleDatabase.OrderCount, SampleDatabase.OrderCount * 5);
        Assert.Equal(2, counts[5]);
        Assert.Equal(SampleDatabase.CustomerCount, counts[6]);
        Assert.Equal(0, counts[7]); // triggers kept order totals consistent
        Assert.Single(sets); // foreign_key_check returned no rows
    }
}
