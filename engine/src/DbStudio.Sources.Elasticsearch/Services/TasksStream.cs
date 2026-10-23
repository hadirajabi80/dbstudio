using DbStudio.Core.Services;
using DbStudio.Sources.Elasticsearch.Endpoints;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>
/// <c>es.tasks</c> streams: <c>params { intervalMs (≥ 1000, default 2000), actions?, detailed? (default true) }</c>; pushes
/// one <see cref="EsTasksStreamItem"/> per poll. A failed poll is pushed as an empty list after the source answers again
/// (the stream ends with an error when Elasticsearch is unreachable three polls in a row).
/// </summary>
public sealed class TasksStreamFactory(SourceClientManager clients, TaskService tasks) : IStreamFactory
{
    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var interval = ctx.GetInt("intervalMs", 2000);
        if (interval < 1000) throw EngineException.Validation("params.intervalMs must be ≥ 1000.", new { field = "params.intervalMs" });
        var actions = ctx.GetString("actions");
        var detailed = ctx.GetBool("detailed", true);
        var client = await EsEndpoints.ClientAsync(clients, ctx.ConnectionId, ct).ConfigureAwait(false);
        // Validate the filter once (400 before the stream starts).
        await tasks.ListAsync(client, actions, detailed, ct).ConfigureAwait(false);
        return new TasksStream(clients, tasks, ctx.ConnectionId, TimeSpan.FromMilliseconds(Math.Min(interval, 60_000)), actions, detailed);
    }
}

internal sealed class TasksStream(SourceClientManager clients, TaskService tasks, string cid, TimeSpan interval, string? actions, bool detailed) : IEngineStream
{
    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        var failures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var client = await EsEndpoints.ClientAsync(clients, cid, ct).ConfigureAwait(false);
                var list = await tasks.ListAsync(client, actions, detailed, ct).ConfigureAwait(false);
                failures = 0;
                sink.Push(new EsTasksStreamItem(DateTimeOffset.UtcNow.ToString("O"), list));
            }
            catch (EngineException ex) when (ex.Code == ErrorCodes.SourceUnavailable)
            {
                if (++failures >= 3) throw;
            }
            await Task.Delay(interval, ct).ConfigureAwait(false);
        }
    }
}
