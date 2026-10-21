using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class StreamTests
{
    private static JsonElement Params(object o) => JsonSerializer.SerializeToElement(o, CoreJson.Options);

    private static async Task WaitUntil(Func<bool> condition, int timeoutMs = 10_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task Monitor_streams_commands_of_other_clients()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var info = await h.Streams.OpenAsync("redis.monitor", h.Cid, Params(new { }), "ui1", CancellationToken.None);
        await WaitUntil(() => h.Server.Monitors == 1);
        await c.Db(0).ExecuteAsync("SET", "watched", "a b");
        var data = await h.Events.WaitAsync<StreamDataEvent>(e => e.StreamId == info.StreamId &&
            e.Items.Any(i => i.GetProperty("args").EnumerateArray().Select(a => a.GetString()).SequenceEqual(new[] { "SET", "watched", "a b" })));
        var item = data.Items.First(i => i.GetProperty("args")[0].GetString() == "SET");
        Assert.Equal(0, item.GetProperty("db").GetInt32());
        Assert.Contains("127.0.0.1", item.GetProperty("client").GetString());
        Assert.True(await h.Streams.CloseAsync(info.StreamId));
        await h.Events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State == "ended");
        await WaitUntil(() => h.Server.Monitors == 0);
    }

    [Fact]
    public async Task Monitor_delivers_10k_lines_per_second_and_reports_drops()
    {
        await using var h = await RedisHarness.StartAsync(streamOptions: new StreamManagerOptions
        {
            FlushInterval = TimeSpan.FromMilliseconds(20), MaxQueuedItems = 2_000, DropReportInterval = TimeSpan.FromMilliseconds(50),
        });
        var info = await h.Streams.OpenAsync("redis.monitor", h.Cid, Params(new { }), "ui1", CancellationToken.None);
        await WaitUntil(() => h.Server.Monitors == 1);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        h.Server.FloodMonitors(30_000);
        await WaitUntil(() => h.Events.All.OfType<StreamDataEvent>().Where(e => e.StreamId == info.StreamId).Sum(e => e.Items.Count)
            + (h.Streams.List().FirstOrDefault(s => s.StreamId == info.StreamId)?.Dropped ?? 0) >= 30_000, 20_000);
        sw.Stop();
        Assert.True(30_000 / sw.Elapsed.TotalSeconds >= 10_000, $"{30_000 / sw.Elapsed.TotalSeconds:N0} lines/s");
        // Phase 2: a slow consumer (WebSocket fan-out blocked) makes the 2,000 item queue drop the oldest lines.
        h.Events.DataGate.Reset();
        h.Server.FloodMonitors(10_000);
        await WaitUntil(() => (h.Streams.List().First(s => s.StreamId == info.StreamId).Dropped) > 0, 20_000);
        h.Events.DataGate.Set();
        var state = await h.Events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.Dropped > 0);
        Assert.Equal("open", state.State);
        await h.Streams.CloseAsync(info.StreamId);
    }

    [Fact]
    public async Task Monitor_auto_stops_after_its_limit()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var stream = new MonitorStream(c, c.Primary, TimeSpan.FromMilliseconds(300));
        var sink = new ListSink();
        var run = stream.RunAsync(sink, CancellationToken.None);
        Assert.Same(run, await Task.WhenAny(run, Task.Delay(10_000)));
        await run; // completed normally
        await WaitUntil(() => h.Server.Monitors == 0);
    }

    [Fact]
    public async Task Monitor_params_are_validated()
    {
        await using var h = await RedisHarness.StartAsync();
        var ex = await Assert.ThrowsAsync<EngineException>(() => h.Streams.OpenAsync("redis.monitor", h.Cid, Params(new { maxMinutes = 0 }), "ui1", CancellationToken.None));
        Assert.Contains("maxMinutes", ex.Message);
        await Assert.ThrowsAsync<EngineException>(() => h.Streams.OpenAsync("redis.monitor", h.Cid, Params(new { node = "10.0.0.1:1" }), "ui1", CancellationToken.None));
    }

    [Fact]
    public void Monitor_line_parsing()
    {
        var item = MonitorStream.Parse("1700000000.123456 [3 10.0.0.5:51234] \"HSET\" \"h\" \"f\" \"a\\\"b\""u8)!;
        Assert.Equal(3, item.Db);
        Assert.Equal("10.0.0.5:51234", item.Client);
        Assert.Equal(["HSET", "h", "f", "a\"b"], item.Args);
        Assert.Equal(1_700_000_000_123, item.Ts.ToUnixTimeMilliseconds());
        Assert.Equal("lua", MonitorStream.Parse("1.5 [0 lua] \"GET\" \"x\""u8)!.Client);
        Assert.Null(MonitorStream.Parse("garbage"u8));
    }

    [Fact]
    public async Task Subscribe_delivers_channel_and_pattern_messages_then_unsubscribes()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var info = await h.Streams.OpenAsync("redis.subscribe", h.Cid, Params(new { channels = new[] { "news" }, patterns = new[] { "orders.*" } }), "ui1", CancellationToken.None);
        await WaitUntil(() => h.Server.Subscriptions >= 2);
        var publish = new InfoService();
        Assert.True((await publish.PublishAsync(c, new RedisPublishRequest("news", "hello"))).Receivers >= 1);
        await publish.PublishAsync(c, new RedisPublishRequest("orders.eu", "{\"id\":1}"));
        await h.Events.WaitAsync<StreamDataEvent>(e => e.StreamId == info.StreamId && e.Items.Any(i => i.GetProperty("channel").GetString() == "news"));
        var p = await h.Events.WaitAsync<StreamDataEvent>(e => e.StreamId == info.StreamId && e.Items.Any(i => i.GetProperty("channel").GetString() == "orders.eu"));
        var item = p.Items.First(i => i.GetProperty("channel").GetString() == "orders.eu");
        Assert.Equal("orders.*", item.GetProperty("pattern").GetString());
        Assert.Equal("{\"id\":1}", item.GetProperty("payload").GetString());
        await h.Streams.CloseAsync(info.StreamId);
        await WaitUntil(() => h.Server.Connections.All(x => !x.Channels.Contains("news") && !x.Patterns.Contains("orders.*")));
    }

    [Fact]
    public async Task Subscribe_needs_a_channel()
    {
        await using var h = await RedisHarness.StartAsync();
        await Assert.ThrowsAsync<EngineException>(() => h.Streams.OpenAsync("redis.subscribe", h.Cid, Params(new { channels = Array.Empty<string>() }), "ui1", CancellationToken.None));
    }

    [Fact]
    public void Binary_pubsub_payloads_travel_as_hex()
    {
        var item = PubSubStream.ToItem("c", null, new byte[] { 0, 1, 255 });
        Assert.True(item.Binary);
        Assert.Equal("0001ff", item.Payload);
        Assert.Null(PubSubStream.ToItem("c", null, "text").Binary);
    }

    [Fact]
    public async Task Closing_the_source_client_ends_its_streams()
    {
        await using var h = await RedisHarness.StartAsync();
        var info = await h.Streams.OpenAsync("redis.subscribe", h.Cid, Params(new { channels = new[] { "x" } }), "ui1", CancellationToken.None);
        await WaitUntil(() => h.Server.Subscriptions >= 1);
        await h.Clients.CloseAsync(h.Cid);
        var ended = await h.Events.WaitAsync<StreamStateEvent>(e => e.StreamId == info.StreamId && e.State is "ended" or "error");
        Assert.Equal("source-closed", ended.Reason);
    }

    private sealed class ListSink : IStreamSink
    {
        public readonly List<JsonElement> Items = [];
        public string StreamId => "st_test";
        public bool Paused => false;

        public bool Push(JsonElement item)
        {
            lock (Items) Items.Add(item);
            return true;
        }
    }
}
