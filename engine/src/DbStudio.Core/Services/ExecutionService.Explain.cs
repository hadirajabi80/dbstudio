using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Sql;
using Microsoft.Extensions.Logging;

namespace DbStudio.Core.Services;

public sealed partial class ExecutionService
{
    /// <summary>
    /// M1.5 <c>POST /sessions/{sid}/explain</c>: runs the plan reader's script on the tab session as one execution
    /// (exec.started … exec.plan, exec.done; history label "explain"). Actual mode streams the statement's result sets;
    /// plan result sets are captured and never shown. The reader's cleanup statements always run afterwards.
    /// </summary>
    public ExecutionStarted StartExplain(string sessionId, ExplainCommand cmd, IPlanReader reader)
    {
        ArgumentNullException.ThrowIfNull(reader);
        var h = _sessions.Get(sessionId);
        if (string.IsNullOrWhiteSpace(cmd.Sql)) throw EngineException.Validation("sql is required.", new { field = "sql" });
        if (cmd.Mode is not (ExplainModes.Estimated or ExplainModes.Actual))
            throw EngineException.Validation("mode must be estimated or actual.", new { field = "mode" });
        if (cmd.MaxRows < 0) throw EngineException.Validation("maxRows must be >= 0.", new { field = "maxRows" });
        if (cmd.Line < 1 || cmd.Col < 1) throw EngineException.Validation("line and col must be >= 1.", new { field = "line" });
        ParamValues.Validate(cmd.Params);
        if (cmd.Mode == ExplainModes.Actual) EnforceReadOnly(h, [new SqlBatch(cmd.Sql, cmd.Line, cmd.Col)], cmd.ConfirmedDestructive);
        if (h.Session is not AdoSessionBase)
            throw new EngineException(400, ErrorCodes.NotSupported, "Explain plans are not supported for this session.");

        var executionId = Ids.New("x");
        if (!h.TryReserve(executionId))
            throw new EngineException(409, ErrorCodes.SessionBusy, "The session is already executing a statement.");
        var startedAt = DateTimeOffset.UtcNow;
        Track(h, startedAt, cmd.TabId, cmd.Title);
        var task = Task.Run(() => RunExplainAsync(h, executionId, cmd, reader, startedAt));
        _running[executionId] = task;
        _ = task.ContinueWith(_ => _running.TryRemove(executionId, out var _), TaskScheduler.Default);
        return new ExecutionStarted(executionId, startedAt.ToString("O"));
    }

    private async Task RunExplainAsync(SessionHandle h, string executionId, ExplainCommand cmd, IPlanReader reader, DateTimeOffset startedAt)
    {
        var sw = Stopwatch.StartNew();
        var store = _results.Begin(h.Id, executionId, h.Dialect);
        var sink = new EventExecutionSink(executionId, _events, store, 1);
        var status = ExecutionStatus.Ok;
        var resultSets = 0;
        long rowsAffected = 0;
        try
        {
            _events.Publish(new ExecStartedEvent(executionId, h.Id, 1));
            _sessions.PublishChanged(h);
            var reconnectMessage = await _sessions.EnsureUsableAsync(h, CancellationToken.None).ConfigureAwait(false);
            if (reconnectMessage is not null)
                _events.Publish(new ExecMessageEvent(executionId, 0, MessageSeverity.Warning, reconnectMessage, null, null, MessageSource.Engine));

            var session = (AdoSessionBase)h.Session;
            var input = new ExplainInput(executionId, cmd.Sql, cmd.Mode, cmd.Params, cmd.Line, cmd.Col, session.Server.ProductVersion);
            await sink.BatchStarted(0).ConfigureAwait(false);
            var outcome = await ExplainRunner.RunAsync(session, reader, input, sink, cmd.MaxRows, h.Options.CaptureServerOutput, CancellationToken.None).ConfigureAwait(false);
            status = outcome.Status;
            rowsAffected = outcome.RowsAffected;
            resultSets = outcome.ResultSets;
            foreach (var problem in outcome.CleanupErrors)
            {
                _log.LogWarning("Explain cleanup failed for {ExecutionId}: {Error}", executionId, problem);
                _events.Publish(new ExecMessageEvent(executionId, 0, MessageSeverity.Warning,
                    $"Could not restore the session after the plan: {problem}", null, null, MessageSource.Engine));
            }
            if (outcome.Plan is { } plan)
                _events.Publish(new ExecPlanEvent(executionId, h.Dialect, cmd.Mode, plan.Root, plan.Raw, plan.RawFormat, plan.Warnings));
        }
        catch (Exception ex)
        {
            var (code, message) = ex switch
            {
                EngineException ee => (ee.Code, ee.Message),
                SessionBusyException => (ErrorCodes.SessionBusy, ex.Message),
                SessionBrokenException => (ErrorCodes.SessionBroken, ex.Message),
                System.Data.Common.DbException db => (ErrorCodes.ProviderError, db.Message),
                _ => (ErrorCodes.EngineError, ex.Message),
            };
            if (ex is not EngineException and not System.Data.Common.DbException) _log.LogError(ex, "Explain {ExecutionId} failed", executionId);
            await sink.Error(0, new ErrorInfo(code, message, cmd.Line)).ConfigureAwait(false);
            status = status == ExecutionStatus.Cancelled ? status : ExecutionStatus.Error;
        }
        finally
        {
            await sink.BatchEnded(0, sw.ElapsedMilliseconds, status switch
            {
                ExecutionStatus.Ok => BatchStatus.Ok,
                ExecutionStatus.Cancelled => BatchStatus.Cancelled,
                _ => BatchStatus.Error,
            }).ConfigureAwait(false);
            store.Completed = true;
            h.Release();
        }

        _events.Publish(new ExecDoneEvent(executionId, h.Id, status, sw.ElapsedMilliseconds, resultSets, rowsAffected, h.Session.TxOpen));
        _sessions.PublishChanged(h);

        if (cmd.Mode == ExplainModes.Actual && status == ExecutionStatus.Ok)
        {
            try
            {
                var targets = StatementClassifier.Classify(cmd.Sql, h.Dialect).DdlTargets.ToList();
                if (targets.Count > 0) _catalog.InvalidateAfterDdl(h.Profile.Id, h.Dialect, h.Session.CurrentDatabase, targets);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Catalog invalidation failed");
            }
        }
        try
        {
            await _history.AddAsync(h.Profile.Id, h.Session.CurrentDatabase, cmd.Sql, startedAt, sw.ElapsedMilliseconds, status,
                rowsAffected, sink.TotalRows, sink.FirstError, "explain").ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not record history");
        }
    }

}

