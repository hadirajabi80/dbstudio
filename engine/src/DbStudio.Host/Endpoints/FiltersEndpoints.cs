using DbStudio.Core.Filters;
using DbStudio.Core.Services;

namespace DbStudio.Host.Endpoints;

/// <summary>M1.5 saved filters (docs/PLAN-M1.5.md 3.7).</summary>
public static class FiltersEndpoints
{
    public static RouteGroupBuilder MapFilters(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/filters");

        g.MapGet("", (string? connectionId, string? signature, FilterStore filters) =>
            filters.List(connectionId ?? "", signature));

        g.MapPost("", (SavedFilterInput? input, FilterStore filters, ConnectionStore connections) =>
        {
            if (!string.IsNullOrWhiteSpace(input?.ConnectionId)) connections.Get(input.ConnectionId); // 404 for unknown connections
            var created = filters.Create(input);
            return Results.Json(created, CoreJson.Options, statusCode: StatusCodes.Status201Created);
        });

        g.MapPut("/{id}", (string id, SavedFilterPatch? patch, FilterStore filters) => filters.Update(id, patch));

        g.MapDelete("/{id}", (string id, FilterStore filters) =>
        {
            if (!filters.Delete(id)) throw EngineException.NotFound($"Filter '{id}'");
            return Results.NoContent();
        });

        return api;
    }
}
