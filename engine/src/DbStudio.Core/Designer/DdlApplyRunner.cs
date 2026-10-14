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

    /// <summary>Called for each new command (timeouts, BindByName, ...).</summary>
    public Action<DbCommand>? Configure { get; init; }

    public async Task<DdlApplyResult> RunAsync(DbConnection connection, IReadOnlyList<string> statements, bool transactional, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var executed = 0;
        DbTransaction? tx = transactional ? await connection.BeginTransactionAsync(ct).ConfigureAwait(false) : null;
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
                    cmd.CommandTimeout = 0;
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
                    var message = $"Statement {i + 1} failed: {error.Message.TrimEnd().TrimEnd('.')}."
                                  + (rolledBack ? " All changes were rolled back." : executed > 0 ? $" {executed} statement(s) had already run and were committed." : "");
                    throw new DdlFailedException(message, i, executed, rolledBack, error);
                }
            }
            if (tx is not null) await tx.CommitAsync(ct).ConfigureAwait(false);
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
