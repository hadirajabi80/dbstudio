using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Catalog;
using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite;
using Microsoft.Data.Sqlite;

namespace DbStudio.Core.Tests;

/// <summary>Full Core service graph over the SQLite provider in a temp data directory.</summary>
public sealed class EngineEnv : IAsyncDisposable
{
    public string Dir { get; } = Path.Combine(Path.GetTempPath(), "dbstudio-core-tests", Guid.NewGuid().ToString("N"));
    public AppPaths Paths { get; }
    public RecordingPublisher Events { get; } = new();
    public ProviderRegistry Providers { get; } = new([new SqliteProvider()]);
    public ConnectionStore Connections { get; }
    public ResultStore Results { get; }
    public HistoryService History { get; }
    public SessionManager Sessions { get; }
    public CatalogService Catalog { get; }
    public ExecutionService Executions { get; }
    public ExportService Exports { get; }

    public EngineEnv(long resultCap = ResultStore.DefaultCapBytes)
    {
        Paths = new AppPaths(Dir);
        Connections = new ConnectionStore(Paths, new InMemorySecretStore(), Providers);
        Results = new ResultStore(resultCap);
        History = new HistoryService(Paths);
        Sessions = new SessionManager(Providers, Connections, Events, Results);
        Catalog = new CatalogService(Providers, Connections, Events);
        Executions = new ExecutionService(Sessions, Results, History, Catalog, Connections, Events);
        Exports = new ExportService(Sessions, Results, Events);
    }

    public ConnectionProfile AddSqlite(string file = "db.sqlite", bool readOnly = false) =>
        Connections.Create(new ConnectionProfile
        {
            Name = file, ProviderId = "sqlite", ReadOnly = readOnly,
            Props = new() { ["path"] = Path.Combine(Dir, file), ["createIfMissing"] = true },
        }, null);

    /// <summary>Runs batches and waits for exec.done.</summary>
    public async Task<(string Xid, ExecDoneEvent Done)> RunAsync(string sid, params string[] sql)
    {
        var started = Executions.Start(sid, new ExecuteCommand(sql.Select((s, i) => new SqlBatch(s, i + 1, 1)).ToList(), 1000, true, "script"));
        var done = await Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        return (started.ExecutionId, done);
    }

    public async ValueTask DisposeAsync()
    {
        await Sessions.DisposeAsync();
        History.Dispose();
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(Dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed class RecordingPublisher : IEventPublisher
{
    private readonly ConcurrentQueue<EngineEvent> _events = new();
    private readonly List<(Func<EngineEvent, bool> Pred, TaskCompletionSource<EngineEvent> Tcs)> _waiters = [];

    public IReadOnlyList<EngineEvent> All => _events.ToList();

    public void Publish(EngineEvent ev)
    {
        // Every event must serialize with the wire options.
        JsonSerializer.SerializeToUtf8Bytes(ev, ev.GetType(), CoreJson.Options);
        _events.Enqueue(ev);
        lock (_waiters)
        {
            foreach (var w in _waiters.Where(w => w.Pred(ev)).ToList())
            {
                _waiters.Remove(w);
                w.Tcs.TrySetResult(ev);
            }
        }
    }

    public async Task<T> WaitAsync<T>(Func<T, bool> pred, int timeoutMs = 15000) where T : EngineEvent
    {
        TaskCompletionSource<EngineEvent> tcs;
        lock (_waiters)
        {
            var hit = _events.OfType<T>().FirstOrDefault(pred);
            if (hit is not null) return hit;
            tcs = new TaskCompletionSource<EngineEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add((e => e is T t && pred(t), tcs));
        }
        return (T)await tcs.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs));
    }
}

public class ExecutionServiceTests
{
    [Fact]
    public async Task Execute_StreamsEvents_StoresRows_RecordsHistory()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, true, CancellationToken.None);

