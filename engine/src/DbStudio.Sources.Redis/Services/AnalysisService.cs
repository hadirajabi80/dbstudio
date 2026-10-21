using System.Diagnostics;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>
/// Database analysis job (docs/PLAN-M2.md 5.5): SCAN up to <c>sampleLimit</c> keys (cluster: every primary), TYPE + TTL +
/// MEMORY USAGE pipelined per page, aggregated into namespaces (first two delimiter levels), the top 100 keys by memory,
/// per-type totals and TTL buckets. Progress after every page; cancellable between pages.
/// </summary>
public sealed class AnalysisService
{
    public const int DefaultSampleLimit = 100_000;
    public const int MaxSampleLimit = 5_000_000;
    public const int PageSize = 1000;
    public const int TopKeys = 100;
    public const int MaxNamespaces = 2000;

    private static readonly (string Label, long? Max)[] TtlBuckets =
    [
        ("< 1 hour", 3600), ("< 1 day", 86_400), ("< 1 week", 604_800), ("< 1 month", 2_592_000), ("> 1 month", null),
    ];

    public static (int Db, int Limit, string Delimiter) Validate(RedisClient c, RedisAnalysisRequest req)
    {
        var db = c.CheckDb(req.Db ?? c.Settings.Database);
        var limit = req.SampleLimit ?? DefaultSampleLimit;
        if (limit is < 1 or > MaxSampleLimit) throw EngineException.Validation($"sampleLimit must be between 1 and {MaxSampleLimit}.", new { field = "sampleLimit" });
        var delimiter = string.IsNullOrEmpty(req.Delimiter) ? c.Settings.KeyDelimiter : req.Delimiter;
        return (db, limit, delimiter);
    }

    private sealed class Ns
    {
        public long Keys, Memory, TtlSum, TtlCount;
        public int Depth;
        public readonly Dictionary<string, long> Types = new(StringComparer.Ordinal);
    }

    public async Task<RedisAnalysisResult> RunAsync(RedisClient c, int db, int sampleLimit, string delimiter, JobContext job, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var d = c.Db(db);
        var total = await KeyBrowser.DbSizeAsync(c, db).ConfigureAwait(false);
        var target = Math.Min(total, sampleLimit);
        var memorySupported = c.Supports(4);
        var namespaces = new Dictionary<string, Ns>(StringComparer.Ordinal);
        var byType = new Dictionary<string, (long Keys, long Memory)>(StringComparer.Ordinal);
        var top = new PriorityQueue<RedisTopKey, long>();
        var bucketCounts = new long[TtlBuckets.Length];
        long scanned = 0, noTtl = 0;
        job.Report(0, target, "Scanning keys…", force: true);

        foreach (var node in c.IsCluster ? c.Primaries().Select(p => (IServer?)p).ToList() : [null])
        {
            var cursor = "0";
            do
            {
                ct.ThrowIfCancellationRequested();
                var args = new object[] { cursor, "COUNT", PageSize };
                var reply = Resp.Arr(await RedisErrors.Guard(() => node is null ? d.ExecuteAsync("SCAN", args) : node.ExecuteAsync("SCAN", args), "scan").ConfigureAwait(false));
                cursor = reply.Length > 0 ? (string?)reply[0] ?? "0" : "0";
                var keys = (reply.Length > 1 ? Resp.Arr(reply[1]) : []).Select(Resp.Text).Take((int)Math.Max(0, sampleLimit - scanned)).ToList();
                if (keys.Count == 0) continue;
                var summaries = await KeyBrowser.DescribeAsync(d, keys, null).ConfigureAwait(false);
                var sizes = await KeyBrowser.MemoryOfAsync(d, keys, memorySupported).ConfigureAwait(false);
                foreach (var s in summaries)
                {
                    if (s.Type == "none") continue;
                    var mem = sizes.GetValueOrDefault(s.Key) ?? 0;
                    scanned++;
                    var t = byType.GetValueOrDefault(s.Type);
                    byType[s.Type] = (t.Keys + 1, t.Memory + mem);
                    if (s.Ttl < 0) noTtl++;
                    else
                    {
                        var b = Array.FindIndex(TtlBuckets, x => x.Max is null || s.Ttl < x.Max);
                        bucketCounts[b]++;
                    }
                    foreach (var (prefix, depth) in Prefixes(s.Key, delimiter))
                    {
                        if (!namespaces.TryGetValue(prefix, out var ns))
                        {
                            if (namespaces.Count >= MaxNamespaces * 4) Compact(namespaces);
                            ns = namespaces[prefix] = new Ns { Depth = depth };
                        }
                        ns.Keys++;
                        ns.Memory += mem;
                        ns.Types[s.Type] = ns.Types.GetValueOrDefault(s.Type) + 1;
                        if (s.Ttl >= 0) { ns.TtlSum += s.Ttl; ns.TtlCount++; }
                    }
                    var entry = new RedisTopKey(s.Key, s.Type, mem, s.Ttl);
                    if (top.Count < TopKeys) top.Enqueue(entry, mem);
                    else if (top.TryPeek(out _, out var min) && mem > min) top.EnqueueDequeue(entry, mem);
                }
                job.Report(scanned, target, $"Analysed {scanned:N0} of {target:N0} keys");
            } while (cursor != "0" && scanned < sampleLimit);
            if (scanned >= sampleLimit) break;
        }

        var nsList = namespaces
            .OrderByDescending(kv => kv.Value.Memory).ThenByDescending(kv => kv.Value.Keys)
            .Take(MaxNamespaces)
            .Select(kv => new RedisAnalysisNamespace(kv.Key, kv.Value.Keys, kv.Value.Memory,
                kv.Value.TtlCount > 0 ? Math.Round((double)kv.Value.TtlSum / kv.Value.TtlCount, 1) : null, kv.Value.Types))
            .ToList();
        var topList = new List<RedisTopKey>();
        while (top.Count > 0) topList.Add(top.Dequeue());
        topList.Reverse();
        var buckets = TtlBuckets.Select((b, i) => new RedisTtlBucket(b.Label, b.Max, bucketCounts[i])).ToList();
        job.Report(scanned, scanned, $"Analysed {scanned:N0} keys", force: true);
        return new RedisAnalysisResult(scanned, total, scanned < total, nsList, topList,
            byType.ToDictionary(kv => kv.Key, kv => new RedisTypeStat(kv.Value.Keys, kv.Value.Memory), StringComparer.Ordinal),
            new RedisTtlStats(noTtl, buckets), scanned - noTtl, sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// Namespace prefixes of a key: the first and second delimiter levels ("user:" and "user:1001:" for
    /// "user:1001:profile"); "" for keys without a delimiter (shown as "(no namespace)").
    /// </summary>
    internal static IEnumerable<(string Prefix, int Depth)> Prefixes(string key, string delimiter)
    {
        var first = key.IndexOf(delimiter, StringComparison.Ordinal);
        if (first < 0)
        {
            yield return ("", 0);
            yield break;
        }
        yield return (key[..(first + delimiter.Length)], 1);
        var second = key.IndexOf(delimiter, first + delimiter.Length, StringComparison.Ordinal);
        if (second > 0) yield return (key[..(second + delimiter.Length)], 2);
    }

    /// <summary>Bounds memory on keyspaces with millions of distinct second-level prefixes: drop the smallest.</summary>
    private static void Compact(Dictionary<string, Ns> namespaces)
    {
        foreach (var kv in namespaces.Where(kv => kv.Value.Depth > 1).OrderBy(kv => kv.Value.Memory).Take(namespaces.Count / 2).ToList())
            namespaces.Remove(kv.Key);
    }

}
