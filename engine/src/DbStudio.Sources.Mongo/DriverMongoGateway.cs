using System.Runtime.CompilerServices;
using MongoDB.Bson;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary><see cref="IMongoGateway"/> over MongoDB.Driver 3.x (untyped <see cref="BsonDocument"/> collections).</summary>
public sealed class DriverMongoGateway(IMongoClient client) : IMongoGateway
{
    public IMongoClient? Client => client;

    private IMongoDatabase Db(string db) => client.GetDatabase(db);

    private IMongoCollection<BsonDocument> Coll(string db, string coll) => client.GetDatabase(db).GetCollection<BsonDocument>(coll);

    public Task<BsonDocument> RunCommandAsync(string db, BsonDocument command, CancellationToken ct) =>
        Db(db).RunCommandAsync(new BsonDocumentCommand<BsonDocument>(command), ReadPreference.Primary, ct);

    public async Task<IReadOnlyList<BsonDocument>> ListDatabasesAsync(bool authorizedOnly, CancellationToken ct)
    {
        using var cursor = await client.ListDatabasesAsync(new ListDatabasesOptions { AuthorizedDatabases = authorizedOnly ? true : null }, ct)
            .ConfigureAwait(false);
        return await cursor.ToListAsync(ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<BsonDocument>> ListCollectionsAsync(string db, BsonDocument? filter, CancellationToken ct)
    {
        var options = new ListCollectionsOptions();
        if (filter is not null) options.Filter = new BsonDocumentFilterDefinition<BsonDocument>(filter);
        using var cursor = await Db(db).ListCollectionsAsync(options, ct).ConfigureAwait(false);
        return await cursor.ToListAsync(ct).ConfigureAwait(false);
    }

    private static FindOptions<BsonDocument, BsonDocument> FindOptions(FindSpec spec, int? batchSize = null)
    {
        var o = new FindOptions<BsonDocument, BsonDocument>
        {
            Skip = spec.Skip > 0 ? spec.Skip : null,
            Limit = spec.Limit,
            MaxTime = spec.MaxTime,
            BatchSize = batchSize,
        };
        if (spec.Projection is { ElementCount: > 0 } p) o.Projection = new BsonDocumentProjectionDefinition<BsonDocument, BsonDocument>(p);
        if (spec.Sort is { ElementCount: > 0 } s) o.Sort = new BsonDocumentSortDefinition<BsonDocument>(s);
        if (spec.Collation is { ElementCount: > 0 } c) o.Collation = Collation.FromBsonDocument(c);
        return o;
    }

    public async Task<IReadOnlyList<BsonDocument>> FindAsync(string db, string coll, FindSpec spec, CancellationToken ct)
    {
        using var cursor = await Coll(db, coll).FindAsync(new BsonDocumentFilterDefinition<BsonDocument>(spec.Filter), FindOptions(spec), ct)
            .ConfigureAwait(false);
        return await cursor.ToListAsync(ct).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<BsonDocument> FindStreamAsync(string db, string coll, FindSpec spec, [EnumeratorCancellation] CancellationToken ct)
    {
        using var cursor = await Coll(db, coll).FindAsync(new BsonDocumentFilterDefinition<BsonDocument>(spec.Filter), FindOptions(spec, 1000), ct)
            .ConfigureAwait(false);
        while (await cursor.MoveNextAsync(ct).ConfigureAwait(false))
            foreach (var d in cursor.Current)
                yield return d;
    }

    public Task<long> CountDocumentsAsync(string db, string coll, BsonDocument filter, TimeSpan? maxTime, CancellationToken ct) =>
        Coll(db, coll).CountDocumentsAsync(new BsonDocumentFilterDefinition<BsonDocument>(filter), new CountOptions { MaxTime = maxTime }, ct);

    public Task<long> EstimatedCountAsync(string db, string coll, TimeSpan? maxTime, CancellationToken ct) =>
        Coll(db, coll).EstimatedDocumentCountAsync(new EstimatedDocumentCountOptions { MaxTime = maxTime }, ct);

    private static AggregateOptions AggOptions(AggregateSpec spec, int? batchSize = null)
    {
        var o = new AggregateOptions { AllowDiskUse = spec.AllowDiskUse ? true : null, MaxTime = spec.MaxTime, BatchSize = batchSize };
        if (spec.Collation is { ElementCount: > 0 } c) o.Collation = Collation.FromBsonDocument(c);
        return o;
    }

    internal static bool EndsWithWriteStage(IReadOnlyList<BsonDocument> pipeline) =>
        pipeline.Count > 0 && pipeline[^1].ElementCount == 1 && pipeline[^1].GetElement(0).Name is "$out" or "$merge";

    public async Task<IReadOnlyList<BsonDocument>> AggregateAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec,
        CancellationToken ct)
    {
        var def = PipelineDefinition<BsonDocument, BsonDocument>.Create(pipeline);
        if (EndsWithWriteStage(pipeline))
        {
            await Coll(db, coll).AggregateToCollectionAsync(def, AggOptions(spec), ct).ConfigureAwait(false);
            return [];
        }
        using var cursor = await Coll(db, coll).AggregateAsync(def, AggOptions(spec), ct).ConfigureAwait(false);
        return await cursor.ToListAsync(ct).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<BsonDocument> AggregateStreamAsync(string db, string coll, IReadOnlyList<BsonDocument> pipeline, AggregateSpec spec,
        [EnumeratorCancellation] CancellationToken ct)
    {
        using var cursor = await Coll(db, coll).AggregateAsync(PipelineDefinition<BsonDocument, BsonDocument>.Create(pipeline), AggOptions(spec, 1000), ct)
            .ConfigureAwait(false);
        while (await cursor.MoveNextAsync(ct).ConfigureAwait(false))
            foreach (var d in cursor.Current)
                yield return d;
    }

    public async Task<InsertManyResult> InsertManyAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, bool ordered, CancellationToken ct)
    {
        if (docs.Count == 0) return new InsertManyResult(0, []);
        var models = docs.Select(d => (WriteModel<BsonDocument>)new InsertOneModel<BsonDocument>(d)).ToList();
        try
        {
            var r = await Coll(db, coll).BulkWriteAsync(models, new BulkWriteOptions { IsOrdered = ordered }, ct).ConfigureAwait(false);
            return new InsertManyResult(r.InsertedCount, []);
        }
        catch (MongoBulkWriteException<BsonDocument> ex)
        {
            return new InsertManyResult(ex.Result.InsertedCount, ex.WriteErrors.Select(e => new WriteFailure(e.Index, e.Code, e.Message)).ToList());
        }
    }

    public async Task<ReplaceResult> ReplaceOneAsync(string db, string coll, BsonDocument filter, BsonDocument doc, bool upsert, CancellationToken ct)
    {
        var r = await Coll(db, coll).ReplaceOneAsync(new BsonDocumentFilterDefinition<BsonDocument>(filter), doc, new ReplaceOptions { IsUpsert = upsert }, ct)
            .ConfigureAwait(false);
        return new ReplaceResult(r.IsAcknowledged ? r.MatchedCount : 0, r.IsAcknowledged && r.IsModifiedCountAvailable ? r.ModifiedCount : 0,
            r.IsAcknowledged ? r.UpsertedId : null);
    }

    public async Task<BulkUpsertResult> BulkUpsertAsync(string db, string coll, IReadOnlyList<BsonDocument> docs, string key, bool ordered, CancellationToken ct)
    {
        if (docs.Count == 0) return new BulkUpsertResult(0, 0, 0, []);
        var models = docs.Select(d => (WriteModel<BsonDocument>)new ReplaceOneModel<BsonDocument>(
            new BsonDocumentFilterDefinition<BsonDocument>(new BsonDocument(key, BsonKit.GetPath(d, key) ?? BsonNull.Value)), d) { IsUpsert = true }).ToList();
        try
        {
            var r = await Coll(db, coll).BulkWriteAsync(models, new BulkWriteOptions { IsOrdered = ordered }, ct).ConfigureAwait(false);
            return new BulkUpsertResult(r.Upserts.Count, r.MatchedCount, r.IsModifiedCountAvailable ? r.ModifiedCount : 0, []);
        }
        catch (MongoBulkWriteException<BsonDocument> ex)
        {
            var r = ex.Result;
            return new BulkUpsertResult(r.Upserts.Count, r.MatchedCount, r.IsModifiedCountAvailable ? r.ModifiedCount : 0,
                ex.WriteErrors.Select(e => new WriteFailure(e.Index, e.Code, e.Message)).ToList());
        }
    }

    public async Task<long> DeleteManyAsync(string db, string coll, BsonDocument filter, CancellationToken ct)
    {
        var r = await Coll(db, coll).DeleteManyAsync(new BsonDocumentFilterDefinition<BsonDocument>(filter), ct).ConfigureAwait(false);
        return r.IsAcknowledged ? r.DeletedCount : 0;
    }

    public async Task<IReadOnlyList<BsonDocument>> ListIndexesAsync(string db, string coll, CancellationToken ct)
    {
        using var cursor = await Coll(db, coll).Indexes.ListAsync(ct).ConfigureAwait(false);
        return await cursor.ToListAsync(ct).ConfigureAwait(false);
    }

    public async Task<string> CreateIndexAsync(string db, string coll, BsonDocument indexSpec, CancellationToken ct)
    {
        await RunCommandAsync(db, new BsonDocument { { "createIndexes", coll }, { "indexes", new BsonArray { indexSpec } } }, ct).ConfigureAwait(false);
        return indexSpec["name"].AsString;
    }

    public Task DropIndexAsync(string db, string coll, string name, CancellationToken ct) => Coll(db, coll).Indexes.DropOneAsync(name, ct);

    public Task CreateCollectionAsync(string db, string name, BsonDocument options, CancellationToken ct)
    {
        var cmd = new BsonDocument("create", name);
        cmd.AddRange(options);
        return RunCommandAsync(db, cmd, ct);
    }

    public Task DropCollectionAsync(string db, string coll, CancellationToken ct) => Db(db).DropCollectionAsync(coll, ct);

    public Task DropDatabaseAsync(string db, CancellationToken ct) => client.DropDatabaseAsync(db, ct);

    public Task RenameCollectionAsync(string db, string coll, string newName, bool dropTarget, CancellationToken ct) =>
        Db(db).RenameCollectionAsync(coll, newName, new RenameCollectionOptions { DropTarget = dropTarget }, ct);

    public async IAsyncEnumerable<BsonDocument> WatchAsync(string db, string? coll, bool fullDocumentUpdateLookup, [EnumeratorCancellation] CancellationToken ct)
    {
        var options = new ChangeStreamOptions
        {
            FullDocument = fullDocumentUpdateLookup ? ChangeStreamFullDocumentOption.UpdateLookup : ChangeStreamFullDocumentOption.Default,
            MaxAwaitTime = TimeSpan.FromSeconds(1),
        };
        var pipeline = new EmptyPipelineDefinition<ChangeStreamDocument<BsonDocument>>()
            .As<ChangeStreamDocument<BsonDocument>, ChangeStreamDocument<BsonDocument>, BsonDocument>();
        using var cursor = coll is null
            ? await Db(db).WatchAsync(pipeline, options, ct).ConfigureAwait(false)
            : await Coll(db, coll).WatchAsync(pipeline, options, ct).ConfigureAwait(false);
        while (await cursor.MoveNextAsync(ct).ConfigureAwait(false))
            foreach (var d in cursor.Current)
                yield return d;
    }

    public ValueTask DisposeAsync()
    {
        client.Dispose();
        return ValueTask.CompletedTask;
    }
}
