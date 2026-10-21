using MongoDB.Bson;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary>Options of a find (all BSON already parsed; null = not set).</summary>
public sealed record FindSpec(
    BsonDocument Filter,
    BsonDocument? Projection = null,
    BsonDocument? Sort = null,
    int Skip = 0,
    int? Limit = null,
    BsonDocument? Collation = null,
    TimeSpan? MaxTime = null);

/// <summary>Options of an aggregate.</summary>
public sealed record AggregateSpec(bool AllowDiskUse = false, TimeSpan? MaxTime = null, BsonDocument? Collation = null);

/// <summary>A per-document write failure (index into the batch, server code, message).</summary>
public sealed record WriteFailure(int Index, int Code, string Message);

public sealed record InsertManyResult(long Inserted, IReadOnlyList<WriteFailure> Errors);

public sealed record ReplaceResult(long Matched, long Modified, BsonValue? UpsertedId);

/// <param name="Upserted">Documents newly inserted by the upserts.</param>
/// <param name="Matched">Existing documents that were replaced (matched by the key).</param>
public sealed record BulkUpsertResult(long Upserted, long Matched, long Modified, IReadOnlyList<WriteFailure> Errors);

/// <summary>
/// The MongoDB calls the services need (docs/PLAN-M2.md 6.5 "Engine tests"): a seam so every service is unit-tested over
/// the in-memory <c>MongoFake</c>; <see cref="DriverMongoGateway"/> implements it with MongoDB.Driver. Driver exceptions
/// (MongoCommandException, MongoConnectionException, TimeoutException …) pass through and are mapped by <c>MongoErrors</c>.
/// </summary>
public interface IMongoGateway : IAsyncDisposable
{
    /// <summary>The driver client, or null for fakes.</summary>
    IMongoClient? Client { get; }

    /// <summary>Runs a database command (hello, buildInfo, collStats, collMod, explain, currentOp, createIndexes, create …).</summary>
    Task<BsonDocument> RunCommandAsync(string db, BsonDocument command, CancellationToken ct);

    /// <summary><c>listDatabases</c> (with sizes); <paramref name="authorizedOnly"/> sets <c>authorizedDatabases: true</c>.</summary>
    Task<IReadOnlyList<BsonDocument>> ListDatabasesAsync(bool authorizedOnly, CancellationToken ct);

    /// <summary><c>listCollections</c> documents ({ name, type, options, info }).</summary>
    Task<IReadOnlyList<BsonDocument>> ListCollectionsAsync(string db, BsonDocument? filter, CancellationToken ct);

    Task<IReadOnlyList<BsonDocument>> FindAsync(string db, string coll, FindSpec spec, CancellationToken ct);

    /// <summary>Streams a find (exports).</summary>
    IAsyncEnumerable<BsonDocument> FindStreamAsync(string db, string coll, FindSpec spec, CancellationToken ct);

    Task<long> CountDocumentsAsync(string db, string coll, BsonDocument filter, TimeSpan? maxTime, CancellationToken ct);

    Task<long> EstimatedCountAsync(string db, string coll, TimeSpan? maxTime, CancellationToken ct);

    /// <summary>Runs a pipeline; a pipeline ending in <c>$out</c>/<c>$merge</c> is executed and returns no documents.</summary>
    Task<IReadOnlyList<BsonDocument>> AggregateAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec, CancellationToken ct);

    IAsyncEnumerable<BsonDocument> AggregateStreamAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec, CancellationToken ct);

    /// <summary>Inserts documents; per-document failures are returned (not thrown).</summary>
    Task<InsertManyResult> InsertManyAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, bool ordered, CancellationToken ct);

    Task<ReplaceResult> ReplaceOneAsync(string db, string coll, BsonDocument filter, BsonDocument doc, bool upsert, CancellationToken ct);

    /// <summary>Replace-one-by-key with upsert for every document (import upsert mode).</summary>
    Task<BulkUpsertResult> BulkUpsertAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, string key, bool ordered, CancellationToken ct);

    Task<long> DeleteManyAsync(string db, string coll, BsonDocument filter, CancellationToken ct);

    Task<IReadOnlyList<BsonDocument>> ListIndexesAsync(string db, string coll, CancellationToken ct);

    /// <summary>Builds one index from its full spec (<c>{ key, name, unique?, … }</c>); completes when the build finished.</summary>
    Task<string> CreateIndexAsync(string db, string coll, BsonDocument indexSpec, CancellationToken ct);

    Task DropIndexAsync(string db, string coll, string name, CancellationToken ct);

    /// <summary><c>create</c> with the command options (capped, size, max, timeseries, validator, viewOn, pipeline …).</summary>
    Task CreateCollectionAsync(string db, string name, BsonDocument options, CancellationToken ct);

    Task DropCollectionAsync(string db, string coll, CancellationToken ct);

    Task DropDatabaseAsync(string db, CancellationToken ct);

    Task RenameCollectionAsync(string db, string coll, string newName, bool dropTarget, CancellationToken ct);

    /// <summary>Change stream of a collection (or a database when <paramref name="coll"/> is null), raw change events.</summary>
    IAsyncEnumerable<BsonDocument> WatchAsync(string db, string? coll, bool fullDocumentUpdateLookup, CancellationToken ct);
}
