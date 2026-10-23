using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;

namespace DbStudio.Providers.Snowflake.Plans;

/// <summary>
/// Snowflake plans (plan-batch3 WP-SF). Estimated: <c>EXPLAIN USING JSON</c> (compiled in the cloud services layer, nothing
/// runs, no warehouse): the operations with their objects, expressions and the partitions/bytes the pruning assigned.
/// Actual: the statement runs normally (its rows stream as usual), then
/// <c>GET_QUERY_OPERATOR_STATS('&lt;query id&gt;')</c> gives the executed operator tree with output rows, the share of the
/// execution time per operator (CostPct), pruning, spilling and network statistics. Unbound placeholders are explained
/// with NULL binds.
/// </summary>
public sealed class SnowflakePlanReader : IPlanReader
{
    public const string PlanColumn = "content";
    public const string StatsUnavailableWarning =
        "Operator statistics are not available for this statement (GET_QUERY_OPERATOR_STATS needs a completed query of this session); showing the estimated plan.";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => "snowflake";

    public ExplainScript CreateScript(ExplainInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var sql = input.Sql.Trim().TrimEnd(';').TrimEnd();
        if (input.IsActual)
            return new ExplainScript { Batches = [new ExplainBatch(sql, true, false, input.Line, input.Col)], Params = input.Params };

        var parameters = input.Params;
        var placeholders = Params.SnowflakeParamBinder.Placeholders(sql);
        if (placeholders.Count > 0 && parameters is not { Count: > 0 })
        {
            var positional = 0;
            parameters = placeholders.Select(p => p.Name ?? (++positional).ToString(Inv)).Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(n => new QueryParam(n, ParamKinds.Null)).ToList();
        }
        // The EXPLAIN header sits on its own line so error positions keep the statement's document lines.
        return new ExplainScript
        {
            Batches = [new ExplainBatch($"EXPLAIN USING JSON\n{sql}", false, true, input.Line - 1, 1)],
            Params = parameters,
        };
    }

    public static bool IsPlanResultSet(ColumnInfo[] columns) =>
        columns.Length == 1 && columns[0].Name.Equals(PlanColumn, StringComparison.OrdinalIgnoreCase);

    public static string OperatorStatsSql(string queryId) =>
        "SELECT STEP_ID, OPERATOR_ID, PARENT_OPERATORS, OPERATOR_TYPE, OPERATOR_STATISTICS, EXECUTION_TIME_BREAKDOWN, OPERATOR_ATTRIBUTES " +
        $"FROM TABLE(GET_QUERY_OPERATOR_STATS({SnowflakeSql.Literal(queryId)})) ORDER BY STEP_ID, OPERATOR_ID";

