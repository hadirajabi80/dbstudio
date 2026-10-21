using DbStudio.Core.Diagrams;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Host.Endpoints;

/// <summary>
/// M2 ER diagram layouts (docs/PLAN-M2.md section 3):
/// <c>GET /connections/{cid}/er/layouts?database=&amp;scope=</c> lists, <c>PUT …/{id}</c> upserts,
/// <c>DELETE …/{id}</c> removes. <c>scope</c> is a scope key (<see cref="DiagramStore.ScopeKey"/>); an unknown
/// connection is 404, an invalid body 400 VALIDATION naming the field.
/// </summary>
public sealed class DiagramEndpoints : IEngineModule
{
    public void ConfigureServices(IServiceCollection services)
    {
        // DiagramStore is registered by Core's DiagramsModule.
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections/{cid}/er/layouts");

        g.MapGet("", (string cid, string? database, string? scope, DiagramStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.List(cid, database, scope), CoreJson.Options);
        });

        g.MapPut("/{id}", (string cid, string id, DiagramLayout? layout, DiagramStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.Save(cid, id, layout), CoreJson.Options);
        });

        g.MapDelete("/{id}", (string cid, string id, DiagramStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            if (!store.Delete(cid, id)) throw EngineException.NotFound($"Diagram layout '{id}'");
            return Results.NoContent();
        });
    }
}
