using System.Diagnostics;
using System.Text.Json;
using DbStudio.Core.Designer;
using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using M15Helpers = DbStudio.Core.Tests.M15.M15;
using DbStudio.Providers.Sqlite;

namespace DbStudio.Core.Tests.B1;

/// <summary>Shared setup: a "Shop" SQLite file with Customers(Id, City), Ids 1..10, City = 'C1'..'C10'.</summary>
internal static class Shop
{
    public static async Task<ConnectionProfile> CreateAsync(EngineEnv env, string file = "shop.sqlite", int busyTimeout = 30, string providerId = "sqlite")
    {
        var path = Path.Combine(env.Dir, file);
        var setup = env.Connections.Create(new ConnectionProfile
        {
            Name = "Shop setup", ProviderId = "sqlite",
            Props = new() { ["path"] = path, ["createIfMissing"] = true },
        }, null);
        var h = await env.Sessions.CreateAsync(setup.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var values = string.Join(", ", Enumerable.Range(1, 10).Select(i => $"({i}, 'C{i}')"));
        var (_, done) = await env.RunAsync(h.Id, "CREATE TABLE Customers (Id INTEGER PRIMARY KEY, City TEXT NOT NULL)", $"INSERT INTO Customers (Id, City) VALUES {values}");
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        await env.Sessions.CloseAsync(h.Id, force: true);
        return env.Connections.Create(new ConnectionProfile
        {
            Name = "Shop", ProviderId = providerId,
            Props = new() { ["path"] = path, ["busyTimeout"] = busyTimeout },
        }, null);
    }

    public static ExecuteCommand Cmd(string sql, string title = "Console", bool skipHistory = false, int line = 1) =>
        new([new SqlBatch(sql, line, 1)], 1000, true, "statement", TabId: "tab-" + title, Title: title, SkipHistory: skipHistory);

    public static async Task<ExecDoneEvent> RunAsync(EngineEnv env, SessionHandle h, string sql, string title = "Console")
    {
        var started = env.Executions.Start(h.Id, Cmd(sql, title));
        return await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 20000);
    }

    /// <summary>The value of the first cell of a query, read on <paramref name="h"/>.</summary>
    public static async Task<object?> ScalarAsync(EngineEnv env, SessionHandle h, string sql)
    {
        var started = env.Executions.Start(h.Id, Cmd(sql, "probe", skipHistory: true));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 20000);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        return env.Exports.GetStored(started.ExecutionId, 0).Page(0, 1)[0][0];
    }

    public static IEnumerable<ExecMessageEvent> Messages(EngineEnv env, string executionId) =>
        env.Events.All.OfType<ExecMessageEvent>().Where(m => m.ExecutionId == executionId);

    public static IEnumerable<ExecErrorEvent> Errors(EngineEnv env, string executionId) =>
        env.Events.All.OfType<ExecErrorEvent>().Where(m => m.ExecutionId == executionId);
}

/// <summary>logic-01 / logic-02: cancel and lock waits report what really happened to the data.</summary>
public class CancelAndLockTests
{
    [Fact]
    public async Task Cancel_WhileBlockedByAnotherSessionsWriteLock_IsCancelled_AndRowUnchanged()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        var w = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        var pending = await Shop.RunAsync(env, r, "UPDATE Customers SET City = 'R' WHERE Id = 2", "Console 1");
        Assert.Equal(ExecutionStatus.Ok, pending.Status);
        Assert.True(pending.TxOpen); // R holds the write lock

        var started = env.Executions.Start(w.Id, Shop.Cmd("UPDATE Customers SET City = 'CANCEL-TEST' WHERE Id = 7", "Console 3"));
        await env.Events.WaitAsync<ExecBatchStartedEvent>(e => e.ExecutionId == started.ExecutionId);
        await Task.Delay(1500); // waiting on the lock (busy timeout 30 s)
        Assert.DoesNotContain(env.Events.All.OfType<ExecDoneEvent>(), e => e.ExecutionId == started.ExecutionId);

