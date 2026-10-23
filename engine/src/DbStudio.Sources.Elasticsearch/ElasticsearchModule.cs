using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Elasticsearch.Endpoints;
using DbStudio.Sources.Elasticsearch.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>
/// Composition root of the "elasticsearch" package (plan-batch3 WP-ES, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: the provider (kind <c>search</c>), the services, the <c>es.tasks</c> stream
/// factory and <c>/es/{cid}/...</c>.
/// </summary>
public sealed class ElasticsearchModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider>(_ => new EsProvider());
        AddServices(services);
    }

    /// <summary>Everything but the provider (tests register a provider over a fake server).</summary>
    public static void AddServices(IServiceCollection services)
    {
        services.AddSingleton<ClusterService>();
        services.AddSingleton<IndexService>();
        services.AddSingleton<SearchService>();
        services.AddSingleton<DocumentService>();
        services.AddSingleton<ConsoleService>();
        services.AddSingleton<SqlService>();
        services.AddSingleton<TaskService>();
        services.AddSingleton<JobsService>();
        services.AddKeyedSingleton<IStreamFactory, TasksStreamFactory>("es.tasks");
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapElasticsearch();
}
