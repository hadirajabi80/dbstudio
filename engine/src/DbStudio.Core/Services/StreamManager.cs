using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using DbStudio.Core.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Services;

// M2 (docs/PLAN-M2.md D3, 2.4): long-running engine streams (Kafka tail, Redis MONITOR / pub-sub, Mongo change streams,
// log tails, activity polling) created over REST and delivered as batched `stream.data` WebSocket events.
//
// Feature packages register a factory per stream kind in their IEngineModule:
//     services.AddKeyedSingleton<IStreamFactory, MonitorStreamFactory>("redis.monitor");
// and implement IEngineStream.RunAsync, pushing kind-specific JSON objects into the sink until cancelled.

/// <summary>Creates the engine stream of one kind (registered as a keyed singleton under the kind, e.g. "kafka.tail").</summary>
public interface IStreamFactory
{
    /// <summary>
    /// Validates <see cref="StreamContext.Params"/> (throw <see cref="EngineException.Validation"/> naming the field) and
    /// creates the stream; may open the source client (<see cref="SourceClientManager.GetAsync"/>). Do not start
    /// producing here: <see cref="IEngineStream.RunAsync"/> is called right after.
    /// </summary>
    Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct);
}

/// <summary>One running stream. If it also implements <see cref="IAsyncDisposable"/> it is disposed after it ends.</summary>
public interface IEngineStream
{
    /// <summary>
    /// Pushes items into <paramref name="sink"/> until <paramref name="ct"/> is cancelled (DELETE, client gone, source
    /// closed, shutdown) or the source ends. Returning normally ends the stream ("completed"); an exception ends it with
    /// state "error" and the exception message as reason.
    /// </summary>
    Task RunAsync(IStreamSink sink, CancellationToken ct);
}

/// <summary>A stream that can pause its source itself (e.g. Kafka tail pauses the consumer) instead of dropping items.</summary>
public interface IPausableEngineStream : IEngineStream
{
    void SetPaused(bool paused);
}

/// <summary>Where a stream pushes its items. Thread-safe; never blocks.</summary>
public interface IStreamSink
{
    string StreamId { get; }

    /// <summary>True while the stream is paused (items pushed now are dropped unless the stream pauses itself).</summary>
    bool Paused { get; }

    /// <summary>
    /// Queues one item (a JSON object). When the bounded queue (settings streams.maxQueuedItems) is full the OLDEST item
    /// is dropped and counted. Returns false when the item itself was dropped (paused) or the stream is ending.
    /// </summary>
    bool Push(JsonElement item);
}

public static class StreamSinkExtensions
{
    /// <summary>Serializes <paramref name="item"/> with the engine JSON conventions (camelCase) and pushes it.</summary>
    public static bool Push<T>(this IStreamSink sink, T item) =>
        sink.Push(JsonSerializer.SerializeToElement(item, CoreJson.Options));
}

/// <param name="StreamId">"st_…".</param>
/// <param name="ConnectionId">The connection id, or "engine" for engine-level streams (engine log).</param>
/// <param name="Profile">The connection profile; null for "engine".</param>
/// <param name="Params">The request's <c>params</c> object (an empty object when omitted).</param>
/// <param name="OwnerClientId">UI client id (<c>X-DbStudio-Client</c>) owning the stream; null for API callers without one.</param>
public sealed record StreamContext(string StreamId, string Kind, string ConnectionId, ConnectionProfile? Profile, JsonElement Params, string? OwnerClientId)
{
    /// <summary>String param; 400 VALIDATION (field <c>params.{name}</c>) when required and missing.</summary>
    public string? GetString(string name, bool required = false)
    {
        if (Params.ValueKind == JsonValueKind.Object && Params.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null)
        {
            var s = v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText();
            if (!string.IsNullOrEmpty(s)) return s;
        }
        if (required) throw EngineException.Validation($"params.{name} is required.", new { field = $"params.{name}" });
        return null;
    }