        var sw = Stopwatch.StartNew();
        Assert.True(env.Executions.Cancel(w.Id));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 10000);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"cancel took {sw.Elapsed}"); // logic-02: cancel works while waiting on a lock
        Assert.Equal(ExecutionStatus.Cancelled, done.Status);
        Assert.Equal(0, done.RowsAffected);
        Assert.Contains(Shop.Messages(env, started.ExecutionId), m => m.Text == "Query was cancelled.");

        await r.Session.RollbackAsync(CancellationToken.None);
        // The reported outcome and the data agree: cancelled means not written.
        Assert.Equal("C7", await Shop.ScalarAsync(env, w, "SELECT City FROM Customers WHERE Id = 7"));
        Assert.Equal("C2", await Shop.ScalarAsync(env, w, "SELECT City FROM Customers WHERE Id = 2"));
        var history = await env.History.SearchAsync(conn.Id, "CANCEL", 5, null);
        Assert.Equal("cancelled", Assert.Single(history).Status);
    }

    [Fact]
    public async Task Cancel_WhileWaitingForReadersToCommit_IsCancelled_AndRowUnchanged()
    {
        // The QA repro: R holds a SHARED lock (open read transaction), W's auto-commit UPDATE waits for it to commit.
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var w = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        Assert.True((await Shop.RunAsync(env, r, "BEGIN", "Console 1")).TxOpen); // user-typed BEGIN is tracked
        Assert.Equal(10L, await Shop.ScalarAsync(env, r, "SELECT COUNT(*) FROM Customers"));
        Assert.True(r.Session.TxOpen);

        var started = env.Executions.Start(w.Id, Shop.Cmd("UPDATE Customers SET City = 'CANCEL-TEST' WHERE Id = 7", "Console 3"));
        await env.Events.WaitAsync<ExecBatchStartedEvent>(e => e.ExecutionId == started.ExecutionId);
        await Task.Delay(1500);
        Assert.True(env.Executions.Cancel(w.Id));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 10000);

        Assert.False((await Shop.RunAsync(env, r, "ROLLBACK", "Console 1")).TxOpen);
        var city = await Shop.ScalarAsync(env, w, "SELECT City FROM Customers WHERE Id = 7");
        // Whatever the timing, status, rows affected and data must agree.
        if (done.Status == ExecutionStatus.Cancelled)
        {
            Assert.Equal(0, done.RowsAffected);
            Assert.Equal("C7", city);
        }
        else
        {
            Assert.Equal(ExecutionStatus.Ok, done.Status);
            Assert.Equal(1, done.RowsAffected);
            Assert.Equal("CANCEL-TEST", city);
        }
        Assert.Equal(ExecutionStatus.Cancelled, done.Status); // with the lock held for the whole wait, the cancel wins
    }

    [Fact]
    public async Task Cancel_ArrivingAfterTheStatementCompleted_IsOk_WithRowsAffected_AndWarning()
    {
        await using var env = new EngineEnv(extraProviders: [new DoubleProvider()]);
        var conn = await Shop.CreateAsync(env, providerId: "double");
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        var started = env.Executions.Start(h.Id, Shop.Cmd("UPDATE Customers SET City = 'Late' WHERE Id = 6 /*cancel-after*/"));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);

        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(1, done.RowsAffected);
        Assert.Contains(Shop.Messages(env, started.ExecutionId), m => m.Severity == MessageSeverity.Warning
            && m.Text == "Cancel arrived after the statement completed; its changes were committed.");
        Assert.DoesNotContain(Shop.Messages(env, started.ExecutionId), m => m.Text.StartsWith("Query was cancelled", StringComparison.Ordinal));
        Assert.Equal("Late", await Shop.ScalarAsync(env, h, "SELECT City FROM Customers WHERE Id = 6"));
        Assert.Equal("ok", Assert.Single(await env.History.SearchAsync(conn.Id, "Late", 5, null)).Status);
    }

    [Fact]
    public async Task Cancel_ArrivingAfterTheStatementCompleted_InManualMode_KeepsTheTransactionOpen()
    {
        await using var env = new EngineEnv(extraProviders: [new DoubleProvider()]);
        var conn = await Shop.CreateAsync(env, providerId: "double");
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);

        var started = env.Executions.Start(h.Id, Shop.Cmd("UPDATE Customers SET City = 'Late' WHERE Id = 6 /*cancel-after*/"));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);

        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(1, done.RowsAffected);
        Assert.True(done.TxOpen);
        Assert.Contains(Shop.Messages(env, started.ExecutionId), m => m.Text.Contains("part of the open transaction", StringComparison.Ordinal));
        await h.Session.RollbackAsync(CancellationToken.None);
        Assert.Equal("C6", await Shop.ScalarAsync(env, h, "SELECT City FROM Customers WHERE Id = 6"));
    }

    [Fact]
    public async Task LockTimeout_NamesTheBlockingSession_InExecutionsAndDesignerApply()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env, busyTimeout: 1);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        var w = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        Assert.True((await Shop.RunAsync(env, r, "UPDATE Customers SET City = 'R' WHERE Id = 2", "Console 1")).TxOpen);

        var sw = Stopwatch.StartNew();
        var started = env.Executions.Start(w.Id, Shop.Cmd("UPDATE Customers SET City = 'W' WHERE Id = 3", "Console 2"));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 20000);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10), $"waited {sw.Elapsed}"); // busy timeout, not forever
        Assert.Equal(ExecutionStatus.Error, done.Status);
        var error = Assert.Single(Shop.Errors(env, started.ExecutionId));
        Assert.Equal("SQLITE_BUSY", error.Code);
        Assert.Equal("Database is locked by another session: Console 1 (open transaction). Commit or roll back there, then run again.", error.Message);

        var designer = new DesignerService(env.Connections, env.Providers, M15Helpers.Features(), env.Catalog, env.Sessions);
        var failed = await Assert.ThrowsAsync<DdlFailedException>(() =>
            designer.ApplyAsync(conn.Id, new DdlApplyRequest(null, ["ALTER TABLE Customers ADD COLUMN Phone TEXT"], true), CancellationToken.None));
        Assert.Contains("Database is locked by another session: Console 1 (open transaction).", failed.Message);
        Assert.Contains("Database is locked by another session: Console 1 (open transaction).", failed.ProviderError.Message);

        await r.Session.RollbackAsync(CancellationToken.None);
        Assert.Equal(ExecutionStatus.Ok, (await Shop.RunAsync(env, w, "UPDATE Customers SET City = 'W' WHERE Id = 3", "Console 2")).Status);
    }
}

