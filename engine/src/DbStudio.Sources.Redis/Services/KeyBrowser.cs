using System.Diagnostics;
using System.Globalization;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>
/// Key browser (docs/PLAN-M2.md 5.3): incremental SCAN with pattern and type filter, TYPE/TTL per page, lazy MEMORY
/// USAGE badges. One request never holds the server: each SCAN call is O(COUNT) and a request stops after a time
/// budget, returning the cursor to continue ("Scan more"). Cluster: one cursor per primary, encoded <c>node@cursor;…</c>.
/// </summary>
public sealed class KeyBrowser
{
    /// <summary>A request stops scanning after this long (the UI continues with the returned cursor).</summary>
    public static TimeSpan Budget { get; set; } = TimeSpan.FromMilliseconds(400);

    public const int MaxIterations = 64;
    public const int MaxMemoryKeys = 100;

    public async Task<RedisScanResponse> ScanAsync(RedisClient c, RedisScanRequest req, CancellationToken ct)
    {
        var db = c.CheckDb(req.Db ?? c.Settings.Database);
        var pattern = string.IsNullOrEmpty(req.Pattern) ? "*" : req.Pattern;
        var count = req.Count ?? c.Settings.ScanCount;
        if (count is < 1 or > 10_000) throw EngineException.Validation("count must be between 1 and 10000.", new { field = "count" });
        var type = string.IsNullOrEmpty(req.Type) || req.Type is "all" ? null : req.Type;
        if (type is not null && Array.IndexOf(Resp.WireTypes, type) < 0)
            throw EngineException.Validation($"Unknown key type '{type}'.", new { field = "type" });
        var serverTypeFilter = type is not null && c.Supports(6);

        var cursors = ParseCursor(c, req.Cursor);
        var found = new List<string>();
        var sw = Stopwatch.StartNew();
        long scanned = 0;
        var iterations = 0;
        var database = c.Db(db);
        while (cursors.Count > 0 && found.Count < count && iterations < MaxIterations)
        {
            ct.ThrowIfCancellationRequested();
            var (node, cursor) = cursors[0];
            var args = new List<object> { cursor, "MATCH", pattern, "COUNT", count };
            if (serverTypeFilter) { args.Add("TYPE"); args.Add(Resp.ServerType(type!)); }
            var reply = await RedisErrors.Guard(() => node is null
                ? database.ExecuteAsync("SCAN", args.ToArray())
                : node.ExecuteAsync("SCAN", args), "scan").ConfigureAwait(false);
            var parts = Resp.Arr(reply);
            var nextCursor = parts.Length > 0 ? (string?)parts[0] ?? "0" : "0";
            foreach (var k in parts.Length > 1 ? Resp.Arr(parts[1]) : []) found.Add(Resp.Text(k));
            scanned += count;
            iterations++;
            if (nextCursor == "0") cursors.RemoveAt(0);
            else
            {
                cursors[0] = (node, nextCursor);
                if (cursors.Count > 1)
                {
                    // round-robin over cluster nodes so one big node does not starve the others
                    var head = cursors[0];
                    cursors.RemoveAt(0);
                    cursors.Add(head);
                }
            }
            if (sw.Elapsed > Budget) break;
        }

        // SCAN may return a key twice (rehashing); keep the first.
        var unique = found.Distinct(StringComparer.Ordinal).ToList();
        var summaries = await DescribeAsync(database, unique, serverTypeFilter ? type : null).ConfigureAwait(false);
        if (type is not null && !serverTypeFilter) summaries = summaries.Where(s => s.Type == type).ToList();
        else summaries = summaries.Where(s => s.Type != "none").ToList();
        var dbSize = await DbSizeAsync(c, db).ConfigureAwait(false);
        // scanned: keys examined by this request (COUNT per SCAN call, at most the database size); the UI sums pages.
        var next = FormatCursor(c, cursors);
        if (next == "0" && req.Cursor is null or "0") scanned = dbSize;
        return new RedisScanResponse(next, summaries, dbSize > 0 ? Math.Min(scanned, dbSize) : scanned, dbSize);
    }