    /// <summary>Integer param with a default; 400 VALIDATION when present but not an integer.</summary>
    public int GetInt(string name, int fallback)
    {
        if (Params.ValueKind != JsonValueKind.Object || !Params.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return fallback;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
        if (v.ValueKind == JsonValueKind.String && int.TryParse(v.GetString(), out var p)) return p;
        throw EngineException.Validation($"params.{name} must be an integer.", new { field = $"params.{name}" });
    }

    /// <summary>Boolean param with a default.</summary>
    public bool GetBool(string name, bool fallback) =>
        Params.ValueKind == JsonValueKind.Object && Params.TryGetProperty(name, out var v)
            ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => fallback }
            : fallback;

    /// <summary>String-array param (a JSON array of strings, or a comma-separated string); empty when missing.</summary>
    public IReadOnlyList<string> GetStrings(string name)
    {
        if (Params.ValueKind != JsonValueKind.Object || !Params.TryGetProperty(name, out var v)) return [];
        return v.ValueKind switch
        {
            JsonValueKind.Array => v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList(),
            JsonValueKind.String => v.GetString()!.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            _ => [],
        };
    }
}

/// <summary>Wire shape of a stream (<c>GET /streams</c>, pause/resume responses).</summary>
/// <param name="State">open | paused | ended | error.</param>
public sealed record StreamInfo(string StreamId, string Kind, string ConnectionId, string State, string? Owner, DateTimeOffset OpenedAt, long Delivered, long Dropped);

/// <summary>Tunables of <see cref="StreamManager"/> (tests shorten the intervals).</summary>
public sealed record StreamManagerOptions
{
    /// <summary>A batch is flushed at the latest this long after its first item (100 ms).</summary>
    public TimeSpan FlushInterval { get; init; } = TimeSpan.FromMilliseconds(100);

    /// <summary>A batch is flushed as soon as it holds this many items (200).</summary>
    public int MaxBatchItems { get; init; } = 200;

    /// <summary>Open streams per UI client (8, STREAM_LIMIT).</summary>
    public int MaxStreamsPerClient { get; init; } = StreamManager.DefaultMaxStreamsPerClient;

    /// <summary>Engine-wide cap (64, STREAM_LIMIT).</summary>
    public int MaxStreams { get; init; } = StreamManager.DefaultMaxStreams;

    /// <summary>Overrides settings streams.maxQueuedItems.</summary>
    public int? MaxQueuedItems { get; init; }

    /// <summary>While dropping, a <c>stream.state{open, dropped}</c> is sent at most this often (1 s).</summary>
    public TimeSpan DropReportInterval { get; init; } = TimeSpan.FromSeconds(1);

    /// <summary>Overrides settings connections.orphanGraceSeconds (how long streams survive their client's disconnect).</summary>
    public TimeSpan? OrphanGrace { get; init; }

    /// <summary>How long Close waits for a stream to finish after cancelling it.</summary>
    public TimeSpan CloseTimeout { get; init; } = TimeSpan.FromSeconds(5);
}

/// <summary>
/// Owns every engine stream (docs/PLAN-M2.md 2.4): creation through the <see cref="IStreamFactory"/> keyed by kind,
/// bounded per-stream queues with drop-oldest accounting, 100 ms / 200 item batching into <c>stream.data</c>, pause,
/// limits (8 per UI client, 64 engine-wide) and lifetime: a stream ends with <c>stream.state{ended, reason}</c> on DELETE
/// ("closed"), when its owner client is gone for <c>orphanGraceSeconds</c> ("client-gone"), when its source client is
/// closed or breaks ("source-closed" / "source-broken"), at shutdown ("shutdown"), or when the source ends ("completed").
/// </summary>
public sealed class StreamManager : IAsyncDisposable
{
    public const int DefaultMaxQueuedItems = 50_000;
    public const int DefaultMaxStreamsPerClient = 8;
    public const int DefaultMaxStreams = 64;