/// <summary>logic-03: manual mode begins the transaction lazily, at the first statement that is not a query.</summary>
public class LazyTransactionTests
{
    [Fact]
    public async Task ManualMode_SelectOnly_OpensNoTransaction_AndHoldsNoLock()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env, busyTimeout: 1);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        var w = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        var select = await Shop.RunAsync(env, r, "SELECT * FROM Customers", "Console 1");
        Assert.Equal(ExecutionStatus.Ok, select.Status);
        Assert.False(select.TxOpen);
        Assert.False(r.Session.TxOpen);
        Assert.False(r.ToInfo().TxOpen);
        var pragma = await Shop.RunAsync(env, r, "PRAGMA foreign_keys", "Console 1");
        Assert.False(pragma.TxOpen);

        // No read lock is held: another session writes at once (busy timeout is only 1 s).
        Assert.Equal(ExecutionStatus.Ok, (await Shop.RunAsync(env, w, "UPDATE Customers SET City = 'W' WHERE Id = 1")).Status);

        // The first write opens the transaction; commit ends it.
        var update = await Shop.RunAsync(env, r, "UPDATE Customers SET City = 'R' WHERE Id = 2", "Console 1");
        Assert.True(update.TxOpen);
        var afterRead = await Shop.RunAsync(env, r, "SELECT City FROM Customers WHERE Id = 2", "Console 1");
        Assert.True(afterRead.TxOpen); // a query inside the open transaction keeps it open
        await r.Session.CommitAsync(CancellationToken.None);
        Assert.False(r.Session.TxOpen);
        Assert.Equal("R", await Shop.ScalarAsync(env, w, "SELECT City FROM Customers WHERE Id = 2"));
    }

    [Fact]
    public async Task ManualMode_UserTypedBegin_IsTrackedAsServerTransaction()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);

        Assert.True((await Shop.RunAsync(env, r, "BEGIN")).TxOpen);
        var insert = await Shop.RunAsync(env, r, "INSERT INTO Customers (Id, City) VALUES (11, 'New')");
        Assert.Equal(ExecutionStatus.Ok, insert.Status); // no nested engine BEGIN
        Assert.True(insert.TxOpen);
        Assert.False((await Shop.RunAsync(env, r, "COMMIT")).TxOpen);
        Assert.Equal(11L, await Shop.ScalarAsync(env, r, "SELECT COUNT(*) FROM Customers"));
    }

    [Fact]
    public async Task ManualMode_FailedFirstWrite_LeavesNoPendingTransaction()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var r = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);

        var failed = await Shop.RunAsync(env, r, "UPDATE Customers SET Id = 1 WHERE Id = 2"); // UNIQUE constraint
        Assert.Equal(ExecutionStatus.Error, failed.Status);
        Assert.False(failed.TxOpen);

        // After a successful write a later failure keeps the transaction (it holds the earlier change).
        Assert.True((await Shop.RunAsync(env, r, "UPDATE Customers SET City = 'X' WHERE Id = 3")).TxOpen);
        Assert.True((await Shop.RunAsync(env, r, "UPDATE Customers SET Id = 1 WHERE Id = 2")).TxOpen);
        await r.Session.RollbackAsync(CancellationToken.None);
    }
}

