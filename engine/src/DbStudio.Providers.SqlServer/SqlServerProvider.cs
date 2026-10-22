using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>Microsoft SQL Server provider (Microsoft.Data.SqlClient, ScriptDom diagnostics).</summary>
public sealed class SqlServerProvider : IDbProvider, IObjectBrowserProvider, IDatabaseSearchProvider
{
    public string Id => "sqlserver";
    public string DisplayName => "Microsoft SQL Server";
    public Dialect Dialect => Dialect.TSql;
    public ConnectionFormSpec FormSpec => SqlServerConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new TSqlDdlGenerator();
    public ISqlDiagnostics? Diagnostics { get; } = new ScriptDomDiagnostics();
    public IdentifierRules Identifiers { get; } = new('[', ']', "preserve", SqlServerReservedWords.All);

    /// <summary>The session connection string (pooling disabled).</summary>
    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        SqlServerConnectionStrings.Build(profile, password, pooling: false);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var conn = new SqlConnection(SqlServerConnectionStrings.Build(profile, password, pooling: false));
            await conn.OpenAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is SqlException or ArgumentException or InvalidOperationException or TimeoutException)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(profile, password, pooling: false));
        if (!string.IsNullOrWhiteSpace(options.Database)) b.InitialCatalog = options.Database;
        var conn = new SqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new SqlServerSession(conn, profile, options, info);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new SqlConnection(SqlServerConnectionStrings.Build(profile, password, pooling: true));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return new SqlServerCatalogReader(conn);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    // ---- WP3 object browser (dependencies + object list): one pooled catalog connection per call.
    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenBrowserAsync(profile, password, ct).ConfigureAwait(false);

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenBrowserAsync(profile, password, ct).ConfigureAwait(false);

    // ---- Find in database (Ctrl+Shift+F): one pooled catalog connection per search.
    public async Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new SqlConnection(SqlServerConnectionStrings.Build(profile, password, pooling: true));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return new SqlServerSearcher(conn);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static async Task<SqlServerDependencyReader> OpenBrowserAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new SqlConnection(SqlServerConnectionStrings.Build(profile, password, pooling: true));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return new SqlServerDependencyReader(conn);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>@@VERSION, ProductVersion, @@SERVERNAME, SUSER_SNAME(), DB_NAME().</summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(SqlConnection conn, CancellationToken ct)
    {
        await using var cmd = SqlDb.Command(conn, SqlServerCatalogQueries.ServerInfo);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false)) return new ServerInfo(conn.ServerVersion, conn.ServerVersion, conn.DataSource, null, conn.Database);
        return new ServerInfo(
            (SqlDb.Str(r, 0) ?? conn.ServerVersion).Trim(),
            SqlDb.Str(r, 1),
            SqlDb.Str(r, 2),
            SqlDb.Str(r, 3),
            SqlDb.Str(r, 4));
    }

    public static ErrorInfo ToProviderError(Exception ex) => ex switch
    {
        SqlException sql => new ErrorInfo("PROVIDER_ERROR", sql.Message, State: sql.State, ProviderCode: sql.Number,
            Detail: sql.Errors.Count > 0 ? SqlServerErrors.Header(SqlServerErrors.From(sql.Errors[0])) : null),
        _ => new ErrorInfo("PROVIDER_ERROR", ex.Message, Detail: ex.GetType().Name),
    };
}