    /// <summary>TYPE (unless known) and TTL of keys, pipelined.</summary>
    internal static async Task<List<RedisKeySummary>> DescribeAsync(IDatabase db, IReadOnlyList<string> keys, string? knownType)
    {
        var result = new List<RedisKeySummary>(keys.Count);
        foreach (var chunk in keys.Chunk(500))
        {
            var batch = db.CreateBatch();
            var types = knownType is null ? chunk.Select(k => batch.ExecuteAsync("TYPE", (RedisKey)k)).ToArray() : null;
            var ttls = chunk.Select(k => batch.ExecuteAsync("TTL", (RedisKey)k)).ToArray();
            batch.Execute();
            await RedisErrors.Guard(() => Task.WhenAll(types is null ? ttls : [.. types, .. ttls]), "type").ConfigureAwait(false);
            for (var i = 0; i < chunk.Length; i++)
            {
                var t = knownType ?? Resp.WireType((string?)types![i].Result);
                result.Add(new RedisKeySummary(chunk[i], t, Resp.Long(ttls[i].Result)));
            }
        }
        return result;
    }

    /// <summary>DBSIZE (cluster: summed over the primaries).</summary>
    public static async Task<long> DbSizeAsync(RedisClient c, int db)
    {
        if (!c.IsCluster) return Resp.Long(await RedisErrors.Guard(() => c.Db(db).ExecuteAsync("DBSIZE"), "dbsize").ConfigureAwait(false));
        long total = 0;
        foreach (var s in c.Primaries()) total += Resp.Long(await RedisErrors.Guard(() => s.ExecuteAsync("DBSIZE"), "dbsize").ConfigureAwait(false));
        return total;
    }

    /// <summary><c>MEMORY USAGE key SAMPLES 0</c> for up to 100 keys (null when unknown or unsupported).</summary>
    public async Task<RedisMemoryResponse> MemoryAsync(RedisClient c, RedisMemoryRequest req)
    {
        var db = c.CheckDb(req.Db ?? c.Settings.Database);
        var keys = req.Keys ?? throw EngineException.Validation("keys is required.", new { field = "keys" });
        if (keys.Count > MaxMemoryKeys) throw EngineException.Validation($"At most {MaxMemoryKeys} keys per request.", new { field = "keys" });
        return new RedisMemoryResponse(await MemoryOfAsync(c.Db(db), keys, c.Supports(4)).ConfigureAwait(false));
    }

    internal static async Task<Dictionary<string, long?>> MemoryOfAsync(IDatabase db, IReadOnlyList<string> keys, bool supported)
    {
        var sizes = new Dictionary<string, long?>(StringComparer.Ordinal);
        if (!supported)
        {
            foreach (var k in keys) sizes[k] = null;
            return sizes;
        }
        var batch = db.CreateBatch();
        var tasks = keys.Distinct(StringComparer.Ordinal).Select(k => (k, batch.ExecuteAsync("MEMORY", "USAGE", (RedisKey)k, "SAMPLES", "0"))).ToList();
        batch.Execute();
        foreach (var (k, t) in tasks)
        {
            try
            {
                var r = await t.ConfigureAwait(false);
                sizes[k] = r.IsNull ? null : Resp.Long(r);
            }
            catch (RedisServerException ex) when (!RedisErrors.IsPermissionError(ex.Message))
            {
                sizes[k] = null;
            }
            catch (RedisServerException ex)
            {
                throw RedisErrors.FromServerError(ex.Message, "memory|usage");
            }
        }
        return sizes;
    }

    /// <summary>"0" = start every node; cluster "host:port@cursor;…" = continue those nodes only.</summary>
    internal static List<(IServer? Node, string Cursor)> ParseCursor(RedisClient c, string? cursor)
    {
        cursor = string.IsNullOrWhiteSpace(cursor) ? "0" : cursor.Trim();
        if (!c.IsCluster)
        {
            if (!ulong.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out _))
                throw EngineException.Validation("cursor must be a SCAN cursor.", new { field = "cursor" });
            return [(null, cursor)];
        }
        var primaries = c.Primaries();
        if (cursor == "0") return primaries.Select(p => ((IServer?)p, "0")).ToList();
        var list = new List<(IServer?, string)>();
        foreach (var part in cursor.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var at = part.LastIndexOf('@');
            if (at <= 0) throw EngineException.Validation("cursor must be node@cursor;… in cluster mode.", new { field = "cursor" });
            var name = part[..at];
            var node = primaries.FirstOrDefault(p => RedisClient.Format(p.EndPoint) == name)
                ?? throw EngineException.Validation($"Cluster node {name} is not a connected primary any more: restart the scan.", new { field = "cursor" });
            list.Add((node, part[(at + 1)..]));
        }
        return list;
    }

    internal static string FormatCursor(RedisClient c, List<(IServer? Node, string Cursor)> cursors)
    {
        if (cursors.Count == 0) return "0";
        if (!c.IsCluster) return cursors[0].Cursor;
        return string.Join(';', cursors.Select(x => $"{RedisClient.Format(x.Node!.EndPoint)}@{x.Cursor}"));
    }
}