/// <summary>code-05: a manual transaction lost with the connection is reported, not silently replaced.</summary>
public class LostTransactionTests
{
    [Fact]
    public async Task BrokenConnection_WithOpenTransaction_IsReportedInTheBatch_AndOnTheNextRun()
    {
        await using var env = new EngineEnv(extraProviders: [new DoubleProvider()]);
        var conn = await Shop.CreateAsync(env, providerId: "double");
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        Assert.True((await Shop.RunAsync(env, h, "UPDATE Customers SET City = 'Lost' WHERE Id = 4")).TxOpen);
        var oldSession = h.Session;

        var started = env.Executions.Start(h.Id, Shop.Cmd("SELECT 1 /*break*/"));
        var broke = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId);
        Assert.Equal(ExecutionStatus.Error, broke.Status);
        Assert.False(broke.TxOpen);
        Assert.Contains(Shop.Errors(env, started.ExecutionId), e => e.Code == ErrorCodes.SessionBroken
            && e.Message.Contains("your open transaction was rolled back by the server", StringComparison.Ordinal));
        Assert.Equal(SessionState.Broken, h.Session.State);
        Assert.True(h.Session.LostTransaction);

        // The next run reconnects and says the transaction is gone instead of "the connection was reopened".
        var next = env.Executions.Start(h.Id, Shop.Cmd("SELECT City FROM Customers WHERE Id = 4"));
        var nextDone = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == next.ExecutionId);
        Assert.Equal(ExecutionStatus.Error, nextDone.Status);
        var error = Assert.Single(Shop.Errors(env, next.ExecutionId));
        Assert.Equal(ErrorCodes.SessionBroken, error.Code);
        Assert.Contains("the open transaction was rolled back by the server", error.Message);
        Assert.NotSame(oldSession, h.Session);
        Assert.Equal(SessionState.Idle, h.Session.State);

        Assert.Equal("C4", await Shop.ScalarAsync(env, h, "SELECT City FROM Customers WHERE Id = 4"));
    }

    [Fact]
    public async Task BrokenConnection_WithoutTransaction_ReconnectsWithAWarning()
    {
        await using var env = new EngineEnv(extraProviders: [new DoubleProvider()]);
        var conn = await Shop.CreateAsync(env, providerId: "double");
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var broke = await Shop.RunAsync(env, h, "SELECT 1 /*break*/");
        Assert.Equal(ExecutionStatus.Error, broke.Status);
        Assert.False(h.Session.LostTransaction);

        var next = env.Executions.Start(h.Id, Shop.Cmd("SELECT 1"));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == next.ExecutionId);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Contains(Shop.Messages(env, next.ExecutionId), m => m.Text == "The connection was lost and has been reopened.");
    }
}

