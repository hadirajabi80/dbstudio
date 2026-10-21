using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>Documents view (docs/PLAN-M2.md 6.3): find with counts, single document, insert / replace / delete.</summary>
public sealed class DocumentsService
{
    public const int MaxLimit = 1000;

    /// <summary>maxTimeMS of the filtered countDocuments (2 s); on expiry the count falls back to an estimate.</summary>
    public TimeSpan CountMaxTime { get; init; } = TimeSpan.FromSeconds(2);

    public static FindSpec ParseFind(MongoFindRequest req, int maxLimit = MaxLimit)
    {
        MongoValidate.Range(req.Skip, 0, int.MaxValue, "skip");
        MongoValidate.Range(req.Limit, 1, maxLimit, "limit");
        var filter = ShellJson.ParseDocument(req.Filter, "filter");
        var projection = ShellJson.ParseDocument(req.Projection, "projection");
        var sort = ShellJson.ParseDocument(req.Sort, "sort");
        var collation = ShellJson.ParseDocument(req.Collation, "collation");
        if (collation.ElementCount > 0 && !collation.Contains("locale"))
            throw MongoValidate.Fail("collation", "A collation needs a locale, e.g. { locale: \"en\", strength: 2 }.");
        return new FindSpec(filter, NullIfEmpty(projection), NullIfEmpty(sort), req.Skip, req.Limit, NullIfEmpty(collation),
            MongoValidate.MaxTime(req.MaxTimeMs, 30_000));
    }

    internal static BsonDocument? NullIfEmpty(BsonDocument d) => d.ElementCount == 0 ? null : d;

    public async Task<MongoFindResponse> FindAsync(MongoClientHandle h, string db, string coll, MongoFindRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        var spec = ParseFind(req);
        var docsTask = h.Gateway.FindAsync(db, coll, spec, ct);
        var countTask = CountAsync(h, db, coll, spec.Filter, spec.Collation, ct);
        var docs = await docsTask.ConfigureAwait(false);
        MongoCount count;
        try
        {
            count = await countTask.ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException && !MongoErrors.IsConnectionFailure(ex))
        {
            count = new MongoCount(spec.Skip + docs.Count, false);
        }
        return new MongoFindResponse(docs.Select(d => Ejson.Canonical(d, truncate: true)).ToList(), count);
    }

    /// <summary>
    /// Unfiltered collections: estimatedDocumentCount (exact). Filtered: countDocuments with maxTimeMS 2000; on expiry an
    /// estimate with <c>exact: false</c>. Views (and time series) always use countDocuments.
    /// </summary>
    public async Task<MongoCount> CountAsync(MongoClientHandle h, string db, string coll, BsonDocument filter, BsonDocument? collation, CancellationToken ct)
    {
        var type = await h.CollectionTypeAsync(db, coll, ct).ConfigureAwait(false);
        var plain = type == "collection";
        if (plain && filter.ElementCount == 0)
            return new MongoCount(await h.Gateway.EstimatedCountAsync(db, coll, CountMaxTime, ct).ConfigureAwait(false), true);
        try
        {
            return new MongoCount(await h.Gateway.CountDocumentsAsync(db, coll, filter, CountMaxTime, ct).ConfigureAwait(false), true);
        }
        catch (Exception ex) when (MongoErrors.IsTimeout(ex) && plain)
        {
            return new MongoCount(await h.Gateway.EstimatedCountAsync(db, coll, CountMaxTime, ct).ConfigureAwait(false), false);
        }
    }

    public async Task<MongoDocResponse> GetAsync(MongoClientHandle h, string db, string coll, string? idText, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        if (string.IsNullOrWhiteSpace(idText)) throw MongoValidate.Fail("_id", "The _id query parameter is required.");
        var id = ShellJson.Parse(idText, "_id");
        var docs = await h.Gateway.FindAsync(db, coll, new FindSpec(new BsonDocument("_id", id), Limit: 1), ct).ConfigureAwait(false);
        return new MongoDocResponse(docs.Count == 0 ? null : Ejson.Canonical(docs[0]));
    }

    public async Task<MongoInsertResponse> InsertAsync(MongoClientHandle h, string db, string coll, MongoInsertRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("insert documents");
        if (string.IsNullOrWhiteSpace(req.Doc)) throw MongoValidate.Fail("doc", "The document is required.");
        var doc = ShellJson.ParseDocument(req.Doc, "doc");
        if (!doc.TryGetValue("_id", out var id))
        {
            id = ObjectId.GenerateNewId();
            doc.InsertAt(0, new BsonElement("_id", id));
        }
        var r = await h.Gateway.InsertManyAsync(db, coll, [doc], ordered: true, ct).ConfigureAwait(false);
        if (r.Errors.Count > 0) throw WriteError(r.Errors[0]);
        return new MongoInsertResponse(Ejson.Canonical(id));
    }

    internal static EngineException WriteError(WriteFailure f) =>
        new(422, ErrorCodes.ProviderError, f.Message, new { providerCode = (int?)f.Code, codeName = f.Code == MongoErrors.DuplicateKey ? "DuplicateKey" : null });

    public async Task<MongoReplaceResponse> ReplaceAsync(MongoClientHandle h, string db, string coll, MongoReplaceRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("replace a document");
        if (string.IsNullOrWhiteSpace(req.Id)) throw MongoValidate.Fail("_id", "_id is required.");
        if (string.IsNullOrWhiteSpace(req.Doc)) throw MongoValidate.Fail("doc", "The document is required.");
        if (!req.Replace) throw MongoValidate.Fail("replace", "Only full-document replacement (replace: true) is supported.");
        var id = ShellJson.Parse(req.Id, "_id");
        var doc = ShellJson.ParseDocument(req.Doc, "doc");
        if (doc.TryGetValue("_id", out var docId))
        {
            if (!BsonKit.ValueEquals(docId, id) || docId.BsonType != id.BsonType)
                throw MongoValidate.Fail("doc._id", "The document's _id differs from the edited document: changing _id needs insert + delete.");
        }
        else
        {
            doc.InsertAt(0, new BsonElement("_id", id));
        }
        var r = await h.Gateway.ReplaceOneAsync(db, coll, new BsonDocument("_id", id), doc, upsert: false, ct).ConfigureAwait(false);
        return new MongoReplaceResponse(r.Matched, r.Modified);
    }

    public async Task<MongoDeleteResponse> DeleteAsync(MongoClientHandle h, string db, string coll, MongoDeleteRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("delete documents");
        if (req.Ids is not { Count: > 0 }) throw MongoValidate.Fail("ids", "At least one _id is required.");
        if (req.Ids.Count > 10_000) throw MongoValidate.Fail("ids", "At most 10,000 documents can be deleted at once.");
        var ids = new BsonArray(req.Ids.Select((t, i) => ShellJson.Parse(t, $"ids[{i}]")));
        var n = await h.Gateway.DeleteManyAsync(db, coll, new BsonDocument("_id", new BsonDocument("$in", ids)), ct).ConfigureAwait(false);
        return new MongoDeleteResponse(n);
    }
}
