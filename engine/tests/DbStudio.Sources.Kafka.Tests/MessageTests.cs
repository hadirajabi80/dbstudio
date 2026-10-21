using System.Collections.Concurrent;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

public sealed class BrowserTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 18, 14, 0, 0, TimeSpan.Zero);

    /// <summary>orders: 3 partitions × 10 messages, timestamps T0 + (p*10 + i) seconds interleaved.</summary>
    private static Harness Seeded()
    {
        var h = new Harness();
        h.Fake.AddTopic("orders", 3);
        for (var i = 0; i < 10; i++)
            for (var p = 0; p < 3; p++)
                h.Fake.Append("orders", p, $"cust-{p}", $$"""{"id":{{p * 100 + i}},"note":"{{(i % 3 == 0 ? "Rush" : "normal")}}"}""", T0.AddSeconds(i * 3 + p), ("traceparent", $"00-{p}{i}"));
        return h;
    }

    private static FetchOptions O(string kind = "latest", int limit = 200, int? count = null, long? offset = null, string? iso = null,
        List<int>? partitions = null, string? search = null, bool caseSensitive = false, long? maxBytes = null, int? timeoutMs = 3000) =>
        FetchOptions.From(new KafkaFetchRequest(partitions, new KafkaFetchStart(kind, count, offset, iso), limit, "string", "json",
            search is null ? null : new KafkaSearch(search, caseSensitive), maxBytes, timeoutMs));

    private static async Task<(KafkaFetchResult Result, List<KafkaMessageDto> Messages)> Fetch(Harness h, FetchOptions o)
    {
        var list = new List<KafkaMessageDto>();
        var r = await new MessageBrowser().FetchAsync(h.Handle, "orders", o, m => { list.Add(m); return true; }, null, default);
        return (r, list);
    }

    [Fact]
    public async Task Latest_N_keeps_the_newest_across_partitions()
    {
        await using var h = Seeded();
        var (r, msgs) = await Fetch(h, O(limit: 5));
        Assert.Equal(5, r.Fetched);
        Assert.Equal(5, msgs.Count);
        // newest timestamps: i=9 for p=2,1,0 then i=8 for p=2,1
        Assert.Equal([2, 1, 0, 2, 1], msgs.Select(m => m.Partition));
        Assert.All(msgs, m => Assert.True(m.Offset >= 8));
        Assert.Equal([0, 1, 2], r.PartitionsDone);
    }

    [Fact]
    public async Task Latest_offset_math_is_per_partition_high_minus_count()
    {
        await using var h = Seeded();
        h.Fake.AddTopic("small", 2);
        h.Fake.Append("small", 0, null, "only");
        var ranges = await MessageBrowser.PlanAsync(h.Handle, "orders", O(count: 4), default);
        Assert.All(ranges, r => Assert.Equal((6L, 10L), (r.Start, r.End)));
        var small = await MessageBrowser.PlanAsync(h.Handle, "small", O(count: 4), default);
        Assert.Equal((0L, 1L), (small[0].Start, small[0].End));
        Assert.Equal((0L, 0L), (small[1].Start, small[1].End));
    }

    [Fact]
    public async Task Oldest_starts_at_the_low_watermark_and_honours_the_limit()
    {
        await using var h = Seeded();
        await h.Fake.DeleteRecordsAsync("orders", new Dictionary<int, long> { [0] = 4 }, default);
        var (r, msgs) = await Fetch(h, O("oldest", limit: 7));
        Assert.Equal(7, msgs.Count);
        Assert.True(r.Truncated);
        Assert.DoesNotContain(msgs, m => m.Partition == 0 && m.Offset < 4);
    }

    [Fact]
    public async Task Offset_start_is_clamped_to_the_partition()
    {
        await using var h = Seeded();
        var (_, msgs) = await Fetch(h, O("offset", offset: 8, partitions: [1]));
        Assert.Equal([8L, 9L], msgs.Select(m => m.Offset));
        var (_, beyond) = await Fetch(h, O("offset", offset: 500, partitions: [1]));
        Assert.Empty(beyond);
    }

    [Fact]
    public async Task Timestamp_start_uses_offsets_for_times()
    {
        await using var h = Seeded();
        // T0 + 25 s: partition 0 first record at i=9 (27 s), p1 at i=8 (25 s), p2 at i=8 (26 s)
        var (r, msgs) = await Fetch(h, O("timestamp", iso: T0.AddSeconds(25).ToString("O")));
        Assert.Equal(5, r.Fetched);
        Assert.All(msgs, m => Assert.True(m.Timestamp >= T0.AddSeconds(25)));
        Assert.Contains(h.Fake.Calls, c => c == "OffsetsForTimes");
    }

    [Fact]
    public async Task Timestamp_after_the_last_record_returns_nothing()
    {
        await using var h = Seeded();
        var (r, msgs) = await Fetch(h, O("timestamp", iso: T0.AddDays(1).ToString("O")));
        Assert.Empty(msgs);
        Assert.Equal(0, r.Scanned);
    }

    [Fact]
    public async Task Search_filters_on_the_value_text()
    {
        await using var h = Seeded();
        var (r, msgs) = await Fetch(h, O("oldest", search: "rush"));
        Assert.Equal(12, msgs.Count); // i = 0,3,6,9 × 3 partitions
        Assert.Equal(30, r.Scanned);
        var (_, exact) = await Fetch(h, O("oldest", search: "rush", caseSensitive: true));
        Assert.Empty(exact);
    }

    [Fact]
    public async Task Max_bytes_stops_the_fetch()
    {
        await using var h = Seeded();
        h.Fake.AddTopic("blobs");
        for (var i = 0; i < 20; i++) h.Fake.Append("blobs", 0, null, new string('x', 1000));
        var list = new List<KafkaMessageDto>();
        var r = await new MessageBrowser().FetchAsync(h.Handle, "blobs", O("oldest", maxBytes: 4096), m => { list.Add(m); return true; }, null, default);
        Assert.True(r.Truncated);
        Assert.InRange(list.Count, 4, 5);
    }

    [Fact]
    public async Task Messages_carry_key_value_headers_and_size()
    {
        await using var h = Seeded();
        var (_, msgs) = await Fetch(h, O("offset", offset: 0, partitions: [2], limit: 1));
        var m = Assert.Single(msgs);
        Assert.Equal("cust-2", m.Key.Text);
        Assert.Equal(200, m.Value.Json!.Value.GetProperty("id").GetInt32());
        Assert.Equal("traceparent", m.Headers[0].Key);
        Assert.Equal("00-20", m.Headers[0].Value.Text);
        Assert.Equal("create", m.TimestampType);
        Assert.True(m.Size > 20);
    }

    [Fact]
    public async Task Readers_never_leak()
    {
        await using var h = Seeded();
        await Fetch(h, O());
        Assert.All(h.Fake.Readers, r => Assert.True(r.Disposed));
        Assert.Equal("browse", h.Fake.Readers[0].Purpose);
    }

    [Fact]
    public async Task Stopping_the_push_ends_the_fetch()
    {
        await using var h = Seeded();
        var n = 0;
        var r = await new MessageBrowser().FetchAsync(h.Handle, "orders", O("oldest"), _ => ++n < 3, null, default);
        Assert.Equal(3, r.Fetched);
    }

    [Theory]
    [InlineData("sideways", "start.kind")]
    [InlineData("offset", "start.offset")]
    [InlineData("timestamp", "start.iso")]
    public void Fetch_request_validation_names_the_field(string kind, string field)
    {
        var ex = Assert.Throws<EngineException>(() => FetchOptions.From(new KafkaFetchRequest(null, new KafkaFetchStart(kind, null, null, null), 10, null, null, null, null, null)));
        Assert.Contains(field, JsonSerializer.Serialize(ex.Detail));
    }

    [Fact]
    public void Fetch_limits_are_validated()
    {
        Assert.Throws<EngineException>(() => FetchOptions.From(new KafkaFetchRequest(null, null, 0, null, null, null, null, null)));
        Assert.Throws<EngineException>(() => FetchOptions.From(new KafkaFetchRequest(null, null, 10, null, null, null, 10, null)));
        Assert.Throws<EngineException>(() => FetchOptions.From(new KafkaFetchRequest([-1], null, 10, null, null, null, null, null)));
        var o = FetchOptions.From(new KafkaFetchRequest(null, null, null, null, null, null, null, null));
        Assert.Equal(("latest", 200, 200), (o.StartKind, o.Limit, o.Count));
        Assert.Equal(FetchOptions.DefaultMaxBytes, o.MaxBytes);
    }

    [Fact]
    public async Task Unknown_partition_is_a_validation_error()
    {
        await using var h = Seeded();
        var ex = await Assert.ThrowsAsync<EngineException>(() => Fetch(h, O(partitions: [9])));
        Assert.Contains("partitions", JsonSerializer.Serialize(ex.Detail));
    }

    [Fact]
    public async Task Single_message_is_returned_untruncated()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("big");
        var text = new string('z', 50_000);
        h.Fake.Append("big", 0, "k", text);
        var m = await new MessageBrowser().GetAsync(h.Handle, "big", 0, 0, "string", "string", default);
        Assert.Equal(text, m.Value.Text);
        var ex = await Assert.ThrowsAsync<EngineException>(() => new MessageBrowser().GetAsync(h.Handle, "big", 0, 5, "string", "string", default));
        Assert.Equal(404, ex.Status);
    }
}

