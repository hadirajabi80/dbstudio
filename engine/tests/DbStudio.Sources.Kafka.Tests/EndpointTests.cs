using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka.Tests;

// Every /kafka/{cid}/... endpoint over TestServer + KafkaFake (docs/PLAN-M2.md 9: "every new endpoint validates input and
// has a fake-backed test").
public sealed class EndpointTests : IAsyncLifetime
{
    private EndpointHost _host = null!;
    private string K => $"kafka/{_host.Cid}";

    public async Task InitializeAsync()
    {
        _host = await EndpointHost.StartAsync();
        _host.Fake.AddTopic("orders", 2, replicas: 2);
        for (var i = 0; i < 6; i++) _host.Fake.Append("orders", i % 2, $"k{i}", $$"""{"n":{{i}}}""");
        _host.Fake.AddGroup("billing", "Empty", ("orders", 0, 1));
    }

    public async Task DisposeAsync() => await _host.DisposeAsync();

    private static string Code(JsonElement body) => body.GetProperty("error").GetProperty("code").GetString()!;

    [Fact]
    public async Task Cluster_and_broker_configs()
    {
        var (s, body) = await _host.Get($"{K}/cluster");
        Assert.Equal(200, s);
        Assert.Equal(3, body.GetProperty("brokers").GetArrayLength());
        Assert.Equal(1, body.GetProperty("controller").GetProperty("id").GetInt32());
        Assert.Equal(2, body.GetProperty("partitionCount").GetInt32());
        var (s2, configs) = await _host.Get($"{K}/brokers/1/configs");
        Assert.Equal(200, s2);
        Assert.Contains(configs.EnumerateArray(), c => c.GetProperty("name").GetString() == "log.retention.hours");
    }

    [Fact]
    public async Task Topics_list_detail_create_alter_partitions_purge_delete()
    {
        var (s, list) = await _host.Get($"{K}/topics");
        Assert.Equal(200, s);
        Assert.Equal(6, list[0].GetProperty("messages").GetInt64());

        Assert.Equal(204, (await _host.Post($"{K}/topics", new { name = "events", partitions = 3, replicationFactor = 1, configs = new { } })).Status);
        var (s3, detail) = await _host.Get($"{K}/topics/events");
        Assert.Equal(200, s3);
        Assert.Equal(3, detail.GetProperty("partitions").GetArrayLength());

        Assert.Equal(204, (await _host.Put($"{K}/topics/events/configs", new { set = new Dictionary<string, string> { ["retention.ms"] = "1000" }, delete = Array.Empty<string>() })).Status);
        Assert.Equal("1000", _host.Fake.Topics["events"].Configs["retention.ms"]);
        Assert.Equal(204, (await _host.Post($"{K}/topics/events/partitions", new { count = 4 })).Status);

        var (s4, purge) = await _host.Post($"{K}/topics/orders/purge", new { partitions = (int[]?)null });
        Assert.Equal(200, s4);
        Assert.All(purge.GetProperty("partitions").EnumerateArray(), p => Assert.Equal(3, p.GetProperty("lowOffset").GetInt64()));

        Assert.Equal(204, (await _host.Delete($"{K}/topics/events")).Status);
        Assert.Equal(404, (await _host.Get($"{K}/topics/events")).Status);
    }

