using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.SqlServer.Params;
using Microsoft.Data.SqlClient;
using SqlBatch = DbStudio.Core.Models.SqlBatch;

namespace DbStudio.Providers.SqlServer;

/// <summary>
/// One SQL Server editor-tab session (pooling off). Each GO batch runs as one SqlCommand. PRINT/RAISERROR and
/// severity ≥ 11 errors arrive through InfoMessage (FireInfoMessageEventOnUserErrors) so the batch continues like SSMS;
/// rows affected are reported per statement from StatementCompleted.
/// </summary>
public sealed class SqlServerSession : AdoSessionBase
{
    private const string ErrorCountKey = "sqlserver.errors";
    private const string StoppingKey = "sqlserver.stopping";
    private const string CancelAckKey = "sqlserver.cancelAck";

    private readonly SqlConnection _conn;

    // Result-set tracking for StatementCompleted (the first DONE after a result set's metadata belongs to that SELECT).
    private bool _resultSetOpen;
    private long _resultSetRows;
    private bool _resultSetTruncated;
    private int _completionIndex;

    // Errors raised by provider commands outside a batch (ChangeDatabase), collected from InfoMessage.
    private volatile List<SqlServerErrors.ServerError>? _outOfBatchErrors;

    public SqlServerSession(SqlConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server)
        : base(connection, profile, options, Dialect.TSql, server)
    {
        _conn = connection;
        _conn.FireInfoMessageEventOnUserErrors = true;
        _conn.InfoMessage += OnInfoMessage;
        CurrentDatabase = string.IsNullOrEmpty(_conn.Database) ? server.Database : _conn.Database;
    }

    // ------------------------------------------------------------------ hooks

    /// <summary>M1.5: @name parameters (sp_executesql).</summary>
    protected override IParamBinder? ParamBinder => SqlServerParamBinder.Instance;

    /// <summary>M1.5: direct work (describe, explain helpers) gets server errors as exceptions, not InfoMessages.</summary>
    protected override IDisposable? EnterDirectMode()
    {
        if (!_conn.FireInfoMessageEventOnUserErrors) return null;
        _conn.FireInfoMessageEventOnUserErrors = false;
        return new RestoreInfoMessages(_conn);
    }

    private sealed class RestoreInfoMessages(SqlConnection conn) : IDisposable
    {
        public void Dispose() => conn.FireInfoMessageEventOnUserErrors = true;
    }