        var (xid, done) = await env.RunAsync(h.Id,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)",
            "INSERT INTO t (v) VALUES ('a'), ('b'), ('c')",
            "SELECT id, v FROM t ORDER BY id");

        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(1, done.ResultSets);
        Assert.Equal(3, done.RowsAffected);
        var evs = env.Events.All.Where(e => e is not SessionChangedEvent and not CatalogChangedEvent).ToList();
        Assert.IsType<ExecStartedEvent>(evs[0]);
        Assert.Contains(evs, e => e is ExecAffectedEvent { Count: 3, StatementKind: "INSERT", BatchIndex: 1 });
        var rs = Assert.Single(evs.OfType<ExecResultSetEvent>());
        Assert.Equal(2, rs.BatchIndex);
        Assert.Equal(3, evs.OfType<ExecRowsEvent>().Sum(r => r.Rows.Count));

        var stored = env.Exports.GetStored(xid, 0);
        Assert.Equal(3, stored.RowCount);
        Assert.Equal("b", stored.Page(1, 1)[0][1]);

        var history = await env.History.SearchAsync(conn.Id, "INSERT", 10, null);
        var entry = Assert.Single(history);
        Assert.Equal("ok", entry.Status);
        Assert.Equal(3, entry.RowsAffected);
        Assert.Equal(3, entry.ResultRows);
        Assert.Equal("script", entry.Label);
        Assert.Contains("CREATE TABLE t", entry.Sql);
    }

    [Fact]
    public async Task Execute_IsRejectedWhileBusy_AndCancels()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var started = env.Executions.Start(h.Id, new ExecuteCommand(
            [new SqlBatch("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000000000) SELECT count(*) FROM c", 1, 1)],
            10, true, "statement"));

        var busy = Assert.Throws<EngineException>(() => env.Executions.Start(h.Id, new ExecuteCommand([new SqlBatch("SELECT 1", 1, 1)], 10, true, "statement")));
        Assert.Equal((409, ErrorCodes.SessionBusy), (busy.Status, busy.Code));

        await env.Events.WaitAsync<ExecBatchStartedEvent>(e => e.ExecutionId == started.ExecutionId);
        await Task.Delay(200);
        Assert.True(env.Executions.Cancel(h.Id));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 10000);
        Assert.Equal(ExecutionStatus.Cancelled, done.Status);

        var (_, after) = await env.RunAsync(h.Id, "SELECT 1");
        Assert.Equal(ExecutionStatus.Ok, after.Status);
        Assert.Equal("cancelled", (await env.History.SearchAsync(conn.Id, "RECURSIVE", 5, null))[0].Status);
    }

    [Fact]
    public async Task ReadOnlyConnection_RejectsWrites_UnlessConfirmed()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite("ro.sqlite", readOnly: true);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        var ex = Assert.Throws<EngineException>(() => env.Executions.Start(h.Id,
            new ExecuteCommand([new SqlBatch("SELECT 1", 1, 1), new SqlBatch("CREATE TABLE x (a)", 5, 1)], 10, true, "script")));
        Assert.Equal((403, ErrorCodes.ReadOnly), (ex.Status, ex.Code));
        Assert.False(h.IsReserved);

        var (_, ok) = await env.RunAsync(h.Id, "SELECT 1", "PRAGMA table_info(sqlite_master)");
        Assert.Equal(ExecutionStatus.Ok, ok.Status);

        var confirmed = env.Executions.Start(h.Id, new ExecuteCommand([new SqlBatch("CREATE TABLE x (a)", 1, 1)], 10, true, "statement", ConfirmedDestructive: true));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == confirmed.ExecutionId);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
    }

    [Fact]
    public async Task Validation_Errors()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => env.Executions.Start(h.Id, new ExecuteCommand([], 10, true, "statement"))).Code);
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => env.Executions.Start(h.Id, new ExecuteCommand([new SqlBatch("  ", 1, 1)], 10, true, "statement"))).Code);
        Assert.Equal(ErrorCodes.NotFound, Assert.Throws<EngineException>(() => env.Executions.Start("s_nope", new ExecuteCommand([new SqlBatch("SELECT 1", 1, 1)], 10, true, "statement"))).Code);
    }

    [Fact]
    public async Task CloseSession_WithOpenTransaction_RequiresForce()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        await env.RunAsync(h.Id, "CREATE TABLE t (a)");
        Assert.True(h.Session.TxOpen);
        var ex = await Assert.ThrowsAsync<EngineException>(() => env.Sessions.CloseAsync(h.Id, force: false));
        Assert.Equal(ErrorCodes.TxOpen, ex.Code);
        await env.Sessions.CloseAsync(h.Id, force: true);
        Assert.Throws<EngineException>(() => env.Sessions.Get(h.Id));
        Assert.Contains(env.Events.All, e => e is SessionChangedEvent { State: SessionState.Closed });
    }

    [Fact]
    public async Task QueryExport_StreamsToFile()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        await env.RunAsync(h.Id, "CREATE TABLE n (i INTEGER)",
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 25000) INSERT INTO n SELECT x FROM c");

        var path = Path.Combine(env.Dir, "out.csv");
        var id = env.Exports.StartQueryExport(h.Id, "SELECT i FROM n ORDER BY i", ExportFormats.Csv, path, new ExportOptions());
        var done = await env.Events.WaitAsync<ExportDoneEvent>(e => e.ExportId == id, 20000);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(25000, done.Rows);
        var lines = await File.ReadAllLinesAsync(path);
        Assert.Equal(25001, lines.Length);
        Assert.Equal("25000", lines[^1]);
        Assert.False(File.Exists(path + ".partial"));
        Assert.False(h.IsReserved);
    }
}

