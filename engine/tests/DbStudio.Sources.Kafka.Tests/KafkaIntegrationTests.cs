using DbStudio.Core.Models;
using DbStudio.Sources.Kafka.Services;
using Testcontainers.Kafka;

namespace DbStudio.Sources.Kafka.Tests;

/// <summary>
/// Real broker (docs/PLAN-M2.md 7.6): <c>DBSTUDIO_KAFKA_BOOTSTRAP</c>, else a Testcontainers <c>apache/kafka:3.8.0</c> (KRaft).
/// Skipped when <c>DBSTUDIO_IT=0</c> or Docker is unavailable.
/// </summary>
public static class KafkaBackend
{
    public const string Image = "apache/kafka:3.8.0";
    private static readonly Lazy<Task<(string? Bootstrap, string? SkipReason)>> s_backend = new(StartAsync);

    public static Task<(string? Bootstrap, string? SkipReason)> GetAsync() => s_backend.Value;

    private static async Task<(string?, string?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0") return (null, "Integration tests disabled (DBSTUDIO_IT=0).");
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_KAFKA_BOOTSTRAP");
        if (!string.IsNullOrWhiteSpace(external)) return (external, null);
        try
        {
            var container = new KafkaBuilder(Image).Build();
            await container.StartAsync().ConfigureAwait(false);
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
            };
            return (container.GetBootstrapAddress().Replace("PLAINTEXT://", "", StringComparison.Ordinal).TrimEnd('/'), null);
        }
        catch (Exception ex)
        {
            return (null, $"Docker/Kafka container unavailable: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public static ConnectionProfile Profile(string bootstrap) => new()
    {
        Id = "c_it_kafka", Name = "Kafka IT", ProviderId = "kafka",
        Props = new() { ["bootstrapServers"] = bootstrap, ["requestTimeoutMs"] = 20000 },
    };
}

public sealed class KafkaIntegrationTests
{
    private static async Task<KafkaClientHandle> OpenAsync()
    {
        var (bootstrap, skip) = await KafkaBackend.GetAsync();
        Skip.If(bootstrap is null, skip);
        return (KafkaClientHandle)await new KafkaProvider().OpenAsync(KafkaBackend.Profile(bootstrap!), null, default);
    }

    [SkippableFact]
    public async Task Produce_browse_tail_and_group_reset_round_trip()
    {
        await using var h = await OpenAsync();
        var topic = $"it-{Guid.NewGuid():N}";
        await new TopicService().CreateAsync(h, new KafkaCreateTopicRequest(topic, 2, 1, null), default);
        await Task.Delay(1000);
        var produced = await new ProduceService().ProduceAsync(h, topic, new KafkaProduceRequest(
            Enumerable.Range(0, 20).Select(i => new KafkaProduceMessage($"k{i}", $$"""{"i":{{i}}}""", [new("h", "v")], i % 2)).ToList(), "string", "json", null, null, null), default);
        Assert.Equal(20, produced.Count);

        var list = new List<KafkaMessageDto>();
        var o = FetchOptions.From(new KafkaFetchRequest(null, new KafkaFetchStart("latest", 5, null, null), 5, "string", "json", null, null, 15000));
        var r = await new MessageBrowser().FetchAsync(h, topic, o, m => { list.Add(m); return true; }, null, default);
        Assert.Equal(5, r.Fetched);

        var ts = produced[10].Timestamp;
        var byTime = new List<KafkaMessageDto>();
        await new MessageBrowser().FetchAsync(h, topic, FetchOptions.From(new KafkaFetchRequest(null, new KafkaFetchStart("timestamp", null, null, ts.ToString("O")), 100, null, "json", null, null, 15000)),
            m => { byTime.Add(m); return true; }, null, default);
        Assert.All(byTime, m => Assert.True(m.Timestamp >= ts.AddMilliseconds(-1)));

        var group = $"it-group-{Guid.NewGuid():N}";
        var rows = await new GroupService().ResetAsync(h, group, new KafkaOffsetResetRequest(null, topic, new KafkaResetTarget("earliest", null), false), default);
        Assert.Equal(2, rows.Count);
        var detail = await new GroupService().DetailAsync(h, group, default);
        Assert.Equal(20, detail.Partitions.Sum(p => p.Lag ?? 0));

        await new TopicService().AlterConfigsAsync(h, topic, new KafkaAlterConfigsRequest(new() { ["retention.ms"] = "3600000" }, null), default);
        var configs = (await new TopicService().DetailAsync(h, topic, default)).Configs;
        Assert.Equal("3600000", configs.Single(c => c.Name == "retention.ms").Value);
        await new TopicService().DeleteAsync(h, topic, default);
    }

    [SkippableFact]
    public async Task Cluster_overview_on_kraft()
    {
        await using var h = await OpenAsync();
        var c = await new ClusterService().ClusterAsync(h, default);
        Assert.NotEmpty(c.Brokers);
        Assert.NotNull(c.ClusterId);
    }
}
