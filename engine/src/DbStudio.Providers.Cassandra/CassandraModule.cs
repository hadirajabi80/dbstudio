using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Composition root of the "cassandra" package (plan-batch3 WP-CS, D6), discovered by <c>EngineModules.Discover</c> through the
/// anchor in <c>Host/ModuleAssemblies.cs</c>: no Program.cs edit. WP0 stub: registers nothing, so the provider id stays
/// unknown to <c>GET /providers</c> until WP-CS lands.
/// </summary>
public sealed class CassandraModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // WP-CS registers here: CassandraProvider ("cassandra") as IDbProvider; keyed IDdlScripter/IDesignerDatabase (CQL subset); /cassandra/... endpoints (consistency, tracing, cluster).
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // WP-CS maps its endpoints here.
    }
}
