using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using DbStudio.Sources.Mongo.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// Composition root of the Mongo package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>: the
/// provider, the services, the <c>mongo.changes</c> stream factory and the <c>/mongo/{cid}/…</c> endpoints.
/// </summary>
public sealed class MongoModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider, MongoProvider>();
        AddServices(services);
    }

    /// <summary>The Mongo services without the provider (tests register a provider over the fake).</summary>
    public static void AddServices(IServiceCollection services)
    {
        services.AddSingleton<ExplorerService>();
        services.AddSingleton<DocumentsService>();
        services.AddSingleton<AggregateService>();
        services.AddSingleton<ExplainService>();
        services.AddSingleton<SchemaService>();
        services.AddSingleton<FieldsService>();
        services.AddSingleton<IndexesService>();
        services.AddSingleton<ValidationService>();
        services.AddSingleton<ProfilingService>();
        services.AddSingleton<ImportExportService>();
        services.AddKeyedSingleton<IStreamFactory, MongoChangeStreamFactory>("mongo.changes");
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapMongo();
}
