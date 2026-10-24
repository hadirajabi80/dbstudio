using System.Diagnostics;
using System.Net.Sockets;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// MySQL / MariaDB provider base (plan-batch3 WP-MY, MySqlConnector 2.4): sessions on dedicated unpooled connections,
/// pooled catalog / search / object-browser connections, <c>Dialect.MySql</c> for both ids. The server flavor is detected
/// per connection (a "mysql" profile pointing at a MariaDB server still works).
/// </summary>
public abstract class MySqlProviderBase : IDbProvider, IObjectBrowserProvider, IDatabaseSearchProvider
{
    public abstract string Id { get; }
    public abstract string DisplayName { get; }
    public Dialect Dialect => Dialect.MySql;
    public ConnectionFormSpec FormSpec => MySqlConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new MySqlDdlGenerator();
    public ISqlDiagnostics? Diagnostics => null;
    public IdentifierRules Identifiers { get; } = new('`', '`', "preserve", MySqlReservedWords.All);

    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        MySqlConnectionStrings.Build(profile, password, pooling: false);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var conn = new MySqlConnection(MySqlConnectionStrings.Build(profile, password, pooling: false));
            await conn.OpenAsync(ct).ConfigureAwait(false);
            await MySqlDb.InitializeAsync(conn, profile, session: false, ct).ConfigureAwait(false);
            var (info, _, _) = await ReadServerInfoAsync(conn, profile, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is MySqlException or SocketException or TimeoutException or ArgumentException or InvalidOperationException or IOException
                                       or FormatException or System.Security.Authentication.AuthenticationException)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, MySqlErrors.ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var conn = new MySqlConnection(MySqlConnectionStrings.Build(profile, password, pooling: false, options.Database));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            await MySqlDb.InitializeAsync(conn, profile, session: true, ct).ConfigureAwait(false);
            var (info, flavor, id) = await ReadServerInfoAsync(conn, profile, ct).ConfigureAwait(false);
            return new MySqlSession(conn, profile, options, info, flavor, id);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await MySqlCatalogReader.OpenAsync(profile, password, ct).ConfigureAwait(false);

    public async Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new MySqlSearcher(await MySqlCatalogReader.OpenAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new MySqlDependencyReader(await MySqlCatalogReader.OpenAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new MySqlDependencyReader(await MySqlCatalogReader.OpenAsync(profile, password, ct).ConfigureAwait(false));

    /// <summary>"MySQL 8.4.3 (MySQL Community Server - GPL)", "8.4.3", host, CURRENT_USER(), DATABASE().</summary>
    public static async Task<(ServerInfo Info, MySqlFlavor Flavor, long ConnectionId)> ReadServerInfoAsync(MySqlConnection conn, ConnectionProfile profile, CancellationToken ct)
    {
        var (flavor, user, database, id) = await MySqlDb.ServerFactsAsync(conn, ct).ConfigureAwait(false);
        var banner = $"{flavor.Product} {flavor.ProductVersion}" + (string.IsNullOrWhiteSpace(flavor.Comment) ? "" : $" ({flavor.Comment})");
        // ProductVersion carries the flavor for version-dependent readers (plans): "8.4.3" / "11.4.2-MariaDB".
        var productVersion = flavor.IsMariaDb ? flavor.ProductVersion + "-MariaDB" : flavor.ProductVersion;
        return (new ServerInfo(banner, productVersion, profile.GetString("host"), user, database), flavor, id);
    }
}

/// <summary>MySQL 5.7+ / 8.x / 9.x, Aurora MySQL, PlanetScale ("mysql").</summary>
public sealed class MySqlProvider : MySqlProviderBase
{
    public override string Id => "mysql";
    public override string DisplayName => "MySQL";
}

/// <summary>MariaDB 10.4+ / 11.x ("mariadb").</summary>
public sealed class MariaDbProvider : MySqlProviderBase
{
    public override string Id => "mariadb";
    public override string DisplayName => "MariaDB";
}
