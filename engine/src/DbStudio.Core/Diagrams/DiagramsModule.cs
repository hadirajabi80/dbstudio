using DbStudio.Core.Providers;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Diagrams;

/// <summary>
/// Composition root of the ER diagram package (docs/PLAN-M2.md section 3, D4): registers <see cref="DiagramStore"/>.
/// The routes (<c>/connections/{cid}/er/layouts</c>) are mapped by the Host's <c>DiagramEndpoints</c> module, which
/// owns the HTTP shapes; both are discovered by <c>EngineModules.Discover</c>.
/// </summary>
public sealed class DiagramsModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services) => services.AddSingleton<DiagramStore>();

    public void MapEndpoints(RouteGroupBuilder api)
    {
    }
}
