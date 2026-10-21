using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs.Endpoints;
using DbStudio.Logs.Providers.Kafka;
using DbStudio.Logs.Providers.Mongo;
using DbStudio.Logs.Providers.Oracle;
using DbStudio.Logs.Providers.PostgreSql;
using DbStudio.Logs.Providers.Redis;
using DbStudio.Logs.Providers.SqlServer;
using DbStudio.Logs.Sql;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace DbStudio.Logs;

/// <summary>
/// Composition root of the logs and activity package (docs/PLAN-M2.md 8, D9), discovered by <c>EngineModules.Discover</c>.
/// Registers the per-provider <see cref="ILogSource"/>/<see cref="IActivitySource"/> (keyed by provider id; SQLite has
/// none, so its Logs tab shows the engine log only), the gateway seams (TryAdd: an integrator may register adapters over
/// the M2-R/M/K clients first), the <c>logs.tail</c> and <c>activity.poll</c> stream factories and <c>/logs/{cid}/…</c>.
/// </summary>
public sealed class LogsModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        services.TryAddSingleton(sp => new EngineLogSource(sp.GetRequiredService<AppPaths>().LogsDir));
        services.TryAddSingleton<ISqlRunnerFactory>(sp => new SessionSqlRunnerFactory(sp.GetRequiredService<ProviderRegistry>(), sp.GetRequiredService<ConnectionStore>(),
            sp.GetService<Microsoft.Extensions.Logging.ILogger<SessionSqlRunnerFactory>>()));
        services.TryAddSingleton<IRedisLogGateway>(sp => new RespRedisGateway(sp.GetRequiredService<ConnectionStore>().GetPassword));
        services.TryAddSingleton<IMongoLogGateway>(sp => new ReflectionMongoGateway(sp.GetRequiredService<SourceClientManager>()));
        services.TryAddSingleton<IKafkaLogGateway>(sp => new ReflectionKafkaGateway(sp.GetRequiredService<SourceClientManager>(), sp));

        services.AddSingleton<SqlServerLogSource>();
        services.AddSingleton<OracleLogSource>();
        services.AddSingleton<PgLogSource>();
        services.AddSingleton<RedisLogSource>();
        services.AddSingleton<MongoLogSource>();
        services.AddSingleton(sp => new KafkaLogSource(sp.GetRequiredService<IKafkaLogGateway>(), sp.GetRequiredService<JobManager>(), () => sp.GetService<StreamManager>()));
        Keyed<SqlServerLogSource>(services, "sqlserver");
        Keyed<OracleLogSource>(services, "oracle");
        Keyed<PgLogSource>(services, "postgresql");
        Keyed<RedisLogSource>(services, "redis");
        Keyed<MongoLogSource>(services, "mongodb");
        Keyed<KafkaLogSource>(services, "kafka");

        services.AddSingleton(LogService.FromServices);
        services.AddKeyedSingleton<IStreamFactory>(LogTailStreamFactory.Kind, (sp, _) =>
            new LogTailStreamFactory(sp.GetRequiredService<LogService>(), () => TailInterval(sp.GetService<SettingsService>())));
        services.AddKeyedSingleton<IStreamFactory>(ActivityPollStreamFactory.Kind, (sp, _) => new ActivityPollStreamFactory(sp.GetRequiredService<LogService>()));
    }

    private static void Keyed<T>(IServiceCollection services, string providerId) where T : class, ILogSource, IActivitySource
    {
        services.AddKeyedSingleton<ILogSource>(providerId, (sp, _) => sp.GetRequiredService<T>());
        services.AddKeyedSingleton<IActivitySource>(providerId, (sp, _) => sp.GetRequiredService<T>());
    }

    /// <summary>settings logs.tailIntervalMs (default 2000).</summary>
    public static int TailInterval(SettingsService? settings)
    {
        var node = settings?.Get()["logs"]?["tailIntervalMs"];
        return node is null ? 2000 : (int)Math.Clamp(SettingsService.Number(node), 250, 600_000);
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapLogs();
}
