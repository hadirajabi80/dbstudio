using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Redis;

/// <summary>
/// Composition root of the Redis package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>.
/// M2-R adds its services, <c>AddKeyedSingleton&lt;IStreamFactory&gt;("redis.monitor" | "redis.subscribe", ...)</c> and
/// maps <c>/redis/{cid}/...</c> on <paramref name="api"/> (the <c>/api/v1</c> group).
/// </summary>
public sealed class RedisModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider, RedisProvider>();
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // M2-R: api.MapGroup("/redis/{cid}") ... (Endpoints/RedisEndpoints.cs)
    }
}
