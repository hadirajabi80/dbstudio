using System.Globalization;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>
/// Server facts and dashboards (docs/PLAN-M2.md 5.1, 5.5): server + modules + keyspace, parsed INFO, CLIENT LIST / KILL,
/// CONFIG GET / SET, SLOWLOG, PUBSUB CHANNELS / NUMSUB, PUBLISH. Writes (CONFIG SET, CLIENT KILL, SLOWLOG RESET,
/// PUBLISH) are READ_ONLY-guarded.
/// </summary>
public sealed class InfoService
{
    public async Task<RedisServerResponse> ServerAsync(RedisClient c)
    {
        var modules = await c.ModulesAsync().ConfigureAwait(false);
        var keyspace = new Dictionary<int, (long Keys, long Expires)>();
        foreach (var server in c.Primaries())
        {
            var info = InfoParser.Parse((await RedisErrors.Guard(() => server.ExecuteAsync("INFO", "keyspace"), "info").ConfigureAwait(false)).ToString() ?? "");
            foreach (var (db, keys, expires) in InfoParser.Keyspace(info.GetValueOrDefault("keyspace")))
            {
                var cur = keyspace.GetValueOrDefault(db);
                keyspace[db] = (cur.Keys + keys, cur.Expires + expires);
            }
        }
        var list = keyspace.OrderBy(k => k.Key).Select(k => new RedisKeyspaceDb(k.Key, k.Value.Keys, k.Value.Expires)).ToList();
        return new RedisServerResponse(c.Server, c.Mode.ToString().ToLowerInvariant(), modules, c.Databases, list, c.ReadOnly,
            c.Settings.KeyDelimiter, c.Settings.ScanCount);
    }

    public async Task<RedisInfoResponse> InfoAsync(RedisClient c)
    {
        var primary = c.Primary;
        var text = (await RedisErrors.Guard(() => primary.ExecuteAsync("INFO"), "info").ConfigureAwait(false)).ToString() ?? "";
        var sections = InfoParser.Parse(text);
        var dbSize = await KeyBrowser.DbSizeAsync(c, c.IsCluster ? 0 : c.Settings.Database).ConfigureAwait(false);
        long clients;
        try
        {
            clients = (await ClientsAsync(c).ConfigureAwait(false)).Count;
        }
        catch (EngineException)
        {
            clients = InfoParser.Long(sections.GetValueOrDefault("clients")?.GetValueOrDefault("connected_clients"));
        }
        List<RedisClusterNode>? nodes = null;
        if (c.IsCluster)
        {
            var raw = (await RedisErrors.Guard(() => primary.ExecuteAsync("CLUSTER", "NODES"), "cluster|nodes").ConfigureAwait(false)).ToString() ?? "";
            nodes = ParseClusterNodes(raw);
        }
        return new RedisInfoResponse(sections, dbSize, clients, nodes);
    }

