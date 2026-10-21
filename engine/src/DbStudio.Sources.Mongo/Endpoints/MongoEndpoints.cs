using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Mongo.Endpoints;

/// <summary>
/// <c>/api/v1/mongo/{cid}/…</c> (docs/PLAN-M2.md 6, ui/src/api/client.m2.ts <c>mongo</c>). Every handler opens the
/// connection's <see cref="MongoClientHandle"/> through <see cref="SourceClientManager"/>; an endpoint filter maps driver
/// exceptions (<see cref="MongoErrors"/>) and marks the client broken on connection failures.
/// </summary>
public static class MongoEndpoints
{
    public const string ClientHeader = "X-DbStudio-Client";

    public static RouteGroupBuilder MapMongo(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/mongo/{cid}");
        g.AddEndpointFilter(MapErrorsAsync);

        g.MapGet("/server", async (string cid, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
            Json(await svc.ServerAsync(await HandleAsync(clients, cid, ct), ct)));

        g.MapGet("/databases", async (string cid, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
            Json(await svc.DatabasesAsync(await HandleAsync(clients, cid, ct), ct)));

        g.MapGet("/db/{db}/collections", async (string cid, string db, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
            Json(await svc.CollectionsAsync(await HandleAsync(clients, cid, ct), db, ct)));

        g.MapPost("/db/{db}/collections", async (string cid, string db, HttpContext http, SourceClientManager clients, ExplorerService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            await svc.CreateCollectionAsync(h, db, await BodyAsync<MongoCreateCollectionRequest>(http, ct), ct);
            return Results.NoContent();
        });

        // M2-L: the profiler level of the Logs "Profiler" source (db.setProfilingLevel; READ_ONLY on read-only profiles).
        g.MapGet("/db/{db}/profiling", async (string cid, string db, SourceClientManager clients, ProfilingService svc, CancellationToken ct) =>
            Json(await svc.GetAsync(await HandleAsync(clients, cid, ct), db, ct)));

        g.MapPut("/db/{db}/profiling", async (string cid, string db, HttpContext http, SourceClientManager clients, ProfilingService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.SetAsync(h, db, await BodyAsync<MongoProfiling>(http, ct), ct));
        });

        g.MapDelete("/db/{db}", async (string cid, string db, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
        {
            await svc.DropDatabaseAsync(await HandleAsync(clients, cid, ct), db, ct);
            return Results.NoContent();
        });

        var c = g.MapGroup("/db/{db}/coll/{coll}");

        c.MapDelete("", async (string cid, string db, string coll, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
        {
            await svc.DropCollectionAsync(await HandleAsync(clients, cid, ct), db, coll, ct);
            return Results.NoContent();
        });

        c.MapPost("/rename", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, ExplorerService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            await svc.RenameCollectionAsync(h, db, coll, await BodyAsync<MongoRenameCollectionRequest>(http, ct), ct);
            return Results.NoContent();
        });

        c.MapGet("/stats", async (string cid, string db, string coll, SourceClientManager clients, ExplorerService svc, CancellationToken ct) =>
            Json(await svc.StatsAsync(await HandleAsync(clients, cid, ct), db, coll, ct)));

        c.MapPost("/fields", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, FieldsService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.FieldsAsync(h, db, coll, await BodyAsync<MongoFieldsRequest>(http, ct), ct));
        });

        c.MapPost("/find", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, DocumentsService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.FindAsync(h, db, coll, await BodyAsync<MongoFindRequest>(http, ct), ct));
        });

        c.MapGet("/doc", async (string cid, string db, string coll, [FromQuery(Name = "_id")] string? id, SourceClientManager clients,
            DocumentsService svc, CancellationToken ct) =>
            Json(await svc.GetAsync(await HandleAsync(clients, cid, ct), db, coll, id, ct)));

