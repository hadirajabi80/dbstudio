using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Endpoints;
using DbStudio.Sources.Redis.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Redis;

/// <summary>
/// Composition root of the Redis package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>:
/// the provider, the key/value/command/info/analysis services, the <c>redis.monitor</c> and <c>redis.subscribe</c>
/// stream factories and the <c>/redis/{cid}/…</c> endpoints.
/// </summary>
public sealed class RedisModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider, RedisProvider>();
        services.AddSingleton<KeyBrowser>();
        services.AddSingleton<ValueService>();
        services.AddSingleton<CommandService>();
        services.AddSingleton<InfoService>();
        services.AddSingleton<AnalysisService>();
        services.AddKeyedSingleton<IStreamFactory>("redis.monitor", (sp, _) => new MonitorStreamFactory(sp.GetRequiredService<SourceClientManager>()));
        services.AddKeyedSingleton<IStreamFactory>("redis.subscribe", (sp, _) => new PubSubStreamFactory(sp.GetRequiredService<SourceClientManager>()));
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapRedis();
}
