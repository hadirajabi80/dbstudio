using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Export;

/// <summary>
/// Exports a stored result set (rows already fetched) or streams a fresh, unlimited execution straight to a file
/// (<c>POST /export</c>, progress via <c>export.progress</c> / <c>export.done</c>).
/// </summary>
public sealed class ExportService
{
    private readonly SessionManager _sessions;
    private readonly ResultStore _results;
    private readonly IEventPublisher _events;
    private readonly ILogger _log;

    public ExportService(SessionManager sessions, ResultStore results, IEventPublisher events, ILogger<ExportService>? log = null)
    {
        _sessions = sessions;
        _results = results;
        _events = events;
        _log = log ?? (ILogger)NullLogger.Instance;
    }

    public StoredResultSet GetStored(string executionId, int resultSetId)
    {
        var exec = _results.Get(executionId) ?? throw EngineException.NotFound($"Execution '{executionId}' (results are kept for the latest execution of each session)");
        return exec.Get(resultSetId) ?? throw EngineException.NotFound($"Result set {resultSetId} of execution '{executionId}'");
    }

    /// <summary>Writes a stored result set to <paramref name="target"/>; returns the number of rows written.</summary>
    public async Task<long> ExportStoredAsync(string executionId, int resultSetId, string format, ExportOptions options, Stream target, CancellationToken ct)
    {
        if (!ExportFormats.IsKnown(format)) throw EngineException.Validation($"Unknown export format '{format}'.", new { field = "format" });
        var exec = _results.Get(executionId) ?? throw EngineException.NotFound($"Execution '{executionId}'");
        var set = GetStored(executionId, resultSetId);
        await using var writer = ExportFormats.Create(format, target, options, exec.Dialect);
        await writer.BeginAsync(set.Columns, ct).ConfigureAwait(false);
        long count = 0;
        foreach (var row in set.Snapshot())
        {
            await writer.WriteRowAsync(row, ct).ConfigureAwait(false);
            count++;
        }
        await writer.EndAsync(ct).ConfigureAwait(false);
        return count;
    }

    /// <summary>Writes a stored result set to a file atomically.</summary>
    public async Task<long> ExportStoredToFileAsync(string executionId, int resultSetId, string format, ExportOptions options, string path, CancellationToken ct)
    {
        path = ValidatePath(path);
        var partial = path + ".partial";
        long rows;
        try
        {
            await using (var fs = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true))
                rows = await ExportStoredAsync(executionId, resultSetId, format, options, fs, ct).ConfigureAwait(false);
            File.Move(partial, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(partial)) File.Delete(partial);
        }
        return rows;
    }

    /// <summary>Starts an unlimited streaming export of <paramref name="sql"/> on the session; returns the export id.</summary>
    public string StartQueryExport(string sessionId, string sql, string format, string path, ExportOptions options)
    {
        if (string.IsNullOrWhiteSpace(sql)) throw EngineException.Validation("sql is required.", new { field = "sql" });
        if (!ExportFormats.IsKnown(format)) throw EngineException.Validation($"Unknown export format '{format}'.", new { field = "format" });
        path = ValidatePath(path);
        var h = _sessions.Get(sessionId);
        var exportId = Ids.New("e");
        if (!h.TryReserve(exportId))
            throw new EngineException(409, ErrorCodes.SessionBusy, "The session is already executing a statement.");
        _ = Task.Run(() => RunQueryExportAsync(h, exportId, sql, format, path, options));
        return exportId;
    }

    private static string ValidatePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw EngineException.Validation("path is required.", new { field = "path" });
        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw EngineException.Validation($"Invalid path: {ex.Message}", new { field = "path" });
        }
        var dir = Path.GetDirectoryName(full);
        if (dir is null || !Directory.Exists(dir)) throw EngineException.Validation($"Directory does not exist: {dir}", new { field = "path" });
        return full;
    }

    private async Task RunQueryExportAsync(SessionHandle h, string exportId, string sql, string format, string path, ExportOptions options)
    {
        var partial = path + ".partial";
        ExportSink? sink = null;
        var status = ExecutionStatus.Error;
        string? error = null;
        try
        {
            await _sessions.EnsureUsableAsync(h, CancellationToken.None).ConfigureAwait(false);
            await using var fs = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 64 * 1024, useAsync: true);
            sink = new ExportSink(exportId, fs, format, options, h.Dialect, _events);
            var summary = await h.Session.ExecuteAsync(
                new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "statement"), sink, CancellationToken.None).ConfigureAwait(false);
            await sink.CompleteAsync().ConfigureAwait(false);
            status = summary.Status;
            error = sink.ErrorMessage;
            if (status == ExecutionStatus.Ok && sink.ErrorMessage is null && !sink.HadResultSet)
            {
                status = ExecutionStatus.Error;
                error = "The statement returned no result set.";
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Export {ExportId} failed", exportId);
            error = ex.Message;
            status = ExecutionStatus.Error;
        }
        finally
        {
            h.Release();
            _sessions.PublishChanged(h);
        }

        try
        {
            if (status == ExecutionStatus.Ok) File.Move(partial, path, overwrite: true);
            else if (File.Exists(partial)) File.Delete(partial);
        }
        catch (IOException ex)
        {
            status = ExecutionStatus.Error;
            error = ex.Message;
        }
        _events.Publish(new ExportDoneEvent(exportId, path, sink?.RowsWritten ?? 0, status, error));
    }

    /// <summary>Writes the first result set of an execution to a file and reports progress.</summary>
    private sealed class ExportSink(string exportId, Stream stream, string format, ExportOptions options, Dialect dialect, IEventPublisher events) : IExecutionSink
    {
        private IResultWriter? _writer;
        private int _resultSetId = -1;
        private long _lastProgressTicks = Stopwatch.GetTimestamp();

        public long RowsWritten { get; private set; }
        public string? ErrorMessage { get; private set; }
        public bool HadResultSet => _resultSetId >= 0;

        public ValueTask BatchStarted(int batchIndex) => ValueTask.CompletedTask;

        public async ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns)
        {
            if (_resultSetId >= 0) return; // only the first result set is exported
            _resultSetId = resultSetId;
            _writer = ExportFormats.Create(format, stream, options, dialect);
            await _writer.BeginAsync(columns, CancellationToken.None).ConfigureAwait(false);
        }

        public async ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows)
        {
            if (resultSetId != _resultSetId || _writer is null) return;
            foreach (var row in rows) await _writer.WriteRowAsync(row, CancellationToken.None).ConfigureAwait(false);
            RowsWritten += rows.Count;
            if (Stopwatch.GetElapsedTime(_lastProgressTicks) >= TimeSpan.FromMilliseconds(500))
            {
                _lastProgressTicks = Stopwatch.GetTimestamp();
                events.Publish(new ExportProgressEvent(exportId, RowsWritten));
            }
        }

        public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs) => ValueTask.CompletedTask;
        public ValueTask RowsAffected(int batchIndex, long count, string? statementKind) => ValueTask.CompletedTask;
        public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) => ValueTask.CompletedTask;

        public ValueTask Error(int batchIndex, ErrorInfo error)
        {
            ErrorMessage ??= error.Message;
            return ValueTask.CompletedTask;
        }

        public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => ValueTask.CompletedTask;

        public async Task CompleteAsync()
        {
            if (_writer is null) return;
            await _writer.EndAsync(CancellationToken.None).ConfigureAwait(false);
            await _writer.DisposeAsync().ConfigureAwait(false);
            _writer = null;
            events.Publish(new ExportProgressEvent(exportId, RowsWritten));
        }
    }
}