public class ResultStoreTests
{
    private static readonly ColumnInfo[] Cols = [new("v", 0, "TEXT", ColumnKinds.String, true)];

    [Fact]
    public void LatestExecutionPerSession_ReplacesPrevious()
    {
        var store = new ResultStore();
        var a = store.Begin("s1", "x1", Dialect.Sqlite);
        a.Start(0, 0, Cols);
        a.AddRows(0, [["a"]]);
        store.Begin("s1", "x2", Dialect.Sqlite);
        Assert.Null(store.Get("x1"));
        Assert.NotNull(store.Get("x2"));
        Assert.Equal(0, store.TotalBytes);
        store.ReleaseSession("s1");
        Assert.Null(store.Get("x2"));
    }

    [Fact]
    public void MemoryCap_EvictsLeastRecentlyUsed_ThenMarksPartial()
    {
        var store = new ResultStore(capBytes: 200_000);
        var big = new string('x', 20_000); // ~40 KB each
        var first = store.Begin("s1", "x1", Dialect.Sqlite);
        first.Start(0, 0, Cols);
        for (var i = 0; i < 3; i++) first.AddRows(0, [[big]]);

        var second = store.Begin("s2", "x2", Dialect.Sqlite);
        second.Start(0, 0, Cols);
        for (var i = 0; i < 3; i++) second.AddRows(0, [[big]]);
        Assert.Null(store.Get("x1")); // evicted to make room
        Assert.Equal(3, second.Get(0)!.StoredRows);

        for (var i = 0; i < 10; i++) second.AddRows(0, [[big]]);
        var set = second.Get(0)!;
        Assert.True(set.Partial);
        Assert.True(store.TotalBytes <= store.CapBytes);
    }
}

