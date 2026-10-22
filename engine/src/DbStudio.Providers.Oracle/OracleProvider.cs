using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle;

/// <summary>Oracle Database provider (Oracle.ManagedDataAccess.Core, managed driver).</summary>
public sealed class OracleProvider : IDbProvider, IObjectBrowserProvider
{
    // ---- WP3 object browser (dependencies + object list): one pooled catalog connection per call.
    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenBrowserAsync(profile, password, ct).ConfigureAwait(false);

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenBrowserAsync(profile, password, ct).ConfigureAwait(false);

    private static async Task<OracleDependencyReader> OpenBrowserAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new OracleConnection(OracleConnectionStrings.Build(profile, password, pooling: true));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            conn.ModuleName = "DbStudio";
            conn.ClientInfo = "DbStudio catalog";
            return new OracleDependencyReader(conn);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public const string DefaultNlsDateFormat = "YYYY-MM-DD HH24:MI:SS";
    public const string DefaultNlsTimestampFormat = "YYYY-MM-DD HH24:MI:SS.FF";
    public const string DefaultNlsTimestampTzFormat = "YYYY-MM-DD HH24:MI:SS.FF TZH:TZM";

    public string Id => "oracle";
    public string DisplayName => "Oracle Database";
    public Dialect Dialect => Dialect.PlSql;
    public ConnectionFormSpec FormSpec => OracleConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new OracleDdlGenerator();

    /// <summary>No server-side syntax diagnostics for Oracle in M1 (D-5).</summary>
    public ISqlDiagnostics? Diagnostics => null;

    public IdentifierRules Identifiers { get; } = new('"', '"', "upper", OracleReservedWords.All);

    /// <summary>The session connection string (pooling and statement cache disabled).</summary>
    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        OracleConnectionStrings.Build(profile, password, pooling: false);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var conn = new OracleConnection(OracleConnectionStrings.Build(profile, password, pooling: false));
            await conn.OpenAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is OracleException or ArgumentException or InvalidOperationException or TimeoutException)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var conn = new OracleConnection(OracleConnectionStrings.Build(profile, password, pooling: false));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            conn.ModuleName = "DbStudio";
            conn.ClientInfo = "DbStudio session " + options.SessionId;

            await ExecAsync(conn, $"ALTER SESSION SET NLS_DATE_FORMAT = {OracleSqlText.Literal(profile.GetString("nlsDateFormat") ?? DefaultNlsDateFormat)}", ct).ConfigureAwait(false);
            await ExecAsync(conn, $"ALTER SESSION SET NLS_TIMESTAMP_FORMAT = {OracleSqlText.Literal(profile.GetString("nlsTimestampFormat") ?? DefaultNlsTimestampFormat)}", ct).ConfigureAwait(false);
            await ExecAsync(conn, $"ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = {OracleSqlText.Literal(DefaultNlsTimestampTzFormat)}", ct).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(options.Database))
            {
                var schema = options.Database.Trim();
                if (schema.StartsWith('"') && schema.EndsWith('"') && schema.Length >= 2) schema = schema[1..^1];
                await ExecAsync(conn, "ALTER SESSION SET CURRENT_SCHEMA = " + OracleSqlText.Quote(schema), ct).ConfigureAwait(false);
            }
            if (options.CaptureServerOutput)
                await ExecAsync(conn, "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;", ct).ConfigureAwait(false);

            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new OracleSession(conn, profile, options, info, options.CaptureServerOutput);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new OracleConnection(OracleConnectionStrings.Build(profile, password, pooling: true));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            conn.ModuleName = "DbStudio";
            conn.ClientInfo = "DbStudio catalog";
            return new OracleCatalogReader(conn);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>
    /// Version banner (V$VERSION, falling back to PRODUCT_COMPONENT_VERSION and the driver's ServerVersion),
    /// session user, current schema (as Database) and server name (DB_NAME / SERVER_HOST).
    /// </summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(OracleConnection conn, CancellationToken ct)
    {
        string? banner = null;
        try
        {
            banner = Convert.ToString(await OracleDb.ScalarAsync(conn, OracleCatalogQueries.VersionBanner, ct).ConfigureAwait(false));
        }
        catch (OracleException)
        {
            try
            {
                banner = Convert.ToString(await OracleDb.ScalarAsync(conn, OracleCatalogQueries.VersionFallback, ct).ConfigureAwait(false));
            }
            catch (OracleException)
            {
                // Neither view visible; the driver's version string remains.
            }
        }

        string? user = null, schema = null, dbName = null, host = null;
        var rows = await OracleDb.QueryAsync(conn, OracleCatalogQueries.SessionInfo,
            r => (OracleDb.Str(r, 0), OracleDb.Str(r, 1), OracleDb.Str(r, 2), OracleDb.Str(r, 3)), ct).ConfigureAwait(false);
        if (rows.Count > 0) (user, schema, dbName, host) = rows[0];

        var productVersion = conn.ServerVersion;
        return new ServerInfo(
            string.IsNullOrWhiteSpace(banner) ? "Oracle Database " + productVersion : banner.Trim(),
            productVersion,
            dbName ?? host,
            user,
            schema);
    }

    public static ErrorInfo ToProviderError(Exception ex) => ex switch
    {
        OracleException ora => new ErrorInfo("PROVIDER_ERROR", OracleErrors.CleanMessage(ora.Message).Message,
            ProviderCode: ora.Number, Detail: OracleErrors.Code(ora.Number)),
        _ => new ErrorInfo("PROVIDER_ERROR", ex.Message, Detail: ex.GetType().Name),
    };

    private static Task ExecAsync(OracleConnection conn, string sql, CancellationToken ct) => OracleDb.ExecuteAsync(conn, sql, ct);
}
