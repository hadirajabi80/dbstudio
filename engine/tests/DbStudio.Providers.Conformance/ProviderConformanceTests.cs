using System.Diagnostics;
using System.Globalization;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Conformance;

/// <summary>
/// Behaviour every <see cref="IDbProvider"/> must have (docs/PLAN.md 2.2–2.6). A provider test project declares
/// <code>public sealed class SqliteConformanceTests(SqliteFixture f) : ProviderConformanceTests&lt;SqliteFixture&gt;(f);</code>
/// and gets all tests below. Tests are skipped when <see cref="ProviderFixture.IsAvailable"/> is false.
/// Identifiers are written in their logical T-SQL form and mapped with <see cref="ProviderFixture.N"/>.
/// </summary>
public abstract class ProviderConformanceTests<TFixture> : IClassFixture<TFixture> where TFixture : ProviderFixture
{
    protected ProviderConformanceTests(TFixture fixture) => Fixture = fixture;

    protected TFixture Fixture { get; }

    protected Dialect Dialect => Fixture.Dialect;

    protected static readonly TimeSpan Timeout = TimeSpan.FromSeconds(60);

    protected void RequireAvailable() => Skip.IfNot(Fixture.IsAvailable, Fixture.SkipReason ?? "Provider backend not available.");

    /// <summary>Batch 3: skips when the provider has no manual transactions (ClickHouse, Cassandra).</summary>
    protected void RequireTransactions() => Skip.IfNot(Fixture.SupportsTransactions, $"{Fixture.Provider.Id} has no manual transactions.");

    /// <summary>Batch 3: skips when the provider has no savepoints (Snowflake) or no transactions.</summary>
    protected void RequireSavepoints() => Skip.IfNot(Fixture.SupportsTransactions && Fixture.SupportsSavepoints, $"{Fixture.Provider.Id} has no savepoints.");

    /// <summary>Batch 3: skips when the provider cannot cancel a running statement.</summary>
    protected void RequireCancel() => Skip.IfNot(Fixture.SupportsCancel, $"{Fixture.Provider.Id} cannot cancel a running statement.");

    protected string N(string logical) => Fixture.N(logical);

    protected string Q(string logical) => $"{Fixture.ShopSchemaQualifier}{N(logical)}";

    protected static ExecuteRequest Request(int maxRows, bool stopOnError, params SqlBatch[] batches) =>
        new(batches, maxRows, stopOnError, false, "script");

    protected static ExecuteRequest Request(params string[] sql) =>
        new(sql.Select(s => new SqlBatch(s, 1, 1)).ToList(), 10_000, true, false, "script");

