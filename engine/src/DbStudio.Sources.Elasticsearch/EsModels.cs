using System.Text.Json;

namespace DbStudio.Sources.Elasticsearch;

// Wire shapes of /api/v1/es/{cid}/… (plan-batch3 WP-ES). The UI mirror is ui/src/api/types.es.ts; JSON is camelCase
// (CoreJson.Options) and JsonElement fields carry the server's JSON as is.

public sealed record EsCluster(
    string ClusterName, string? ClusterUuid, string Flavor, string Version, string? LuceneVersion, string Status, bool TimedOut,
    int Nodes, int DataNodes, int ActivePrimaryShards, int ActiveShards, int RelocatingShards, int InitializingShards, int UnassignedShards,
    double ActiveShardsPercent, int PendingTasks, long? Indices, long? Docs, long? StoreBytes, long? JvmHeapUsedBytes, long? JvmHeapMaxBytes,
    long? FsTotalBytes, long? FsAvailableBytes);

public sealed record EsNode(
    string Id, string Name, string? Ip, IReadOnlyList<string> Roles, bool Master, string? Version, double? HeapPercent, double? RamPercent,
    double? Cpu, double? Load1m, double? DiskUsedPercent, long? DiskUsedBytes, long? DiskTotalBytes, string? Uptime);

public sealed record EsIndexSummary(
    string Name, string? Uuid, string? Health, string Status, int Primaries, int Replicas, long? DocsCount, long? DocsDeleted, long? StoreBytes,
    long? PriStoreBytes, bool Hidden, bool System, IReadOnlyList<string> Aliases, string? DataStream, string? CreatedAt);

public sealed record EsAlias(string Alias, string Index, bool Filter, string? IndexRouting, string? SearchRouting, bool? IsWriteIndex);

public sealed record EsDataStream(string Name, string? Status, string? Template, long Generation, string? TimestampField, IReadOnlyList<string> Indices);

public sealed record EsTemplate(string Name, string Kind, IReadOnlyList<string> Patterns, long? Priority, long? Version, bool DataStream,
    IReadOnlyList<string> ComposedOf, JsonElement? Body);

public sealed record EsShard(int Shard, string Prirep, string State, long? Docs, long? StoreBytes, string? Ip, string? Node, string? UnassignedReason);

public sealed record EsIndexStats(JsonElement? Primaries, JsonElement? Total);

public sealed record EsIndexDetail(string Name, JsonElement? Mappings, JsonElement? Settings, JsonElement? Aliases, EsIndexSummary? Summary,
    IReadOnlyList<EsShard> Shards, EsIndexStats? Stats);

public sealed record EsField(string Path, string Type, string? Parent, bool Searchable, bool Aggregatable);

public sealed class EsSearchRequest
{
    public string? Index { get; set; }
    public JsonElement? Body { get; set; }
    public int? From { get; set; }
    public int? Size { get; set; }
    public JsonElement? SearchAfter { get; set; }
    /// <summary>bool or number (JSON).</summary>
    public JsonElement? TrackTotalHits { get; set; }
}

public sealed record EsHit(string Index, string Id, double? Score, long? SeqNo, long? PrimaryTerm, long? Version, string? Routing, JsonElement? Source,
    JsonElement? Fields, IReadOnlyDictionary<string, IReadOnlyList<string>>? Highlight, JsonElement? Sort, JsonElement? Explanation,
    IReadOnlyList<string>? MatchedQueries);

public sealed record EsShardsInfo(int Total, int Successful, int Skipped, int Failed);

public sealed record EsSearchResponse(long Took, bool TimedOut, long? Total, string TotalRelation, double? MaxScore, IReadOnlyList<EsHit> Hits,
    JsonElement? Aggregations, EsShardsInfo Shards, JsonElement? Profile, long ElapsedMs, bool Capped, JsonElement Request);

public sealed record EsDoc(string Index, string Id, bool Found, long? SeqNo, long? PrimaryTerm, long? Version, string? Routing, JsonElement? Source);

