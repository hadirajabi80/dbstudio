using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Sources.Redis.Endpoints;

/// <summary>
/// <c>/api/v1/redis/{cid}/…</c> (docs/PLAN-M2.md 5.3–5.5). Every handler opens the shared client lazily through
/// <see cref="SourceClientManager"/> (503 SOURCE_UNAVAILABLE). Key routes carry <c>?db=</c>; the key segment is decoded
/// from the raw request target so keys containing <c>/</c> (sent as <c>%2F</c>) round-trip exactly.
/// </summary>
public static class RedisEndpoints
{
    private const string ClientHeader = "X-DbStudio-Client";

    public static RouteGroupBuilder MapRedis(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/redis/{cid}");

        g.MapGet("/server", async (string cid, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.ServerAsync(await Client(clients, cid, ct))));

        // ---- keys
        g.MapPost("/keys/scan", async (string cid, RedisScanRequest? req, SourceClientManager clients, KeyBrowser browser, CancellationToken ct) =>
            Json(await browser.ScanAsync(await Client(clients, cid, ct), req ?? new RedisScanRequest(null, null, null, null, null), ct)));

        g.MapPost("/keys/memory", async (string cid, RedisMemoryRequest? req, SourceClientManager clients, KeyBrowser browser, CancellationToken ct) =>
            Json(await browser.MemoryAsync(await Client(clients, cid, ct), req ?? throw EngineException.Validation("A body is required."))));

        g.MapPost("/keys", async (string cid, RedisCreateKeyRequest? req, SourceClientManager clients, ValueService values, CancellationToken ct) =>
        {
            await values.CreateAsync(await Client(clients, cid, ct), req ?? throw EngineException.Validation("A body is required."));
            return Results.NoContent();
        });

        g.MapPost("/keys/delete-pattern", async (string cid, RedisDeletePatternRequest? req, HttpContext http, SourceClientManager clients,
            ValueService values, JobManager jobs, CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            c.EnsureWritable("deleting keys by pattern");
            var pattern = req?.Pattern is { Length: > 0 } p ? p : throw EngineException.Validation("pattern is required.", new { field = "pattern" });
            var db = c.CheckDb(req.Db ?? c.Settings.Database);
            var id = jobs.Start("redis.deletePattern", cid, ClientId(http), async (job, jct) =>
            {
                using var lease = clients.AcquireLease(cid);
                return await values.DeletePatternAsync(c, db, pattern, job, jct);
            });
            return Results.Json(new JobStarted(id), CoreJson.Options, statusCode: 202);
        });

        g.MapGet("/keys/{key}", async (string cid, int? db, string? cursor, int? count, string? field, string? start, string? stop,
            HttpContext http, SourceClientManager clients, ValueService values, CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            return Json(await values.GetAsync(c, Db(c, db), RouteKey(http), new RedisKeyQuery(cursor, count, field, start, stop)));
        });

        g.MapGet("/keys/{key}/stream/groups/{group}", async (string cid, string group, int? db, HttpContext http, SourceClientManager clients,
            ValueService values, CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            return Json(await values.StreamGroupAsync(c, Db(c, db), RouteKey(http), Uri.UnescapeDataString(group)));
        });

        g.MapPut("/keys/{key}/string", (string cid, int? db, RedisSetStringRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.SetStringAsync(c, Db(c, db), RouteKey(http), req ?? new RedisSetStringRequest(null))));

        g.MapPost("/keys/{key}/hash", (string cid, int? db, RedisHashEditRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.EditHashAsync(c, Db(c, db), RouteKey(http), req ?? new RedisHashEditRequest(null, null))));

        g.MapPost("/keys/{key}/list", (string cid, int? db, RedisListEditRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.EditListAsync(c, Db(c, db), RouteKey(http), req ?? new RedisListEditRequest(null, null, null))));

        g.MapPost("/keys/{key}/set", (string cid, int? db, RedisSetEditRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.EditSetAsync(c, Db(c, db), RouteKey(http), req ?? new RedisSetEditRequest(null, null))));

        g.MapPost("/keys/{key}/zset", (string cid, int? db, RedisZsetEditRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.EditZsetAsync(c, Db(c, db), RouteKey(http), req ?? new RedisZsetEditRequest(null, null))));

        g.MapPost("/keys/{key}/stream", async (string cid, int? db, RedisStreamEditRequest? req, HttpContext http, SourceClientManager clients, ValueService v,
            CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            var id = await v.EditStreamAsync(c, Db(c, db), RouteKey(http), req ?? new RedisStreamEditRequest(null, null, null, null, null, null));
            return id is null ? Results.NoContent() : Json(new { id });
        });

        g.MapPut("/keys/{key}/json", (string cid, int? db, RedisJsonSetRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.SetJsonAsync(c, Db(c, db), RouteKey(http), req ?? new RedisJsonSetRequest(null, null))));

        g.MapPost("/keys/{key}/rename", (string cid, int? db, RedisRenameRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.RenameAsync(c, Db(c, db), RouteKey(http), req ?? new RedisRenameRequest(null, null))));

        g.MapPut("/keys/{key}/ttl", (string cid, int? db, RedisTtlRequest? req, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.SetTtlAsync(c, Db(c, db), RouteKey(http), req ?? new RedisTtlRequest(null))));

        g.MapDelete("/keys/{key}", (string cid, int? db, HttpContext http, SourceClientManager clients, ValueService v, CancellationToken ct) =>
            Write(clients, cid, ct, c => v.DeleteAsync(c, Db(c, db), RouteKey(http))));

        // ---- workbench / CLI
        g.MapPost("/commands", async (string cid, RedisCommandsRequest? req, SourceClientManager clients, CommandService commands, CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            using var lease = clients.AcquireLease(cid);
            return Json(await commands.ExecuteAsync(c, req ?? throw EngineException.Validation("A body is required."), ct));
        });

        // ---- pub/sub, slowlog, config, info, clients
        g.MapPost("/publish", async (string cid, RedisPublishRequest? req, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.PublishAsync(await Client(clients, cid, ct), req ?? new RedisPublishRequest(null, null))));

        g.MapGet("/pubsub/channels", async (string cid, string? pattern, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.ChannelsAsync(await Client(clients, cid, ct), pattern)));

        g.MapGet("/slowlog", async (string cid, int? count, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.SlowlogAsync(await Client(clients, cid, ct), count ?? 128)));

        g.MapPost("/slowlog/reset", (string cid, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Write(clients, cid, ct, info.ResetSlowlogAsync));

        g.MapGet("/config", async (string cid, string? pattern, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.ConfigAsync(await Client(clients, cid, ct), pattern)));

        g.MapPut("/config", (string cid, RedisConfigSetRequest? req, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Write(clients, cid, ct, c => info.SetConfigAsync(c, req ?? new RedisConfigSetRequest(null, null))));

        g.MapGet("/info", async (string cid, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.InfoAsync(await Client(clients, cid, ct))));

        g.MapGet("/clients", async (string cid, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Json(await info.ClientsAsync(await Client(clients, cid, ct))));

        g.MapPost("/clients/kill", (string cid, RedisClientKillRequest? req, SourceClientManager clients, InfoService info, CancellationToken ct) =>
            Write(clients, cid, ct, c => info.KillClientAsync(c, req ?? new RedisClientKillRequest(null))));

        // ---- analysis
        g.MapPost("/analysis", async (string cid, RedisAnalysisRequest? req, HttpContext http, SourceClientManager clients, AnalysisService analysis,
            JobManager jobs, CancellationToken ct) =>
        {
            var c = await Client(clients, cid, ct);
            var (db, limit, delimiter) = AnalysisService.Validate(c, req ?? new RedisAnalysisRequest(null, null, null));
            var id = jobs.Start("redis.analysis", cid, ClientId(http), async (job, jct) =>
            {
                using var lease = clients.AcquireLease(cid);
                return await analysis.RunAsync(c, db, limit, delimiter, job, jct);
            });
            return Results.Json(new JobStarted(id), CoreJson.Options, statusCode: 202);
        });

        return api;
    }

    private static IResult Json(object value) => Results.Json(value, CoreJson.Options);

    private static async Task<IResult> Write(SourceClientManager clients, string cid, CancellationToken ct, Func<RedisClient, Task> action)
    {
        await action(await Client(clients, cid, ct));
        return Results.NoContent();
    }

    internal static async Task<RedisClient> Client(SourceClientManager clients, string cid, CancellationToken ct) =>
        await clients.GetAsync(cid, ct) as RedisClient
        ?? throw EngineException.Validation($"Connection '{cid}' is not a Redis connection.", new { connectionId = cid });

    private static int Db(RedisClient c, int? db) => c.CheckDb(db ?? (c.IsCluster ? 0 : c.Settings.Database));

    private static string? ClientId(HttpContext http) => ClientPresence.Normalize(http.Request.Headers[ClientHeader].ToString());

    /// <summary>The <c>{key}</c> segment, decoded once from the raw target (keeps <c>%2F</c> → <c>/</c> and <c>%25</c> → <c>%</c> exact).</summary>
    internal static string RouteKey(HttpContext http)
    {
        var raw = http.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(raw) || raw[0] != '/') raw = (http.Request.PathBase + http.Request.Path).ToUriComponent();
        var q = raw.IndexOf('?');
        if (q >= 0) raw = raw[..q];
        var segments = raw.Split('/');
        for (var i = 0; i + 3 < segments.Length; i++)
        {
            if (segments[i] == "redis" && segments[i + 2] == "keys")
                return Uri.UnescapeDataString(segments[i + 3]);
        }
        return http.Request.RouteValues["key"]?.ToString() ?? throw EngineException.Validation("The key is missing from the path.", new { field = "key" });
    }
}