    internal static List<RedisClusterNode> ParseClusterNodes(string text)
    {
        var list = new List<RedisClusterNode>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var p = line.Split(' ');
            if (p.Length < 8) continue;
            var address = p[1].Split('@')[0];
            list.Add(new RedisClusterNode(p[0], address, p[2].Split(','), p[3] == "-" ? null : p[3], p.Skip(8).ToList(), p[7]));
        }
        return list;
    }

    public async Task<List<RedisClientInfo>> ClientsAsync(RedisClient c)
    {
        var list = new List<RedisClientInfo>();
        foreach (var server in c.Primaries())
        {
            var text = (await RedisErrors.Guard(() => server.ExecuteAsync("CLIENT", "LIST"), "client|list").ConfigureAwait(false)).ToString() ?? "";
            foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var f = InfoParser.Pairs(line);
                if (!f.TryGetValue("id", out var id)) continue;
                list.Add(new RedisClientInfo(id, f.GetValueOrDefault("addr") ?? "", Empty(f.GetValueOrDefault("name")), Empty(f.GetValueOrDefault("user")),
                    (int)InfoParser.Long(f.GetValueOrDefault("db")), InfoParser.Long(f.GetValueOrDefault("age")), InfoParser.Long(f.GetValueOrDefault("idle")),
                    Empty(f.GetValueOrDefault("cmd")), f.GetValueOrDefault("flags") ?? "", f));
            }
        }
        return list;
    }

    private static string? Empty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    public async Task KillClientAsync(RedisClient c, RedisClientKillRequest req)
    {
        c.EnsureWritable("CLIENT KILL");
        var id = req.Id is { Length: > 0 } i && long.TryParse(i, NumberStyles.None, CultureInfo.InvariantCulture, out _)
            ? i : throw EngineException.Validation("id must be a client id.", new { field = "id" });
        long killed = 0;
        foreach (var server in c.Primaries())
            killed += Resp.Long(await RedisErrors.Guard(() => server.ExecuteAsync("CLIENT", "KILL", "ID", id), "client|kill").ConfigureAwait(false));
        if (killed == 0) throw EngineException.NotFound($"Client {id}");
    }

    public async Task<RedisConfigResponse> ConfigAsync(RedisClient c, string? pattern)
    {
        if (string.IsNullOrWhiteSpace(pattern)) throw EngineException.Validation("pattern is required.", new { field = "pattern" });
        var map = Resp.Map(await RedisErrors.Guard(() => c.Primary.ExecuteAsync("CONFIG", "GET", pattern), "config|get").ConfigureAwait(false));
        return new RedisConfigResponse(map.ToDictionary(kv => kv.Key, kv => Resp.Text(kv.Value), StringComparer.Ordinal));
    }

    public async Task SetConfigAsync(RedisClient c, RedisConfigSetRequest req)
    {
        c.EnsureWritable("CONFIG SET");
        var name = req.Name is { Length: > 0 } n ? n : throw EngineException.Validation("name is required.", new { field = "name" });
        var value = req.Value ?? throw EngineException.Validation("value is required.", new { field = "value" });
        foreach (var server in c.Primaries())
            await RedisErrors.Guard(() => server.ExecuteAsync("CONFIG", "SET", name, value), "config|set").ConfigureAwait(false);
    }

    public async Task<List<RedisSlowlogEntry>> SlowlogAsync(RedisClient c, int count)
    {
        if (count is < 1 or > 10_000) throw EngineException.Validation("count must be between 1 and 10000.", new { field = "count" });
        var list = new List<RedisSlowlogEntry>();
        foreach (var server in c.Primaries())
        {
            foreach (var e in Resp.Arr(await RedisErrors.Guard(() => server.ExecuteAsync("SLOWLOG", "GET", count), "slowlog|get").ConfigureAwait(false)))
            {
                var p = Resp.Arr(e);
                if (p.Length < 4) continue;
                var args = Resp.Arr(p[3]).Select(Resp.Text).ToList();
                list.Add(new RedisSlowlogEntry(Resp.Long(p[0]), DateTimeOffset.FromUnixTimeSeconds(Resp.Long(p[1])), Resp.Long(p[2]), args,
                    p.Length > 4 ? Empty(Resp.Text(p[4])) : null, p.Length > 5 ? Empty(Resp.Text(p[5])) : null));
            }
        }
        return list.OrderByDescending(e => e.Ts).ThenByDescending(e => e.Id).Take(count).ToList();
    }

    public async Task ResetSlowlogAsync(RedisClient c)
    {
        c.EnsureWritable("SLOWLOG RESET");
        foreach (var server in c.Primaries())
            await RedisErrors.Guard(() => server.ExecuteAsync("SLOWLOG", "RESET"), "slowlog|reset").ConfigureAwait(false);
    }

    public async Task<RedisPublishResponse> PublishAsync(RedisClient c, RedisPublishRequest req)
    {
        c.EnsureWritable("PUBLISH");
        var channel = req.Channel is { Length: > 0 } ch ? ch : throw EngineException.Validation("channel is required.", new { field = "channel" });
        var message = req.Message ?? throw EngineException.Validation("message is required.", new { field = "message" });
        var receivers = await RedisErrors.Guard(() => c.Mux.GetSubscriber().PublishAsync(RedisChannel.Literal(channel), message), "publish").ConfigureAwait(false);
        return new RedisPublishResponse(receivers);
    }

    public async Task<RedisPubSubChannels> ChannelsAsync(RedisClient c, string? pattern)
    {
        var names = new SortedSet<string>(StringComparer.Ordinal);
        long patterns = 0;
        foreach (var server in c.Primaries())
        {
            var reply = await RedisErrors.Guard(() => string.IsNullOrEmpty(pattern)
                ? server.ExecuteAsync("PUBSUB", "CHANNELS")
                : server.ExecuteAsync("PUBSUB", "CHANNELS", pattern), "pubsub|channels").ConfigureAwait(false);
            foreach (var n in Resp.Arr(reply)) names.Add(Resp.Text(n));
            patterns += Resp.Long(await RedisErrors.Guard(() => server.ExecuteAsync("PUBSUB", "NUMPAT"), "pubsub|numpat").ConfigureAwait(false));
        }
        var counts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var chunk in names.Take(1000).Chunk(100))
        {
            foreach (var server in c.Primaries())
            {
                var reply = Resp.Arr(await RedisErrors.Guard(() => server.ExecuteAsync("PUBSUB", ["NUMSUB", .. chunk]), "pubsub|numsub").ConfigureAwait(false));
                for (var i = 0; i + 1 < reply.Length; i += 2)
                {
                    var name = Resp.Text(reply[i]);
                    counts[name] = counts.GetValueOrDefault(name) + Resp.Long(reply[i + 1]);
                }
            }
        }
        return new RedisPubSubChannels(names.Take(1000).Select(n => new RedisChannelInfo(n, counts.GetValueOrDefault(n))).ToList(), patterns);
    }
}
