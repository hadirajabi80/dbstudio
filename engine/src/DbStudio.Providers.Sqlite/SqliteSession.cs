using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.Sqlite.Params;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// SQLite tab session. Microsoft.Data.Sqlite is synchronous under the hood; the base class runs execution on a
/// thread-pool thread and cancellation interrupts the running statement with <c>sqlite3_interrupt</c>.
/// </summary>
internal sealed class SqliteSession : AdoSessionBase
{
    private readonly SqliteConnection _connection;

    // Read-only profile: the session runs with PRAGMA query_only = ON (set when opening), lifted only for an execution
    // the user explicitly allowed to write (ExecuteRequest.WritesConfirmed).
    private readonly bool _queryOnlyGuard;
    private bool _queryOnlyLifted;

    public SqliteSession(SqliteConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server)
        : base(connection, profile, options, Dialect.Sqlite, server)
    {
        _connection = connection;
        _queryOnlyGuard = SqliteConnections.UsesQueryOnlyGuard(profile);
        CurrentDatabase = "main";
    }

    protected override async ValueTask OnExecutionStartingAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct)
    {
        if (_queryOnlyGuard && request.WritesConfirmed != _queryOnlyLifted) await SetQueryOnlyAsync(!request.WritesConfirmed).ConfigureAwait(false);
    }

    protected override async ValueTask OnExecutionCompletedAsync(ExecuteRequest request, ExecutionSummary summary)
    {
        if (_queryOnlyLifted) await SetQueryOnlyAsync(true).ConfigureAwait(false);
    }

    private async Task SetQueryOnlyAsync(bool on)
    {
        await using var cmd = CreateCommand(on ? "PRAGMA query_only = ON" : "PRAGMA query_only = OFF");
        await cmd.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
        _queryOnlyLifted = !on;
    }

    /// <summary>M1.5: named (:x @x $x ?N) and positional (?) parameters.</summary>
    protected override IParamBinder? ParamBinder => SqliteParamBinder.Instance;

    /// <summary>
    /// Microsoft.Data.Sqlite retries a locked database (SQLITE_BUSY) until CommandTimeout; 0 would wait forever. The
    /// default is the profile's busy timeout (30 s).
    /// </summary>
    protected override int DefaultCommandTimeoutSeconds => SqliteConnections.BusyTimeoutSeconds(Profile);

    /// <summary>SQLite placeholders (:x @x $x ?N ?) are unambiguous: a missing value is a VALIDATION error up front.</summary>
    protected override bool RejectUnboundParameters => true;

    /// <summary>
    /// sqlite3_interrupt is safe to call from any thread; it aborts the statement running on the connection. It does not
    /// stop the driver's busy-retry loop (each retry resets the statement, which clears the interrupt), so the command
    /// timeout is also cut to 1 s: the driver re-reads it on every retry and gives up with SQLITE_BUSY.
    /// </summary>
    protected override void CancelCommand(DbCommand command)
    {
        var handle = _connection.Handle;
        if (handle is not null && !handle.IsInvalid) SQLitePCL.raw.sqlite3_interrupt(handle);
        SqliteConnections.StopBusyWait(command);
    }

    /// <summary>SQLITE_INTERRUPT, or a lock wait that our cancel cut short (the statement never got the lock).</summary>
    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception)
        || exception is SqliteException { SqliteErrorCode: SqliteConnections.Interrupt }
        || (CancelRequested && exception is SqliteException se && SqliteConnections.IsLockError(se));

    /// <summary>
    /// <c>sqlite3_get_autocommit</c> is 0 while a transaction is open: tracks a user-typed BEGIN (auto or manual mode)
    /// and a COMMIT/ROLLBACK typed inside it.
    /// </summary>
    protected override ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct)
    {
        var handle = _connection.Handle;
        if (Transaction is not null || handle is null || handle.IsInvalid) return ValueTask.FromResult<bool?>(null);
        return ValueTask.FromResult<bool?>(SQLitePCL.raw.sqlite3_get_autocommit(handle) == 0);
    }

    /// <summary>Deferred BEGIN: no write lock until the first write, friendlier to other processes using the file.</summary>
    protected override Task<DbTransaction> BeginTransactionAsync(CancellationToken ct) =>
        Task.FromResult<DbTransaction>(_connection.BeginTransaction(deferred: true));

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column)
    {
        if (reader.IsDBNull(ordinal)) return null;
        var value = reader.GetValue(ordinal);
        // SQLite stores booleans as integers; honour a declared BOOLEAN type.
        if (column.Kind == ColumnKinds.Bool && value is long l) return l != 0;
        return ValueConverter.ToWire(value);
    }

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        if (exception is not SqliteException se) return base.MapException(exception, batch);
        if (SqliteConnections.IsLockError(se))
            return new ErrorInfo(SqliteNames.CodeName(se.SqliteErrorCode), LockWait.Message + ".", FirstCodeLine(batch, Dialect.Sqlite),
                Detail: $"SQLite: {SqliteNames.CleanMessage(se.Message)} (waited up to {CommandTimeoutSeconds} s, the connection's busy timeout).",
                ProviderCode: se.SqliteErrorCode);
        var message = SqliteNames.CleanMessage(se.Message);
        var (line, col) = SqliteErrorLocator.Locate(message, batch.Sql) is { } offset
            ? DocumentPosition(batch, offset)
            : (FirstCodeLine(batch, Dialect.Sqlite), (int?)null);
        return new ErrorInfo(
            Code: SqliteNames.CodeName(se.SqliteErrorCode),
            Message: message,
            Line: line,
            Col: col,
            Detail: se.SqliteExtendedErrorCode != se.SqliteErrorCode ? $"Extended code {se.SqliteExtendedErrorCode}" : null,
            ProviderCode: se.SqliteErrorCode);
    }

    private static (int Line, int? Col) DocumentPosition(SqlBatch batch, int offset)
    {
        var (relLine, relCol) = SqlTokenizer.LineColAt(batch.Sql, offset);
        return (ToDocumentLine(batch, relLine), ToDocumentCol(batch, relLine, relCol));
    }

    protected override bool IsConnectionBroken(Exception? exception) =>
        base.IsConnectionBroken(exception) || exception is SqliteException { SqliteErrorCode: 26 or 11 }; // NOTADB, CORRUPT
}