/// <summary>code-02: exports run only single queries; read-only SQLite profiles are read-only in the driver too.</summary>
public class ExportGuardTests
{
    private static async Task<ConnectionProfile> ReadOnlyShopAsync(EngineEnv env)
    {
        var shop = await Shop.CreateAsync(env);
        return env.Connections.Create(new ConnectionProfile
        {
            Name = "Shop (read-only)", ProviderId = "sqlite", ReadOnly = true,
            Props = new() { ["path"] = shop.GetString("path") },
        }, null);
    }

    [Fact]
    public async Task Export_OfDml_OnReadOnlyProfile_Is403_AndChangesNothing()
    {
        await using var env = new EngineEnv();
        var ro = await ReadOnlyShopAsync(env);
        var h = await env.Sessions.CreateAsync(ro.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var path = Path.Combine(env.Dir, "out.csv");

        var ex = Assert.Throws<EngineException>(() =>
            env.Exports.StartQueryExport(h.Id, "DELETE FROM Customers RETURNING Id", "csv", path, new ExportOptions()));
        Assert.Equal((403, ErrorCodes.ReadOnly), (ex.Status, ex.Code));
        Assert.False(h.IsReserved);
        Assert.False(File.Exists(path));
        Assert.Equal(10L, await Shop.ScalarAsync(env, h, "SELECT COUNT(*) FROM Customers"));
    }

    [Fact]
    public async Task Export_AcceptsOnlyASingleQuery_AndIsRecordedInHistory()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var path = Path.Combine(env.Dir, "out.csv");

        foreach (var sql in new[] { "DELETE FROM Customers RETURNING Id", "SELECT 1; DELETE FROM Customers", "SELECT 1; SELECT 2", "CREATE TABLE x (a)" })
        {
            var ex = Assert.Throws<EngineException>(() => env.Exports.StartQueryExport(h.Id, sql, "csv", path, new ExportOptions()));
            Assert.Equal((400, ErrorCodes.Validation), (ex.Status, ex.Code));
            Assert.Contains("single SELECT", ex.Message);
        }
        Assert.Equal(10L, await Shop.ScalarAsync(env, h, "SELECT COUNT(*) FROM Customers"));

        var id = env.Exports.StartQueryExport(h.Id, "SELECT Id, City FROM Customers ORDER BY Id", "csv", path, new ExportOptions());
        var done = await env.Events.WaitAsync<ExportDoneEvent>(e => e.ExportId == id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(10, done.Rows);
        var entry = await WaitForHistoryAsync(env, conn.Id, "export");
        Assert.Equal("ok", entry.Status);
        Assert.Equal(10, entry.ResultRows);
        Assert.Contains("SELECT Id, City", entry.Sql);
    }

    private static async Task<HistoryEntry> WaitForHistoryAsync(EngineEnv env, string connectionId, string label)
    {
        for (var i = 0; i < 100; i++)
        {
            var hit = (await env.History.SearchAsync(connectionId, null, 50, null)).FirstOrDefault(e => e.Label == label);
            if (hit is not null) return hit;
            await Task.Delay(50);
        }
        throw new TimeoutException($"No history entry with label {label}.");
    }

    [Fact]
    public async Task ReadOnlyProfile_OpensReadOnly_InTheDriver()
    {
        await using var env = new EngineEnv();
        var ro = await ReadOnlyShopAsync(env);
        Assert.Contains("Mode=ReadOnly", new SqliteProvider().BuildConnectionString(ro, null));

        // A tab session runs with PRAGMA query_only: a write that bypasses the engine guard fails in SQLite itself.
        var h = await env.Sessions.CreateAsync(ro.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var sink = new CollectingSink();
        var summary = await h.Session.ExecuteAsync(new ExecuteRequest([new SqlBatch("DELETE FROM Customers", 1, 1)], 0, true, false, "statement"),
            sink, CancellationToken.None);
        Assert.Equal(ExecutionStatus.Error, summary.Status);
        Assert.Contains(sink.Errors, e => e.Message.Contains("readonly", StringComparison.OrdinalIgnoreCase));

        // The explicit "Run with writes" override (confirmedDestructive) still works for one execution...
        var confirmed = env.Executions.Start(h.Id, Shop.Cmd("DELETE FROM Customers WHERE Id = 10") with { ConfirmedDestructive = true });
        Assert.Equal(ExecutionStatus.Ok, (await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == confirmed.ExecutionId)).Status);
        // ...and the guard is back afterwards.
        var again = await h.Session.ExecuteAsync(new ExecuteRequest([new SqlBatch("DELETE FROM Customers", 1, 1)], 0, true, false, "statement"),
            new CollectingSink(), CancellationToken.None);
        Assert.Equal(ExecutionStatus.Error, again.Status);
        Assert.Equal(9L, await Shop.ScalarAsync(env, h, "SELECT COUNT(*) FROM Customers"));
    }
}

/// <summary>logic-16, logic-19, logic-21, logic-24(d).</summary>
public class ExecutionRequestTests
{
    [Fact]
    public async Task MissingParameterValue_IsValidation_WithPosition_BeforeAnythingRuns()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);

