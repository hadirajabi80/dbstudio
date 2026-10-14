using System.Data.Common;
using System.Globalization;
using System.Text;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle.Plans;

/// <summary>
/// Oracle plans (docs/PLAN-M1.5.md A5). Estimated: <c>EXPLAIN PLAN SET STATEMENT_ID = … FOR</c> the statement, then a
/// structured read of PLAN_TABLE (and <c>DBMS_XPLAN.DISPLAY</c> as raw text); the rows are deleted afterwards.
/// Actual: the statement runs with <c>STATISTICS_LEVEL = ALL</c> and a tag comment; its cursor is found in V$SQL and
/// the tree comes from V$SQL_PLAN_STATISTICS_ALL with <c>DBMS_XPLAN.DISPLAY_CURSOR(…, 'ALLSTATS LAST')</c> as raw text.
/// Without access to the V$ views the estimated plan is returned with a warning.
/// </summary>
public sealed class OraclePlanReader : IPlanReader
{
    public string ProviderId => "oracle";

    public const string PlanTableQuery =
        "SELECT id, parent_id, operation, options, object_owner, object_name, cost, cardinality, bytes, access_predicates, filter_predicates, " +
        "cpu_cost, io_cost, time, optimizer FROM plan_table WHERE statement_id = :sid ORDER BY id";

    public const string XplanDisplay = "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :sid, 'TYPICAL'))";

    public const string FindCursor =
        "SELECT sql_id, child_number FROM (SELECT sql_id, child_number FROM v$sql WHERE sql_text LIKE :tag AND sql_text NOT LIKE '%v$sql%' " +
        "ORDER BY last_active_time DESC) WHERE ROWNUM = 1";

    public const string CursorPlanQuery =
        "SELECT id, parent_id, operation, options, object_owner, object_name, cost, cardinality, bytes, access_predicates, filter_predicates, " +
        "last_output_rows, last_starts, last_elapsed_time, last_cr_buffer_gets FROM v$sql_plan_statistics_all WHERE sql_id = :sqlid AND child_number = :child ORDER BY id";

    public const string XplanCursor = "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sqlid, :child, 'ALLSTATS LAST'))";

    /// <summary>STATEMENT_ID (VARCHAR2(30)) / tag of an execution.</summary>
    public static string StatementId(string executionId) => executionId.Length <= 30 ? executionId : executionId[^30..];

    public static string Tag(string executionId) => "dbstudio:" + executionId;

    public ExplainScript CreateScript(ExplainInput input)
    {
        var (sql, _) = OracleSqlText.Prepare(input.Sql);
        if (input.IsActual)
        {
            return new ExplainScript
            {
                Batches =
                [
                    new ExplainBatch("ALTER SESSION SET STATISTICS_LEVEL = ALL", false, false),
                    new ExplainBatch(sql + "\n/* " + Tag(input.ExecutionId) + " */", true, false, input.Line, input.Col),
                ],
                Params = input.Params,
                CleanupSql = ["ALTER SESSION SET STATISTICS_LEVEL = TYPICAL"],
            };
        }
        return new ExplainScript
        {
            Batches = [new ExplainBatch($"EXPLAIN PLAN SET STATEMENT_ID = '{StatementId(input.ExecutionId)}' FOR\n{sql}", false, false, Math.Max(0, input.Line - 1), 1)],
            Params = WithNullBinds(sql, input.Params),
        };
    }

    /// <summary>EXPLAIN PLAN does not execute: unbound binds get NULL values so the statement can be parsed.</summary>
    public static IReadOnlyList<QueryParam> WithNullBinds(string sql, IReadOnlyList<QueryParam>? parameters)
    {
        var list = new List<QueryParam>(parameters ?? []);
        var known = new HashSet<string>(list.Select(p => p.BareName), StringComparer.OrdinalIgnoreCase);
        foreach (var ph in Params.OracleParamBinder.Instance.FindPlaceholders(sql))
            if (ph.Name is not null && known.Add(ph.Name)) list.Add(new QueryParam(ph.Name, ParamKinds.String));
        return list;
    }

