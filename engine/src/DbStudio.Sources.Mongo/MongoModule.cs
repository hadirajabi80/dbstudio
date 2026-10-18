using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// Composition root of the Mongo package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>.
/// M2-M adds its services, <c>AddKeyedSingleton&lt;IStreamFactory&gt;("mongo.changes", ...)</c> and
/// maps <c>/mongo/{cid}/...</c> on <paramref name="api"/> (the <c>/api/v1</c> group).
/// </summary>
public sealed class MongoModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider, MongoProvider>();
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // M2-M: api.MapGroup("/mongo/{cid}") ... (Endpoints/MongoEndpoints.cs)
    }
}
