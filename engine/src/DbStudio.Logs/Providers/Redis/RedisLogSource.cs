using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Providers.Redis;

/// <summary>
/// Redis (docs/PLAN-M2.md 8.1): <c>slowlog</c> (SLOWLOG GET, cursor by id), <c>latency</c> (LATENCY LATEST + HISTORY;
/// hint when latency-monitor-threshold is 0), <c>monitor</c> (MONITOR, live only, auto-stops after 10 minutes) and
/// activity (CLIENT LIST, CLIENT KILL ID).
/// </summary>
public sealed class RedisLogSource(IRedisLogGateway gateway) : ILogSource, IActivitySource
{
    public const string Slowlog = "slowlog", Latency = "latency", Monitor = "monitor", Activity = "activity";

    public string ProviderId => "redis";

    public static string AclNeeds(string? user, string categories) => $"ACL SETUSER {(string.IsNullOrEmpty(user) ? "default" : user)} {categories}";

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        var nodes = await gateway.NodesAsync(target, ct).ConfigureAwait(false);
        var node = nodes.FirstOrDefault() ?? throw EngineException.SourceUnavailable("No Redis node is reachable.");
        var user = target.Profile?.GetString("user");
        var levels = new List<string> { LogLevels.Info, LogLevels.Warn, LogLevels.Error };
        var slowlog = new LogSourceInfo(Slowlog, "Slow log", "log", true, true, levels, true);
        var latency = new LogSourceInfo(Latency, "Latency monitor", "log", true, true, levels, true);
        var monitor = new LogSourceInfo(Monitor, "MONITOR (live commands)", "log", true, false, [LogLevels.Info], true,
            Reason: "MONITOR costs ~50 % throughput on busy servers; it stops after 10 minutes.");
        var activity = new LogSourceInfo(Activity, "Clients", "activity", false, false, [], true);

