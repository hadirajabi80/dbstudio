using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Conformance;

/// <summary>Thread-safe <see cref="IExecutionSink"/> that records every event for assertions.</summary>
public sealed class RecordingSink : IExecutionSink, IExecutionDiagnosticsSink
{
    private readonly object _gate = new();
    private readonly List<object> _events = [];
    private readonly Dictionary<int, RecordedResultSet> _resultSets = new();

    public sealed class RecordedResultSet(int id, int batchIndex, ColumnInfo[] columns)
    {
        public int Id { get; } = id;
        public int BatchIndex { get; } = batchIndex;
        public ColumnInfo[] Columns { get; } = columns;
        public List<object?[]> Rows { get; } = [];
        public int RowFrames { get; set; }
        public long? RowCount { get; set; }
        public bool Truncated { get; set; }
        public bool Ended => RowCount is not null;
    }

    public sealed record AffectedEvent(int BatchIndex, long Count, string? StatementKind);
    public sealed record MessageEvent(int BatchIndex, MessageSeverity Severity, string Text, int? Line, int? Code, MessageSource Source);
    public sealed record ErrorEvent(int BatchIndex, ErrorInfo Error);
    public sealed record BatchStartedEvent(int BatchIndex);
    public sealed record BatchEndedEvent(int BatchIndex, long ElapsedMs, BatchStatus Status);
    public sealed record DiagnosticsEvent(int BatchIndex, IReadOnlyList<SqlDiagnostic> Diagnostics);

    /// <summary>All events in arrival order (records above plus <see cref="RecordedResultSet"/> on ResultSetStarted).</summary>
    public IReadOnlyList<object> Events { get { lock (_gate) return _events.ToList(); } }

    public IReadOnlyList<RecordedResultSet> ResultSets { get { lock (_gate) return _resultSets.Values.OrderBy(r => r.Id).ToList(); } }
    public IReadOnlyList<AffectedEvent> Affected => Of<AffectedEvent>();
    public IReadOnlyList<MessageEvent> Messages => Of<MessageEvent>();
    public IReadOnlyList<ErrorEvent> Errors => Of<ErrorEvent>();
    public IReadOnlyList<BatchStartedEvent> BatchesStarted => Of<BatchStartedEvent>();
    public IReadOnlyList<BatchEndedEvent> BatchesEnded => Of<BatchEndedEvent>();
    public IReadOnlyList<DiagnosticsEvent> DiagnosticsEvents => Of<DiagnosticsEvent>();

    /// <summary>Completes when the first result set has started (used by cancel tests to wait for real execution).</summary>
    public TaskCompletionSource FirstBatchStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private List<T> Of<T>() { lock (_gate) return _events.OfType<T>().ToList(); }

    private ValueTask Add(object e)
    {
        lock (_gate) _events.Add(e);
        return ValueTask.CompletedTask;
    }

    public ValueTask BatchStarted(int batchIndex)
    {
        FirstBatchStarted.TrySetResult();
        return Add(new BatchStartedEvent(batchIndex));
    }

    public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns)
    {
        var rs = new RecordedResultSet(resultSetId, batchIndex, columns);
        lock (_gate)
        {
            if (_resultSets.ContainsKey(resultSetId))
                throw new InvalidOperationException($"Result set id {resultSetId} was started twice.");
            _resultSets[resultSetId] = rs;
            _events.Add(rs);
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows)
    {
        lock (_gate)
        {
            if (!_resultSets.TryGetValue(resultSetId, out var rs))
                throw new InvalidOperationException($"Rows for unknown result set {resultSetId}.");
            if (rs.Ended) throw new InvalidOperationException($"Rows after end of result set {resultSetId}.");
            rs.Rows.AddRange(rows);
            rs.RowFrames++;
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs)
    {
        lock (_gate)
        {
            var rs = _resultSets[resultSetId];
            rs.RowCount = rowCount;
            rs.Truncated = truncated;
        }
        return ValueTask.CompletedTask;
    }

    public ValueTask RowsAffected(int batchIndex, long count, string? statementKind) => Add(new AffectedEvent(batchIndex, count, statementKind));

    public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) =>
        Add(new MessageEvent(batchIndex, severity, text, line, code, source));

    public ValueTask Error(int batchIndex, ErrorInfo error) => Add(new ErrorEvent(batchIndex, error));

    public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => Add(new BatchEndedEvent(batchIndex, elapsedMs, status));

    public ValueTask Diagnostics(int batchIndex, IReadOnlyList<SqlDiagnostic> diagnostics) => Add(new DiagnosticsEvent(batchIndex, diagnostics));

    /// <summary>Human-readable dump of errors and messages for assertion failure output.</summary>
    public string Describe() =>
        string.Join(Environment.NewLine, Events.Select(e => e switch
        {
            ErrorEvent er => $"error[{er.BatchIndex}] {er.Error.Code}: {er.Error.Message} (line {er.Error.Line})",
            MessageEvent m => $"message[{m.BatchIndex}] {m.Severity}: {m.Text}",
            RecordedResultSet rs => $"resultset {rs.Id} (batch {rs.BatchIndex}) rows={rs.RowCount}",
            _ => e.ToString(),
        }));
}