public class StoreTests
{
    private static string TempDir() => Path.Combine(Path.GetTempPath(), "dbstudio-core-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void Settings_DefaultsMergeAndValidate()
    {
        var paths = new AppPaths(TempDir());
        var s = new SettingsService(paths);
        var defaults = s.Get();
        Assert.Equal("system", defaults["theme"]!.GetValue<string>());
        Assert.Equal(10000, defaults["results"]!["maxRows"]!.GetValue<int>());

        var updated = s.Update(new JsonObject { ["theme"] = "dark", ["editor"] = new JsonObject { ["fontSize"] = 16 }, ["ui"] = new JsonObject { ["mru"] = new JsonObject { ["a"] = 1 } } });
        Assert.Equal("dark", updated["theme"]!.GetValue<string>());
        Assert.Equal(16, updated["editor"]!["fontSize"]!.GetValue<int>());
        Assert.Equal("upper", updated["editor"]!["keywordCase"]!.GetValue<string>()); // untouched sibling kept
        s.Update(new JsonObject { ["ui"] = new JsonObject { ["layout"] = "x" } });

        var reloaded = new SettingsService(paths).Get();
        Assert.Equal("dark", reloaded["theme"]!.GetValue<string>());
        Assert.Equal(1, reloaded["ui"]!["mru"]!["a"]!.GetValue<int>());
        Assert.Equal("x", reloaded["ui"]!["layout"]!.GetValue<string>());

        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => s.Update(new JsonObject { ["theme"] = "neon" })).Code);
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => s.Update(new JsonObject { ["editor"] = new JsonObject { ["fontSize"] = "big" } })).Code);
        Assert.Equal("dark", s.Get()["theme"]!.GetValue<string>()); // failed update not applied

        var reset = s.Update(new JsonObject { ["theme"] = null });
        Assert.Equal("system", reset["theme"]!.GetValue<string>());
    }

    [Fact]
    public void Connections_CrudAndPasswords()
    {
        var paths = new AppPaths(TempDir());
        var secrets = new InMemorySecretStore();
        var registry = new ProviderRegistry([new SqliteProvider()]);
        var store = new ConnectionStore(paths, secrets, registry);

        var created = store.Create(new ConnectionProfile { Name = " Local ", ProviderId = "sqlite", Props = new() { ["path"] = "C:\\x.db", ["password"] = "leak" } }, "secret");
        Assert.StartsWith("c_", created.Id);
        Assert.Equal("Local", created.Name);
        Assert.True(created.HasPassword);
        Assert.False(created.Props.ContainsKey("password"));
        Assert.DoesNotContain("secret", File.ReadAllText(paths.ConnectionsFile));
        Assert.DoesNotContain("leak", File.ReadAllText(paths.ConnectionsFile));

        var kept = store.Update(created.Id, new ConnectionProfile { Name = "Renamed", ProviderId = "sqlite", Props = new() { ["path"] = "C:\\y.db" } }, null);
        Assert.Equal("Renamed", kept.Name);
        Assert.Equal("secret", store.GetPassword(created.Id));
        Assert.Equal(created.CreatedAt, kept.CreatedAt);

        var cleared = store.Update(created.Id, new ConnectionProfile { Name = "Renamed", ProviderId = "sqlite", Props = new() { ["path"] = "C:\\y.db" } }, "");
        Assert.False(cleared.HasPassword);

        var reloaded = new ConnectionStore(paths, secrets, registry);
        Assert.Equal("Renamed", Assert.Single(reloaded.List()).Name);

        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => store.Create(new ConnectionProfile { Name = "x", ProviderId = "sqlite" }, null)).Code);
        Assert.Equal(ErrorCodes.Validation, Assert.Throws<EngineException>(() => store.Create(new ConnectionProfile { Name = "x", ProviderId = "nope" }, null)).Code);

        store.Delete(created.Id);
        Assert.Empty(store.List());
        Assert.Null(secrets.Get(created.Id));
        Assert.Equal(ErrorCodes.NotFound, Assert.Throws<EngineException>(() => store.Delete(created.Id)).Code);
    }

    [Fact]
    public void DpapiSecretStore_RoundTripsAndBindsToProfileId()
    {
        if (!OperatingSystem.IsWindows()) return;
        var paths = new AppPaths(TempDir());
        var store = new DpapiSecretStore(paths);
        store.Set("c_1", "pa$$w0rd", persist: true);
        store.Set("c_2", "memory-only", persist: false);
        Assert.DoesNotContain("pa$$w0rd", File.ReadAllText(paths.SecretsFile));
        Assert.DoesNotContain("c_2", File.ReadAllText(paths.SecretsFile));

        var fresh = new DpapiSecretStore(paths);
        Assert.Equal("pa$$w0rd", fresh.Get("c_1"));
        Assert.Null(fresh.Get("c_2"));

        // A blob copied to another profile id does not decrypt (entropy includes the id).
        var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(paths.SecretsFile))!;
        map["c_3"] = map["c_1"];
        File.WriteAllText(paths.SecretsFile, JsonSerializer.Serialize(map));
        Assert.Null(new DpapiSecretStore(paths).Get("c_3"));

        fresh.Remove("c_1");
        Assert.False(new DpapiSecretStore(paths).Has("c_1"));
    }

    [Fact]
    public async Task History_SearchPinClear()
    {
        var paths = new AppPaths(TempDir());
        using var h = new HistoryService(paths);
        var t = DateTimeOffset.UtcNow;
        var a = await h.AddAsync("c_1", "main", "SELECT * FROM customers WHERE name LIKE 'A%'", t, 5, ExecutionStatus.Ok, null, 2, null, "statement");
        var b = await h.AddAsync("c_1", "main", "UPDATE orders SET total = 0", t, 7, ExecutionStatus.Error, null, null, "boom", "statement");
        await h.AddAsync("c_2", null, "SELECT 1", t, 1, ExecutionStatus.Cancelled, null, null, null, "script");
        Assert.True(h.FullTextEnabled);

        Assert.Equal(a, Assert.Single(await h.SearchAsync(null, "custom", 10, null)).Id); // prefix match
        Assert.Equal(b, Assert.Single(await h.SearchAsync("c_1", "orders total", 10, null)).Id);
        Assert.Empty(await h.SearchAsync("c_2", "orders", 10, null));
        Assert.Equal(2, (await h.SearchAsync("c_1", null, 10, null)).Count);
        Assert.Equal(a, Assert.Single(await h.SearchAsync("c_1", null, 10, before: b)).Id);
        Assert.Equal("error", (await h.SearchAsync("c_1", "UPDATE", 1, null))[0].Status);

        Assert.True(await h.SetPinnedAsync(a, true));
        await h.ClearAsync("c_1");
        var left = await h.SearchAsync("c_1", null, 10, null);
        Assert.True(Assert.Single(left).Pinned);
        Assert.True(await h.DeleteAsync(a));
        Assert.False(await h.DeleteAsync(a));
        Assert.Single(await h.SearchAsync(null, null, 10, null)); // c_2 untouched
    }

    [Fact]
    public void Ids_AreUniqueAndSortable()
    {
        var ids = Enumerable.Range(0, 1000).Select(_ => Ids.New("x")).ToList();
        Assert.Equal(1000, ids.Distinct().Count());
        Assert.All(ids, id => Assert.Matches("^x_[0-9A-HJKMNP-TV-Z]{26}$", id));
    }

    [Fact]
    public void AtomicFile_Replaces()
    {
        var path = Path.Combine(TempDir(), "f.json");
        AtomicFile.WriteAllText(path, "one");
        AtomicFile.WriteAllText(path, "two");
        Assert.Equal("two", File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!));
    }
}

