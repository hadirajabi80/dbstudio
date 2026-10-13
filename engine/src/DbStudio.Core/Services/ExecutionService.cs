using System.Collections.Concurrent;
using System.Diagnostics;
using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Sql;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Services;

/// <param name="Label">"statement" | "selection" | "script".</param>
/// <param name="ConfirmedDestructive">The user confirmed running non-queries (required on read-only connections).</param>
public sealed record ExecuteCommand(
    IReadOnlyList<SqlBatch> Batches,
    int MaxRows,
    bool StopOnError,
    string Label,
    bool ConfirmedDestructive = false,
    string? TabId = null,
    string? Title = null);

public sealed record ExecutionStarted(string ExecutionId, string StartedAt);

/// <summary>
/// Starts executions on tab sessions and streams their events (docs/PLAN.md 1 "Ctrl+Enter" flow): read-only guard,
/// busy check (409 synchronously), background run, result store, history, DDL-driven catalog invalidation,
/// <c>exec.*</c> and <c>session.changed</c> events.
/// </summary>
public sealed class ExecutionService
{
    private readonly SessionManager _sessions;
    private readonly ResultStore _results;
    private readonly HistoryService _history;
    private readonly CatalogService _catalog;
    private readonly ConnectionStore _connections;
    private readonly IEventPublisher _events;
    private readonly ILogger _log;
    private readonly ConcurrentDictionary<string, Task> _running = new(StringComparer.Ordinal);

    public ExecutionService(SessionManager sessions, ResultStore results, HistoryService history, CatalogService catalog,
        ConnectionStore connections, IEventPublisher events, ILogger<ExecutionService>? log = null)
    {
        _sessions = sessions;
        _results = results;
        _history = history;
        _catalog = catalog;
        _connections = connections;
        _events = events;
        _log = log ?? (ILogger)NullLogger.Instance;
    }

    /// <summary>Task of a running execution (tests and graceful shutdown); null when finished or unknown.</summary>
    public Task? Running(string executionId) => _running.GetValueOrDefault(executionId);

    public ExecutionStarted Start(string sessionId, ExecuteCommand cmd)
    {
        var h = _sessions.Get(sessionId);
        Validate(cmd);
        EnforceReadOnly(h, cmd);

        var executionId = Ids.New("x");
        if (!h.TryReserve(executionId))
            throw new EngineException(409, ErrorCodes.SessionBusy, "The session is already executing a statement.");

        var startedAt = DateTimeOffset.UtcNow;
        var task = Task.Run(() => RunAsync(h, executionId, cmd, startedAt));
        _running[executionId] = task;
        _ = task.ContinueWith(_ => _running.TryRemove(executionId, out var _), TaskScheduler.Default);
        return new ExecutionStarted(executionId, startedAt.ToString("O"));
    }

    public bool Cancel(string sessionId)
    {
        var h = _sessions.Get(sessionId);
        if (!h.IsReserved) return false;
        h.Session.Cancel();
        return true;
    }

    private static void Validate(ExecuteCommand cmd)
    {
        if (cmd.Batches is null || cmd.Batches.Count == 0) throw EngineException.Validation("At least one batch is required.", new { field = "batches" });
        if (cmd.MaxRows < 0) throw EngineException.Validation("maxRows must be >= 0.", new { field = "maxRows" });
        for (var i = 0; i < cmd.Batches.Count; i++)
        {
            var b = cmd.Batches[i];
            if (b is null || string.IsNullOrWhiteSpace(b.Sql)) throw EngineException.Validation($"Batch {i} is empty.", new { field = $"batches[{i}].sql" });
            if (b.Line < 1 || b.Col < 1) throw EngineException.Validation($"Batch {i} has an invalid position.", new { field = $"batches[{i}].line" });
        }
    }

    private static void EnforceReadOnly(SessionHandle h, ExecuteCommand cmd)
    {
        if (!h.Profile.ReadOnly || cmd.ConfirmedDestructive) return;
        foreach (var batch in cmd.Batches)
        {
            var classification = StatementClassifier.Classify(batch.Sql, h.Dialect);
            if (classification.IsQueryOnly) continue;
            var kind = classification.Statements.FirstOrDefault(s => s.Category is not (StatementCategory.Query or StatementCategory.Session or StatementCategory.Transaction))?.Kind
                       ?? classification.PrimaryKind ?? "statement";
            throw new EngineException(403, ErrorCodes.ReadOnly,
                $"The connection '{h.Profile.Name}' is read-only: {kind} is not allowed.",
                new { line = batch.Line, kind });
        }
    }

