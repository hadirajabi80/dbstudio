using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.PostgreSql.Plans;

/// <summary>
/// PostgreSQL plans (docs/PLAN-PG.md D-PG8, 2.8): <c>EXPLAIN (FORMAT JSON, VERBOSE, COSTS [, GENERIC_PLAN])</c> for the
/// estimated plan (nothing runs) and <c>EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS, TIMING, FORMAT JSON)</c> for the actual
/// plan. EXPLAIN ANALYZE executes the statement but discards its rows; for a read-only query the statement additionally
/// runs once normally so its result set is delivered (it runs twice), any other statement runs only under EXPLAIN
/// ANALYZE (its rows are not returned; a warning says so). JSON plan nodes become <see cref="PlanNode"/>s.
/// </summary>
public sealed class PgPlanReader : IPlanReader
{
    public const string PlanColumn = "QUERY PLAN";
    public const string EstimatedOptions = "FORMAT JSON, VERBOSE true, COSTS true";
    public const string ActualOptions = "ANALYZE true, BUFFERS true, VERBOSE true, COSTS true, TIMING true, FORMAT JSON";
    public const string RanTwiceWarning = "The query ran twice: once for its rows and once under EXPLAIN ANALYZE for the plan.";
    public const string RowsNotReturnedWarning = "EXPLAIN ANALYZE executed the statement; its result rows are not returned.";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => "postgresql";

    public ExplainScript CreateScript(ExplainInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var sql = input.Sql.Trim().TrimEnd(';').TrimEnd();
        // The EXPLAIN header sits on its own line so the statement keeps its document lines for error positions.
        var line = input.Line - 1;
        if (input.IsActual)
        {
            var explain = new ExplainBatch($"EXPLAIN ({ActualOptions})\n{sql}", false, true, line, 1);
            return new ExplainScript
            {
                Batches = DeliversRows(sql) ? [new ExplainBatch(sql, true, false, input.Line, input.Col), explain] : [explain],
                Params = input.Params,
            };
        }

        var hasPlaceholders = PgSqlText.Placeholders(sql).Count > 0;
        var noParams = input.Params is not { Count: > 0 };
        if (hasPlaceholders && noParams && PostgreSqlProvider.MajorVersion(input.ServerVersion) >= 16)
        {
            // Plan with the parameters left unbound: $n stay placeholders (named ones are rewritten to $n first).
            var text = PgSqlText.Rewrite(sql).Text;
            return new ExplainScript { Batches = [new ExplainBatch($"EXPLAIN ({EstimatedOptions}, GENERIC_PLAN true)\n{text}", false, true, line, 1)] };
        }
        var parameters = input.Params;
        if (hasPlaceholders && noParams)
        {
            // Older servers: plan for NULL values (the type is inferred from the context).
            parameters = PgSqlText.Placeholders(sql).Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(n => new QueryParam(n, ParamKinds.Null)).ToList();
        }
        return new ExplainScript { Batches = [new ExplainBatch($"EXPLAIN ({EstimatedOptions})\n{sql}", false, true, line, 1)], Params = parameters };
    }

    /// <summary>A single read-only query: safe to run once more for its rows.</summary>
    public static bool DeliversRows(string sql)
    {
        var c = PgSqlText.Classify(sql);
        return c.IsQueryOnly && c.Statements.Count == 1 && c.Statements[0].Category == StatementCategory.Query
               && c.Statements[0].Kind is "SELECT" or "VALUES" or "TABLE";
    }

    public static bool IsPlanResultSet(ColumnInfo[] columns) =>
        columns.Length == 1 && columns[0].Name.Equals(PlanColumn, StringComparison.OrdinalIgnoreCase);