/// <summary>Finds the offset of the token an SQLite error message refers to (SQLite reports no positions).</summary>
internal static partial class SqliteErrorLocator
{
    [GeneratedRegex("""near "(?<tok>.+?)": syntax error""")]
    private static partial Regex NearToken();

    [GeneratedRegex("""no such (?:table|column|function|collation sequence|module|index|view|trigger): (?<tok>[^\s,]+)""")]
    private static partial Regex NoSuchName();

    [GeneratedRegex("""(?:ambiguous column name|table \S+ has no column named|duplicate column name|table|view|index|trigger) (?<tok>[^\s,]+)(?: already exists)?""")]
    private static partial Regex NamedObject();

    /// <summary>0-based offset in <paramref name="sql"/> of the token mentioned by <paramref name="message"/>, or null.</summary>
    public static int? Locate(string message, string sql)
    {
        if (message.Contains("incomplete input", StringComparison.OrdinalIgnoreCase))
        {
            var tokens = SqlTokenizer.Tokenize(sql, Dialect.Sqlite);
            return tokens.Count > 0 ? tokens[^1].Start : null;
        }

        var m = NearToken().Match(message);
        if (!m.Success) m = NoSuchName().Match(message);
        if (!m.Success && (message.Contains("already exists", StringComparison.Ordinal) || message.StartsWith("ambiguous", StringComparison.Ordinal)
                           || message.Contains("has no column named", StringComparison.Ordinal)))
            m = NamedObject().Match(message);
        if (!m.Success) return null;

        var target = m.Groups["tok"].Value;
        // "no such column: c.Nmae" → look for the last part; "main.t" → "t"
        var lastPart = target.Contains('.') ? target[(target.LastIndexOf('.') + 1)..] : target;
        foreach (var t in SqlTokenizer.Tokenize(sql, Dialect.Sqlite))
        {
            var text = sql[t.Start..t.End];
            if (text.Equals(target, StringComparison.OrdinalIgnoreCase) || t.Value.Equals(lastPart, StringComparison.OrdinalIgnoreCase))
                return t.Start;
        }
        var idx = sql.IndexOf(target, StringComparison.OrdinalIgnoreCase);
        return idx >= 0 ? idx : null;
    }
}
