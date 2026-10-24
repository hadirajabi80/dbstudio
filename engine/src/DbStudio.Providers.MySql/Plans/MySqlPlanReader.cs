using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.MySql.Plans;

/// <summary>
/// MySQL / MariaDB plans (plan-batch3 WP-MY). Estimated: <c>EXPLAIN FORMAT=JSON</c> (nothing runs; placeholders without
/// values plan for NULL). Actual: MySQL 8.0.18+ <c>EXPLAIN ANALYZE</c> (TREE text with costs, estimated and actual rows),
/// MariaDB <c>ANALYZE FORMAT=JSON</c> (r_rows, r_total_time_ms), older MySQL the estimated JSON. Both actual forms execute
/// the statement and discard its rows: a single read-only query additionally runs once normally so its result set is
/// delivered (it runs twice); other statements only run under ANALYZE and a warning says their rows are not returned.
/// </summary>
public sealed partial class MySqlPlanReader(string providerId = "mysql") : IPlanReader
{
    public const string RanTwiceWarning = "The query ran twice: once for its rows and once under EXPLAIN ANALYZE for the plan.";
    public const string RowsNotReturnedWarning = "ANALYZE executed the statement; its result rows are not returned.";
    public const string EstimatedOnlyWarning = "This server has no EXPLAIN ANALYZE (MySQL 8.0.18+): the plan shows estimates only.";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => providerId;

    public ExplainScript CreateScript(ExplainInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var sql = Statement(input.Sql);
        var flavor = FlavorOf(input);
        var line = Math.Max(1, input.Line - 1);
        if (input.IsActual)
        {
            ExplainBatch plan;
            if (flavor.IsMariaDb) plan = new ExplainBatch($"ANALYZE FORMAT=JSON\n{sql}", false, true, line, 1);
            else if (flavor.HasExplainAnalyze || flavor.Major == 0) plan = new ExplainBatch($"EXPLAIN ANALYZE\n{sql}", false, true, line, 1);
            else plan = new ExplainBatch($"EXPLAIN FORMAT=JSON\n{sql}", false, true, line, 1);
            var runsTwice = DeliversRows(sql) || (!flavor.IsMariaDb && !flavor.HasExplainAnalyze && flavor.Major > 0);
            return new ExplainScript
            {
                Batches = runsTwice ? [new ExplainBatch(sql, true, false, input.Line, input.Col), plan] : [plan],
                Params = input.Params,
            };
        }
        var parameters = input.Params;
        if (parameters is not { Count: > 0 })
        {
            // Plan for NULL values: the text keeps its shape (user @variables stay variables).
            var placeholders = MySqlSqlText.Placeholders(sql).Where(p => p.Prefix != '@').ToList();
            if (placeholders.Count > 0)
            {
                var list = placeholders.Where(p => p.Name is not null).Select(p => p.Name!).Distinct(StringComparer.OrdinalIgnoreCase)
                    .Select(n => new QueryParam(n, ParamKinds.Null)).ToList();
                var unnamed = placeholders.Count(p => p.Name is null);
                for (var i = 1; i <= unnamed; i++) list.Add(new QueryParam(i.ToString(Inv), ParamKinds.Null));
                parameters = list;
            }
        }
        return new ExplainScript { Batches = [new ExplainBatch($"EXPLAIN FORMAT=JSON\n{sql}", false, true, line, 1)], Params = parameters };
    }

    /// <summary>The server flavor from the session's version; without one, the provider id decides (mariadb → MariaDB).</summary>
    private MySqlFlavor FlavorOf(ExplainInput input)
    {
        var f = MySqlFlavor.From(input.ServerVersion, null);
        return f.Major == 0 && providerId == "mariadb" ? f with { IsMariaDb = true, Major = 10, Minor = 6 } : f;
    }

