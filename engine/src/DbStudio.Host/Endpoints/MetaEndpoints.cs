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

        // M2: every provider (relational and non-relational) in SourceRegistry.DisplayOrder:
        // sqlserver, oracle, postgresql, sqlite, redis, mongodb, kafka.
        api.MapGet("/providers", (SourceRegistry sources) =>
            sources.Describe().Select(p => new ProviderInfoResponse(p.Id, p.DisplayName, p.Dialect, p.FormSpec, p.Kind)));

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
