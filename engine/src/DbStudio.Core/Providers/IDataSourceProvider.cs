using DbStudio.Core.Models;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Providers;

/// <summary>
/// M2 (docs/PLAN-M2.md D1): a data source family that is not driven by SQL batches (Redis, MongoDB, Kafka). Stateless
/// singleton, registered by its feature module (<c>services.AddSingleton&lt;IDataSourceProvider, RedisProvider&gt;()</c>).
/// Relational <see cref="IDbProvider"/>s are listed next to these through <see cref="Services.RelationalSourceAdapter"/>,
/// so <see cref="Services.SourceRegistry"/> knows every provider id; <see cref="IDbProvider"/> itself stays frozen.
/// </summary>
public interface IDataSourceProvider
{
    /// <summary>"redis" | "mongodb" | "kafka" (relational adapters: "sqlserver" | "oracle" | "sqlite" | "postgresql").</summary>
    string Id { get; }
    string DisplayName { get; }
    SourceKind Kind { get; }

    /// <summary>Drives the generic connection dialog. Fields of type "password" are never persisted in props (D12).</summary>
    ConnectionFormSpec FormSpec { get; }

    /// <summary>Connects, reads <see cref="ServerInfo"/> and disconnects. Driver failures are returned, not thrown.</summary>
    Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct);

    /// <summary>
    /// Opens the long-lived client of one connection profile (D2). Called only by <see cref="Services.SourceClientManager"/>,
    /// which serializes opens per connection; the profile carries the extra secret fields (e.g. <c>saslPassword</c>).
    /// Throw on failure; the manager maps it to 503 SOURCE_UNAVAILABLE.
    /// </summary>
    Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct);
}

/// <summary>The shared driver handle of one connection (ConnectionMultiplexer, MongoClient, Kafka admin client...).</summary>
public interface IDataSourceClient : IAsyncDisposable
{
    string ConnectionId { get; }
    ServerInfo Server { get; }
    Task<bool> PingAsync(CancellationToken ct);

    /// <summary>Maintained by <see cref="Services.SourceClientManager"/> (every GetAsync); drives the idle reaper.</summary>
    DateTimeOffset LastUsed { get; set; }
}

/// <summary>
/// M2 (docs/PLAN-M2.md D4): a feature package's composition root. Non-abstract implementations with a public parameterless
/// constructor are discovered by <see cref="Services.EngineModules.Discover"/> in the DbStudio assemblies the Host references;
/// <see cref="ConfigureServices"/> runs before the app is built, <see cref="MapEndpoints"/> after, on the <c>/api/v1</c> group.
/// </summary>
public interface IEngineModule
{
    void ConfigureServices(IServiceCollection services);

    void MapEndpoints(RouteGroupBuilder api);
}