    protected static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession session, ExecuteRequest request)
    {
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(request, sink, CancellationToken.None).WaitAsync(Timeout);
        return (summary, sink);
    }

    protected static string NewScratchName() => "zz_conf_" + Guid.NewGuid().ToString("N")[..8];

    protected static bool NameEquals(string? a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    protected static void AssertOk(ExecutionSummary summary, RecordingSink sink) =>
        Assert.True(summary.Status == ExecutionStatus.Ok, $"Execution status {summary.Status}:{Environment.NewLine}{sink.Describe()}");

    // ------------------------------------------------------------------ connection

    [SkippableFact]
    public async Task TestConnection_Succeeds_WithServerInfo()
    {
        RequireAvailable();
        var result = await Fixture.Provider.TestAsync(Fixture.Profile, Fixture.Password, CancellationToken.None).WaitAsync(Timeout);
        Assert.True(result.Ok, result.Error?.Message);
        Assert.NotNull(result.ServerInfo);
        Assert.False(string.IsNullOrWhiteSpace(result.ServerInfo!.Version));
        Assert.Null(result.Error);
        Assert.True(result.ElapsedMs >= 0);
    }

    [SkippableFact]
    public async Task TestConnection_Fails_WithError()
    {
        RequireAvailable();
        var failing = Fixture.CreateFailingProfile();
        Skip.If(failing is null, "Fixture provides no failing profile.");
        var result = await Fixture.Provider.TestAsync(failing!, Fixture.Password, CancellationToken.None).WaitAsync(Timeout);
        Assert.False(result.Ok);
        Assert.NotNull(result.Error);
        Assert.False(string.IsNullOrWhiteSpace(result.Error!.Message));
    }

    [SkippableFact]
    public async Task OpenSession_IsIdle_WithServerInfo()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        Assert.Equal(SessionState.Idle, session.State);
        Assert.Equal(Fixture.Profile.Id, session.ConnectionId);
        Assert.Equal(Dialect, session.Dialect);
        Assert.Equal(TransactionMode.Auto, session.TxMode);
        Assert.False(session.TxOpen);
        Assert.False(string.IsNullOrWhiteSpace(session.Server.Version));
        Assert.True(await session.PingAsync(CancellationToken.None));
    }

    [SkippableFact]
    public async Task DisposeSession_Closes()
    {
        RequireAvailable();
        var session = await Fixture.OpenSessionAsync();
        await session.DisposeAsync();
        Assert.Equal(SessionState.Closed, session.State);
    }

    // ------------------------------------------------------------------ execution

    [SkippableFact]
    public async Task Execute_Query_StreamsColumnsAndRows()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var sql = $"SELECT {N("Id")}, {N("Name")}, {N("Email")} FROM {Q("Customers")} ORDER BY {N("Id")}";
        var (summary, sink) = await RunAsync(session, Request(sql));

        AssertOk(summary, sink);
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(0, rs.Id);
        Assert.Equal(0, rs.BatchIndex);
        Assert.Equal(new[] { N("Id"), N("Name"), N("Email") }, rs.Columns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
        Assert.Equal(Enumerable.Range(0, 3), rs.Columns.Select(c => c.Ordinal));
        Assert.Equal(ShopSchema.CustomerCount, rs.RowCount);
        Assert.Equal(ShopSchema.CustomerCount, rs.Rows.Count);
        Assert.False(rs.Truncated);
        Assert.Equal("Alice", rs.Rows[0][1]);
        Assert.Null(rs.Rows[1][2]); // Bob has no email
        Assert.Equal(1L, Convert.ToInt64(rs.Rows[0][0], CultureInfo.InvariantCulture));
        Assert.Equal(1, summary.ResultSets);
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(SessionState.Idle, session.State);

        var ended = Assert.Single(sink.BatchesEnded);
        Assert.Equal(BatchStatus.Ok, ended.Status);
        Assert.Single(sink.BatchesStarted);
    }

    [SkippableFact]
    public async Task Execute_DecimalColumn_IsDecimalKind()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, Request($"SELECT {N("Total")} FROM {Q("Orders")} WHERE {N("Id")} = 1"));
        AssertOk(summary, sink);
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(ColumnKinds.Decimal, rs.Columns[0].Kind);
        var value = rs.Rows[0][0];
        Assert.True(value is string or double or long or int, $"Unexpected wire type {value?.GetType()}");
        Assert.Equal(ShopSchema.Order1Total, decimal.Parse(ValueConverter.ToInvariantString(value), NumberStyles.Float, CultureInfo.InvariantCulture));
    }

    [SkippableFact]
    public async Task Execute_MultipleBatches_ProduceSeparateResultSets()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, Request(
            $"SELECT 1 AS a{Fixture.FromDual}",
            $"SELECT {N("Name")} FROM {Q("Countries")} ORDER BY {N("Id")}"));

        AssertOk(summary, sink);
        Assert.Equal(2, summary.ResultSets);
        var sets = sink.ResultSets;
        Assert.Equal(2, sets.Count);
        Assert.Equal((0, 0), (sets[0].Id, sets[0].BatchIndex));
        Assert.Equal((1, 1), (sets[1].Id, sets[1].BatchIndex));
        Assert.Equal(3, sets[1].RowCount);
        Assert.Equal(new[] { 0, 1 }, sink.BatchesEnded.Select(b => b.BatchIndex));
    }

    [SkippableFact]
    public async Task Execute_SingleBatchWithTwoResultSets()
    {
        RequireAvailable();
        Skip.If(Fixture.MultiResultSetBatch is null, "Dialect has no multi-result-set batch.");
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, Request(Fixture.MultiResultSetBatch!));
        AssertOk(summary, sink);
        Assert.Equal(2, sink.ResultSets.Count);
        Assert.All(sink.ResultSets, rs => Assert.Equal(0, rs.BatchIndex));
        Assert.Equal(2, sink.ResultSets[1].Columns.Length);
    }

    [SkippableFact]
    public async Task Execute_MaxRows_TruncatesAndContinues()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, Request(2, true,
            new SqlBatch($"SELECT {N("Id")} FROM {Q("Customers")} ORDER BY {N("Id")}", 1, 1),
            new SqlBatch($"SELECT 42 AS answer{Fixture.FromDual}", 2, 1)));

        AssertOk(summary, sink);
        var sets = sink.ResultSets;
        Assert.Equal(2, sets.Count);
        Assert.True(sets[0].Truncated);
        Assert.Equal(2, sets[0].RowCount);
        Assert.Equal(2, sets[0].Rows.Count);
        Assert.False(sets[1].Truncated);
        Assert.Equal(1, sets[1].RowCount);
    }

    [SkippableFact]
    public async Task Execute_Dml_ReportsRowsAffected()
    {
        RequireAvailable();
        var table = NewScratchName();
        await using var session = await Fixture.OpenSessionAsync();
        try
        {
            var (s1, k1) = await RunAsync(session, Request(Fixture.CreateScratchTableSql(table)));
            AssertOk(s1, k1);
            var (summary, sink) = await RunAsync(session, Request(
                Fixture.InsertScratchRowsSql(table, 1, 3),
                $"UPDATE {table} SET val = 'x' WHERE id <= 2",
                $"DELETE FROM {table} WHERE id = 3"));

            AssertOk(summary, sink);
            var affected = sink.Affected;
            Assert.Contains(affected, a => a.BatchIndex == 0 && a.Count == 3);
            Assert.Contains(affected, a => a.BatchIndex == 1 && a.Count == 2);
            Assert.Contains(affected, a => a.BatchIndex == 2 && a.Count == 1);
            Assert.Equal("UPDATE", affected.First(a => a.BatchIndex == 1).StatementKind, StringComparer.OrdinalIgnoreCase);
            Assert.Equal(6, summary.RowsAffected);
            Assert.Equal(0, summary.ResultSets);
        }
        finally
        {
            await RunAsync(session, Request(Fixture.DropScratchTableSql(table)));
        }
    }

    [SkippableFact]
    public async Task Execute_Error_ReportsDocumentLine()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, Request(10, true, new SqlBatch(Fixture.InvalidQuery, 7, 1)));

        Assert.Equal(ExecutionStatus.Error, summary.Status);
        var error = Assert.Single(sink.Errors);
        Assert.Equal(0, error.BatchIndex);
        Assert.False(string.IsNullOrWhiteSpace(error.Error.Code));
        Assert.Contains("no_such_table_xyz", error.Error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(7, error.Error.Line);
        Assert.Equal(BatchStatus.Error, Assert.Single(sink.BatchesEnded).Status);
        Assert.Equal(SessionState.Idle, session.State);
    }

    [SkippableFact]
    public async Task Execute_ErrorOnLaterLineOfBatch_IsAbsolute()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        // Leading blank line + comment: the failing statement starts on the batch's 3rd line → document line 12.
        var sql = "\n-- comment\n" + Fixture.InvalidQuery;
        var (_, sink) = await RunAsync(session, Request(10, true, new SqlBatch(sql, 10, 1)));
        var error = Assert.Single(sink.Errors);
        Assert.Equal(12, error.Error.Line);
    }

    [SkippableFact]
    public async Task Execute_StopOnError_StopsOrContinues()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var batches = new[] { new SqlBatch(Fixture.InvalidQuery, 1, 1), new SqlBatch($"SELECT 1 AS ok{Fixture.FromDual}", 2, 1) };

        var (stopSummary, stopSink) = await RunAsync(session, Request(10, true, batches));
        Assert.Equal(ExecutionStatus.Error, stopSummary.Status);
        Assert.Single(stopSink.BatchesStarted);
        Assert.Empty(stopSink.ResultSets);

        var (goSummary, goSink) = await RunAsync(session, Request(10, false, batches));
        Assert.Equal(ExecutionStatus.Error, goSummary.Status);
        Assert.Equal(2, goSink.BatchesStarted.Count);
        Assert.Single(goSink.ResultSets);
        Assert.Equal(new[] { BatchStatus.Error, BatchStatus.Ok }, goSink.BatchesEnded.Select(b => b.Status));
    }

    [SkippableFact]
    public async Task Execute_WhileBusy_Throws()
    {
        RequireAvailable();
        RequireCancel();
        await using var session = await Fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        var running = session.ExecuteAsync(Request(Fixture.LongRunningQuery), sink, CancellationToken.None);
        try
        {
            Assert.Equal(SessionState.Executing, session.State);
            await Assert.ThrowsAsync<SessionBusyException>(() => session.ExecuteAsync(Request($"SELECT 1 AS a{Fixture.FromDual}"), new RecordingSink(), CancellationToken.None));
        }
        finally
        {
            session.Cancel();
            await running.WaitAsync(Timeout);
        }
    }

    [SkippableFact]
    public async Task Cancel_LongRunningQuery_ReturnsQuicklyAndSessionStaysUsable()
    {
        RequireAvailable();
        RequireCancel();
        await using var session = await Fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        var running = session.ExecuteAsync(Request(Fixture.LongRunningQuery), sink, CancellationToken.None);
        await sink.FirstBatchStarted.Task.WaitAsync(Timeout);
        await Task.Delay(500);
        Assert.False(running.IsCompleted, "The long-running query finished before it could be cancelled.");

        var sw = Stopwatch.StartNew();
        session.Cancel();
        var summary = await running.WaitAsync(TimeSpan.FromSeconds(15));
        sw.Stop();

        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"Cancel took {sw.Elapsed}.");
        Assert.Equal(BatchStatus.Cancelled, Assert.Single(sink.BatchesEnded).Status);
        Assert.Empty(sink.Errors);
        Assert.Equal(SessionState.Idle, session.State);

        var (after, afterSink) = await RunAsync(session, Request($"SELECT 1 AS a{Fixture.FromDual}"));
        AssertOk(after, afterSink);
    }

    [SkippableFact]
    public async Task Cancel_WhenIdle_IsNoOp()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        session.Cancel();
        var (summary, sink) = await RunAsync(session, Request($"SELECT 1 AS a{Fixture.FromDual}"));
        AssertOk(summary, sink);
    }

    // ------------------------------------------------------------------ transactions

    [SkippableFact]
    public async Task ManualTransaction_Commit_Persists()
    {
        RequireAvailable();
        RequireTransactions();
        var table = NewScratchName();
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table)]);
        try
        {
            await using (var session = await Fixture.OpenSessionAsync())
            {
                await session.SetTransactionModeAsync(TransactionMode.Manual, CancellationToken.None);
                Assert.Equal(TransactionMode.Manual, session.TxMode);
                Assert.False(session.TxOpen);

                var (summary, sink) = await RunAsync(session, Request(Fixture.InsertScratchRowsSql(table, 1, 2)));
                AssertOk(summary, sink);
                Assert.True(session.TxOpen);

                await session.CommitAsync(CancellationToken.None);
                Assert.False(session.TxOpen);
            }

            Assert.Equal(2L, ToLong(await Fixture.ScalarAsync($"SELECT COUNT(*) FROM {table}")));
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    [SkippableFact]
    public async Task ManualTransaction_Rollback_Discards()
    {
        RequireAvailable();
        RequireTransactions();
        var table = NewScratchName();
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table), Fixture.InsertScratchRowsSql(table, 1, 1)]);
        try
        {
            await using (var session = await Fixture.OpenSessionAsync(TransactionMode.Manual))
            {
                var (summary, sink) = await RunAsync(session, Request(Fixture.InsertScratchRowsSql(table, 10, 3), $"DELETE FROM {table} WHERE id = 1"));
                AssertOk(summary, sink);
                Assert.True(session.TxOpen);

                // Inside the transaction the session sees its own changes.
                var (_, countSink) = await RunAsync(session, Request($"SELECT COUNT(*) AS n FROM {table}"));
                Assert.Equal(3L, ToLong(countSink.ResultSets[0].Rows[0][0]));

                await session.RollbackAsync(CancellationToken.None);
                Assert.False(session.TxOpen);

                var (_, afterSink) = await RunAsync(session, Request($"SELECT COUNT(*) AS n FROM {table}"));
                Assert.Equal(1L, ToLong(afterSink.ResultSets[0].Rows[0][0]));
                await session.RollbackAsync(CancellationToken.None); // the SELECT opened a new manual transaction
            }

            Assert.Equal(1L, ToLong(await Fixture.ScalarAsync($"SELECT COUNT(*) FROM {table}")));
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    // The grid's edit savepoint (ui/src/data/sqlgen.ts savepointSql / rollbackToSavepointSql / releaseSavepointSql).
    private string SavepointSql => Dialect == Dialect.TSql ? "SAVE TRANSACTION dbs_edit" : "SAVEPOINT dbs_edit";
    private string RollbackToSavepointSql => Dialect == Dialect.TSql ? "ROLLBACK TRANSACTION dbs_edit" : "ROLLBACK TO SAVEPOINT dbs_edit";
    private string? ReleaseSavepointSql => Dialect == Dialect.Sqlite ? "RELEASE SAVEPOINT dbs_edit" : null;

    /// <summary>
    /// Rows of <paramref name="table"/> with val = <paramref name="val"/> as another session sees them. SQL Server reads
    /// with READPAST: a row still locked by an uncommitted change is skipped instead of blocking, a committed one counts.
    /// </summary>
    private async Task<long> CommittedCountAsync(string table, string val) =>
        ToLong(await Fixture.ScalarAsync($"SELECT COUNT(*) FROM {table}{(Dialect == Dialect.TSql ? " WITH (READPAST)" : "")} WHERE val = '{val}'"));

    private async Task RunOkAsync(IDbSession session, string sql)
    {
        var (summary, sink) = await RunAsync(session, Request(sql));
        AssertOk(summary, sink);
    }

    /// <summary>
    /// code-r1-01: a manual-mode session with nothing open runs the grid's "SAVEPOINT; DML; RELEASE". The savepoint
    /// begins the engine transaction (SQL Server would refuse SAVE TRANSACTION outside one, SQLite's RELEASE would commit
    /// its own, Oracle would auto-commit), so the change stays pending until the user commits and Rollback undoes it.
    /// </summary>
    [SkippableFact]
    public async Task ManualTransaction_EditSavepoint_WithNothingOpen_KeepsTheChangePending()
    {
        RequireAvailable();
        RequireSavepoints();
        var table = NewScratchName();
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table), Fixture.InsertScratchRowsSql(table, 1, 1)]);
        try
        {
            await using (var session = await Fixture.OpenSessionAsync(TransactionMode.Manual))
            {
                Assert.False(session.TxOpen);
                await RunOkAsync(session, SavepointSql);
                Assert.True(session.TxOpen);
                await RunOkAsync(session, $"UPDATE {table} SET val = 'edited' WHERE id = 1");
                if (ReleaseSavepointSql is { } release) await RunOkAsync(session, release);

                // RELEASE released only the savepoint: the engine transaction is still open and nothing is committed.
                Assert.True(session.TxOpen);
                Assert.Equal(0L, await CommittedCountAsync(table, "edited"));

                await session.RollbackAsync(CancellationToken.None);
                Assert.False(session.TxOpen);
            }

            Assert.Equal(0L, await CommittedCountAsync(table, "edited"));
            Assert.Equal(1L, await CommittedCountAsync(table, "v1"));
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    /// <summary>code-r1-01, failure path: ROLLBACK TO the savepoint (+ RELEASE) leaves a clean open transaction.</summary>
    [SkippableFact]
    public async Task ManualTransaction_EditSavepoint_RollbackTo_LeavesACleanOpenTransaction()
    {
        RequireAvailable();
        RequireSavepoints();
        var table = NewScratchName();
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table), Fixture.InsertScratchRowsSql(table, 1, 1)]);
        try
        {
            await using (var session = await Fixture.OpenSessionAsync(TransactionMode.Manual))
            {
                await RunOkAsync(session, SavepointSql);
                await RunOkAsync(session, $"UPDATE {table} SET val = 'edited' WHERE id = 1");
                await RunOkAsync(session, RollbackToSavepointSql);
                if (ReleaseSavepointSql is { } release) await RunOkAsync(session, release);
                Assert.True(session.TxOpen);

                // The session itself no longer sees the edit, and nobody else ever did.
                var (_, own) = await RunAsync(session, Request($"SELECT val FROM {table} WHERE id = 1"));
                Assert.Equal("v1", own.ResultSets[0].Rows[0][0]);
                Assert.Equal(0L, await CommittedCountAsync(table, "edited"));

                // Committing that transaction commits nothing of the undone edit.
                await session.CommitAsync(CancellationToken.None);
                Assert.False(session.TxOpen);
            }

            Assert.Equal(1L, await CommittedCountAsync(table, "v1"));
            Assert.Equal(0L, await CommittedCountAsync(table, "edited"));
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    [SkippableFact]
    public async Task SwitchToAuto_WithOpenTransaction_Throws()
    {
        RequireAvailable();
        RequireTransactions();
        var table = NewScratchName();
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table)]);
        try
        {
            await using var session = await Fixture.OpenSessionAsync(TransactionMode.Manual);
            var (summary, sink) = await RunAsync(session, Request(Fixture.InsertScratchRowsSql(table, 1, 1)));
            AssertOk(summary, sink);
            Assert.True(session.TxOpen);
            await Assert.ThrowsAsync<TxOpenException>(() => session.SetTransactionModeAsync(TransactionMode.Auto, CancellationToken.None));
            await session.RollbackAsync(CancellationToken.None);
            await session.SetTransactionModeAsync(TransactionMode.Auto, CancellationToken.None);
            Assert.Equal(TransactionMode.Auto, session.TxMode);
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    // ------------------------------------------------------------------ catalog

    [SkippableFact]
    public async Task Catalog_ListsShopSchema_AndDefault()
    {
        RequireAvailable();
        await using var reader = await Fixture.OpenCatalogAsync();
        var schemas = await reader.ListSchemasAsync(Fixture.Database, CancellationToken.None);
        Assert.Contains(schemas, s => NameEquals(s.Name, Fixture.ShopSchema));
        var defaultSchema = await reader.GetDefaultSchemaAsync(Fixture.Database, CancellationToken.None);
        Assert.Equal(Fixture.ShopSchema, defaultSchema, StringComparer.OrdinalIgnoreCase);
        // ListDatabasesAsync must not throw (Oracle returns an empty list).
        _ = await reader.ListDatabasesAsync(CancellationToken.None);
    }

    [SkippableFact]
    public async Task Catalog_LoadSchema_TablesColumnsKeys()
    {
        RequireAvailable();
        var schema = await LoadShopSchemaAsync();
        Assert.Equal(Fixture.ShopSchema, schema.Name, StringComparer.OrdinalIgnoreCase);

        foreach (var t in new[] { "Countries", "Customers", "Orders", "Products", "OrderLines" })
            Assert.Equal(ObjectTypes.Table, Find(schema, t).Type);

        var customers = Find(schema, "Customers");
        Assert.Equal(new[] { N("Id"), N("Name"), N("Email"), N("CountryId") }, customers.Columns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
        Assert.Equal(new[] { N("Id") }, customers.PrimaryKey, StringComparer.OrdinalIgnoreCase);
        var id = customers.Columns[0];
        Assert.True(id.IsPk);
        Assert.True((id.Flags & 1) == 1, "Customers.Id must be flagged identity/autoincrement.");
        Assert.False(customers.Columns[1].Nullable);
        Assert.True(customers.Columns[2].Nullable);
        Assert.All(customers.Columns, c => Assert.False(string.IsNullOrWhiteSpace(c.TypeText)));

        var lines = Find(schema, "OrderLines");
        Assert.Equal(new[] { N("OrderId"), N("ProductId") }, lines.PrimaryKey, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(2, lines.ForeignKeys.Count);
    }

    [SkippableFact]
    public async Task Catalog_LoadSchema_ForeignKeys()
    {
        RequireAvailable();
        var schema = await LoadShopSchemaAsync();
        var orders = Find(schema, "Orders");
        var fk = Assert.Single(orders.ForeignKeys);
        Assert.Equal(N("Customers"), fk.RefTable, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(new[] { N("CustomerId") }, fk.Columns, StringComparer.OrdinalIgnoreCase);
        Assert.Equal(new[] { N("Id") }, fk.RefColumns, StringComparer.OrdinalIgnoreCase);
        Assert.False(string.IsNullOrWhiteSpace(fk.Name));
        if (fk.RefSchema is not null) Assert.Equal(Fixture.ShopSchema, fk.RefSchema, StringComparer.OrdinalIgnoreCase);

        var customers = Find(schema, "Customers");
        var toCountries = Assert.Single(customers.ForeignKeys);
        Assert.Equal(N("Countries"), toCountries.RefTable, StringComparer.OrdinalIgnoreCase);
    }

    [SkippableFact]
    public async Task Catalog_LoadSchema_View()
    {
        RequireAvailable();
        var schema = await LoadShopSchemaAsync();
        var view = Find(schema, "CustomerOrders");
        Assert.Equal(ObjectTypes.View, view.Type);
        Assert.Equal(new[] { N("CustomerId"), N("Name"), N("OrderId"), N("Total") }, view.Columns.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
    }

    [SkippableFact]
    public async Task Catalog_ObjectDetails_ColumnsAndReferencedBy()
    {
        RequireAvailable();
        await using var reader = await Fixture.OpenCatalogAsync();
        var details = await reader.GetObjectDetailsAsync(new ObjectRef(Fixture.Database, Fixture.ShopSchema, N("Customers"), ObjectTypes.Table), CancellationToken.None);

        Assert.Equal(4, details.Columns.Count);
        Assert.Equal(N("Id"), details.Columns[0].Name, StringComparer.OrdinalIgnoreCase);
        Assert.True(details.Columns[0].IsPk);
        Assert.True(details.Columns[0].IsIdentity);
        Assert.False(details.Columns[1].Nullable);
        Assert.Equal(Enumerable.Range(1, 4), details.Columns.Select(c => c.Ordinal));
        Assert.Single(details.ForeignKeys);
        // Incoming FKs: Orders.CustomerId → Customers.Id
        var incoming = Assert.Single(details.ReferencedBy, r => NameEquals(r.Table, N("Orders")));
        Assert.Equal(new[] { N("CustomerId") }, incoming.Columns, StringComparer.OrdinalIgnoreCase);
        Assert.False(string.IsNullOrWhiteSpace(incoming.Constraint));

        var lineDetails = await reader.GetObjectDetailsAsync(new ObjectRef(Fixture.Database, Fixture.ShopSchema, N("OrderLines"), ObjectTypes.Table), CancellationToken.None);
        var qty = Assert.Single(lineDetails.Columns, c => NameEquals(c.Name, N("Qty")));
        Assert.NotNull(qty.Default);
        Assert.Contains("1", qty.Default);
    }

    [SkippableFact]
    public async Task Catalog_Ddl_ForTableAndView()
    {
        RequireAvailable();
        await using var reader = await Fixture.OpenCatalogAsync();
        var table = await reader.GetDdlAsync(new ObjectRef(Fixture.Database, Fixture.ShopSchema, N("Customers"), ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("CREATE", table.Ddl, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(N("Customers"), table.Ddl, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(N("Email"), table.Ddl, StringComparison.OrdinalIgnoreCase);
        Assert.True(table.Source is "generated" or "stored");

        var view = await reader.GetDdlAsync(new ObjectRef(Fixture.Database, Fixture.ShopSchema, N("CustomerOrders"), ObjectTypes.View), CancellationToken.None);
        Assert.Contains("SELECT", view.Ddl, StringComparison.OrdinalIgnoreCase);
        Assert.Equal("stored", view.Source);
    }

    [SkippableFact]
    public async Task Catalog_CompileErrors_AndPublicSynonym_DoNotThrow()
    {
        RequireAvailable();
        await using var reader = await Fixture.OpenCatalogAsync();
        var errors = await reader.GetCompileErrorsAsync(new ObjectRef(Fixture.Database, Fixture.ShopSchema, N("CustomerOrders"), ObjectTypes.View), CancellationToken.None);
        Assert.NotNull(errors);
        _ = await reader.ResolvePublicSynonymAsync("NO_SUCH_SYNONYM_XYZ", CancellationToken.None);
    }

    // ------------------------------------------------------------------ helpers

    protected async Task<SchemaCatalog> LoadShopSchemaAsync()
    {
        await using var reader = await Fixture.OpenCatalogAsync();
        return await reader.LoadSchemaAsync(Fixture.Database, Fixture.ShopSchema, CancellationToken.None).WaitAsync(Timeout);
    }

    protected CatalogObject Find(SchemaCatalog schema, string logical)
    {
        var name = N(logical);
        var obj = schema.Objects.FirstOrDefault(o => NameEquals(o.Name, name));
        Assert.True(obj is not null, $"Object {name} not found in schema {schema.Name}: {string.Join(", ", schema.Objects.Select(o => o.Name))}");
        return obj!;
    }

    protected static long ToLong(object? wire) =>
        Convert.ToInt64(decimal.Parse(ValueConverter.ToInvariantString(wire), NumberStyles.Float, CultureInfo.InvariantCulture));
}
