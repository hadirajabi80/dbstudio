using System.Collections.Concurrent;
using System.Text.Json;
using DbStudio.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Services;

/// <summary>202 body of endpoints that start a job: <c>{ jobId }</c> (docs/PLAN-M2.md 2.3).</summary>
public sealed record JobStarted(string JobId);

/// <summary>Wire shape of a running job (<c>GET /jobs</c>).</summary>
public sealed record JobInfo(string JobId, string Kind, string? ConnectionId, string? Owner, DateTimeOffset StartedAt, long Done, long? Total, string? Message);

/// <summary>Progress reporting of one job (throttled: at most ~10 <c>job.progress</c> events per second).</summary>
public sealed class JobContext
{
    private readonly JobManager _owner;
    private long _lastPublishTicks;

    internal JobContext(JobManager owner, string jobId, string kind, string? connectionId)
    {
        _owner = owner;
        JobId = jobId;
        Kind = kind;
        ConnectionId = connectionId;
    }

    public string JobId { get; }
    public string Kind { get; }
    public string? ConnectionId { get; }
    public long Done { get; private set; }
    public long? Total { get; private set; }
    public string? Message { get; private set; }

    /// <param name="force">Publish even when the last event was less than 100 ms ago (e.g. phase changes).</param>
    public void Report(long done, long? total = null, string? message = null, bool force = false)
    {
        Done = done;
        Total = total ?? Total;
        Message = message ?? Message;
        var now = Environment.TickCount64;
        if (!force && now - Interlocked.Read(ref _lastPublishTicks) < 100) return;
        Interlocked.Exchange(ref _lastPublishTicks, now);
        _owner.Publish(new JobProgressEvent(JobId, Kind, Done, Total, Message));
    }
}

/// <summary>
/// M2 (docs/PLAN-M2.md 2.3): long operations (Redis delete-pattern/analysis, Mongo schema/import/export, Kafka fetch...).
/// <c>Start</c> returns the job id at once (endpoints answer <c>202 { jobId }</c>); the work reports <c>job.progress</c>
/// through its <see cref="JobContext"/> and ends with <c>job.done { status, error, result }</c> (result = the work's return
/// value serialized with the engine conventions). <c>DELETE /jobs/{id}</c> cancels (status "cancelled").
/// </summary>
public sealed class JobManager(IEventPublisher events, ILogger<JobManager>? log = null) : IAsyncDisposable
{
    private readonly ILogger _log = log ?? (ILogger)NullLogger.Instance;
    private readonly ConcurrentDictionary<string, Job> _jobs = new(StringComparer.Ordinal);

    private sealed record Job(JobContext Context, string? Owner, DateTimeOffset StartedAt, CancellationTokenSource Cts)
    {
        public Task? Completion { get; set; }
    }

    /// <param name="kind">e.g. "redis.deletePattern", "mongo.import", "kafka.fetch".</param>
    /// <param name="work">Runs on the thread pool; return the job result (or null). Throw to fail the job.</param>
    public string Start(string kind, string? connectionId, string? ownerClientId, Func<JobContext, CancellationToken, Task<object?>> work)
    {
        var id = Ids.New("j");
        var ctx = new JobContext(this, id, kind, connectionId);
        var job = new Job(ctx, ClientPresence.Normalize(ownerClientId), DateTimeOffset.UtcNow, new CancellationTokenSource());
        _jobs[id] = job;
        job.Completion = Task.Run(() => RunAsync(job, work), CancellationToken.None);
        return id;
    }

    public IReadOnlyList<JobInfo> List() =>
        _jobs.Values.OrderBy(j => j.StartedAt).Select(j => new JobInfo(j.Context.JobId, j.Context.Kind, j.Context.ConnectionId, j.Owner,
            j.StartedAt, j.Context.Done, j.Context.Total, j.Context.Message)).ToList();

    /// <summary>Requests cancellation; false when the job is unknown or already finished.</summary>
    public bool Cancel(string jobId)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return false;
        try { job.Cts.Cancel(); }
        catch (ObjectDisposedException) { return false; }
        return true;
    }

    /// <summary>Waits for a job to finish (tests). Returns immediately when unknown.</summary>
    public Task WaitAsync(string jobId) => _jobs.TryGetValue(jobId, out var job) && job.Completion is { } t ? t : Task.CompletedTask;

    internal void Publish(EngineEvent ev) => events.Publish(ev);

    private async Task RunAsync(Job job, Func<JobContext, CancellationToken, Task<object?>> work)
    {
        var ctx = job.Context;
        ExecutionStatus status;
        string? error = null;
        JsonElement? result = null;
        try
        {
            var value = await work(ctx, job.Cts.Token).ConfigureAwait(false);
            result = value is null ? null : JsonSerializer.SerializeToElement(value, value.GetType(), CoreJson.Options);
            status = ExecutionStatus.Ok;
        }
        catch (OperationCanceledException) when (job.Cts.IsCancellationRequested)
        {
            status = ExecutionStatus.Cancelled;
        }
        catch (Exception ex)
        {
            status = ExecutionStatus.Error;
            error = ex.Message;
            if (ex is not EngineException) _log.LogWarning(ex, "Job {JobId} ({Kind}) failed", ctx.JobId, ctx.Kind);
        }
        _jobs.TryRemove(ctx.JobId, out _);
        job.Cts.Dispose();
        events.Publish(new JobDoneEvent(ctx.JobId, ctx.Kind, status, error, result));
    }

    public async ValueTask DisposeAsync()
    {
        var running = _jobs.Values.ToList();
        foreach (var j in running)
        {
            try { await j.Cts.CancelAsync().ConfigureAwait(false); }
            catch (ObjectDisposedException) { /* finished */ }
        }
        await Task.WhenAny(Task.WhenAll(running.Select(j => j.Completion ?? Task.CompletedTask)), Task.Delay(5000)).ConfigureAwait(false);
    }
}
