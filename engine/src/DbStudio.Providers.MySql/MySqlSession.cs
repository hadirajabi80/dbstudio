using System.Data;
using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.MySql.Params;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// One MySQL / MariaDB editor-tab session (plan-batch3 WP-MY): a dedicated MySqlConnector connection with pooling off.
/// <list type="bullet">
/// <item>Each batch is split into its statements (<see cref="MySqlSqlText.Split"/>: DELIMITER lines, stored-program bodies
/// kept whole) and sent as one command, or as a <see cref="MySqlBatch"/> with one command per statement, so every result
/// set arrives in order and rows affected are reported per statement.</item>
/// <item>Warnings and notes (SHOW WARNINGS after each statement) arrive as server messages.</item>
/// <item>Errors carry the server error number; the line/column comes from "near '…' at line N" or the offending name.</item>
/// <item>DDL commits implicitly in MySQL: a DDL statement never begins the engine transaction, and an open one is reported
/// as committed. A user-typed START TRANSACTION / COMMIT is tracked (MariaDB: <c>@@in_transaction</c>).</item>
/// <item>Cancel sends <c>KILL QUERY</c> on a side connection (MySqlConnector).</item>
/// </list>
/// </summary>
public sealed class MySqlSession : AdoSessionBase
{
    public const string ImplicitCommitMessage =
        "MySQL committed the open transaction implicitly before this DDL statement (DDL is not transactional); a new transaction begins with the next change.";

    private const string SentKey = "my.sent";
    private const string ClassificationKey = "my.classification";
    private const string StoppedKey = "my.stopped";
    private const string WarningsKey = "my.warnings";
    private const string ReaderKey = "my.reader";
    private const string IndexKey = "my.index";

    private readonly MySqlConnection _conn;
    private volatile MySqlCommand? _running;

    public MySqlSession(MySqlConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server, MySqlFlavor flavor, long connectionId)
        : base(connection, profile, options, Dialect.MySql, server)
    {
        _conn = connection;
        Flavor = flavor;
        ServerConnectionId = connectionId;
        CurrentDatabase = string.IsNullOrEmpty(server.Database) ? null : server.Database;
    }

    public MySqlFlavor Flavor { get; }

    /// <summary>CONNECTION_ID() of the session (activity view, KILL).</summary>
    public long ServerConnectionId { get; }

    /// <summary>One statement as sent: its offset in the user's batch text, the original statement and the text sent.</summary>
    internal sealed record SentStatement(int Start, string Text, string SentText, StatementClassification? Class);

    internal sealed record SentBatch(IReadOnlyList<SentStatement> Statements);

    // ------------------------------------------------------------------ hooks

    protected override IParamBinder? ParamBinder => MySqlParamBinder.Instance;

    protected override string PingSql => "SELECT 1";

    private static BatchClassification ClassificationOf(BatchContext ctx)
    {
        if (ctx.Items.TryGetValue(ClassificationKey, out var c) && c is BatchClassification cached) return cached;
        var cls = MySqlSqlText.Classify(ctx.Batch.Sql);
        ctx.Items[ClassificationKey] = cls;
        return cls;
    }

    /// <summary>
    /// Manual mode: a write or a SAVEPOINT begins the engine transaction; queries, session/transaction statements and DDL
    /// do not (DDL commits implicitly in MySQL, so a transaction begun for it would end at once).
    /// </summary>
    protected override bool RequiresTransaction(BatchContext context)
    {
        var c = ClassificationOf(context);
        if (c.HasSavepoint) return true;
        if (c.IsQueryOnly) return false;
        return !c.Statements.All(s => s.Category == StatementCategory.Ddl || IsImplicitCommit(s));
    }

    protected override string? ClassifyAffected(BatchContext context)
    {
        var c = ClassificationOf(context);
        return c.HasDml ? c.PrimaryKind : null;
    }

    protected override ErrorInfo? ValidateBatch(SqlBatch batch, BatchContext context)
    {
        foreach (var st in MySqlSqlText.Split(batch.Sql))
        {
            var t = st.Tokens;
            if (t.Count > 2 && t[0].IsWord("LOAD") && t.Take(5).Any(x => x.IsWord("LOCAL")))
            {
                var (line, col) = MySqlSqlText.LineColAt(batch.Sql, st.Start);
                return new ErrorInfo(ErrorCodes.NotSupported,
                    "LOAD DATA LOCAL INFILE reads a file on the client, which the console does not allow. Use LOAD DATA INFILE with a server-side file, or the import feature.",
                    ToDocumentLine(batch, line), ToDocumentCol(batch, line, col));
            }
        }
        return null;
    }