public sealed class TailTests
{
    private sealed class Sink : IStreamSink
    {
        public readonly ConcurrentQueue<JsonElement> Items = new();
        public string StreamId => "st_test";
        public bool Paused => false;
        public bool Push(JsonElement item)
        {
            Items.Enqueue(item);
            return true;
        }
    }

    [Fact]
    public async Task Tail_starts_at_latest_and_streams_new_messages()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        h.Fake.Append("orders", 0, null, "old");
        var stream = new TailStream(h.Handle, [(new KTopicPartition("orders", 0), 1), (new KTopicPartition("orders", 1), 0)], "string", "string", null);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = stream.RunAsync(sink, cts.Token);
        h.Fake.Append("orders", 1, "k", "new-1");
        h.Fake.Append("orders", 0, "k", "new-0");
        await Util.WaitUntil(() => sink.Items.Count == 2);
        Assert.DoesNotContain(sink.Items, i => i.GetProperty("value").GetProperty("text").GetString() == "old");
        await cts.CancelAsync();
        await run;
        Assert.True(h.Fake.Readers.Single().Disposed);
    }

    [Fact]
    public async Task Pause_pauses_the_consumer_and_resume_delivers_the_backlog()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        var stream = new TailStream(h.Handle, [(new KTopicPartition("orders", 0), 0)], "string", "string", null);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = stream.RunAsync(sink, cts.Token);
        await Util.WaitUntil(() => h.Fake.Readers.Count == 1);
        stream.SetPaused(true);
        await Util.WaitUntil(() => h.Fake.Readers[0].Paused);
        h.Fake.Append("orders", 0, null, "while-paused");
        await Task.Delay(150);
        Assert.Empty(sink.Items);
        stream.SetPaused(false);
        await Util.WaitUntil(() => sink.Items.Count == 1);
        await cts.CancelAsync();
        await run;
    }

    [Fact]
    public async Task Filter_matches_value_or_key()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        var stream = new TailStream(h.Handle, [(new KTopicPartition("orders", 0), 0)], "string", "string", "VIP");
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = stream.RunAsync(sink, cts.Token);
        h.Fake.Append("orders", 0, "a", "plain");
        h.Fake.Append("orders", 0, "vip-1", "x");
        h.Fake.Append("orders", 0, "b", "is vip");
        await Util.WaitUntil(() => sink.Items.Count == 2);
        await Task.Delay(100);
        Assert.Equal(2, sink.Items.Count);
        await cts.CancelAsync();
        await run;
    }
}

