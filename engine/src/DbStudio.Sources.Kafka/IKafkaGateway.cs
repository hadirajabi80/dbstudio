namespace DbStudio.Sources.Kafka;

// The seam between the Kafka services and the driver (docs/PLAN-M2.md 7.6, D11). ConfluentKafkaGateway talks to real
// brokers through Confluent.Kafka/librdkafka; the test project's KafkaFake is an in-memory broker model with partitions,
// offsets, timestamps and groups. The services never see a Confluent type, so every behaviour is unit-testable.

public sealed record KBroker(int Id, string Host, int Port, string? Rack);

/// <param name="Leader">-1 when the partition has no leader (offline).</param>
public sealed record KPartitionMeta(int Id, int Leader, IReadOnlyList<int> Replicas, IReadOnlyList<int> Isr, string? Error = null);

public sealed record KTopicMeta(string Name, IReadOnlyList<KPartitionMeta> Partitions, bool Internal, string? Error = null);

public sealed record KMetadata(IReadOnlyList<KBroker> Brokers, IReadOnlyList<KTopicMeta> Topics, int OriginatingBrokerId);

public sealed record KClusterInfo(string? ClusterId, int? ControllerId, IReadOnlyList<KBroker> Nodes);

public enum KConfigResource { Topic, Broker }

public sealed record KConfigSynonym(string Name, string? Value, string Source);

/// <param name="Source">librdkafka config source in snake case: dynamic_topic_config, dynamic_broker_config, static_broker_config, default_config, ...</param>
public sealed record KConfigEntry(string Name, string? Value, string Source, bool IsDefault, bool IsReadOnly, bool IsSensitive,
    IReadOnlyList<KConfigSynonym> Synonyms);

public readonly record struct KTopicPartition(string Topic, int Partition)
{
    public override string ToString() => $"{Topic}[{Partition}]";
}

public readonly record struct KWatermarks(long Low, long High);

public sealed record KHeader(string Key, byte[]? Value);

/// <param name="TimestampType">create | logAppend | notAvailable.</param>
public sealed record KRecord(string Topic, int Partition, long Offset, DateTimeOffset Timestamp, string TimestampType,
    byte[]? Key, byte[]? Value, IReadOnlyList<KHeader> Headers)
{
    public int Size => (Key?.Length ?? 0) + (Value?.Length ?? 0) + Headers.Sum(h => h.Key.Length + (h.Value?.Length ?? 0));
}

public sealed record KProduceRecord(byte[]? Key, byte[]? Value, IReadOnlyList<KHeader> Headers, int? Partition);

public sealed record KDelivery(int Partition, long Offset, DateTimeOffset Timestamp);

/// <param name="State">Stable | Empty | Dead | PreparingRebalance | CompletingRebalance | Unknown.</param>
public sealed record KGroupListing(string GroupId, string State, bool IsSimple);

public sealed record KGroupMember(string MemberId, string ClientId, string Host, IReadOnlyList<KTopicPartition> Assignment);

public sealed record KGroupDescription(string GroupId, string State, string? Protocol, KBroker? Coordinator, IReadOnlyList<KGroupMember> Members);

/// <param name="Offset">Committed offset; null when the group has no commit for the partition.</param>
public sealed record KCommitted(KTopicPartition Tp, long? Offset);

/// <summary>One poll result: a record, or "partition reached its end" (EOF), never both.</summary>
public sealed record KConsumeResult(KRecord? Record, KTopicPartition? Eof = null, long EofOffset = -1);

/// <summary>Failure categories the services map to REST errors (KafkaErrors.ToEngine).</summary>
public enum KafkaErrorKind
{
    Unknown, Unreachable, Timeout, UnknownTopic, TopicExists, UnknownGroup, GroupNotEmpty, Authorization, Authentication,
    InvalidRequest, PolicyViolation,
}

public sealed class KafkaGatewayException(KafkaErrorKind kind, string message, Exception? inner = null) : Exception(message, inner)
{
    public KafkaErrorKind Kind { get; } = kind;
}

/// <summary>Driver operations used by the Kafka services. Implementations are thread-safe.</summary>
public interface IKafkaGateway : IDisposable
{
    /// <summary>librdkafka version (the fake reports "fake").</summary>
    string LibraryVersion { get; }

    /// <param name="topic">Null = all topics.</param>
    Task<KMetadata> MetadataAsync(string? topic, CancellationToken ct);

    Task<KClusterInfo> DescribeClusterAsync(CancellationToken ct);

    Task<IReadOnlyList<KConfigEntry>> DescribeConfigsAsync(KConfigResource kind, string name, CancellationToken ct);

    Task CreateTopicAsync(string name, int partitions, short replicationFactor, IReadOnlyDictionary<string, string> configs, CancellationToken ct);

    Task DeleteTopicAsync(string name, CancellationToken ct);

    /// <param name="totalCount">New total partition count (must exceed the current one).</param>
    Task CreatePartitionsAsync(string topic, int totalCount, CancellationToken ct);

    Task AlterTopicConfigsAsync(string topic, IReadOnlyDictionary<string, string> set, IReadOnlyList<string> delete, CancellationToken ct);

    /// <summary>DeleteRecords: removes everything before the given offsets; returns the new low watermarks.</summary>
    Task<IReadOnlyDictionary<int, long>> DeleteRecordsAsync(string topic, IReadOnlyDictionary<int, long> before, CancellationToken ct);

    Task<IReadOnlyDictionary<KTopicPartition, KWatermarks>> WatermarksAsync(IReadOnlyList<KTopicPartition> partitions, CancellationToken ct);

    /// <summary>Earliest offset whose timestamp is ≥ <paramref name="timestamp"/>; null when no such record exists.</summary>
    Task<IReadOnlyDictionary<KTopicPartition, long?>> OffsetsForTimesAsync(IReadOnlyList<KTopicPartition> partitions, DateTimeOffset timestamp, CancellationToken ct);

    /// <summary>A consumer that never joins a group (manual assignment, no commits) for browsing and tailing.</summary>
    IKafkaReader CreateReader(string purpose);

    Task<IReadOnlyList<KDelivery>> ProduceAsync(string topic, IReadOnlyList<KProduceRecord> records, string? compression, CancellationToken ct);

    Task<IReadOnlyList<KGroupListing>> ListGroupsAsync(CancellationToken ct);

    Task<IReadOnlyList<KGroupDescription>> DescribeGroupsAsync(IReadOnlyList<string> groupIds, CancellationToken ct);

    Task<IReadOnlyList<KCommitted>> GroupOffsetsAsync(string groupId, CancellationToken ct);

    Task AlterGroupOffsetsAsync(string groupId, IReadOnlyDictionary<KTopicPartition, long> offsets, CancellationToken ct);

    Task DeleteGroupAsync(string groupId, CancellationToken ct);
}

/// <summary>A manually assigned consumer. Not thread-safe: one thread polls; pause/resume from that thread.</summary>
public interface IKafkaReader : IDisposable
{
    void Assign(IReadOnlyList<(KTopicPartition Tp, long Offset)> start);

    /// <summary>Next record or EOF notification; null when nothing arrived within <paramref name="timeout"/>.</summary>
    KConsumeResult? Consume(TimeSpan timeout, CancellationToken ct);

    void Pause();

    void Resume();
}
