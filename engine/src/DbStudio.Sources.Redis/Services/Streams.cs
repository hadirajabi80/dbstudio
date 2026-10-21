using System.Globalization;
using System.Text;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary><c>redis.monitor</c> item (docs/PLAN-M2.md 2.4).</summary>
public sealed record RedisMonitorItem(DateTimeOffset Ts, int Db, string Client, IReadOnlyList<string> Args);

/// <summary><c>redis.subscribe</c> item; <c>Binary</c> payloads travel as hex.</summary>
public sealed record RedisMessageItem(DateTimeOffset Ts, string Channel, string? Pattern, string Payload, bool? Binary);

/// <summary>
/// <c>POST /streams { kind: "redis.monitor", params: { maxMinutes?, node? } }</c>: MONITOR on a dedicated connection.
/// MONITOR costs the server throughput, so the stream stops itself after <c>maxMinutes</c> (default 10, at most 60;
/// ends with reason "completed"). Items beyond the stream queue are dropped and counted by the StreamManager.
/// </summary>
public sealed class MonitorStreamFactory(SourceClientManager clients) : IStreamFactory
{
    public const int DefaultMinutes = 10;
    public const int MaxMinutes = 60;

    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var minutes = ctx.GetInt("maxMinutes", DefaultMinutes);
        if (minutes is < 1 or > MaxMinutes) throw EngineException.Validation($"params.maxMinutes must be between 1 and {MaxMinutes}.", new { field = "params.maxMinutes" });
        var client = await clients.GetAsync(ctx.ConnectionId, ct).ConfigureAwait(false) as RedisClient
            ?? throw EngineException.Validation("redis.monitor needs a Redis connection.", new { field = "connectionId" });
        var nodeName = ctx.GetString("node");
        var server = nodeName is null
            ? client.Primary
            : client.Primaries().FirstOrDefault(p => RedisClient.Format(p.EndPoint) == nodeName)
              ?? throw EngineException.Validation($"Node {nodeName} is not a connected primary.", new { field = "params.node" });
        return new MonitorStream(client, server, TimeSpan.FromMinutes(minutes));
    }
}

public sealed class MonitorStream(RedisClient client, IServer server, TimeSpan limit) : IEngineStream
{
    /// <summary>Tests shorten the auto-stop.</summary>
    internal TimeSpan Limit { get; init; } = limit;

    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        await using var conn = await client.OpenDedicatedAsync(server, 0, ct).ConfigureAwait(false);
        var ok = await conn.CommandAsync(["MONITOR"], ct).ConfigureAwait(false);
        if (ok.IsError) throw RedisErrors.FromServerError(ok.Text ?? "MONITOR failed", "monitor");
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        stop.CancelAfter(Limit);
        try
        {
            while (true)
            {
                var line = await conn.ReadLineAsync(stop.Token).ConfigureAwait(false);
                if (line.Length < 2 || line[0] != '+') continue;
                if (Parse(line.AsSpan(1)) is { } item) sink.Push(item);
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // auto-stop: ends as "completed"
        }
    }

    /// <summary><c>1700000000.123456 [0 127.0.0.1:5000] "SET" "k" "v"</c> → item (null for lines that do not parse).</summary>
    internal static RedisMonitorItem? Parse(ReadOnlySpan<byte> line)
    {
        var open = line.IndexOf((byte)'[');
        var close = line.IndexOf((byte)']');
        if (open <= 0 || close <= open) return null;
        var tsText = Encoding.ASCII.GetString(line[..open]).Trim();
        if (!decimal.TryParse(tsText, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var seconds)) return null;
        var inside = Encoding.UTF8.GetString(line[(open + 1)..close]);
        var space = inside.IndexOf(' ');
        var db = space > 0 && int.TryParse(inside.AsSpan(0, space), NumberStyles.None, CultureInfo.InvariantCulture, out var d) ? d : 0;
        var who = space > 0 ? inside[(space + 1)..] : inside;
        List<string> args;
        try
        {
            args = RedisArgs.Parse(line[(close + 1)..]).Select(RedisArgs.ToDisplay).ToList();
        }
        catch (FormatException)
        {
            args = [Encoding.UTF8.GetString(line[(close + 1)..]).Trim()];
        }
        var ts = DateTimeOffset.FromUnixTimeMilliseconds((long)(seconds * 1000m));
        return new RedisMonitorItem(ts, db, who, args);
    }
}

