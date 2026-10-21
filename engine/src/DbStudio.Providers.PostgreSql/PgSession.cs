using System.Data;
using System.Data.Common;
using System.Globalization;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.PostgreSql.Params;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// One PostgreSQL editor-tab session (docs/PLAN-PG.md 2.2): a dedicated Npgsql connection with pooling off.
/// <list type="bullet">
/// <item>Each batch is split into its statements (PostgreSQL lexical rules) and sent as one <see cref="NpgsqlBatch"/>:
/// one statement per batch command, positional <c>$k</c> parameters renumbered per statement, every result set
/// returned in order. Like <c>psql -c</c>, the statements of one batch share an implicit transaction in auto mode.</item>
/// <item>NOTICE/WARNING/INFO (RAISE) arrive as server messages with DETAIL/HINT/CONTEXT.</item>
/// <item>Errors carry the SQLSTATE and the document line/column of the server's position, mapped back through the
/// statement split and the placeholder rewrite.</item>
/// <item>Manual mode (D-PG3): every batch runs inside <c>SAVEPOINT dbstudio_stmt</c>, released on success and rolled back
/// on error/cancel, so a failing statement never leaves the transaction in the aborted (25P02) state.</item>
/// <item>A user-typed BEGIN/COMMIT in auto mode is detected after each batch (<c>transaction_timestamp() &lt;&gt; statement_timestamp()</c>).</item>
/// <item>Rows affected are reported per INSERT/UPDATE/DELETE/MERGE/COPY statement.</item>
/// </list>
/// </summary>
public sealed class PgSession : AdoSessionBase
{
    public const string StatementSavepoint = "dbstudio_stmt";
    public const string SavepointRolledBackMessage =
        "Statement rolled back to its savepoint; the transaction stays open with the previous statements intact.";

    private const string SentKey = "pg.sent";
    private const string ClassificationKey = "pg.classification";
    private const string SavepointKey = "pg.savepoint";
    private const string StoppedKey = "pg.stopped";
    private const string WarningsKey = "pg.warnings";

    private readonly NpgsqlConnection _conn;
    private volatile NpgsqlBatch? _currentBatch;

    public PgSession(NpgsqlConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server)
        : base(connection, profile, options, Dialect.PgSql, server)
    {
        _conn = connection;
        _conn.Notice += OnNotice;
        CurrentDatabase = string.IsNullOrEmpty(_conn.Database) ? server.Database : _conn.Database;
    }

    /// <summary>The statements one batch was sent as: the (rewritten) batch text and, per statement, its batch command,
    /// offset in that text, the statement text and the text actually sent (placeholders renumbered).</summary>
    internal sealed record SentStatement(NpgsqlBatchCommand? Command, int Start, string Text, string SentText);

    internal sealed record SentBatch(string Text, IReadOnlyList<SentStatement> Statements);

    // ------------------------------------------------------------------ hooks

    protected override IParamBinder? ParamBinder => PgParamBinder.Instance;

    /// <summary>PostgreSQL placeholders are unambiguous ($n, :x, @x; never ?), so missing values fail up front.</summary>
    protected override bool RejectUnboundParameters => true;

    protected override int DefaultCommandTimeoutSeconds => 0;

    protected override string PingSql => "SELECT 1";

    private static BatchClassification ClassificationOf(BatchContext ctx)
    {
        if (ctx.Items.TryGetValue(ClassificationKey, out var c) && c is BatchClassification cached) return cached;
        var cls = PgSqlText.Classify(ctx.Batch.Sql);
        ctx.Items[ClassificationKey] = cls;
        return cls;
    }

    /// <summary>Manual mode: queries, session and transaction statements run without the engine transaction (lazy begin);
    /// a write or a SAVEPOINT begins it. Uses the PostgreSQL classification (dollar-quoted bodies, BEGIN as transaction).</summary>
    protected override bool RequiresTransaction(BatchContext context)
    {
        var c = ClassificationOf(context);
        return !c.IsQueryOnly || c.HasSavepoint;
    }

    protected override string? ClassifyAffected(BatchContext context)
    {
        var c = ClassificationOf(context);
        return c.HasDml ? c.PrimaryKind : null;
    }