public sealed class ProduceTests
{
    [Fact]
    public async Task Produces_strings_with_headers_and_explicit_partition()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 3);
        var res = await new ProduceService().ProduceAsync(h.Handle, "orders", new KafkaProduceRequest(
            [new("k1", "v1", [new("trace", "abc")], 2), new(null, null, null, 0)], "string", "string", null, null, "lz4"), default);
        Assert.Equal(2, res.Count);
        Assert.Equal(2, res[0].Partition);
        var rec = h.Fake.Topics["orders"].Partitions[2].Log.Single();
        Assert.Equal("trace", rec.Headers[0].Key);
        Assert.Null(h.Fake.Topics["orders"].Partitions[0].Log.Single().Value); // tombstone
        Assert.Equal("lz4", h.Fake.LastCompression);
    }

    [Fact]
    public async Task Json_values_are_validated()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new ProduceService().ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "{bad", null, null)], "string", "json", null, null, null), default));
        Assert.Contains("messages[0].value", ex.Message);
        Assert.DoesNotContain("Produce", h.Fake.Calls);
    }

    [Fact]
    public async Task Avro_produce_uses_the_registry_subject_and_round_trips()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        var e = h.Registry.Register("orders-value", "AVRO", CodecTests.OrderAvro);
        var value = """{"id":7,"customer":"c","total":1.5,"status":"NEW","tags":[],"attrs":{},"created":"2026-01-01T00:00:00Z"}""";
        await new ProduceService().ProduceAsync(h.Handle, "orders", new KafkaProduceRequest([new("k", value, null, null)], "string", "avro",
            new KafkaSchemaRef("orders-value", Util.Json("\"latest\"")), null, null), default);
        var rec = h.Fake.Topics["orders"].Partitions[0].Log.Single();
        Assert.Equal(0, rec.Value![0]);
        var decoded = await h.Handle.Codec.DecodeAsync(rec.Value, "auto", false, default);
        Assert.Equal(e.Id, decoded.SchemaId);
        Assert.Equal(7, decoded.Json!.Value.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Protobuf_produce_round_trips()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        h.Registry.Register("orders-proto", "PROTOBUF", CodecTests.OrderProto);
        await new ProduceService().ProduceAsync(h.Handle, "orders", new KafkaProduceRequest([new(null, """{"id":5,"status":"PAID"}""", null, null)], "string",
            "protobuf", new KafkaSchemaRef("orders-proto", Util.Json("1")), null, null), default);
        var decoded = await h.Handle.Codec.DecodeAsync(h.Fake.Topics["orders"].Partitions[0].Log.Single().Value, "protobuf", false, default);
        Assert.Null(decoded.Error);
        Assert.Equal("PAID", decoded.Json!.Value.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Schema_formats_need_a_subject_of_the_right_type()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        h.Registry.Register("orders-value", "AVRO", CodecTests.OrderAvro);
        var svc = new ProduceService();
        var missing = await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "{}", null, null)], "string", "avro", null, null, null), default));
        Assert.Contains("schema.subject", missing.Message);
        var wrong = await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "{}", null, null)], "string", "protobuf", new KafkaSchemaRef("orders-value", null), null, null), default));
        Assert.Contains("AVRO", wrong.Message);
        var mismatch = await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, """{"id":"x"}""", null, null)], "string", "avro", new KafkaSchemaRef("orders-value", null), null, null), default));
        Assert.Contains("does not match schema", mismatch.Message);
    }

    [Fact]
    public async Task Produce_limits_and_partition_checks()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        var svc = new ProduceService();
        await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders", new KafkaProduceRequest([], null, null, null, null, null), default));
        var many = Enumerable.Range(0, 1001).Select(i => new KafkaProduceMessage(null, $"{i}", null, null)).ToList();
        await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders", new KafkaProduceRequest(many, null, null, null, null, null), default));
        var part = await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "x", null, 5)], null, null, null, null, null), default));
        Assert.Contains("partition 5", part.Message);
        await Assert.ThrowsAsync<EngineException>(() => svc.ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "x", null, null)], null, null, null, null, "brotli"), default));
    }

    [Fact]
    public async Task Read_only_refuses_produce()
    {
        await using var h = new Harness(readOnly: true);
        h.Fake.AddTopic("orders");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new ProduceService().ProduceAsync(h.Handle, "orders",
            new KafkaProduceRequest([new(null, "x", null, null)], null, null, null, null, null), default));
        Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
        Assert.Contains("producing to topic 'orders'", ex.Message);
    }
}
