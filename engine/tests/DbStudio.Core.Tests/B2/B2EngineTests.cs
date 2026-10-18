using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Core.Tests.B1;
using M15Helpers = DbStudio.Core.Tests.M15.M15;

namespace DbStudio.Core.Tests.B2;

/// <summary>code-r1-01: manual mode begins the engine transaction for the grid's edit savepoint too.</summary>
public class ManualSavepointTests
{
    [Theory]
    [InlineData("SAVEPOINT dbs_edit", Dialect.Sqlite, true)]
    [InlineData("SAVEPOINT dbs_edit", Dialect.PlSql, true)]
    [InlineData("SAVE TRANSACTION dbs_edit", Dialect.TSql, true)]
    [InlineData("SAVE TRAN dbs_edit", Dialect.TSql, true)]
    [InlineData("RELEASE SAVEPOINT dbs_edit", Dialect.Sqlite, false)]
    [InlineData("ROLLBACK TO SAVEPOINT dbs_edit", Dialect.Sqlite, false)]
    [InlineData("ROLLBACK TRANSACTION dbs_edit", Dialect.TSql, false)]
    [InlineData("BEGIN", Dialect.Sqlite, false)]
    [InlineData("COMMIT", Dialect.Sqlite, false)]
    [InlineData("BEGIN TRANSACTION", Dialect.TSql, false)]
    [InlineData("SELECT 1", Dialect.Sqlite, false)]
    public void HasSavepoint_OnlyForSettingASavepoint(string sql, Dialect dialect, bool expected)
    {
        var c = StatementClassifier.Classify(sql, dialect);
        Assert.Equal(expected, c.HasSavepoint);
        Assert.True(c.IsQueryOnly); // still transaction control: the read-only guard and labels are unchanged
    }

    [Fact]
    public async Task EditSavepoint_InAManualSessionWithNothingOpen_StaysPendingUntilRollback()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env, busyTimeout: 1);
        var edit = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        var other = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        Assert.False(edit.Session.TxOpen);

        Assert.True((await Shop.RunAsync(env, edit, "SAVEPOINT dbs_edit", "Edit")).TxOpen);
        Assert.True((await Shop.RunAsync(env, edit, "UPDATE Customers SET City = 'QA_X' WHERE Id = 1", "Edit")).TxOpen);
        var release = await Shop.RunAsync(env, edit, "RELEASE SAVEPOINT dbs_edit", "Edit");
        Assert.Equal(ExecutionStatus.Ok, release.Status);
        Assert.True(release.TxOpen); // RELEASE ended only the savepoint, not the engine transaction
        Assert.True(edit.ToInfo().TxOpen);
        Assert.Equal("C1", await Shop.ScalarAsync(env, other, "SELECT City FROM Customers WHERE Id = 1"));

        await env.Sessions.Get(edit.Id).Session.RollbackAsync(CancellationToken.None);
        Assert.False(edit.Session.TxOpen);
        Assert.Equal("C1", await Shop.ScalarAsync(env, other, "SELECT City FROM Customers WHERE Id = 1"));
    }
}

/// <summary>design-r1-06: lock holders of other windows are named as such, not as the requester's own "Console 1".</summary>
public class LockHolderWindowTests
{
    [Fact]
    public async Task LockHolders_AreQualified_ByTheWindowThatOwnsThem()
    {
        var presence = new ClientPresence();
        await using var env = new EngineEnv(presence: presence, orphanGrace: TimeSpan.FromHours(1));
        var conn = await Shop.CreateAsync(env);
        presence.Connected("ui-me");
        presence.Connected("ui-other");
        presence.Connected("ui-gone");
        var me = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-me", CancellationToken.None);
        var mine = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-me", CancellationToken.None);
        var theirs = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-other", CancellationToken.None);
        var orphan = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-gone", CancellationToken.None);
        var api = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, CancellationToken.None);
        // A typed (deferred) BEGIN opens a transaction without taking a lock, so all of them can hold one at once.
        Assert.True((await Shop.RunAsync(env, mine, "BEGIN", "Console 2")).TxOpen);
        Assert.True((await Shop.RunAsync(env, theirs, "BEGIN", "Console 1")).TxOpen);
        Assert.True((await Shop.RunAsync(env, orphan, "BEGIN", "Console 1")).TxOpen);
        Assert.True((await Shop.RunAsync(env, api, "BEGIN", "Script")).TxOpen);
        presence.Disconnected("ui-gone");
        Assert.True(orphan.ToInfo().Orphan);

        var holders = env.Sessions.DescribeLockHolders(conn, me.Id, "ui-me");
        Assert.Equal(4, holders.Count);
        Assert.Contains("Console 2 (open transaction)", holders);
        Assert.Contains("Console 1 in another window (open transaction)", holders);
        Assert.Contains("Console 1 from an earlier window (open transaction)", holders);
        Assert.Contains("Script (open transaction)", holders); // no owner client: nothing to say about its window

        // Requester unknown (API caller): only the orphan is qualified.
        var anonymous = env.Sessions.DescribeLockHolders(conn, me.Id);
        Assert.Contains("Console 1 (open transaction)", anonymous);
        Assert.Contains("Console 1 from an earlier window (open transaction)", anonymous);

        // A session of the requester is never "from an earlier window", even if its socket is not (yet) live.
        presence.Disconnected("ui-me");
        Assert.Contains("Console 2 (open transaction)", env.Sessions.DescribeLockHolders(conn, me.Id, "ui-me"));

