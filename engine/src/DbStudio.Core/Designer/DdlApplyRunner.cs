using System.Data.Common;
using System.Diagnostics;
using DbStudio.Core.Models;

namespace DbStudio.Core.Designer;

/// <summary>
/// Executes a designer DDL script on a dedicated connection (docs/PLAN-M1.5.md 3.9 apply). Transactional: one
/// transaction, rolled back on the first error. Non-transactional: autocommit per statement, stop at the first error.
/// Transaction-control statements (BEGIN/COMMIT) in hand-edited scripts are skipped because the runner owns the
/// transaction. Failures throw <see cref="DdlFailedException"/> with the index of the failing statement.
/// </summary>
public sealed class DdlApplyRunner
{
    /// <summary>Maps a driver exception to the error reported in <c>detail.providerError</c>.</summary>
    public required Func<Exception, string, ErrorInfo> MapError { get; init; }

    /// <summary>Optional rewrite of each statement before execution (Oracle: strip the trailing ; and /). Return "" to skip.</summary>
    public Func<string, string>? PrepareSql { get; init; }

    /// <summary>Executes one statement (default ExecuteNonQueryAsync). May throw to fail the statement.</summary>
    public Func<DbCommand, CancellationToken, Task>? Execute { get; init; }

    /// <summary>
    /// CommandTimeout of every statement (default 0 = no limit: a rebuild of a large table may legitimately run long).
    /// SQLite passes its busy timeout: its driver retries a locked database until CommandTimeout, so 0 would hang forever.
    /// </summary>
    public int CommandTimeoutSeconds { get; init; }

    /// <summary>Called for each new command (timeouts, BindByName, ...).</summary>
    public Action<DbCommand>? Configure { get; init; }

    /// <summary>"Statement 2 failed: &lt;error&gt;. All changes were rolled back." (also used when a service rewords the error).</summary>
    public static string FailureMessage(int failedIndex, ErrorInfo error, int executed, bool rolledBack) =>
        $"Statement {failedIndex + 1} failed: {error.Message.TrimEnd().TrimEnd('.')}."
        + (rolledBack ? " All changes were rolled back." : executed > 0 ? $" {executed} statement(s) had already run and were committed." : "");

    public async Task<DdlApplyResult> RunAsync(DbConnection connection, IReadOnlyList<string> statements, bool transactional, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var executed = 0;
        DbTransaction? tx = null;
        if (transactional)
        {
            try
            {
                tx = await connection.BeginTransactionAsync(ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                // SQLite BEGIN IMMEDIATE waits for other connections' write locks (busy timeout).
                var error = MapError(ex, "BEGIN");
                throw new DdlFailedException($"Could not start the transaction: {error.Message.TrimEnd().TrimEnd('.')}. Nothing was changed.",
                    0, 0, true, error);
            }
        }
        try
        {
            for (var i = 0; i < statements.Count; i++)
            {
                var raw = statements[i] ?? "";
                if (string.IsNullOrWhiteSpace(raw) || DdlText.IsTransactionControl(raw)) continue;
                var sql = PrepareSql is null ? raw.Trim() : PrepareSql(raw);
                if (string.IsNullOrWhiteSpace(sql)) continue;
                try
                {
                    await using var cmd = connection.CreateCommand();
                    cmd.CommandText = sql;
                    cmd.Transaction = tx;
                    cmd.CommandTimeout = CommandTimeoutSeconds;
                    Configure?.Invoke(cmd);
                    if (Execute is not null) await Execute(cmd, ct).ConfigureAwait(false);
                    else await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
                    executed++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    var rolledBack = false;
                    if (tx is not null)
                    {
                        try { await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false); rolledBack = true; }
                        catch (Exception) { /* the server may have rolled back already (SQL Server XACT_ABORT errors) */ rolledBack = true; }
                        await tx.DisposeAsync().ConfigureAwait(false);
                        tx = null;
                    }
                    var error = MapError(ex, sql);
                    throw new DdlFailedException(FailureMessage(i, error, executed, rolledBack), i, executed, rolledBack, error);
                }
            }
            if (tx is not null)
            {
                try
                {
                    await tx.CommitAsync(ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    // SQLite: COMMIT needs an exclusive lock and gives up after the busy timeout when a console still reads.
                    try { await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false); } catch (Exception) { /* already ended */ }
                    await tx.DisposeAsync().ConfigureAwait(false);
                    tx = null;
                    var error = MapError(ex, "COMMIT");
                    throw new DdlFailedException($"Could not commit: {error.Message.TrimEnd().TrimEnd('.')}. All changes were rolled back.",
                        Math.Max(0, statements.Count - 1), executed, true, error);
                }
            }
            return new DdlApplyResult(true, executed, sw.ElapsedMilliseconds);
        }
        catch (OperationCanceledException) when (tx is not null)
        {
            try { await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false); } catch (Exception) { /* connection closing */ }
            throw;
        }
        finally
        {
            if (tx is not null) await tx.DisposeAsync().ConfigureAwait(false);
        }
    }
}
