using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

public static class HistoryAndSqlEndpoints
{
    public static RouteGroupBuilder MapHistory(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/history");

        g.MapGet("", (string? connectionId, string? q, int? limit, long? before, string? status, string? from, string? to, bool? pinned,
            HistoryService history, CancellationToken ct) =>
            history.SearchAsync(connectionId, q, limit ?? 200, before, ParseFilter(status, from, to, pinned), ct));

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

    /// <summary>M1.5 history filters: status=ok,error&amp;from=ISO&amp;to=ISO&amp;pinned=true.</summary>
    internal static HistoryFilter ParseFilter(string? status, string? from, string? to, bool? pinned)
    {
        List<string>? statuses = null;
        if (!string.IsNullOrWhiteSpace(status))
        {
            statuses = status.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(x => x.ToLowerInvariant()).Distinct().ToList();
            var bad = statuses.FirstOrDefault(x => x is not ("ok" or "error" or "cancelled"));
            if (bad is not null) throw EngineException.Validation($"status '{bad}' must be ok, error or cancelled.", new { field = "status" });
        }
        return new HistoryFilter(statuses, ParseTime(from, "from"), ParseTime(to, "to"), pinned == true);
    }

    private static DateTimeOffset? ParseTime(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (DateTimeOffset.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var t)) return t;
        throw EngineException.Validation($"{field} must be an ISO 8601 timestamp.", new { field });
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
