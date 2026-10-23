using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Elasticsearch.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Sources.Elasticsearch.Endpoints;

/// <summary>
/// REST surface of the Elasticsearch / OpenSearch source (plan-batch3 WP-ES) under <c>/api/v1/es/{cid}</c>; wire types
/// in EsModels.cs (UI mirror ui/src/api/types.es.ts). Writes answer 403 READ_ONLY on read-only connections; long
/// operations (reindex, import, export to a file) answer <c>202 { jobId }</c>.
/// </summary>
public static class EsEndpoints
{
    public const string ClientHeader = "X-DbStudio-Client";

    /// <summary>The connection's client (opens lazily; 503 SOURCE_UNAVAILABLE; 400 when the connection is not Elasticsearch).</summary>
    public static async Task<EsClient> ClientAsync(SourceClientManager clients, string cid, CancellationToken ct) =>
        await clients.GetAsync(cid, ct).ConfigureAwait(false) as EsClient
            ?? throw EngineException.Validation($"Connection '{cid}' is not an Elasticsearch connection.", new { field = "connectionId" });

    private static IResult Json(object? value) => Results.Json(value, CoreJson.Options);

    private static IResult Started(string jobId) => Results.Json(new JobStarted(jobId), CoreJson.Options, statusCode: 202);

    private static string? ClientId(HttpContext http) => ClientPresence.Normalize(http.Request.Headers[ClientHeader].ToString());

