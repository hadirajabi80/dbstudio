using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;
using DbStudio.Host.Infrastructure;

namespace DbStudio.Host.Endpoints;

public static class SessionEndpoints
{
    public static RouteGroupBuilder MapSessions(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/sessions");

        g.MapPost("", async (HttpContext http, CreateSessionRequest? req, SessionManager sessions, CancellationToken ct) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.ConnectionId))
                throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
            var h = await sessions.CreateAsync(req.ConnectionId, req.Database, req.TxMode, req.CaptureServerOutput, http.ClientId(), ct);
            sessions.PublishChanged(h);
            return h.ToInfo();
        });

        g.MapGet("", (SessionManager sessions) => sessions.List().Select(h => h.ToInfo()));

        g.MapGet("/{sid}", (string sid, SessionManager sessions) => sessions.Get(sid).ToInfo());

        g.MapDelete("/{sid}", async (string sid, bool? force, SessionManager sessions) =>
        {
            await sessions.CloseAsync(sid, force ?? false);
            return Results.NoContent();
        });

        g.MapPost("/{sid}/database", async (HttpContext http, string sid, DatabaseRequest? req, SessionManager sessions, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req?.Database)) throw EngineException.Validation("database is required.", new { field = "database" });
            var h = Touch(http, sessions, sid);
            await h.Session.ChangeDatabaseAsync(req.Database, ct);
            sessions.PublishChanged(h);
            return h.ToInfo();
        });

        g.MapPost("/{sid}/tx-mode", async (HttpContext http, string sid, TxModeRequest? req, SessionManager sessions, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("txMode is required.", new { field = "txMode" });
            var h = Touch(http, sessions, sid);
            await h.Session.SetTransactionModeAsync(req.TxMode, ct);
            sessions.PublishChanged(h);
            return h.ToInfo();
        });

        g.MapPost("/{sid}/commit", async (HttpContext http, string sid, SessionManager sessions, CancellationToken ct) =>
        {
            var h = Touch(http, sessions, sid);
            await h.Session.CommitAsync(ct);
            sessions.PublishChanged(h);
            return h.ToInfo();
        });

        g.MapPost("/{sid}/rollback", async (HttpContext http, string sid, SessionManager sessions, CancellationToken ct) =>
        {
            var h = Touch(http, sessions, sid);
            await h.Session.RollbackAsync(ct);
            sessions.PublishChanged(h);
            return h.ToInfo();
        });

        g.MapPost("/{sid}/execute", (HttpContext http, string sid, ExecuteRequestDto? req, ExecutionService executions, SettingsService settings, SessionManager sessions) =>
        {
            if (req?.Batches is null) throw EngineException.Validation("batches is required.", new { field = "batches" });
            Touch(http, sessions, sid);
            var maxRows = req.MaxRows ?? settings.DefaultMaxRows();
            var label = req.Label is not null && ExecLabels.All.Contains(req.Label) ? req.Label : "statement";
            var started = executions.Start(sid, new ExecuteCommand(
                req.Batches, maxRows, req.StopOnError ?? true, label, req.ConfirmedDestructive ?? false, req.Source?.TabId, req.Source?.Title,
                req.Params is { Count: > 0 } ps ? ps : null, req.SkipHistory ?? false));
            return Results.Json(new ExecuteResponse(started.ExecutionId, started.StartedAt), CoreJson.Options, statusCode: StatusCodes.Status202Accepted);
        });

        g.MapPost("/{sid}/cancel", (HttpContext http, string sid, ExecutionService executions, SessionManager sessions) =>
        {
            Touch(http, sessions, sid);
            return new CancelResponse(executions.Cancel(sid));
        });

        return api;
    }

    /// <summary>The session, now owned by the calling UI client (logic-08: the client that last touched it).</summary>
    internal static SessionHandle Touch(HttpContext http, SessionManager sessions, string sid)
    {
        var h = sessions.Get(sid);
        sessions.Claim(h, http.ClientId());
        return h;
    }

    public static RouteGroupBuilder MapExecutions(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/executions/{xid}/resultsets/{rs:int}");

        g.MapGet("/rows", (string xid, int rs, long? offset, int? limit, ExportService exports) =>
        {
            var set = exports.GetStored(xid, rs);
            var page = set.Page(Math.Max(0, offset ?? 0), Math.Clamp(limit ?? 1000, 0, 100_000));
            return new RowsPage(set.Columns, page, set.IsComplete ? set.RowCount : set.StoredRows, set.Truncated || set.Partial);
        });

        g.MapGet("/cell", (string xid, int rs, long? row, int? col, ExportService exports) =>
        {
            var set = exports.GetStored(xid, rs);
            if (row is null || col is null) throw EngineException.Validation("row and col are required.");
            var values = set.Row(row.Value) ?? throw EngineException.NotFound($"Row {row}");
            if (col < 0 || col >= values.Length) throw EngineException.NotFound($"Column {col}");
            var (kind, value, len) = ValueConverter.FullValue(values[col.Value]);
            return new CellResponse(kind, value, len);
        });

        g.MapPost("/export", async (HttpContext http, string xid, int rs, ResultSetExportRequest? req, ExportService exports, CancellationToken ct) =>
        {
            var format = req?.Format ?? ExportFormats.Csv;
            if (!ExportFormats.IsKnown(format)) throw EngineException.Validation($"Unknown export format '{format}'.", new { field = "format" });
            var options = req?.Options ?? new ExportOptions();
            exports.GetStored(xid, rs); // 404 before any output
            if (!string.IsNullOrWhiteSpace(req?.Path))
            {
                var rows = await exports.ExportStoredToFileAsync(xid, rs, format, options, req.Path, ct);
                return Results.Json(new ExportFileResponse(Path.GetFullPath(req.Path), rows), CoreJson.Options);
            }
            // Browser mode: stream the file as an attachment.
            var fileName = $"result-{rs + 1}{ExportFormats.Extension(format)}";
            http.Response.ContentType = ExportFormats.ContentType(format) + "; charset=utf-8";
            http.Response.Headers.ContentDisposition = $"attachment; filename=\"{fileName}\"";
            await exports.ExportStoredAsync(xid, rs, format, options, http.Response.Body, ct);
            return Results.Empty;
        });

        api.MapPost("/export", (HttpContext http, QueryExportRequest? req, ExportService exports, SessionManager sessions) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.SessionId)) throw EngineException.Validation("sessionId is required.", new { field = "sessionId" });
            Touch(http, sessions, req.SessionId);
            var id = exports.StartQueryExport(req.SessionId, req.Sql ?? "", req.Format ?? ExportFormats.Csv, req.Path ?? "", req.Options ?? new ExportOptions());
            return Results.Json(new QueryExportResponse(id), CoreJson.Options, statusCode: StatusCodes.Status202Accepted);
        });

        return api;
    }
}