    protected override async Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct)
    {
        var cmd = (MySqlCommand)command;
        var sentText = cmd.CommandText;
        var original = MySqlSqlText.Split(context.Batch.Sql);
        var sent = MySqlSqlText.Split(sentText);
        var classification = ClassificationOf(context);

        await SetOutputVariablesAsync(context, ct).ConfigureAwait(false);

        if (sent.Count == 0)
        {
            // Only comments / DELIMITER lines: nothing to run (the server would answer "Query was empty").
            cmd.CommandText = "DO 0";
            context.Items[SentKey] = new SentBatch([new SentStatement(0, context.Batch.Sql, "DO 0", null)]);
            return await cmd.ExecuteReaderAsync(CommandBehavior.Default, ct).ConfigureAwait(false);
        }

        StatementClassification? ClassAt(int i) => i < classification.Statements.Count ? classification.Statements[i] : null;
        var list = new List<SentStatement>(sent.Count);
        for (var i = 0; i < sent.Count; i++)
        {
            var (start, text) = i < original.Count && original.Count == sent.Count
                ? (original[i].Start, original[i].Text(context.Batch.Sql))
                : (sent[i].Start, sent[i].Text(sentText));
            list.Add(new SentStatement(start, text, sent[i].Text(sentText), ClassAt(i)));
        }
        context.Items[SentKey] = new SentBatch(list);

        // One command per statement on the session connection, run in order by the statement reader.
        Task<MySqlDataReader> Execute(int index, CancellationToken token)
        {
            context.Items[IndexKey] = index;
            MySqlCommand c;
            if (index == 0)
            {
                c = cmd;
            }
            else
            {
                c = (MySqlCommand)CreateCommand(list[index].SentText);
                foreach (MySqlParameter p in cmd.Parameters) c.Parameters.Add(p.Clone());
            }
            c.CommandText = list[index].SentText;
            _running = c;
            return c.ExecuteReaderAsync(CommandBehavior.Default, token);
        }
        var reader = await MySqlStatementReader.OpenAsync(list.Count, Execute, index => ReadWarningsAsync(list[index]), ct).ConfigureAwait(false);
        context.Items[ReaderKey] = reader;
        return reader;
    }

    /// <summary>SHOW WARNINGS after each statement: Note → info, Warning → warning, Error → error message.</summary>
    private async Task ReadWarningsAsync(SentStatement statement)
    {

        // The driver does not surface warning counts (and misses SELECT warnings): always ask, like MySQL Workbench.
        // Side effect: ROW_COUNT() / FOUND_ROWS() in a later batch describe SHOW WARNINGS, not the user's statement.
        if (statement.Class is { Kind: "SHOW" or "DESCRIBE" or "HELP" }) return;
        var messages = new List<(MessageSeverity Severity, string Text, int? Code)>();
        await using (var w = CreateCommand("SHOW WARNINGS"))
        await using (var r = await w.ExecuteReaderAsync(CancellationToken.None).ConfigureAwait(false))
        {
            while (await r.ReadAsync(CancellationToken.None).ConfigureAwait(false))
            {
                var level = r.IsDBNull(0) ? "" : r.GetString(0);
                int? code = r.IsDBNull(1) ? null : Convert.ToInt32(r.GetValue(1), System.Globalization.CultureInfo.InvariantCulture);
                var text = r.IsDBNull(2) ? "" : r.GetString(2);
                var severity = level.ToUpperInvariant() switch { "ERROR" => MessageSeverity.Error, "NOTE" => MessageSeverity.Info, _ => MessageSeverity.Warning };
                messages.Add((severity, text, code));
            }
        }
        foreach (var (severity, text, code) in messages)
            await EmitMessageAsync(severity, text, null, code, MessageSource.Server).ConfigureAwait(false);
    }

    /// <summary>Out / inout parameters are user variables: set them before the statement runs.</summary>
    private async Task SetOutputVariablesAsync(BatchContext context, CancellationToken ct)
    {
        var outputs = MySqlParamBinder.OutputVariables(context.Parameters);
        if (outputs.Count == 0) return;
        await using var set = (MySqlCommand)CreateCommand(string.Join(", ", outputs.Select((o, i) => $"{o.Parameter.ParameterName} = @__in{i}")).Insert(0, "SET "));
        for (var i = 0; i < outputs.Count; i++)
        {
            var (param, parameter) = outputs[i];
            var value = param.EffectiveDirection == ParamDirections.InOut ? parameter.Value : DBNull.Value;
            set.Parameters.Add(new MySqlParameter("@__in" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), value ?? DBNull.Value)
            {
                MySqlDbType = param.EffectiveDirection == ParamDirections.InOut ? parameter.MySqlDbType : MySqlDbType.VarChar,
            });
        }
        await set.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Reads the out / inout user variables back after the statement.</summary>
    protected override async ValueTask OnParametersAvailableAsync(BatchContext context, CancellationToken ct)
    {
        var outputs = MySqlParamBinder.OutputVariables(context.Parameters);
        if (outputs.Count == 0) return;
        await using var get = CreateCommand("SELECT " + string.Join(", ", outputs.Select(o => o.Parameter.ParameterName)));
        await using var r = await get.ExecuteReaderAsync(ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false)) return;
        for (var i = 0; i < outputs.Count; i++)
        {
            object? v;
            try { v = r.IsDBNull(i) ? DBNull.Value : r.GetValue(i); }
            catch (Exception ex) when (ex is InvalidCastException or OverflowException or FormatException) { v = r.GetString(i); }
            outputs[i].Parameter.Value = v is byte[] bytes ? System.Text.Encoding.UTF8.GetString(bytes) : v;
        }
    }

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        var columns = base.DescribeColumns(reader, context);
        for (var i = 0; i < columns.Length; i++)
        {
            Type? clr;
            try { clr = reader.GetFieldType(i); } catch { clr = null; }
            var kind = MySqlTypes.KindFor(columns[i].DbType, clr);
            if (kind != columns[i].Kind)
                columns[i] = columns[i] with { Kind = kind, Size = kind is ColumnKinds.String or ColumnKinds.Binary ? columns[i].Size : null };
        }
        return columns;
    }

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column) =>
        MySqlTypes.ReadValue(reader, ordinal, column, Warn);

    private void Warn(string message)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        if (!ctx.Items.TryGetValue(WarningsKey, out var w) || w is not HashSet<string> set)
            ctx.Items[WarningsKey] = set = new HashSet<string>(StringComparer.Ordinal);
        set.Add(message);
    }

    /// <summary>A batch that is a single query cannot produce more result sets: stop the server (KILL QUERY) instead of draining.</summary>
    protected override ValueTask<bool> OnResultSetTruncatedAsync(DbDataReader reader, BatchContext context)
    {
        var s = ClassificationOf(context).Statements;
        var single = s.Count == 1 && s[0].Category == StatementCategory.Query;
        if (single) context.Items[StoppedKey] = true;
        return ValueTask.FromResult(!single);
    }

    protected override async ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected)
    {
        if (context.Items.TryGetValue(SentKey, out var s) && s is SentBatch sent
            && context.Items.TryGetValue(ReaderKey, out var r) && r is MySqlStatementReader reader)
        {
            for (var i = 0; i < sent.Statements.Count && i < reader.Affected.Length; i++)
            {
                var st = sent.Statements[i];
                if (st.Class is not { } c || reader.Affected[i] < 0) continue;
                if (c.Category == StatementCategory.Dml) await EmitRowsAffectedAsync(reader.Affected[i], c.Kind).ConfigureAwait(false);
                else if (c is { Category: StatementCategory.Other, Kind: "CALL" } && reader.Affected[i] > 0) await EmitRowsAffectedAsync(reader.Affected[i], null).ConfigureAwait(false);
            }
            return;
        }
        await base.ReportRowsAffectedAsync(context, recordsAffected).ConfigureAwait(false);
    }

    protected override async ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        _running = null;

        // KILL QUERY makes a statement that only sleeps (SELECT SLEEP(60)) return 1 instead of failing: a read-only batch
        // that "completed" after the cancel was cut short by it, so report it cancelled (nothing was changed either way).
        if (context.CompletedDespiteCancel && context.Status == BatchStatus.Ok && ClassificationOf(context).IsQueryOnly)
        {
            context.CompletedDespiteCancel = false;
            context.Status = BatchStatus.Cancelled;
            await EmitMessageAsync(MessageSeverity.Warning, "Query was cancelled.", null, null, MessageSource.Engine).ConfigureAwait(false);
        }

        if (context.Items.TryGetValue(WarningsKey, out var w) && w is HashSet<string> warnings)
            foreach (var text in warnings) await EmitMessageAsync(MessageSeverity.Warning, text, null, null, MessageSource.Engine).ConfigureAwait(false);

        if (_conn.State != ConnectionState.Open) return;
        var statements = ClassificationOf(context).Statements;

        // The user's COMMIT / ROLLBACK, or a DDL statement's implicit commit, ended the engine transaction.
        if (Transaction is not null && context.Status != BatchStatus.Cancelled)
        {
            var ended = EndsTransaction(statements, out var implicitCommit);
            if (ended)
            {
                var tx = Transaction;
                Transaction = null;
                try { await tx.DisposeAsync().ConfigureAwait(false); } catch (Exception ex) when (ex is MySqlException or InvalidOperationException) { }
                if (implicitCommit && context.Status == BatchStatus.Ok)
                    await EmitMessageAsync(MessageSeverity.Warning, ImplicitCommitMessage, null, null, MessageSource.Engine).ConfigureAwait(false);
            }
        }

        // USE / DROP DATABASE / CALL may change DATABASE().
        if (statements.Any(s => s.Kind is "USE" or "CALL" || s.Ddl?.ObjectType is "database" or "schema"))
        {
            try
            {
                await using var cmd = CreateCommand("SELECT DATABASE()");
                var db = await cmd.ExecuteScalarAsync(CancellationToken.None).ConfigureAwait(false);
                CurrentDatabase = db is string s ? s : null;
            }
            catch (MySqlException) { /* keep the last known one */ }
        }
    }

    /// <summary>Statements after which no transaction is open (implicit commit: DDL, LOCK TABLES, SET autocommit = 1 …).</summary>
    private static bool IsImplicitCommit(StatementClassification s) =>
        s.Category == StatementCategory.Ddl || s.Kind is "LOCK TABLES" or "UNLOCK TABLES";

    /// <summary>True when the batch ends the transaction: a COMMIT / ROLLBACK (not ROLLBACK TO SAVEPOINT) or an implicit commit.</summary>
    internal static bool EndsTransaction(IReadOnlyList<StatementClassification> statements, out bool implicitCommit)
    {
        implicitCommit = false;
        var ended = false;
        foreach (var s in statements)
        {
            if (s.Category == StatementCategory.Transaction && s.Kind is "COMMIT" or "ROLLBACK") { ended = true; implicitCommit = false; }
            else if (s.Category == StatementCategory.Transaction && s.Kind is "BEGIN") { ended = true; implicitCommit = true; }
            else if (IsImplicitCommit(s)) { ended = true; implicitCommit = true; }
        }
        return ended;
    }

    /// <summary>
    /// Whether a transaction is open on the server after the batch. MariaDB answers <c>@@in_transaction</c>; MySQL has no
    /// unprivileged equivalent, so the transaction-control statements of the batch decide (START TRANSACTION / BEGIN open
    /// one; COMMIT, ROLLBACK and implicitly committing statements end it). Batches without such statements keep the state.
    /// </summary>
    protected override async ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct)
    {
        if (_conn.State != ConnectionState.Open) return null;
        var statements = ClassificationOf(context).Statements;
        var relevant = statements.Any(s => s.Category == StatementCategory.Transaction || IsImplicitCommit(s) || s.Kind is "CALL" or "SET");
        if (!relevant) return null;
        if (Flavor.IsMariaDb)
        {
            await using var cmd = CreateCommand("SELECT @@in_transaction");
            var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
            return v is not null and not DBNull && Convert.ToInt64(v, System.Globalization.CultureInfo.InvariantCulture) != 0;
        }
        bool? open = null;
        foreach (var s in statements)
        {
            if (s.Category == StatementCategory.Transaction)
            {
                if (s.Kind == "BEGIN") open = true;
                else if (s.Kind is "COMMIT" or "ROLLBACK") open = false;
            }
            else if (IsImplicitCommit(s)) open = false;
        }
        if (context.Status != BatchStatus.Ok && open == true) return null;
        return open;
    }

    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception) || MySqlErrors.IsInterrupted(exception) || exception.InnerException is OperationCanceledException;

    /// <summary>KILL QUERY (MySqlConnector, side connection) for the statement running now.</summary>
    protected override void CancelCommand(DbCommand command)
    {
        var running = _running ?? command as MySqlCommand;
        try { (running ?? command).Cancel(); } catch (Exception ex) when (ex is MySqlException or InvalidOperationException or ObjectDisposedException) { }
    }

    protected override bool IsConnectionBroken(Exception? exception) =>
        base.IsConnectionBroken(exception) || MySqlErrors.IsConnectionFailure(exception);

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        var my = exception as MySqlException ?? exception.InnerException as MySqlException;
        if (my is not null)
        {
            var items = CurrentBatch?.Items;
            var sent = items?.TryGetValue(SentKey, out var s) == true ? s as SentBatch : null;
            var index = items?.TryGetValue(IndexKey, out var ix) == true && ix is int i ? i : 0;
            var st = sent is not null && index < sent.Statements.Count ? sent.Statements[index] : null;
            return st is null
                ? MySqlErrors.FromException(my, batch, 0, batch.Sql)
                : MySqlErrors.FromException(my, batch, st.Start, st.Text);
        }
        return base.MapException(exception, batch);
    }

    protected override async Task ChangeDatabaseCoreAsync(string database, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(database);
        await using var cmd = CreateCommand("USE " + MySqlSqlText.Quote(database.Trim()));
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        CurrentDatabase = database.Trim();
    }

}
