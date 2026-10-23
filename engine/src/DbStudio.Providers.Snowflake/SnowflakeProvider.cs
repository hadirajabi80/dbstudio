using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;
using Snowflake.Data.Client;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Snowflake provider (plan-batch3 WP-SF, Snowflake.Data 6.x): tab sessions on dedicated unpooled connections; catalog,
/// object browser, search, designer reads and the module endpoints over pooled gateway connections
/// (<see cref="ISnowflakeGatewayFactory"/>, replaced by recorded fixtures in tests). Two-level like PostgreSQL
/// (database → schema), plus warehouse and role on the connection and the session.
/// </summary>
public sealed class SnowflakeProvider : IDbProvider, IObjectBrowserProvider, IDatabaseSearchProvider
{
    private readonly ISnowflakeGatewayFactory _gateways;
    private readonly SnowflakeSecrets _secrets;

    public SnowflakeProvider() : this(new SnowflakeGatewayFactory()) { }

    public SnowflakeProvider(ISnowflakeGatewayFactory gateways, SnowflakeSecrets? secrets = null)
    {
        _gateways = gateways;
        _secrets = secrets ?? SnowflakeSecrets.None;
    }

    public ISnowflakeGatewayFactory Gateways => _gateways;

    public string Id => "snowflake";
    public string DisplayName => "Snowflake";
    public Dialect Dialect => Dialect.Snowflake;
    public ConnectionFormSpec FormSpec => SnowflakeConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new SnowflakeDdlGenerator();
    public ISqlDiagnostics? Diagnostics => null;
    public IdentifierRules Identifiers { get; } = new('"', '"', "upper", SnowflakeSql.ReservedWords);

    /// <summary>The session connection string (pooling disabled; the key passphrase masked).</summary>
    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        SnowflakeConnectionStrings.Masked(SnowflakeConnectionStrings.Build(profile, password, pooling: false));

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var built = SnowflakeConnectionStrings.Build(_secrets.Hydrate(profile), password, pooling: false, application: SnowflakeConnectionStrings.ApplicationName);
            await using var conn = await SnowflakeDriver.OpenAsync(built, ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException && !ct.IsCancellationRequested)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, SnowflakeErrors.ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var database = string.IsNullOrWhiteSpace(options.Database) ? null : SnowflakeSql.Normalize(options.Database);
        var built = SnowflakeConnectionStrings.Build(_secrets.Hydrate(profile), password, pooling: false, database);
        var conn = await SnowflakeDriver.OpenAsync(built, ct).ConfigureAwait(false);
        try
        {
            var info = await ReadServerInfoAsync(conn, ct).ConfigureAwait(false);
            return new SnowflakeSession(conn, profile, options, info, c => _gateways.OpenAsync(profile, password, c));
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenReaderAsync(profile, password, ct).ConfigureAwait(false);

    internal async Task<SnowflakeCatalogReader> OpenReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var gateway = await _gateways.OpenAsync(profile, password, ct).ConfigureAwait(false);
        return new SnowflakeCatalogReader(gateway, profile);
    }

    public async Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new SnowflakeSearcher(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new SnowflakeDependencyReader(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new SnowflakeDependencyReader(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    /// <summary>CURRENT_VERSION(), account, region, user, database, warehouse, role (one round trip, no warehouse needed).</summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(SnowflakeDbConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SnowflakeSql.ServerInfo;
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var cells = new object?[r.FieldCount];
        var rows = new List<object?[]>();
        if (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            for (var i = 0; i < cells.Length; i++) cells[i] = SnowflakeDriver.Cell(r, i);
            rows.Add(cells);
        }
        var names = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToArray();
        return ServerInfoOf(new SqlRowSet(names, rows), conn.DataSource);
    }

    public static ServerInfo ServerInfoOf(SqlRowSet rs, string? host)
    {
        if (rs.Rows.Count == 0) return new ServerInfo("Snowflake", null, host, null, null);
        var r = rs.Rows[0];
        var version = rs.Str(r, "VERSION");
        var account = rs.Str(r, "ACCOUNT");
        var region = rs.Str(r, "REGION");
        var server = account is null ? host : region is null ? account : $"{account} ({region})";
        return new ServerInfo(version is null ? "Snowflake" : $"Snowflake {version}", version, server, rs.Str(r, "USER_NAME"), rs.Str(r, "DATABASE_NAME"));
    }
}
