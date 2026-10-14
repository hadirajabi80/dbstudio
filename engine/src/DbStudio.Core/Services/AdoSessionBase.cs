using System.Data;
using System.Data.Common;
using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Services;

/// <summary>
/// Per-batch state handed to <see cref="AdoSessionBase"/> hooks. One instance per batch of an execution.
/// </summary>
public sealed class BatchContext
{
    private BatchClassification? _classification;

    internal BatchContext(int index, SqlBatch batch, ExecuteRequest request, IExecutionSink sink, Dialect dialect, CancellationToken ct)
    {
        Index = index;
        Batch = batch;
        Request = request;
        Sink = sink;
        Dialect = dialect;
        CancellationToken = ct;
    }

    /// <summary>0-based index of the batch within <see cref="ExecuteRequest.Batches"/>.</summary>
    public int Index { get; }
    public SqlBatch Batch { get; }
    public ExecuteRequest Request { get; }
    /// <summary>The (counting) sink of this execution. Prefer the <c>Emit*</c> helpers of <see cref="AdoSessionBase"/>.</summary>
    public IExecutionSink Sink { get; }
    public Dialect Dialect { get; }
    /// <summary>Cancelled when the user cancels the execution or the caller's token fires.</summary>
    public CancellationToken CancellationToken { get; }

    /// <summary>The command executing this batch (null before it is created / for batches rejected by ValidateBatch).</summary>
    public DbCommand? Command { get; internal set; }

    /// <summary>Exception raised by the batch, if any (already reported through sink.Error unless cancelled).</summary>
    public Exception? Exception { get; internal set; }

    /// <summary>Outcome so far. Hooks running after execution (<see cref="AdoSessionBase.OnBatchCompletedAsync"/>) may set
    /// it to <see cref="BatchStatus.Error"/>, e.g. Oracle "success with compilation error".</summary>
    public BatchStatus Status { get; set; } = BatchStatus.Ok;

    /// <summary>Result sets produced by this batch.</summary>
    public int ResultSetCount { get; internal set; }

    /// <summary><c>DbDataReader.RecordsAffected</c> after the reader closed; -1 when unknown/not applicable.</summary>
    public long RecordsAffected { get; internal set; } = -1;

    /// <summary>Statement classification of the batch text (lazy, dialect aware).</summary>
    public BatchClassification Classification => _classification ??= StatementClassifier.Classify(Batch.Sql, Dialect);

    /// <summary>Free-form per-batch state for provider hooks.</summary>
    public IDictionary<string, object?> Items { get; } = new Dictionary<string, object?>();

    /// <summary>M1.5: parameters bound to <see cref="Command"/> (empty when the request has no params).</summary>
    public BoundParameters Parameters { get; internal set; } = BoundParameters.None;

    /// <summary>Set by the base class when an error was raised by a cancellation the engine itself triggered (row cap).</summary>
    internal bool SuppressErrors { get; set; }
}

/// <summary>
/// Common <see cref="IDbSession"/> implementation over one ADO.NET <see cref="DbConnection"/> (docs/PLAN.md 2.3, 2.4).
/// It owns the execution loop: Idle/Executing state machine with busy check, manual/auto transactions, one
/// <c>ExecuteReader</c> per batch, result sets with MaxRows truncation, rows batched to the sink (every
/// <see cref="RowBatchSize"/> rows / <see cref="RowFlushInterval"/> / <see cref="RowBatchMaxBytes"/>), rows affected,
/// errors with document-absolute lines, StopOnError, cancellation and timing.
/// <para>
/// Providers subclass it and override the protected virtual hooks. Order of hook calls for each batch:
/// <see cref="ValidateBatch"/> → (manual mode) <see cref="BeginTransactionAsync"/> → <see cref="ConfigureCommand"/> →
/// <see cref="ExecuteReaderAsync"/> → per result set <see cref="DescribeColumns"/> / <see cref="ReadValue"/> /
/// <see cref="OnResultSetTruncatedAsync"/> → <see cref="ReportRowsAffectedAsync"/> (uses <see cref="ClassifyAffected"/>) →
/// on failure <see cref="MapException"/> → always <see cref="OnBatchCompletedAsync"/> → (auto mode, success)
/// <see cref="CommitAfterBatchAsync"/> when <see cref="AutoCommitAfterBatch"/>.
/// Once per execution: <see cref="OnExecutionStartingAsync"/> before the first batch and
/// <see cref="OnExecutionCompletedAsync"/> after the last one.
/// </para>
/// <para>
/// Server messages (SQL Server InfoMessage, Oracle DBMS_OUTPUT) are forwarded with <see cref="EmitMessageAsync"/> /
/// <see cref="EmitMessage"/>, which flush pending rows first so ordering is preserved. They target the batch currently
/// executing (<see cref="CurrentBatch"/>). The execution runs on a thread-pool thread (Task.Run), so synchronous
/// drivers (Microsoft.Data.Sqlite) never block the caller.
/// </para>
/// </summary>
public abstract class AdoSessionBase : IDbSession
{
    private const int StateIdle = (int)SessionState.Idle;
    private const int StateExecuting = (int)SessionState.Executing;
    private const int StateBroken = (int)SessionState.Broken;
    private const int StateClosed = (int)SessionState.Closed;

    private int _state = StateIdle;
    private volatile bool _cancelRequested;
    private volatile DbCommand? _currentCommand;
    private CancellationTokenSource? _executionCts;
    private readonly object _cancelLock = new();
    private Task? _runningExecution;
    private RowBuffer? _rowBuffer;
    private ParamBindCursor _bindCursor = new();
    private List<OutParamValue>? _outParams;

    /// <param name="connection">An already opened connection; the session owns and disposes it.</param>
    /// <param name="profile">The connection profile (for timeouts and provider props).</param>
    /// <param name="options">Session id, initial database, tx mode, server-output capture.</param>
    /// <param name="dialect">SQL dialect of the provider.</param>
    /// <param name="server">Server information collected by the provider when opening.</param>
    protected AdoSessionBase(DbConnection connection, ConnectionProfile profile, SessionOptions options, Dialect dialect, ServerInfo server)
    {
        Connection = connection ?? throw new ArgumentNullException(nameof(connection));
        Profile = profile;
        Options = options;
        Dialect = dialect;
        Server = server;
        SessionId = options.SessionId;
        ConnectionId = profile.Id;
        TxMode = options.TxMode;
        CurrentDatabase = server.Database ?? options.Database;
        CommandTimeoutSeconds = Math.Max(0, profile.GetInt("commandTimeout", 0));
    }

