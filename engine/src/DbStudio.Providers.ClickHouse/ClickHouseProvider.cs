using System.Diagnostics;
using ClickHouse.Driver;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// ClickHouse provider (plan-batch3 WP-CH, ClickHouse.Driver over HTTP). Single-level like Oracle: the console switcher
/// and the explorer's schemas are ClickHouse databases. Console sessions are HTTP sessions; catalog, designer, object
/// browser and search use sessionless requests over the shared connection pool.
/// </summary>
public sealed class ClickHouseProvider : IDbProvider, IObjectBrowserProvider, IDatabaseSearchProvider
{
    /// <summary>Test seam: an HTTP handler standing in for the server (null = the shared socket handler).</summary>
    public HttpMessageHandler? Handler { get; init; }

    public string Id => "clickhouse";
    public string DisplayName => "ClickHouse";
    public Dialect Dialect => Dialect.ClickHouse;
    public ConnectionFormSpec FormSpec => ChConnections.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new ChDdlGenerator();
    public ISqlDiagnostics? Diagnostics => null;

    /// <summary>Identifiers are case-sensitive in ClickHouse ("preserve"); backticks quote.</summary>
    public IdentifierRules Identifiers { get; } = new('`', '`', "preserve", ChReservedWords.All);

    public string BuildConnectionString(ConnectionProfile profile, string? password) => ChConnections.Describe(profile);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var ch = await ChConnections.OpenAsync(profile, password, null, null, ct, Handler).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(ch, profile, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is ClickHouseServerException or HttpRequestException or TaskCanceledException or ArgumentException
                                       or InvalidOperationException or IOException or FormatException)
        {
            if (ex is TaskCanceledException && ct.IsCancellationRequested) throw;
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, ChErrors.ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var sessionId = "rowlit-" + Guid.NewGuid().ToString("N");
        var ch = await ChConnections.OpenAsync(profile, password, options.Database, sessionId, ct, Handler).ConfigureAwait(false);
        try
        {
            var info = await ReadServerInfoAsync(ch, profile, ct).ConfigureAwait(false);
            return new ChSession(ch, profile, password, options, info, Handler);
        }
        catch
        {
            await ch.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenReaderAsync(profile, password, ct).ConfigureAwait(false);

    internal async Task<ChCatalogReader> OpenReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var ch = await ChConnections.OpenAsync(profile, password, null, null, ct, Handler).ConfigureAwait(false);
        return new ChCatalogReader(ch, ChConnections.Database(profile));
    }

    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new ChDependencyReader(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new ChDependencyReader(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new ChSearcher(await OpenReaderAsync(profile, password, ct).ConfigureAwait(false));

    /// <summary>version(), hostName(), currentUser(), currentDatabase().</summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(ChConnection ch, ConnectionProfile profile, CancellationToken ct)
    {
        var row = (await ChDb.QueryAsync(ch.Connection, ChCatalogQueries.ServerInfo,
            r => (Version: ChDb.S(r, 0), Host: ChDb.Str(r, 1), User: ChDb.Str(r, 2), Db: ChDb.Str(r, 3), Tz: ChDb.Str(r, 4)), ct).ConfigureAwait(false))
            .FirstOrDefault();
        var host = ChConnections.Host(profile);
        if (row == default) return new ServerInfo("ClickHouse", null, host, ChConnections.User(profile), ChConnections.Database(profile));
        return new ServerInfo($"ClickHouse {row.Version}", row.Version, row.Host ?? host, row.User, row.Db);
    }

    /// <summary>Major.minor of a version ("24.8.14.39" → (24, 8)); (0, 0) when unknown.</summary>
    public static (int Major, int Minor) VersionOf(string? version)
    {
        if (string.IsNullOrWhiteSpace(version)) return (0, 0);
        var parts = version.Trim().Split('.', ' ');
        int.TryParse(parts[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var major);
        var minor = 0;
        if (parts.Length > 1) int.TryParse(parts[1], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out minor);
        return (major, minor);
    }
}