        c.MapPost("/docs", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, DocumentsService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.InsertAsync(h, db, coll, await BodyAsync<MongoInsertRequest>(http, ct), ct));
        });

        c.MapPut("/docs", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, DocumentsService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.ReplaceAsync(h, db, coll, await BodyAsync<MongoReplaceRequest>(http, ct), ct));
        });

        c.MapDelete("/docs", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, DocumentsService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.DeleteAsync(h, db, coll, await BodyAsync<MongoDeleteRequest>(http, ct), ct));
        });

        c.MapPost("/aggregate", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, AggregateService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.RunAsync(h, db, coll, await BodyAsync<MongoAggregateRequest>(http, ct), ct));
        });

        c.MapPost("/explain", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, ExplainService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.ExplainAsync(h, db, coll, await BodyAsync<MongoExplainRequest>(http, ct), ct));
        });

        c.MapPost("/schema", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, JobManager jobs,
            SchemaService svc, CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            MongoValidate.Db(db);
            MongoValidate.Coll(coll);
            var (size, filter) = SchemaService.Parse(await BodyAsync<MongoSchemaRequest>(http, ct));
            var id = StartJob(jobs, clients, http, "mongo.schema", cid,
                async (ctx, jobCt) => await svc.AnalyzeAsync(h, db, coll, size, filter, ctx, jobCt));
            return Started(id);
        });

        c.MapGet("/indexes", async (string cid, string db, string coll, SourceClientManager clients, IndexesService svc, CancellationToken ct) =>
            Json(await svc.ListAsync(await HandleAsync(clients, cid, ct), db, coll, ct)));

        c.MapPost("/indexes", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, JobManager jobs,
            IndexesService svc, CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            var req = await BodyAsync<MongoCreateIndexRequest>(http, ct);
            return Json(await svc.CreateAsync(h, db, coll, req, work => StartJob(jobs, clients, http, "mongo.createIndex", cid, work), ct));
        });

        c.MapDelete("/indexes/{name}", async (string cid, string db, string coll, string name, SourceClientManager clients, IndexesService svc,
            CancellationToken ct) =>
        {
            await svc.DropAsync(await HandleAsync(clients, cid, ct), db, coll, name, ct);
            return Results.NoContent();
        });

        c.MapGet("/validation", async (string cid, string db, string coll, SourceClientManager clients, ValidationService svc, CancellationToken ct) =>
            Json(await svc.GetAsync(await HandleAsync(clients, cid, ct), db, coll, ct)));

        c.MapPut("/validation", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, ValidationService svc,
            CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            return Json(await svc.SetAsync(h, db, coll, await BodyAsync<MongoValidation>(http, ct), ct));
        });

        c.MapPost("/export", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, JobManager jobs,
            ImportExportService svc, CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            MongoValidate.Db(db);
            MongoValidate.Coll(coll);
            var plan = ImportExportService.ParseExport(await BodyAsync<MongoExportRequest>(http, ct));
            if (plan.Path is { } path)
            {
                var id = StartJob(jobs, clients, http, "mongo.export", cid, async (ctx, jobCt) =>
                {
                    long n;
                    await using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
                        n = await svc.ExportAsync(h, db, coll, plan, file, ctx, jobCt);
                    return new MongoExportResult(path, n);
                });
                return Started(id);
            }
            // Browser mode: the file itself. Buffered in a temp file so a failure still answers with an error envelope.
            var temp = Path.Combine(Path.GetTempPath(), $"dbstudio-export-{Guid.NewGuid():N}.tmp");
            var buffer = new FileStream(temp, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 64 * 1024,
                FileOptions.DeleteOnClose | FileOptions.Asynchronous);
            try
            {
                await svc.ExportAsync(h, db, coll, plan, buffer, null, ct);
                buffer.Position = 0;
            }
            catch
            {
                await buffer.DisposeAsync();
                throw;
            }
            http.Response.Headers.ContentDisposition = $"attachment; filename=\"{SafeFileName(coll)}.{plan.Extension}\"";
            return Results.Stream(buffer, "application/octet-stream");
        });

        c.MapPost("/import", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, JobManager jobs,
            ImportExportService svc, CancellationToken ct) =>
        {
            var h = await HandleAsync(clients, cid, ct);
            MongoValidate.Db(db);
            MongoValidate.Coll(coll);
            h.EnsureWritable("import documents");
            var plan = ImportExportService.ParseImport(await BodyAsync<MongoImportRequest>(http, ct));
            var id = StartJob(jobs, clients, http, "mongo.import", cid, async (ctx, jobCt) => await svc.ImportAsync(h, db, coll, plan, ctx, jobCt));
            return Started(id);
        });

        c.MapPost("/import/preview", async (string cid, string db, string coll, HttpContext http, SourceClientManager clients, CancellationToken ct) =>
        {
            await HandleAsync(clients, cid, ct);
            MongoValidate.Db(db);
            MongoValidate.Coll(coll);
            var plan = ImportExportService.ParseImport(await BodyAsync<MongoImportRequest>(http, ct));
            return Json(ImportExportService.Preview(plan));
        });

        return api;
    }

    private static async ValueTask<object?> MapErrorsAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        try
        {
            return await next(ctx);
        }
        catch (Exception ex) when (ex is not EngineException && ex is not OperationCanceledException && MongoErrors.Map(ex) is { } mapped)
        {
            if (MongoErrors.IsConnectionFailure(ex) && ctx.HttpContext.Request.RouteValues["cid"] is string cid)
            {
                var clients = ctx.HttpContext.RequestServices.GetRequiredService<SourceClientManager>();
                await clients.MarkBrokenAsync(cid, mapped.Message);
            }
            throw mapped;
        }
    }

    /// <summary>The Mongo client of the connection (400 when the connection is not a MongoDB one).</summary>
    public static async Task<MongoClientHandle> HandleAsync(SourceClientManager clients, string cid, CancellationToken ct) =>
        await clients.GetAsync(cid, ct) as MongoClientHandle
        ?? throw EngineException.Validation("This is not a MongoDB connection.", new { field = "cid", connectionId = cid });

    public static IResult Json(object value) => Results.Json(value, CoreJson.Options);

    private static IResult Started(string jobId) => Results.Json(new JobStarted(jobId), CoreJson.Options, statusCode: 202);

    private static string? ClientId(HttpContext http) => ClientPresence.Normalize(http.Request.Headers[ClientHeader].ToString());

    private static string StartJob(JobManager jobs, SourceClientManager clients, HttpContext http, string kind, string cid,
        Func<JobContext, CancellationToken, Task<object?>> work)
    {
        var lease = clients.AcquireLease(cid);
        try
        {
            return jobs.Start(kind, cid, ClientId(http), async (ctx, ct) =>
            {
                using (lease)
                {
                    try
                    {
                        return await work(ctx, ct).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is not EngineException && ex is not OperationCanceledException && MongoErrors.Map(ex) is { } mapped)
                    {
                        if (MongoErrors.IsConnectionFailure(ex)) await clients.MarkBrokenAsync(cid, mapped.Message).ConfigureAwait(false);
                        throw mapped;
                    }
                }
            });
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    /// <summary>Reads the JSON body with the engine conventions; an empty body is a default instance.</summary>
    public static async Task<T> BodyAsync<T>(HttpContext http, CancellationToken ct) where T : new()
    {
        using var reader = new StreamReader(http.Request.Body, Encoding.UTF8);
        var text = await reader.ReadToEndAsync(ct);
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

    private static string SafeFileName(string name)
    {
        var sb = new StringBuilder();
        foreach (var ch in name) sb.Append(ch is '"' or '\\' or '/' or ':' or '*' or '?' or '<' or '>' or '|' || char.IsControl(ch) ? '_' : ch);
        return sb.ToString();
    }
}