public class CatalogServiceTests
{
    [Fact]
    public async Task Snapshot_ETag_And_DdlInvalidation()
    {
        await using var env = new EngineEnv();
        var conn = env.AddSqlite();
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        await env.RunAsync(h.Id, "CREATE TABLE a (id INTEGER PRIMARY KEY)");

        var first = await env.Catalog.GetSnapshotAsync(conn.Id, null, null, null, CancellationToken.None);
        Assert.False(first.NotModified);
        using (var doc = JsonDocument.Parse(first.Json!))
        {
            Assert.Equal("main", doc.RootElement.GetProperty("defaultSchema").GetString());
            Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("database").ValueKind);
            Assert.Equal("a", doc.RootElement.GetProperty("schemas")[0].GetProperty("objects")[0].GetProperty("n").GetString());
        }

        var again = await env.Catalog.GetSnapshotAsync(conn.Id, null, ["main"], first.ETag, CancellationToken.None);
        Assert.True(again.NotModified);
        Assert.Null(again.Json);
        Assert.Equal(first.ETag, again.ETag);

        await env.RunAsync(h.Id, "CREATE TABLE b (id INTEGER)");
        var changed = await env.Events.WaitAsync<CatalogChangedEvent>(e => e.ConnectionId == conn.Id);
        Assert.Contains("main", changed.Schemas);
        Assert.True(changed.Version > first.Version);

        var after = await env.Catalog.GetSnapshotAsync(conn.Id, null, null, first.ETag, CancellationToken.None);
        Assert.False(after.NotModified);
        Assert.NotEqual(first.ETag, after.ETag);
        Assert.Contains("\"n\":\"b\"", System.Text.Encoding.UTF8.GetString(after.Json!));

        var schemas = await env.Catalog.GetSchemasAsync(conn.Id, null, CancellationToken.None);
        Assert.Equal("main", schemas.DefaultSchema);
        var main = Assert.Single(schemas.Schemas);
        Assert.True(main.Loaded);
        Assert.Equal(2, main.ObjectCount);

        var version = await env.Catalog.RefreshAsync(conn.Id, null, null, CancellationToken.None);
        Assert.True(version > changed.Version);

        var missing = await Assert.ThrowsAsync<EngineException>(() => env.Catalog.GetSnapshotAsync(conn.Id, null, ["nope"], null, CancellationToken.None));
        Assert.Equal(404, missing.Status);
    }
}
