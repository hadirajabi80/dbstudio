using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Logs;

/// <summary>
/// Composition root of the logs and activity package (docs/PLAN-M2.md 8, D9), discovered by <c>EngineModules.Discover</c>.
/// M2-L adds <c>ILogSource</c>/<c>IActivitySource</c> (keyed by provider id), the <c>logs.tail</c> and <c>activity.poll</c>
/// stream factories (<c>AddKeyedSingleton&lt;IStreamFactory&gt;("logs.tail", ...)</c>) and maps <c>/logs/{cid}/...</c>
/// (<c>cid = "engine"</c> for the engine log, see <c>StreamManager.EngineConnectionId</c>).
/// </summary>
public sealed class LogsModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // M2-L
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // M2-L: api.MapGroup("/logs/{cid}") ... (Endpoints/LogsEndpoints.cs)
    }
}
