using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

public sealed class SettingsTests
{
    private static ConnectionProfile P(params (string Key, object? Value)[] props)
    {
        var p = new ConnectionProfile { Id = "c1", Name = "k", ProviderId = "kafka" };
        p.Props["bootstrapServers"] = "localhost:9092";
        foreach (var (k, v) in props) p.Props[k] = v is null ? null : JsonValue.Create(v);
        return p;
    }

    private static string FieldOf(EngineException ex) => ex.Detail!.GetType().GetProperty("field")!.GetValue(ex.Detail)!.ToString()!;

    [Theory]
    [InlineData("", "bootstrapServers")]
    [InlineData("localhost", "bootstrapServers")]
    [InlineData("localhost:99999", "bootstrapServers")]
    public void Bootstrap_servers_must_be_host_port(string value, string field)
    {
        var ex = Assert.Throws<EngineException>(() => KafkaSettings.From(P(("bootstrapServers", value)), null));
        Assert.Equal(field, FieldOf(ex));
    }

    [Fact]
    public void Plaintext_defaults()
    {
        var s = KafkaSettings.From(P(), null);
        Assert.Equal("PLAINTEXT", s.SecurityProtocol);
        Assert.Equal("DbStudio", s.ClientId);
        Assert.Equal(15000, s.RequestTimeoutMs);
        Assert.False(s.UsesSasl);
        var c = s.ToClientConfig();
        Assert.Equal("plaintext", c["security.protocol"]);
        Assert.False(c.ContainsKey("sasl.mechanism"));
    }

    [Fact]
    public void Sasl_requires_a_user_and_maps_scram()
    {
        var ex = Assert.Throws<EngineException>(() => KafkaSettings.From(P(("securityProtocol", "SASL_SSL")), null));
        Assert.Equal("user", FieldOf(ex));
        var s = KafkaSettings.From(P(("securityProtocol", "SASL_SSL"), ("saslMechanism", "SCRAM-SHA-512"), ("user", "alice"), ("sslCaLocation", "/ca.pem")), "s3cret");
        var c = s.ToClientConfig();
        Assert.Equal("sasl_ssl", c["security.protocol"]);
        Assert.Equal("SCRAM-SHA-512", c["sasl.mechanism"]);
        Assert.Equal("alice", c["sasl.username"]);
        Assert.Equal("s3cret", c["sasl.password"]);
        Assert.Equal("/ca.pem", c["ssl.ca.location"]);
        Assert.Equal("********", s.Describe()["sasl.password"]);
    }

    [Fact]
    public void Ssl_client_certificate_and_key_password()
    {
        var s = KafkaSettings.From(P(("securityProtocol", "SSL"), ("sslCertLocation", "/c.pem"), ("sslKeyLocation", "/k.pem"), ("sslKeyPassword", "kp")), null);
        var c = s.ToClientConfig();
        Assert.Equal("/c.pem", c["ssl.certificate.location"]);
        Assert.Equal("kp", c["ssl.key.password"]);
        Assert.False(c.ContainsKey("sasl.username"));
    }

    [Theory]
    [InlineData("securityProtocol", "SSH")]
    [InlineData("saslMechanism", "GSSAPI")]
    [InlineData("schemaRegistryUrl", "ftp://x")]
    [InlineData("requestTimeoutMs", 50)]
    public void Invalid_fields_are_named(string field, object value)
    {
        var ex = Assert.Throws<EngineException>(() => KafkaSettings.From(P((field, value)), null));
        Assert.Equal(field, FieldOf(ex));
    }

    [Fact]
    public void Extra_settings_are_parsed_and_secrets_refused()
    {
        var extra = KafkaSettings.ParseExtra("linger.ms=5; compression.type = lz4\nsocket.keepalive.enable=true");
        Assert.Equal("lz4", extra["compression.type"]);
        Assert.Equal(3, extra.Count);
        Assert.Throws<EngineException>(() => KafkaSettings.ParseExtra("broken"));
        Assert.Throws<EngineException>(() => KafkaSettings.ParseExtra("sasl.password=x"));
        var s = KafkaSettings.From(P(("extra", "linger.ms=7")), null);
        Assert.Equal("7", s.ToClientConfig()["linger.ms"]);
    }
}

