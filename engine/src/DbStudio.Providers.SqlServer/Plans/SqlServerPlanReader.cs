using System.Globalization;
using System.Xml.Linq;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;

namespace DbStudio.Providers.SqlServer.Plans;

/// <summary>
/// SQL Server plans (docs/PLAN-M1.5.md A5): estimated = <c>SET SHOWPLAN_XML ON</c> (nothing runs), actual =
/// <c>SET STATISTICS XML ON</c> (the statement runs, its result sets stream normally and the trailing showplan result
/// sets are captured). ShowPlanXML <c>RelOp</c> elements become <see cref="PlanNode"/>s (physical/logical operator,
/// object, estimated/actual rows, subtree cost, predicates, warnings, missing-index hints).
/// </summary>
public sealed class SqlServerPlanReader : IPlanReader
{
    public const string ShowplanColumn = "Microsoft SQL Server 2005 XML Showplan";
    private static readonly XNamespace Ns = "http://schemas.microsoft.com/sqlserver/2004/07/showplan";

    public string ProviderId => "sqlserver";

    public ExplainScript CreateScript(ExplainInput input)
    {
        var sql = input.Sql.Trim();
        if (input.IsActual)
        {
            return new ExplainScript
            {
                Batches = [new ExplainBatch("SET STATISTICS XML ON", false, false), new ExplainBatch(sql, true, false, input.Line, input.Col)],
                Params = input.Params,
                IsPlanResultSet = IsShowplan,
                CleanupSql = ["SET STATISTICS XML OFF"],
            };
        }
        // Estimated: a parameterized statement goes to the server as an RPC (sp_executesql), and under SHOWPLAN_XML the
        // server answers an RPC with no plan at all. The parameters become local variables of the batch instead, declared
        // on the statement's first line (line numbers of server errors stay the editor's). Nothing executes either way.
        var declare = input.Params is { Count: > 0 } ps ? DeclareParams(ps) : null;
        return new ExplainScript
        {
            Batches = [new ExplainBatch("SET SHOWPLAN_XML ON", false, false), new ExplainBatch(declare is null ? sql : declare + sql, false, true, input.Line, input.Col)],
            Params = declare is null ? input.Params : null,
            IsPlanResultSet = IsShowplan,
            CleanupSql = ["SET SHOWPLAN_XML OFF"],
        };
    }

    /// <summary>
    /// <c>DECLARE @a int, @b nvarchar(4000); </c> for the named input parameters (the types SqlServerParamBinder binds),
    /// or null when a parameter cannot be declared (positional, output, REF CURSOR): the request then keeps its binds.
    /// </summary>
    public static string? DeclareParams(IReadOnlyList<QueryParam> ps)
    {
        var parts = new List<string>();
        foreach (var p in ps)
        {
            if (p.IsPositional || p.IsOutput || p.Kind == ParamKinds.RefCursor || !IsIdentifier(p.BareName)) return null;
            var type = p.Kind switch
            {
                ParamKinds.Int => ParamValues.ToClr(p) is long l && l is >= int.MinValue and <= int.MaxValue ? "int" : "bigint",
                ParamKinds.Decimal => $"decimal(38, {(ParamValues.ToClr(p) is decimal m ? Math.Min((int)m.Scale, 38) : 0)})",
                ParamKinds.Float => "float",
                ParamKinds.Bool => "bit",
                ParamKinds.Date => "date",
                ParamKinds.DateTime => "datetime2(7)",
                ParamKinds.DateTimeOffset => "datetimeoffset(7)",
                ParamKinds.Time => "time(7)",
                ParamKinds.Guid => "uniqueidentifier",
                ParamKinds.Binary => ParamValues.ToClr(p) is byte[] { Length: > 8000 } ? "varbinary(max)" : "varbinary(8000)",
                _ => ParamValues.ToClr(p) is string { Length: > 4000 } ? "nvarchar(max)" : "nvarchar(4000)",
            };
            parts.Add($"@{p.BareName} {type}");
        }
        return parts.Count == 0 ? null : $"DECLARE {string.Join(", ", parts)}; ";
    }

    private static bool IsIdentifier(string name) =>
        name.Length > 0 && (char.IsLetter(name[0]) || name[0] == '_') && name.All(c => char.IsLetterOrDigit(c) || c is '_' or '@' or '#' or '$');

    public static bool IsShowplan(ColumnInfo[] columns) =>
        columns.Length == 1 && columns[0].Name.Equals(ShowplanColumn, StringComparison.OrdinalIgnoreCase);

