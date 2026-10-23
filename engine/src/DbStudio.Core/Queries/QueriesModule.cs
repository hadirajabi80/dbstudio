using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Queries;

/// <summary>
/// Saved queries (Navicat's per-schema "Queries" node): registers <see cref="SavedQueryStore"/> and maps
/// <c>/connections/{cid}/queries</c>. Discovered by <c>EngineModules.Discover</c> like <c>DiagramsModule</c>.
/// <list type="bullet">
/// <item><c>GET …/queries?database=&amp;schema=</c> lists (by name; an absent filter = all, an empty one = none set)</item>
/// <item><c>GET …/queries/{id}</c>, <c>POST …/queries</c> (201), <c>PUT …/queries/{id}</c> (rename / text / description)</item>
/// <item><c>DELETE …/queries/{id}</c> (204), <c>POST …/queries/{id}/duplicate</c> (201)</item>
/// </list>
/// An unknown connection or query is 404; an invalid body (or a name already used in that schema) 400 VALIDATION
/// naming the field.
/// </summary>
public sealed class QueriesModule : IEngineModule
{
    public void ConfigureServices(IServiceCollection services) => services.AddSingleton<SavedQueryStore>();

    public void MapEndpoints(RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections/{cid}/queries");

        g.MapGet("", (string cid, string? database, string? schema, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.List(cid, database, schema), CoreJson.Options);
        });

        g.MapGet("/{id}", (string cid, string id, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.Get(cid, id), CoreJson.Options);
        });

        g.MapPost("", (string cid, SavedQueryInput? input, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.Create(cid, input), CoreJson.Options, statusCode: StatusCodes.Status201Created);
        });

        g.MapPut("/{id}", (string cid, string id, SavedQueryPatch? patch, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.Update(cid, id, patch), CoreJson.Options);
        });

        g.MapPost("/{id}/duplicate", (string cid, string id, SavedQueryDuplicate? input, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            return Results.Json(store.Duplicate(cid, id, input), CoreJson.Options, statusCode: StatusCodes.Status201Created);
        });

        g.MapDelete("/{id}", (string cid, string id, SavedQueryStore store, ConnectionStore connections) =>
        {
            connections.Get(cid);
            if (!store.Delete(cid, id)) throw EngineException.NotFound($"Saved query '{id}'");
            return Results.NoContent();
        });
    }
}
