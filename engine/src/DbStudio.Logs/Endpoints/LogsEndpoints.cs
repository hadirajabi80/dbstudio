using DbStudio.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Logs.Endpoints;

/// <summary>
/// <c>/api/v1/logs/{cid}/…</c> (docs/PLAN-M2.md 8.1; <c>cid = "engine"</c> addresses the engine log):
/// <list type="bullet">
/// <item><c>GET sources[?refresh=true]</c> → LogSourceInfo[] (cached five minutes per connection).</item>
/// <item><c>POST query { LogQuery }</c> → <c>{ entries, hasMore, truncated }</c> (403 PRIVILEGE with <c>detail.needs</c>).</item>
/// <item><c>GET activity</c> → one ActivitySnapshot (the <c>activity.poll</c> stream sends the same shape).</item>
/// <item><c>POST kill { id, kind, mode? }</c> → <c>{ killed, message }</c> (403 READ_ONLY on read-only profiles).</item>
/// <item><c>POST export { …LogQuery, format, path }</c> → 202 { jobId } (job result LogExportResult), or the file when path is null.</item>
/// </list>
/// </summary>
public static class LogsEndpoints
{
    public static RouteGroupBuilder MapLogs(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/logs/{cid}");

        g.MapGet("/sources", async (string cid, bool? refresh, LogService logs, CancellationToken ct) =>
            Results.Json(await logs.ListAsync(cid, refresh == true, ct), CoreJson.Options));

        g.MapPost("/query", async (string cid, LogQuery? query, LogService logs, CancellationToken ct) =>
            Results.Json(await logs.QueryAsync(cid, query, ct), CoreJson.Options));

        g.MapGet("/activity", async (string cid, LogService logs, CancellationToken ct) =>
            Results.Json(await logs.SnapshotAsync(cid, ct), CoreJson.Options));

        g.MapPost("/kill", async (string cid, LogKillRequest? body, LogService logs, CancellationToken ct) =>
            Results.Json(await logs.KillAsync(cid, body, ct), CoreJson.Options));

        g.MapPost("/export", async (string cid, LogExportRequest? body, LogService logs, JobManager jobs, HttpContext http, CancellationToken ct) =>
        {
            if (body is null) throw EngineException.Validation("An export body is required.");
            var format = LogExporter.Validate(body.Format);
            var query = LogFilter.Validate(body.ToQuery());
            logs.Target(cid); // 404 before starting a job
            if (string.IsNullOrWhiteSpace(body.Path))
            {
                var entries = await LogExporter.CollectAsync(logs, cid, query, null, ct);
                var ms = new MemoryStream();
                await LogExporter.WriteAsync(ms, format, entries, ct);
                return Results.File(ms.ToArray(), LogExporter.ContentType(format), LogExporter.FileName(query.SourceId!, format, DateTimeOffset.Now));
            }
            var path = body.Path.Trim();
            if (!Path.IsPathFullyQualified(path)) throw EngineException.Validation("path must be an absolute file path.", new { field = "path" });
            var dir = Path.GetDirectoryName(path);
            if (dir is null || !Directory.Exists(dir)) throw EngineException.Validation($"The folder '{dir}' does not exist.", new { field = "path" });
            var owner = ClientPresence.Normalize(http.Request.Headers["X-DbStudio-Client"].ToString());
            var jobId = jobs.Start("logs.export", LogService.IsEngine(cid) ? null : cid, owner, async (job, jct) =>
            {
                var entries = await LogExporter.CollectAsync(logs, cid, query, n => job.Report(n, null, $"{n:N0} entries"), jct);
                var temp = path + ".partial";
                await using (var fs = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                    await LogExporter.WriteAsync(fs, format, entries, jct);
                File.Move(temp, path, overwrite: true);
                job.Report(entries.Count, entries.Count, "done", force: true);
                return new LogExportResult(path, entries.Count);
            });
            return Results.Json(new JobStarted(jobId), CoreJson.Options, statusCode: 202);
        });

        return api;
    }
}
