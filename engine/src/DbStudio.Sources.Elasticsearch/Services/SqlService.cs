using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>
/// SQL tab: Elasticsearch <c>_sql?format=json</c> (columns/rows/cursor) or OpenSearch <c>_plugins/_sql</c> with the
/// jdbc format (schema/datarows/cursor), normalised to <see cref="EsSqlResponse"/>; close cursor; translate to DSL
/// (<c>_sql/translate</c> / <c>_plugins/_sql/_explain</c>).
/// </summary>
public sealed class SqlService
{
    public async Task<EsSqlResponse> QueryAsync(EsClient c, EsSqlRequest? req, CancellationToken ct)
    {
        var cursor = string.IsNullOrWhiteSpace(req?.Cursor) ? null : req!.Cursor!.Trim();
        var query = req?.Query?.Trim().TrimEnd(';');
        if (cursor is null && string.IsNullOrWhiteSpace(query)) throw EngineException.Validation("A SQL query is required.", new { field = "query" });
        var fetch = Math.Clamp(req?.FetchSize ?? 1000, 1, 10_000);
        var body = cursor is not null ? new JsonObject { ["cursor"] = cursor } : new JsonObject { ["query"] = query, ["fetch_size"] = fetch };
        var sw = Stopwatch.StartNew();
        var path = c.IsOpenSearch ? "_plugins/_sql?format=jdbc" : "_sql?format=json";
        var res = await c.Transport.JsonAsync(HttpMethod.Post, path, body, ct, TimeSpan.FromMinutes(5)).ConfigureAwait(false);
        return Normalize(res, sw.ElapsedMilliseconds);
    }

    internal static EsSqlResponse Normalize(JsonElement res, long elapsedMs)
    {
        // Elasticsearch: { columns: [{ name, type }], rows: [[…]], cursor }
        // OpenSearch jdbc: { schema: [{ name, alias?, type }], datarows: [[…]], total, size, status, cursor }
        var columns = new List<EsSqlColumn>();
        foreach (var col in (res.Prop("columns") ?? res.Prop("schema")).Items())
            columns.Add(new EsSqlColumn(col.Str("alias") ?? col.Str("name") ?? "", col.Str("type") ?? ""));
        var rows = (res.Prop("rows") ?? res.Prop("datarows")).Items()
            .Select(r => (IReadOnlyList<JsonElement>)r.EnumerateArray().Select(v => v.Clone()).ToList()).ToList();
        var cursor = res.Str("cursor");
        return new EsSqlResponse(columns, rows, string.IsNullOrEmpty(cursor) ? null : cursor, elapsedMs);
    }

    public async Task CloseAsync(EsClient c, EsSqlCursorRequest? req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req?.Cursor)) throw EngineException.Validation("A cursor is required.", new { field = "cursor" });
        var path = c.IsOpenSearch ? "_plugins/_sql/close" : "_sql/close";
        await c.Transport.JsonAsync(HttpMethod.Post, path, new JsonObject { ["cursor"] = req.Cursor.Trim() }, ct).ConfigureAwait(false);
    }

    public async Task<EsSqlTranslateResponse> TranslateAsync(EsClient c, EsSqlRequest? req, CancellationToken ct)
    {
        var query = req?.Query?.Trim().TrimEnd(';');
        if (string.IsNullOrWhiteSpace(query)) throw EngineException.Validation("A SQL query is required.", new { field = "query" });
        var path = c.IsOpenSearch ? "_plugins/_sql/_explain" : "_sql/translate";
        var res = await c.Transport.JsonAsync(HttpMethod.Post, path, new JsonObject { ["query"] = query }, ct).ConfigureAwait(false);
        return new EsSqlTranslateResponse(res);
    }
}

/// <summary>Tasks (<c>_tasks?detailed</c>) and cancel; also feeds the <c>es.tasks</c> stream.</summary>
public sealed class TaskService
{
    public async Task<IReadOnlyList<EsTask>> ListAsync(EsClient c, string? actions, bool detailed, CancellationToken ct)
    {
        var q = new List<string> { "group_by=none" };
        if (detailed) q.Add("detailed=true");
        if (!string.IsNullOrWhiteSpace(actions))
        {
            var a = actions.Trim();
            if (a.Any(ch => !(char.IsAsciiLetterOrDigit(ch) || ch is '*' or ':' or '/' or '_' or ',' or '.' or '[' or ']' or '-')))
                throw EngineException.Validation("actions is a comma list of action patterns (e.g. *reindex,indices:data/write/*).", new { field = "actions" });
            q.Add($"actions={Uri.EscapeDataString(a)}");
        }
        var res = await c.Transport.GetAsync($"_tasks?{string.Join('&', q)}", ct).ConfigureAwait(false);
        return Map(res);
    }

    internal static IReadOnlyList<EsTask> Map(JsonElement res)
    {
        var list = new List<EsTask>();
        if (res.Prop("tasks") is { } tasks)
        {
            if (tasks.ValueKind == JsonValueKind.Array) list.AddRange(tasks.EnumerateArray().Select(t => MapTask(t, null)));
            else if (tasks.ValueKind == JsonValueKind.Object) list.AddRange(tasks.EnumerateObject().Select(p => MapTask(p.Value, p.Name)));
        }
        if (res.Prop("nodes") is { ValueKind: JsonValueKind.Object } nodes)
        {
            foreach (var n in nodes.EnumerateObject())
                if (n.Value.Prop("tasks") is { ValueKind: JsonValueKind.Object } nt)
                    list.AddRange(nt.EnumerateObject().Select(p => MapTask(p.Value, p.Name)));
        }
        return list.OrderBy(t => t.StartTime, StringComparer.Ordinal).ThenBy(t => t.Id, StringComparer.Ordinal).ToList();
    }

    internal static EsTask MapTask(JsonElement t, string? key)
    {
        var node = t.Str("node") ?? "";
        var id = key ?? (t.Long("id") is { } n ? $"{node}:{n.ToString(CultureInfo.InvariantCulture)}" : node);
        var nanos = t.Long("running_time_in_nanos") ?? 0;
        return new EsTask(
            Id: id,
            Node: node,
            Action: t.Str("action") ?? "",
            Type: t.Str("type") ?? "",
            Description: t.Str("description") is { Length: > 0 } d ? d : null,
            StartTime: EsJson.Iso(t.Long("start_time_in_millis")) ?? "",
            RunningTimeMs: nanos / 1_000_000,
            Cancellable: t.Bool("cancellable") ?? false,
            Cancelled: t.Bool("cancelled") ?? false,
            ParentTaskId: t.Str("parent_task_id"),
            Status: t.Prop("status")?.Clone());
    }

    public async Task CancelAsync(EsClient c, string taskId, CancellationToken ct)
    {
        c.EnsureWritable("cancel task");
        var id = EsNames.TaskId(taskId);
        await c.Transport.JsonAsync(HttpMethod.Post, $"_tasks/{id}/_cancel", null, ct).ConfigureAwait(false);
    }
}
