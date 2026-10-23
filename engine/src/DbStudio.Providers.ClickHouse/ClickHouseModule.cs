using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Composition root of the "clickhouse" package (plan-batch3 WP-CH, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: no Program.cs edit. WP0 stub: registers nothing, so the provider id stays
/// unknown to <c>GET /providers</c> until WP-CH lands.
/// </summary>
public sealed class ClickHouseModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // WP-CH registers here: ClickHouseProvider ("clickhouse") as IDbProvider; keyed IDdlScripter/IDesignerDatabase/IPlanReader/IParamBinder/ILogSource/IActivitySource; /clickhouse/... endpoints.
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // WP-CH maps its endpoints here.
    }
}
