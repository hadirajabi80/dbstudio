using System.Text.Json;
using System.Text.Json.Serialization;

namespace DbStudio.Sources.Kafka;

// Wire DTOs of /api/v1/kafka/{cid}/... (docs/PLAN-M2.md 7; TypeScript twins in ui/src/api/types.m2.ts, "Kafka" section).

public sealed record KafkaNodeRef(int Id, string Host);

public sealed record KafkaBrokerDto(int Id, string Host, int Port, string? Rack, bool IsController, bool ConfigsAvailable);

public sealed record KafkaClusterDto(string? ClusterId, KafkaNodeRef? Controller, IReadOnlyList<KafkaBrokerDto> Brokers, int TopicCount,
    int PartitionCount, int UnderReplicated, int OfflinePartitions, string? Version);

public sealed record KafkaConfigSynonymDto(string Name, string? Value, string Source);

public sealed record KafkaConfigEntryDto(string Name, string? Value, string Source, bool IsDefault, bool IsReadOnly, bool IsSensitive,
    IReadOnlyList<KafkaConfigSynonymDto> Synonyms)
{
    public static KafkaConfigEntryDto From(KConfigEntry e) => new(e.Name, e.IsSensitive ? null : e.Value, e.Source, e.IsDefault, e.IsReadOnly,
        e.IsSensitive, e.Synonyms.Select(s => new KafkaConfigSynonymDto(s.Name, e.IsSensitive ? null : s.Value, s.Source)).ToList());
}

public sealed record KafkaTopicSummaryDto(string Name, int Partitions, int ReplicationFactor, bool Internal, int UnderReplicated, long? Messages, long? Size);

public sealed record KafkaPartitionDto(int Id, int? Leader, IReadOnlyList<int> Replicas, IReadOnlyList<int> Isr, long LowOffset, long HighOffset,
    long Messages, long? Size);

public sealed record KafkaTopicDetailDto(string Name, bool Internal, IReadOnlyList<KafkaPartitionDto> Partitions, IReadOnlyList<KafkaConfigEntryDto> Configs);

public sealed record KafkaCreateTopicRequest(string? Name, int? Partitions, int? ReplicationFactor, Dictionary<string, string>? Configs);

public sealed record KafkaAlterConfigsRequest(Dictionary<string, string>? Set, List<string>? Delete);

public sealed record KafkaAddPartitionsRequest(int? Count);

public sealed record KafkaPurgeRequest(List<int>? Partitions);

public sealed record KafkaPurgedPartition(int Partition, long LowOffset);

public sealed record KafkaPurgeResult(IReadOnlyList<KafkaPurgedPartition> Partitions);

/// <param name="Kind">latest | oldest | offset | timestamp.</param>
public sealed record KafkaFetchStart(string? Kind, int? Count, long? Offset, string? Iso);

public sealed record KafkaSearch(string? Text, bool CaseSensitive);

public sealed record KafkaFetchRequest(List<int>? Partitions, KafkaFetchStart? Start, int? Limit, string? KeyFormat, string? ValueFormat,
    KafkaSearch? Search, long? MaxBytes, int? TimeoutMs);

public sealed record KafkaFetchStarted(string JobId, string StreamId);

public sealed record KafkaFetchResult(int Fetched, long Scanned, IReadOnlyList<int> PartitionsDone, bool TimedOut, bool Truncated);

/// <summary>A decoded key, value or header (<c>KafkaDecoded</c>). <c>Text</c> is a string, a <c>{$trunc,len}</c> or null.</summary>
public sealed record KafkaDecoded
{
    public required string Format { get; init; }

    /// <summary>string | TruncatedValue | null (null payload).</summary>
    public object? Text { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public JsonElement? Json { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Hex { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? SchemaId { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? SchemaSubject { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Error { get; init; }

    /// <summary>The full decoded text (never serialized): search runs on it.</summary>
    [JsonIgnore] public string? FullText { get; init; }
}

public sealed record KafkaHeaderDto(string Key, KafkaDecoded Value);

/// <param name="TimestampType">create | logAppend | notAvailable.</param>
public sealed record KafkaMessageDto(string Topic, int Partition, long Offset, DateTimeOffset Timestamp, string TimestampType, KafkaDecoded Key,
    KafkaDecoded Value, IReadOnlyList<KafkaHeaderDto> Headers, int Size);

public sealed record KafkaProduceHeader(string? Key, string? Value);

public sealed record KafkaProduceMessage(string? Key, string? Value, List<KafkaProduceHeader>? Headers, int? Partition);

/// <param name="Version">A number or "latest".</param>
public sealed record KafkaSchemaRef(string? Subject, JsonElement? Version);

public sealed record KafkaProduceRequest(List<KafkaProduceMessage>? Messages, string? KeyFormat, string? ValueFormat, KafkaSchemaRef? Schema,
    KafkaSchemaRef? KeySchema, string? Compression);

public sealed record KafkaProduceResult(int Partition, long Offset, DateTimeOffset Timestamp);

public sealed record KafkaGroupSummaryDto(string GroupId, string State, string? Protocol, int Members, IReadOnlyList<string> Topics, long? LagTotal,
    KafkaNodeRef? Coordinator);

public sealed record KafkaAssignmentDto(string Topic, IReadOnlyList<int> Partitions);

public sealed record KafkaGroupMemberDto(string MemberId, string ClientId, string Host, IReadOnlyList<KafkaAssignmentDto> Assignments);

public sealed record KafkaGroupPartitionDto(string Topic, int Partition, long? Committed, long High, long Low, long? Lag, string? MemberId);

public sealed record KafkaGroupDetailDto(string GroupId, string State, string? Protocol, KafkaNodeRef? Coordinator, IReadOnlyList<KafkaGroupMemberDto> Members,
    IReadOnlyList<KafkaGroupPartitionDto> Partitions);

public sealed record KafkaTopicPartitionRef(string? Topic, int Partition);

/// <param name="Kind">earliest | latest | offset | timestamp | shiftBy.</param>
/// <param name="Value">offset / shift (number) or ISO timestamp (string).</param>
public sealed record KafkaResetTarget(string? Kind, JsonElement? Value);

public sealed record KafkaOffsetResetRequest(List<KafkaTopicPartitionRef>? Partitions, string? Topic, KafkaResetTarget? To, bool DryRun);

public sealed record KafkaOffsetResetRow(string Topic, int Partition, long? From, long To);

public sealed record KafkaSchemaSubjectDto(string Subject, IReadOnlyList<int>? Versions, int? LatestVersion, string? SchemaType);

public sealed record KafkaSchemaReferenceDto(string Name, string Subject, int Version);

public sealed record KafkaSchemaVersionDto(string Subject, int Version, int Id, string SchemaType, string Schema, IReadOnlyList<KafkaSchemaReferenceDto> References);

/// <summary><c>GET /kafka/library</c>: proves librdkafka loaded (docs/PLAN-M2.md D8).</summary>
public sealed record KafkaLibraryInfo(string Version, int VersionInt, IReadOnlyList<string> DebugContexts, string? LoadedFrom);
