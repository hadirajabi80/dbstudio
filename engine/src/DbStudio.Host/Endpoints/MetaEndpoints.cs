using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

public static class MetaEndpoints
{
    public static RouteGroupBuilder MapMeta(this RouteGroupBuilder api)
    {
        api.MapGet("/health", (EngineOptions o) =>
            new HealthResponse("ok", typeof(MetaEndpoints).Assembly.GetName().Version?.ToString(3) ?? "0.1.0", Environment.ProcessId, o.Dev));

        api.MapGet("/providers", (ProviderRegistry providers) =>
            providers.All.OrderBy(p => p.Id switch { "sqlserver" => 0, "oracle" => 1, _ => 2 })
                .Select(p => new ProviderInfoResponse(p.Id, p.DisplayName, p.Dialect, p.FormSpec)));

        api.MapGet("/settings", (SettingsService settings) => Results.Json(settings.Get(), CoreJson.Options));

        api.MapPut("/settings", (JsonObject? patch, SettingsService settings) =>
        {
            if (patch is null) throw EngineException.Validation("A JSON object is required.");
            return Results.Json(settings.Update(patch), CoreJson.Options);
        });

        api.MapPost("/sql/format", () =>
            Infrastructure.ErrorEnvelope.Result(400, ErrorCodes.NotSupported, "SQL formatting is planned for M2."));

        return api;
    }
}