    // ------------------------------------------------------------------ IDbSession

    public string SessionId { get; }
    public string ConnectionId { get; }
    public Dialect Dialect { get; }
    public SessionState State => (SessionState)Volatile.Read(ref _state);
    public TransactionMode TxMode { get; private set; }
    /// <summary>True when an engine-owned transaction (<see cref="Transaction"/>) or a server-side transaction
    /// (<see cref="ServerTxOpen"/>, e.g. a user-typed BEGIN TRAN in auto mode) is open.</summary>
    public virtual bool TxOpen => Transaction is not null || ServerTxOpen;
    public string? CurrentDatabase { get; protected set; }
    public ServerInfo Server { get; protected set; }

    // ------------------------------------------------------------------ provider-facing state

    protected DbConnection Connection { get; }
    protected ConnectionProfile Profile { get; }
    protected SessionOptions Options { get; }

    /// <summary>Open local transaction (manual mode), else null. Every command created by the base gets it assigned.</summary>
    protected DbTransaction? Transaction { get; set; }

    /// <summary>
    /// A transaction open on the server that the engine did not start through <see cref="BeginTransactionAsync"/>
    /// (SQL Server: user-typed BEGIN TRAN, <c>@@TRANCOUNT &gt; 0</c>). Maintained from
    /// <see cref="QueryServerTransactionOpenAsync"/> after every batch; providers may also set it directly.
    /// <see cref="CommitAsync"/>/<see cref="RollbackAsync"/> end it via <see cref="CommitServerTransactionAsync"/> /
    /// <see cref="RollbackServerTransactionAsync"/>.
    /// </summary>
    protected bool ServerTxOpen { get; set; }

    /// <summary>CommandTimeout applied to every command (profile prop "commandTimeout", default 0 = infinite).</summary>
    protected int CommandTimeoutSeconds { get; set; }

    /// <summary>Rows per <c>exec.rows</c> frame (default 200).</summary>
    protected virtual int RowBatchSize => 200;

    /// <summary>Maximum time pending rows wait before being flushed (default 50 ms).</summary>
    protected virtual TimeSpan RowFlushInterval => TimeSpan.FromMilliseconds(50);

    /// <summary>Approximate maximum payload of one rows frame (default 256 KB).</summary>
    protected virtual int RowBatchMaxBytes => 256 * 1024;

    /// <summary>Oracle: true to COMMIT after every successful batch in auto mode (the driver has no autocommit DDL/DML distinction).</summary>
    protected virtual bool AutoCommitAfterBatch => false;

    /// <summary>Statement used by <see cref="PingAsync"/> (Oracle: "SELECT 1 FROM dual").</summary>
    protected virtual string PingSql => "SELECT 1";

    /// <summary>The batch currently executing (null outside execution). Use for message routing in driver event handlers.</summary>
    protected BatchContext? CurrentBatch { get; private set; }

    /// <summary>The sink of the current execution (null outside execution).</summary>
    protected IExecutionSink? CurrentSink { get; private set; }

    /// <summary>True once <see cref="Cancel"/> was called for the current execution.</summary>
    protected bool CancelRequested => _cancelRequested;

    // ------------------------------------------------------------------ hooks

    /// <summary>
    /// Pre-flight check of a batch before any command is created. Return an error to reject the batch without executing
    /// it (reported via sink.Error, batch status Error), e.g. Oracle <c>BIND_VARS_UNSUPPORTED</c>. Default: null.
    /// </summary>
    protected virtual ErrorInfo? ValidateBatch(SqlBatch batch, BatchContext context) => null;

    /// <summary>
    /// Customise the command before execution: attach driver events (SqlCommand.StatementCompleted), set BindByName,
    /// fetch sizes, etc. The base already set CommandText, CommandType.Text, Transaction and CommandTimeout.
    /// </summary>
    protected virtual void ConfigureCommand(DbCommand command, BatchContext context) { }

    /// <summary>M1.5: binder for <see cref="ExecuteRequest.Params"/>; null = the provider does not support parameters.</summary>
    protected virtual IParamBinder? ParamBinder => null;

    /// <summary>
    /// M1.5: binds the request's params the batch references (called after <see cref="ConfigureCommand"/>, so the
    /// command text is final). Default: <see cref="ParamBinder"/>.Bind with the execution's positional cursor.
    /// </summary>
    protected virtual void BindParameters(DbCommand command, BatchContext context)
    {
        var parameters = context.Request.Params;
        if (parameters is not { Count: > 0 }) return;
        var binder = ParamBinder ?? throw new EngineException(400, ErrorCodes.NotSupported, "This provider does not support query parameters.");
        context.Parameters = binder.Bind(command, parameters, _bindCursor);
    }

    /// <summary>
    /// M1.5: called after the batch's reader closed (output parameters are populated), before out values are collected.
    /// Oracle streams REF CURSOR out params that the reader did not already return.
    /// </summary>
    protected virtual ValueTask OnParametersAvailableAsync(BatchContext context, CancellationToken ct) => ValueTask.CompletedTask;

    /// <summary>
    /// M1.5: entered for <see cref="RunExclusiveAsync"/> work so driver errors throw instead of being routed as messages
    /// (SQL Server turns off FireInfoMessageEventOnUserErrors). Return null when nothing changes.
    /// </summary>
    protected virtual IDisposable? EnterDirectMode() => null;

    /// <summary>M1.5: statement text used by <see cref="DescribeAsync"/> (default: trailing semicolons removed).</summary>
    protected virtual string PrepareDescribeSql(string sql) => sql.Trim().TrimEnd(';').TrimEnd();

    /// <summary>M1.5: command behavior used by <see cref="DescribeAsync"/>.</summary>
    protected virtual CommandBehavior DescribeBehavior => CommandBehavior.SchemaOnly | CommandBehavior.KeyInfo;

    /// <summary>M1.5: customise the describe command (Oracle: BindByName).</summary>
    protected virtual void ConfigureDescribeCommand(DbCommand command) { }

