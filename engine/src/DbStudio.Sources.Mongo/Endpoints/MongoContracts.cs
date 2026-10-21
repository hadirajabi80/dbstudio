using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;

namespace DbStudio.Sources.Mongo.Endpoints;

// Wire shapes of /api/v1/mongo/{cid}/… (ui/src/api/types.m2.ts, section "MongoDB"); camelCase via CoreJson.Options.
// Documents and values are canonical Extended JSON text (string); request texts are mongosh-style JSON (ShellJson).

public sealed record MongoTopologyMember(string Host, string State, bool? Health);

public sealed record MongoServerInfo(ServerInfo Server, string Type, string? SetName, IReadOnlyList<MongoTopologyMember> Members, bool IsAtlas,
    int MaxWireVersion);

public sealed record MongoDatabaseInfo(string Name, long? SizeOnDisk, bool Empty);

/// <param name="Type">collection | view | timeseries.</param>
public sealed record MongoCollectionInfo(string Name, string Type, long? Count, bool ReadOnly, string? ViewOn);

public sealed record MongoCollectionStats(long Count, long Size, double? AvgObjSize, long? StorageSize, int Indexes, long? TotalIndexSize);

public sealed class MongoFieldsRequest
{
    public int? SampleSize { get; set; }
    public string? Filter { get; set; }
}

public sealed record MongoFieldPath(string Path, IReadOnlyList<string> Types, IReadOnlyList<string>? Values);

public sealed record MongoFieldsResponse(int Sampled, IReadOnlyList<MongoFieldPath> Fields);

public sealed class MongoFindRequest
{
    public string? Filter { get; set; }
    public string? Projection { get; set; }
    public string? Sort { get; set; }
    public int Skip { get; set; }
    public int Limit { get; set; } = 20;
    public string? Collation { get; set; }
    public int? MaxTimeMs { get; set; }
}

public sealed record MongoCount(long Value, bool Exact);

public sealed record MongoFindResponse(IReadOnlyList<string> Docs, MongoCount Count);

public sealed record MongoDocResponse(string? Doc);

public sealed class MongoInsertRequest
{
    public string? Doc { get; set; }
}

public sealed record MongoInsertResponse(string InsertedId);

public sealed class MongoReplaceRequest
{
    [JsonPropertyName("_id")]
    public string? Id { get; set; }

    public string? Doc { get; set; }
    public bool Replace { get; set; } = true;
}

public sealed record MongoReplaceResponse(long Matched, long Modified);

public sealed class MongoDeleteRequest
{
    public List<string>? Ids { get; set; }
}

public sealed record MongoDeleteResponse(long Deleted);

public sealed class MongoAggregateRequest
{
    public List<string>? Pipeline { get; set; }
    public int? PreviewStage { get; set; }
    public int Limit { get; set; } = 20;
    public int Skip { get; set; }
    public bool AllowDiskUse { get; set; }
    public int? MaxTimeMs { get; set; }
}

public sealed record MongoAggregateResponse(
    IReadOnlyList<string> Docs,
    bool Truncated,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? WriteStageSkipped = null);

/// <summary><c>kind: find</c> uses the find fields, <c>kind: aggregate</c> the pipeline fields.</summary>
public sealed class MongoExplainRequest
{
    public string? Kind { get; set; }
    public string? Verbosity { get; set; }
    public string? Filter { get; set; }
    public string? Projection { get; set; }
    public string? Sort { get; set; }
    public int Skip { get; set; }
    public int? Limit { get; set; }
    public string? Collation { get; set; }
    public int? MaxTimeMs { get; set; }
    public List<string>? Pipeline { get; set; }
    public int? PreviewStage { get; set; }
    public bool AllowDiskUse { get; set; }
}

public sealed record MongoExplainSummary(long? NReturned, long? DocsExamined, long? KeysExamined, long? ExecutionTimeMs, IReadOnlyList<string> Indexes,
    bool Collscan, bool SortInMemory, int RejectedPlans);

public sealed record MongoExplainResponse(string Raw, PlanNode Root, IReadOnlyList<string> Warnings, MongoExplainSummary Summary);

public sealed class MongoSchemaRequest
{
    public int? SampleSize { get; set; }
    public string? Filter { get; set; }
}

public sealed record MongoSchemaType(string BsonType, long Count, double Pct);

public sealed record MongoSchemaStats(JsonNode? Min, JsonNode? Max, long Distinct);

public sealed record MongoSchemaField(
    string Path,
    IReadOnlyList<MongoSchemaType> Types,
    double Probability,
    IReadOnlyList<MongoSchemaField> Nested,
    IReadOnlyList<JsonNode?> Examples,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] MongoSchemaStats? Stats);

