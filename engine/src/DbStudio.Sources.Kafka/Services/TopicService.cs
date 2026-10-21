using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka.Services;

/// <summary>Cluster overview and broker configs (docs/PLAN-M2.md 7.2).</summary>
public sealed class ClusterService
{
    public async Task<KafkaClusterDto> ClusterAsync(KafkaClientHandle h, CancellationToken ct)
    {
        var gw = h.Gateway;
        KClusterInfo? cluster = null;
        try { cluster = await gw.DescribeClusterAsync(ct).ConfigureAwait(false); }
        catch (KafkaGatewayException ex) when (ex.Kind is KafkaErrorKind.Unknown or KafkaErrorKind.Authorization) { /* metadata only */ }
        var md = await KafkaErrors.Call(() => gw.MetadataAsync(null, ct)).ConfigureAwait(false);
        var nodes = cluster?.Nodes is { Count: > 0 } n ? n : md.Brokers;
        var controllerId = cluster?.ControllerId;
        var brokers = nodes.OrderBy(b => b.Id).Select(b => new KafkaBrokerDto(b.Id, b.Host, b.Port, b.Rack, b.Id == controllerId, true)).ToList();
        var partitions = md.Topics.SelectMany(t => t.Partitions).ToList();
        var controller = nodes.FirstOrDefault(b => b.Id == controllerId) is { } c ? new KafkaNodeRef(c.Id, $"{c.Host}:{c.Port}") : null;
        return new KafkaClusterDto(cluster?.ClusterId, controller, brokers, md.Topics.Count, partitions.Count,
            partitions.Count(p => p.Isr.Count < p.Replicas.Count), partitions.Count(p => p.Leader < 0), h.Server.ProductVersion);
    }

    public async Task<IReadOnlyList<KafkaConfigEntryDto>> BrokerConfigsAsync(KafkaClientHandle h, int brokerId, CancellationToken ct)
    {
        if (brokerId < 0) throw EngineException.Validation("brokerId must be ≥ 0.", new { field = "brokerId" });
        var entries = await KafkaErrors.Call(() => h.Gateway.DescribeConfigsAsync(KConfigResource.Broker, brokerId.ToString(CultureInfo.InvariantCulture), ct))
            .ConfigureAwait(false);
        return entries.Select(KafkaConfigEntryDto.From).ToList();
    }
}

/// <summary>Topics: list, detail (partitions, watermarks, configs), create, configs, partitions, delete, purge (7.3).</summary>
public sealed partial class TopicService
{
    /// <summary>Budget for the lazy message estimates of the topic list.</summary>
    public static readonly TimeSpan EstimateBudget = TimeSpan.FromSeconds(5);

    [GeneratedRegex("^[A-Za-z0-9._-]{1,249}$")]
    private static partial Regex TopicName();

    public static string ValidateName(string? name, string field = "name")
    {
        var n = name?.Trim();
        if (string.IsNullOrEmpty(n)) throw EngineException.Validation("A topic name is required.", new { field });
        if (n is "." or ".." || !TopicName().IsMatch(n))
            throw EngineException.Validation("Topic names use letters, digits, '.', '_' and '-' (at most 249 characters).", new { field });
        return n;
    }

    public async Task<IReadOnlyList<KafkaTopicSummaryDto>> ListAsync(KafkaClientHandle h, bool includeInternal, CancellationToken ct)
    {
        var md = await KafkaErrors.Call(() => h.Gateway.MetadataAsync(null, ct)).ConfigureAwait(false);
        var topics = md.Topics.Where(t => includeInternal || !t.Internal).OrderBy(t => t.Name, StringComparer.Ordinal).ToList();
        IReadOnlyDictionary<KTopicPartition, KWatermarks>? marks = null;
        try
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(EstimateBudget);
            var tps = topics.SelectMany(t => t.Partitions.Select(p => new KTopicPartition(t.Name, p.Id))).ToList();
            marks = await h.Gateway.WatermarksAsync(tps, budget.Token).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is KafkaGatewayException or OperationCanceledException && !ct.IsCancellationRequested) { /* estimates stay null */ }