    [Fact]
    public async Task Topic_input_validation_names_fields()
    {
        var (s, body) = await _host.Post($"{K}/topics", new { name = "bad name", partitions = 1, replicationFactor = 1 });
        Assert.Equal(400, s);
        Assert.Equal("VALIDATION", Code(body));
        Assert.Equal("name", body.GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
        var (s2, b2) = await _host.Post($"{K}/topics/orders/partitions", new { });
        Assert.Equal(400, s2);
        Assert.Equal("count", b2.GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
    }

    [Fact]
    public async Task Fetch_starts_a_job_whose_messages_arrive_on_the_kafka_fetch_stream()
    {
        var (s, started) = await _host.Post($"{K}/topics/orders/messages", new
        {
            partitions = (int[]?)null, start = new { kind = "oldest" }, limit = 10, keyFormat = "string", valueFormat = "json", timeoutMs = 3000,
        });
        Assert.Equal(202, s);
        var jobId = started.GetProperty("jobId").GetString()!;
        var streamId = started.GetProperty("streamId").GetString()!;
        var done = await _host.Events.WaitFor<JobDoneEvent>(e => e.JobId == jobId);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        Assert.Equal(6, done.Result!.Value.GetProperty("fetched").GetInt32());
        var ended = await _host.Events.WaitFor<StreamStateEvent>(e => e.StreamId == streamId && e.State == "ended");
        Assert.Equal("completed", ended.Reason);
        var items = _host.Events.All.OfType<StreamDataEvent>().Where(e => e.StreamId == streamId).SelectMany(e => e.Items).ToList();
        Assert.Equal(6, items.Count);
        Assert.All(items, i => Assert.Equal("orders", i.GetProperty("topic").GetString()));
        Assert.Contains(items, i => i.GetProperty("value").GetProperty("json").GetProperty("n").GetInt32() == 5);
    }

    [Fact]
    public async Task Fetch_validation_happens_before_the_job()
    {
        var (s, body) = await _host.Post($"{K}/topics/orders/messages", new { start = new { kind = "offset" }, limit = 10 });
        Assert.Equal(400, s);
        Assert.Equal("start.offset", body.GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
        Assert.Equal(404, (await _host.Post($"{K}/topics/ghost/messages", new { start = new { kind = "latest", count = 5 }, limit = 10 })).Status);
        Assert.Empty(_host.Streams.List());
    }

    [Fact]
    public async Task Kafka_fetch_streams_cannot_be_opened_directly()
    {
        var (s, body) = await _host.Post("streams", new { kind = "kafka.fetch", connectionId = _host.Cid, @params = new { token = "nope" } });
        Assert.Equal(400, s);
        Assert.Contains("POST /kafka", body.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Tail_stream_delivers_new_messages()
    {
        var (s, opened) = await _host.Post("streams", new
        {
            kind = "kafka.tail", connectionId = _host.Cid, @params = new { topic = "orders", partitions = (int[]?)null, from = "latest", keyFormat = "string", valueFormat = "string" },
        });
        Assert.Equal(202, s);
        var streamId = opened.GetProperty("streamId").GetString()!;
        await Util.WaitUntil(() => _host.Fake.Readers.Any(r => r.Purpose == "tail"));
        _host.Fake.Append("orders", 1, "k", "live!");
        var data = await _host.Events.WaitFor<StreamDataEvent>(e => e.StreamId == streamId);
        Assert.Equal("live!", data.Items[0].GetProperty("value").GetProperty("text").GetString());
        await _host.Streams.CloseAsync(streamId);
    }

    [Fact]
    public async Task Tail_params_are_validated()
    {
        var (s, body) = await _host.Post("streams", new { kind = "kafka.tail", connectionId = _host.Cid, @params = new { topic = "orders", from = "yesterday" } });
        Assert.Equal(400, s);
        Assert.Equal("params.from", body.GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
        var (s2, b2) = await _host.Post("streams", new { kind = "kafka.tail", connectionId = _host.Cid, @params = new { } });
        Assert.Equal(400, s2);
        Assert.Equal("params.topic", b2.GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
    }

    [Fact]
    public async Task Single_message_and_produce()
    {
        var (s, msg) = await _host.Get($"{K}/topics/orders/messages/1/0?valueFormat=json");
        Assert.Equal(200, s);
        Assert.Equal(1, msg.GetProperty("value").GetProperty("json").GetProperty("n").GetInt32());
        var (s2, produced) = await _host.Post($"{K}/topics/orders/produce", new
        {
            messages = new[] { new { key = "a", value = "{\"x\":1}", headers = new[] { new { key = "h", value = "v" } }, partition = (int?)0 } },
            keyFormat = "string", valueFormat = "json",
        });
        Assert.Equal(200, s2);
        Assert.Equal(3, produced[0].GetProperty("offset").GetInt64());
        Assert.Equal(400, (await _host.Get($"{K}/topics/orders/messages/1/0?valueFormat=yaml")).Status);
    }

    [Fact]
    public async Task Groups_list_detail_reset_and_delete()
    {
        var (s, groups) = await _host.Get($"{K}/groups");
        Assert.Equal(200, s);
        Assert.Equal(2, groups[0].GetProperty("lagTotal").GetInt64());
        var (s2, detail) = await _host.Get($"{K}/groups/billing");
        Assert.Equal(200, s2);
        Assert.Equal("Empty", detail.GetProperty("state").GetString());
        var (s3, rows) = await _host.Post($"{K}/groups/billing/offsets", new { topic = "orders", to = new { kind = "earliest" }, dryRun = true });
        Assert.Equal(200, s3);
        Assert.Equal(2, rows.GetArrayLength());
        Assert.Equal(1, _host.Fake.Groups["billing"].Offsets[new KTopicPartition("orders", 0)]);
        Assert.Equal(200, (await _host.Post($"{K}/groups/billing/offsets", new { topic = "orders", to = new { kind = "earliest" }, dryRun = false })).Status);
        Assert.Equal(0, _host.Fake.Groups["billing"].Offsets[new KTopicPartition("orders", 0)]);
        Assert.Equal(204, (await _host.Delete($"{K}/groups/billing")).Status);
    }

    [Fact]
    public async Task Active_group_reset_is_409_group_active()
    {
        var g = _host.Fake.AddGroup("live", "Stable", ("orders", 0, 0));
        g.Members.Add(new KGroupMember("m1", "c1", "/h", [new KTopicPartition("orders", 0)]));
        var (s, body) = await _host.Post($"{K}/groups/live/offsets", new { to = new { kind = "latest" }, dryRun = false });
        Assert.Equal(409, s);
        Assert.Equal("GROUP_ACTIVE", Code(body));
        Assert.Equal("c1", body.GetProperty("error").GetProperty("detail").GetProperty("members")[0].GetProperty("clientId").GetString());
    }

    [Fact]
    public async Task Group_ids_with_slashes_are_decoded()
    {
        _host.Fake.AddGroup("team/a", "Empty", ("orders", 0, 0));
        Assert.Equal(200, (await _host.Get($"{K}/groups/team%2Fa")).Status);
    }

    [Fact]
    public async Task Read_only_connection_answers_403_read_only_for_writes()
    {
        var ro = $"kafka/{_host.ReadOnlyCid}";
        var writes = new (HttpMethod, string, object?)[]
        {
            (HttpMethod.Post, $"{ro}/topics", new { name = "x", partitions = 1, replicationFactor = 1 }),
            (HttpMethod.Put, $"{ro}/topics/orders/configs", new { set = new Dictionary<string, string> { ["a"] = "b" } }),
            (HttpMethod.Post, $"{ro}/topics/orders/partitions", new { count = 5 }),
            (HttpMethod.Delete, $"{ro}/topics/orders", null),
            (HttpMethod.Post, $"{ro}/topics/orders/purge", new { }),
            (HttpMethod.Post, $"{ro}/topics/orders/produce", new { messages = new[] { new { key = (string?)null, value = "v" } } }),
            (HttpMethod.Post, $"{ro}/groups/billing/offsets", new { topic = "orders", to = new { kind = "latest" }, dryRun = false }),
            (HttpMethod.Delete, $"{ro}/groups/billing", null),
        };
        foreach (var (method, path, body) in writes)
        {
            var (s, b) = await _host.Send(method, path, body);
            Assert.True(s == 403, $"{method} {path} answered {s}");
            Assert.Equal("READ_ONLY", Code(b));
        }
        // Reads and dry runs still work.
        Assert.Equal(200, (await _host.Get($"{ro}/topics")).Status);
        Assert.Equal(200, (await _host.Post($"{ro}/groups/billing/offsets", new { topic = "orders", to = new { kind = "latest" }, dryRun = true })).Status);
    }

    [Fact]
    public async Task Schema_registry_endpoints()
    {
        _host.Registry.Register("orders-value", "AVRO", CodecTests.OrderAvro);
        var (s, subjects) = await _host.Get($"{K}/schemas/subjects");
        Assert.Equal(200, s);
        Assert.Equal("orders-value", subjects[0].GetProperty("subject").GetString());
        Assert.Equal("AVRO", subjects[0].GetProperty("schemaType").GetString());
        var (s2, v) = await _host.Get($"{K}/schemas/subjects/orders-value/versions/latest");
        Assert.Equal(200, s2);
        Assert.Equal(1, v.GetProperty("version").GetInt32());
        Assert.Equal(400, (await _host.Get($"{K}/schemas/subjects/orders-value/versions/zero")).Status);
        Assert.Equal(404, (await _host.Get($"{K}/schemas/subjects/missing/versions/1")).Status);
    }

    [Fact]
    public async Task Unreachable_brokers_answer_503()
    {
        _host.Fake.FailNext["Metadata"] = new KafkaGatewayException(KafkaErrorKind.Unreachable, "Local: Broker transport failure");
        var (s, body) = await _host.Get($"{K}/topics");
        Assert.Equal(503, s);
        Assert.Equal("SOURCE_UNAVAILABLE", Code(body));
    }

    [Fact]
    public async Task Connection_test_reports_the_cluster()
    {
        var (s, body) = await _host.Post("connections/test", new { profile = Harness.Profile("t"), password = (string?)null });
        Assert.Equal(200, s);
        Assert.True(body.GetProperty("ok").GetBoolean());
        Assert.StartsWith("Kafka 3.8 (3 brokers, controller 1)", body.GetProperty("serverInfo").GetProperty("version").GetString());
    }
}