public sealed class TopicAndClusterTests
{
    [Fact]
    public async Task Cluster_overview_counts_brokers_controller_and_health()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 3, replicas: 3);
        var degraded = h.Fake.AddTopic("payments", 2, replicas: 2);
        degraded.Partitions[0].Isr = [1];
        degraded.Partitions[1].Leader = -1;
        var c = await new ClusterService().ClusterAsync(h.Handle, default);
        Assert.Equal("fake-cluster-1", c.ClusterId);
        Assert.Equal(1, c.Controller!.Id);
        Assert.Equal(3, c.Brokers.Count);
        Assert.True(c.Brokers.Single(b => b.Id == 1).IsController);
        Assert.Equal(2, c.TopicCount);
        Assert.Equal(5, c.PartitionCount);
        Assert.Equal(1, c.UnderReplicated);
        Assert.Equal(1, c.OfflinePartitions);
        Assert.Equal("3.8", c.Version);
    }

    [Fact]
    public async Task Broker_configs_mask_sensitive_values()
    {
        await using var h = new Harness();
        var configs = await new ClusterService().BrokerConfigsAsync(h.Handle, 1, default);
        Assert.Contains(configs, c => c.Name == "log.retention.hours" && c.Value == "168");
        var secret = configs.Single(c => c.Name == "ssl.keystore.password");
        Assert.True(secret.IsSensitive);
        Assert.Null(secret.Value);
    }

    [Fact]
    public async Task Topic_list_hides_internal_topics_and_estimates_messages()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        h.Fake.AddTopic("__consumer_offsets", 1);
        for (var i = 0; i < 5; i++) h.Fake.Append("orders", i % 2, $"k{i}", $"v{i}");
        var svc = new TopicService();
        var visible = await svc.ListAsync(h.Handle, false, default);
        var t = Assert.Single(visible);
        Assert.Equal(5, t.Messages);
        Assert.Equal(2, t.Partitions);
        Assert.Equal(2, (await svc.ListAsync(h.Handle, true, default)).Count);
    }

    [Fact]
    public async Task Topic_list_survives_a_watermark_failure()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        h.Fake.FailNext["Watermarks"] = new KafkaGatewayException(KafkaErrorKind.Timeout, "Local: Timed out");
        var t = Assert.Single(await new TopicService().ListAsync(h.Handle, false, default));
        Assert.Null(t.Messages);
    }

    [Fact]
    public async Task Topic_detail_has_partitions_watermarks_and_configs()
    {
        await using var h = new Harness();
        var topic = h.Fake.AddTopic("orders", 2, replicas: 2);
        topic.Configs["retention.ms"] = "3600000";
        h.Fake.Append("orders", 1, "a", "1");
        h.Fake.Append("orders", 1, "b", "2");
        var d = await new TopicService().DetailAsync(h.Handle, "orders", default);
        Assert.Equal(2, d.Partitions.Count);
        Assert.Equal(2, d.Partitions[1].HighOffset);
        Assert.Equal(2, d.Partitions[1].Messages);
        Assert.Equal([2, 3], d.Partitions[1].Replicas);
        var retention = d.Configs.Single(c => c.Name == "retention.ms");
        Assert.False(retention.IsDefault);
        Assert.Equal("dynamic_topic_config", retention.Source);
        Assert.True(d.Configs.Single(c => c.Name == "cleanup.policy").IsDefault);
    }

    [Fact]
    public async Task Unknown_topic_is_404()
    {
        await using var h = new Harness();
        var ex = await Assert.ThrowsAsync<EngineException>(() => new TopicService().DetailAsync(h.Handle, "nope", default));
        Assert.Equal(404, ex.Status);
    }

    [Theory]
    [InlineData("")]
    [InlineData("..")]
    [InlineData("has space")]
    [InlineData("slash/name")]
    public void Topic_names_are_validated(string name)
    {
        var ex = Assert.Throws<EngineException>(() => TopicService.ValidateName(name));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }

    [Fact]
    public async Task Create_topic_validates_and_creates()
    {
        await using var h = new Harness();
        var svc = new TopicService();
        await svc.CreateAsync(h.Handle, new KafkaCreateTopicRequest("events", 3, 2, new() { ["cleanup.policy"] = "compact" }), default);
        Assert.Equal(3, h.Fake.Topics["events"].Partitions.Count);
        Assert.Equal("compact", h.Fake.Topics["events"].Configs["cleanup.policy"]);
        var dup = await Assert.ThrowsAsync<EngineException>(() => svc.CreateAsync(h.Handle, new KafkaCreateTopicRequest("events", 1, 1, null), default));
        Assert.Equal(409, dup.Status);
        var rf = await Assert.ThrowsAsync<EngineException>(() => svc.CreateAsync(h.Handle, new KafkaCreateTopicRequest("big", 1, 5, null), default));
        Assert.Equal(ErrorCodes.Validation, rf.Code);
        await Assert.ThrowsAsync<EngineException>(() => svc.CreateAsync(h.Handle, new KafkaCreateTopicRequest("zero", 0, 1, null), default));
    }

    [Fact]
    public async Task Alter_configs_sets_and_deletes()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders").Configs["retention.ms"] = "1";
        var svc = new TopicService();
        await svc.AlterConfigsAsync(h.Handle, "orders", new KafkaAlterConfigsRequest(new() { ["max.message.bytes"] = "2048" }, ["retention.ms"]), default);
        Assert.Equal("2048", h.Fake.Topics["orders"].Configs["max.message.bytes"]);
        Assert.False(h.Fake.Topics["orders"].Configs.ContainsKey("retention.ms"));
        await Assert.ThrowsAsync<EngineException>(() => svc.AlterConfigsAsync(h.Handle, "orders", new KafkaAlterConfigsRequest(null, null), default));
        var both = await Assert.ThrowsAsync<EngineException>(() =>
            svc.AlterConfigsAsync(h.Handle, "orders", new KafkaAlterConfigsRequest(new() { ["a"] = "1" }, ["a"]), default));
        Assert.Contains("both", both.Message);
        var bogus = await Assert.ThrowsAsync<EngineException>(() =>
            svc.AlterConfigsAsync(h.Handle, "orders", new KafkaAlterConfigsRequest(new() { ["bogus.config"] = "1" }, null), default));
        Assert.Equal(400, bogus.Status);
    }

    [Fact]
    public async Task Add_partitions_only_grows()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        var svc = new TopicService();
        await Assert.ThrowsAsync<EngineException>(() => svc.AddPartitionsAsync(h.Handle, "orders", new KafkaAddPartitionsRequest(2), default));
        await svc.AddPartitionsAsync(h.Handle, "orders", new KafkaAddPartitionsRequest(5), default);
        Assert.Equal(5, h.Fake.Topics["orders"].Partitions.Count);
    }

    [Fact]
    public async Task Purge_deletes_records_up_to_the_high_watermark()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        for (var i = 0; i < 6; i++) h.Fake.Append("orders", i % 2, null, $"v{i}");
        var r = await new TopicService().PurgeAsync(h.Handle, "orders", new KafkaPurgeRequest([1]), default);
        Assert.Equal(3, Assert.Single(r.Partitions).LowOffset);
        Assert.Empty(h.Fake.Topics["orders"].Partitions[1].Log);
        Assert.Equal(3, h.Fake.Topics["orders"].Partitions[0].Log.Count);
        var bad = await Assert.ThrowsAsync<EngineException>(() => new TopicService().PurgeAsync(h.Handle, "orders", new KafkaPurgeRequest([7]), default));
        Assert.Contains("no partition 7", bad.Message);
    }

    [Fact]
    public async Task Delete_topic()
    {
        await using var h = new Harness();
        h.Fake.AddTopic("orders");
        await new TopicService().DeleteAsync(h.Handle, "orders", default);
        Assert.False(h.Fake.Topics.ContainsKey("orders"));
    }

    [Fact]
    public async Task Read_only_connections_refuse_every_topic_write()
    {
        await using var h = new Harness(readOnly: true);
        h.Fake.AddTopic("orders", 1);
        var svc = new TopicService();
        var calls = new Func<Task>[]
        {
            () => svc.CreateAsync(h.Handle, new KafkaCreateTopicRequest("x", 1, 1, null), default),
            () => svc.AlterConfigsAsync(h.Handle, "orders", new KafkaAlterConfigsRequest(new() { ["a"] = "b" }, null), default),
            () => svc.AddPartitionsAsync(h.Handle, "orders", new KafkaAddPartitionsRequest(3), default),
            () => svc.DeleteAsync(h.Handle, "orders", default),
            () => svc.PurgeAsync(h.Handle, "orders", null, default),
        };
        foreach (var call in calls)
        {
            var ex = await Assert.ThrowsAsync<EngineException>(call);
            Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
            Assert.Contains("read-only", ex.Message);
        }
        Assert.DoesNotContain(h.Fake.Calls, c => c is "CreateTopic" or "AlterConfigs" or "CreatePartitions" or "DeleteTopic" or "DeleteRecords");
    }

    [Theory]
    [InlineData(KafkaErrorKind.Unreachable, 503, ErrorCodes.SourceUnavailable)]
    [InlineData(KafkaErrorKind.Timeout, 503, ErrorCodes.SourceUnavailable)]
    [InlineData(KafkaErrorKind.Authorization, 403, ErrorCodes.Privilege)]
    [InlineData(KafkaErrorKind.GroupNotEmpty, 409, ErrorCodes.GroupActive)]
    [InlineData(KafkaErrorKind.UnknownGroup, 404, ErrorCodes.NotFound)]
    [InlineData(KafkaErrorKind.PolicyViolation, 400, ErrorCodes.Validation)]
    [InlineData(KafkaErrorKind.Unknown, 422, ErrorCodes.ProviderError)]
    public void Gateway_errors_map_to_rest_codes(KafkaErrorKind kind, int status, string code)
    {
        var ex = KafkaErrors.ToEngine(new KafkaGatewayException(kind, "boom"), "x");
        Assert.Equal(status, ex.Status);
        Assert.Equal(code, ex.Code);
    }
}
