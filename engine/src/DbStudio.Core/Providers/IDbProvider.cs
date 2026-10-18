using DbStudio.Core.Models;

namespace DbStudio.Core.Providers;

/// <summary>
/// A database engine family (SQL Server, Oracle, SQLite). Stateless and registered as a singleton.
/// Contract frozen by docs/PLAN.md section 2.2: change the plan before changing this file.
/// </summary>
public interface IDbProvider
{
    /// <summary>"sqlserver" | "oracle" | "sqlite".</summary>
    string Id { get; }
    string DisplayName { get; }
    Dialect Dialect { get; }

    /// <summary>Drives the generic connection dialog in the UI.</summary>
    ConnectionFormSpec FormSpec { get; }

    string BuildConnectionString(ConnectionProfile profile, string? password);
    Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct);

    /// <summary>Opens one dedicated physical connection (pooling disabled) owned by an editor tab.</summary>
    Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct);

    /// <summary>
    /// Opens a short-lived connection used only for catalog/metadata reads (pooling allowed).
    /// Callers dispose the returned reader when done.
    /// </summary>
    Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct);

    IDdlGenerator DdlGenerator { get; }

    /// <summary>ScriptDom for SQL Server, Prepare() for SQLite, null for Oracle (M1).</summary>
    ISqlDiagnostics? Diagnostics { get; }

    IdentifierRules Identifiers { get; }
}

public interface IDbSession : IAsyncDisposable
{
    string SessionId { get; }
    string ConnectionId { get; }
    Dialect Dialect { get; }

    /// <summary>Idle | Executing | Broken | Closed.</summary>
    SessionState State { get; }
    TransactionMode TxMode { get; }
    bool TxOpen { get; }

    /// <summary>SQL Server: DB_NAME(); Oracle: current schema; SQLite: "main".</summary>
    string? CurrentDatabase { get; }
    ServerInfo Server { get; }

    /// <summary>Auto→Manual: takes effect on the next statement. Manual→Auto with an open tx throws <see cref="TxOpenException"/>.</summary>
    Task SetTransactionModeAsync(TransactionMode mode, CancellationToken ct);
    Task CommitAsync(CancellationToken ct);
    Task RollbackAsync(CancellationToken ct);

    /// <summary>SQL Server: USE; Oracle: ALTER SESSION SET CURRENT_SCHEMA; SQLite: throws NotSupportedException.</summary>
    Task ChangeDatabaseAsync(string database, CancellationToken ct);

    /// <summary>
    /// Runs every batch in order on this session's connection, reporting through <paramref name="sink"/>.
    /// Throws <see cref="SessionBusyException"/> if State != Idle. Provider errors inside a batch are reported
    /// via sink.Error (not thrown); only infrastructure failures throw.
    /// </summary>
    Task<ExecutionSummary> ExecuteAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct);

    /// <summary>Cancels the in-flight command (DbCommand.Cancel). Thread-safe, no-op when idle.</summary>
    void Cancel();

    Task<bool> PingAsync(CancellationToken ct);

    /// <summary>
    /// Additive (B1): true once the connection broke while a transaction was open, i.e. the server rolled it back.
    /// <see cref="TxOpen"/> is already false then; the session manager uses this to report the lost transaction.
    /// </summary>
    bool LostTransaction => false;

    /// <summary>
    /// Additive (B1): pre-flight check of a request's placeholders. Returns a VALIDATION error ("Missing value for
    /// parameter @id", document line/col) for the first placeholder without a value, or null. Default: no check.
    /// </summary>
    ErrorInfo? FindUnboundParameter(IReadOnlyList<SqlBatch> batches, IReadOnlyList<DbStudio.Core.Params.QueryParam>? parameters) => null;
}

/// <summary>Receives execution events. Implementations forward to the WebSocket. Rows are already wire values (see ValueConverter).</summary>
public interface IExecutionSink
{
    ValueTask BatchStarted(int batchIndex);
    ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns);
    ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows);
    ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs);
    ValueTask RowsAffected(int batchIndex, long count, string? statementKind);
    ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source);
    ValueTask Error(int batchIndex, ErrorInfo error);
    ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status);
}

/// <summary>Reads metadata over a dedicated catalog connection. Dispose to release the connection.</summary>
public interface ICatalogReader : IAsyncDisposable
{
    Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct);
    Task<string?> GetCurrentDatabaseAsync(CancellationToken ct);
    Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct);
    Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct);

    /// <summary>All objects, columns, keys, FKs (both directions), parameters, synonyms and package members of one schema.</summary>
    Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct);

    /// <summary>Columns, indexes, FKs, referencing FKs, triggers, parameters, row estimate for one object.</summary>
    Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct);

    Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct);

    /// <summary>Oracle only (ALL_ERRORS); others return empty.</summary>
    Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct);

    /// <summary>Oracle: resolve a PUBLIC synonym on demand. Others return null.</summary>
    Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct);
}

public interface IDdlGenerator
{
    /// <summary>Builds CREATE TABLE (with keys, FKs, indexes, defaults, identity) from catalog metadata.</summary>
    string GenerateTableDdl(ObjectRef table, ObjectDetails details);
}

public interface ISqlDiagnostics
{
    /// <summary>Syntax diagnostics for a whole document. Positions are 1-based and absolute to the document.</summary>
    Task<IReadOnlyList<SqlDiagnostic>> AnalyzeAsync(string sql, ConnectionProfile? profile, string? password, CancellationToken ct);
    string EngineName { get; }
}

public sealed class SessionBusyException() : InvalidOperationException("The session is already executing a statement.");
public sealed class TxOpenException() : InvalidOperationException("A transaction is open. Commit or roll back first.");