        var ex = Assert.Throws<EngineException>(() => env.Executions.Start(h.Id,
            Shop.Cmd("SELECT Id FROM Customers\nWHERE Id = @id", line: 3)));
        Assert.Equal((400, ErrorCodes.Validation), (ex.Status, ex.Code));
        Assert.Equal("Missing value for parameter @id", ex.Message);
        using var detail = JsonDocument.Parse(JsonSerializer.Serialize(ex.Detail, CoreJson.Options));
        Assert.Equal("params", detail.RootElement.GetProperty("field").GetString());
        Assert.Equal(4, detail.RootElement.GetProperty("line").GetInt32());
        Assert.Equal(12, detail.RootElement.GetProperty("col").GetInt32());
        Assert.False(h.IsReserved);

        // A script: nothing runs when a later batch misses a value.
        var script = new ExecuteCommand([new SqlBatch("DELETE FROM Customers", 1, 1), new SqlBatch("SELECT :city", 2, 1)], 100, true, "script",
            Params: [M15Helpers.P("other", "string", "x")]);
        Assert.Equal("Missing value for parameter :city", Assert.Throws<EngineException>(() => env.Executions.Start(h.Id, script)).Message);
        Assert.Contains("positional", Assert.Throws<EngineException>(() => env.Executions.Start(h.Id, Shop.Cmd("SELECT ?"))).Message);
        Assert.Equal(10L, await Shop.ScalarAsync(env, h, "SELECT COUNT(*) FROM Customers"));

        var bound = env.Executions.Start(h.Id, Shop.Cmd("SELECT City FROM Customers WHERE Id = @id") with { Params = [M15Helpers.P("id", "int", 3)] });
        Assert.Equal(ExecutionStatus.Ok, (await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == bound.ExecutionId)).Status);
        Assert.Equal("C3", env.Exports.GetStored(bound.ExecutionId, 0).Page(0, 1)[0][0]);
    }

    [Fact]
    public async Task SkipHistory_SuppressesTheHistoryRecord()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        var skipped = env.Executions.Start(h.Id, Shop.Cmd("SELECT COUNT(*) AS probe_count FROM Customers", skipHistory: true));
        await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == skipped.ExecutionId);
        await Shop.RunAsync(env, h, "SELECT City AS recorded FROM Customers");
        await Task.Delay(200); // history is written after exec.done
        Assert.Empty(await env.History.SearchAsync(conn.Id, "probe_count", 10, null));
        Assert.Single(await env.History.SearchAsync(conn.Id, "recorded", 10, null));
    }

    [Fact]
    public async Task DeletingAConnection_WithOpenTransactions_Is409_UnlessForced()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        env.Sessions.EnsureNoOpenTransactions(conn.Id, force: false); // nothing open yet
        await Shop.RunAsync(env, h, "DELETE FROM Customers WHERE Id = 1", "Console 2");

        var ex = Assert.Throws<EngineException>(() => env.Sessions.EnsureNoOpenTransactions(conn.Id, force: false));
        Assert.Equal((409, ErrorCodes.TxOpen), (ex.Status, ex.Code));
        Assert.Contains("Console 2", ex.Message);
        using var detail = JsonDocument.Parse(JsonSerializer.Serialize(ex.Detail, CoreJson.Options));
        var listed = Assert.Single(detail.RootElement.GetProperty("sessions").EnumerateArray());
        Assert.Equal(h.Id, listed.GetProperty("sessionId").GetString());
        Assert.Equal("Console 2", listed.GetProperty("label").GetString());

        env.Sessions.EnsureNoOpenTransactions(conn.Id, force: true);
    }

    [Fact]
    public async Task History_Exists_ForPartialUpdates()
    {
        await using var env = new EngineEnv();
        var id = await env.History.AddAsync("c1", null, "SELECT 1", DateTimeOffset.UtcNow, 1, ExecutionStatus.Ok, null, 1, null, "statement");
        Assert.True(await env.History.ExistsAsync(id));
        Assert.False(await env.History.ExistsAsync(id + 1000));
    }
}

