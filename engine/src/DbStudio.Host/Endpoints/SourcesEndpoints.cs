using DbStudio.Core.Services;

namespace DbStudio.Host.Endpoints;

/// <summary>
/// M2 (docs/PLAN-M2.md 1.1, D2): the long-lived clients of non-relational connections.
/// <c>GET /sources/clients</c>; <c>GET /sources/{cid}/client</c> opens lazily (503 SOURCE_UNAVAILABLE on failure);
/// <c>DELETE /sources/{cid}/client</c> disconnects (streams on it end with reason "source-closed").
/// </summary>
public static class SourcesEndpoints
{
    public static RouteGroupBuilder MapSources(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/sources");

        g.MapGet("/clients", (SourceClientManager clients) => clients.List());

        g.MapGet("/{cid}/client", async (string cid, SourceClientManager clients, CancellationToken ct) =>
        {
            await clients.GetAsync(cid, ct);
            return clients.Info(cid) ?? throw EngineException.SourceUnavailable("The source client closed while opening.", new { connectionId = cid });
        });

        g.MapDelete("/{cid}/client", async (string cid, SourceClientManager clients) =>
        {
            await clients.CloseAsync(cid);
            return Results.NoContent();
        });

        return api;
    }
}
