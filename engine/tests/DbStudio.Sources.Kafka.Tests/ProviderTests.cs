using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

public sealed class ProviderTests
{
    private static KafkaProvider Provider(KafkaFake fake, FakeSchemaRegistry? sr = null) =>
        new((_, _) => fake, s => sr is null || !s.HasSchemaRegistry ? null : new HttpSchemaRegistry(s.SchemaRegistryUrl!, s.SchemaRegistryUser, s.SchemaRegistrySecret, sr));

    [Fact]
    public async Task Test_reports_version_brokers_controller_and_registry_status()
    {
        var fake = new KafkaFake();
        var sr = new FakeSchemaRegistry();
        var r = await Provider(fake, sr).TestAsync(Harness.Profile(), null, default);
        Assert.True(r.Ok);
        Assert.Equal("Kafka 3.8 (3 brokers, controller 1); Schema Registry ok", r.ServerInfo!.Version);
        Assert.Equal("3.8", r.ServerInfo.ProductVersion);
        Assert.Equal("broker1:9092", r.ServerInfo.ServerName);
        Assert.True(fake.Disposed);
    }

    [Fact]
    public async Task Registry_failure_is_a_warning_not_a_failure()
    {
        var sr = new FakeSchemaRegistry { Down = true };
        var r = await Provider(new KafkaFake(), sr).TestAsync(Harness.Profile(), null, default);
        Assert.True(r.Ok);
        Assert.Contains("warning: Schema Registry is unreachable", r.ServerInfo!.Version);
    }

    [Fact]
    public async Task Unreachable_brokers_fail_with_the_librdkafka_detail()
    {
        var fake = new KafkaFake();
        fake.FailNext["DescribeCluster"] = new KafkaGatewayException(KafkaErrorKind.Timeout, "Failed while waiting for controller: Local: Timed out");
        var r = await Provider(fake).TestAsync(Harness.Profile(withRegistry: false), null, default);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.ProviderError, r.Error!.Code);
        Assert.StartsWith("Cannot reach the Kafka brokers", r.Error.Message);
        Assert.Equal("librdkafka fake", r.Error.Detail);
    }

    [Fact]
    public async Task Invalid_profile_fails_the_test_with_validation()
    {
        var p = Harness.Profile();
        p.Props["bootstrapServers"] = "nope";
        var r = await Provider(new KafkaFake()).TestAsync(p, null, default);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.Validation, r.Error!.Code);
    }

    [Fact]
    public async Task Describe_falls_back_to_metadata_when_describe_cluster_is_denied()
    {
        var fake = new KafkaFake();
        fake.FailNext["DescribeCluster"] = new KafkaGatewayException(KafkaErrorKind.Authorization, "denied");
        var r = await Provider(fake).TestAsync(Harness.Profile(withRegistry: false), null, default);
        Assert.True(r.Ok);
        Assert.Equal("Kafka 3.8 (3 brokers)", r.ServerInfo!.Version);
    }

    [Fact]
    public async Task Open_returns_a_kafka_client_handle_and_maps_failures_to_503()
    {
        var fake = new KafkaFake();
        await using var client = (KafkaClientHandle)await Provider(fake, new FakeSchemaRegistry()).OpenAsync(Harness.Profile(), null, default);
        Assert.Same(fake, client.Gateway);
        Assert.True(client.Schemas.Available);
        Assert.True(await client.PingAsync(default));

        var broken = new KafkaFake();
        broken.FailNext["DescribeCluster"] = new KafkaGatewayException(KafkaErrorKind.Unreachable, "Local: Broker transport failure");
        var ex = await Assert.ThrowsAsync<EngineException>(() => Provider(broken).OpenAsync(Harness.Profile(), null, default));
        Assert.Equal(503, ex.Status);
        Assert.True(broken.Disposed);
    }

    [Fact]
    public void Form_spec_has_the_secret_fields_as_passwords()
    {
        var spec = new KafkaProvider().FormSpec;
        Assert.Equal(["password", "sslKeyPassword", "schemaRegistrySecret"], spec.Fields.Where(f => f.Type == "password").Select(f => f.Key));
        Assert.Equal("bootstrapServers", spec.Fields[0].Key);
        Assert.True(spec.Fields[0].Required);
    }

    [Fact]
    public void Log_buffer_is_bounded_and_maps_levels()
    {
        var log = new KafkaLogBuffer(3);
        for (var i = 0; i < 5; i++) log.Add(KafkaLogBuffer.MapLevel(i % 2 == 0 ? 3 : 7), "FAC", "c", $"m{i}");
        Assert.Equal(3, log.Snapshot().Count);
        Assert.Equal(2, log.Evicted);
        Assert.Equal("m4", log.LastError()!.Message);
        Assert.Equal("warn", KafkaLogBuffer.MapLevel(4));
        Assert.Equal("info", KafkaLogBuffer.MapLevel(6));
    }

    [Fact]
    public void Real_gateway_loads_librdkafka()
    {
        // Proves the native library resolves in the test host (runtimes/<rid>/native); the published engine is covered by
        // scripts/ci/kafka-native-smoke.mjs.
        Assert.Matches(@"^\d+\.\d+\.\d+", ConfluentKafkaGateway.NativeVersion);
    }

    [Fact]
    public async Task Real_gateway_reports_an_unreachable_broker()
    {
        var p = Harness.Profile(withRegistry: false);
        p.Props["bootstrapServers"] = "127.0.0.1:1";
        p.Props["requestTimeoutMs"] = 2000;
        var r = await new KafkaProvider().TestAsync(p, null, default);
        Assert.False(r.Ok);
        Assert.StartsWith("librdkafka ", r.Error!.Detail);
        Assert.Contains("Cannot reach the Kafka brokers", r.Error.Message);
    }
}