    /// <summary>Connection id of engine-level streams (engine log tail).</summary>
    public const string EngineConnectionId = "engine";

    private readonly IEventPublisher _events;
    private readonly Func<string, IStreamFactory?> _factories;
    private readonly ConnectionStore? _connections;
    private readonly ClientPresence? _presence;
    private readonly SourceClientManager? _clients;
    private readonly SettingsService? _settings;
    private readonly ILogger _log;
    private readonly StreamManagerOptions _options;
    private readonly ConcurrentDictionary<string, Handle> _streams = new(StringComparer.Ordinal);
    private readonly object _limitGate = new();
    private readonly CancellationTokenSource _disposing = new();
    private int _reserved;

    /// <param name="factories">Resolves the factory of a kind (the Host passes keyed DI: <c>kind => sp.GetKeyedService&lt;IStreamFactory&gt;(kind)</c>).</param>
    /// <param name="connections">Resolves profiles (404 for unknown connection ids); optional for tests.</param>
    public StreamManager(IEventPublisher events, Func<string, IStreamFactory?> factories, ConnectionStore? connections = null,
        ClientPresence? presence = null, SourceClientManager? clients = null, SettingsService? settings = null,
        ILogger<StreamManager>? log = null, StreamManagerOptions? options = null)
    {
        _events = events;
        _factories = factories;
        _connections = connections;
        _presence = presence;
        _clients = clients;
        _settings = settings;
        _log = log ?? (ILogger)NullLogger.Instance;
        _options = options ?? new StreamManagerOptions();
        if (_presence is not null) _presence.ClientGone += OnClientGone;
        if (_clients is not null) _clients.ClientClosed += OnSourceClientClosed;
    }

    public int Count => _streams.Count;

    /// <summary>
    /// Creates and starts a stream. 400 VALIDATION for an unknown kind, 404 for an unknown connection, 429 STREAM_LIMIT
    /// over the limits; factory exceptions (VALIDATION, SOURCE_UNAVAILABLE...) propagate.
    /// </summary>
    public async Task<StreamInfo> OpenAsync(string kind, string connectionId, JsonElement? parameters, string? ownerClientId, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposing.IsCancellationRequested, this);
        if (string.IsNullOrWhiteSpace(kind)) throw EngineException.Validation("kind is required.", new { field = "kind" });
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        var factory = _factories(kind) ?? throw EngineException.Validation($"Unknown stream kind '{kind}'.", new { field = "kind" });
        var owner = ClientPresence.Normalize(ownerClientId);
        ConnectionProfile? profile = connectionId == EngineConnectionId ? null : _connections?.Get(connectionId);

        Reserve(owner);
        var id = Ids.New("st");
        IEngineStream stream;
        var p = parameters is { ValueKind: JsonValueKind.Object } obj ? obj.Clone() : JsonDocument.Parse("{}").RootElement.Clone();
        try
        {
            stream = await factory.CreateAsync(new StreamContext(id, kind, connectionId, profile, p, owner), ct).ConfigureAwait(false);
        }
        catch
        {
            Unreserve();
            throw;
        }