    public async Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        if (!input.IsActual)
        {
            var json = captured.Where(c => IsPlanResultSet(c.Columns)).SelectMany(c => c.Rows).Select(r => CapturedResultSet.Text(r[0]))
                .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x))
                ?? throw new EngineException(422, ErrorCodes.ProviderError, "Snowflake returned no plan for this statement.");
            return ParseExplain(json);
        }

        var queryId = (session as SnowflakeSession)?.LastQueryId;
        if (string.IsNullOrEmpty(queryId))
            throw new EngineException(422, ErrorCodes.ProviderError, "The statement has no query id (it did not run on the server).");
        SqlRowSet? stats = null;
        string? explain = null;
        await session.RunExclusiveAsync(async (scope, c) =>
        {
            try { stats = await QueryAsync(scope, OperatorStatsSql(queryId), c).ConfigureAwait(false); }
            catch (Exception ex) when (ex is System.Data.Common.DbException) { stats = null; }
            if (stats is null || stats.Rows.Count == 0)
            {
                try
                {
                    var plan = await QueryAsync(scope, "EXPLAIN USING JSON\n" + input.Sql.Trim().TrimEnd(';'), c).ConfigureAwait(false);
                    explain = plan.Rows.Count == 0 ? null : SqlCells.Str(plan.Rows[0][0]);
                }
                catch (Exception ex) when (ex is System.Data.Common.DbException) { explain = null; }
            }
            return true;
        }, ct).ConfigureAwait(false);

        if (stats is { Rows.Count: > 0 })
        {
            var result = ParseOperatorStats(stats);
            return result with { Warnings = [.. result.Warnings, $"Query id {queryId}."] };
        }
        if (explain is not null)
        {
            var est = ParseExplain(explain);
            return est with { Warnings = [.. est.Warnings, StatsUnavailableWarning] };
        }
        throw new EngineException(422, ErrorCodes.ProviderError, StatsUnavailableWarning);
    }

    private static async Task<SqlRowSet> QueryAsync(AdoSessionBase.SessionScope scope, string sql, CancellationToken ct)
    {
        await using var cmd = scope.CreateCommand(sql);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var names = Enumerable.Range(0, r.FieldCount).Select(r.GetName).ToArray();
        var rows = new List<object?[]>();
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var row = new object?[names.Length];
            for (var i = 0; i < row.Length; i++) row[i] = Gateway.SnowflakeDriver.Cell(r, i);
            rows.Add(row);
        }
        return new SqlRowSet(names, rows);
    }

    // ------------------------------------------------------------------ EXPLAIN USING JSON

    /// <summary>
    /// <c>{"GlobalStats":{"partitionsTotal":…,"partitionsAssigned":…,"bytesAssigned":…},"Operations":[[{"id":0,"operation":"Result",…},
    /// {"id":1,"parent":0,"operation":"TableScan","objects":[…],"expressions":[…],"partitionsAssigned":…}]]}</c>. Each inner array is
    /// a step; several steps hang under a synthetic root.
    /// </summary>
    public static PlanResult ParseExplain(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var warnings = new List<string>();
        var steps = new List<PlanNode>();
        var nextId = 1;
        if (root.TryGetProperty("Operations", out var ops) && ops.ValueKind == JsonValueKind.Array)
        {
            foreach (var step in ops.EnumerateArray())
            {
                if (step.ValueKind != JsonValueKind.Array) continue;
                var byId = new Dictionary<long, PlanNode>();
                var parents = new List<(PlanNode Node, IReadOnlyList<long> Parents)>();
                foreach (var op in step.EnumerateArray())
                {
                    var node = new PlanNode { Id = nextId++, Op = Str(op, "operation") ?? "Operation" };
                    if (op.TryGetProperty("objects", out var objs) && objs.ValueKind == JsonValueKind.Array)
                        node.Object = string.Join(", ", objs.EnumerateArray().Select(o => o.ToString()));
                    if (op.TryGetProperty("expressions", out var ex) && ex.ValueKind == JsonValueKind.Array)
                    {
                        var list = ex.EnumerateArray().Select(e => e.ToString()).ToList();
                        if (node.Op is "Filter" or "InnerJoin" or "LeftOuterJoin" or "RightOuterJoin" or "FullOuterJoin" or "CartesianJoin" or "Join"
                            || node.Op.EndsWith("Join", StringComparison.Ordinal))
                            node.Predicate = string.Join(" AND ", list);
                        else node.SetProp("Expressions", string.Join("; ", list));
                    }
                    var assigned = Num(op, "partitionsAssigned");
                    var total = Num(op, "partitionsTotal");
                    if (assigned is not null) node.SetProp("Partitions assigned", Fmt(assigned));
                    if (total is not null) node.SetProp("Partitions total", Fmt(total));
                    if (Num(op, "bytesAssigned") is { } bytes) node.SetProp("Bytes assigned", Fmt(bytes));
                    if (assigned is not null && total is > 1 && assigned >= total && node.Op == "TableScan")
                        node.Warnings.Add("No partition pruning: every micro-partition is scanned.");
                    var id = (long)(Num(op, "id") ?? -1);
                    if (id >= 0) byId[id] = node;
                    parents.Add((node, ParentsOf(op)));
                }
                var roots = new List<PlanNode>();
                foreach (var (node, ps) in parents)
                {
                    var parent = ps.Select(p => byId.GetValueOrDefault(p)).FirstOrDefault(p => p is not null);
                    if (parent is null) roots.Add(node);
                    else parent.Children.Add(node);
                }
                steps.AddRange(roots);
            }
        }
        var planRoot = steps.Count == 1 ? steps[0] : new PlanNode { Id = 0, Op = "Query", Children = steps };
        if (root.TryGetProperty("GlobalStats", out var gs) && gs.ValueKind == JsonValueKind.Object)
        {
            if (Num(gs, "partitionsAssigned") is { } a) planRoot.SetProp("Partitions assigned (query)", Fmt(a));
            if (Num(gs, "partitionsTotal") is { } t) planRoot.SetProp("Partitions total (query)", Fmt(t));
            if (Num(gs, "bytesAssigned") is { } b) planRoot.SetProp("Bytes assigned (query)", Fmt(b));
        }
        foreach (var n in planRoot.DescendantsAndSelf()) n.Warnings = n.Warnings.Distinct().ToList();
        PlanTree.ComputeCostPercentages(planRoot);
        return new PlanResult(planRoot, Pretty(json), "json", warnings);
    }

    private static IReadOnlyList<long> ParentsOf(JsonElement op)
    {
        if (op.TryGetProperty("parent", out var p) && p.ValueKind == JsonValueKind.Number) return [p.GetInt64()];
        if (op.TryGetProperty("parents", out var ps) && ps.ValueKind == JsonValueKind.Array)
            return ps.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Number).Select(x => x.GetInt64()).ToList();
        return [];
    }

    // ------------------------------------------------------------------ GET_QUERY_OPERATOR_STATS

    /// <summary>Operator rows (STEP_ID, OPERATOR_ID, PARENT_OPERATORS, OPERATOR_TYPE, OPERATOR_STATISTICS, EXECUTION_TIME_BREAKDOWN, OPERATOR_ATTRIBUTES) → tree.</summary>
    public static PlanResult ParseOperatorStats(SqlRowSet rs)
    {
        var steps = new List<PlanNode>();
        var raw = new List<Dictionary<string, object?>>();
        var nextId = 1;
        foreach (var step in rs.Rows.GroupBy(r => rs.Long(r, "STEP_ID") ?? 1).OrderBy(g => g.Key))
        {
            var byId = new Dictionary<long, PlanNode>();
            var parents = new List<(PlanNode Node, IReadOnlyList<long> Parents, double Own)>();
            foreach (var r in step.OrderBy(r => rs.Long(r, "OPERATOR_ID") ?? 0))
            {
                var node = new PlanNode { Id = nextId++, Op = rs.Str(r, "OPERATOR_TYPE") ?? "Operator" };
                var statsJson = rs.Str(r, "OPERATOR_STATISTICS");
                var timeJson = rs.Str(r, "EXECUTION_TIME_BREAKDOWN");
                var attrJson = rs.Str(r, "OPERATOR_ATTRIBUTES");
                raw.Add(new Dictionary<string, object?>
                {
                    ["step"] = step.Key, ["operator"] = rs.Long(r, "OPERATOR_ID"), ["parents"] = rs.Str(r, "PARENT_OPERATORS"), ["type"] = node.Op,
                    ["statistics"] = statsJson, ["time"] = timeJson, ["attributes"] = attrJson,
                });
                double own = 0;
                using (var stats = TryParse(statsJson))
                {
                    if (stats is not null)
                    {
                        var s = stats.RootElement;
                        node.ActualRows = Num(s, "output_rows");
                        if (Num(s, "input_rows") is { } input) node.SetProp("Input rows", Fmt(input));
                        if (s.TryGetProperty("pruning", out var pr) && pr.ValueKind == JsonValueKind.Object)
                        {
                            var scanned = Num(pr, "partitions_scanned");
                            var total = Num(pr, "partitions_total");
                            if (scanned is not null) node.SetProp("Partitions scanned", Fmt(scanned));
                            if (total is not null) node.SetProp("Partitions total", Fmt(total));
                            if (scanned is not null && total is > 1 && scanned >= total) node.Warnings.Add("No partition pruning: every micro-partition was scanned.");
                        }
                        if (s.TryGetProperty("io", out var io) && io.ValueKind == JsonValueKind.Object)
                        {
                            if (Num(io, "bytes_scanned") is { } bs) node.SetProp("Bytes scanned", Fmt(bs));
                            if (Num(io, "percentage_scanned_from_cache") is { } pc) node.SetProp("Scanned from cache (%)", Fmt(Math.Round(pc * 100, 1)));
                        }
                        if (s.TryGetProperty("spilling", out var sp) && sp.ValueKind == JsonValueKind.Object)
                        {
                            if (Num(sp, "bytes_spilled_local_storage") is > 0 and var local)
                                node.Warnings.Add($"Spilled {Mb(local)} to local storage (the warehouse ran out of memory).");
                            if (Num(sp, "bytes_spilled_remote_storage") is > 0 and var remote)
                                node.Warnings.Add($"Spilled {Mb(remote)} to remote storage: consider a larger warehouse.");
                        }
                        if (s.TryGetProperty("network", out var nw) && nw.ValueKind == JsonValueKind.Object && Num(nw, "network_bytes") is { } nb)
                            node.SetProp("Network bytes", Fmt(nb));
                    }
                }
                using (var time = TryParse(timeJson))
                {
                    if (time is not null && Num(time.RootElement, "overall_percentage") is { } pct)
                    {
                        own = pct * 100;
                        node.SetProp("Time (% of query)", Fmt(Math.Round(own, 1)));
                    }
                }
                using (var attrs = TryParse(attrJson))
                {
                    if (attrs is not null)
                    {
                        var a = attrs.RootElement;
                        node.Object = Str(a, "table_name");
                        var predicate = Str(a, "filter_condition") ?? Str(a, "equality_join_condition") ?? Str(a, "additional_join_condition");
                        if (predicate is not null) node.Predicate = predicate;
                        if (Str(a, "join_type") is { } jt) node.LogicalOp = jt;
                        foreach (var key in new[] { "columns", "grouping_keys", "functions", "sort_keys", "expressions", "rows" })
                            if (a.TryGetProperty(key, out var v)) node.SetProp(key.Replace('_', ' '), v.ValueKind == JsonValueKind.Array ? string.Join(", ", v.EnumerateArray().Select(x => x.ToString())) : v.ToString());
                    }
                }
                var id = rs.Long(r, "OPERATOR_ID") ?? -1;
                byId[id] = node;
                parents.Add((node, ParseIds(rs.Str(r, "PARENT_OPERATORS")), own));
            }
            var roots = new List<PlanNode>();
            foreach (var (node, ps, own) in parents)
            {
                node.Cost = own;
                var parent = ps.Select(p => byId.GetValueOrDefault(p)).FirstOrDefault(p => p is not null);
                if (parent is null) roots.Add(node);
                else parent.Children.Add(node);
            }
            steps.AddRange(roots);
        }
        var root = steps.Count == 1 ? steps[0] : new PlanNode { Id = 0, Op = "Query", Cost = 0, Children = steps };
        // Cost = subtree share of the execution time, so CostPct is each operator's own share.
        Accumulate(root);
        foreach (var n in root.DescendantsAndSelf()) n.Warnings = n.Warnings.Distinct().ToList();
        PlanTree.ComputeCostPercentages(root);
        return new PlanResult(root, JsonSerializer.Serialize(raw, new JsonSerializerOptions { WriteIndented = true }), "json", []);
    }

    private static double Accumulate(PlanNode n)
    {
        var own = n.Cost ?? 0;
        var total = own + n.Children.Sum(Accumulate);
        n.Cost = total;
        return total;
    }

    /// <summary>"[0]", "[1, 2]", "1" → ids.</summary>
    public static IReadOnlyList<long> ParseIds(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return [];
        return text.Trim().Trim('[', ']').Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(x => long.TryParse(x, NumberStyles.Integer, Inv, out var v) ? v : -1).Where(v => v >= 0).ToList();
    }

    private static JsonDocument? TryParse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonDocument.Parse(json); } catch (JsonException) { return null; }
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? null : v.ToString() : null;

    private static double? Num(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    private static string Fmt(double? v) => v is null ? "" : v.Value.ToString("0.###", Inv);

    private static string Mb(double bytes) => (bytes / 1024 / 1024).ToString("0.#", Inv) + " MB";

    private static string Pretty(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (JsonException)
        {
            return json;
        }
    }
}
