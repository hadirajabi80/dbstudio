using System.Globalization;
using System.Text;
using System.Text.Json;
using ClickHouse.Driver;
using ClickHouse.Driver.ADO.Parameters;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;

namespace DbStudio.Providers.ClickHouse.Plans;

/// <summary>
/// ClickHouse plans (plan-batch3 WP-CH): <c>EXPLAIN json = 1, indexes = 1, description = 1</c> gives the query plan tree
/// (ReadFromMergeTree nodes carry the primary-key / partition / skip-index filtering: parts and granules before and after);
/// for queries <c>EXPLAIN PIPELINE</c> is attached to the root as text. The actual plan runs the statement normally (its
/// rows are delivered) and adds the server's own counters from <c>system.query_log</c> (rows/bytes read, result rows,
/// memory, duration, selected parts/marks) to the root.
/// </summary>
public sealed class ChPlanReader : IPlanReader
{
    public const string PlanColumn = "explain";
    public const string Options = "json = 1, indexes = 1, description = 1";
    public const string StatsMissingWarning = "Query statistics are not in system.query_log yet (log_queries off or not flushed); only the estimated plan is shown.";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => "clickhouse";

    public ExplainScript CreateScript(ExplainInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var sql = input.Sql.Trim().TrimEnd(';').TrimEnd();
        var line = input.Line - 1;
        var batches = new List<ExplainBatch>();
        if (input.IsActual) batches.Add(new ExplainBatch(sql, true, false, input.Line, input.Col));
        batches.Add(new ExplainBatch($"EXPLAIN {Options}\n{sql}", false, true, line, 1));
        if (IsQuery(sql)) batches.Add(new ExplainBatch($"EXPLAIN PIPELINE\n{sql}", false, true, line, 1));
        return new ExplainScript { Batches = batches, Params = input.Params };
    }

    public static bool IsQuery(string sql)
    {
        var st = ChSqlText.Split(sql);
        return st.Count == 1 && st[0].Kind is "SELECT" or "WITH";
    }

    public async Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        string? json = null;
        string? pipeline = null;
        foreach (var set in captured)
        {
            if (set.Columns.Length != 1) continue;
            var text = string.Join("\n", set.Rows.Select(r => CapturedResultSet.Text(r[0]) ?? ""));
            if (json is null && text.TrimStart().StartsWith('[')) json = text;
            else if (pipeline is null && json is not null) pipeline = text;
        }
        if (json is null) throw new EngineException(422, ErrorCodes.ProviderError, "The server returned no plan for this statement.");
        var result = Parse(json);
        if (pipeline is not null) result.Root.SetProp("pipeline", pipeline);