    /// <summary>COPY … FROM STDIN / TO STDOUT need a client data stream the console cannot provide; reject them before
    /// they reach the driver (which would leave the connection in COPY mode).</summary>
    protected override ErrorInfo? ValidateBatch(SqlBatch batch, BatchContext context)
    {
        foreach (var st in PgSqlText.Split(batch.Sql))
        {
            var t = st.Tokens;
            if (t.Count == 0 || !t[0].IsWord("COPY")) continue;
            if (t.Any(x => x.IsWord("STDIN") || x.IsWord("STDOUT")))
            {
                var (line, col) = PgSqlText.LineColAt(batch.Sql, st.Start);
                return new ErrorInfo(ErrorCodes.NotSupported,
                    "COPY … FROM STDIN / TO STDOUT streams data through the client, which the console does not support. " +
                    "Use COPY with a server-side file or program, or the export/import features.",
                    ToDocumentLine(batch, line), ToDocumentCol(batch, line, col));
            }
        }
        return null;
    }

    protected override async Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct)
    {
        var cmd = (NpgsqlCommand)command;
        var text = cmd.CommandText;
        var statements = PgSqlText.Split(text);
        var classification = ClassificationOf(context);

        // D-PG3: a statement savepoint around the batch inside the engine transaction (not around the user's own
        // transaction/savepoint statements: releasing ours would also release savepoints they establish).
        if (Transaction is not null && statements.Count > 0 && !classification.Statements.Any(s => s.Category == StatementCategory.Transaction))
        {
            await using var sp = CreateCommand("SAVEPOINT " + StatementSavepoint);
            await sp.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            context.Items[SavepointKey] = true;
        }

        if (statements.Count == 0)
        {
            // Only comments/whitespace: the server answers with an empty query response.
            context.Items[SentKey] = new SentBatch(text, [new SentStatement(null, 0, text, text)]);
            return await cmd.ExecuteReaderAsync(CommandBehavior.Default, ct).ConfigureAwait(false);
        }

        // One batch command per statement; the global $k of the rewritten text are renumbered $1..$m per statement.
        var specs = new List<(PgStatement Statement, string Text, string Sent, List<NpgsqlParameter> Parameters)>(statements.Count);
        var globals = cmd.Parameters;
        foreach (var st in statements)
        {
            var stText = text[st.Start..st.End];
            var parameters = new List<NpgsqlParameter>();
            var sentText = stText;
            if (globals.Count > 0)
            {
                var (local, order) = Renumber(stText);
                sentText = local;
                foreach (var globalIndex in order)
                {
                    var src = globalIndex >= 1 && globalIndex <= globals.Count ? globals[globalIndex - 1] : null;
                    parameters.Add(src is null
                        ? new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Unknown, Value = DBNull.Value }
                        : new NpgsqlParameter { NpgsqlDbType = src.NpgsqlDbType, Value = src.Value });
                }
            }
            specs.Add((st, stText, sentText, parameters));
        }

        for (var attempt = 0; ; attempt++)
        {
            var batch = new NpgsqlBatch(_conn, Transaction as NpgsqlTransaction) { Timeout = cmd.CommandTimeout };
            var sent = new List<SentStatement>(specs.Count);
            foreach (var spec in specs)
            {
                var bc = new NpgsqlBatchCommand(spec.Sent);
                foreach (var p in spec.Parameters) bc.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = p.NpgsqlDbType, Value = p.Value });
                batch.BatchCommands.Add(bc);
                sent.Add(new SentStatement(bc, spec.Statement.Start, spec.Text, spec.Sent));
            }
            context.Items[SentKey] = new SentBatch(text, sent);
            _currentBatch = batch;
            try
            {
                return await batch.ExecuteReaderAsync(CommandBehavior.Default, ct).ConfigureAwait(false);
            }
            catch (PostgresException pg) when (pg.SqlState == "42P18" && attempt < 16 && CanRetry(context)
                                               && TypeIndeterminateAsText(pg, sent, specs.Select(s => s.Parameters).ToList()))
            {
                // A NULL/string value in a context that gives no type ($1 IS NULL, SELECT $1): nothing ran (the failed
                // pipeline was rolled back), so send it again with that parameter typed as text.
                _currentBatch = null;
                await batch.DisposeAsync().ConfigureAwait(false);
                if (context.Items.ContainsKey(SavepointKey)) await ExecAsync("ROLLBACK TO SAVEPOINT " + StatementSavepoint).ConfigureAwait(false);
            }
            catch
            {
                _currentBatch = null;
                await batch.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }
    }

    /// <summary>A retry is safe when the failed pipeline left nothing behind: autocommit outside a user transaction, or
    /// inside the statement savepoint (rolled back before the retry).</summary>
    private bool CanRetry(BatchContext context) =>
        context.Items.ContainsKey(SavepointKey) || (Transaction is null && !ServerTxOpen);

    /// <summary>"could not determine data type of parameter $n" → parameter n of the failing statement becomes text.</summary>
    private static bool TypeIndeterminateAsText(PostgresException pg, IReadOnlyList<SentStatement> sent, IReadOnlyList<List<NpgsqlParameter>> parameters)
    {
        var m = System.Text.RegularExpressions.Regex.Match(pg.MessageText, @"\$(\d+)");
        if (!m.Success || !int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var n)) return false;
        var index = -1;
        for (var i = 0; i < sent.Count; i++) if (ReferenceEquals(sent[i].Command, pg.BatchCommand)) index = i;
        if (index < 0 && sent.Count == 1) index = 0;
        if (index < 0 || n < 1 || n > parameters[index].Count) return false;
        var p = parameters[index][n - 1];
        if (p.NpgsqlDbType != NpgsqlTypes.NpgsqlDbType.Unknown) return false;
        p.NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text;
        return true;
    }


    /// <summary>Renumbers the global <c>$k</c> placeholders of one statement to <c>$1..$m</c> (first appearance order).</summary>
    internal static (string Text, IReadOnlyList<int> GlobalOrder) Renumber(string statement)
    {
        var placeholders = PgSqlText.Placeholders(statement).Where(p => p.Positional).ToList();
        if (placeholders.Count == 0) return (statement, []);
        var order = new List<int>();
        var local = new Dictionary<int, int>();
        var sb = new System.Text.StringBuilder(statement.Length);
        var last = 0;
        foreach (var p in placeholders)
        {
            if (!int.TryParse(p.Name, NumberStyles.None, CultureInfo.InvariantCulture, out var g) || g <= 0) continue;
            if (!local.TryGetValue(g, out var l))
            {
                order.Add(g);
                l = order.Count;
                local[g] = l;
            }
            sb.Append(statement, last, p.Start - last).Append('$').Append(l.ToString(CultureInfo.InvariantCulture));
            last = p.End;
        }
        sb.Append(statement, last, statement.Length - last);
        return (sb.ToString(), order);
    }

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        var columns = base.DescribeColumns(reader, context);
        for (var i = 0; i < columns.Length; i++)
        {
            Type? clr;
            try { clr = reader.GetFieldType(i); } catch { clr = null; }
            var kind = PgTypes.KindFor(columns[i].DbType, clr);
            if (kind != columns[i].Kind)
                columns[i] = columns[i] with { Kind = kind, Size = kind is ColumnKinds.String or ColumnKinds.Binary ? columns[i].Size : null };
        }
        return columns;
    }

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column) =>
        PgTypes.ReadValue((NpgsqlDataReader)reader, ordinal, column, Warn);

    private void Warn(string message)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        if (!ctx.Items.TryGetValue(WarningsKey, out var w) || w is not HashSet<string> set)
            ctx.Items[WarningsKey] = set = new HashSet<string>(StringComparer.Ordinal);
        set.Add(message);
    }

    /// <summary>A batch that is a single query cannot produce more result sets: cancel it to stop the server quickly.</summary>
    protected override ValueTask<bool> OnResultSetTruncatedAsync(DbDataReader reader, BatchContext context)
    {
        var s = ClassificationOf(context).Statements;
        var single = s.Count == 1 && s[0].Category == StatementCategory.Query;
        if (single) context.Items[StoppedKey] = true;
        return ValueTask.FromResult(!single);
    }

    /// <summary>Per statement from the batch commands (INSERT/UPDATE/DELETE/MERGE/COPY, CREATE TABLE AS / SELECT INTO).</summary>
    protected override async ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected)
    {
        if (!context.Items.TryGetValue(SentKey, out var s) || s is not SentBatch sent) return;
        foreach (var st in sent.Statements)
        {
            if (st.Command is null) continue;
            var kind = st.Command.StatementType switch
            {
                Npgsql.StatementType.Insert => "INSERT",
                Npgsql.StatementType.Update => "UPDATE",
                Npgsql.StatementType.Delete => "DELETE",
                Npgsql.StatementType.Merge => "MERGE",
                Npgsql.StatementType.Copy => "COPY",
                Npgsql.StatementType.CreateTableAs => "SELECT INTO",
                _ => null,
            };
            if (kind is null) continue;
            await EmitRowsAffectedAsync((long)st.Command.Rows, kind).ConfigureAwait(false);
        }
    }

    protected override async ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        var batch = _currentBatch;
        _currentBatch = null;
        if (batch is not null) await batch.DisposeAsync().ConfigureAwait(false);

        if (context.Items.TryGetValue(WarningsKey, out var w) && w is HashSet<string> warnings)
            foreach (var text in warnings) await EmitMessageAsync(MessageSeverity.Warning, text, null, null, MessageSource.Engine).ConfigureAwait(false);

        if (_conn.State != ConnectionState.Open) return;

        if (context.Items.ContainsKey(SavepointKey) && Transaction is not null)
        {
            var ok = context.Status == BatchStatus.Ok && !context.Items.ContainsKey(StoppedKey);
            if (ok)
            {
                try
                {
                    await ExecAsync("RELEASE SAVEPOINT " + StatementSavepoint).ConfigureAwait(false);
                }
                catch (PostgresException)
                {
                    await RollbackToStatementSavepointAsync().ConfigureAwait(false);
                }
            }
            else
            {
                await RollbackToStatementSavepointAsync().ConfigureAwait(false);
                if (context.Status != BatchStatus.Ok && !context.BeganTransaction)
                    await EmitMessageAsync(MessageSeverity.Info, SavepointRolledBackMessage, null, null, MessageSource.Engine).ConfigureAwait(false);
            }
        }
        else if (Transaction is not null && EndsTransaction(context.Batch.Sql))
        {
            // The user's COMMIT/ROLLBACK/END ended the engine transaction: forget it so the next write begins a new one.
            var tx = Transaction;
            Transaction = null;
            try { await tx.DisposeAsync().ConfigureAwait(false); } catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException) { }
        }
    }

    private async Task RollbackToStatementSavepointAsync()
    {
        await ExecAsync("ROLLBACK TO SAVEPOINT " + StatementSavepoint).ConfigureAwait(false);
        await ExecAsync("RELEASE SAVEPOINT " + StatementSavepoint).ConfigureAwait(false);
    }

    private async Task ExecAsync(string sql)
    {
        await using var cmd = CreateCommand(sql);
        await cmd.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
    }

    /// <summary>True when a top-level statement of the batch ends the transaction (COMMIT, END, ROLLBACK, ABORT; not ROLLBACK TO / PREPARED).</summary>
    internal static bool EndsTransaction(string sql)
    {
        foreach (var st in PgSqlText.Split(sql))
        {
            var t = st.Tokens;
            if (t.Count == 0 || t[0].Kind != SqlTokenKind.Word) continue;
            var head = t[0].Upper;
            if (head is not ("COMMIT" or "END" or "ROLLBACK" or "ABORT")) continue;
            if (t.Any(x => x.IsWord("PREPARED") || x.IsWord("TO"))) continue;
            return true;
        }
        return false;
    }

    /// <summary>
    /// Whether a transaction block is open on the server (a user-typed BEGIN in auto mode, or a COMMIT inside the batch).
    /// Only batches with transaction control, CALL or DO can change it, so other batches keep the known state. The check
    /// reads <c>transaction_timestamp()</c> twice: outside a block every statement is its own transaction (the values
    /// differ), inside one they are equal. (With the extended protocol <c>statement_timestamp()</c> is refreshed per
    /// message, so it cannot be compared with the transaction start.) An aborted block (25P02) is open as well.
    /// </summary>
    protected override async ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct)
    {
        if (_conn.State != ConnectionState.Open) return null;
        var statements = ClassificationOf(context).Statements;
        if (!statements.Any(s => s.Category is StatementCategory.Transaction or StatementCategory.Block || s.Kind is "CALL" or "EXEC"))
            return null;
        try
        {
            var first = await TransactionStartAsync(ct).ConfigureAwait(false);
            var second = await TransactionStartAsync(ct).ConfigureAwait(false);
            return first is not null && first == second;
        }
        catch (PostgresException pg) when (pg.SqlState == "25P02")
        {
            return true;
        }
    }

    private async Task<DateTime?> TransactionStartAsync(CancellationToken ct)
    {
        await using var cmd = CreateCommand("SELECT transaction_timestamp()");
        return await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false) is DateTime dt ? dt : null;
    }


    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception)
        || exception is PostgresException { SqlState: "57014" }
        || exception.InnerException is PostgresException { SqlState: "57014" } or OperationCanceledException;

    protected override void CancelCommand(DbCommand command)
    {
        var batch = _currentBatch;
        if (batch is not null)
        {
            try { batch.Cancel(); } catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException or ObjectDisposedException) { }
            return;
        }
        command.Cancel();
    }

    protected override bool IsConnectionBroken(Exception? exception) =>
        base.IsConnectionBroken(exception)
        || exception is PostgresException pg && PgErrors.IsConnectionLossState(pg.SqlState);

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        var pg = exception as PostgresException ?? exception.InnerException as PostgresException;
        if (pg is not null)
        {
            var sent = CurrentBatch?.Items.TryGetValue(SentKey, out var s) == true ? s as SentBatch : null;
            return PgErrors.FromException(pg, batch, pos => MapServerPosition(sent, pg.BatchCommand, batch.Sql, pos));
        }
        if (exception is NpgsqlException npg)
            return new ErrorInfo(ErrorCodes.ProviderError, npg.Message, FirstCodeLine(batch, Dialect.PgSql), Detail: npg.InnerException?.Message);
        return base.MapException(exception, batch);
    }

    /// <summary>
    /// Server position (1-based, in the text of the failing batch command) → 0-based offset in the user's batch text:
    /// statement-local renumbering → statement in the rewritten batch text → original text (placeholder rewrite).
    /// </summary>
    internal static int? MapServerPosition(SentBatch? sent, NpgsqlBatchCommand? failing, string original, int position)
    {
        if (sent is null || sent.Statements.Count == 0) return null;
        var st = failing is null ? null : sent.Statements.FirstOrDefault(x => ReferenceEquals(x.Command, failing));
        if (st is null)
        {
            if (sent.Statements.Count != 1) return null;
            st = sent.Statements[0];
        }
        var inStatement = PgSqlText.MapPosition(st.SentText, st.Text, position);
        var inBatch = st.Start + inStatement;
        return PgSqlText.MapPosition(sent.Text, original, inBatch + 1);
    }

    protected override Task ChangeDatabaseCoreAsync(string database, CancellationToken ct) =>
        throw new NotSupportedException("PostgreSQL connections are bound to one database; the session is reopened on the new database.");

    protected override ValueTask DisposeCoreAsync()
    {
        _conn.Notice -= OnNotice;
        return ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------------ driver events

    private void OnNotice(object sender, NpgsqlNoticeEventArgs e)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return; // e.g. notices of the savepoint/transaction-state commands outside a batch
        var n = e.Notice;
        int? line = null;
        if (n.Position > 0 && ctx.Items.TryGetValue(SentKey, out var s) && s is SentBatch sent && sent.Statements.Count == 1
            && MapServerPosition(sent, null, ctx.Batch.Sql, n.Position) is int offset)
        {
            var (l, _) = PgSqlText.LineColAt(ctx.Batch.Sql, offset);
            line = ToDocumentLine(ctx.Batch, l);
        }
        EmitMessage(PgErrors.NoticeSeverity(n), PgErrors.NoticeText(n), line, null, MessageSource.Server);
    }
}
