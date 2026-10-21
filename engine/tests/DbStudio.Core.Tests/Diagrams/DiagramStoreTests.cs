using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Diagrams;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests.Diagrams;

/// <summary>M2-ER (docs/PLAN-M2.md section 3): layouts round-trip, one layout per scope, validation names the field.</summary>
public sealed class DiagramStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-diagrams", Guid.NewGuid().ToString("N"));

    private static DiagramLayout Layout(string id, DiagramScope scope, double x = 10, double y = 20) => new(
        id, scope, new Dictionary<string, double[]> { ["main.orders"] = [x, y], ["main.customers"] = [300.123456, -40] },
        ["main.events"], 0.8, [12, -34], "", "layered-lr", ["other.audit"], ["main.orders"], new JsonObject { ["types"] = true });

    [Fact]
    public void ScopeKey_MatchesTheUiHelper()
    {
        Assert.Equal("Shop|dbo", DiagramStore.ScopeKey(new DiagramScope("Shop", "dbo", null)));
        Assert.Equal("|main", DiagramStore.ScopeKey(new DiagramScope(null, "main", null)));
        Assert.Equal("Shop|t:dbo.a,dbo.b,sales.Z", DiagramStore.ScopeKey(new DiagramScope("Shop", null, ["sales.Z", "dbo.b", "dbo.a"])));
        // empty table list falls back to the schema form (same as the UI)
        Assert.Equal("Shop|dbo", DiagramStore.ScopeKey(new DiagramScope("Shop", "dbo", [])));
    }

    [Fact]
    public void Crud_PersistsAcrossInstances()
    {
        var paths = new AppPaths(_dir);
        var store = new DiagramStore(paths);
        var saved = store.Save("c1", "er_1", Layout("er_1", new DiagramScope(null, "main", null)));
        store.Save("c1", "er_2", Layout("", new DiagramScope("Shop", null, ["dbo.a", "dbo.b"])));
        store.Save("c2", "er_1", Layout("er_1", new DiagramScope(null, "main", null)));

        Assert.Equal("er_1", saved.Id);
        Assert.Equal([300.12, -40], saved.Positions["main.customers"]);
        Assert.False(string.IsNullOrEmpty(saved.UpdatedAt));

        var reloaded = new DiagramStore(paths);
        Assert.Equal(2, reloaded.List("c1", null, null).Count);
        var byScope = Assert.Single(reloaded.List("c1", null, "|main"));
        Assert.Equal(["main.events"], byScope.Hidden);
        Assert.Equal(["other.audit"], byScope.Added);
        Assert.Equal(["main.orders"], byScope.Pinned);
        Assert.Equal("layered-lr", byScope.Auto);
        Assert.True(byScope.Options!["types"]!.GetValue<bool>());
        Assert.Equal([12, -34], byScope.Pan);
        var byDb = Assert.Single(reloaded.List("c1", "Shop", null));
        Assert.Equal("er_2", byDb.Id);
        Assert.Single(reloaded.List("c1", "", null)); // null database is stored as the empty string key

        Assert.True(reloaded.Delete("c1", "er_1"));
        Assert.False(reloaded.Delete("c1", "er_1"));
        Assert.Single(new DiagramStore(paths).List("c2", null, null));
        Assert.Equal(1, reloaded.DeleteForConnection("c2"));
        Assert.Empty(new DiagramStore(paths).List("c2", null, null));
    }

    [Fact]
    public void Save_Upserts_AndKeepsOneLayoutPerScope()
    {
        var store = new DiagramStore(new AppPaths(_dir));
        var scope = new DiagramScope(null, "main", null);
        store.Save("c1", "er_a", Layout("er_a", scope, 1, 1));
        store.Save("c1", "er_a", Layout("er_a", scope, 5, 6));
        var one = Assert.Single(store.List("c1", null, null));
        Assert.Equal([5, 6], one.Positions["main.orders"]);

        // another window created a second id for the same scope: it replaces the first one
        store.Save("c1", "er_b", Layout("er_b", scope, 7, 8));
        var only = Assert.Single(store.List("c1", null, null));
        Assert.Equal("er_b", only.Id);
        Assert.Null(store.Get("c1", "er_a"));
    }

    [Fact]
    public void Validation_NamesTheField()
    {
        var store = new DiagramStore(new AppPaths(_dir));
        var scope = new DiagramScope(null, "main", null);
        string Field(Action a)
        {
            var ex = Assert.Throws<EngineException>(a);
            Assert.Equal(400, ex.Status);
            return JsonSerializer.Serialize(ex.Detail, CoreJson.Options);
        }

        Assert.Contains("\"id\"", Field(() => store.Save("c1", "", Layout("", scope))));
        Assert.Contains("\"id\"", Field(() => store.Save("c1", "bad id/../x", Layout("", scope))));
        Assert.Contains("\"id\"", Field(() => store.Save("c1", "er_1", Layout("er_2", scope))));
        Assert.Contains("\"scope\"", Field(() => store.Save("c1", "er_1", Layout("er_1", new DiagramScope(null, null, null)))));
        Assert.Contains("\"scope\"", Field(() => store.Save("c1", "er_1", Layout("er_1", new DiagramScope(null, "main", ["main.a"])))));
        Assert.Contains("\"zoom\"", Field(() => store.Save("c1", "er_1", Layout("er_1", scope) with { Zoom = 9 })));
        Assert.Contains("\"pan\"", Field(() => store.Save("c1", "er_1", Layout("er_1", scope) with { Pan = [1] })));
        Assert.Contains("\"auto\"", Field(() => store.Save("c1", "er_1", Layout("er_1", scope) with { Auto = "radial" })));
        Assert.Contains("\"positions\"", Field(() => store.Save("c1", "er_1", Layout("er_1", scope) with
        {
            Positions = new Dictionary<string, double[]> { ["main.a"] = [double.NaN, 1] },
        })));
        Assert.Contains("\"hidden\"", Field(() => store.Save("c1", "er_1", Layout("er_1", scope) with { Hidden = [" "] })));
        Assert.Contains("\"connectionId\"", Field(() => store.List("", null, null)));
        Assert.Throws<EngineException>(() => store.Save("c1", "er_1", null));
        Assert.Empty(store.List("c1", null, null));
    }

    [Fact]
    public void Save_DeduplicatesNames()
    {
        var store = new DiagramStore(new AppPaths(_dir));
        var saved = store.Save("c1", "er_1", Layout("er_1", new DiagramScope(null, null, ["main.a", "main.a", "main.b"])) with { Hidden = ["x", "x"] });
        Assert.Equal(["main.a", "main.b"], saved.Scope.Tables);
        Assert.Equal(["x"], saved.Hidden);
        Assert.Null(saved.Scope.Schema);
    }

    [Fact]
    public void CorruptFile_StartsEmpty()
    {
        var paths = new AppPaths(_dir);
        File.WriteAllText(Path.Combine(paths.DataDir, "diagrams.json"), "[ not json");
        var store = new DiagramStore(paths);
        Assert.Empty(store.List("c1", null, null));
        store.Save("c1", "er_1", Layout("er_1", new DiagramScope(null, "main", null)));
        Assert.True(File.Exists(Path.Combine(paths.DataDir, "diagrams.json.corrupt")));
        Assert.Single(new DiagramStore(paths).List("c1", null, null));
    }

    [Fact]
    public void WireShape_IsCamelCase_AndKeepsTableKeysVerbatim()
    {
        var store = new DiagramStore(new AppPaths(_dir));
        var saved = store.Save("c1", "er_1", Layout("er_1", new DiagramScope("Shop", "Sales", null)) with
        {
            Positions = new Dictionary<string, double[]> { ["Sales.OrderLines"] = [1, 2] },
        });
        var json = JsonSerializer.Serialize(saved, CoreJson.Options);
        Assert.Contains("\"Sales.OrderLines\":[1,2]", json);
        Assert.Contains("\"updatedAt\"", json);
        Assert.Contains("\"scope\":{\"database\":\"Shop\",\"schema\":\"Sales\"", json);
        var back = JsonSerializer.Deserialize<DiagramLayout>(json, CoreJson.Options)!;
        Assert.Equal(saved.Positions["Sales.OrderLines"], back.Positions["Sales.OrderLines"]);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }
}