        if (await Probe(node, ["SLOWLOG", "LEN"], ct).ConfigureAwait(false) is { } e1)
            slowlog = e1.IsPermission ? slowlog.Unavailable(e1.Message, AclNeeds(user, "+slowlog")) : slowlog.Unavailable(e1.Message, null);
        try
        {
            var cfg = await node.ExecuteAsync(["CONFIG", "GET", "latency-monitor-threshold"], ct).ConfigureAwait(false);
            if (cfg.Array.Count >= 2 && cfg.Array[1].AsString() == "0")
                latency = latency with
                {
                    Reason = "The latency monitor is disabled (latency-monitor-threshold is 0).",
                    Needs = "CONFIG SET latency-monitor-threshold 100",
                };
        }
        catch (RedisReplyException)
        {
            // CONFIG is often renamed or denied on managed Redis: no hint then.
        }
        if (await Probe(node, ["LATENCY", "LATEST"], ct).ConfigureAwait(false) is { } e2)
            latency = e2.IsPermission ? latency.Unavailable(e2.Message, AclNeeds(user, "+latency")) : latency.Unavailable(e2.Message, null);
        if (await Probe(node, ["CLIENT", "LIST"], ct).ConfigureAwait(false) is { } e3)
            activity = e3.IsPermission ? activity.Unavailable(e3.Message, AclNeeds(user, "+client|list +client|kill")) : activity.Unavailable(e3.Message, null);
        return [slowlog, latency, monitor, activity];
    }

    private static async Task<RedisReplyException?> Probe(IRedisNode node, string[] args, CancellationToken ct)
    {
        try
        {
            await node.ExecuteAsync(args, ct).ConfigureAwait(false);
            return null;
        }
        catch (RedisReplyException ex)
        {
            return ex;
        }
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var nodes = await gateway.NodesAsync(target, ct).ConfigureAwait(false);
        var multi = nodes.Count > 1;
        var user = target.Profile?.GetString("user");
        var entries = new List<LogEntry>();
        switch (query.SourceId)
        {
            case Slowlog:
            {
                var count = Math.Clamp(LogFilter.LimitOf(query), 128, 1024);
                foreach (var n in nodes)
                {
                    var reply = await Exec(n, ["SLOWLOG", "GET", count.ToString(CultureInfo.InvariantCulture)], AclNeeds(user, "+slowlog"), ct).ConfigureAwait(false);
                    entries.AddRange(ParseSlowlog(reply, multi ? n.Address : null));
                }
                if (multi) entries = Reseq(entries);
                return LogFilter.Page(entries, query, truncated: entries.Count >= count);
            }
            case Latency:
            {
                foreach (var n in nodes)
                {
                    var latest = await Exec(n, ["LATENCY", "LATEST"], AclNeeds(user, "+latency"), ct).ConfigureAwait(false);
                    var history = new Dictionary<string, RespValue>();
                    foreach (var ev in ParseLatencyLatest(latest))
                        history[ev.Event] = await Exec(n, ["LATENCY", "HISTORY", ev.Event], AclNeeds(user, "+latency"), ct).ConfigureAwait(false);
                    entries.AddRange(ParseLatency(latest, history, multi ? n.Address : null));
                }
                return LogFilter.Page(Reseq(entries), query);
            }
            case Monitor:
                throw EngineException.Validation("MONITOR is a live source: open a logs.tail stream instead.", new { field = "sourceId" });
            default:
                throw SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
        }
    }

    public IAsyncEnumerable<LogEntry>? OpenLive(LogTarget target, string sourceId, CancellationToken ct) =>
        sourceId == Monitor ? MonitorEntries(target, ct) : null;

    private async IAsyncEnumerable<LogEntry> MonitorEntries(LogTarget target, [EnumeratorCancellation] CancellationToken ct)
    {
        var seq = new TimeSeq();
        await foreach (var (node, line) in gateway.MonitorAsync(target, ct).ConfigureAwait(false))
        {
            if (ParseMonitorLine(line, seq) is { } e) yield return e;
        }
    }

    private static async Task<RespValue> Exec(IRedisNode n, string[] args, string needs, CancellationToken ct)
    {
        try
        {
            return await n.ExecuteAsync(args, ct).ConfigureAwait(false);
        }
        catch (RedisReplyException ex) when (ex.IsPermission)
        {
            throw EngineException.Privilege(ex.Message, needs);
        }
        catch (RedisReplyException ex)
        {
            throw EngineException.Validation(ex.Message);
        }
    }

    private static List<LogEntry> Reseq(List<LogEntry> entries)
    {
        var seq = new TimeSeq();
        return entries.OrderBy(e => e.Time ?? DateTimeOffset.MinValue).Select(e => e with { Seq = seq.Next(e.Time) }).ToList();
    }

    // ---- Parsers

    /// <summary>Slow log duration → level: ≥ 1 s error, ≥ 100 ms warn, else info.</summary>
    public static string SlowLevel(double ms) => ms >= 1000 ? LogLevels.Error : ms >= 100 ? LogLevels.Warn : LogLevels.Info;

    /// <summary>SLOWLOG GET reply: [id, unix seconds, duration µs, [args], client addr (4.0+), client name (4.0+)]. Seq = id.</summary>
    public static List<LogEntry> ParseSlowlog(RespValue reply, string? node)
    {
        var list = new List<LogEntry>();
        foreach (var e in reply.Array)
        {
            var a = e.Array;
            if (a.Count < 4) continue;
            var id = a[0].AsLong() ?? 0;
            var ts = a[1].AsLong() is { } s ? DateTimeOffset.FromUnixTimeSeconds(s) : (DateTimeOffset?)null;
            var us = a[2].AsLong() ?? 0;
            var args = a[3].Array.Select(x => x.AsString() ?? "").ToList();
            var fields = new Dictionary<string, string>
            {
                ["id"] = id.ToString(CultureInfo.InvariantCulture),
                ["durationUs"] = us.ToString(CultureInfo.InvariantCulture),
            };
            if (a.Count > 4 && a[4].AsString() is { Length: > 0 } client) fields["client"] = client;
            if (a.Count > 5 && a[5].AsString() is { Length: > 0 } name) fields["clientName"] = name;
            if (node is not null) fields["node"] = node;
            var ms = us / 1000.0;
            list.Add(new LogEntry(ts is null ? null : TimeSeq.Iso(ts.Value), SlowLevel(ms), fields.GetValueOrDefault("client") ?? "slowlog",
                $"{ms.ToString("0.###", CultureInfo.InvariantCulture)} ms  {JoinArgs(args)}", id, null, fields));
        }
        return list;
    }

    public sealed record LatencyEvent(string Event, long Ts, long LatestMs, long MaxMs);

    /// <summary>LATENCY LATEST reply: [[event, unix seconds, latest ms, max ms, (7.4+: sum, count)], ...].</summary>
    public static List<LatencyEvent> ParseLatencyLatest(RespValue reply) =>
        reply.Array.Where(e => e.Array.Count >= 4)
            .Select(e => new LatencyEvent(e.Array[0].AsString() ?? "", e.Array[1].AsLong() ?? 0, e.Array[2].AsLong() ?? 0, e.Array[3].AsLong() ?? 0)).ToList();

    /// <summary>One entry per LATENCY HISTORY sample ([unix seconds, ms]); events without history give their latest sample.</summary>
    public static List<LogEntry> ParseLatency(RespValue latest, IReadOnlyDictionary<string, RespValue> history, string? node)
    {
        var list = new List<LogEntry>();
        foreach (var ev in ParseLatencyLatest(latest))
        {
            var samples = history.TryGetValue(ev.Event, out var h) && h.Array.Count > 0
                ? h.Array.Where(s => s.Array.Count >= 2).Select(s => (Ts: s.Array[0].AsLong() ?? 0, Ms: s.Array[1].AsLong() ?? 0)).ToList()
                : [(ev.Ts, ev.LatestMs)];
            foreach (var (ts, ms) in samples)
            {
                var fields = new Dictionary<string, string>
                {
                    ["event"] = ev.Event, ["latencyMs"] = ms.ToString(CultureInfo.InvariantCulture), ["maxMs"] = ev.MaxMs.ToString(CultureInfo.InvariantCulture),
                };
                if (node is not null) fields["node"] = node;
                var t = DateTimeOffset.FromUnixTimeSeconds(ts);
                list.Add(new LogEntry(TimeSeq.Iso(t), SlowLevel(ms), ev.Event, $"{ev.Event}: {ms} ms (max {ev.MaxMs} ms)", 0, null, fields));
            }
        }
        return list;
    }

    /// <summary>Joins command arguments, quoting those with spaces or quotes (redis-cli style).</summary>
    public static string JoinArgs(IEnumerable<string> args) =>
        string.Join(' ', args.Select(a => a.Length == 0 || a.Any(c => char.IsWhiteSpace(c) || c is '"' or '\'') ? "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"" : a));

    /// <summary>A MONITOR line: <c>1697461331.123456 [0 127.0.0.1:5000] "SET" "k" "a b"</c> (also <c>[0 lua]</c>, <c>[0 unix:/tmp/r.sock]</c>).</summary>
    public static LogEntry? ParseMonitorLine(string line, TimeSeq seq)
    {
        var sp = line.IndexOf(' ');
        var open = line.IndexOf('[');
        var close = line.IndexOf(']', Math.Max(open, 0));
        if (sp <= 0 || open < 0 || close < open) return line == "OK" ? null : new LogEntry(null, LogLevels.Unknown, "monitor", line, seq.Next(null));
        DateTimeOffset? ts = double.TryParse(line[..sp], NumberStyles.Float, CultureInfo.InvariantCulture, out var secs)
            ? DateTimeOffset.FromUnixTimeMilliseconds((long)(secs * 1000)) : null;
        var inside = line[(open + 1)..close].Split(' ', 2);
        var db = inside[0];
        var client = inside.Length > 1 ? inside[1] : "";
        var args = UnquoteArgs(line[(close + 1)..]);
        var fields = new Dictionary<string, string> { ["db"] = db, ["client"] = client };
        if (args.Count > 0) fields["command"] = args[0].ToUpperInvariant();
        return new LogEntry(ts is null ? null : TimeSeq.Iso(ts.Value), LogLevels.Info, client.Length > 0 ? client : "monitor", JoinArgs(args), seq.Next(ts), null, fields);
    }

    /// <summary>Parses the "quoted" "args" of a MONITOR line (\" \\ \n \r \t \xHH escapes).</summary>
    public static List<string> UnquoteArgs(string s)
    {
        var list = new List<string>();
        var i = 0;
        while (i < s.Length)
        {
            while (i < s.Length && s[i] == ' ') i++;
            if (i >= s.Length) break;
            if (s[i] != '"')
            {
                var end = s.IndexOf(' ', i);
                if (end < 0) end = s.Length;
                list.Add(s[i..end]);
                i = end;
                continue;
            }
            i++;
            var bytes = new List<byte>();
            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    var c = s[i + 1];
                    if (c == 'x' && i + 3 < s.Length && byte.TryParse(s.AsSpan(i + 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var b))
                    {
                        bytes.Add(b);
                        i += 4;
                        continue;
                    }
                    bytes.AddRange(Encoding.UTF8.GetBytes(c switch { 'n' => "\n", 'r' => "\r", 't' => "\t", 'a' => "\a", 'b' => "\b", _ => c.ToString() }));
                    i += 2;
                    continue;
                }
                bytes.AddRange(Encoding.UTF8.GetBytes(s[i].ToString()));
                i++;
            }
            i++; // closing quote
            list.Add(Encoding.UTF8.GetString(bytes.ToArray()));
        }
        return list;
    }

    // ---- Activity

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var nodes = await gateway.NodesAsync(target, ct).ConfigureAwait(false);
        var user = target.Profile?.GetString("user");
        var rows = new List<ActivityRow>();
        foreach (var n in nodes)
        {
            var own = (await Exec(n, ["CLIENT", "ID"], AclNeeds(user, "+client|id"), ct).ConfigureAwait(false)).AsLong();
            var list = await Exec(n, ["CLIENT", "LIST"], AclNeeds(user, "+client|list"), ct).ConfigureAwait(false);
            rows.AddRange(ParseClientList(list.AsString() ?? "", own, nodes.Count > 1 ? n.Address : null, DateTimeOffset.UtcNow));
        }
        return rows;
    }

    /// <summary>CLIENT LIST lines (<c>id=3 addr=… name= age=10 idle=0 flags=N db=0 … cmd=client|list user=default</c>).</summary>
    public static List<ActivityRow> ParseClientList(string text, long? ownId, string? node, DateTimeOffset now)
    {
        var rows = new List<ActivityRow>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var kv = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var eq = part.IndexOf('=');
                if (eq > 0) kv[part[..eq]] = part[(eq + 1)..];
            }
            if (!kv.TryGetValue("id", out var id)) continue;
            var flags = kv.GetValueOrDefault("flags", "N");
            var idle = long.TryParse(kv.GetValueOrDefault("idle"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var i) ? i : 0;
            var age = long.TryParse(kv.GetValueOrDefault("age"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var a) ? a : 0;
            var state = flags.Contains('b') ? "blocked" : flags.Contains('S') ? "replica" : flags.Contains('M') ? "master" : flags.Contains('P') ? "pubsub"
                : flags.Contains('x') ? "multi" : idle <= 1 ? "active" : "idle";
            var rowId = node is null ? id : $"{id}@{node}";
            var fields = new Dictionary<string, string>(kv) { ["killStatement"] = $"CLIENT KILL ID {id}" };
            if (node is not null) fields["node"] = node;
            var own = ownId is { } o && o.ToString(CultureInfo.InvariantCulture) == id;
            if (own) fields["self"] = "true";
            var cmd = kv.GetValueOrDefault("cmd");
            rows.Add(new ActivityRow
            {
                Id = rowId,
                Kind = "client",
                User = kv.GetValueOrDefault("user"),
                Host = kv.GetValueOrDefault("addr"),
                App = kv.GetValueOrDefault("name") is { Length: > 0 } name ? name : kv.GetValueOrDefault("lib-name"),
                Database = kv.GetValueOrDefault("db"),
                State = state,
                Since = TimeSeq.Iso(now - TimeSpan.FromSeconds(age)),
                DurationMs = age * 1000,
                WaitType = flags.Contains('b') ? "blocking command" : null,
                Command = cmd is null or "NULL" ? null : cmd,
                CanKill = !own,
                Fields = fields,
            });
        }
        return rows;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var raw = request.Id ?? "";
        var at = raw.IndexOf('@');
        var idText = at >= 0 ? raw[..at] : raw;
        var address = at >= 0 ? raw[(at + 1)..] : null;
        if (!long.TryParse(idText, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
            throw EngineException.Validation("id must be a Redis client id.", new { field = "id" });
        var nodes = await gateway.NodesAsync(target, ct).ConfigureAwait(false);
        var node = address is null ? nodes.FirstOrDefault() : nodes.FirstOrDefault(n => n.Address == address);
        if (node is null) throw EngineException.Validation($"Unknown node '{address}'.", new { field = "id" });
        var reply = await Exec(node, ["CLIENT", "KILL", "ID", idText], AclNeeds(target.Profile?.GetString("user"), "+client|kill"), ct).ConfigureAwait(false);
        var killed = (reply.AsLong() ?? 0) > 0;
        return new LogKillResult(killed, killed ? $"Client {id} was disconnected." : $"No client with id {id}.");
    }
}