    public async Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct)
    {
        if (!input.IsActual)
            return await session.RunExclusiveAsync((scope, token) => ReadPlanTableAsync(scope, StatementId(input.ExecutionId), [], token), ct).ConfigureAwait(false);

        return await session.RunExclusiveAsync(async (scope, token) =>
        {
            try
            {
                var cursor = await QueryAsync(scope, FindCursor, r => (SqlId: r.GetString(0), Child: Convert.ToInt32(r.GetValue(1), CultureInfo.InvariantCulture)), token,
                    ("tag", "%" + Tag(input.ExecutionId) + "%")).ConfigureAwait(false);
                if (cursor.Count == 0) throw new InvalidOperationException("The statement's cursor was not found in V$SQL.");
                var (sqlId, child) = cursor[0];
                var rows = await QueryAsync(scope, CursorPlanQuery, ReadRow(actual: true), token, ("sqlid", sqlId), ("child", child)).ConfigureAwait(false);
                var text = await QueryAsync(scope, XplanCursor, r => r.IsDBNull(0) ? "" : r.GetString(0), token, ("sqlid", sqlId), ("child", child)).ConfigureAwait(false);
                return new PlanResult(BuildTree(rows), string.Join("\n", text), "text", []);
            }
            catch (Exception ex) when (ex is OracleException or InvalidOperationException)
            {
                // No V$ access (ORA-00942) or the cursor aged out: fall back to the estimated plan.
                var sid = StatementId(input.ExecutionId);
                var (sql, _) = OracleSqlText.Prepare(input.Sql);
                await using (var cmd = (OracleCommand)scope.CreateCommand($"EXPLAIN PLAN SET STATEMENT_ID = '{sid}' FOR\n{sql}"))
                {
                    cmd.BindByName = true;
                    if (scope.Binder is { } binder) binder.Bind(cmd, WithNullBinds(sql, input.Params), new ParamBindCursor());
                    await cmd.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                }
                var warning = ex is OracleException { Number: 942 }
                    ? "Runtime statistics need SELECT access to V$SQL and V$SQL_PLAN_STATISTICS_ALL; showing the estimated plan."
                    : $"Runtime statistics are not available ({ex.Message}); showing the estimated plan.";
                return await ReadPlanTableAsync(scope, sid, [warning], token).ConfigureAwait(false);
            }
        }, ct).ConfigureAwait(false);
    }

    private static async Task<PlanResult> ReadPlanTableAsync(AdoSessionBase.SessionScope scope, string statementId, List<string> warnings, CancellationToken ct)
    {
        var rows = await QueryAsync(scope, PlanTableQuery, ReadRow(actual: false), ct, ("sid", statementId)).ConfigureAwait(false);
        List<string> text;
        try
        {
            text = await QueryAsync(scope, XplanDisplay, r => r.IsDBNull(0) ? "" : r.GetString(0), ct, ("sid", statementId)).ConfigureAwait(false);
        }
        catch (OracleException ex)
        {
            text = [$"(DBMS_XPLAN.DISPLAY failed: {OracleErrors.CleanMessage(ex.Message).Message})"];
        }
        try
        {
            await using var del = (OracleCommand)scope.CreateCommand("DELETE FROM plan_table WHERE statement_id = :sid");
            del.BindByName = true;
            del.Parameters.Add(new OracleParameter("sid", statementId));
            await del.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        catch (OracleException)
        {
            // PLAN_TABLE is a global temporary table in recent versions; leftovers vanish with the session.
        }
        if (rows.Count == 0) throw new EngineException(422, ErrorCodes.ProviderError, "PLAN_TABLE has no rows for this statement.");
        return new PlanResult(BuildTree(rows), string.Join("\n", text), "text", warnings);
    }

    /// <summary>One PLAN_TABLE / V$SQL_PLAN_STATISTICS_ALL row.</summary>
    public sealed record PlanRow(int Id, int? ParentId, string Operation, string? Options, string? Owner, string? Object, double? Cost, double? Cardinality,
        double? Bytes, string? Access, string? Filter, double? ActualRows = null, double? Starts = null, double? ElapsedMicros = null, double? BufferGets = null);

    private static Func<DbDataReader, PlanRow> ReadRow(bool actual) => r => new PlanRow(
        Convert.ToInt32(r.GetValue(0), CultureInfo.InvariantCulture),
        r.IsDBNull(1) ? null : Convert.ToInt32(r.GetValue(1), CultureInfo.InvariantCulture),
        r.IsDBNull(2) ? "" : r.GetString(2), Str(r, 3), Str(r, 4), Str(r, 5), Num(r, 6), Num(r, 7), Num(r, 8), Str(r, 9), Str(r, 10),
        actual ? Num(r, 11) : null, actual ? Num(r, 12) : null, actual ? Num(r, 13) : null, actual ? Num(r, 14) : null);

    /// <summary>Rows (id, parent_id) → tree rooted at id 0 (or the first row).</summary>
    public static PlanNode BuildTree(IReadOnlyList<PlanRow> rows)
    {
        var nodes = new Dictionary<int, PlanNode>();
        PlanNode? root = null;
        foreach (var row in rows.OrderBy(r => r.Id))
        {
            var node = new PlanNode
            {
                Id = row.Id,
                Op = string.IsNullOrWhiteSpace(row.Options) ? row.Operation : $"{row.Operation} {row.Options}",
                LogicalOp = row.Operation,
                Object = row.Object is null ? null : string.IsNullOrEmpty(row.Owner) ? row.Object : $"{row.Owner}.{row.Object}",
                Cost = row.Cost,
                EstRows = row.Cardinality,
                ActualRows = row.ActualRows,
                Predicate = Join(row.Access, row.Filter),
            };
            node.SetProp("Bytes", row.Bytes?.ToString(CultureInfo.InvariantCulture));
            node.SetProp("Access predicates", row.Access);
            node.SetProp("Filter predicates", row.Filter);
            node.SetProp("Starts", row.Starts?.ToString(CultureInfo.InvariantCulture));
            if (row.ElapsedMicros is { } us) node.SetProp("Actual elapsed (ms)", (us / 1000).ToString("0.###", CultureInfo.InvariantCulture));
            node.SetProp("Buffer gets", row.BufferGets?.ToString(CultureInfo.InvariantCulture));
            if (row.Operation == "TABLE ACCESS" && row.Options == "FULL") node.Warnings.Add($"Full table scan of {node.Object}");
            if (row.Operation == "MERGE JOIN" && row.Options == "CARTESIAN") node.Warnings.Add("Cartesian join");
            if (row.ActualRows is { } act && row.Cardinality is { } est && row.Starts is > 0 && est > 0
                && (act / row.Starts.Value > est * 10 || act / row.Starts.Value * 10 < est) && Math.Abs(act / row.Starts.Value - est) > 100)
                node.Warnings.Add($"Row estimate off: estimated {est:0.#}, actual {act / row.Starts.Value:0.#} per start");
            nodes[row.Id] = node;
            if (row.ParentId is { } p && nodes.TryGetValue(p, out var parent)) parent.Children.Add(node);
            else root ??= node;
        }
        root ??= new PlanNode { Id = 0, Op = "SELECT STATEMENT" };
        // The statement row has no cost on some versions: use its child's.
        if (root.Cost is null && root.Children.Count > 0) root.Cost = root.Children.Sum(c => c.Cost ?? 0);
        PlanTree.ComputeCostPercentages(root);
        return root;
    }

    private static string? Join(string? access, string? filter) =>
        access is null ? filter : filter is null ? access : $"{access} AND {filter}";

    private static async Task<List<T>> QueryAsync<T>(AdoSessionBase.SessionScope scope, string sql, Func<DbDataReader, T> map, CancellationToken ct,
        params (string Name, object Value)[] parameters)
    {
        await using var cmd = (OracleCommand)scope.CreateCommand(sql);
        cmd.BindByName = true;
        cmd.InitialLONGFetchSize = -1;
        foreach (var (name, value) in parameters) cmd.Parameters.Add(new OracleParameter(name, value));
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    private static string? Str(DbDataReader r, int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture);

    private static double? Num(DbDataReader r, int i) =>
        r.IsDBNull(i) ? null : double.TryParse(Convert.ToString(r.GetValue(i), CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
}
