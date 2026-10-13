using System.Buffers;
using System.Text.Json;
using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;
using Microsoft.AspNetCore.Mvc;

namespace DbStudio.Host.Endpoints;

public static class CatalogEndpoints
{
    private static readonly HashSet<string> KnownTypes =
    [
        ObjectTypes.Table, ObjectTypes.View, ObjectTypes.MView, ObjectTypes.Proc, ObjectTypes.Func, ObjectTypes.TableFunc,
        ObjectTypes.Synonym, ObjectTypes.Sequence, ObjectTypes.Package, ObjectTypes.Type, ObjectTypes.Trigger,
    ];

    public static RouteGroupBuilder MapCatalog(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections/{id}/catalog");

        g.MapGet("/databases", async (string id, CatalogService catalog, CancellationToken ct) =>
        {
            var r = await catalog.GetDatabasesAsync(id, ct);
            return new DatabasesResponse(r.Databases, r.Current);
        });

        g.MapGet("/schemas", (string id, string? database, CatalogService catalog, CancellationToken ct) =>
            catalog.GetSchemasAsync(id, Blank(database), ct));

        g.MapGet("", async (HttpContext http, string id, string? database, string? schemas, CatalogService catalog, CancellationToken ct) =>
        {
            var list = schemas?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var ifNoneMatch = http.Request.Headers.IfNoneMatch.ToString();
            var result = await catalog.GetSnapshotAsync(id, Blank(database), list, string.IsNullOrEmpty(ifNoneMatch) ? null : ifNoneMatch, ct);
            http.Response.Headers.ETag = result.ETag;
            http.Response.Headers.CacheControl = "no-cache";
            if (result.NotModified) return Results.StatusCode(StatusCodes.Status304NotModified);
            return Results.Bytes(result.Json!, "application/json; charset=utf-8");
        });

        g.MapGet("/object", (string id, string? database, string? schema, string? name, string? type, CatalogService catalog, CancellationToken ct) =>
            catalog.GetObjectDetailsAsync(id, Ref(database, schema, name, type), ct));

        g.MapGet("/ddl", async (string id, string? database, string? schema, string? name, string? type, CatalogService catalog, CancellationToken ct) =>
        {
            var ddl = await catalog.GetDdlAsync(id, Ref(database, schema, name, type), ct);
            return new DdlResponse(ddl.Ddl, ddl.Source);
        });

        g.MapGet("/errors", (string id, string? database, string? schema, string? name, string? type, CatalogService catalog, CancellationToken ct) =>
            catalog.GetCompileErrorsAsync(id, Ref(database, schema, name, type), ct));

        // Oracle PUBLIC synonym on-demand resolution (sql-intel lazy hook): a wire CatalogObject with "target", or 404.
        g.MapGet("/synonym", async (string id, string? name, CatalogService catalog, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
            var obj = await catalog.ResolvePublicSynonymAsync(id, name, ct)
                      ?? throw EngineException.NotFound($"Public synonym '{name}'");
            var buffer = new ArrayBufferWriter<byte>();
            using (var w = new Utf8JsonWriter(buffer, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
                CatalogWire.WriteObject(w, obj);
            return Results.Bytes(buffer.WrittenSpan.ToArray(), "application/json; charset=utf-8");
        });

        g.MapPost("/refresh", async (string id, [FromBody] RefreshRequest? req, CatalogService catalog, CancellationToken ct) =>
            new RefreshResponse(await catalog.RefreshAsync(id, Blank(req?.Database), req?.Schemas, ct)));

        return api;
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    private static ObjectRef Ref(string? database, string? schema, string? name, string? type)
    {
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var t = string.IsNullOrWhiteSpace(type) ? ObjectTypes.Table : type.Trim().ToLowerInvariant();
        if (!KnownTypes.Contains(t)) throw EngineException.Validation($"Unknown object type '{type}'.", new { field = "type" });
        return new ObjectRef(Blank(database), Blank(schema), name, t);
    }
}
