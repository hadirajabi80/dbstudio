using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Endpoints;
using DbStudio.Sources.Kafka.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// Composition root of the Kafka package (docs/PLAN-M2.md 2.1, D4), discovered by <c>EngineModules.Discover</c>:
/// the provider, the services, the <c>kafka.tail</c> / <c>kafka.fetch</c> stream factories and <c>/kafka/{cid}/...</c>.
/// </summary>
public sealed class KafkaModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDataSourceProvider>(_ => new KafkaProvider());
        AddServices(services);
    }

    /// <summary>Everything but the provider (tests register a provider over KafkaFake).</summary>
    public static void AddServices(IServiceCollection services)
    {
        services.AddSingleton<ClusterService>();
        services.AddSingleton<TopicService>();
        services.AddSingleton<MessageBrowser>();
        services.AddSingleton<ProduceService>();
        services.AddSingleton<GroupService>();
        services.AddSingleton<SchemaService>();
        services.AddSingleton<FetchRelays>();
        services.AddKeyedSingleton<IStreamFactory, TailStreamFactory>("kafka.tail");
        services.AddKeyedSingleton<IStreamFactory, FetchStreamFactory>("kafka.fetch");
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapKafka();
}
