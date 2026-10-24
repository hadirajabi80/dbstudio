using DbStudio.Core.Designer;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Cassandra.Designer;
using DbStudio.Providers.Cassandra.Endpoints;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Composition root of the "cassandra" package (plan-batch3 WP-CS, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: the provider (relational, dialect cql), its designer services and the
/// <c>/cassandra/...</c> endpoints. Explain plans answer NOT_SUPPORTED with a pointer to tracing (a keyed plan reader whose
/// resolution throws, so the shared endpoint returns this provider's message).
/// </summary>
public sealed class CassandraModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<CqlClusterPool>();
        services.AddSingleton<CassandraProvider>();
        services.AddSingleton<IDbProvider>(sp => sp.GetRequiredService<CassandraProvider>());
        services.AddKeyedSingleton<IDdlScripter, CqlDdlScripter>(CassandraProvider.ProviderId);
        services.AddKeyedSingleton<IDesignerDatabase>(CassandraProvider.ProviderId, (sp, _) => new CqlDesignerDatabase(sp.GetRequiredService<CassandraProvider>()));
        services.AddKeyedTransient<IPlanReader>(CassandraProvider.ProviderId,
            (_, _) => throw new EngineException(400, ErrorCodes.NotSupported, CqlSession.NoExplainMessage));
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapCassandra();
}
