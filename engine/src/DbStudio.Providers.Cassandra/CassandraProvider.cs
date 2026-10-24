using System.Diagnostics;
using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Cassandra / ScyllaDB as a relational provider (plan-batch3 WP-CS, D3): <see cref="IDbProvider"/> implemented directly on
/// CassandraCSharpDriver 3.22 (no ADO.NET). Dialect <c>cql</c>; keyspaces are the schema level; identifiers fold to lower
/// case and are quoted with <c>"</c>. Clusters are shared per profile (<see cref="CqlClusterPool"/>).
/// </summary>
public sealed class CassandraProvider(CqlClusterPool pool) : IDbProvider, IObjectBrowserProvider, IDatabaseSearchProvider
{
    public const string ProviderId = "cassandra";

    public CassandraProvider() : this(new CqlClusterPool()) { }

    public CqlClusterPool Pool { get; } = pool;

    public string Id => ProviderId;
    public string DisplayName => "Cassandra";
    public Dialect Dialect => Dialect.Cql;
    public ConnectionFormSpec FormSpec => CqlConnectionSettings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new CqlDdl.Generator();
    public ISqlDiagnostics? Diagnostics => null;
    public IdentifierRules Identifiers { get; } = new('"', '"', "lower", CqlReservedWords.All);

    /// <summary>A description of the target (CQL has no connection strings); never contains the password.</summary>
    public string BuildConnectionString(ConnectionProfile profile, string? password) => CqlConnectionSettings.From(profile).Describe();

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        ICluster? cluster = null;
        try
        {
            var settings = CqlConnectionSettings.From(profile);
            cluster = CqlClusterPool.Build(settings, password);
            var session = await cluster.ConnectAsync().WaitAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(session, settings, settings.Keyspace, ct).ConfigureAwait(false);
            if (settings.Keyspace is { } ks)
            {
                var exists = (await session.ExecuteAsync(new SimpleStatement("SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?", ks))
                    .WaitAsync(ct).ConfigureAwait(false)).Any();
                if (!exists)
                    return new TestConnectionResult(false, info, sw.ElapsedMilliseconds,
                        new ErrorInfo(CqlErrors.Invalid, $"Connected, but the keyspace '{ks}' does not exist."));
            }
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (CqlErrors.IsDriverFailure(ex))
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, CqlErrors.ToError(ex));
        }
        finally
        {
            if (cluster is not null)
            {
                try { await cluster.ShutdownAsync().ConfigureAwait(false); } catch { /* best effort */ }
            }
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        // A requested manual mode is ignored: the session is always auto (SetTransactionModeAsync explains why).
        var lease = await AcquireAsync(profile, password, ct).ConfigureAwait(false);
        try
        {
            var keyspace = options.Database ?? lease.Settings.Keyspace;
            var session = await lease.ConnectAsync(keyspace).WaitAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(session, lease.Settings, keyspace, ct).ConfigureAwait(false);
            return new CqlSession(lease, session, profile, options, info);
        }
        catch
        {
            await lease.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        await OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false);

    public async Task<CqlCatalogReader> OpenCqlCatalogAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var lease = await AcquireAsync(profile, password, ct).ConfigureAwait(false);
        try
        {
            var session = await lease.CatalogSessionAsync().WaitAsync(ct).ConfigureAwait(false);
            return new CqlCatalogReader(lease, session);
        }
        catch
        {
            await lease.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<CqlClusterPool.Lease> AcquireAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        try
        {
            return await Pool.AcquireAsync(profile, password, ct).ConfigureAwait(false);
        }
        catch (NoHostAvailableException ex)
        {
            throw new DbStudio.Core.Services.EngineException(503, DbStudio.Core.Services.ErrorCodes.ProviderError, CqlErrors.ToError(ex).Message);
        }
        catch (global::Cassandra.AuthenticationException ex)
        {
            throw new DbStudio.Core.Services.EngineException(401, DbStudio.Core.Services.ErrorCodes.ProviderError, $"Authentication failed: {ex.Message}");
        }
    }

    // ---- object browser and search over the catalog reader
    public async Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new CqlObjectBrowser(await OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new CqlObjectBrowser(await OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false));

    public async Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        new CqlSearcher(await OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false));

    /// <summary>Product, version, cluster name, user and keyspace from system.local (ScyllaDB / DSE detected).</summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(ISession session, CqlConnectionSettings settings, string? keyspace, CancellationToken ct)
    {
        var rows = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system.local").SetConsistencyLevel(ConsistencyLevel.One))
            .WaitAsync(ct).ConfigureAwait(false)).ToList();
        var local = rows.FirstOrDefault();
        var release = local is null ? null : CqlSchemaReader.Str(local, "release_version");
        var cql = local is null ? null : CqlSchemaReader.Str(local, "cql_version");
        var cluster = local is null ? null : CqlSchemaReader.Str(local, "cluster_name");
        var dse = local is null ? null : CqlSchemaReader.Str(local, "dse_version");
        var product = "Apache Cassandra";
        var version = release;
        if (dse is not null) { product = "DataStax Enterprise"; version = dse; }
        else if (await ScyllaVersionAsync(session, ct).ConfigureAwait(false) is { } scylla) { product = "ScyllaDB"; version = scylla; }
        var text = $"{product} {version}".Trim() + (cql is null ? "" : $" (CQL {cql})");
        return new ServerInfo(text, version, cluster, settings.User, keyspace);
    }

    private static async Task<string?> ScyllaVersionAsync(ISession session, CancellationToken ct)
    {
        try
        {
            var rows = (await session.ExecuteAsync(new SimpleStatement("SELECT version FROM system.versions WHERE key = 'local'")).WaitAsync(ct).ConfigureAwait(false)).ToList();
            return rows.Count > 0 ? CqlSchemaReader.Str(rows[0], "version") : null;
        }
        catch (DriverException)
        {
            return null; // not ScyllaDB
        }
    }

    /// <summary>Product family for the cluster view: "cassandra" | "scylla" | "dse".</summary>
    public static string ProductOf(ServerInfo info) =>
        info.Version.StartsWith("ScyllaDB", StringComparison.Ordinal) ? "scylla" : info.Version.StartsWith("DataStax", StringComparison.Ordinal) ? "dse" : "cassandra";
}
