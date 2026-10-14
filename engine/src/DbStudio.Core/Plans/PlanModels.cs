using System.Text.Json.Serialization;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;

namespace DbStudio.Core.Plans;

/// <summary>One operator of a normalized execution plan (docs/PLAN-M1.5.md 3.8, ui/src/api/types.ts PlanNode).</summary>
public sealed class PlanNode
{
    public int Id { get; set; }
    public string Op { get; set; } = "";
    public string? LogicalOp { get; set; }
    public string? Object { get; set; }
    public double? EstRows { get; set; }
    public double? ActualRows { get; set; }
    /// <summary>Subtree cost in the provider's unit; null when unknown (SQLite).</summary>
    public double? Cost { get; set; }
    /// <summary>Share of the root's cost spent in this node alone (0–100); null when costs are unknown.</summary>
    public double? CostPct { get; set; }
    public string? Predicate { get; set; }
    public List<string> Warnings { get; set; } = [];
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? Props { get; set; }
    public List<PlanNode> Children { get; set; } = [];

    public IEnumerable<PlanNode> DescendantsAndSelf()
    {
        yield return this;
        foreach (var c in Children)
            foreach (var d in c.DescendantsAndSelf())
                yield return d;
    }

    public void SetProp(string key, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        (Props ??= new Dictionary<string, string>(StringComparer.Ordinal))[key] = value;
    }
}

/// <param name="RawFormat">"xml" | "text".</param>
public sealed record PlanResult(PlanNode Root, string Raw, string RawFormat, IReadOnlyList<string> Warnings);

public static class ExplainModes
{
    public const string Estimated = "estimated", Actual = "actual";
}

/// <summary>Input of an explain request.</summary>
/// <param name="Line">1-based editor line of the statement (error mapping).</param>
public sealed record ExplainInput(
    string ExecutionId,
    string Sql,
    string Mode,
    IReadOnlyList<QueryParam>? Params = null,
    int Line = 1,
    int Col = 1,
    string? ServerVersion = null)
{
    public bool IsActual => Mode == ExplainModes.Actual;
}

/// <param name="Visible">The user's statement: its result sets, counts and messages stream normally (batch index 0).</param>
/// <param name="CaptureAll">Every result set of this batch is plan data (captured, not shown).</param>
public sealed record ExplainBatch(string Sql, bool Visible, bool CaptureAll, int Line = 1, int Col = 1);

/// <summary>What a plan reader runs on the session for one explain request.</summary>
public sealed class ExplainScript
{
    public required IReadOnlyList<ExplainBatch> Batches { get; init; }

    /// <summary>Parameters for the request (the reader may add NULL binds for estimated plans).</summary>
    public IReadOnlyList<QueryParam>? Params { get; init; }

    /// <summary>Result sets of visible batches that carry plan data (SQL Server STATISTICS XML) — captured, not shown.</summary>
    public Func<ColumnInfo[], bool> IsPlanResultSet { get; init; } = _ => false;

    /// <summary>Statements always run on the session after the script (even after errors/cancel), e.g. SET SHOWPLAN_XML OFF.</summary>
    public IReadOnlyList<string> CleanupSql { get; init; } = [];
}

/// <summary>A captured plan result set (values are wire values; long text keeps its full value via ToString).</summary>
public sealed record CapturedResultSet(ColumnInfo[] Columns, List<object?[]> Rows)
{
    public static string? Text(object? v) => v switch
    {
        null => null,
        TruncatedValue t => t.Full,
        string s => s,
        _ => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture),
    };

    public static double? Number(object? v) => v switch
    {
        null => null,
        double d => d,
        long l => l,
        int i => i,
        string s when double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var p) => p,
        _ => null,
    };
}

/// <summary>
/// Explain plan support of one provider (docs/PLAN-M1.5.md A5), registered as a keyed singleton by provider id.
/// The engine runs <see cref="CreateScript"/>'s batches through the normal execution path (so actual-mode result sets
/// stream as usual), captures the plan result sets, runs the cleanup statements and calls <see cref="BuildAsync"/>.
/// </summary>
public interface IPlanReader
{
    string ProviderId { get; }

    ExplainScript CreateScript(ExplainInput input);

    /// <summary>
    /// Builds the normalized tree from the captured result sets; may run follow-up queries on the session through
    /// <see cref="AdoSessionBase.RunExclusiveAsync{T}"/> (Oracle PLAN_TABLE).
    /// </summary>
    Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct);
}

/// <summary>Tree helpers shared by the plan readers.</summary>
public static class PlanTree
{
    /// <summary>
    /// Sets <see cref="PlanNode.CostPct"/> = (own cost / root subtree cost) × 100 where own cost = subtree cost minus the
    /// children's subtree costs (never negative). Leaves CostPct null when the root has no cost.
    /// </summary>
    public static void ComputeCostPercentages(PlanNode root)
    {
        var total = root.Cost;
        if (total is null or <= 0)
        {
            foreach (var n in root.DescendantsAndSelf()) n.CostPct = null;
            return;
        }
        foreach (var n in root.DescendantsAndSelf())
        {
            if (n.Cost is null) { n.CostPct = null; continue; }
            var own = n.Cost.Value - n.Children.Sum(c => c.Cost ?? 0);
            n.CostPct = Math.Round(Math.Max(0, own) / total.Value * 100, 1);
        }
    }

    /// <summary>Renders the tree as indented text (the raw view for SQLite, a fallback elsewhere).</summary>
    public static string ToText(PlanNode root)
    {
        var sb = new System.Text.StringBuilder();
        void Walk(PlanNode n, int depth)
        {
            sb.Append(new string(' ', depth * 2)).Append(depth == 0 ? "" : "└─ ").Append(n.Op);
            if (!string.IsNullOrEmpty(n.Object)) sb.Append(" [").Append(n.Object).Append(']');
            sb.Append('\n');
            foreach (var c in n.Children) Walk(c, depth + 1);
        }
        Walk(root, 0);
        return sb.ToString();
    }
}
