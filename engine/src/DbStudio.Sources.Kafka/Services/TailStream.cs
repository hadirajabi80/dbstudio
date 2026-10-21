using System.Collections.Concurrent;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Deserializers;
using DbStudio.Sources.Kafka.Endpoints;

namespace DbStudio.Sources.Kafka.Services;

/// <summary>
/// <c>kafka.tail</c> streams (docs/PLAN-M2.md 7.4): <c>params { topic, partitions, from: 'latest'|'offsetMap', offsets,
/// keyFormat, valueFormat, filter }</c>. Items are <see cref="KafkaMessageDto"/>. Pausing pauses the consumer itself
/// (nothing is dropped while paused; the backlog arrives on resume).
/// </summary>
public sealed class TailStreamFactory(SourceClientManager clients) : IStreamFactory
{
    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var topic = TopicService.ValidateName(ctx.GetString("topic", required: true), "params.topic");
        var partitions = Ints(ctx.Params, "partitions");
        var from = (ctx.GetString("from") ?? "latest").ToLowerInvariant();
        if (from is not ("latest" or "offsetmap"))
            throw EngineException.Validation("params.from must be 'latest' or 'offsetMap'.", new { field = "params.from" });
        var offsets = OffsetMap(ctx.Params);
        var keyFormat = KafkaFormats.Decoder(ctx.GetString("keyFormat"), "params.keyFormat", "string");
        var valueFormat = KafkaFormats.Decoder(ctx.GetString("valueFormat"), "params.valueFormat");
        var filter = ctx.GetString("filter");

        var h = await KafkaEndpointsHelpers.HandleAsync(clients, ctx.ConnectionId, ct).ConfigureAwait(false);
        var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        var ids = TopicService.SelectPartitions(meta, partitions, "params.partitions");
        var tps = ids.Select(p => new KTopicPartition(topic, p)).ToList();
        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(tps, ct), topic).ConfigureAwait(false);
        var starts = tps.Select(tp =>
        {
            var w = marks.GetValueOrDefault(tp);
            var start = from == "offsetmap" && offsets.TryGetValue(tp.Partition, out var o) ? Math.Clamp(o, w.Low, w.High) : w.High;
            return (tp, start);
        }).ToList();
        return new TailStream(h, starts, keyFormat, valueFormat, filter);
    }

    internal static IReadOnlyList<int>? Ints(JsonElement p, string name)
    {
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        if (v.ValueKind != JsonValueKind.Array) throw EngineException.Validation($"params.{name} must be an array of partition numbers.", new { field = $"params.{name}" });
        return v.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var i) && i >= 0
            ? i : throw EngineException.Validation($"params.{name} must be an array of partition numbers.", new { field = $"params.{name}" })).ToList();
    }

    private static Dictionary<int, long> OffsetMap(JsonElement p)
    {
        var map = new Dictionary<int, long>();
        if (p.ValueKind != JsonValueKind.Object || !p.TryGetProperty("offsets", out var v) || v.ValueKind != JsonValueKind.Object) return map;
        foreach (var e in v.EnumerateObject())
        {
            if (!int.TryParse(e.Name, out var partition) || e.Value.ValueKind != JsonValueKind.Number || !e.Value.TryGetInt64(out var off) || off < 0)
                throw EngineException.Validation("params.offsets maps partition numbers to offsets ≥ 0.", new { field = "params.offsets" });
            map[partition] = off;
        }
        return map;
    }
}

public sealed class TailStream(KafkaClientHandle h, IReadOnlyList<(KTopicPartition Tp, long Start)> starts, string keyFormat, string valueFormat, string? filter)
    : IPausableEngineStream
{
    private volatile bool _paused;

    public IReadOnlyList<(KTopicPartition Tp, long Start)> Starts => starts;

    public void SetPaused(bool paused) => _paused = paused;

    public Task RunAsync(IStreamSink sink, CancellationToken ct) => Task.Factory.StartNew(() => Loop(sink, ct), ct,
        TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();

    private async Task Loop(IStreamSink sink, CancellationToken ct)
    {
        using var reader = h.Gateway.CreateReader("tail");
        reader.Assign(starts.ToList());
        var paused = false;
        while (!ct.IsCancellationRequested)
        {
            if (_paused != paused)
            {
                paused = _paused;
                if (paused) reader.Pause();
                else reader.Resume();
            }
            if (paused)
            {
                await Task.Delay(100, ct).ConfigureAwait(false);
                continue;
            }
            KConsumeResult? r;
            try { r = reader.Consume(TimeSpan.FromMilliseconds(200), ct); }
            catch (OperationCanceledException) { break; }
            catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex); }
            if (r?.Record is not { } rec) continue;
            var dto = await MessageBrowser.ToDtoAsync(h.Codec, rec, keyFormat, valueFormat, full: false, ct).ConfigureAwait(false);
            if (filter is not null && !(dto.Value.FullText?.Contains(filter, StringComparison.OrdinalIgnoreCase) ?? false)
                && !(dto.Key.FullText?.Contains(filter, StringComparison.OrdinalIgnoreCase) ?? false)) continue;
            sink.Push(dto);
        }
    }
}

/// <summary>
/// <c>kafka.fetch</c> streams carry the messages of one browse job (POST …/messages answers <c>{ jobId, streamId }</c>):
/// the endpoint registers a relay, opens the stream with <c>params.token</c>, and the job pushes into the relay's sink.
/// The stream completes when the job finishes; closing the stream cancels the job.
/// </summary>
public sealed class FetchRelays
{
    private readonly ConcurrentDictionary<string, FetchRelay> _pending = new(StringComparer.Ordinal);

    public FetchRelay Register()
    {
        var relay = new FetchRelay(Guid.NewGuid().ToString("N"));
        _pending[relay.Token] = relay;
        return relay;
    }

    public FetchRelay? Take(string token) => _pending.TryRemove(token, out var r) ? r : null;

    public void Forget(FetchRelay relay) => _pending.TryRemove(relay.Token, out _);
}

public sealed class FetchRelay(string token) : IEngineStream
{
    private readonly TaskCompletionSource<IStreamSink> _sink = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly CancellationTokenSource _closed = new();

    public string Token { get; } = token;

    public Task<IStreamSink> Sink => _sink.Task;

    /// <summary>Cancelled when the stream ends before the job (DELETE /streams/{id}, client gone, disconnect).</summary>
    public CancellationToken Closed => _closed.Token;

    public void Complete() => _done.TrySetResult();

    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        _sink.TrySetResult(sink);
        try { await _done.Task.WaitAsync(ct).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            try { await _closed.CancelAsync().ConfigureAwait(false); } catch (ObjectDisposedException) { }
            throw;
        }
    }
}

public sealed class FetchStreamFactory(FetchRelays relays) : IStreamFactory
{
    public Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var token = ctx.GetString("token");
        var relay = token is null ? null : relays.Take(token);
        return relay is null
            ? throw EngineException.Validation("kafka.fetch streams are opened by POST /kafka/{cid}/topics/{topic}/messages.", new { field = "kind" })
            : Task.FromResult<IEngineStream>(relay);
    }
}