/// <summary>
/// <c>POST /streams { kind: "redis.subscribe", params: { channels: [...], patterns: [...] } }</c>: SUBSCRIBE / PSUBSCRIBE
/// through the multiplexer's subscriber connection; ends (and unsubscribes) on DELETE.
/// </summary>
public sealed class PubSubStreamFactory(SourceClientManager clients) : IStreamFactory
{
    public const int MaxSubscriptions = 100;

    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var channels = ctx.GetStrings("channels").Where(s => s.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        var patterns = ctx.GetStrings("patterns").Where(s => s.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        if (channels.Count + patterns.Count == 0)
            throw EngineException.Validation("params.channels or params.patterns needs at least one entry.", new { field = "params.channels" });
        if (channels.Count + patterns.Count > MaxSubscriptions)
            throw EngineException.Validation($"At most {MaxSubscriptions} channels and patterns per stream.", new { field = "params.channels" });
        var client = await clients.GetAsync(ctx.ConnectionId, ct).ConfigureAwait(false) as RedisClient
            ?? throw EngineException.Validation("redis.subscribe needs a Redis connection.", new { field = "connectionId" });
        return new PubSubStream(client, channels, patterns);
    }
}

public sealed class PubSubStream(RedisClient client, IReadOnlyList<string> channels, IReadOnlyList<string> patterns) : IEngineStream
{
    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        var sub = client.Mux.GetSubscriber();
        var queues = new List<ChannelMessageQueue>();
        try
        {
            foreach (var ch in channels)
                queues.Add(await RedisErrors.Guard(() => sub.SubscribeAsync(RedisChannel.Literal(ch)).WaitAsync(ct), "subscribe").ConfigureAwait(false));
            foreach (var p in patterns)
                queues.Add(await RedisErrors.Guard(() => sub.SubscribeAsync(RedisChannel.Pattern(p)).WaitAsync(ct), "psubscribe").ConfigureAwait(false));
            foreach (var q in queues)
            {
                var pattern = q.Channel.IsPattern ? q.Channel.ToString() : null;
                q.OnMessage(m => sink.Push(ToItem(m.Channel.ToString(), pattern, m.Message)));
            }
            await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is ObjectDisposedException || client.IsClosing)
        {
            // The source client was closed under the stream (Disconnect, idle reaper), possibly mid-SUBSCRIBE (the pipe
            // reader is completed then: InvalidOperationException): the StreamManager ends it with "source-closed" right
            // after; wait for that cancellation instead of failing the stream with an error.
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
        finally
        {
            // The source client may be closing (Disconnect / idle reaper): never wait on a closed multiplexer.
            foreach (var q in queues)
            {
                try
                {
                    if (client.Mux.IsConnected) await q.UnsubscribeAsync().WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
                    else q.Unsubscribe();
                }
                catch (Exception ex) when (ex is RedisException or ObjectDisposedException or TimeoutException or InvalidOperationException)
                {
                }
            }
        }
    }

    internal static RedisMessageItem ToItem(string channel, string? pattern, RedisValue message)
    {
        var bytes = (byte[]?)message ?? [];
        var binary = RedisArgs.IsBinary(bytes);
        var payload = binary ? Convert.ToHexString(bytes).ToLowerInvariant() : Encoding.UTF8.GetString(bytes);
        return new RedisMessageItem(DateTimeOffset.UtcNow, channel, pattern, payload, binary ? true : null);
    }
}
