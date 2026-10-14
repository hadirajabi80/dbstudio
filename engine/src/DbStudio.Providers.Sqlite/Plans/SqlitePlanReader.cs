using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Sqlite.Plans;

/// <summary>
/// SQLite plans (docs/PLAN-M1.5.md A5): <c>EXPLAIN QUERY PLAN</c> rows (id, parent, notused, detail) → tree.
/// Actual mode runs the statement normally first; SQLite has no runtime statistics, so the tree is the same.
/// </summary>
public sealed partial class SqlitePlanReader : IPlanReader
{
    public const string ExplainPrefix = "EXPLAIN QUERY PLAN\n";

    public string ProviderId => "sqlite";

    public ExplainScript CreateScript(ExplainInput input)
    {
        var sql = input.Sql.Trim().TrimEnd(';').TrimEnd();
        if (input.IsActual)
            return new ExplainScript { Batches = [new ExplainBatch(sql, Visible: true, CaptureAll: false, input.Line, input.Col)], Params = input.Params };
        return new ExplainScript
        {
            Batches = [new ExplainBatch(ExplainPrefix + sql, Visible: false, CaptureAll: true, Math.Max(0, input.Line - 1), 1)],
            Params = input.Params,
        };
    }

    public async Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        List<(long Id, long Parent, string Detail)> rows;
        if (captured.Count > 0)
        {
            rows = captured[0].Rows.Select(r => ((long)(CapturedResultSet.Number(r[0]) ?? 0), (long)(CapturedResultSet.Number(r[1]) ?? 0), CapturedResultSet.Text(r[^1]) ?? "")).ToList();
        }
        else
        {
            var sql = ExplainPrefix + input.Sql.Trim().TrimEnd(';').TrimEnd();
            rows = await session.RunExclusiveAsync(async (scope, token) =>
            {
                var list = new List<(long, long, string)>();
                await using var cmd = scope.CreateCommand(sql);
                if (input.Params is { Count: > 0 } ps && scope.Binder is { } binder) binder.Bind(cmd, ps, new ParamBindCursor());
                await using var r = await cmd.ExecuteReaderAsync(token).ConfigureAwait(false);
                while (await r.ReadAsync(token).ConfigureAwait(false))
                    list.Add((Convert.ToInt64(r.GetValue(0)), Convert.ToInt64(r.GetValue(1)), Convert.ToString(r.GetValue(r.FieldCount - 1)) ?? ""));
                return list;
            }, ct).ConfigureAwait(false);
        }
        var warnings = new List<string>();
        if (input.IsActual) warnings.Add("SQLite reports no runtime statistics; the plan shown is the query plan.");
        var root = BuildTree(rows);
        return new PlanResult(root, ToRawText(rows), "text", warnings);
    }

    /// <summary>Rows in output order; parent 0 = top level. Several top-level rows get a synthetic "QUERY PLAN" root.</summary>
    public static PlanNode BuildTree(IReadOnlyList<(long Id, long Parent, string Detail)> rows)
    {
        var nodes = new Dictionary<long, PlanNode>();
        var top = new List<PlanNode>();
        foreach (var (id, parent, detail) in rows)
        {
            var node = ToNode((int)id, detail);
            nodes[id] = node;
            if (parent != 0 && nodes.TryGetValue(parent, out var p)) p.Children.Add(node);
            else top.Add(node);
        }
        if (top.Count == 1) return top[0];
        var root = new PlanNode { Id = 0, Op = "QUERY PLAN", Children = top };
        return root;
    }

    [GeneratedRegex(@"^(?<verb>SCAN|SEARCH)\s+(?:TABLE\s+)?(?<table>[^\s(]+)(?:\s+AS\s+(?<alias>\S+))?(?<rest>.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex ScanSearch();

    [GeneratedRegex(@"\((?<pred>[^()]*)\)\s*$")]
    private static partial Regex TrailingParens();

    public static PlanNode ToNode(int id, string detail)
    {
        var node = new PlanNode { Id = id, Op = detail.Trim() };
        var m = ScanSearch().Match(node.Op);
        if (m.Success)
        {
            node.LogicalOp = m.Groups["verb"].Value.ToUpperInvariant() == "SCAN" ? "Scan" : "Seek";
            node.Object = m.Groups["table"].Value;
            var rest = m.Groups["rest"].Value;
            var pred = TrailingParens().Match(rest);
            if (pred.Success) node.Predicate = pred.Groups["pred"].Value.Trim();
            var idx = Regex.Match(rest, @"USING (?:(?:COVERING|AUTOMATIC (?:COVERING )?|INTEGER PRIMARY KEY|PRIMARY KEY)\s*)?INDEX\s+(\S+)", RegexOptions.IgnoreCase);
            if (idx.Success) node.SetProp("Index", idx.Groups[1].Value);
            if (m.Groups["alias"].Success) node.SetProp("Alias", m.Groups["alias"].Value);
            if (node.LogicalOp == "Scan" && !rest.Contains("USING", StringComparison.OrdinalIgnoreCase))
                node.Warnings.Add($"Full scan of {node.Object}");
            if (rest.Contains("AUTOMATIC", StringComparison.OrdinalIgnoreCase))
                node.Warnings.Add("SQLite builds a temporary (automatic) index; consider a permanent one.");
        }
        else if (node.Op.StartsWith("USE TEMP B-TREE", StringComparison.OrdinalIgnoreCase))
        {
            node.LogicalOp = "Sort";
            node.Warnings.Add("Temporary B-tree: " + node.Op[15..].Trim().ToLowerInvariant());
        }
        else
        {
            var first = node.Op.Split(' ', 2)[0];
            node.LogicalOp = first.Length > 0 ? char.ToUpperInvariant(first[0]) + first[1..].ToLowerInvariant() : null;
        }
        return node;
    }

    /// <summary>The sqlite3 shell's rendering: "QUERY PLAN", then "|--" / "`--" branches.</summary>
    public static string ToRawText(IReadOnlyList<(long Id, long Parent, string Detail)> rows)
    {
        var children = rows.GroupBy(r => r.Parent).ToDictionary(g => g.Key, g => g.ToList());
        var sb = new StringBuilder("QUERY PLAN\n");
        void Walk(long parent, string indent)
        {
            if (!children.TryGetValue(parent, out var list)) return;
            for (var i = 0; i < list.Count; i++)
            {
                var last = i == list.Count - 1;
                sb.Append(indent).Append(last ? "`--" : "|--").Append(list[i].Detail).Append('\n');
                Walk(list[i].Id, indent + (last ? "   " : "|  "));
            }
        }
        Walk(0, "");
        return sb.ToString();
    }
}