/// <summary>logic-08: sessions whose UI client went away are closed after the grace period.</summary>
public class OrphanSessionTests
{
    [Fact]
    public async Task Session_OfADisconnectedClient_IsClosedAfterTheGracePeriod_RollingBack()
    {
        var presence = new ClientPresence();
        await using var env = new EngineEnv(presence: presence, orphanGrace: TimeSpan.FromMilliseconds(300));
        var conn = await Shop.CreateAsync(env);
        presence.Connected("ui-1");
        presence.Connected("ui-2");
        var gone = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-1", CancellationToken.None);
        var stays = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, "ui-2", CancellationToken.None);
        var anonymous = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        Assert.True((await Shop.RunAsync(env, gone, "UPDATE Customers SET City = 'Orphan' WHERE Id = 5")).TxOpen);
        Assert.False(gone.ToInfo().Orphan);
        Assert.Equal("ui-1", gone.OwnerClientId);

        presence.Disconnected("ui-1");
        Assert.True(gone.ToInfo().Orphan);
        Assert.False(stays.ToInfo().Orphan);
        Assert.False(anonymous.ToInfo().Orphan); // API callers without a client id are never orphaned

        await WaitUntilAsync(() => env.Sessions.List().All(s => s.Id != gone.Id));
        Assert.Contains(env.Sessions.List(), s => s.Id == stays.Id);
        Assert.Contains(env.Sessions.List(), s => s.Id == anonymous.Id);
        Assert.Equal("C5", await Shop.ScalarAsync(env, stays, "SELECT City FROM Customers WHERE Id = 5")); // rolled back
    }

    [Fact]
    public async Task Session_SurvivesAReconnectWithinTheGracePeriod_AndFollowsTheLastClient()
    {
        var presence = new ClientPresence();
        await using var env = new EngineEnv(presence: presence, orphanGrace: TimeSpan.FromMilliseconds(400));
        var conn = await Shop.CreateAsync(env);
        presence.Connected("ui-1");
        var h = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, "ui-1", CancellationToken.None);

        presence.Disconnected("ui-1");
        await Task.Delay(100);
        presence.Connected("ui-1"); // page reload / network blip
        await Task.Delay(700);
        Assert.Contains(env.Sessions.List(), s => s.Id == h.Id);
        Assert.False(h.ToInfo().Orphan);

        // Another window touches the session: it now follows that client.
        presence.Connected("ui-2");
        env.Sessions.Claim(h, "ui-2");
        presence.Disconnected("ui-1");
        await Task.Delay(700);
        Assert.Contains(env.Sessions.List(), s => s.Id == h.Id);
        Assert.Equal(0, await env.Sessions.CloseOrphansAsync());
    }

    [Fact]
    public void SessionInfo_SerializesOrphan()
    {
        var info = new SessionInfo("s1", "c1", new ServerInfo("3", null, null, null, "main"), "main", TransactionMode.Auto, false,
            SessionState.Idle, Dialect.Sqlite, Orphan: true);
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(info, CoreJson.Options));
        Assert.True(doc.RootElement.GetProperty("orphan").GetBoolean());
        Assert.Null(ClientPresence.Normalize("bad id with spaces"));
        Assert.Equal("ok-id", ClientPresence.Normalize(" ok-id "));
    }

    private static async Task WaitUntilAsync(Func<bool> condition, int timeoutMs = 10000)
    {
        var sw = Stopwatch.StartNew();
        while (!condition())
        {
            if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("Condition not met.");
            await Task.Delay(50);
        }
    }
}
