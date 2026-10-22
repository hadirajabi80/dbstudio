using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Search;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Tests.Search;

/// <summary>"Find in database" end to end over SQLite files (main + an attached database), also through the stream manager.</summary>
public sealed class SearchSqliteTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-search-tests", Guid.NewGuid().ToString("N"));
    private ConnectionStore _store = null!;
    private ProviderRegistry _providers = null!;
    private DatabaseSearchService _service = null!;
    private string _cid = "";

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var main = Path.Combine(_dir, "shop.db");
        var archive = Path.Combine(_dir, "archive.db");
        await ExecAsync(main, """
            CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email VARCHAR(100), notes TEXT, score INTEGER, photo BLOB);
            INSERT INTO customers (id, name, email, notes, score) VALUES
              (1, 'Ann Smith', 'ann@shop.test', 'prefers 50% off coupons', 3),
              (2, 'Bob Stone', 'bob@shop.test', 'VIP   customer since 2019', 7),
              (3, 'Cleo', NULL, '5000 off', 1);
            CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL);
            CREATE VIEW customer_orders AS
              SELECT c.name, o.total
              FROM customers c JOIN orders o ON o.customer_id = c.id;
            CREATE TRIGGER trg_orders_ai AFTER INSERT ON orders BEGIN
              UPDATE customers SET score = score + 1 WHERE id = NEW.customer_id;
            END;
            CREATE TABLE codes (code TEXT);
            INSERT INTO codes VALUES ('x_y'), ('xzy');
            """);
        await ExecAsync(archive, "CREATE TABLE archived_customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO archived_customers VALUES (9, 'Old Smith');");

        _providers = new ProviderRegistry([new SqliteProvider()]);
        _store = new ConnectionStore(new AppPaths(Path.Combine(_dir, "data")), new InMemorySecretStore(), _providers);
        _cid = _store.Create(new ConnectionProfile
        {
            Name = "shop", ProviderId = "sqlite",
            Props = new() { ["path"] = main, ["attach"] = new JsonArray($"archive={archive}") },
        }, null).Id;
        _service = new DatabaseSearchService(_store, _providers);
    }

    public Task DisposeAsync()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return Task.CompletedTask;
    }

    private static async Task ExecAsync(string path, string sql)
    {
        await using var c = new SqliteConnection($"Data Source={path};Pooling=False");
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task<List<SearchItem>> SearchAsync(string json)
    {
        var request = SearchRequest.Parse(JsonDocument.Parse(json.Replace("$CID", _cid)).RootElement);
        _service.Validate(request);
        var items = new List<SearchItem>();
        await _service.RunAsync(request, i => { lock (items) items.Add(i); }, CancellationToken.None);
        return items;
    }

    [Fact]
    public async Task WholeConnection_NamesColumnsAndCode_InMainAndTheAttachedDatabase()
    {
        var items = await SearchAsync("""{ "term": "customer", "targets": [ { "connectionId": "$CID" } ] }""");
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Contains(hits, h => h is { Match: "name", Schema: "main", Object.Name: "customers", Object.Type: "table" });
        Assert.Contains(hits, h => h is { Match: "name", Schema: "main", Object.Name: "customer_orders", Object.Type: "view" });
        Assert.Contains(hits, h => h is { Match: "name", Schema: "archive", Object.Name: "archived_customers" });
        Assert.Contains(hits, h => h is { Match: "column", Object.Name: "orders", Column: "customer_id", DataType: "INTEGER" });
        var trigger = Assert.Single(hits, h => h is { Match: "code", Object.Name: "trg_orders_ai" } && h.Text.Contains("customers SET"));
        Assert.Equal(2, trigger.Line);
        var view = hits.Where(h => h is { Match: "code", Object.Name: "customer_orders" }).Select(h => h.Line).ToList();
        Assert.Equal([1, 3], view);
        Assert.DoesNotContain(hits, h => h.Match == "data");
        Assert.IsType<SearchDone>(items[^1]);
        Assert.DoesNotContain(items, i => i is SearchError);
    }

    [Fact]
    public async Task WholeWordMatchCaseAndTypes()
    {
        var items = await SearchAsync("""{ "term": "Customers", "matchCase": true, "targets": [ { "connectionId": "$CID", "schema": "main" } ] }""");
        Assert.DoesNotContain(items.OfType<SearchHit>(), h => h.Match == "name"); // the table is "customers"
        items = await SearchAsync("""{ "term": "customer", "wholeWord": true, "types": ["view"], "targets": [ { "connectionId": "$CID", "schema": "main" } ] }""");
        Assert.Empty(items.OfType<SearchHit>()); // customer_orders / customers are other words
    }

    [Fact]
    public async Task Data_FindsRowsWithTheirKey_AndEscapesLikeWildcards()
    {
        var items = await SearchAsync("""
            { "term": "smith", "in": { "names": false, "columns": false, "code": false, "data": true },
              "targets": [ { "connectionId": "$CID", "schema": "main" }, { "connectionId": "$CID", "schema": "archive" } ] }
            """);
        var hits = items.OfType<SearchHit>().ToList();
        var ann = Assert.Single(hits, h => h.Schema == "main");
        Assert.Equal(("customers", "name", "Ann Smith"), (ann.Object.Name, ann.Column, ann.Text));
        Assert.Equal([[4, 5]], ann.Ranges);
        Assert.Equal("id", Assert.Single(ann.Key!).Column);
        Assert.Equal(1L, ann.Key![0].Value);
        Assert.Contains(hits, h => h is { Schema: "archive", Object.Name: "archived_customers", Text: "Old Smith" });

        // % and _ are literal: "50%" is not "5000", "x_y" is not "xzy".
        items = await SearchAsync("""{ "term": "50%", "in": { "names": false, "columns": false, "code": false, "data": true }, "targets": [ { "connectionId": "$CID", "schema": "main" } ] }""");
        Assert.Equal("prefers 50% off coupons", Assert.Single(items.OfType<SearchHit>()).Text);
        items = await SearchAsync("""{ "term": "x_y", "in": { "names": false, "columns": false, "code": false, "data": true }, "targets": [ { "connectionId": "$CID", "schema": "main" } ] }""");
        var code = Assert.Single(items.OfType<SearchHit>());
        Assert.Equal(("codes", "x_y"), (code.Object.Name, code.Text));
        Assert.Null(code.Key); // no primary key: the UI filters on the matched text

        // Only the chosen tables.
        items = await SearchAsync("""
            { "term": "shop.test", "in": { "names": false, "columns": false, "code": false, "data": true }, "dataRowLimit": 1,
              "targets": [ { "connectionId": "$CID", "objects": [ { "schema": "main", "name": "customers" } ] } ] }
            """);
        Assert.Equal("ann@shop.test", Assert.Single(items.OfType<SearchHit>()).Text); // row limit 1
    }

    [Fact]
    public async Task Data_RegexThroughTheRegisteredRegexpFunction()
    {
        var items = await SearchAsync("""
            { "term": "vip\\s+customer", "regex": true, "in": { "names": false, "columns": false, "code": false, "data": true },
              "targets": [ { "connectionId": "$CID", "schema": "main" } ] }
            """);
        var hit = Assert.Single(items.OfType<SearchHit>());
        Assert.Equal(("notes", 2L), (hit.Column, hit.Key![0].Value));
        Assert.Equal([[0, 14]], hit.Ranges);
    }

    [Fact]
    public void Module_IsDiscovered_AndRegistersTheStreamFactory()
    {
        var module = Assert.Single(EngineModules.Discover(typeof(SearchModule).Assembly), m => m is SearchModule);
        var services = new ServiceCollection().AddSingleton(_store).AddSingleton(_providers);
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        Assert.IsType<SearchStreamFactory>(sp.GetRequiredKeyedService<IStreamFactory>(SearchModule.StreamKind));
    }

    [Fact]
    public void UnknownConnection_IsNotFound()
    {
        var request = SearchRequest.Parse(JsonDocument.Parse("""{ "term": "x", "targets": [ { "connectionId": "c_nope" } ] }""").RootElement);
        Assert.Equal(404, Assert.Throws<EngineException>(() => _service.Validate(request)).Status);
    }

    [Fact]
    public async Task Stream_DeliversItemsAndCompletes_AndCanBeCancelled()
    {
        var events = new RecordingPublisher();
        var factory = new SearchStreamFactory(_service);
        await using var streams = new StreamManager(events, kind => kind == SearchModule.StreamKind ? factory : null, _store);
        var p = JsonDocument.Parse($$"""{ "term": "customer", "targets": [ { "connectionId": "{{_cid}}" } ] }""").RootElement;
        var info = await streams.OpenAsync(SearchModule.StreamKind, StreamManager.EngineConnectionId, p, null, CancellationToken.None);
        var ended = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "ended");
        Assert.Equal("completed", ended.Reason);
        var items = events.All.OfType<StreamDataEvent>().Where(e => e.StreamId == info.StreamId).SelectMany(e => e.Items).ToList();
        Assert.Contains(items, i => i.GetProperty("kind").GetString() == "hit" && i.GetProperty("object").GetProperty("name").GetString() == "customers");
        Assert.Equal("done", items[^1].GetProperty("kind").GetString());

        // A bad request fails the POST (no stream is opened).
        var bad = JsonDocument.Parse("""{ "term": "(", "regex": true, "targets": [ { "connectionId": "x" } ] }""").RootElement;
        await Assert.ThrowsAsync<EngineException>(() => streams.OpenAsync(SearchModule.StreamKind, StreamManager.EngineConnectionId, bad, null, CancellationToken.None));

        // Cancel: DELETE /streams/{id} ends it as "closed" without a done item.
        var slow = new SearchStreamFactory(new DatabaseSearchService(async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); throw new InvalidOperationException(); }));
        await using var streams2 = new StreamManager(events, _ => slow, _store);
        var running = await streams2.OpenAsync(SearchModule.StreamKind, StreamManager.EngineConnectionId,
            JsonDocument.Parse("""{ "term": "x", "targets": [ { "connectionId": "c1" } ] }""").RootElement, null, CancellationToken.None);
        Assert.True(await streams2.CloseAsync(running.StreamId));
        var closed = await events.WaitAsync<StreamStateEvent>(e => e.StreamId == running.StreamId && e.State == "ended");
        Assert.Equal("closed", closed.Reason);
        Assert.DoesNotContain(events.All.OfType<StreamDataEvent>().Where(e => e.StreamId == running.StreamId).SelectMany(e => e.Items),
            i => i.GetProperty("kind").GetString() == "done");
    }
}
