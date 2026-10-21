using System.Globalization;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Deserializers;

namespace DbStudio.Sources.Kafka.Services;

/// <summary>A validated <see cref="KafkaFetchRequest"/>.</summary>
public sealed record FetchOptions(IReadOnlyList<int>? Partitions, string StartKind, int Count, long Offset, DateTimeOffset? Timestamp, int Limit,
    string KeyFormat, string ValueFormat, string? Search, bool CaseSensitive, long MaxBytes, TimeSpan Timeout)
{
    public const int MaxLimit = 5000;
    public const long DefaultMaxBytes = 10L * 1024 * 1024;

    public static FetchOptions From(KafkaFetchRequest? req)
    {
        if (req is null) throw EngineException.Validation("A request body is required.", new { field = "start" });
        var start = req.Start ?? new KafkaFetchStart("latest", null, null, null);
        var kind = (start.Kind ?? "latest").Trim().ToLowerInvariant();
        var limit = req.Limit ?? 200;
        if (limit is < 1 or > MaxLimit) throw EngineException.Validation($"limit must be between 1 and {MaxLimit}.", new { field = "limit" });
        var count = limit;
        long offset = 0;
        DateTimeOffset? ts = null;
        switch (kind)
        {
            case "latest":
                count = start.Count ?? limit;
                if (count is < 1 or > MaxLimit) throw EngineException.Validation($"start.count must be between 1 and {MaxLimit}.", new { field = "start.count" });
                break;
            case "oldest": break;
            case "offset":
                offset = start.Offset ?? throw EngineException.Validation("start.offset is required.", new { field = "start.offset" });
                if (offset < 0) throw EngineException.Validation("start.offset must be ≥ 0.", new { field = "start.offset" });
                break;
            case "timestamp":
                if (string.IsNullOrWhiteSpace(start.Iso) || !DateTimeOffset.TryParse(start.Iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
                    throw EngineException.Validation("start.iso must be an ISO date/time.", new { field = "start.iso" });
                ts = parsed;
                break;
            default:
                throw EngineException.Validation("start.kind must be latest, oldest, offset or timestamp.", new { field = "start.kind" });
        }
        if (req.Partitions is { } ps && ps.Any(p => p < 0)) throw EngineException.Validation("Partitions are ≥ 0.", new { field = "partitions" });
        var maxBytes = req.MaxBytes ?? DefaultMaxBytes;
        if (maxBytes is < 1024 or > 64L * 1024 * 1024) throw EngineException.Validation("maxBytes must be between 1 KB and 64 MB.", new { field = "maxBytes" });
        var timeout = req.TimeoutMs ?? 8000;
        if (timeout is < 500 or > 120_000) throw EngineException.Validation("timeoutMs must be between 500 and 120000.", new { field = "timeoutMs" });
        var search = string.IsNullOrEmpty(req.Search?.Text) ? null : req.Search!.Text;
        return new FetchOptions(req.Partitions, kind, count, offset, ts, limit,
            KafkaFormats.Decoder(req.KeyFormat, "keyFormat", "string"), KafkaFormats.Decoder(req.ValueFormat, "valueFormat"),
            search, req.Search?.CaseSensitive ?? false, maxBytes, TimeSpan.FromMilliseconds(timeout));
    }
}

/// <summary>One partition range of a fetch: [Start, End) with End = the high watermark when the fetch started.</summary>
public sealed record FetchRange(int Partition, long Start, long End);

/// <summary>
/// The message browser (docs/PLAN-M2.md 7.4): computes per-partition start offsets (latest−count via watermarks,
/// OffsetsForTimes for timestamps), then consumes with a manually assigned reader (no group, no commits) until every
/// partition reaches the high watermark it had at the start, the limit, maxBytes or the timeout. "Latest N" keeps the
/// N newest across partitions (by timestamp); search filters on the decoded value text.
/// </summary>
public sealed class MessageBrowser
{
    public static async Task<IReadOnlyList<FetchRange>> PlanAsync(KafkaClientHandle h, string topic, FetchOptions o, CancellationToken ct)
    {
        var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        var ids = TopicService.SelectPartitions(meta, o.Partitions, "partitions");
        var tps = ids.Select(p => new KTopicPartition(topic, p)).ToList();
        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(tps, ct), topic).ConfigureAwait(false);
        IReadOnlyDictionary<KTopicPartition, long?>? times = null;
        if (o.StartKind == "timestamp")
            times = await KafkaErrors.Call(() => h.Gateway.OffsetsForTimesAsync(tps, o.Timestamp!.Value, ct), topic).ConfigureAwait(false);
        return tps.Select(tp =>
        {
            var w = marks.GetValueOrDefault(tp);
            var start = o.StartKind switch
            {
                "latest" => Math.Max(w.Low, w.High - o.Count),
                "oldest" => w.Low,
                "offset" => Math.Clamp(o.Offset, w.Low, w.High),
                _ => Math.Clamp(times?.GetValueOrDefault(tp) ?? w.High, w.Low, w.High),
            };
            return new FetchRange(tp.Partition, start, w.High);
        }).ToList();
    }

    /// <param name="push">Receives each matching message; return false to stop (stream closed).</param>
    /// <param name="progress">(done, total, message) for job.progress.</param>
    public async Task<KafkaFetchResult> FetchAsync(KafkaClientHandle h, string topic, FetchOptions o, Func<KafkaMessageDto, bool> push,
        Action<long, long?, string?>? progress, CancellationToken ct)
    {
        var ranges = await PlanAsync(h, topic, o, ct).ConfigureAwait(false);
        Interlocked.Increment(ref h.ActiveFetches);
        try { return await Task.Run(() => ConsumeAsync(h, topic, o, ranges, push, progress, ct), ct).ConfigureAwait(false); }
        finally { Interlocked.Decrement(ref h.ActiveFetches); }
    }

    private static async Task<KafkaFetchResult> ConsumeAsync(KafkaClientHandle h, string topic, FetchOptions o, IReadOnlyList<FetchRange> ranges,
        Func<KafkaMessageDto, bool> push, Action<long, long?, string?>? progress, CancellationToken ct)
    {
        var ends = ranges.ToDictionary(r => r.Partition, r => r.End);
        var done = new SortedSet<int>(ranges.Where(r => r.Start >= r.End).Select(r => r.Partition));
        var active = ranges.Where(r => r.Start < r.End).ToList();
        var total = active.Sum(r => r.End - r.Start);
        var latest = o.StartKind == "latest";
        var collected = new List<KafkaMessageDto>();
        long scanned = 0, bytes = 0;
        var fetched = 0;
        var timedOut = false;
        var truncated = false;
        var stopped = false;
        var comparison = o.CaseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;

        if (active.Count > 0)
        {
            using var reader = h.Gateway.CreateReader("browse");
            reader.Assign(active.Select(r => (new KTopicPartition(topic, r.Partition), r.Start)).ToList());
            var deadline = DateTimeOffset.UtcNow + o.Timeout;
            while (done.Count < ranges.Count && !stopped)
            {
                ct.ThrowIfCancellationRequested();
                var remaining = deadline - DateTimeOffset.UtcNow;
                if (remaining <= TimeSpan.Zero)
                {
                    timedOut = true;
                    break;
                }
                KConsumeResult? r;
                try { r = reader.Consume(remaining < TimeSpan.FromMilliseconds(250) ? remaining : TimeSpan.FromMilliseconds(250), ct); }
                catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex, topic); }
                if (r is null) continue;
                if (r.Eof is { } eof)
                {
                    if (eof.Topic == topic) done.Add(eof.Partition);
                    continue;
                }
                var rec = r.Record!;
                if (rec.Topic != topic || done.Contains(rec.Partition)) continue;
                var end = ends[rec.Partition];
                if (rec.Offset >= end)
                {
                    done.Add(rec.Partition);
                    continue;
                }
                scanned++;
                if (rec.Offset + 1 >= end) done.Add(rec.Partition);

                var dto = await ToDtoAsync(h.Codec, rec, o.KeyFormat, o.ValueFormat, full: false, ct).ConfigureAwait(false);
                if (o.Search is not null && !(dto.Value.FullText?.Contains(o.Search, comparison) ?? false))
                {
                    if (scanned % 500 == 0) progress?.Invoke(scanned, total, $"{fetched} matched, {scanned} scanned");
                    continue;
                }
                bytes += rec.Size;
                if (latest) collected.Add(dto);
                else
                {
                    fetched++;
                    if (!push(dto)) stopped = true;
                    if (fetched >= o.Limit)
                    {
                        truncated = done.Count < ranges.Count;
                        break;
                    }
                }
                if (bytes >= o.MaxBytes)
                {
                    truncated = true;
                    break;
                }
                if (scanned % 100 == 0) progress?.Invoke(scanned, total, $"{(latest ? collected.Count : fetched)} matched, {scanned} scanned");
            }
        }

        if (latest)
        {
            var newest = collected.OrderByDescending(m => m.Timestamp).ThenByDescending(m => m.Offset).Take(o.Limit).ToList();
            truncated |= collected.Count > newest.Count;
            foreach (var m in newest)
            {
                fetched++;
                if (!push(m)) break;
            }
        }
        progress?.Invoke(scanned, total, $"{fetched} fetched, {scanned} scanned");
        return new KafkaFetchResult(fetched, scanned, done.ToList(), timedOut, truncated);
    }

    /// <summary>One untruncated message (<c>GET …/messages/{partition}/{offset}</c>, "Load full").</summary>
    public async Task<KafkaMessageDto> GetAsync(KafkaClientHandle h, string topic, int partition, long offset, string keyFormat, string valueFormat, CancellationToken ct)
    {
        var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        TopicService.SelectPartitions(meta, [partition], "partition");
        var tp = new KTopicPartition(topic, partition);
        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync([tp], ct), topic).ConfigureAwait(false);
        var w = marks.GetValueOrDefault(tp);
        if (offset < w.Low || offset >= w.High)
            throw new EngineException(404, ErrorCodes.NotFound, $"Offset {offset} is outside partition {partition} ({w.Low}–{Math.Max(w.Low, w.High - 1)}).");
        return await Task.Run(async () =>
        {
            using var reader = h.Gateway.CreateReader("browse");
            reader.Assign([(tp, offset)]);
            var deadline = DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(Math.Max(5000, h.Settings.RequestTimeoutMs));
            while (DateTimeOffset.UtcNow < deadline)
            {
                ct.ThrowIfCancellationRequested();
                KConsumeResult? r;
                try { r = reader.Consume(TimeSpan.FromMilliseconds(250), ct); }
                catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex, topic); }
                if (r?.Record is { } rec && rec.Partition == partition && rec.Offset >= offset)
                {
                    if (rec.Offset != offset) break; // compacted away
                    return await ToDtoAsync(h.Codec, rec, keyFormat, valueFormat, full: true, ct).ConfigureAwait(false);
                }
                if (r?.Eof is { } eof && eof.Partition == partition) break;
            }
            throw new EngineException(404, ErrorCodes.NotFound, $"Message {partition}/{offset} of '{topic}' is not available (compacted or deleted).");
        }, ct).ConfigureAwait(false);
    }

    public static async Task<KafkaMessageDto> ToDtoAsync(MessageCodec codec, KRecord r, string keyFormat, string valueFormat, bool full, CancellationToken ct)
    {
        var key = await codec.DecodeAsync(r.Key, keyFormat, full, ct).ConfigureAwait(false);
        var value = await codec.DecodeAsync(r.Value, valueFormat, full, ct).ConfigureAwait(false);
        var headers = new List<KafkaHeaderDto>(r.Headers.Count);
        foreach (var hd in r.Headers) headers.Add(new KafkaHeaderDto(hd.Key, await codec.DecodeAsync(hd.Value, "string", full, ct).ConfigureAwait(false)));
        return new KafkaMessageDto(r.Topic, r.Partition, r.Offset, r.Timestamp, r.TimestampType, key, value, headers, r.Size);
    }
}