    private async Task RunAsync(SessionHandle h, string executionId, ExecuteCommand cmd, DateTimeOffset startedAt)
    {
        var sw = Stopwatch.StartNew();
        var store = _results.Begin(h.Id, executionId, h.Dialect);
        var sink = new EventExecutionSink(executionId, _events, store, cmd.Batches.Count);
        ExecutionSummary summary;
        try
        {
            _events.Publish(new ExecStartedEvent(executionId, h.Id, cmd.Batches.Count));
            _sessions.PublishChanged(h);

            var reconnectMessage = await _sessions.EnsureUsableAsync(h, CancellationToken.None).ConfigureAwait(false);
            if (reconnectMessage is not null)
                _events.Publish(new ExecMessageEvent(executionId, 0, MessageSeverity.Warning, reconnectMessage, null, null, MessageSource.Engine));

            var request = new ExecuteRequest(cmd.Batches, cmd.MaxRows, cmd.StopOnError, h.Options.CaptureServerOutput, cmd.Label);
            summary = await h.Session.ExecuteAsync(request, sink, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            var (code, message) = ex switch
            {
                EngineException ee => (ee.Code, ee.Message),
                SessionBusyException => (ErrorCodes.SessionBusy, ex.Message),
                SessionBrokenException => (ErrorCodes.SessionBroken, ex.Message),
                _ => (ErrorCodes.EngineError, ex.Message),
            };
            if (ex is not EngineException) _log.LogError(ex, "Execution {ExecutionId} failed", executionId);
            await sink.Error(0, new ErrorInfo(code, message)).ConfigureAwait(false);
            summary = new ExecutionSummary(ExecutionStatus.Error, sw.ElapsedMilliseconds, store.ResultSets.Count, 0);
        }
        finally
        {
            store.Completed = true;
            h.Release();
        }

        var session = h.Session;
        _events.Publish(new ExecDoneEvent(executionId, h.Id, summary.Status, summary.ElapsedMs, summary.ResultSets, summary.RowsAffected, session.TxOpen));
        _sessions.PublishChanged(h);

        InvalidateCatalog(h, cmd, sink);
        await RecordHistoryAsync(h, cmd, startedAt, summary, sink).ConfigureAwait(false);
    }

    private void InvalidateCatalog(SessionHandle h, ExecuteCommand cmd, EventExecutionSink sink)
    {
        try
        {
            var targets = new List<DdlTarget>();
            for (var i = 0; i < cmd.Batches.Count; i++)
            {
                if (sink.BatchStatus(i) != BatchStatus.Ok) continue;
                targets.AddRange(StatementClassifier.Classify(cmd.Batches[i].Sql, h.Dialect).DdlTargets);
            }
            if (targets.Count > 0) _catalog.InvalidateAfterDdl(h.Profile.Id, h.Dialect, h.Session.CurrentDatabase, targets);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Catalog invalidation failed");
        }
    }

    private async Task RecordHistoryAsync(SessionHandle h, ExecuteCommand cmd, DateTimeOffset startedAt, ExecutionSummary summary, EventExecutionSink sink)
    {
        try
        {
            var separator = h.Dialect switch { Dialect.TSql => "\nGO\n", Dialect.PlSql => "\n/\n", _ => ";\n" };
            var sql = cmd.Batches.Count == 1 ? cmd.Batches[0].Sql : string.Join(separator, cmd.Batches.Select(b => b.Sql.TrimEnd().TrimEnd(';')));
            await _history.AddAsync(h.Profile.Id, h.Session.CurrentDatabase, sql, startedAt, summary.ElapsedMs, summary.Status,
                summary.RowsAffected, sink.TotalRows, sink.FirstError, cmd.Label).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not record history");
        }
    }
}

/// <summary>Forwards execution events to the WebSocket publisher and the result store.</summary>
internal sealed class EventExecutionSink(string executionId, IEventPublisher events, StoredExecution store, int batchCount)
    : IExecutionSink, IExecutionDiagnosticsSink
{
    private readonly BatchStatus?[] _statuses = new BatchStatus?[batchCount];
    private long _totalRows;

    public string? FirstError { get; private set; }
    public long TotalRows => Interlocked.Read(ref _totalRows);
    public BatchStatus? BatchStatus(int index) => index >= 0 && index < _statuses.Length ? _statuses[index] : null;

    public ValueTask BatchStarted(int batchIndex)
    {
        events.Publish(new ExecBatchStartedEvent(executionId, batchIndex));
        return ValueTask.CompletedTask;
    }

    public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns)
    {
        store.Start(resultSetId, batchIndex, columns);
        events.Publish(new ExecResultSetEvent(executionId, resultSetId, batchIndex, columns));
        return ValueTask.CompletedTask;
    }

    public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows)
    {
        store.AddRows(resultSetId, rows);
        events.Publish(new ExecRowsEvent(executionId, resultSetId, rows));
        return ValueTask.CompletedTask;
    }

    public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs)
    {
        store.End(resultSetId, rowCount, truncated);
        Interlocked.Add(ref _totalRows, rowCount);
        events.Publish(new ExecResultSetEndEvent(executionId, resultSetId, rowCount, truncated, elapsedMs));
        return ValueTask.CompletedTask;
    }

    public ValueTask RowsAffected(int batchIndex, long count, string? statementKind)
    {
        events.Publish(new ExecAffectedEvent(executionId, batchIndex, count, statementKind));
        return ValueTask.CompletedTask;
    }

    public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source)
    {
        events.Publish(new ExecMessageEvent(executionId, batchIndex, severity, text, line, code, source));
        return ValueTask.CompletedTask;
    }

    public ValueTask Error(int batchIndex, ErrorInfo error)
    {
        FirstError ??= error.Message;
        events.Publish(new ExecErrorEvent(executionId, batchIndex, error.Code, error.Message, error.Line, error.Col, error.Detail));
        return ValueTask.CompletedTask;
    }

    public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status)
    {
        if (batchIndex >= 0 && batchIndex < _statuses.Length) _statuses[batchIndex] = status;
        events.Publish(new ExecBatchEndedEvent(executionId, batchIndex, elapsedMs, status));
        return ValueTask.CompletedTask;
    }

    public ValueTask Diagnostics(int batchIndex, IReadOnlyList<SqlDiagnostic> diagnostics)
    {
        events.Publish(new ExecDiagnosticsEvent(executionId, diagnostics));
        return ValueTask.CompletedTask;
    }
}
