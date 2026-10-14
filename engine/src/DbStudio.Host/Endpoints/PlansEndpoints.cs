using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

/// <summary>M1.5 explain plan endpoint (docs/PLAN-M1.5.md 3.8): 202 { executionId }, then exec.* events and exec.plan.</summary>
public static class PlansEndpoints
{
    public static RouteGroupBuilder MapPlans(this RouteGroupBuilder api)
    {
        api.MapPost("/sessions/{sid}/explain", (string sid, ExplainRequestDto? req, SessionManager sessions, ExecutionService executions,
            ProviderFeatures features, SettingsService settings) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.Sql)) throw EngineException.Validation("sql is required.", new { field = "sql" });
            var mode = string.IsNullOrWhiteSpace(req.Mode) ? ExplainModes.Estimated : req.Mode.Trim().ToLowerInvariant();
            var h = sessions.Get(sid);
            var reader = features.PlanReader(h.Provider.Id);
            var started = executions.StartExplain(sid, new ExplainCommand(
                req.Sql, mode, req.MaxRows ?? settings.DefaultMaxRows(), req.Params is { Count: > 0 } ps ? ps : null,
                req.Line ?? 1, req.Col ?? 1, req.ConfirmedDestructive ?? false, req.Source?.TabId, req.Source?.Title), reader);
            return Results.Json(new ExecuteResponse(started.ExecutionId, started.StartedAt), CoreJson.Options, statusCode: StatusCodes.Status202Accepted);
        });
        return api;
    }
}