        var handle = new Handle(this, id, kind, connectionId, owner, stream, MaxQueuedItems());
        handle.Lease = _clients?.AcquireLease(connectionId);
        _streams[id] = handle;
        Unreserve();
        _log.LogInformation("Stream {StreamId} ({Kind}) opened on {ConnectionId} for {Owner}", id, kind, connectionId, owner ?? "-");
        handle.Completion = Task.Run(() => RunAsync(handle), CancellationToken.None);
        return handle.ToInfo();
    }

    public StreamInfo? Get(string streamId) => _streams.TryGetValue(streamId, out var h) ? h.ToInfo() : null;

    /// <summary>Open streams, optionally only those of one owner client.</summary>
    public IReadOnlyList<StreamInfo> List(string? ownerClientId = null) =>
        _streams.Values.Where(h => ownerClientId is null || string.Equals(h.Owner, ownerClientId, StringComparison.Ordinal))
            .OrderBy(h => h.OpenedAt).Select(h => h.ToInfo()).ToList();

    /// <summary>Pause keeps the stream open; items are dropped (counted) unless the stream pauses its source. 404 when unknown.</summary>
    public StreamInfo Pause(string streamId) => SetPaused(streamId, true);

    public StreamInfo Resume(string streamId) => SetPaused(streamId, false);

    private StreamInfo SetPaused(string streamId, bool paused)
    {
        if (!_streams.TryGetValue(streamId, out var h)) throw EngineException.NotFound($"Stream '{streamId}'");
        if (h.Paused != paused)
        {
            h.Paused = paused;
            if (h.Stream is IPausableEngineStream ps)
            {
                try { ps.SetPaused(paused); }
                catch (Exception ex) { _log.LogWarning(ex, "Stream {StreamId} could not {Action}", streamId, paused ? "pause" : "resume"); }
            }
            _events.Publish(new StreamStateEvent(streamId, paused ? "paused" : "open", null, h.Dropped));
        }
        return h.ToInfo();
    }

    /// <summary>Ends the stream (DELETE: reason "closed"). Returns false when unknown. Waits for it to finish (bounded).</summary>
    public async Task<bool> CloseAsync(string streamId, string reason = "closed")
    {
        if (!_streams.TryGetValue(streamId, out var h)) return false;
        await StopAsync(h, reason).ConfigureAwait(false);
        return true;
    }

    /// <summary>Ends every stream on a connection (Disconnect, connection deleted or edited).</summary>
    public Task<int> CloseForConnectionAsync(string connectionId, string reason) =>
        CloseWhereAsync(h => h.ConnectionId == connectionId, reason);

    /// <summary>Ends every stream owned by a UI client.</summary>
    public Task<int> CloseForClientAsync(string ownerClientId, string reason) =>
        CloseWhereAsync(h => string.Equals(h.Owner, ownerClientId, StringComparison.Ordinal), reason);

    private async Task<int> CloseWhereAsync(Func<Handle, bool> predicate, string reason)
    {
        var targets = _streams.Values.Where(predicate).ToList();
        await Task.WhenAll(targets.Select(h => StopAsync(h, reason))).ConfigureAwait(false);
        return targets.Count;
    }

    private async Task StopAsync(Handle h, string reason)
    {
        h.CloseReason ??= reason;
        try { await h.Cts.CancelAsync().ConfigureAwait(false); }
        catch (ObjectDisposedException) { /* already finished */ }
        var completion = h.Completion;
        if (completion is null) return;
        var finished = await Task.WhenAny(completion, Task.Delay(_options.CloseTimeout)).ConfigureAwait(false);
        if (finished != completion) _log.LogWarning("Stream {StreamId} did not stop within {Timeout}", h.Id, _options.CloseTimeout);
    }

    /// <summary>settings streams.maxQueuedItems (or the options override).</summary>
    public int MaxQueuedItems()
    {
        if (_options.MaxQueuedItems is { } fixedMax) return Math.Max(1, fixedMax);
        var node = _settings?.Get()["streams"]?["maxQueuedItems"];
        return node is null ? DefaultMaxQueuedItems : (int)Math.Clamp(SettingsService.Number(node), 1, 10_000_000);
    }

    private TimeSpan OrphanGrace()
    {
        if (_options.OrphanGrace is { } fixedGrace) return fixedGrace;
        var node = _settings?.Get()["connections"]?["orphanGraceSeconds"];
        var seconds = node is null ? SessionManager.DefaultOrphanGraceSeconds : Math.Clamp(SettingsService.Number(node), 0, 86_400);
        return TimeSpan.FromSeconds(seconds);
    }

    private void Reserve(string? owner)
    {
        lock (_limitGate)
        {
            var total = _streams.Count + _reserved;
            if (total >= _options.MaxStreams)
                throw EngineException.StreamLimit($"The engine already runs {total} streams (limit {_options.MaxStreams}). Close some live views first.",
                    new { limit = _options.MaxStreams, open = total, scope = "engine" });
            var mine = _streams.Values.Count(h => string.Equals(h.Owner, owner, StringComparison.Ordinal));
            if (mine >= _options.MaxStreamsPerClient)
                throw EngineException.StreamLimit($"This window already has {mine} open streams (limit {_options.MaxStreamsPerClient}). Close a live view (tail, monitor, watch) first.",
                    new { limit = _options.MaxStreamsPerClient, open = mine, scope = "client" });
            _reserved++;
        }
    }

    private void Unreserve()
    {
        lock (_limitGate) _reserved--;
    }

    private async Task RunAsync(Handle h)
    {
        var flush = Task.Run(() => FlushLoopAsync(h), CancellationToken.None);
        var state = "ended";
        string? reason;
        try
        {
            await h.Stream.RunAsync(h, h.Cts.Token).ConfigureAwait(false);
            reason = h.CloseReason ?? "completed";
        }
        catch (OperationCanceledException) when (h.Cts.IsCancellationRequested)
        {
            reason = h.CloseReason ?? "closed";
        }
        catch (Exception ex)
        {
            state = "error";
            reason = ex.Message;
            _log.LogWarning(ex, "Stream {StreamId} ({Kind}) failed", h.Id, h.Kind);
        }
        h.Ending = true;
        h.Queue.Writer.TryComplete();
        try { await flush.ConfigureAwait(false); }
        catch (Exception ex) { _log.LogWarning(ex, "Stream {StreamId} flush loop failed", h.Id); }
        _streams.TryRemove(h.Id, out _);
        h.Lease?.Dispose();
        if (h.Stream is IAsyncDisposable disposable)
        {
            try { await disposable.DisposeAsync().ConfigureAwait(false); }
            catch (Exception ex) { _log.LogDebug(ex, "Disposing stream {StreamId} failed", h.Id); }
        }
        _events.Publish(new StreamStateEvent(h.Id, state, reason, h.Dropped));
        _log.LogInformation("Stream {StreamId} {State} ({Reason}); delivered {Delivered}, dropped {Dropped}", h.Id, state, reason, h.Delivered, h.Dropped);
        h.Cts.Dispose();
    }

    /// <summary>Drains the queue into <c>stream.data</c> batches: flush at 200 items or 100 ms after the first item.</summary>
    private async Task FlushLoopAsync(Handle h)
    {
        var reader = h.Queue.Reader;
        var lastReport = DateTimeOffset.UtcNow;
        long reportedDrops = 0;
        var batch = new List<JsonElement>(_options.MaxBatchItems);

        void ReportDrops(bool force)
        {
            var dropped = h.Dropped;
            if (dropped == reportedDrops) return;
            var now = DateTimeOffset.UtcNow;
            if (!force && now - lastReport < _options.DropReportInterval) return;
            reportedDrops = dropped;
            lastReport = now;
            _events.Publish(new StreamStateEvent(h.Id, h.Paused ? "paused" : "open", null, dropped));
        }

        while (true)
        {
            var hasItems = await WaitAsync(reader, _options.DropReportInterval).ConfigureAwait(false);
            if (hasItems is null)
            {
                ReportDrops(force: false);
                continue;
            }
            if (hasItems == false) break; // completed and drained

            var deadline = DateTimeOffset.UtcNow + _options.FlushInterval;
            while (batch.Count < _options.MaxBatchItems)
            {
                while (batch.Count < _options.MaxBatchItems && reader.TryRead(out var item)) batch.Add(item);
                if (batch.Count >= _options.MaxBatchItems) break;
                var remaining = deadline - DateTimeOffset.UtcNow;
                if (remaining <= TimeSpan.Zero) break;
                if (await WaitAsync(reader, remaining).ConfigureAwait(false) != true) break;
            }
            if (batch.Count > 0)
            {
                var seq = ++h.Seq;
                h.AddDelivered(batch.Count);
                _events.Publish(new StreamDataEvent(h.Id, batch, seq));
                batch = new List<JsonElement>(_options.MaxBatchItems);
            }
            ReportDrops(force: false);
        }
        ReportDrops(force: true);
    }

    /// <returns>true = items available, false = queue completed and empty, null = timed out.</returns>
    private static async Task<bool?> WaitAsync(ChannelReader<JsonElement> reader, TimeSpan timeout)
    {
        if (reader.TryPeek(out _)) return true;
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            return await reader.WaitToReadAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private void OnClientGone(string clientId)
    {
        if (_disposing.IsCancellationRequested || !_streams.Values.Any(h => h.Owner == clientId)) return;
        var grace = OrphanGrace();
        if (grace <= TimeSpan.Zero) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(grace + TimeSpan.FromMilliseconds(20), _disposing.Token).ConfigureAwait(false);
                if (_presence?.IsLive(clientId) == true) return; // came back in time
                var closed = await CloseForClientAsync(clientId, "client-gone").ConfigureAwait(false);
                if (closed > 0) _log.LogInformation("Closed {Count} streams of gone client {ClientId}", closed, clientId);
            }
            catch (OperationCanceledException)
            {
                // shutting down
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Closing streams of client {ClientId} failed", clientId);
            }
        });
    }

    private void OnSourceClientClosed(string connectionId, string state, string? reason)
    {
        if (_disposing.IsCancellationRequested) return;
        _ = CloseForConnectionAsync(connectionId, state == "broken" ? "source-broken" : "source-closed");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposing.IsCancellationRequested) return;
        await _disposing.CancelAsync().ConfigureAwait(false);
        if (_presence is not null) _presence.ClientGone -= OnClientGone;
        if (_clients is not null) _clients.ClientClosed -= OnSourceClientClosed;
        await CloseWhereAsync(_ => true, "shutdown").ConfigureAwait(false);
    }

    private sealed class Handle : IStreamSink
    {
        private long _dropped;
        private long _delivered;

        public Handle(StreamManager owner, string id, string kind, string connectionId, string? ownerClientId, IEngineStream stream, int capacity)
        {
            Manager = owner;
            Id = id;
            Kind = kind;
            ConnectionId = connectionId;
            Owner = ownerClientId;
            Stream = stream;
            Queue = Channel.CreateBounded<JsonElement>(
                new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.DropOldest, SingleWriter = false, SingleReader = false },
                _ => Interlocked.Increment(ref _dropped));
        }

        public StreamManager Manager { get; }
        public string Id { get; }
        public string Kind { get; }
        public string ConnectionId { get; }
        public string? Owner { get; }
        public IEngineStream Stream { get; }
        public Channel<JsonElement> Queue { get; }
        public CancellationTokenSource Cts { get; } = new();
        public DateTimeOffset OpenedAt { get; } = DateTimeOffset.UtcNow;
        public Task? Completion { get; set; }
        public IDisposable? Lease { get; set; }
        public string? CloseReason { get; set; }
        public volatile bool Ending;
        private volatile bool _paused;
        public long Seq;

        public string StreamId => Id;
        public bool Paused { get => _paused; set => _paused = value; }
        public long Dropped => Interlocked.Read(ref _dropped);
        public long Delivered => Interlocked.Read(ref _delivered);

        public void AddDelivered(int n) => Interlocked.Add(ref _delivered, n);

        public bool Push(JsonElement item)
        {
            if (Ending) return false;
            if (_paused && Stream is not IPausableEngineStream)
            {
                Interlocked.Increment(ref _dropped);
                return false;
            }
            return Queue.Writer.TryWrite(item);
        }

        public StreamInfo ToInfo() =>
            new(Id, Kind, ConnectionId, Paused ? "paused" : "open", Owner, OpenedAt, Delivered, Dropped);
    }
}
