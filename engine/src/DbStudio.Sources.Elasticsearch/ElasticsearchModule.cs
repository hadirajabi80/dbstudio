using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>
/// Composition root of the "elasticsearch" package (plan-batch3 WP-ES, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: no Program.cs edit. WP0 stub: registers nothing, so the provider id stays
/// unknown to <c>GET /providers</c> until WP-ES lands.
/// </summary>
public sealed class ElasticsearchModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // WP-ES registers here: EsProvider ("elasticsearch", SourceKind.Search) as IDataSourceProvider; services; IStreamFactory "es.tasks"; /es/{cid}/... endpoints.
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // WP-ES maps its endpoints here.
    }
}
