using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Composition root of the "snowflake" package (plan-batch3 WP-SF, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: no Program.cs edit. WP0 stub: registers nothing, so the provider id stays
/// unknown to <c>GET /providers</c> until WP-SF lands.
/// </summary>
public sealed class SnowflakeModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // WP-SF registers here: SnowflakeProvider ("snowflake") as IDbProvider; keyed IDdlScripter/IDesignerDatabase/IPlanReader/IParamBinder/ILogSource/IActivitySource; /snowflake/... endpoints.
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // WP-SF maps its endpoints here.
    }
}
