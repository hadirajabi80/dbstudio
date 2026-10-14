using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Core.Plans;

/// <param name="ResultSets">Visible result sets (actual mode).</param>
/// <param name="CleanupErrors">Failures of the reader's cleanup statements (the session may need attention).</param>
public sealed record ExplainOutcome(ExecutionStatus Status, PlanResult? Plan, int ResultSets, long RowsAffected, IReadOnlyList<string> CleanupErrors);

/// <summary>
/// Runs one explain request on a session (docs/PLAN-M1.5.md A5): the reader's batches through the normal execution
/// path with plan result sets captured, the cleanup statements (always), then <see cref="IPlanReader.BuildAsync"/>.
/// The caller owns the session reservation and the batch-0 start/end events of <paramref name="sink"/>.
/// </summary>
public static class ExplainRunner
{
    public static async Task<ExplainOutcome> RunAsync(AdoSessionBase session, IPlanReader reader, ExplainInput input, IExecutionSink sink,
        int maxRows, bool captureServerOutput, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(reader);
        var script = reader.CreateScript(input);
        var explainSink = new ExplainSink(sink, script);
        var status = ExecutionStatus.Ok;
        var cleanupErrors = new List<string>();
        try
        {
            if (script.Batches.Count > 0)
            {
                var batches = script.Batches.Select(b => new SqlBatch(b.Sql, b.Line, b.Col)).ToList();
                var request = new ExecuteRequest(batches, maxRows, true, captureServerOutput, "explain", script.Params);
                status = (await session.ExecuteAsync(request, explainSink, ct).ConfigureAwait(false)).Status;
            }
        }
        finally
        {
            if (script.CleanupSql.Count > 0)
            {
                try
                {
                    await session.RunExclusiveAsync(async (scope, token) =>
                    {
                        foreach (var sql in script.CleanupSql)
                        {
                            await using var c = scope.CreateCommand(sql);
                            await c.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                        }
                        return true;
                    }, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    cleanupErrors.Add(ex.Message);
                }
            }
        }

        PlanResult? plan = null;
        if (status == ExecutionStatus.Ok && !explainSink.AnyError)
            plan = await reader.BuildAsync(input, explainSink.Captured, session, ct).ConfigureAwait(false);
        else if (status == ExecutionStatus.Ok)
            status = ExecutionStatus.Error;
        return new ExplainOutcome(status, plan, explainSink.VisibleResultSets, explainSink.VisibleRowsAffected, cleanupErrors);
    }
}

/// <summary>
/// Sink of an explain run: the visible batch maps to batch 0, hidden batches only surface errors and messages,
/// plan result sets are captured instead of published, and visible result sets are renumbered from 0.
/// </summary>
internal sealed class ExplainSink(IExecutionSink inner, ExplainScript script) : IExecutionSink, IExecutionDiagnosticsSink
{
    private readonly Dictionary<int, CapturedResultSet> _capturing = [];
    private readonly Dictionary<int, int> _visibleIds = [];
    private readonly List<CapturedResultSet> _captured = [];
    private int _nextVisibleId;
    private long _rowsAffected;

    public IReadOnlyList<CapturedResultSet> Captured => _captured;
    public bool AnyError { get; private set; }
    public int VisibleResultSets => _nextVisibleId;
    public long VisibleRowsAffected => Interlocked.Read(ref _rowsAffected);

    private ExplainBatch Batch(int index) => index >= 0 && index < script.Batches.Count ? script.Batches[index] : script.Batches[^1];

    public ValueTask BatchStarted(int batchIndex) => ValueTask.CompletedTask;
    public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => ValueTask.CompletedTask;

    public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns)
    {
        var b = Batch(batchIndex);
        if (b.CaptureAll || script.IsPlanResultSet(columns))
        {
            var set = new CapturedResultSet(columns, []);
            _capturing[resultSetId] = set;
            _captured.Add(set);
            return ValueTask.CompletedTask;
        }
        if (!b.Visible) return ValueTask.CompletedTask; // hidden, non-plan output: drop
        var id = _nextVisibleId++;
        _visibleIds[resultSetId] = id;
        return inner.ResultSetStarted(id, 0, columns);
    }

    public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows)
    {
        if (_capturing.TryGetValue(resultSetId, out var set)) { set.Rows.AddRange(rows); return ValueTask.CompletedTask; }
        return _visibleIds.TryGetValue(resultSetId, out var id) ? inner.Rows(id, rows) : ValueTask.CompletedTask;
    }

    public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs)
    {
        if (_capturing.Remove(resultSetId)) return ValueTask.CompletedTask;
        return _visibleIds.TryGetValue(resultSetId, out var id) ? inner.ResultSetEnded(id, rowCount, truncated, elapsedMs) : ValueTask.CompletedTask;
    }

    public ValueTask RowsAffected(int batchIndex, long count, string? statementKind)
    {
        if (!Batch(batchIndex).Visible) return ValueTask.CompletedTask;
        if (count > 0) Interlocked.Add(ref _rowsAffected, count);
        return inner.RowsAffected(0, count, statementKind);
    }

    public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) =>
        Batch(batchIndex).Visible || severity != MessageSeverity.Info ? inner.Message(0, severity, text, line, code, source) : ValueTask.CompletedTask;

    public ValueTask Error(int batchIndex, ErrorInfo error)
    {
        AnyError = true;
        return inner.Error(0, error);
    }

    public ValueTask Diagnostics(int batchIndex, IReadOnlyList<SqlDiagnostic> diagnostics) =>
        inner is IExecutionDiagnosticsSink ds ? ds.Diagnostics(0, diagnostics) : ValueTask.CompletedTask;
}