    /// <summary>Executes the command. Default: <c>command.ExecuteReaderAsync(CommandBehavior.Default, ct)</c>.</summary>
    protected virtual Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct) =>
        command.ExecuteReaderAsync(CommandBehavior.Default, ct);

    /// <summary>
    /// Builds the column descriptors of the current result set. Default uses <c>GetColumnSchema()</c> when available
    /// (nullability, size, precision/scale, base table, key) and falls back to name/type only.
    /// </summary>
    protected virtual ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        System.Collections.ObjectModel.ReadOnlyCollection<DbColumn>? schema = null;
        try
        {
            if (reader.CanGetColumnSchema()) schema = reader.GetColumnSchema();
        }
        catch
        {
            schema = null;
        }

        var columns = new ColumnInfo[reader.FieldCount];
        for (var i = 0; i < columns.Length; i++)
        {
            var dbColumn = schema is not null && i < schema.Count ? schema[i] : null;
            string name;
            try { name = reader.GetName(i); } catch { name = dbColumn?.ColumnName ?? $"column{i + 1}"; }
            string dbType;
            try { dbType = reader.GetDataTypeName(i); } catch { dbType = dbColumn?.DataTypeName ?? ""; }
            Type? clr;
            try { clr = reader.GetFieldType(i); } catch { clr = dbColumn?.DataType; }
            var kind = ValueConverter.KindFor(clr, dbType, Dialect);

            int? size = dbColumn?.ColumnSize is > 0 and < int.MaxValue and var s ? s : null;
            int? precision = null, scale = null;
            if (kind is ColumnKinds.Decimal or ColumnKinds.Float or ColumnKinds.DateTime or ColumnKinds.Time or ColumnKinds.DateTimeOffset)
            {
                if (dbColumn?.NumericPrecision is > 0 and < 255 and var p) precision = p;
                if (dbColumn?.NumericScale is >= 0 and < 255 and var sc && (precision is not null || kind != ColumnKinds.Decimal)) scale = sc;
            }

            columns[i] = new ColumnInfo(
                Name: name,
                Ordinal: i,
                DbType: dbType,
                Kind: kind,
                Nullable: dbColumn?.AllowDBNull ?? true,
                Size: kind is ColumnKinds.String or ColumnKinds.Binary ? size : null,
                Precision: precision,
                Scale: scale,
                Table: string.IsNullOrEmpty(dbColumn?.BaseTableName) ? null : dbColumn.BaseTableName,
                Schema: string.IsNullOrEmpty(dbColumn?.BaseSchemaName) ? null : dbColumn.BaseSchemaName,
                IsKey: dbColumn?.IsKey ?? false);
        }
        return columns;
    }

    /// <summary>Reads one cell as a wire value. Default: null for DBNull, else <see cref="ValueConverter.ToWire"/> of GetValue.
    /// Override for provider types (Oracle REF CURSOR → <see cref="CursorValue"/>, OracleDecimal → string, ...).</summary>
    protected virtual object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column) =>
        reader.IsDBNull(ordinal) ? null : ValueConverter.ToWire(reader.GetValue(ordinal));

    /// <summary>
    /// Called when a result set hit <see cref="ExecuteRequest.MaxRows"/> (the reader is positioned on the first row that
    /// was not sent). Return true to continue with <c>NextResult()</c> (draining the rest, the default); return false to
    /// stop the batch here: the base then cancels the command and swallows the resulting cancellation error. SQL Server
    /// may return false when it knows the truncated set is the last one to stop the server quickly.
    /// </summary>
    protected virtual ValueTask<bool> OnResultSetTruncatedAsync(DbDataReader reader, BatchContext context) => ValueTask.FromResult(true);

    /// <summary>Statement kind for <c>exec.affected</c> ("INSERT", "UPDATE", ...). Default: the first DML statement of the batch, else null.</summary>
    protected virtual string? ClassifyAffected(BatchContext context) =>
        context.Classification.HasDml ? context.Classification.PrimaryKind : null;

    /// <summary>
    /// Reports rows affected after the reader closed. Default: emits <paramref name="recordsAffected"/> when ≥ 0 and the
    /// batch is not pure DDL/query/session/transaction (avoids stale counts some drivers report for DDL).
    /// SQL Server overrides this to a no-op and emits per-statement counts from <c>StatementCompleted</c> via
    /// <see cref="EmitRowsAffectedAsync"/> instead.
    /// </summary>
    protected virtual async ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected)
    {
        if (recordsAffected < 0) return;
        var cls = context.Classification;
        var reportable = cls.HasDml || cls.Statements.Count == 0
                         || cls.Statements.Any(s => s.Category is StatementCategory.Unknown or StatementCategory.Other or StatementCategory.Block);
        if (!reportable) return;
        await EmitRowsAffectedAsync(recordsAffected, ClassifyAffected(context)).ConfigureAwait(false);
    }

    /// <summary>
    /// Called after every batch (success, error or cancel) while the session is still in Executing state and the
    /// connection is free: Oracle pumps DBMS_OUTPUT here and queries ALL_ERRORS after CREATE. May change
    /// <see cref="BatchContext.Status"/>. Exceptions thrown here are reported as engine warnings, not as batch errors.
    /// </summary>
    protected virtual ValueTask OnBatchCompletedAsync(BatchContext context) => ValueTask.CompletedTask;

    /// <summary>Once per execution before the first batch (e.g. DBMS_OUTPUT.ENABLE when CaptureServerOutput).</summary>
    protected virtual ValueTask OnExecutionStartingAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct) => ValueTask.CompletedTask;

    /// <summary>Once per execution after the last batch (also after cancel/error).</summary>
    protected virtual ValueTask OnExecutionCompletedAsync(ExecuteRequest request, ExecutionSummary summary) => ValueTask.CompletedTask;

    /// <summary>
    /// Maps a driver exception to <see cref="ErrorInfo"/>. Line must be absolute to the document: use
    /// <see cref="ToDocumentLine"/> for batch-relative driver lines, or <see cref="FirstCodeLine"/> when the driver has none.
    /// Default: DbException → code SqlState or ErrorCode, line = first code line of the batch.
    /// </summary>
    protected virtual ErrorInfo MapException(Exception exception, SqlBatch batch) => exception switch
    {
        DbException db => new ErrorInfo(
            Code: string.IsNullOrEmpty(db.SqlState) ? db.ErrorCode.ToString(System.Globalization.CultureInfo.InvariantCulture) : db.SqlState,
            Message: db.Message,
            Line: FirstCodeLine(batch, Dialect),
            ProviderCode: db.ErrorCode),
        EngineException ee => new ErrorInfo(ee.Code, ee.Message, FirstCodeLine(batch, Dialect)),
        _ => new ErrorInfo(ErrorCodes.EngineError, exception.Message, FirstCodeLine(batch, Dialect), Detail: exception.GetType().Name),
    };

    /// <summary>True when the exception (or the connection state) means the connection is unusable. Default: connection not Open.</summary>
    protected virtual bool IsConnectionBroken(Exception? exception) =>
        Connection.State is ConnectionState.Closed or ConnectionState.Broken;

    /// <summary>Starts the manual-mode transaction. Default: <c>Connection.BeginTransactionAsync()</c>.</summary>
    protected virtual async Task<DbTransaction> BeginTransactionAsync(CancellationToken ct) =>
        await Connection.BeginTransactionAsync(ct).ConfigureAwait(false);

    /// <summary>Auto mode with <see cref="AutoCommitAfterBatch"/>: commits after a successful batch. Default executes "COMMIT".</summary>
    protected virtual async Task CommitAfterBatchAsync(BatchContext context, CancellationToken ct)
    {
        await using var cmd = CreateCommand("COMMIT");
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Asks the server whether a transaction is open, after every batch (connection free, session still Executing).
    /// Return true/false to set <see cref="ServerTxOpen"/>, or null when unknown (default: null, no query).
    /// When an engine-owned <see cref="Transaction"/> is open the result is still stored but TxOpen is true anyway.
    /// SQL Server: <c>SELECT @@TRANCOUNT</c> &gt; 0 (with the open Transaction assigned to the command).
    /// </summary>
    protected virtual ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct) => ValueTask.FromResult<bool?>(null);

    /// <summary>
    /// Commit for the Commit endpoint, inside the session's exclusive section. Default: commits <see cref="Transaction"/>
    /// when open, else <see cref="CommitServerTransactionAsync"/> when <see cref="ServerTxOpen"/>. Override to customise
    /// (call base or clear <see cref="Transaction"/>/<see cref="ServerTxOpen"/> yourself).
    /// </summary>
    protected virtual async Task CommitCoreAsync(CancellationToken ct)
    {
        var tx = Transaction;
        if (tx is not null)
        {
            await tx.CommitAsync(ct).ConfigureAwait(false);
            await tx.DisposeAsync().ConfigureAwait(false);
            Transaction = null;
            ServerTxOpen = false;
            return;
        }
        if (ServerTxOpen)
        {
            await CommitServerTransactionAsync(ct).ConfigureAwait(false);
            ServerTxOpen = false;
        }
    }

    /// <summary>Rollback counterpart of <see cref="CommitCoreAsync"/>; also used when the session is disposed with an open transaction.</summary>
    protected virtual async Task RollbackCoreAsync(CancellationToken ct)
    {
        var tx = Transaction;
        if (tx is not null)
        {
            try
            {
                await tx.RollbackAsync(ct).ConfigureAwait(false);
            }
            finally
            {
                await tx.DisposeAsync().ConfigureAwait(false);
                Transaction = null;
            }
            ServerTxOpen = false;
            return;
        }
        if (ServerTxOpen)
        {
            await RollbackServerTransactionAsync(ct).ConfigureAwait(false);
            ServerTxOpen = false;
        }
    }

    /// <summary>Ends a server-side transaction (<see cref="ServerTxOpen"/>). Default executes "COMMIT".</summary>
    protected virtual async Task CommitServerTransactionAsync(CancellationToken ct)
    {
        await using var cmd = CreateCommand("COMMIT");
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Rolls back a server-side transaction (<see cref="ServerTxOpen"/>). Default executes "ROLLBACK".</summary>
    protected virtual async Task RollbackServerTransactionAsync(CancellationToken ct)
    {
        await using var cmd = CreateCommand("ROLLBACK");
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Cancels the in-flight command. Default <c>command.Cancel()</c>; SQLite overrides with sqlite3_interrupt.
    /// Called from an arbitrary thread; must not throw.</summary>
    protected virtual void CancelCommand(DbCommand command) => command.Cancel();

    /// <summary>SQL Server USE / Oracle ALTER SESSION SET CURRENT_SCHEMA. Must update <see cref="CurrentDatabase"/>. Default: not supported.</summary>
    protected virtual Task ChangeDatabaseCoreAsync(string database, CancellationToken ct) =>
        throw new NotSupportedException("This provider does not support changing the database of a session.");

    // ------------------------------------------------------------------ helpers for providers

    /// <summary>Creates a command bound to the session's connection and open transaction, with the session timeout.</summary>
    protected DbCommand CreateCommand(string sql)
    {
        var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.CommandTimeout = CommandTimeoutSeconds;
        cmd.Transaction = Transaction;
        return cmd;
    }

    /// <summary>Converts a 1-based line relative to the batch into a document line.</summary>
    protected static int ToDocumentLine(SqlBatch batch, int batchRelativeLine) => batch.Line + Math.Max(1, batchRelativeLine) - 1;

    /// <summary>Converts a 1-based column on a batch-relative line into a document column (only line 1 is shifted by batch.Col).</summary>
    protected static int ToDocumentCol(SqlBatch batch, int batchRelativeLine, int col) => batchRelativeLine <= 1 ? batch.Col + col - 1 : col;

    /// <summary>Document line of the first token of the batch (skipping leading blank lines and comments).</summary>
    protected static int FirstCodeLine(SqlBatch batch, Dialect dialect)
    {
        var tokens = SqlTokenizer.Tokenize(batch.Sql, dialect);
        return tokens.Count == 0 ? batch.Line : ToDocumentLine(batch, tokens[0].Line);
    }

    /// <summary>Forwards a message for the current batch (flushing pending rows first). No-op outside execution.</summary>
    protected async ValueTask EmitMessageAsync(MessageSeverity severity, string text, int? line, int? code, MessageSource source)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        await FlushRowsAsync().ConfigureAwait(false);
        await ctx.Sink.Message(ctx.Index, severity, text, line, code, source).ConfigureAwait(false);
    }

    /// <summary>Synchronous variant of <see cref="EmitMessageAsync"/> for driver event handlers (InfoMessage).</summary>
    protected void EmitMessage(MessageSeverity severity, string text, int? line, int? code, MessageSource source)
    {
        var vt = EmitMessageAsync(severity, text, line, code, source);
        if (!vt.IsCompletedSuccessfully) vt.AsTask().GetAwaiter().GetResult();
    }

    /// <summary>Reports rows affected for the current batch (counted in <see cref="ExecutionSummary.RowsAffected"/>).</summary>
    protected async ValueTask EmitRowsAffectedAsync(long count, string? statementKind)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        await FlushRowsAsync().ConfigureAwait(false);
        await ctx.Sink.RowsAffected(ctx.Index, count, statementKind).ConfigureAwait(false);
    }

    /// <summary>Synchronous variant of <see cref="EmitRowsAffectedAsync"/> for driver event handlers (StatementCompleted).</summary>
    protected void EmitRowsAffected(long count, string? statementKind)
    {
        var vt = EmitRowsAffectedAsync(count, statementKind);
        if (!vt.IsCompletedSuccessfully) vt.AsTask().GetAwaiter().GetResult();
    }

    /// <summary>Reports an error for the current batch without failing the batch (e.g. SQL Server severity ≥ 11 info messages).</summary>
    protected async ValueTask EmitErrorAsync(ErrorInfo error)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        await FlushRowsAsync().ConfigureAwait(false);
        await ctx.Sink.Error(ctx.Index, error).ConfigureAwait(false);
    }

    /// <summary>Synchronous variant of <see cref="EmitErrorAsync"/> for driver event handlers (SqlConnection.InfoMessage).</summary>
    protected void EmitError(ErrorInfo error)
    {
        var vt = EmitErrorAsync(error);
        if (!vt.IsCompletedSuccessfully) vt.AsTask().GetAwaiter().GetResult();
    }

    /// <summary>Reports an error for an explicit batch index (flushing pending rows first); no-op outside execution.</summary>
    protected async ValueTask EmitErrorAsync(int batchIndex, ErrorInfo error)
    {
        var sink = CurrentSink;
        if (sink is null) return;
        await FlushRowsAsync().ConfigureAwait(false);
        await sink.Error(batchIndex, error).ConfigureAwait(false);
    }

    /// <summary>Synchronous variant of <see cref="EmitErrorAsync(int, ErrorInfo)"/> for driver event handlers.</summary>
    protected void EmitError(int batchIndex, ErrorInfo error)
    {
        var vt = EmitErrorAsync(batchIndex, error);
        if (!vt.IsCompletedSuccessfully) vt.AsTask().GetAwaiter().GetResult();
    }

    /// <summary>Forwards diagnostics (1-based document positions) as <c>exec.diagnostics</c> when the sink supports it.</summary>
    protected async ValueTask EmitDiagnosticsAsync(IReadOnlyList<SqlDiagnostic> diagnostics)
    {
        var ctx = CurrentBatch;
        if (ctx is null || diagnostics.Count == 0) return;
        if (ctx.Sink is IExecutionDiagnosticsSink ds) await ds.Diagnostics(ctx.Index, diagnostics).ConfigureAwait(false);
    }

    /// <summary>Marks the session broken (e.g. from a driver event). The session manager reopens it on next use.</summary>
    protected void MarkBroken() => Interlocked.Exchange(ref _state, StateBroken);

    // ------------------------------------------------------------------ transactions / database

    public async Task SetTransactionModeAsync(TransactionMode mode, CancellationToken ct)
    {
        EnterExclusive();
        try
        {
            if (mode == TxMode) return;
            if (mode == TransactionMode.Auto && TxOpen) throw new TxOpenException();
            TxMode = mode;
            await Task.CompletedTask.ConfigureAwait(false);
        }
        finally
        {
            ExitExclusive();
        }
    }

    public async Task CommitAsync(CancellationToken ct)
    {
        EnterExclusive();
        try
        {
            await CommitCoreAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException && IsConnectionBroken(ex))
        {
            Transaction = null;
            ServerTxOpen = false;
            MarkBroken();
            throw;
        }
        finally
        {
            ExitExclusive();
        }
    }

    public async Task RollbackAsync(CancellationToken ct)
    {
        EnterExclusive();
        try
        {
            await RollbackCoreAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException && IsConnectionBroken(ex))
        {
            Transaction = null;
            ServerTxOpen = false;
            MarkBroken();
            throw;
        }
        finally
        {
            ExitExclusive();
        }
    }

    public async Task ChangeDatabaseAsync(string database, CancellationToken ct)
    {
        EnterExclusive();
        try
        {
            await ChangeDatabaseCoreAsync(database, ct).ConfigureAwait(false);
        }
        finally
        {
            ExitExclusive();
        }
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        if (Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle) != StateIdle)
            return State == SessionState.Executing; // busy means alive; broken/closed means not
        try
        {
            await using var cmd = CreateCommand(PingSql);
            await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
            Interlocked.Exchange(ref _state, StateIdle);
            return true;
        }
        catch (Exception ex)
        {
            Interlocked.Exchange(ref _state, IsConnectionBroken(ex) || ex is DbException ? StateBroken : StateIdle);
            return State != SessionState.Broken;
        }
    }

    private void EnterExclusive()
    {
        var prev = Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle);
        switch (prev)
        {
            case StateIdle: return;
            case StateExecuting: throw new SessionBusyException();
            case StateBroken: throw new SessionBrokenException();
            default: throw new ObjectDisposedException(GetType().Name, "The session is closed.");
        }
    }

    private void ExitExclusive()
    {
        // Only return to Idle if nobody marked the session broken meanwhile.
        Interlocked.CompareExchange(ref _state, IsConnectionBroken(null) ? StateBroken : StateIdle, StateExecuting);
    }

    // ------------------------------------------------------------------ cancellation

    public void Cancel()
    {
        lock (_cancelLock)
        {
            if (State != SessionState.Executing || _executionCts is null) return;
            _cancelRequested = true;
            try { _executionCts.Cancel(); } catch (ObjectDisposedException) { } catch (AggregateException) { }
            var cmd = _currentCommand;
            if (cmd is not null)
            {
                try { CancelCommand(cmd); } catch { /* best effort */ }
            }
        }
    }

    // ------------------------------------------------------------------ execution

    public Task<ExecutionSummary> ExecuteAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(sink);
        var prev = Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle);
        if (prev != StateIdle)
        {
            if (prev == StateBroken) throw new SessionBrokenException();
            if (prev == StateClosed) throw new ObjectDisposedException(GetType().Name, "The session is closed.");
            throw new SessionBusyException();
        }

        CancellationTokenSource cts;
        lock (_cancelLock)
        {
            _cancelRequested = false;
            cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _executionCts = cts;
        }

        var task = Task.Run(() => RunExecutionAsync(request, sink, cts), CancellationToken.None);
        _runningExecution = task;
        return task;
    }

    private async Task<ExecutionSummary> RunExecutionAsync(ExecuteRequest request, IExecutionSink userSink, CancellationTokenSource cts)
    {
        var total = Stopwatch.StartNew();
        var sink = new CountingSink(userSink);
        CurrentSink = sink;
        _bindCursor = new ParamBindCursor();
        _outParams = null;
        if (request.Params is { Count: > 0 } requestParams) ParamValues.Validate(requestParams);
        var anyError = false;
        var cancelled = false;
        ExecutionSummary? summary = null;
        try
        {
            await OnExecutionStartingAsync(request, sink, cts.Token).ConfigureAwait(false);

            for (var i = 0; i < request.Batches.Count; i++)
            {
                if (_cancelRequested || cts.IsCancellationRequested) { cancelled = true; break; }
                var ctx = new BatchContext(i, request.Batches[i], request, sink, Dialect, cts.Token);
                CurrentBatch = ctx;
                var status = await RunBatchAsync(ctx, cts).ConfigureAwait(false);
                CurrentBatch = null;
                if (status == BatchStatus.Cancelled) { cancelled = true; break; }
                if (status == BatchStatus.Error)
                {
                    anyError = true;
                    if (request.StopOnError) break;
                }
                if (IsConnectionBroken(null)) break;
            }

            var status2 = cancelled ? ExecutionStatus.Cancelled : anyError ? ExecutionStatus.Error : ExecutionStatus.Ok;
            summary = new ExecutionSummary(status2, total.ElapsedMilliseconds, sink.ResultSets, sink.TotalRowsAffected, _outParams);
            try
            {
                await OnExecutionCompletedAsync(request, summary).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                await sink.Message(Math.Max(0, request.Batches.Count - 1), MessageSeverity.Warning, ex.Message, null, null, MessageSource.Engine).ConfigureAwait(false);
            }
            return summary;
        }
        finally
        {
            CurrentBatch = null;
            CurrentSink = null;
            _rowBuffer = null;
            lock (_cancelLock)
            {
                _executionCts = null;
                _currentCommand = null;
            }
            cts.Dispose();
            var broken = IsConnectionBroken(null);
            if (broken)
            {
                if (Transaction is not null)
                {
                    try { await Transaction.DisposeAsync().ConfigureAwait(false); } catch { /* connection is gone */ }
                    Transaction = null;
                }
                ServerTxOpen = false;
            }
            Interlocked.CompareExchange(ref _state, broken ? StateBroken : StateIdle, StateExecuting);
        }
    }

    private async Task<BatchStatus> RunBatchAsync(BatchContext ctx, CancellationTokenSource cts)
    {
        var sw = Stopwatch.StartNew();
        var sink = ctx.Sink;
        var ct = cts.Token;
        await sink.BatchStarted(ctx.Index).ConfigureAwait(false);

        var rejected = ValidateBatch(ctx.Batch, ctx);
        if (rejected is not null)
        {
            await sink.Error(ctx.Index, rejected).ConfigureAwait(false);
            ctx.Status = BatchStatus.Error;
        }
        else
        {
            await ExecuteBatchCoreAsync(ctx, cts).ConfigureAwait(false);
        }

        // Hooks see a free connection; Transaction may have been ended by a COMMIT/ROLLBACK inside the batch.
        if (Transaction is not null && Transaction.Connection is null) Transaction = null;

        if (!IsConnectionBroken(ctx.Exception))
        {
            try
            {
                await OnBatchCompletedAsync(ctx).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                await sink.Message(ctx.Index, MessageSeverity.Warning, ex.Message, null, null, MessageSource.Engine).ConfigureAwait(false);
            }

            if (ctx.Status == BatchStatus.Ok && TxMode == TransactionMode.Auto && AutoCommitAfterBatch && Transaction is null)
            {
                try
                {
                    await CommitAfterBatchAsync(ctx, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    ctx.Status = BatchStatus.Error;
                    await sink.Error(ctx.Index, MapException(ex, ctx.Batch)).ConfigureAwait(false);
                }
            }

            try
            {
                var serverTx = await QueryServerTransactionOpenAsync(ctx, CancellationToken.None).ConfigureAwait(false);
                if (serverTx is not null) ServerTxOpen = serverTx.Value;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                await sink.Message(ctx.Index, MessageSeverity.Warning, $"Could not determine the transaction state: {ex.Message}", null, null, MessageSource.Engine).ConfigureAwait(false);
            }
        }
        else
        {
            if (ctx.Status != BatchStatus.Cancelled)
                await sink.Message(ctx.Index, MessageSeverity.Error, "The connection to the server was lost.", null, null, MessageSource.Engine).ConfigureAwait(false);
        }

        await sink.BatchEnded(ctx.Index, sw.ElapsedMilliseconds, ctx.Status).ConfigureAwait(false);
        return ctx.Status;
    }

    private async Task ExecuteBatchCoreAsync(BatchContext ctx, CancellationTokenSource cts)
    {
        var ct = cts.Token;
        DbCommand? cmd = null;
        DbDataReader? reader = null;
        try
        {
            if (TxMode == TransactionMode.Manual && Transaction is null)
                Transaction = await BeginTransactionAsync(ct).ConfigureAwait(false);

            cmd = CreateCommand(ctx.Batch.Sql);
            ctx.Command = cmd;
            ConfigureCommand(cmd, ctx);
            BindParameters(cmd, ctx);
            lock (_cancelLock)
            {
                _currentCommand = cmd;
                if (_cancelRequested) ct.ThrowIfCancellationRequested();
            }

            reader = await ExecuteReaderAsync(cmd, ctx, ct).ConfigureAwait(false);
            var stop = false;
            do
            {
                if (reader.FieldCount > 0)
                {
                    var continueBatch = await ReadResultSetAsync(reader, ctx, ct).ConfigureAwait(false);
                    if (!continueBatch) { stop = true; break; }
                }
            } while (await reader.NextResultAsync(ct).ConfigureAwait(false));

            if (stop)
            {
                ctx.SuppressErrors = true;
                try { CancelCommand(cmd); } catch { /* best effort */ }
            }

            await CloseReaderAsync(reader, ctx).ConfigureAwait(false);
            reader = null;
            if (!stop) await ReportRowsAffectedAsync(ctx, ctx.RecordsAffected).ConfigureAwait(false);
            if (!stop && ctx.Parameters.Bound.Count > 0)
            {
                await OnParametersAvailableAsync(ctx, ct).ConfigureAwait(false);
                CollectOutputs(ctx);
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            await FlushRowsAsync().ConfigureAwait(false);
            if (reader is not null)
            {
                try { await reader.DisposeAsync().ConfigureAwait(false); } catch { /* reader may be unusable after cancel */ }
                reader = null;
            }

            if (ctx.SuppressErrors && !_cancelRequested)
            {
                ctx.Status = BatchStatus.Ok;
            }
            else if (_cancelRequested || ct.IsCancellationRequested)
            {
                ctx.Exception = ex;
                ctx.Status = BatchStatus.Cancelled;
                await ctx.Sink.Message(ctx.Index, MessageSeverity.Warning, "Query was cancelled.", null, null, MessageSource.Engine).ConfigureAwait(false);
            }
            else
            {
                ctx.Exception = ex;
                ctx.Status = BatchStatus.Error;
                ErrorInfo error;
                try { error = MapException(ex, ctx.Batch); }
                catch (Exception mapEx) { error = new ErrorInfo(ErrorCodes.EngineError, ex.Message, ctx.Batch.Line, Detail: mapEx.Message); }
                await ctx.Sink.Error(ctx.Index, error).ConfigureAwait(false);
            }
        }
        finally
        {
            lock (_cancelLock) _currentCommand = null;
            if (reader is not null)
            {
                try { await reader.DisposeAsync().ConfigureAwait(false); } catch { /* ignore */ }
            }
            if (cmd is not null)
            {
                try { await cmd.DisposeAsync().ConfigureAwait(false); } catch { /* ignore */ }
            }
        }
    }

    private static async Task CloseReaderAsync(DbDataReader reader, BatchContext ctx)
    {
        await reader.CloseAsync().ConfigureAwait(false);
        try { ctx.RecordsAffected = reader.RecordsAffected; } catch { ctx.RecordsAffected = -1; }
        await reader.DisposeAsync().ConfigureAwait(false);
    }

    /// <returns>False when the batch must stop (row cap reached and the provider asked to stop).</returns>
    private async Task<bool> ReadResultSetAsync(DbDataReader reader, BatchContext ctx, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var columns = DescribeColumns(reader, ctx);
        var resultSetId = ((CountingSink)ctx.Sink).NextResultSetId();
        ctx.ResultSetCount++;
        await ctx.Sink.ResultSetStarted(resultSetId, ctx.Index, columns).ConfigureAwait(false);

        var buffer = new RowBuffer(resultSetId, ctx.Sink, RowBatchSize, RowFlushInterval, RowBatchMaxBytes);
        _rowBuffer = buffer;
        long count = 0;
        var truncated = false;
        var maxRows = ctx.Request.MaxRows;
        var fieldCount = columns.Length;
        var continueBatch = true;
        try
        {
            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                if (maxRows > 0 && count >= maxRows)
                {
                    truncated = true;
                    break;
                }
                var row = new object?[fieldCount];
                for (var c = 0; c < fieldCount; c++) row[c] = ReadValue(reader, c, columns[c]);
                count++;
                await buffer.AddAsync(row).ConfigureAwait(false);
            }
        }
        finally
        {
            await buffer.FlushAsync().ConfigureAwait(false);
            _rowBuffer = null;
        }

        await ctx.Sink.ResultSetEnded(resultSetId, count, truncated, sw.ElapsedMilliseconds).ConfigureAwait(false);
        if (truncated) continueBatch = await OnResultSetTruncatedAsync(reader, ctx).ConfigureAwait(false);
        return continueBatch;
    }

    private ValueTask FlushRowsAsync() => _rowBuffer?.FlushAsync() ?? ValueTask.CompletedTask;

    // ------------------------------------------------------------------ M1.5: parameters, direct access, describe

    private void CollectOutputs(BatchContext ctx)
    {
        var binder = ParamBinder;
        if (binder is null) return;
        foreach (var (param, parameter) in ctx.Parameters.Outputs)
        {
            if (param.Kind == ParamKinds.RefCursor) continue;
            object? value;
            try { value = binder.ReadOutput(parameter); }
            catch (Exception ex) when (ex is InvalidCastException or InvalidOperationException or OverflowException) { value = parameter.Value?.ToString(); }
            (_outParams ??= []).Add(new OutParamValue(param.BareName, value));
        }
    }

    /// <summary>
    /// Streams <paramref name="reader"/>'s current result set to the sink as a normal result set of the batch (row cap,
    /// batching), e.g. an Oracle REF CURSOR out parameter. Returns false when the row cap stopped it.
    /// </summary>
    protected Task<bool> StreamResultSetAsync(DbDataReader reader, BatchContext context, CancellationToken ct) =>
        ReadResultSetAsync(reader, context, ct);

    /// <summary>
    /// M1.5: runs provider-level work on the session's connection while holding the session exclusively (state
    /// Executing, so executions and transaction calls are rejected meanwhile). <see cref="Cancel"/> cancels the token
    /// and the command created last through the scope. Used by describe and the explain-plan readers. The work runs on
    /// a thread-pool thread; the open manual transaction (if any) is assigned to every command.
    /// </summary>
    public async Task<T> RunExclusiveAsync<T>(Func<SessionScope, CancellationToken, Task<T>> work, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(work);
        var prev = Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle);
        if (prev != StateIdle)
        {
            if (prev == StateBroken) throw new SessionBrokenException();
            if (prev == StateClosed) throw new ObjectDisposedException(GetType().Name, "The session is closed.");
            throw new SessionBusyException();
        }

        CancellationTokenSource cts;
        lock (_cancelLock)
        {
            _cancelRequested = false;
            cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _executionCts = cts;
        }
        try
        {
            using var direct = EnterDirectMode();
            var scope = new SessionScope(this);
            return await Task.Run(() => work(scope, cts.Token), CancellationToken.None).ConfigureAwait(false);
        }
        finally
        {
            lock (_cancelLock)
            {
                _executionCts = null;
                _currentCommand = null;
            }
            cts.Dispose();
            if (Transaction is not null && Transaction.Connection is null) Transaction = null;
            var broken = IsConnectionBroken(null);
            if (broken)
            {
                Transaction = null;
                ServerTxOpen = false;
            }
            Interlocked.CompareExchange(ref _state, broken ? StateBroken : StateIdle, StateExecuting);
        }
    }

    /// <summary>
    /// M1.5 <c>POST /sessions/{sid}/describe</c>: the columns a query would return, using
    /// <see cref="DescribeBehavior"/> (SchemaOnly) so nothing is executed. Placeholders without a parameter are bound
    /// to NULL. Callers must reject non-queries first.
    /// </summary>
    public Task<ColumnInfo[]> DescribeAsync(string sql, IReadOnlyList<QueryParam>? parameters, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);
        if (parameters is { Count: > 0 }) ParamValues.Validate(parameters);
        return RunExclusiveAsync(async (scope, token) =>
        {
            var text = PrepareDescribeSql(sql);
            await using var cmd = scope.CreateCommand(text);
            ConfigureDescribeCommand(cmd);
            if (ParamBinder is { } binder)
            {
                var all = new List<QueryParam>(parameters ?? []);
                var known = new HashSet<string>(all.Select(p => p.BareName), StringComparer.OrdinalIgnoreCase);
                var unnamed = 0;
                foreach (var ph in binder.FindPlaceholders(text))
                {
                    if (ph.Name is null) unnamed++;
                    else if (known.Add(ph.Name)) all.Add(new QueryParam(ph.Name, ParamKinds.Null));
                }
                var positional = all.Count(p => p.IsPositional);
                for (var i = positional + 1; i <= unnamed; i++) all.Add(new QueryParam(i.ToString(System.Globalization.CultureInfo.InvariantCulture), ParamKinds.Null));
                binder.Bind(cmd, all, new ParamBindCursor());
            }
            else if (parameters is { Count: > 0 })
            {
                throw new EngineException(400, ErrorCodes.NotSupported, "This provider does not support query parameters.");
            }
            await using var reader = await cmd.ExecuteReaderAsync(DescribeBehavior, token).ConfigureAwait(false);
            var batch = new SqlBatch(text, 1, 1);
            var context = new BatchContext(0, batch, new ExecuteRequest([batch], 0, true, false, "describe", parameters), NullSink.Instance, Dialect, token);
            return reader.FieldCount > 0 ? DescribeColumns(reader, context) : [];
        }, ct);
    }

    /// <summary>Access to the session connection inside <see cref="RunExclusiveAsync"/>.</summary>
    public sealed class SessionScope
    {
        private readonly AdoSessionBase _session;

        internal SessionScope(AdoSessionBase session) => _session = session;

        public DbConnection Connection => _session.Connection;
        public DbTransaction? Transaction => _session.Transaction;
        public Dialect Dialect => _session.Dialect;
        public IParamBinder? Binder => _session.ParamBinder;

        /// <summary>A command on the session connection (session timeout, open transaction) that <see cref="Cancel"/> can interrupt.</summary>
        public DbCommand CreateCommand(string sql)
        {
            var cmd = _session.CreateCommand(sql);
            lock (_session._cancelLock) _session._currentCommand = cmd;
            return cmd;
        }
    }

    private sealed class NullSink : IExecutionSink
    {
        public static readonly NullSink Instance = new();
        public ValueTask BatchStarted(int batchIndex) => ValueTask.CompletedTask;
        public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns) => ValueTask.CompletedTask;
        public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows) => ValueTask.CompletedTask;
        public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs) => ValueTask.CompletedTask;
        public ValueTask RowsAffected(int batchIndex, long count, string? statementKind) => ValueTask.CompletedTask;
        public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) => ValueTask.CompletedTask;
        public ValueTask Error(int batchIndex, ErrorInfo error) => ValueTask.CompletedTask;
        public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------------ disposal

    public async ValueTask DisposeAsync()
    {
        if (Volatile.Read(ref _state) == StateClosed) return;
        Cancel();
        var running = _runningExecution;
        if (running is not null)
        {
            try { await running.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); } catch { /* ignore */ }
        }
        Interlocked.Exchange(ref _state, StateClosed);
        try
        {
            if (TxOpen && !IsConnectionBroken(null))
                await RollbackCoreAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
            // Closing the connection rolls back anyway.
        }
        Transaction = null;
        ServerTxOpen = false;
        try
        {
            await DisposeCoreAsync().ConfigureAwait(false);
        }
        finally
        {
            await Connection.DisposeAsync().ConfigureAwait(false);
        }
        GC.SuppressFinalize(this);
    }

    /// <summary>Provider cleanup before the connection is disposed (unsubscribe events, ...).</summary>
    protected virtual ValueTask DisposeCoreAsync() => ValueTask.CompletedTask;

    // ------------------------------------------------------------------ internals

    /// <summary>Accumulates rows and flushes them to the sink by count, age or approximate size.</summary>
    private sealed class RowBuffer(int resultSetId, IExecutionSink sink, int maxRows, TimeSpan maxAge, int maxBytes)
    {
        private List<object?[]> _rows = new(Math.Min(maxRows, 1024));
        private long _bytes;
        private long _lastFlush = Stopwatch.GetTimestamp();

        public async ValueTask AddAsync(object?[] row)
        {
            _rows.Add(row);
            foreach (var v in row) _bytes += ValueConverter.EstimateSize(v) / 2; // rough JSON size of the value
            if (_rows.Count >= maxRows || _bytes >= maxBytes || Stopwatch.GetElapsedTime(_lastFlush) >= maxAge)
                await FlushAsync().ConfigureAwait(false);
        }

        public async ValueTask FlushAsync()
        {
            if (_rows.Count == 0) return;
            var batch = _rows;
            _rows = new List<object?[]>(Math.Min(maxRows, 1024));
            _bytes = 0;
            _lastFlush = Stopwatch.GetTimestamp();
            await sink.Rows(resultSetId, batch).ConfigureAwait(false);
        }
    }

    /// <summary>Wraps the caller's sink to number result sets and total rows affected for <see cref="ExecutionSummary"/>.</summary>
    private sealed class CountingSink(IExecutionSink inner) : IExecutionSink, IExecutionDiagnosticsSink
    {
        private int _nextResultSetId;
        private long _rowsAffected;

        public int ResultSets => Volatile.Read(ref _nextResultSetId);
        public long TotalRowsAffected => Interlocked.Read(ref _rowsAffected);
        public int NextResultSetId() => Interlocked.Increment(ref _nextResultSetId) - 1;

        public ValueTask BatchStarted(int batchIndex) => inner.BatchStarted(batchIndex);
        public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns) => inner.ResultSetStarted(resultSetId, batchIndex, columns);
        public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows) => inner.Rows(resultSetId, rows);
        public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs) => inner.ResultSetEnded(resultSetId, rowCount, truncated, elapsedMs);

        public ValueTask RowsAffected(int batchIndex, long count, string? statementKind)
        {
            if (count > 0) Interlocked.Add(ref _rowsAffected, count);
            return inner.RowsAffected(batchIndex, count, statementKind);
        }

        public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) =>
            inner.Message(batchIndex, severity, text, line, code, source);

        public ValueTask Error(int batchIndex, ErrorInfo error) => inner.Error(batchIndex, error);
        public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => inner.BatchEnded(batchIndex, elapsedMs, status);

        public ValueTask Diagnostics(int batchIndex, IReadOnlyList<SqlDiagnostic> diagnostics) =>
            inner is IExecutionDiagnosticsSink ds ? ds.Diagnostics(batchIndex, diagnostics) : ValueTask.CompletedTask;
    }
}