        if (input.IsActual && session is ChSession ch && ch.LastQueryId(ExplainKinds) is { } queryId)
        {
            var stats = await ReadQueryLogAsync(ch, queryId, ct).ConfigureAwait(false);
            if (stats is null) result = result with { Warnings = [.. result.Warnings, StatsMissingWarning] };
            else Apply(result.Root, stats);
        }
        return result;
    }

    private static readonly string[] ExplainKinds = ["EXPLAIN"];

    /// <summary>Parses <c>EXPLAIN json = 1</c>: <c>[ { "Plan": { "Node Type", "Description", "Indexes", "Plans" } } ]</c>.</summary>
    public static PlanResult Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var rootEl = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0 ? doc.RootElement[0] : doc.RootElement;
        if (!rootEl.TryGetProperty("Plan", out var plan)) throw new EngineException(422, ErrorCodes.ProviderError, "Unexpected EXPLAIN output.");
        var id = 0;
        var warnings = new List<string>();
        var root = Node(plan, ref id, warnings);
        return new PlanResult(root, json, "json", warnings);
    }

    private static PlanNode Node(JsonElement e, ref int id, List<string> warnings)
    {
        var node = new PlanNode
        {
            Id = id++,
            Op = e.TryGetProperty("Node Type", out var nt) ? nt.GetString() ?? "?" : "?",
        };
        if (e.TryGetProperty("Description", out var d) && d.GetString() is { Length: > 0 } desc)
        {
            if (node.Op.StartsWith("ReadFrom", StringComparison.Ordinal)) node.Object = desc;
            else node.LogicalOp = desc;
        }
        if (e.TryGetProperty("Indexes", out var idx) && idx.ValueKind == JsonValueKind.Array)
        {
            var filtered = false;
            var parts = new StringBuilder();
            foreach (var ix in idx.EnumerateArray())
            {
                var type = Str(ix, "Type") ?? "Index";
                var cond = Str(ix, "Condition");
                var name = Str(ix, "Name");
                var keys = ix.TryGetProperty("Keys", out var k) && k.ValueKind == JsonValueKind.Array ? string.Join(", ", k.EnumerateArray().Select(x => x.GetString())) : null;
                var ip = Num(ix, "Initial Parts");
                var sp = Num(ix, "Selected Parts");
                var ig = Num(ix, "Initial Granules");
                var sg = Num(ix, "Selected Granules");
                if (sg is not null && ig is not null && sg < ig) filtered = true;
                var label = name is null ? type : $"{type} {name}";
                var text = $"{label}{(keys is null ? "" : $" ({keys})")}: parts {Fmt(sp)}/{Fmt(ip)}, granules {Fmt(sg)}/{Fmt(ig)}";
                if (!string.IsNullOrEmpty(cond) && cond != "true") text += $" — {cond}";
                if (parts.Length > 0) parts.Append('\n');
                parts.Append(text);
                if (type == "PrimaryKey" && !string.IsNullOrEmpty(cond) && cond != "true") node.Predicate = cond;
            }
            node.SetProp("indexes", parts.ToString());
            if (!filtered && node.Op == "ReadFromMergeTree")
                node.Warnings.Add("No index filtered any granule: every part of the table is read (full scan). Filter on the sorting key or the partition key.");
        }
        else if (node.Op == "ReadFromMergeTree")
        {
            node.Warnings.Add("Full scan: the condition does not use the primary key, partition key or a skipping index.");
        }
        if (e.TryGetProperty("Plans", out var plans) && plans.ValueKind == JsonValueKind.Array)
            foreach (var c in plans.EnumerateArray()) node.Children.Add(Node(c, ref id, warnings));
        foreach (var w in node.Warnings) if (!warnings.Contains(w)) warnings.Add(w);
        return node;
    }

    private static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double? Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;

    private static string Fmt(double? v) => v?.ToString("0", Inv) ?? "?";

    public sealed record QueryStats(long ReadRows, long ReadBytes, long ResultRows, long MemoryUsage, long DurationMs, long SelectedParts, long SelectedMarks);

    public const string QueryLogSql = """
        SELECT read_rows, read_bytes, result_rows, memory_usage, query_duration_ms,
            ProfileEvents['SelectedParts'], ProfileEvents['SelectedMarks']
        FROM system.query_log
        WHERE query_id = {qid:String} AND type = 'QueryFinish' AND event_date >= yesterday()
        ORDER BY event_time DESC LIMIT 1
        """;

    /// <summary>Flushes the logs (when allowed) and reads the finished query's row; polls briefly when the flush is denied.</summary>
    private static async Task<QueryStats?> ReadQueryLogAsync(ChSession session, string queryId, CancellationToken ct) =>
        await session.RunExclusiveAsync(async (scope, token) =>
        {
            var flushed = true;
            try
            {
                await using var flush = scope.CreateCommand("SYSTEM FLUSH LOGS");
                await flush.ExecuteNonQueryAsync(token).ConfigureAwait(false);
            }
            catch (ClickHouseServerException)
            {
                flushed = false;
            }
            for (var attempt = 0; attempt < (flushed ? 3 : 9); attempt++)
            {
                await using var cmd = scope.CreateCommand(QueryLogSql);
                cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = "qid", ClickHouseType = "String", Value = queryId });
                try
                {
                    await using var r = await cmd.ExecuteReaderAsync(token).ConfigureAwait(false);
                    if (await r.ReadAsync(token).ConfigureAwait(false))
                        return new QueryStats(L(r.GetValue(0)), L(r.GetValue(1)), L(r.GetValue(2)), L(r.GetValue(3)), L(r.GetValue(4)), L(r.GetValue(5)), L(r.GetValue(6)));
                }
                catch (ClickHouseServerException)
                {
                    return null; // no access to system.query_log
                }
                await Task.Delay(1000, token).ConfigureAwait(false);
            }
            return null;
        }, ct).ConfigureAwait(false);

    private static long L(object? v) => v switch
    {
        null or DBNull => 0,
        ulong u => u > long.MaxValue ? long.MaxValue : (long)u,
        _ => Convert.ToInt64(v, Inv),
    };

    public static void Apply(PlanNode root, QueryStats s)
    {
        root.ActualRows = s.ResultRows;
        root.SetProp("readRows", s.ReadRows.ToString(Inv));
        root.SetProp("readBytes", s.ReadBytes.ToString(Inv));
        root.SetProp("resultRows", s.ResultRows.ToString(Inv));
        root.SetProp("memoryUsage", s.MemoryUsage.ToString(Inv));
        root.SetProp("durationMs", s.DurationMs.ToString(Inv));
        root.SetProp("selectedParts", s.SelectedParts.ToString(Inv));
        root.SetProp("selectedMarks", s.SelectedMarks.ToString(Inv));
        foreach (var n in root.DescendantsAndSelf().Where(n => n.Op.StartsWith("ReadFrom", StringComparison.Ordinal)))
            n.ActualRows ??= s.ReadRows;
    }
}
