using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

public static class HistoryAndSqlEndpoints
{
    public static RouteGroupBuilder MapHistory(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/history");

        g.MapGet("", (string? connectionId, string? q, int? limit, long? before, HistoryService history, CancellationToken ct) =>
            history.SearchAsync(connectionId, q, limit ?? 200, before, ct));

        g.MapPut("/{id:long}", async (long id, HistoryUpdateRequest? req, HistoryService history, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("pinned is required.", new { field = "pinned" });
            if (!await history.SetPinnedAsync(id, req.Pinned, ct)) throw EngineException.NotFound($"History entry {id}");
            return Results.NoContent();
        });

        g.MapDelete("/{id:long}", async (long id, HistoryService history, CancellationToken ct) =>
        {
            if (!await history.DeleteAsync(id, ct)) throw EngineException.NotFound($"History entry {id}");
            return Results.NoContent();
        });

        g.MapDelete("", async (string? connectionId, HistoryService history, CancellationToken ct) =>
        {
            await history.ClearAsync(connectionId, ct);
            return Results.NoContent();
        });

        return api;
    }

    public static RouteGroupBuilder MapSql(this RouteGroupBuilder api)
    {
        api.MapPost("/sql/diagnostics", async (DiagnosticsRequest? req, ProviderRegistry providers, ConnectionStore connections, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("A request body is required.");
            var provider = providers.ForDialect(req.Dialect)
                           ?? throw new EngineException(400, ErrorCodes.NotSupported, $"No provider for dialect {CoreJson.ToWire(req.Dialect)}.");
            Core.Models.ConnectionProfile? profile = null;
            string? password = null;
            if (!string.IsNullOrWhiteSpace(req.ConnectionId))
            {
                profile = connections.Get(req.ConnectionId);
                if (!profile.ProviderId.Equals(provider.Id, StringComparison.OrdinalIgnoreCase))
                {
                    provider = providers.Get(profile.ProviderId);
                    if (provider.Dialect != req.Dialect)
                        throw EngineException.Validation("The connection's dialect does not match the requested dialect.", new { field = "dialect" });
                }
                password = connections.GetPassword(profile.Id);
            }
            var diagnostics = provider.Diagnostics
                              ?? throw new EngineException(400, ErrorCodes.NotSupported, $"Server diagnostics are not available for {provider.DisplayName} in this version.");
            var result = await diagnostics.AnalyzeAsync(req.Sql ?? "", profile, password, ct);
            return new DiagnosticsResponse(result, diagnostics.EngineName);
        });

        return api;
    }
}
