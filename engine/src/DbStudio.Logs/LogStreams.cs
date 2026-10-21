using DbStudio.Core.Services;

namespace DbStudio.Logs;

/// <summary>
/// <c>logs.tail { sourceId, levels?, q?, after?, maxMinutes? }</c> (docs/PLAN-M2.md 8.1, 2.4): items are <see cref="LogEntry"/>.
/// Polled sources are queried every <c>logs.tailIntervalMs</c> (engine log: at most 1 s) with a seq cursor that starts at
/// the newest entry (or <c>params.after</c>); pausing stops polling and resuming catches up. Live sources (Redis MONITOR,
/// Mongo change stream) push; MONITOR ends after <c>maxMinutes</c> (default 10) with a final entry whose
/// <c>fields.autoStopped</c> is "true".
/// </summary>
public sealed class LogTailStreamFactory(LogService logs, Func<int>? tailIntervalMs = null) : IStreamFactory
{
    public const string Kind = "logs.tail";

    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var sourceId = ctx.GetString("sourceId", required: true)!;
        var levels = ctx.GetStrings("levels").Select(l => l.ToLowerInvariant()).ToList();
        foreach (var l in levels)
            if (!LogLevels.IsKnown(l)) throw EngineException.Validation($"Unknown level '{l}'.", new { field = "params.levels" });
        var q = ctx.GetString("q");
        if (q is { Length: > LogFilter.MaxQueryLength }) throw EngineException.Validation("params.q is too long.", new { field = "params.q" });
        var maxMinutes = ctx.GetInt("maxMinutes", 10);
        if (maxMinutes is < 1 or > 120) throw EngineException.Validation("params.maxMinutes must be between 1 and 120.", new { field = "params.maxMinutes" });
        var filter = new LogQuery(sourceId, Levels: levels.Count > 0 ? levels : null, Q: string.IsNullOrWhiteSpace(q) ? null : q.Trim());
        var target = logs.Target(ctx.ConnectionId); // 404 for unknown connections
        if (target.Profile is null && sourceId != EngineLogSource.SourceId)
            throw EngineException.Validation($"Unknown engine log source '{sourceId}'.", new { field = "params.sourceId" });

        var live = logs.OpenLive(ctx.ConnectionId, sourceId, CancellationToken.None);
        if (live is not null)
        {
            var autoStop = sourceId == Providers.Redis.RedisLogSource.Monitor ? TimeSpan.FromMinutes(maxMinutes) : (TimeSpan?)null;
            return new LiveTailStream(logs, ctx.ConnectionId, sourceId, filter, autoStop);
        }
        long cursor;
        if (ctx.Params.ValueKind == System.Text.Json.JsonValueKind.Object && ctx.Params.TryGetProperty("after", out var a) && a.TryGetInt64(out var after))
            cursor = after;
        else cursor = await logs.NewestSeqAsync(ctx.ConnectionId, sourceId, ct).ConfigureAwait(false);
        var interval = Math.Clamp(tailIntervalMs?.Invoke() ?? 2000, 100, 600_000);
        if (sourceId == EngineLogSource.SourceId) interval = Math.Min(interval, 1000);
        return new PolledTailStream(logs, ctx.ConnectionId, filter, cursor, TimeSpan.FromMilliseconds(interval));
    }

    internal sealed class PolledTailStream(LogService logs, string cid, LogQuery filter, long cursor, TimeSpan interval) : IPausableEngineStream
    {
        private volatile bool _paused;
        public long Cursor => cursor;
        public void SetPaused(bool paused) => _paused = paused;

        public async Task RunAsync(IStreamSink sink, CancellationToken ct)
        {
            var failures = 0;
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(interval, ct).ConfigureAwait(false);
                if (_paused) continue;
                var more = true;
                while (more && !ct.IsCancellationRequested && !_paused)
                {
                    LogQueryResponse page;
                    try
                    {
                        page = await logs.QueryAsync(cid, filter with { After = cursor, Limit = LogFilter.MaxLimit }, ct).ConfigureAwait(false);
                        failures = 0;
                    }
                    catch (EngineException ex) when (ex.Code is ErrorCodes.SourceUnavailable or ErrorCodes.ProviderError && ++failures < 3)
                    {
                        break; // transient: retry on the next tick
                    }
                    foreach (var e in page.Entries) sink.Push(e);
                    if (page.Entries.Count > 0) cursor = page.Entries[^1].Seq;
                    more = page.HasMore && page.Entries.Count > 0;
                }
            }
        }
    }

    internal sealed class LiveTailStream(LogService logs, string cid, string sourceId, LogQuery filter, TimeSpan? autoStop) : IEngineStream
    {
        public async Task RunAsync(IStreamSink sink, CancellationToken ct)
        {
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
            if (autoStop is { } after) stop.CancelAfter(after);
            var feed = logs.OpenLive(cid, sourceId, stop.Token) ?? throw EngineException.Validation($"'{sourceId}' is not a live source.");
            try
            {
                await foreach (var e in feed.WithCancellation(stop.Token).ConfigureAwait(false))
                    if (LogFilter.Matches(e, filter)) sink.Push(e);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested && stop.IsCancellationRequested)
            {
                var minutes = (int)Math.Round(autoStop!.Value.TotalMinutes);
                sink.Push(new LogEntry(TimeSeq.Iso(DateTimeOffset.UtcNow), LogLevels.Warn, "monitor",
                    $"MONITOR stopped after {minutes} minutes (it costs throughput on busy servers). Extend to keep watching.", long.MaxValue / 2, null,
                    new Dictionary<string, string> { ["autoStopped"] = "true" }));
            }
        }
    }
}

/// <summary><c>activity.poll { intervalMs }</c>: one <see cref="ActivitySnapshot"/> per interval (500 ms – 60 s, default 2 s).</summary>
public sealed class ActivityPollStreamFactory(LogService logs) : IStreamFactory
{
    public const string Kind = "activity.poll";

    public Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var interval = ctx.GetInt("intervalMs", 2000);
        if (interval is < 500 or > 60_000) throw EngineException.Validation("params.intervalMs must be between 500 and 60000.", new { field = "params.intervalMs" });
        var target = logs.Target(ctx.ConnectionId);
        logs.Activity(target); // VALIDATION when the provider has no activity source
        return Task.FromResult<IEngineStream>(new Stream(logs, ctx.ConnectionId, TimeSpan.FromMilliseconds(interval)));
    }

    internal sealed class Stream(LogService logs, string cid, TimeSpan interval) : IPausableEngineStream
    {
        private volatile bool _paused;
        public void SetPaused(bool paused) => _paused = paused;

        public async Task RunAsync(IStreamSink sink, CancellationToken ct)
        {
            var failures = 0;
            while (!ct.IsCancellationRequested)
            {
                if (!_paused)
                {
                    try
                    {
                        sink.Push(await logs.SnapshotAsync(cid, ct).ConfigureAwait(false));
                        failures = 0;
                    }
                    catch (EngineException ex) when (ex.Code is ErrorCodes.SourceUnavailable or ErrorCodes.ProviderError && ++failures < 3)
                    {
                        // transient: retry on the next tick
                    }
                }
                await Task.Delay(interval, ct).ConfigureAwait(false);
            }
        }
    }
}