    /// <summary>Reads the JSON body with the engine conventions; an empty body is a default instance.</summary>
    public static async Task<T> BodyAsync<T>(HttpContext http, CancellationToken ct) where T : new()
    {
        using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
        var text = await reader.ReadToEndAsync(ct).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text)) return new T();
        try
        {
            return JsonSerializer.Deserialize<T>(text, CoreJson.Options) ?? new T();
        }
        catch (JsonException ex)
        {
            throw EngineException.Validation($"The request body is not valid: {ex.Message}", new { field = ex.Path?.TrimStart('$', '.') ?? "body" });
        }
    }

    private static string StartJob(JobManager jobs, SourceClientManager clients, HttpContext http, string kind, string cid,
        Func<JobContext, CancellationToken, Task<object?>> work)
    {
        var lease = clients.AcquireLease(cid);
        try
        {
            return jobs.Start(kind, cid, ClientId(http), async (ctx, ct) =>
            {
                using (lease) return await work(ctx, ct).ConfigureAwait(false);
            });
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    private static string SafeFileName(string name)
    {
        var sb = new StringBuilder();
        foreach (var ch in name) sb.Append(ch is '"' or '\\' or '/' or ':' or '*' or '?' or '<' or '>' or '|' or ',' || char.IsControl(ch) ? '_' : ch);
        return sb.ToString();
    }

    public static RouteGroupBuilder MapElasticsearch(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/es/{cid}");

        // ---- cluster
        g.MapGet("/cluster", async (string cid, SourceClientManager clients, ClusterService svc, CancellationToken ct) =>
            Json(await svc.ClusterAsync(await ClientAsync(clients, cid, ct), ct)));
        g.MapGet("/nodes", async (string cid, SourceClientManager clients, ClusterService svc, CancellationToken ct) =>
            Json(await svc.NodesAsync(await ClientAsync(clients, cid, ct), ct)));

        // ---- indices
        g.MapGet("/indices", async (string cid, bool? hidden, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.ListAsync(await ClientAsync(clients, cid, ct), hidden ?? false, ct)));
        g.MapPost("/indices", async (string cid, HttpContext http, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            await svc.CreateAsync(c, await BodyAsync<EsCreateIndexRequest>(http, ct), ct);
            return Results.NoContent();
        });
        g.MapGet("/indices/{index}", async (string cid, string index, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.DetailAsync(await ClientAsync(clients, cid, ct), EsNames.Target(index), ct)));
        g.MapDelete("/indices/{index}", async (string cid, string index, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
        {
            await svc.DeleteAsync(await ClientAsync(clients, cid, ct), index, ct);
            return Results.NoContent();
        });
        g.MapPost("/indices/{index}/actions/{action}", async (string cid, string index, string action, SourceClientManager clients, IndexService svc,
            CancellationToken ct) => Json(await svc.ActionAsync(await ClientAsync(clients, cid, ct), index, action, ct)));
        g.MapPut("/indices/{index}/settings", async (string cid, string index, HttpContext http, SourceClientManager clients, IndexService svc,
            CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            await svc.UpdateSettingsAsync(c, index, await BodyAsync<EsSettingsUpdate>(http, ct), ct);
            return Results.NoContent();
        });
        g.MapPut("/indices/{index}/mappings", async (string cid, string index, HttpContext http, SourceClientManager clients, IndexService svc,
            CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            await svc.UpdateMappingsAsync(c, index, await BodyAsync<EsMappingsUpdate>(http, ct), ct);
            return Results.NoContent();
        });
        g.MapGet("/indices/{index}/fields", async (string cid, string index, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.FieldsAsync(await ClientAsync(clients, cid, ct), EsNames.Target(index), ct)));

        g.MapGet("/aliases", async (string cid, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.AliasesAsync(await ClientAsync(clients, cid, ct), ct)));
        g.MapPost("/aliases", async (string cid, HttpContext http, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            await svc.UpdateAliasesAsync(c, await BodyAsync<EsAliasesRequest>(http, ct), ct);
            return Results.NoContent();
        });
        g.MapGet("/datastreams", async (string cid, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.DataStreamsAsync(await ClientAsync(clients, cid, ct), ct)));
        g.MapGet("/templates", async (string cid, SourceClientManager clients, IndexService svc, CancellationToken ct) =>
            Json(await svc.TemplatesAsync(await ClientAsync(clients, cid, ct), ct)));

        // ---- search and documents
        g.MapPost("/search", async (string cid, HttpContext http, SourceClientManager clients, SearchService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.SearchAsync(c, await BodyAsync<EsSearchRequest>(http, ct), ct));
        });
        g.MapGet("/indices/{index}/docs/{id}", async (string cid, string index, string id, string? routing, SourceClientManager clients,
            DocumentService svc, CancellationToken ct) =>
            Json(await svc.GetAsync(await ClientAsync(clients, cid, ct), index, EsNames.Segment(id), routing, ct)));
        g.MapPut("/indices/{index}/docs/{id}", async (string cid, string index, string id, HttpContext http, SourceClientManager clients,
            DocumentService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.PutAsync(c, index, EsNames.Segment(id), await BodyAsync<EsPutDocRequest>(http, ct), ct));
        });
        g.MapPost("/indices/{index}/docs", async (string cid, string index, HttpContext http, SourceClientManager clients, DocumentService svc,
            CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.PutAsync(c, index, null, await BodyAsync<EsPutDocRequest>(http, ct), ct));
        });
        g.MapDelete("/indices/{index}/docs/{id}", async (string cid, string index, string id, long? ifSeqNo, long? ifPrimaryTerm, string? routing,
            SourceClientManager clients, DocumentService svc, CancellationToken ct) =>
            Json(await svc.DeleteAsync(await ClientAsync(clients, cid, ct), index, EsNames.Segment(id), ifSeqNo, ifPrimaryTerm, routing, ct)));

        // ---- SQL
        g.MapPost("/sql", async (string cid, HttpContext http, SourceClientManager clients, SqlService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.QueryAsync(c, await BodyAsync<EsSqlRequest>(http, ct), ct));
        });
        g.MapPost("/sql/close", async (string cid, HttpContext http, SourceClientManager clients, SqlService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            await svc.CloseAsync(c, await BodyAsync<EsSqlCursorRequest>(http, ct), ct);
            return Results.NoContent();
        });
        g.MapPost("/sql/translate", async (string cid, HttpContext http, SourceClientManager clients, SqlService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.TranslateAsync(c, await BodyAsync<EsSqlRequest>(http, ct), ct));
        });

        // ---- console
        g.MapPost("/console", async (string cid, HttpContext http, SourceClientManager clients, ConsoleService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            return Json(await svc.RunAsync(c, await BodyAsync<EsConsoleRequest>(http, ct), ct));
        });

        // ---- tasks
        g.MapGet("/tasks", async (string cid, string? actions, bool? detailed, SourceClientManager clients, TaskService svc, CancellationToken ct) =>
            Json(await svc.ListAsync(await ClientAsync(clients, cid, ct), actions, detailed ?? true, ct)));
        g.MapPost("/tasks/{taskId}/cancel", async (string cid, string taskId, SourceClientManager clients, TaskService svc, CancellationToken ct) =>
        {
            await svc.CancelAsync(await ClientAsync(clients, cid, ct), taskId, ct);
            return Results.NoContent();
        });

        // ---- jobs
        g.MapPost("/reindex", async (string cid, HttpContext http, SourceClientManager clients, JobManager jobs, JobsService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            c.EnsureWritable("reindex");
            var req = await BodyAsync<EsReindexRequest>(http, ct);
            JobsService.ReindexBody(req); // 400 before the job starts
            return Started(StartJob(jobs, clients, http, "es.reindex", cid, async (ctx, jct) => await svc.ReindexAsync(c, req, ctx, jct)));
        });
        g.MapPost("/import", async (string cid, HttpContext http, SourceClientManager clients, JobManager jobs, JobsService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            c.EnsureWritable("import documents");
            var plan = JobsService.ParseImport(await BodyAsync<EsImportRequest>(http, ct));
            return Started(StartJob(jobs, clients, http, "es.import", cid, async (ctx, jct) => await svc.ImportAsync(c, plan, ctx, jct)));
        });
        g.MapPost("/export", async (string cid, HttpContext http, SourceClientManager clients, JobManager jobs, JobsService svc, CancellationToken ct) =>
        {
            var c = await ClientAsync(clients, cid, ct);
            var plan = JobsService.ParseExport(await BodyAsync<EsExportRequest>(http, ct));
            if (plan.Path is { } path)
            {
                return Started(StartJob(jobs, clients, http, "es.export", cid, async (ctx, jct) =>
                {
                    long n;
                    await using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
                        n = await svc.ExportAsync(c, plan, file, ctx, jct);
                    return new EsExportResult(path, n);
                }));
            }
            // Browser mode: the file itself, buffered in a temp file so a failure still answers with an error envelope.
            var temp = Path.Combine(Path.GetTempPath(), $"dbstudio-es-export-{Guid.NewGuid():N}.tmp");
            var buffer = new FileStream(temp, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 64 * 1024, FileOptions.DeleteOnClose | FileOptions.Asynchronous);
            try
            {
                await svc.ExportAsync(c, plan, buffer, null, ct);
                buffer.Position = 0;
            }
            catch
            {
                await buffer.DisposeAsync();
                throw;
            }
            http.Response.Headers.ContentDisposition = $"attachment; filename=\"{SafeFileName(plan.Index)}.{plan.Extension}\"";
            return Results.Stream(buffer, "application/octet-stream");
        });

        return api;
    }
}
