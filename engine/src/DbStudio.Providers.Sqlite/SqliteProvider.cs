using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>SQLite via Microsoft.Data.Sqlite (docs/PLAN.md 2.5). Profile props: path, readOnly, createIfMissing, attach.</summary>
public sealed class SqliteProvider : IDbProvider
{
    private static readonly SqliteDdlGenerator Ddl = new();
    private static readonly SqlitePrepareDiagnostics Prepare = new();

    public string Id => "sqlite";
    public string DisplayName => "SQLite";
    public Dialect Dialect => Dialect.Sqlite;

    public ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("path", "Database file", "file", Required: true, Placeholder: @"C:\data\app.db",
            FileFilter: "*.db;*.sqlite;*.sqlite3", Help: "Path to the database file, or :memory: for a private in-memory database."),
        new FormField("readOnly", "Open read-only", "bool", Default: JsonValue.Create(false),
            Help: "Opens the file with Mode=ReadOnly; no statement can modify it."),
        new FormField("createIfMissing", "Create the file if it does not exist", "bool", Default: JsonValue.Create(false)),
        new FormField("attach", "Attached databases", "list", Placeholder: @"archive=C:\data\archive.db",
            Help: "Optional entries name=path, attached to every session and to the object explorer."),
    ]);

    public IDdlGenerator DdlGenerator => Ddl;
    public ISqlDiagnostics? Diagnostics => Prepare;
    public IdentifierRules Identifiers { get; } = new('"', '"', "preserve", SqliteKeywords.Reserved);

    public string BuildConnectionString(ConnectionProfile profile, string? password) => SqliteConnections.BuildConnectionString(profile);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var connection = await SqliteConnections.OpenAsync(profile, forceReadOnly: false, ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(connection, profile, ct).ConfigureAwait(false);
            // Touch the schema so a non-database file fails here ("file is not a database").
            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = "SELECT count(*) FROM sqlite_master";
                await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
            }
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, ToError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        var connection = await SqliteConnections.OpenAsync(profile, forceReadOnly: false, ct, queryOnlyGuard: true).ConfigureAwait(false);
        try
        {
            var info = await ReadServerInfoAsync(connection, profile, ct).ConfigureAwait(false);
            return new SqliteSession(connection, profile, options, info);
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var connection = await SqliteConnections.OpenAsync(profile, forceReadOnly: false, ct).ConfigureAwait(false);
        return new SqliteCatalogReader(connection, Ddl);
    }

    private static async Task<ServerInfo> ReadServerInfoAsync(SqliteConnection connection, ConnectionProfile profile, CancellationToken ct)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT sqlite_version()";
        var version = (string?)await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false) ?? connection.ServerVersion;
        var path = SqliteConnections.ResolvePath(profile);
        return new ServerInfo($"SQLite {version}", version, path == SqliteConnections.MemoryPath ? path : Path.GetFileName(path), null, "main");
    }

    internal static ErrorInfo ToError(Exception ex) => ex switch
    {
        SqliteException se when SqliteConnections.IsLockError(se) => new ErrorInfo(SqliteNames.CodeName(se.SqliteErrorCode), DbStudio.Core.Services.LockWait.Message + ".",
            Detail: "SQLite: " + SqliteNames.CleanMessage(se.Message), ProviderCode: se.SqliteErrorCode),
        SqliteException se => new ErrorInfo(SqliteNames.CodeName(se.SqliteErrorCode), SqliteNames.CleanMessage(se.Message), ProviderCode: se.SqliteErrorCode),
        FileNotFoundException fnf => new ErrorInfo("SQLITE_CANTOPEN", fnf.Message, ProviderCode: 14),
        ArgumentException ae => new ErrorInfo("VALIDATION", ae.Message),
        UnauthorizedAccessException ua => new ErrorInfo("SQLITE_PERM", ua.Message, ProviderCode: 3),
        _ => new ErrorInfo("PROVIDER_ERROR", ex.Message),
    };
}

internal static class SqliteKeywords
{
    /// <summary>SQLite keywords (sqlite.org/lang_keywords.html).</summary>
    public static readonly IReadOnlySet<string> Reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ABORT", "ACTION", "ADD", "AFTER", "ALL", "ALTER", "ALWAYS", "ANALYZE", "AND", "AS", "ASC", "ATTACH", "AUTOINCREMENT",
        "BEFORE", "BEGIN", "BETWEEN", "BY", "CASCADE", "CASE", "CAST", "CHECK", "COLLATE", "COLUMN", "COMMIT", "CONFLICT",
        "CONSTRAINT", "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATABASE", "DEFAULT",
        "DEFERRABLE", "DEFERRED", "DELETE", "DESC", "DETACH", "DISTINCT", "DO", "DROP", "EACH", "ELSE", "END", "ESCAPE",
        "EXCEPT", "EXCLUDE", "EXCLUSIVE", "EXISTS", "EXPLAIN", "FAIL", "FILTER", "FIRST", "FOLLOWING", "FOR", "FOREIGN",
        "FROM", "FULL", "GENERATED", "GLOB", "GROUP", "GROUPS", "HAVING", "IF", "IGNORE", "IMMEDIATE", "IN", "INDEX",
        "INDEXED", "INITIALLY", "INNER", "INSERT", "INSTEAD", "INTERSECT", "INTO", "IS", "ISNULL", "JOIN", "KEY", "LAST",
        "LEFT", "LIKE", "LIMIT", "MATCH", "MATERIALIZED", "NATURAL", "NO", "NOT", "NOTHING", "NOTNULL", "NULL", "NULLS",
        "OF", "OFFSET", "ON", "OR", "ORDER", "OTHERS", "OUTER", "OVER", "PARTITION", "PLAN", "PRAGMA", "PRECEDING",
        "PRIMARY", "QUERY", "RAISE", "RANGE", "RECURSIVE", "REFERENCES", "REGEXP", "REINDEX", "RELEASE", "RENAME",
        "REPLACE", "RESTRICT", "RETURNING", "RIGHT", "ROLLBACK", "ROW", "ROWS", "SAVEPOINT", "SELECT", "SET", "TABLE",
        "TEMP", "TEMPORARY", "THEN", "TIES", "TO", "TRANSACTION", "TRIGGER", "UNBOUNDED", "UNION", "UNIQUE", "UPDATE",
        "USING", "VACUUM", "VALUES", "VIEW", "VIRTUAL", "WHEN", "WHERE", "WINDOW", "WITH", "WITHOUT",
    };
}
