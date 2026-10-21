using System.Text.Json;
using System.Text.Json.Serialization;
using DbStudio.Core.Models;

namespace DbStudio.Sources.Redis;

// Wire shapes of /api/v1/redis/{cid}/... (docs/PLAN-M2.md 5.3-5.5; TypeScript twins in ui/src/api/types.m2.ts).
// Requests are nullable everywhere so validation can name the missing field (400 VALIDATION).

public sealed record RedisKeyspaceDb(int Db, long Keys, long Expires);

/// <param name="Mode">standalone | cluster | sentinel.</param>
public sealed record RedisServerResponse(ServerInfo Server, string Mode, IReadOnlyList<string> Modules, int Databases,
    IReadOnlyList<RedisKeyspaceDb> Keyspace, bool ReadOnly, string Delimiter, int ScanCount);

public sealed record RedisScanRequest(int? Db, string? Pattern, string? Type, string? Cursor, int? Count);

/// <param name="Ttl">Seconds; -1 no TTL, -2 gone.</param>
public sealed record RedisKeySummary(string Key, string Type, long Ttl, long? Size = null);

public sealed record RedisScanResponse(string Cursor, IReadOnlyList<RedisKeySummary> Keys, long Scanned, long DbSize);

public sealed record RedisMemoryRequest(int? Db, IReadOnlyList<string>? Keys);

public sealed record RedisMemoryResponse(Dictionary<string, long?> Sizes);

/// <summary>A value cut at 1 MB (<c>{ "$trunc": "...", "len": 123 }</c>, M2TruncatedText).</summary>
public sealed record TruncatedText([property: JsonPropertyName("$trunc")] string Trunc, long Len);

public abstract record RedisKeyValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory)
{
    public abstract string Type { get; }
}

/// <param name="Value">string or <see cref="TruncatedText"/>.</param>
/// <param name="Encoding">utf8 | hex.</param>
public sealed record RedisStringValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, object Value, string Encoding, bool IsJson, long Length)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "string";
}

public sealed record RedisHashField(string Field, string Value);

public sealed record RedisHashValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, IReadOnlyList<RedisHashField> Fields, string Cursor, long Length)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "hash";
}

public sealed record RedisListItem(long Index, string Value);

public sealed record RedisListValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, IReadOnlyList<RedisListItem> Items, long Length, long Start, long Stop)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "list";
}

public sealed record RedisSetValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, IReadOnlyList<string> Members, string Cursor, long Length)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "set";
}

public sealed record RedisZsetMember(string Member, double Score);

public sealed record RedisZsetValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, IReadOnlyList<RedisZsetMember> Members, string Cursor, long Length)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "zset";
}

public sealed record RedisStreamEntry(string Id, Dictionary<string, string> Fields);

public sealed record RedisStreamGroup(string Name, long Consumers, long Pending, string LastDeliveredId, long? Lag);

public sealed record RedisStreamValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, IReadOnlyList<RedisStreamEntry> Entries,
    long Length, string? FirstId, string? LastId, IReadOnlyList<RedisStreamGroup> Groups)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "stream";
}

public sealed record RedisJsonValue(string Key, int Db, long Ttl, string? ObjectEncoding, long? Memory, JsonElement Json, string Path)
    : RedisKeyValue(Key, Db, Ttl, ObjectEncoding, Memory)
{
    public override string Type => "rejson";
}

public sealed record RedisStreamConsumer(string Name, long Pending, long IdleMs, long? InactiveMs);

public sealed record RedisPendingEntry(string Id, string Consumer, long IdleMs, long Deliveries);

/// <summary><c>GET /keys/{key}/stream/groups/{group}</c>: XINFO CONSUMERS + XPENDING (first 100).</summary>
public sealed record RedisStreamGroupDetail(string Group, IReadOnlyList<RedisStreamConsumer> Consumers, IReadOnlyList<RedisPendingEntry> Pending);

// ---- mutations

public sealed record RedisSetStringRequest(string? Value);

public sealed record RedisHashEditRequest(Dictionary<string, string>? Set, IReadOnlyList<string>? Del);

public sealed record RedisListPush(string? Side, IReadOnlyList<string>? Values);

public sealed record RedisListSetIndex(long? Index, string? Value);

public sealed record RedisListRemove(string? Value, long? Count);

