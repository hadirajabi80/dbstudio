using System.Text.Json;
using DbStudio.Core.Queries;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests.Queries;

/// <summary>Saved queries: round-trip, unique names per schema (ignoring case), rename / text / copy, validation names the field.</summary>
public sealed class SavedQueryStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-queries", Guid.NewGuid().ToString("N"));

    private static SavedQueryInput Input(string name, string? schema = "dbo", string? database = "Shop", string sql = "SELECT 1", string? description = null) =>
        new(database, schema, name, sql, description);

    private static string Field(Action a)
    {
        var ex = Assert.Throws<EngineException>(a);
        Assert.Equal(400, ex.Status);
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        return JsonSerializer.Serialize(ex.Detail, CoreJson.Options);
    }

    [Fact]
    public void Crud_PersistsAcrossInstances()
    {
        var paths = new AppPaths(_dir);
        var store = new SavedQueryStore(paths);
        var a = store.Create("c1", Input("Top customers", sql: "SELECT TOP 10 * FROM dbo.Customers", description: "  for the weekly report "));
        store.Create("c1", Input("orders by day", schema: "sales"));
        store.Create("c1", Input("Oracle style", schema: "SHOP", database: null));
        store.Create("c2", Input("Top customers"));

        Assert.StartsWith("q_", a.Id);
        Assert.Equal("for the weekly report", a.Description);
        Assert.Equal(a.CreatedAt, a.UpdatedAt);
        Assert.Equal("Shop", a.Database);
        Assert.Equal("dbo", a.Schema);

        var reloaded = new SavedQueryStore(paths);
        Assert.Equal(["Oracle style", "orders by day", "Top customers"], reloaded.List("c1").Select(q => q.Name));
        Assert.Equal(["Top customers"], reloaded.List("c1", "Shop", "dbo").Select(q => q.Name));
        Assert.Equal(["Oracle style"], reloaded.List("c1", "", "SHOP").Select(q => q.Name)); // "" = saved without a database
        Assert.Equal(2, reloaded.List("c1", "Shop").Count);
        Assert.Equal("SELECT TOP 10 * FROM dbo.Customers", reloaded.Get("c1", a.Id).Sql);
        Assert.Throws<EngineException>(() => reloaded.Get("c2", a.Id)); // another connection's id is not found

        Assert.True(reloaded.Delete("c1", a.Id));
        Assert.False(reloaded.Delete("c1", a.Id));
        Assert.Equal(2, new SavedQueryStore(paths).List("c1").Count);
        Assert.Equal(1, reloaded.DeleteForConnection("c2"));
        Assert.Empty(new SavedQueryStore(paths).List("c2"));
        Assert.True(File.Exists(Path.Combine(paths.DataDir, "queries.json")));
    }

    [Fact]
    public void Names_AreUniquePerSchema_IgnoringCase()
    {
        var store = new SavedQueryStore(new AppPaths(_dir));
        var first = store.Create("c1", Input("Report"));
        var detail = Field(() => store.Create("c1", Input("  report ")));
        Assert.Contains("\"field\":\"name\"", detail);
        Assert.Contains("\"reason\":\"duplicate\"", detail);
        Assert.Contains(first.Id, detail);

        // the same name is fine in another schema, database or connection
        store.Create("c1", Input("Report", schema: "sales"));
        store.Create("c1", Input("Report", database: "Staging"));
        store.Create("c2", Input("Report"));
        Assert.Equal(4, store.List("c1").Count + store.List("c2").Count);

        // renaming onto a taken name fails; a change of case of its own name does not
        var other = store.Create("c1", Input("Other"));
        Assert.Contains("\"name\"", Field(() => store.Update("c1", other.Id, new SavedQueryPatch("REPORT", null, null))));
        Assert.Equal("report", store.Update("c1", first.Id, new SavedQueryPatch("report", null, null)).Name);
    }

    [Fact]
    public void Update_RenamesChangesTextAndDescription_KeepingWhatIsAbsent()
    {
        var store = new SavedQueryStore(new AppPaths(_dir));
        var q = store.Create("c1", Input("Daily", sql: "SELECT 1", description: "first"));
        Thread.Sleep(5);
        var text = store.Update("c1", q.Id, new SavedQueryPatch(null, "SELECT 2", null));
        Assert.Equal(("Daily", "SELECT 2", "first"), (text.Name, text.Sql, text.Description));
        Assert.Equal(q.CreatedAt, text.CreatedAt);
        Assert.True(string.CompareOrdinal(text.UpdatedAt, q.UpdatedAt) > 0);

        var renamed = store.Update("c1", q.Id, new SavedQueryPatch("  Daily totals ", null, ""));
        Assert.Equal(("Daily totals", "SELECT 2", (string?)null), (renamed.Name, renamed.Sql, renamed.Description));
        Assert.Throws<EngineException>(() => store.Update("c1", "q_missing", new SavedQueryPatch("x", null, null)));
        Assert.Throws<EngineException>(() => store.Update("c2", q.Id, new SavedQueryPatch("x", null, null)));
    }

    [Fact]
    public void Duplicate_PicksAFreeCopyName_InTheSameSchema()
    {
        var store = new SavedQueryStore(new AppPaths(_dir));
        var q = store.Create("c1", Input("Daily", sql: "SELECT 42", description: "d"));
        var c1 = store.Duplicate("c1", q.Id, null);
        var c2 = store.Duplicate("c1", q.Id, new SavedQueryDuplicate(" "));
        var named = store.Duplicate("c1", q.Id, new SavedQueryDuplicate("Daily v2"));
        Assert.Equal(["Daily (copy)", "Daily (copy 2)", "Daily v2"], new[] { c1, c2, named }.Select(x => x.Name));
        Assert.All(new[] { c1, c2, named }, x =>
        {
            Assert.NotEqual(q.Id, x.Id);
            Assert.Equal(("Shop", "dbo", "SELECT 42", "d"), (x.Database, x.Schema, x.Sql, x.Description));
        });
        Assert.Contains("\"name\"", Field(() => store.Duplicate("c1", q.Id, new SavedQueryDuplicate("daily"))));
        Assert.Throws<EngineException>(() => store.Duplicate("c1", "q_missing", null));
    }

    [Fact]
    public void Validation_NamesTheField()
    {
        var store = new SavedQueryStore(new AppPaths(_dir));
        Assert.Contains("\"name\"", Field(() => store.Create("c1", Input(""))));
        Assert.Contains("\"name\"", Field(() => store.Create("c1", Input("   "))));
        Assert.Contains("\"name\"", Field(() => store.Create("c1", Input(new string('x', SavedQueryStore.MaxNameLength + 1)))));
        Assert.Contains("\"name\"", Field(() => store.Create("c1", Input("tab\there"))));
        Assert.Contains("\"description\"", Field(() => store.Create("c1", Input("n", description: new string('d', SavedQueryStore.MaxDescriptionLength + 1)))));
        Assert.Contains("\"schema\"", Field(() => store.Create("c1", Input("n", schema: new string('s', SavedQueryStore.MaxScopeLength + 1)))));
        Assert.Contains("\"database\"", Field(() => store.Create("c1", Input("n", database: new string('s', SavedQueryStore.MaxScopeLength + 1)))));
        Assert.Contains("\"sql\"", Field(() => store.Create("c1", Input("n", sql: new string(' ', SavedQueryStore.MaxSqlLength + 1)))));
        Assert.Contains("\"connectionId\"", Field(() => store.List("")));
        Assert.Throws<EngineException>(() => store.Create("c1", null));
        Assert.Throws<EngineException>(() => store.Update("c1", "x", null));
        Assert.Empty(store.List("c1"));

        // a missing text is an empty query; empty database / schema are stored as null
        var q = store.Create("c1", new SavedQueryInput("", "", "Scratch", null, null));
        Assert.Equal(("", (string?)null, (string?)null), (q.Sql, q.Database, q.Schema));
    }

    [Fact]
    public void CorruptFile_StartsEmpty_AndKeepsACopy()
    {
        var paths = new AppPaths(_dir);
        File.WriteAllText(Path.Combine(paths.DataDir, "queries.json"), "{ not json");
        var store = new SavedQueryStore(paths);
        Assert.Empty(store.List("c1"));
        store.Create("c1", Input("After"));
        Assert.True(File.Exists(Path.Combine(paths.DataDir, "queries.json.corrupt")));
        Assert.Single(new SavedQueryStore(paths).List("c1"));
    }

    [Fact]
    public void WireShape_IsCamelCase()
    {
        var store = new SavedQueryStore(new AppPaths(_dir));
        var q = store.Create("c1", Input("Wire", description: "x"));
        var json = JsonSerializer.Serialize(q, CoreJson.Options);
        foreach (var key in new[] { "\"id\"", "\"connectionId\"", "\"database\"", "\"schema\"", "\"name\"", "\"sql\"", "\"description\"", "\"createdAt\"", "\"updatedAt\"" })
            Assert.Contains(key, json);
        var back = JsonSerializer.Deserialize<SavedQuery>(json, CoreJson.Options)!;
        Assert.Equal(q, back);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}
