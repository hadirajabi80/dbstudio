using DbStudio.Core.Designer;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;
using DbStudio.Host.Infrastructure;

namespace DbStudio.Host.Endpoints;

/// <summary>M1.5 designer endpoints (docs/PLAN-M1.5.md 3.9).</summary>
public static class DesignerEndpoints
{
    public static RouteGroupBuilder MapDesigner(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections/{id}/designer");

        g.MapGet("/types", (string id, string? database, DesignerService designer, CancellationToken ct) =>
            designer.GetTypesAsync(id, database, ct));

        g.MapGet("/table", (string id, string? database, string? schema, string? name, DesignerService designer, CancellationToken ct) =>
            designer.GetTableAsync(id, database, schema, name ?? "", ct));

        g.MapPost("/table/script", (string id, TableScriptRequestDto? req, DesignerService designer, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("A request body is required.");
            return designer.ScriptTableAsync(id, req.Database, req.Original, req.Desired, ct);
        });

        g.MapGet("/view", (string id, string? database, string? schema, string? name, DesignerService designer, CancellationToken ct) =>
            designer.GetViewAsync(id, database, schema, name ?? "", ct));

        g.MapPost("/view/script", (string id, ViewScriptRequestDto? req, DesignerService designer, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("A request body is required.");
            var view = new ViewDefinition(string.IsNullOrWhiteSpace(req.Schema) ? null : req.Schema, req.Name ?? "",
                string.IsNullOrWhiteSpace(req.OriginalName) ? null : req.OriginalName, req.Body ?? "", req.Options ?? new ViewOptions());
            return designer.ScriptViewAsync(id, req.Database, view, ct);
        });

        g.MapPost("/apply", async (HttpContext http, string id, DdlApplyRequestDto? req, DesignerService designer, CancellationToken ct) =>
        {
            if (req?.Statements is null) throw EngineException.Validation("statements is required.", new { field = "statements" });
            var result = await designer.ApplyAsync(id, new DdlApplyRequest(req.Database, req.Statements, req.Transactional ?? true, req.Schema), http.ClientId(), ct);
            return new DdlApplyResponse(result.Ok, result.Executed, result.ElapsedMs);
        });

        return api;
    }
}