        foreach (var h in new[] { mine, theirs, orphan, api }) await h.Session.RollbackAsync(CancellationToken.None);
    }

    [Fact]
    public async Task LockWait_NamesAHolderFromAnEarlierWindow()
    {
        var presence = new ClientPresence();
        await using var env = new EngineEnv(presence: presence, orphanGrace: TimeSpan.FromHours(1));
        var conn = await Shop.CreateAsync(env, busyTimeout: 1);
        presence.Connected("ui-old");
        presence.Connected("ui-new");
        var old = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Manual, false, "ui-old", CancellationToken.None);
        var current = await env.Sessions.CreateAsync(conn.Id, null, TransactionMode.Auto, false, "ui-new", CancellationToken.None);
        Assert.True((await Shop.RunAsync(env, old, "UPDATE Customers SET City = 'R' WHERE Id = 2", "Console 1")).TxOpen);
        presence.Disconnected("ui-old"); // the earlier window was closed; its session waits out the grace period

        var started = env.Executions.Start(current.Id, Shop.Cmd("UPDATE Customers SET City = 'W' WHERE Id = 3", "Console 1"));
        var done = await env.Events.WaitAsync<ExecDoneEvent>(e => e.ExecutionId == started.ExecutionId, 20000);
        Assert.Equal(ExecutionStatus.Error, done.Status);
        var error = Assert.Single(Shop.Errors(env, started.ExecutionId));
        Assert.Equal("Database is locked by another session: Console 1 from an earlier window (open transaction). Commit or roll back there, then run again.", error.Message);

        // Designer applies of the new window say the same.
        var designer = new DesignerService(env.Connections, env.Providers, M15Helpers.Features(), env.Catalog, env.Sessions, env.History);
        var failed = await Assert.ThrowsAsync<DdlFailedException>(() =>
            designer.ApplyAsync(conn.Id, new DdlApplyRequest(null, ["ALTER TABLE Customers ADD COLUMN Phone TEXT"], true), "ui-new", CancellationToken.None));
        Assert.Contains("Console 1 from an earlier window (open transaction)", failed.ProviderError.Message);

        await old.Session.RollbackAsync(CancellationToken.None);
    }
}

/// <summary>features-r1-06: designer applies (table/view designers, atomic "Edit:" runs) are recorded in History.</summary>
public class DesignerApplyHistoryTests
{
    [Fact]
    public async Task Apply_IsRecordedInHistory_WithLabelDesigner_OkAndError()
    {
        await using var env = new EngineEnv();
        var conn = await Shop.CreateAsync(env);
        var designer = new DesignerService(env.Connections, env.Providers, M15Helpers.Features(), env.Catalog, env.Sessions, env.History);

        var ok = await designer.ApplyAsync(conn.Id,
            new DdlApplyRequest("main", ["ALTER TABLE Customers ADD COLUMN Phone TEXT", "CREATE INDEX IX_Customers_Phone ON Customers (Phone);"], true),
            CancellationToken.None);
        Assert.True(ok.Ok);

        var failed = await Assert.ThrowsAsync<DdlFailedException>(() =>
            designer.ApplyAsync(conn.Id, new DdlApplyRequest(null, ["ALTER TABLE NoSuchTable ADD COLUMN X TEXT"], true), CancellationToken.None));

        var entries = (await env.History.SearchAsync(conn.Id, null, 50, null)).Where(e => e.Label == DesignerService.HistoryLabel).ToList();
        Assert.Equal(2, entries.Count);
        var okEntry = Assert.Single(entries, e => e.Status == "ok");
        Assert.Equal("ALTER TABLE Customers ADD COLUMN Phone TEXT;\nCREATE INDEX IX_Customers_Phone ON Customers (Phone);", okEntry.Sql);
        Assert.Equal("main", okEntry.Database);
        Assert.Equal(conn.Id, okEntry.ConnectionId);
        Assert.True(okEntry.DurationMs >= 0);
        Assert.Null(okEntry.Error);

        var errorEntry = Assert.Single(entries, e => e.Status == "error");
        Assert.Equal("ALTER TABLE NoSuchTable ADD COLUMN X TEXT", errorEntry.Sql);
        Assert.Equal(failed.Message, errorEntry.Error);
        Assert.Contains("NoSuchTable", errorEntry.Error);

        // Refused before anything ran: nothing to record.
        await Assert.ThrowsAsync<EngineException>(() => designer.ApplyAsync(conn.Id, new DdlApplyRequest(null, [" "], true), CancellationToken.None));
        Assert.Equal(2, (await env.History.SearchAsync(conn.Id, null, 50, null)).Count(e => e.Label == DesignerService.HistoryLabel));
    }

    [Fact]
    public void HistorySql_IsARerunnableScript_PerDialect()
    {
        string[] two = ["CREATE TABLE a (x int)", "CREATE PROCEDURE p AS SELECT 1"];
        Assert.Equal("CREATE TABLE a (x int)\nGO\nCREATE PROCEDURE p AS SELECT 1", DesignerService.HistorySql(Dialect.TSql, two));
        Assert.Equal("CREATE TABLE a (x int)\n/\nCREATE PROCEDURE p AS SELECT 1", DesignerService.HistorySql(Dialect.PlSql, two));
        Assert.Equal("CREATE TABLE a (x int);\nCREATE PROCEDURE p AS SELECT 1;", DesignerService.HistorySql(Dialect.Sqlite, two));
        Assert.Equal("CREATE TABLE a (x int) -- note\n;\nDROP TABLE b;", DesignerService.HistorySql(Dialect.Sqlite, ["CREATE TABLE a (x int) -- note", "  ", "DROP TABLE b"]));
        Assert.Equal("CREATE VIEW v AS SELECT 1", DesignerService.HistorySql(Dialect.TSql, ["  CREATE VIEW v AS SELECT 1  "]));
    }
}