public sealed class EsPutDocRequest
{
    public JsonElement? Source { get; set; }
    public long? IfSeqNo { get; set; }
    public long? IfPrimaryTerm { get; set; }
    public string? Routing { get; set; }
    public bool Create { get; set; }
    public string? Refresh { get; set; }
}

public sealed record EsWriteResult(string Index, string Id, string Result, long? SeqNo, long? PrimaryTerm, long? Version);

public sealed class EsCreateIndexRequest
{
    public string? Name { get; set; }
    public int? Shards { get; set; }
    public int? Replicas { get; set; }
    public JsonElement? Body { get; set; }
}

public sealed class EsSettingsUpdate
{
    public JsonElement? Settings { get; set; }
}

public sealed class EsMappingsUpdate
{
    public JsonElement? Mappings { get; set; }
}

public sealed class EsAliasAdd
{
    public string? Index { get; set; }
    public string? Alias { get; set; }
    public JsonElement? Filter { get; set; }
    public string? Routing { get; set; }
    public bool? IsWriteIndex { get; set; }
}

public sealed class EsAliasRemove
{
    public string? Index { get; set; }
    public string? Alias { get; set; }
}

public sealed class EsAliasAction
{
    public EsAliasAdd? Add { get; set; }
    public EsAliasRemove? Remove { get; set; }
}

public sealed class EsAliasesRequest
{
    public List<EsAliasAction>? Actions { get; set; }
}

/// <summary>ApiError.detail of a failed Elasticsearch call.</summary>
public sealed record EsErrorDetail(int Status, string? EsType, string? RootCause);

// ---- jobs

public sealed class EsReindexRequest
{
    public string? Source { get; set; }
    public string? Dest { get; set; }
    public JsonElement? Query { get; set; }
    public string? Conflicts { get; set; }
    public long? MaxDocs { get; set; }
    public int? Slices { get; set; }
    public string? Script { get; set; }
}

public sealed record EsReindexResult(string? TaskId, long Total, long Created, long Updated, long Deleted, long VersionConflicts,
    IReadOnlyList<string> Failures, long TookMs);

public sealed class EsCsvOptions
{
    public string? Delimiter { get; set; }
    public bool? Header { get; set; }
}

public sealed class EsImportRequest
{
    public string? Index { get; set; }
    public string? Format { get; set; }
    public string? Path { get; set; }
    public string? Upload { get; set; }
    public string? IdField { get; set; }
    public int? BatchSize { get; set; }
    public string? Pipeline { get; set; }
    public EsCsvOptions? Csv { get; set; }
}

public sealed record EsImportResult(long Indexed, long Failed, IReadOnlyList<string> Errors, long TookMs);

public sealed class EsExportRequest
{
    public string? Index { get; set; }
    public string? Format { get; set; }
    public JsonElement? Query { get; set; }
    public List<string>? Fields { get; set; }
    public long? Max { get; set; }
    public string? Path { get; set; }
    public bool IncludeMeta { get; set; }
}

public sealed record EsExportResult(string? Path, long Docs);

// ---- SQL

public sealed class EsSqlRequest
{
    public string? Query { get; set; }
    public int? FetchSize { get; set; }
    public string? Cursor { get; set; }
}

public sealed class EsSqlCursorRequest
{
    public string? Cursor { get; set; }
}

public sealed record EsSqlColumn(string Name, string Type);

public sealed record EsSqlResponse(IReadOnlyList<EsSqlColumn> Columns, IReadOnlyList<IReadOnlyList<JsonElement>> Rows, string? Cursor, long ElapsedMs);

public sealed record EsSqlTranslateResponse(JsonElement? Dsl);

// ---- console

public sealed class EsConsoleRequest
{
    public string? Method { get; set; }
    public string? Path { get; set; }
    public string? Body { get; set; }
}

public sealed record EsConsoleResponse(int Status, string StatusText, long ElapsedMs, string? ContentType, string Body, bool Truncated);

// ---- tasks

public sealed record EsTask(string Id, string Node, string Action, string Type, string? Description, string StartTime, long RunningTimeMs,
    bool Cancellable, bool Cancelled, string? ParentTaskId, JsonElement? Status);

public sealed record EsTasksStreamItem(string At, IReadOnlyList<EsTask> Tasks);
