using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.MySql;

/// <summary>
/// Composition root of the "mysql" and "mariadb" package (plan-batch3 WP-MY, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: no Program.cs edit. WP0 stub: registers nothing, so the provider id stays
/// unknown to <c>GET /providers</c> until WP-MY lands.
/// </summary>
public sealed class MySqlModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // WP-MY registers here: MySqlProvider ("mysql") and MariaDbProvider ("mariadb") as IDbProvider; keyed IDdlScripter/IDesignerDatabase/IPlanReader/IParamBinder and ILogSource/IActivitySource under both ids.
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // WP-MY maps its endpoints here.
    }
}
