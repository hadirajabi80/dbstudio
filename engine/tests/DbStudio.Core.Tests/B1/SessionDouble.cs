using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite;
using Microsoft.Data.Sqlite;

namespace DbStudio.Core.Tests.B1;

/// <summary>
/// Provider double ("double"): a plain <see cref="AdoSessionBase"/> over a real SQLite connection, with markers in the
/// SQL text that simulate what a real server cannot be made to do on demand:
/// <c>/*break*/</c> — the connection drops while the statement runs (network failure);
/// <c>/*cancel-after*/</c> — a cancel arrives right after the driver finished the statement.
/// Catalog and form spec come from the SQLite provider; profiles use the same props (path).
/// </summary>
public sealed class DoubleProvider : IDbProvider
{
    private readonly SqliteProvider _inner = new();

    public string Id => "double";
    public string DisplayName => "Session double";
    public Dialect Dialect => Dialect.Sqlite;
    public ConnectionFormSpec FormSpec => _inner.FormSpec;
    public IDdlGenerator DdlGenerator => _inner.DdlGenerator;
    public ISqlDiagnostics? Diagnostics => null;
    public IdentifierRules Identifiers => _inner.Identifiers;

    public string BuildConnectionString(ConnectionProfile profile, string? password) => _inner.BuildConnectionString(profile, password);
    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) => _inner.TestAsync(profile, password, ct);
    public Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) => _inner.OpenCatalogReaderAsync(profile, password, ct);

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = profile.GetString("path"),
            Pooling = false,
            DefaultTimeout = 5,
        }.ToString());
        await connection.OpenAsync(ct);
        return new DoubleSession(connection, profile, options);
    }
}

public sealed class DoubleSession(SqliteConnection connection, ConnectionProfile profile, SessionOptions options)
    : AdoSessionBase(connection, profile, options, Dialect.Sqlite, new ServerInfo("double", null, null, null, "main"))
{
    private volatile bool _broken;

    protected override int DefaultCommandTimeoutSeconds => 5;

    protected override Task<DbTransaction> BeginTransactionAsync(CancellationToken ct) =>
        Task.FromResult<DbTransaction>(connection.BeginTransaction(deferred: true));

    protected override async Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct)
    {
        if (command.CommandText.Contains("/*break*/", StringComparison.Ordinal))
        {
            _broken = true;
            throw new IOException("The network connection was reset (test double).");
        }
        var reader = await base.ExecuteReaderAsync(command, context, ct);
        if (command.CommandText.Contains("/*cancel-after*/", StringComparison.Ordinal)) Cancel();
        return reader;
    }

    protected override bool IsConnectionBroken(Exception? exception) => _broken || base.IsConnectionBroken(exception);
}

/// <summary>Collects what a session reports (direct <see cref="IDbSession.ExecuteAsync"/> calls).</summary>
public sealed class CollectingSink : IExecutionSink
{
    public List<ErrorInfo> Errors { get; } = [];
    public List<(MessageSeverity Severity, string Text)> Messages { get; } = [];
    public List<BatchStatus> Statuses { get; } = [];

    public ValueTask BatchStarted(int batchIndex) => ValueTask.CompletedTask;
    public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns) => ValueTask.CompletedTask;
    public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows) => ValueTask.CompletedTask;
    public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs) => ValueTask.CompletedTask;
    public ValueTask RowsAffected(int batchIndex, long count, string? statementKind) => ValueTask.CompletedTask;

    public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source)
    {
        lock (Messages) Messages.Add((severity, text));
        return ValueTask.CompletedTask;
    }

    public ValueTask Error(int batchIndex, ErrorInfo error)
    {
        lock (Errors) Errors.Add(error);
        return ValueTask.CompletedTask;
    }

    public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status)
    {
        lock (Statuses) Statuses.Add(status);
        return ValueTask.CompletedTask;
    }
}