    /// <summary>The statement without its delimiter / DELIMITER lines.</summary>
    internal static string Statement(string sql)
    {
        var parts = MySqlSqlText.Split(sql);
        return parts.Count == 1 ? parts[0].Text(sql) : sql.Trim().TrimEnd(';').TrimEnd();
    }

    /// <summary>A single read-only query: safe to run once more for its rows.</summary>
    public static bool DeliversRows(string sql)
    {
        var c = MySqlSqlText.Classify(sql);
        return c.IsQueryOnly && c.Statements.Count == 1 && c.Statements[0].Category == StatementCategory.Query
               && c.Statements[0].Kind is "SELECT" or "VALUES" or "TABLE";
    }

    public static bool IsPlanResultSet(ColumnInfo[] columns) =>
        columns.Length == 1 && columns[0].Name.ToUpperInvariant() is "EXPLAIN" or "ANALYZE";

    public Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        var text = string.Join("\n", captured.SelectMany(c => c.Rows).Select(r => CapturedResultSet.Text(r[0])).Where(x => !string.IsNullOrWhiteSpace(x)));
        if (string.IsNullOrWhiteSpace(text))
            throw new EngineException(422, ErrorCodes.ProviderError, "The server returned no execution plan for this statement.");
        var result = text.TrimStart().StartsWith('{') ? ParseJson(text) : ParseTree(text);
        if (input.IsActual)
        {
            var flavor = FlavorOf(input);
            var extra = new List<string>();
            if (!flavor.IsMariaDb && !flavor.HasExplainAnalyze && flavor.Major > 0) extra.Add(EstimatedOnlyWarning);
            else extra.Add(DeliversRows(Statement(input.Sql)) ? RanTwiceWarning : RowsNotReturnedWarning);
            result = result with { Warnings = [.. result.Warnings, .. extra] };
        }
        return Task.FromResult(result);
    }

    // ------------------------------------------------------------------ JSON (EXPLAIN FORMAT=JSON / MariaDB ANALYZE FORMAT=JSON)

    private static readonly HashSet<string> Structural = new(StringComparer.Ordinal)
    {
        "query_block", "nested_loop", "table", "ordering_operation", "grouping_operation", "duplicates_removal", "union_result",
        "query_specifications", "materialized_from_subquery", "attached_subqueries", "optimized_away_subqueries", "select_list_subqueries",
        "order_by_subqueries", "group_by_subqueries", "having_subqueries", "windowing", "buffer_result", "read_sorted_file", "filesort",
        "temporary_table", "subqueries", "block-nl-join", "expression_cache", "window_functions_computation", "query_optimization",
        "having_condition", "duplicate_removal", "materialized", "union_tables",
    };

    public static PlanResult ParseJson(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var rootEl = doc.RootElement;
        var nextId = 1;
        PlanNode root;
        if (rootEl.TryGetProperty("query_block", out var qb)) root = Build("query_block", qb, ref nextId);
        else root = Build("query_block", rootEl, ref nextId);
        foreach (var n in root.DescendantsAndSelf()) n.Warnings = n.Warnings.Distinct().ToList();
        PlanTree.ComputeCostPercentages(root);
        var warnings = root.DescendantsAndSelf().SelectMany(n => n.Warnings).Distinct().ToList();
        string pretty;
        using (var stream = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true })) rootEl.WriteTo(writer);
            pretty = System.Text.Encoding.UTF8.GetString(stream.ToArray());
        }
        return new PlanResult(root, pretty, "text", warnings);
    }

    private static PlanNode Build(string key, JsonElement e, ref int nextId)
    {
        var node = new PlanNode { Id = nextId++, Op = OpName(key, e) };
        if (e.ValueKind != JsonValueKind.Object) return node;
        if (key == "table") FillTable(node, e);
        foreach (var p in e.EnumerateObject())
        {
            if (!Structural.Contains(p.Name) || p.Name == "having_condition") { if (key != "table") Scalar(node, p); continue; }
            switch (p.Value.ValueKind)
            {
                case JsonValueKind.Object:
                    node.Children.Add(Build(p.Name, p.Value, ref nextId));
                    break;
                case JsonValueKind.Array:
                    var holder = p.Name is "nested_loop" or "query_specifications" or "union_tables" ? node : null;
                    PlanNode? group = null;
                    if (holder is null && p.Name.EndsWith("subqueries", StringComparison.Ordinal))
                    {
                        group = new PlanNode { Id = nextId++, Op = "Subqueries" };
                        node.Children.Add(group);
                    }
                    foreach (var item in p.Value.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object) continue;
                        var target = group ?? node;
                        var inner = item.EnumerateObject().FirstOrDefault(x => Structural.Contains(x.Name) && x.Value.ValueKind == JsonValueKind.Object);
                        target.Children.Add(inner.Name is not null && item.EnumerateObject().Count(x => Structural.Contains(x.Name)) == 1
                            ? Build(inner.Name, inner.Value, ref nextId)
                            : Build(p.Name == "nested_loop" ? "table" : "query_block", item, ref nextId));
                    }
                    break;
            }
        }
        if (node.Cost is null && node.Children.Count > 0 && node.Children.All(c => c.Cost is not null))
            node.Cost = node.Children.Sum(c => c.Cost);
        if (node.EstRows is null && node.Children.Count > 0 && node.Children[^1].EstRows is { } last && key != "query_block") node.EstRows = last;
        if (key == "query_block" && e.TryGetProperty("cost_info", out var ci) && ci.TryGetProperty("query_cost", out var qc)) node.Cost = Number(qc);
        else if (key == "query_block" && e.TryGetProperty("cost", out var mc)) node.Cost = Number(mc);
        return node;
    }

    private static string OpName(string key, JsonElement e) => key switch
    {
        "query_block" => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("select_id", out var id) ? $"Query block #{id}" : "Query block",
        "nested_loop" => "Nested loop",
        "ordering_operation" or "filesort" or "read_sorted_file" => "Sort",
        "grouping_operation" => "Group",
        "duplicates_removal" or "duplicate_removal" => "Distinct",
        "union_result" => "Union",
        "materialized_from_subquery" or "materialized" => "Materialize",
        "windowing" or "window_functions_computation" => "Window",
        "buffer_result" => "Buffer",
        "temporary_table" => "Temporary table",
        "block-nl-join" => "Block nested loop",
        "expression_cache" => "Expression cache",
        "table" => AccessOp(e.ValueKind == JsonValueKind.Object && e.TryGetProperty("access_type", out var at) ? at.GetString() : null),
        _ => key,
    };

    /// <summary>EXPLAIN access_type → operator.</summary>
    internal static string AccessOp(string? accessType) => accessType switch
    {
        "ALL" => "Full table scan",
        "index" => "Full index scan",
        "range" => "Index range scan",
        "ref" or "ref_or_null" => "Index lookup",
        "eq_ref" => "Unique index lookup",
        "const" or "system" => "Single-row lookup",
        "fulltext" => "Full-text search",
        "index_merge" => "Index merge",
        "unique_subquery" or "index_subquery" => "Subquery index lookup",
        null => "Table",
        _ => accessType,
    };

    private static void FillTable(PlanNode node, JsonElement t)
    {
        var table = Str(t, "table_name");
        var key = Str(t, "key");
        node.Object = key is null ? table : $"{table} ({key})";
        node.EstRows = Number(t, "rows_produced_per_join") ?? Number(t, "rows") ?? Number(t, "rows_examined_per_scan");
        node.ActualRows = Number(t, "r_rows");
        if (t.TryGetProperty("cost_info", out var ci))
        {
            var own = (Number(ci, "read_cost") ?? 0) + (Number(ci, "eval_cost") ?? 0);
            node.Cost = own > 0 ? own : Number(ci, "prefix_cost");
            node.SetProp("Prefix cost", Str(ci, "prefix_cost"));
            node.SetProp("Data read per join", Str(ci, "data_read_per_join"));
        }
        else if (Number(t, "cost") is { } c) node.Cost = c;
        node.Predicate = Str(t, "attached_condition") ?? Str(t, "index_condition");
        node.SetProp("Access type", Str(t, "access_type"));
        node.SetProp("Possible keys", List(t, "possible_keys"));
        node.SetProp("Key", key);
        node.SetProp("Used key parts", List(t, "used_key_parts"));
        node.SetProp("Key length", Str(t, "key_length"));
        node.SetProp("Ref", List(t, "ref"));
        node.SetProp("Filtered %", Str(t, "filtered"));
        node.SetProp("Rows examined per scan", Str(t, "rows_examined_per_scan"));
        node.SetProp("Used columns", List(t, "used_columns"));
        node.SetProp("Actual time (ms)", Str(t, "r_total_time_ms"));
        node.SetProp("Actual filtered %", Str(t, "r_filtered"));
        node.SetProp("Loops", Str(t, "r_loops"));
        if (Str(t, "access_type") == "ALL" && (node.EstRows ?? 0) >= 1000) node.Warnings.Add($"Full table scan of {table} ({node.EstRows:0} rows)");
        if (t.TryGetProperty("using_index", out var ui) && ui.ValueKind == JsonValueKind.True) node.SetProp("Covering index", "yes");
    }

    private static void Scalar(PlanNode node, JsonProperty p)
    {
        switch (p.Name)
        {
            case "using_filesort" when p.Value.ValueKind == JsonValueKind.True:
                node.Warnings.Add("Using filesort");
                break;
            case "using_temporary_table" when p.Value.ValueKind == JsonValueKind.True:
            case "using_temporary" when p.Value.ValueKind == JsonValueKind.True:
                node.Warnings.Add("Using temporary table");
                break;
            case "message":
                node.Op = p.Value.GetString() ?? node.Op;
                break;
            case "select_id" or "cost_info" or "cost":
                break;
            case "r_total_time_ms" or "r_loops" or "r_rows" or "filesort_key" or "sort_key" or "access_type" or "table_name":
                node.SetProp(p.Name, p.Value.ToString());
                if (p.Name == "r_rows") node.ActualRows ??= Number(p.Value);
                break;
            default:
                if (p.Value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                    node.SetProp(p.Name, p.Value.ToString());
                break;
        }
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
            ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString()
            : null;

    private static string? List(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? string.Join(", ", v.EnumerateArray().Select(x => x.ToString()))
            : null;

    private static double? Number(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? Number(v) : null;

    private static double? Number(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Number => v.GetDouble(),
        JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, Inv, out var d) => d,
        _ => null,
    };

    // ------------------------------------------------------------------ TREE (EXPLAIN ANALYZE)

    private const string Num = @"[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?";

    [GeneratedRegex(@"\(cost=(?<cost>" + Num + @")(?:\.\.(?<cost2>" + Num + @"))?\s+rows=(?<rows>" + Num + @")\)", RegexOptions.CultureInvariant)]
    private static partial Regex CostRows();

    [GeneratedRegex(@"\(actual time=(?<t1>" + Num + @")\.\.(?<t2>" + Num + @")\s+rows=(?<rows>" + Num + @")\s+loops=(?<loops>\d+)\)", RegexOptions.CultureInvariant)]
    private static partial Regex Actual();

    [GeneratedRegex(@"\(never executed\)", RegexOptions.CultureInvariant)]
    private static partial Regex Never();

    [GeneratedRegex(@"\bon (?<table>`?[\w$]+`?)(?: using (?<index>`?[\w$]+`?))?", RegexOptions.CultureInvariant)]
    private static partial Regex OnTable();

    /// <summary>Parses EXPLAIN ANALYZE / FORMAT=TREE output: one "-> operation (cost=… rows=…) (actual time=… rows=… loops=…)" per line, nested by indentation.</summary>
    public static PlanResult ParseTree(string text)
    {
        var lines = text.Replace("\r", "").Split('\n').Where(l => l.TrimStart().StartsWith("->", StringComparison.Ordinal)).ToList();
        var nextId = 1;
        var root = new PlanNode { Id = nextId++, Op = "Query" };
        var stack = new List<(int Indent, PlanNode Node)> { (-1, root) };
        foreach (var raw in lines)
        {
            var indent = raw.Length - raw.TrimStart().Length;
            var body = raw.TrimStart()[2..].Trim();
            var node = new PlanNode { Id = nextId++ };
            var cut = body.IndexOf("  (", StringComparison.Ordinal);
            var cutCost = body.IndexOf(" (cost=", StringComparison.Ordinal);
            var cutActual = body.IndexOf(" (actual", StringComparison.Ordinal);
            var cutNever = body.IndexOf(" (never", StringComparison.Ordinal);
            var end = new[] { cut, cutCost, cutActual, cutNever }.Where(i => i > 0).DefaultIfEmpty(body.Length).Min();
            var op = body[..end].Trim();
            node.Op = op.Contains(':') && op.StartsWith("Filter", StringComparison.Ordinal) ? "Filter" : op.Split(':')[0].Trim();
            if (op.StartsWith("Filter: ", StringComparison.Ordinal)) node.Predicate = op[8..].Trim();
            var on = OnTable().Match(op);
            if (on.Success)
            {
                var table = on.Groups["table"].Value.Trim('`');
                var index = on.Groups["index"].Success ? on.Groups["index"].Value.Trim('`') : null;
                node.Object = index is null ? table : $"{table} ({index})";
                var cond = op.IndexOf('(', on.Index + on.Length);
                if (cond > 0 && op.EndsWith(')')) node.Predicate ??= op[(cond + 1)..^1];
            }
            var cr = CostRows().Match(body);
            if (cr.Success)
            {
                node.Cost = double.Parse(cr.Groups["cost2"].Success ? cr.Groups["cost2"].Value : cr.Groups["cost"].Value, Inv);
                node.EstRows = double.Parse(cr.Groups["rows"].Value, Inv);
            }
            var ac = Actual().Match(body);
            if (ac.Success)
            {
                var rows = double.Parse(ac.Groups["rows"].Value, Inv);
                var loops = int.Parse(ac.Groups["loops"].Value, Inv);
                node.ActualRows = rows * Math.Max(1, loops);
                node.SetProp("Actual time (ms)", $"{ac.Groups["t1"].Value}..{ac.Groups["t2"].Value}");
                node.SetProp("Loops", ac.Groups["loops"].Value);
                if (node.EstRows is { } est && est > 0 && rows > 0 && (rows / est > 10 || est / rows > 10))
                    node.Warnings.Add($"Row estimate {est:0.##} vs actual {rows:0.##} per loop");
            }
            else if (Never().IsMatch(body)) node.SetProp("Executed", "never");
            if (op.StartsWith("Table scan", StringComparison.Ordinal) && (node.ActualRows ?? node.EstRows ?? 0) >= 1000)
                node.Warnings.Add($"Full table scan of {node.Object}");
            while (stack.Count > 1 && stack[^1].Indent >= indent) stack.RemoveAt(stack.Count - 1);
            stack[^1].Node.Children.Add(node);
            stack.Add((indent, node));
        }
        if (root.Children.Count == 1)
        {
            root = root.Children[0];
        }
        else if (root.Children.Count > 0)
        {
            root.Cost = root.Children.All(c => c.Cost is not null) ? root.Children.Sum(c => c.Cost) : null;
        }
        PlanTree.ComputeCostPercentages(root);
        var warnings = root.DescendantsAndSelf().SelectMany(n => n.Warnings).Distinct().ToList();
        return new PlanResult(root, text, "text", warnings);
    }
}