    public Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        var xmls = captured.Where(c => IsShowplan(c.Columns)).SelectMany(c => c.Rows).Select(r => CapturedResultSet.Text(r[0]))
            .Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!).ToList();
        if (xmls.Count == 0)
            throw new EngineException(422, ErrorCodes.ProviderError, "The server returned no execution plan for this statement.");
        return Task.FromResult(Parse(xmls, input.IsActual));
    }

    /// <summary>Parses one or more ShowPlanXML documents into one tree (one statement node per statement).</summary>
    public static PlanResult Parse(IReadOnlyList<string> xmls, bool actual)
    {
        var statements = new List<PlanNode>();
        var warnings = new List<string>();
        var nextId = 1;
        foreach (var xml in xmls)
        {
            var doc = XDocument.Parse(xml);
            foreach (var stmt in doc.Descendants(Ns + "StmtSimple").Concat(doc.Descendants(Ns + "StmtCond")).Concat(doc.Descendants(Ns + "StmtCursor")))
            {
                var node = new PlanNode
                {
                    Id = nextId++,
                    Op = (string?)stmt.Attribute("StatementType") ?? "STATEMENT",
                    LogicalOp = null,
                    Cost = Dbl(stmt.Attribute("StatementSubTreeCost")),
                    EstRows = Dbl(stmt.Attribute("StatementEstRows")),
                };
                node.SetProp("Statement", Shorten((string?)stmt.Attribute("StatementText")));
                node.SetProp("Optimization level", (string?)stmt.Attribute("StatementOptmLevel"));
                node.SetProp("Early abort", (string?)stmt.Attribute("StatementOptmEarlyAbortReason"));
                var plan = stmt.Element(Ns + "QueryPlan");
                if (plan is not null)
                {
                    node.SetProp("Degree of parallelism", (string?)plan.Attribute("DegreeOfParallelism"));
                    node.SetProp("Memory grant (KB)", (string?)plan.Element(Ns + "MemoryGrantInfo")?.Attribute("GrantedMemory"));
                    foreach (var w in PlanWarnings(plan.Element(Ns + "Warnings"))) node.Warnings.Add(w);
                    foreach (var hint in MissingIndexes(plan)) { node.Warnings.Add(hint); warnings.Add(hint); }
                    var top = plan.Element(Ns + "RelOp");
                    if (top is not null) node.Children.Add(ToNode(top, actual, ref nextId));
                }
                if (node.EstRows is null && node.Children.Count > 0) node.EstRows = node.Children[0].EstRows;
                if (actual && node.Children.Count > 0) node.ActualRows = node.Children[0].ActualRows;
                statements.Add(node);
            }
        }
        // Statements without a plan (SET, DECLARE) add noise: keep them only when nothing else exists.
        var withPlans = statements.Where(s => s.Children.Count > 0).ToList();
        if (withPlans.Count > 0) statements = withPlans;
        PlanNode root;
        if (statements.Count == 1)
        {
            root = statements[0];
        }
        else
        {
            root = new PlanNode
            {
                Id = 0,
                Op = "BATCH",
                Cost = statements.Sum(s => s.Cost ?? 0),
                Children = statements,
            };
        }
        foreach (var n in root.DescendantsAndSelf()) n.Warnings = n.Warnings.Distinct().ToList();
        PlanTree.ComputeCostPercentages(root);
        return new PlanResult(root, string.Join("\n", xmls), "xml", warnings.Distinct().ToList());
    }

    private static PlanNode ToNode(XElement relOp, bool actual, ref int nextId)
    {
        var node = new PlanNode
        {
            Id = nextId++,
            Op = (string?)relOp.Attribute("PhysicalOp") ?? "?",
            LogicalOp = (string?)relOp.Attribute("LogicalOp"),
            EstRows = Dbl(relOp.Attribute("EstimateRows")),
            Cost = Dbl(relOp.Attribute("EstimatedTotalSubtreeCost")),
        };
        node.SetProp("Node id", (string?)relOp.Attribute("NodeId"));
        node.SetProp("Estimated I/O cost", (string?)relOp.Attribute("EstimateIO"));
        node.SetProp("Estimated CPU cost", (string?)relOp.Attribute("EstimateCPU"));
        node.SetProp("Average row size (B)", (string?)relOp.Attribute("AvgRowSize"));
        node.SetProp("Estimated executions", (string?)relOp.Attribute("EstimateRebinds") is { } rb && (string?)relOp.Attribute("EstimateRewinds") is { } rw
            ? (1 + (Dbl(rb) ?? 0) + (Dbl(rw) ?? 0)).ToString(CultureInfo.InvariantCulture) : null);
        if (((string?)relOp.Attribute("Parallel")) is "1" or "true") node.SetProp("Parallel", "true");

        // The operator-specific element is the first child that is not a generic RelOp property.
        var op = relOp.Elements().FirstOrDefault(e => e.Name.LocalName is not ("OutputList" or "Warnings" or "MemoryFractions" or "RunTimeInformation"
            or "RunTimePartitionSummary" or "InternalInfo" or "DefinedValues"));
        if (op is not null)
        {
            var obj = op.Elements(Ns + "Object").FirstOrDefault() ?? op.Descendants(Ns + "Object").FirstOrDefault(o => o.Parent?.Name.LocalName is not "RelOp");
            if (obj is not null && !op.Elements(Ns + "RelOp").Any(r => r.Descendants().Contains(obj)))
                node.Object = ObjectName(obj);
            var seek = op.Element(Ns + "SeekPredicates");
            var pred = op.Element(Ns + "Predicate");
            var parts = new List<string>();
            var seekText = seek is null ? null : SeekText(seek);
            if (!string.IsNullOrEmpty(seekText)) { parts.Add(seekText); node.SetProp("Seek predicate", seekText); }
            if (pred?.Descendants(Ns + "ScalarOperator").FirstOrDefault()?.Attribute("ScalarString") is { } ps) parts.Add((string)ps);
            var joinPred = op.Elements().FirstOrDefault(e => e.Name.LocalName is "ProbeResidual" or "Residual" or "PassThru" or "Predicate" && e != pred)
                ?.Descendants(Ns + "ScalarOperator").FirstOrDefault()?.Attribute("ScalarString");
            if (joinPred is not null) parts.Add((string)joinPred);
            if (parts.Count > 0) node.Predicate = string.Join(" AND ", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
        }

        foreach (var w in PlanWarnings(relOp.Element(Ns + "Warnings"))) node.Warnings.Add(w);
        if (actual && relOp.Element(Ns + "RunTimeInformation") is { } rti)
        {
            var threads = rti.Elements(Ns + "RunTimeCountersPerThread").ToList();
            node.ActualRows = threads.Sum(t => Dbl(t.Attribute("ActualRows")) ?? 0);
            var execs = threads.Sum(t => Dbl(t.Attribute("ActualExecutions")) ?? 0);
            node.SetProp("Actual executions", execs.ToString(CultureInfo.InvariantCulture));
            var elapsed = threads.Select(t => Dbl(t.Attribute("ActualElapsedms"))).Where(x => x is not null).DefaultIfEmpty(null).Max();
            if (elapsed is not null) node.SetProp("Actual elapsed (ms)", elapsed.Value.ToString(CultureInfo.InvariantCulture));
            var logicalReads = threads.Sum(t => Dbl(t.Attribute("ActualLogicalReads")) ?? 0);
            if (logicalReads > 0) node.SetProp("Logical reads", logicalReads.ToString(CultureInfo.InvariantCulture));
            if (node.EstRows is { } est && est > 0 && node.ActualRows is { } act && execs > 0 && (act / execs > est * 10 || act / execs * 10 < est) && Math.Abs(act / execs - est) > 100)
                node.Warnings.Add($"Row estimate off: estimated {est:0.#}, actual {act / execs:0.#} per execution");
        }

        // Children: the nearest RelOp descendants.
        foreach (var child in ChildRelOps(relOp)) node.Children.Add(ToNode(child, actual, ref nextId));
        return node;
    }

    private static IEnumerable<XElement> ChildRelOps(XElement relOp)
    {
        foreach (var e in relOp.Elements())
        {
            if (e.Name == Ns + "RelOp") { yield return e; continue; }
            foreach (var r in NearestRelOps(e)) yield return r;
        }
    }

    private static IEnumerable<XElement> NearestRelOps(XElement e)
    {
        foreach (var c in e.Elements())
        {
            if (c.Name == Ns + "RelOp") yield return c;
            else foreach (var r in NearestRelOps(c)) yield return r;
        }
    }

    /// <summary>"[Id] = [@id]" from SeekKeys (Prefix / StartRange / EndRange with RangeColumns and RangeExpressions).</summary>
    private static string SeekText(XElement seekPredicates)
    {
        var terms = new List<string>();
        foreach (var range in seekPredicates.Descendants().Where(e => e.Name.LocalName is "Prefix" or "StartRange" or "EndRange"))
        {
            var op = ((string?)range.Attribute("ScanType")) switch
            {
                "EQ" => "=", "GT" => ">", "GE" => ">=", "LT" => "<", "LE" => "<=", "IS" => "IS", "ISNOT" => "IS NOT", var other => other ?? "=",
            };
            var cols = range.Element(Ns + "RangeColumns")?.Elements(Ns + "ColumnReference").Select(c => "[" + (string?)c.Attribute("Column") + "]").ToList() ?? [];
            var exprs = range.Element(Ns + "RangeExpressions")?.Elements(Ns + "ScalarOperator").Select(x => (string?)x.Attribute("ScalarString") ?? "?").ToList() ?? [];
            for (var i = 0; i < cols.Count; i++) terms.Add($"{cols[i]} {op} {(i < exprs.Count ? exprs[i] : "?")}");
        }
        return string.Join(" AND ", terms);
    }

    private static string? ObjectName(XElement obj)
    {
        string? Part(string attr) => ((string?)obj.Attribute(attr))?.Trim('[', ']');
        var parts = new[] { Part("Schema"), Part("Table"), Part("Index") }.Where(p => !string.IsNullOrEmpty(p)).ToList();
        if (parts.Count == 0) return null;
        var name = string.Join(".", parts);
        var alias = Part("Alias");
        return alias is not null && !alias.Equals(Part("Table"), StringComparison.OrdinalIgnoreCase) ? $"{name} ({alias})" : name;
    }

    private static IEnumerable<string> PlanWarnings(XElement? warnings)
    {
        if (warnings is null) yield break;
        foreach (var a in warnings.Attributes())
            if (a.Value is "1" or "true") yield return Humanize(a.Name.LocalName);
        foreach (var e in warnings.Elements())
        {
            var name = e.Name.LocalName;
            yield return name switch
            {
                "PlanAffectingConvert" => $"Type conversion may affect the plan: {(string?)e.Attribute("Expression")}",
                "SpillToTempDb" => "Operator spilled to tempdb",
                "ColumnsWithNoStatistics" => "Columns without statistics: " + string.Join(", ", e.Descendants(Ns + "ColumnReference").Select(c => (string?)c.Attribute("Column"))),
                "MemoryGrantWarning" => $"Memory grant: {(string?)e.Attribute("GrantWarningKind")}",
                "WaitStats" => "Waits",
                _ => Humanize(name),
            };
        }
    }

    private static IEnumerable<string> MissingIndexes(XElement queryPlan)
    {
        foreach (var group in queryPlan.Descendants(Ns + "MissingIndexGroup"))
        {
            var impact = Dbl(group.Attribute("Impact"));
            foreach (var mi in group.Elements(Ns + "MissingIndex"))
            {
                var table = $"{((string?)mi.Attribute("Schema"))?.Trim('[', ']')}.{((string?)mi.Attribute("Table"))?.Trim('[', ']')}";
                string Cols(params string[] usages) => string.Join(", ", mi.Elements(Ns + "ColumnGroup")
                    .Where(g => usages.Contains((string?)g.Attribute("Usage")))
                    .SelectMany(g => g.Elements(Ns + "Column")).Select(c => ((string?)c.Attribute("Name"))?.Trim('[', ']')));
                var keys = Cols("EQUALITY", "INEQUALITY");
                var include = Cols("INCLUDE");
                yield return $"Missing index (impact {impact?.ToString("0.#", CultureInfo.InvariantCulture) ?? "?"}%): {table} ({keys})" + (include.Length > 0 ? $" INCLUDE ({include})" : "");
            }
        }
    }

    private static string Humanize(string name)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var ch in name)
        {
            if (char.IsUpper(ch) && sb.Length > 0) sb.Append(' ');
            sb.Append(sb.Length == 0 ? ch : char.ToLowerInvariant(ch));
        }
        return sb.ToString();
    }

    private static string? Shorten(string? text) => text is null ? null : text.Length <= 400 ? text.Trim() : text[..400].Trim() + "…";

    private static double? Dbl(XAttribute? a) => a is null ? null : Dbl(a.Value);
    private static double? Dbl(string? s) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
}