        return topics.Select(t =>
        {
            long? messages = null;
            if (marks is not null)
            {
                long sum = 0;
                foreach (var p in t.Partitions)
                {
                    if (!marks.TryGetValue(new KTopicPartition(t.Name, p.Id), out var w)) { sum = -1; break; }
                    sum += w.High - w.Low;
                }
                messages = sum >= 0 ? sum : null;
            }
            return new KafkaTopicSummaryDto(t.Name, t.Partitions.Count, t.Partitions.Count == 0 ? 0 : t.Partitions.Max(p => p.Replicas.Count), t.Internal,
                t.Partitions.Count(p => p.Isr.Count < p.Replicas.Count), messages, null);
        }).ToList();
    }

    public async Task<KafkaTopicDetailDto> DetailAsync(KafkaClientHandle h, string topic, CancellationToken ct)
    {
        var meta = await TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        var tps = meta.Partitions.Select(p => new KTopicPartition(topic, p.Id)).ToList();
        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(tps, ct), topic).ConfigureAwait(false);
        IReadOnlyList<KConfigEntry> configs;
        try { configs = await h.Gateway.DescribeConfigsAsync(KConfigResource.Topic, topic, ct).ConfigureAwait(false); }
        catch (KafkaGatewayException ex) when (ex.Kind == KafkaErrorKind.Authorization) { configs = []; }
        catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex, topic); }
        var partitions = meta.Partitions.Select(p =>
        {
            var w = marks.GetValueOrDefault(new KTopicPartition(topic, p.Id));
            return new KafkaPartitionDto(p.Id, p.Leader >= 0 ? p.Leader : null, p.Replicas, p.Isr, w.Low, w.High, w.High - w.Low, null);
        }).ToList();
        return new KafkaTopicDetailDto(topic, meta.Internal, partitions, configs.Select(KafkaConfigEntryDto.From).ToList());
    }

    public static async Task<KTopicMeta> TopicMetaAsync(KafkaClientHandle h, string topic, CancellationToken ct)
    {
        var md = await KafkaErrors.Call(() => h.Gateway.MetadataAsync(topic, ct), topic).ConfigureAwait(false);
        var meta = md.Topics.FirstOrDefault(t => t.Name == topic);
        if (meta is null || meta.Error == "unknown" || meta.Partitions.Count == 0 && meta.Error is not null)
            throw new EngineException(404, ErrorCodes.NotFound, $"Topic '{topic}' was not found.");
        return meta;
    }

    public async Task CreateAsync(KafkaClientHandle h, KafkaCreateTopicRequest? req, CancellationToken ct)
    {
        if (req is null) throw EngineException.Validation("A request body is required.", new { field = "name" });
        var name = ValidateName(req.Name);
        var partitions = req.Partitions ?? 1;
        if (partitions is < 1 or > 10_000) throw EngineException.Validation("Partitions must be between 1 and 10000.", new { field = "partitions" });
        var rf = req.ReplicationFactor ?? 1;
        if (rf is < 1 or > short.MaxValue) throw EngineException.Validation("Replication factor must be ≥ 1.", new { field = "replicationFactor" });
        var configs = ValidateConfigs(req.Configs, "configs");
        h.EnsureWritable($"creating topic '{name}'");
        await KafkaErrors.Call(() => h.Gateway.CreateTopicAsync(name, partitions, (short)rf, configs, ct), name).ConfigureAwait(false);
    }

    public async Task AlterConfigsAsync(KafkaClientHandle h, string topic, KafkaAlterConfigsRequest? req, CancellationToken ct)
    {
        var set = ValidateConfigs(req?.Set, "set");
        var delete = (req?.Delete ?? []).Select(d => d?.Trim() ?? "").ToList();
        if (delete.Any(string.IsNullOrEmpty)) throw EngineException.Validation("delete must list config names.", new { field = "delete" });
        if (set.Count == 0 && delete.Count == 0) throw EngineException.Validation("Nothing to change: set or delete at least one config.", new { field = "set" });
        if (delete.Intersect(set.Keys).FirstOrDefault() is { } both)
            throw EngineException.Validation($"'{both}' is both set and deleted.", new { field = "delete" });
        h.EnsureWritable($"changing the configs of topic '{topic}'");
        await KafkaErrors.Call(() => h.Gateway.AlterTopicConfigsAsync(topic, set, delete, ct), topic).ConfigureAwait(false);
    }

    public async Task AddPartitionsAsync(KafkaClientHandle h, string topic, KafkaAddPartitionsRequest? req, CancellationToken ct)
    {
        var count = req?.Count ?? throw EngineException.Validation("count (the new total partition count) is required.", new { field = "count" });
        var meta = await TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        if (count <= meta.Partitions.Count)
            throw EngineException.Validation($"The new partition count must exceed the current {meta.Partitions.Count} (partitions cannot be removed).", new { field = "count" });
        if (count > 10_000) throw EngineException.Validation("At most 10000 partitions.", new { field = "count" });
        h.EnsureWritable($"adding partitions to topic '{topic}'");
        await KafkaErrors.Call(() => h.Gateway.CreatePartitionsAsync(topic, count, ct), topic).ConfigureAwait(false);
    }

    public async Task DeleteAsync(KafkaClientHandle h, string topic, CancellationToken ct)
    {
        h.EnsureWritable($"deleting topic '{topic}'");
        await TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        await KafkaErrors.Call(() => h.Gateway.DeleteTopicAsync(topic, ct), topic).ConfigureAwait(false);
    }

    /// <summary>DeleteRecords up to each partition's high watermark (danger; the UI asks for the topic name).</summary>
    public async Task<KafkaPurgeResult> PurgeAsync(KafkaClientHandle h, string topic, KafkaPurgeRequest? req, CancellationToken ct)
    {
        h.EnsureWritable($"purging topic '{topic}'");
        var meta = await TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        var ids = SelectPartitions(meta, req?.Partitions, "partitions");
        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(ids.Select(p => new KTopicPartition(topic, p)).ToList(), ct), topic).ConfigureAwait(false);
        var before = ids.ToDictionary(p => p, p => marks.GetValueOrDefault(new KTopicPartition(topic, p)).High);
        var lows = await KafkaErrors.Call(() => h.Gateway.DeleteRecordsAsync(topic, before, ct), topic).ConfigureAwait(false);
        return new KafkaPurgeResult(ids.Select(p => new KafkaPurgedPartition(p, lows.GetValueOrDefault(p, before[p]))).ToList());
    }

    /// <summary>The requested partition ids (validated against the topic), or all of them.</summary>
    public static IReadOnlyList<int> SelectPartitions(KTopicMeta meta, IReadOnlyCollection<int>? requested, string field)
    {
        var all = meta.Partitions.Select(p => p.Id).ToList();
        if (requested is null || requested.Count == 0) return all;
        var unknown = requested.Where(p => !all.Contains(p)).ToList();
        if (unknown.Count > 0)
            throw EngineException.Validation($"Topic '{meta.Name}' has no partition {string.Join(", ", unknown)} (0–{all.Count - 1}).", new { field });
        return requested.Distinct().Order().ToList();
    }

    private static IReadOnlyDictionary<string, string> ValidateConfigs(Dictionary<string, string>? configs, string field)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (k, v) in configs ?? [])
        {
            var key = k?.Trim();
            if (string.IsNullOrEmpty(key) || key.Any(char.IsWhiteSpace))
                throw EngineException.Validation($"'{k}' is not a valid config name.", new { field });
            result[key] = v ?? throw EngineException.Validation($"Config '{key}' needs a value.", new { field });
        }
        return result;
    }
}
