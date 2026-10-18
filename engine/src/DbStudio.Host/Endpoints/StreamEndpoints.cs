using DbStudio.Core.Services;
using DbStudio.Host.Contracts;
using DbStudio.Host.Infrastructure;

namespace DbStudio.Host.Endpoints;

/// <summary>
/// M2 (docs/PLAN-M2.md 1.1, 2.3, 2.4): engine streams and jobs.
/// <list type="bullet">
/// <item><c>POST /streams { kind, connectionId, params }</c> → <c>202 { streamId }</c>; items arrive as <c>stream.data</c>.</item>
/// <item><c>POST /streams/{id}/pause|resume</c> → StreamInfo; <c>DELETE /streams/{id}</c> → 204; <c>GET /streams</c>.</item>
/// <item><c>GET /jobs</c>; <c>DELETE /jobs/{id}</c> cancels (the job ends with <c>job.done{cancelled}</c>).</item>
/// </list>
/// </summary>
public static class StreamEndpoints
{
    public static RouteGroupBuilder MapStreams(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/streams");

        g.MapPost("", async (StreamOpenRequest? req, StreamManager streams, HttpContext http, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("A stream body is required.");
            var info = await streams.OpenAsync(req.Kind ?? "", req.ConnectionId ?? "", req.Params, http.ClientId(), ct);
            return Results.Json(new StreamOpenResponse(info.StreamId), CoreJson.Options, statusCode: 202);
        });

        g.MapGet("", (StreamManager streams) => streams.List());

        g.MapPost("/{id}/pause", (string id, StreamManager streams) => streams.Pause(id));

        g.MapPost("/{id}/resume", (string id, StreamManager streams) => streams.Resume(id));

        g.MapDelete("/{id}", async (string id, StreamManager streams) =>
        {
            if (!await streams.CloseAsync(id)) throw EngineException.NotFound($"Stream '{id}'");
            return Results.NoContent();
        });

        var jobs = api.MapGroup("/jobs");

        jobs.MapGet("", (JobManager manager) => manager.List());

        jobs.MapDelete("/{id}", (string id, JobManager manager) =>
        {
            if (!manager.Cancel(id)) throw EngineException.NotFound($"Job '{id}'");
            return Results.NoContent();
        });

        return api;
    }
}
