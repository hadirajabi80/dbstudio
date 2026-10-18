using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// Composition root of the Kafka package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>.
/// M2-K adds its services, <c>AddKeyedSingleton&lt;IStreamFactory&gt;("kafka.tail" | "kafka.fetch", ...)</c> and
/// maps <c>/kafka/{cid}/...</c> on <paramref name="api"/> (the <c>/api/v1</c> group).
/// </summary>
public sealed class KafkaModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider, KafkaProvider>();
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // M2-K: api.MapGroup("/kafka/{cid}") ... (Endpoints/KafkaEndpoints.cs)
    }
}