    public Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        var json = captured.Where(c => IsPlanResultSet(c.Columns)).SelectMany(c => c.Rows).Select(r => CapturedResultSet.Text(r[0]))
            .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
        if (json is null)
            throw new EngineException(422, ErrorCodes.ProviderError, "The server returned no execution plan for this statement.");
        var result = Parse(json, input.IsActual);
        if (input.IsActual)
        {
            var extra = DeliversRows(input.Sql.Trim().TrimEnd(';')) ? RanTwiceWarning : RowsNotReturnedWarning;
            result = result with { Warnings = [.. result.Warnings, extra] };
        }
        return Task.FromResult(result);
    }

    /// <summary>Parses EXPLAIN (FORMAT JSON) output: <c>[ { "Plan": {…}, "Planning Time", "Execution Time", "Triggers", "JIT" } ]</c>.</summary>
    public static PlanResult Parse(string json, bool actual)
    {
        using var doc = JsonDocument.Parse(json);
        var top = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().FirstOrDefault() : doc.RootElement;
        if (top.ValueKind != JsonValueKind.Object || !top.TryGetProperty("Plan", out var planElement))
            throw new EngineException(422, ErrorCodes.ProviderError, "The EXPLAIN output has no plan.");

        var nextId = 1;
        var root = ToNode(planElement, actual, ref nextId);
        var warnings = new List<string>();
        root.SetProp("Planning Time (ms)", Num(top, "Planning Time"));
        root.SetProp("Execution Time (ms)", Num(top, "Execution Time"));
        if (top.TryGetProperty("Triggers", out var triggers) && triggers.ValueKind == JsonValueKind.Array)
        {
            var list = triggers.EnumerateArray().Select(t => $"{Str(t, "Trigger Name")} on {Str(t, "Relation")}: {Num(t, "Time")} ms × {Num(t, "Calls")}").ToList();
            if (list.Count > 0) root.SetProp("Triggers", string.Join("; ", list));
        }
        if (top.TryGetProperty("JIT", out var jit) && jit.ValueKind == JsonValueKind.Object)
        {
            var functions = Num(jit, "Functions");
            var w = $"JIT compilation was used ({functions ?? "?"} functions)";
            root.Warnings.Add(w);
            warnings.Add(w);
        }
        foreach (var n in root.DescendantsAndSelf()) n.Warnings = n.Warnings.Distinct().ToList();
        PlanTree.ComputeCostPercentages(root);
        string pretty;
        using (var stream = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
                doc.RootElement.WriteTo(writer);
            pretty = System.Text.Encoding.UTF8.GetString(stream.ToArray()).Replace("\r\n", "\n");
        }
        return new PlanResult(root, pretty, "json", warnings);
    }

    private static PlanNode ToNode(JsonElement p, bool actual, ref int nextId)
    {
        var nodeType = Str(p, "Node Type") ?? "?";
        var join = Str(p, "Join Type");
        var strategy = Str(p, "Strategy");
        var partial = Str(p, "Partial Mode");
        var op = nodeType;
        if (join is not null && join != "Inner") op += $" ({join})";
        if (strategy is not null && strategy != "Plain") op += $" ({strategy})";
        if (partial is not null && partial != "Simple") op += $" ({partial})";
        if (Str(p, "Scan Direction") == "Backward") op += " Backward";

        var node = new PlanNode
        {
            Id = nextId++,
            Op = op,
            LogicalOp = join ?? strategy ?? partial ?? Str(p, "Command") ?? Str(p, "Operation"),
            Object = ObjectName(p, nodeType),
            EstRows = Dbl(p, "Plan Rows"),
            Cost = Dbl(p, "Total Cost"),
        };
        var preds = new[] { "Index Cond", "Recheck Cond", "Filter", "Hash Cond", "Merge Cond", "Join Filter", "TID Cond", "One-Time Filter" }
            .Select(k => Str(p, k)).Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
        if (preds.Count > 0) node.Predicate = string.Join(" AND ", preds);

        var loops = Dbl(p, "Actual Loops");
        var actualRows = Dbl(p, "Actual Rows");
        if (actualRows is not null) node.ActualRows = actualRows * (loops ?? 1);
        if (p.TryGetProperty("Never Executed", out var ne) && ne.ValueKind == JsonValueKind.True) node.SetProp("Never executed", "true");

        node.SetProp("Startup Cost", Num(p, "Startup Cost"));
        node.SetProp("Plan Width", Num(p, "Plan Width"));
        node.SetProp("Actual Startup Time (ms)", Num(p, "Actual Startup Time"));
        node.SetProp("Actual Total Time (ms)", Num(p, "Actual Total Time"));
        node.SetProp("Actual Loops", Num(p, "Actual Loops"));
        foreach (var key in new[]
                 {
                     "Rows Removed by Filter", "Rows Removed by Index Recheck", "Rows Removed by Join Filter", "Heap Fetches",
                     "Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks", "Shared Written Blocks",
                     "Local Hit Blocks", "Local Read Blocks", "Temp Read Blocks", "Temp Written Blocks",
                     "Sort Method", "Sort Space Used", "Sort Space Type", "Hash Buckets", "Hash Batches", "Peak Memory Usage",
                     "Workers Planned", "Workers Launched", "Parent Relationship", "Subplan Name", "Index Name", "CTE Name",
                     "Function Name", "Group Key", "Presorted Key", "Cache Key",
                 })
        {
            node.SetProp(key, Text(p, key));
        }
        node.SetProp("Sort Key", Text(p, "Sort Key"));
        node.SetProp("Output", Text(p, "Output"));
        if (p.TryGetProperty("Parallel Aware", out var pa) && pa.ValueKind == JsonValueKind.True) node.SetProp("Parallel Aware", "true");

        // Warnings (docs/PLAN-PG.md 2.8).
        if (nodeType == "Seq Scan" && node.EstRows is >= 10_000)
            node.Warnings.Add($"Sequential scan of {node.Object ?? "a table"} ({node.EstRows.Value.ToString("0", Inv)} rows estimated)");
        var removed = Dbl(p, "Rows Removed by Filter");
        if (removed is > 0 && actualRows is not null && removed * (loops ?? 1) > 10 * Math.Max(1, actualRows.Value * (loops ?? 1)))
            node.Warnings.Add("Filter discards most rows: an index on the filtered columns may help");
        if (actual && node.EstRows is { } est && actualRows is { } act && est > 0 && (act > est * 10 || act * 10 < est) && Math.Abs(act - est) > 100)
            node.Warnings.Add($"Row estimate off: estimated {est.ToString("0.#", Inv)}, actual {act.ToString("0.#", Inv)} per loop");
        if (Str(p, "Sort Space Type") == "Disk" || Dbl(p, "Temp Read Blocks") is > 0 || Dbl(p, "Temp Written Blocks") is > 0)
            node.Warnings.Add(nodeType.Contains("Sort", StringComparison.Ordinal) ? "Sort spilled to disk" : "Operator spilled to temporary files");
        if (Dbl(p, "Hash Batches") is > 1) node.Warnings.Add($"Hash split into {Num(p, "Hash Batches")} batches (work_mem too small)");
        if (Dbl(p, "Workers Launched") is { } launched && Dbl(p, "Workers Planned") is { } planned && launched < planned)
            node.Warnings.Add($"Only {launched.ToString("0", Inv)} of {planned.ToString("0", Inv)} parallel workers launched");

        if (p.TryGetProperty("Plans", out var plans) && plans.ValueKind == JsonValueKind.Array)
            foreach (var child in plans.EnumerateArray()) node.Children.Add(ToNode(child, actual, ref nextId));
        return node;
    }

    /// <summary>schema.relation (alias), schema.relation.index for index scans, CTE / function names.</summary>
    private static string? ObjectName(JsonElement p, string nodeType)
    {
        var relation = Str(p, "Relation Name");
        var schema = Str(p, "Schema");
        var alias = Str(p, "Alias");
        var index = Str(p, "Index Name");
        if (relation is not null)
        {
            var name = schema is null ? relation : $"{schema}.{relation}";
            if (index is not null && nodeType.Contains("Index", StringComparison.Ordinal)) name += "." + index;
            return alias is not null && alias != relation ? $"{name} ({alias})" : name;
        }
        if (index is not null) return schema is null ? index : $"{schema}.{index}";
        if (Str(p, "CTE Name") is { } cte) return alias is not null && alias != cte ? $"{cte} ({alias})" : cte;
        if (Str(p, "Function Name") is { } fn) return schema is null ? fn : $"{schema}.{fn}";
        return null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static double? Dbl(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;

    private static string? Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetRawText() : null;

    /// <summary>Any scalar or array property as display text (arrays joined with ", ").</summary>
    private static string? Text(JsonElement e, string name)
    {
        if (!e.TryGetProperty(name, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Number => v.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => null,
            JsonValueKind.Array => string.Join(", ", v.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : x.GetRawText())),
            _ => null,
        };
    }
}