public sealed record RedisListEditRequest(RedisListPush? Push, RedisListSetIndex? SetIndex, RedisListRemove? Remove);

public sealed record RedisSetEditRequest(IReadOnlyList<string>? Add, IReadOnlyList<string>? Remove);

public sealed record RedisZsetEditRequest(IReadOnlyList<RedisZsetMember>? Add, IReadOnlyList<string>? Remove);

public sealed record RedisStreamAck(string? Group, IReadOnlyList<string>? Ids);

public sealed record RedisStreamGroupCreate(string? Name, string? Id);

public sealed record RedisStreamEditRequest(Dictionary<string, string>? Add, string? Id, IReadOnlyList<string>? Delete, RedisStreamAck? Ack,
    RedisStreamGroupCreate? GroupCreate, string? GroupDestroy);

public sealed record RedisJsonSetRequest(string? Path, JsonElement? Value);

/// <param name="Members">set: string[]; zset: [{member, score}].</param>
public sealed record RedisCreateKeyRequest(string? Key, int? Db, long? Ttl, string? Type, string? Value, Dictionary<string, string>? Fields,
    IReadOnlyList<string>? Values, JsonElement? Members, JsonElement? Json);

public sealed record RedisRenameRequest(string? NewKey, bool? Overwrite);

public sealed record RedisTtlRequest(long? Seconds);

public sealed record RedisDeletePatternRequest(int? Db, string? Pattern);

public sealed record RedisDeletePatternResult(long Scanned, long Deleted);

// ---- commands

public sealed record RedisCommandsRequest(int? Db, IReadOnlyList<IReadOnlyList<string>>? Commands, IReadOnlyList<string>? Raw);

/// <param name="Type">simple | bulk | int | array | null | error.</param>
/// <param name="Value">string | long | null | nested array of those.</param>
public sealed record RedisCommandResult(bool Ok, string Type, object? Value, long ElapsedMs);

/// <param name="Db">The database selected after the batch (SELECT is tracked per request).</param>
public sealed record RedisCommandsResponse(IReadOnlyList<RedisCommandResult> Results, int Db);

// ---- pub/sub, slowlog, config, info, clients

public sealed record RedisPublishRequest(string? Channel, string? Message);

public sealed record RedisPublishResponse(long Receivers);

public sealed record RedisChannelInfo(string Channel, long Subscribers);

public sealed record RedisPubSubChannels(IReadOnlyList<RedisChannelInfo> Channels, long Patterns);

public sealed record RedisSlowlogEntry(long Id, DateTimeOffset Ts, long DurationUs, IReadOnlyList<string> Args, string? Client, string? Name);

public sealed record RedisConfigResponse(Dictionary<string, string> Values);

public sealed record RedisConfigSetRequest(string? Name, string? Value);

public sealed record RedisClusterNode(string Id, string Address, IReadOnlyList<string> Flags, string? MasterId, IReadOnlyList<string> Slots, string LinkState);

public sealed record RedisInfoResponse(Dictionary<string, Dictionary<string, string>> Sections, long DbSize, long Clients, IReadOnlyList<RedisClusterNode>? ClusterNodes);

public sealed record RedisClientInfo(string Id, string Addr, string? Name, string? User, int Db, long AgeSeconds, long IdleSeconds, string? Cmd, string Flags,
    Dictionary<string, string> Fields);

public sealed record RedisClientKillRequest(string? Id);

// ---- analysis

public sealed record RedisAnalysisRequest(int? Db, int? SampleLimit, string? Delimiter);

public sealed record RedisTypeStat(long Keys, long Memory);

public sealed record RedisAnalysisNamespace(string Prefix, long Keys, long Memory, double? AvgTtl, Dictionary<string, long> Types);

public sealed record RedisTopKey(string Key, string Type, long Memory, long Ttl);

public sealed record RedisTtlBucket(string Label, long? MaxSeconds, long Keys);

public sealed record RedisTtlStats(long NoTtl, IReadOnlyList<RedisTtlBucket> Buckets);

public sealed record RedisAnalysisResult(long Scanned, long TotalKeys, bool Sampled, IReadOnlyList<RedisAnalysisNamespace> Namespaces,
    IReadOnlyList<RedisTopKey> TopKeys, Dictionary<string, RedisTypeStat> ByType, RedisTtlStats Ttl, long Expiring, long ElapsedMs);