public sealed record MongoSchemaResult(int Sampled, IReadOnlyList<MongoSchemaField> Fields);

/// <param name="Type">1 | -1 | "text" | "2dsphere" | "2d" | "hashed".</param>
public sealed record MongoIndexKeyPart(string Field, JsonNode Type);

public sealed record MongoIndexUsage(long Ops, string Since);

public sealed record MongoIndexInfo(string Name, IReadOnlyList<MongoIndexKeyPart> Key, bool Unique, bool Sparse, long? TtlSeconds, string? PartialFilter,
    string? Collation, long? Size, MongoIndexUsage? Usage);

public sealed class MongoIndexKeyPartRequest
{
    public string? Field { get; set; }
    public JsonNode? Type { get; set; }
}

public sealed class MongoCreateIndexOptions
{
    public string? Name { get; set; }
    public bool? Unique { get; set; }
    public bool? Sparse { get; set; }
    public long? ExpireAfterSeconds { get; set; }
    public string? PartialFilterExpression { get; set; }
    public string? Collation { get; set; }
}

public sealed class MongoCreateIndexRequest
{
    public List<MongoIndexKeyPartRequest>? Key { get; set; }
    public MongoCreateIndexOptions? Options { get; set; }
}

public sealed record MongoCreateIndexResponse(string Name, string? JobId);

public sealed record MongoCreateIndexResult(string Name);

/// <summary>GET response and PUT body of …/validation.</summary>
public sealed class MongoValidation
{
    public string? Validator { get; set; }
    public string? Level { get; set; }
    public string? Action { get; set; }
}

/// <summary>GET response and PUT body of /db/{db}/profiling (level 0 off, 1 slow operations, 2 all).</summary>
public sealed class MongoProfiling
{
    public int? Level { get; set; }
    public int? Slowms { get; set; }
    public double? SampleRate { get; set; }
}

public sealed class MongoExportRequest
{
    public string? Format { get; set; }
    public string? Filter { get; set; }
    public string? Projection { get; set; }
    public string? Sort { get; set; }
    public int? Limit { get; set; }
    public List<string>? Fields { get; set; }
    public string? Path { get; set; }
    public string? EjsonMode { get; set; }
}

public sealed record MongoExportResult(string? Path, long Docs);

public sealed class MongoCsvOptions
{
    public bool Header { get; set; } = true;
    public string? Delimiter { get; set; }
    public bool TypeInference { get; set; } = true;
    public Dictionary<string, string>? Types { get; set; }
}

public sealed class MongoImportRequest
{
    public string? Format { get; set; }
    public string? Path { get; set; }
    public string? Upload { get; set; }
    public string? Mode { get; set; }
    public string? UpsertKey { get; set; }
    public int? BatchSize { get; set; }
    public bool StopOnError { get; set; }
    public MongoCsvOptions? Csv { get; set; }
}

public sealed record MongoImportError(int Index, string Message);

public sealed record MongoImportColumn(string Name, string InferredType);

public sealed record MongoImportPreview(IReadOnlyList<string> Docs, IReadOnlyList<MongoImportColumn>? Columns, IReadOnlyList<MongoImportError> Errors);

/// <param name="Inserted">New documents (insert mode, and documents created by upserts).</param>
/// <param name="Upserted">Existing documents replaced by key (upsert mode).</param>
public sealed record MongoImportResult(long Inserted, long Upserted, long Failed, IReadOnlyList<MongoImportError> Errors);

public sealed class MongoTimeseriesOptions
{
    public string? TimeField { get; set; }
    public string? MetaField { get; set; }
    public string? Granularity { get; set; }
}

public sealed class MongoCreateCollectionOptions
{
    public bool? Capped { get; set; }
    public long? Size { get; set; }
    public long? Max { get; set; }
    public MongoTimeseriesOptions? Timeseries { get; set; }
    public string? Validator { get; set; }
    public string? ViewOn { get; set; }
    public List<string>? Pipeline { get; set; }
}

public sealed class MongoCreateCollectionRequest
{
    public string? Name { get; set; }
    public MongoCreateCollectionOptions? Options { get; set; }
}

public sealed class MongoRenameCollectionRequest
{
    public string? NewName { get; set; }
    public bool DropTarget { get; set; }
}

public sealed record MongoChangeNs(string Db, string? Coll);

public sealed record MongoUpdateDescription(string UpdatedFields, IReadOnlyList<string> RemovedFields);

/// <summary>Item of the <c>mongo.changes</c> stream.</summary>
public sealed record MongoChangeItem(string Ts, string OperationType, MongoChangeNs Ns, string? DocumentKey, string? FullDocument,
    MongoUpdateDescription? UpdateDescription);
