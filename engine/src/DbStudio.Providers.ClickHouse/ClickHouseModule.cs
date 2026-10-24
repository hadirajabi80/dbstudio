using DbStudio.Core.Designer;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Logs;
using DbStudio.Logs.Providers.ClickHouse;
using DbStudio.Providers.ClickHouse.Designer;
using DbStudio.Providers.ClickHouse.Endpoints;
using DbStudio.Providers.ClickHouse.Params;
using DbStudio.Providers.ClickHouse.Plans;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Composition root of the "clickhouse" package (plan-batch3 WP-CH, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: the provider, its keyed designer/plan/param services, the log and activity
/// source (<c>DbStudio.Logs.Providers.ClickHouse</c>) and the <c>/clickhouse/{cid}/…</c> endpoints (parts, mutations, merges).
/// </summary>
public sealed class ClickHouseModule : IEngineModule
{
    public const string ProviderId = "clickhouse";

    public void ConfigureServices(IServiceCollection services)
    {
        var provider = new ClickHouseProvider();
        services.AddSingleton(provider);
        services.AddSingleton<IDbProvider>(provider);
        services.AddKeyedSingleton<IDdlScripter, ChDdlScripter>(ProviderId);
        services.AddKeyedSingleton<IDesignerDatabase>(ProviderId, (_, _) => new ChDesignerDatabase(provider));
        services.AddKeyedSingleton<IPlanReader, ChPlanReader>(ProviderId);
        services.AddKeyedSingleton<IParamBinder>(ProviderId, ChParamBinder.Instance);
        services.AddSingleton<ChLogSource>();
        services.AddKeyedSingleton<ILogSource>(ProviderId, (sp, _) => sp.GetRequiredService<ChLogSource>());
        services.AddKeyedSingleton<IActivitySource>(ProviderId, (sp, _) => sp.GetRequiredService<ChLogSource>());
        services.AddSingleton<ChAdminService>();
    }

    public void MapEndpoints(RouteGroupBuilder api) => api.MapClickHouse();
}