    protected override void ConfigureCommand(DbCommand command, BatchContext context)
    {
        _resultSetOpen = false;
        _resultSetRows = 0;
        _resultSetTruncated = false;
        _completionIndex = 0;
        var cmd = (SqlCommand)command;
        cmd.StatementCompleted += (_, e) => OnStatementCompleted(context, e.RecordCount);
    }

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        var cols = base.DescribeColumns(reader, context);
        _resultSetOpen = true;
        _resultSetRows = 0;
        _resultSetTruncated = false;
        return cols;
    }

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column)
    {
        if (ordinal == 0) _resultSetRows++;
        if (reader.IsDBNull(ordinal)) return null;
        var sql = (SqlDataReader)reader;
        switch (column.Kind)
        {
            case ColumnKinds.Decimal when !IsMoney(column.DbType):
                // decimal(38,x) can exceed System.Decimal; SqlDecimal keeps full precision.
                return sql.GetSqlDecimal(ordinal).ToString();
            case ColumnKinds.Date when sql.GetFieldType(ordinal) == typeof(DateTime):
                return ValueConverter.ToWire(DateOnly.FromDateTime(sql.GetDateTime(ordinal)));
        }
        try
        {
            return ValueConverter.ToWire(sql.GetValue(ordinal));
        }
        catch (Exception ex) when (ex is InvalidCastException or FileNotFoundException or FileLoadException or TypeLoadException or InvalidOperationException)
        {
            // CLR UDTs (hierarchyid, geography, geometry) need Microsoft.SqlServer.Types; send the raw bytes instead.
            var bytes = sql.GetSqlBytes(ordinal);
            return bytes.IsNull ? null : ValueConverter.ToWire(bytes.Value);
        }
    }

    protected override ValueTask<bool> OnResultSetTruncatedAsync(DbDataReader reader, BatchContext context)
    {
        _resultSetTruncated = true;
        // A batch that is a single query cannot produce more result sets: cancel to stop the server quickly.
        var statements = context.Classification.Statements;
        bool singleQuery = statements.Count == 1 && statements[0].Category == StatementCategory.Query;
        if (singleQuery) context.Items[StoppingKey] = true;
        return ValueTask.FromResult(!singleQuery);
    }

    /// <summary>Rows affected come from StatementCompleted, per statement.</summary>
    protected override ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected) => ValueTask.CompletedTask;

    protected override ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        if (context.Items.TryGetValue(ErrorCountKey, out var n) && n is int count && count > 0 && context.Status == BatchStatus.Ok)
            context.Status = BatchStatus.Error;
        // With FireInfoMessageEventOnUserErrors the attention ("Operation cancelled by user") arrives as a message, so the
        // reader ends normally: only the acknowledgement says the server aborted the batch. Without it the batch ran to
        // completion before the cancel reached the server (its changes stand): keep the base's Ok + warning.
        var acknowledged = context.Items.ContainsKey(CancelAckKey);
        if (CancelRequested && context.Status != BatchStatus.Cancelled && !context.Items.ContainsKey(StoppingKey)
            && (acknowledged || !context.CompletedDespiteCancel))
        {
            context.Status = BatchStatus.Cancelled;
            context.CompletedDespiteCancel = false;
        }
        // USE [db] inside the batch changes the database (ENVCHANGE is tracked by SqlConnection.Database).
        if (_conn.State == System.Data.ConnectionState.Open && !string.IsNullOrEmpty(_conn.Database))
            CurrentDatabase = _conn.Database;
        return ValueTask.CompletedTask;
    }

    /// <summary>A user-typed BEGIN TRAN (auto mode) or COMMIT inside a manual transaction is reflected in TxOpen.</summary>
    protected override async ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct)
    {
        if (_conn.State != System.Data.ConnectionState.Open) return null;
        await using var cmd = CreateCommand("SELECT @@TRANCOUNT");
        var count = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return count is int n ? n > 0 : null;
    }

    /// <summary>"Operation cancelled by user" (attention acknowledged) thrown as an exception.</summary>
    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception)
        || exception is SqlException sql && sql.Errors.Cast<SqlError>().Any(e => IsCancellationError(SqlServerErrors.From(e)));

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch) => exception switch
    {
        SqlException sql => SqlServerErrors.FromException(sql, batch),
        _ => base.MapException(exception, batch),
    };

    protected override async Task ChangeDatabaseCoreAsync(string database, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(database);
        // Outside execution, server errors arrive as InfoMessage too (FireInfoMessageEventOnUserErrors): collect them.
        var errors = new List<SqlServerErrors.ServerError>();
        _outOfBatchErrors = errors;
        try
        {
            await using (var use = CreateCommand("USE " + SqlServerNames.Quote(database)))
                await use.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            await using var check = CreateCommand("SELECT DB_NAME()");
            var actual = await check.ExecuteScalarAsync(ct).ConfigureAwait(false) as string;
            if (!string.Equals(actual, database, StringComparison.OrdinalIgnoreCase))
            {
                var reason = errors.Count > 0 ? errors[0].Message : $"the session is still in '{actual}'";
                throw new EngineException(422, ErrorCodes.ProviderError, $"Could not switch to database '{database}': {reason}");
            }
            CurrentDatabase = actual;
        }
        finally
        {
            _outOfBatchErrors = null;
        }
    }

    protected override ValueTask DisposeCoreAsync()
    {
        _conn.InfoMessage -= OnInfoMessage;
        return ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------------ driver events

    private void OnInfoMessage(object sender, SqlInfoMessageEventArgs e)
    {
        var ctx = CurrentBatch;
        if (ctx is null)
        {
            if (_outOfBatchErrors is { } sinkList)
                foreach (SqlError raw in e.Errors)
                {
                    var err = SqlServerErrors.From(raw);
                    if (SqlServerErrors.IsError(err)) sinkList.Add(err);
                }
            return;
        }
        foreach (SqlError raw in e.Errors)
        {
            var err = SqlServerErrors.From(raw);
            if (SqlServerErrors.IsError(err))
            {
                // Errors caused by our own cancel (user cancel or row cap) are not batch errors.
                if ((CancelRequested || ctx.Items.ContainsKey(StoppingKey)) && IsCancellationError(err))
                {
                    if (CancelRequested) ctx.Items[CancelAckKey] = true; // the server aborted the batch (attention acknowledged)
                    continue;
                }
                ctx.Items[ErrorCountKey] = (ctx.Items.TryGetValue(ErrorCountKey, out var n) && n is int c ? c : 0) + 1;
                EmitError(SqlServerErrors.ToErrorInfo(err, ctx.Batch));
            }
            else
            {
                EmitMessage(MessageSeverity.Info, err.Message, SqlServerErrors.DocumentLine(err, ctx.Batch),
                    err.Number == 0 ? null : err.Number, MessageSource.Server);
            }
        }
    }

    private static bool IsCancellationError(in SqlServerErrors.ServerError e) =>
        e.Number == 0 || e.Message.Contains("cancelled by user", StringComparison.OrdinalIgnoreCase)
                      || e.Message.Contains("canceled by user", StringComparison.OrdinalIgnoreCase);

    private void OnStatementCompleted(BatchContext context, int recordCount)
    {
        if (CurrentBatch != context) return;
        if (_resultSetOpen)
        {
            _resultSetOpen = false;
            // The DONE token of a SELECT: its row count is the result set's own (already reported with the result set).
            if (_resultSetTruncated || recordCount == _resultSetRows) return;
        }
        var kind = StatementKindFor(context.Classification, _completionIndex++);
        EmitRowsAffected(recordCount, kind);
    }

    /// <summary>The n-th DML statement's kind when the batch has no procedure calls/control flow (else unknown).</summary>
    public static string? StatementKindFor(BatchClassification classification, int index)
    {
        var statements = classification.Statements;
        if (statements.Any(s => s.Category is StatementCategory.Other or StatementCategory.Block or StatementCategory.Unknown)) return null;
        var dml = statements.Where(s => s.Category == StatementCategory.Dml || s.Kind == "SELECT INTO").ToList();
        if (index < dml.Count) return dml[index].Kind;
        return dml.Count > 0 && dml.All(d => d.Kind == dml[0].Kind) ? dml[0].Kind : null;
    }

    private static bool IsMoney(string dbType) =>
        dbType.Equals("money", StringComparison.OrdinalIgnoreCase) || dbType.Equals("smallmoney", StringComparison.OrdinalIgnoreCase);
}
