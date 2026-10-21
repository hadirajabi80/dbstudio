using System.Globalization;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>
/// Stream kind <c>mongo.changes</c> (docs/PLAN-M2.md 2.4, 6.5): params <c>{ db, coll?, fullDocument: "updateLookup" | "default" }</c>;
/// items <see cref="MongoChangeItem"/>. Server errors (a standalone server has no change streams) end the stream with the message.
/// </summary>
public sealed class MongoChangeStreamFactory(SourceClientManager clients) : IStreamFactory
{
    public async Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var db = MongoValidate.Db(ctx.GetString("db", required: true), "params.db");
        var coll = ctx.GetString("coll");
        if (coll is not null) MongoValidate.Coll(coll, "params.coll");
        var full = ctx.GetString("fullDocument") ?? "default";
        if (full is not ("updateLookup" or "default")) throw MongoValidate.Fail("params.fullDocument", "fullDocument is updateLookup or default.");
        if (ctx.Profile is { } p && p.ProviderId != "mongodb")
            throw MongoValidate.Fail("connectionId", "mongo.changes streams need a MongoDB connection.");
        var client = await clients.GetAsync(ctx.ConnectionId, ct).ConfigureAwait(false);
        if (client is not MongoClientHandle h) throw MongoValidate.Fail("connectionId", "mongo.changes streams need a MongoDB connection.");
        return new MongoChangeStream(h, db, coll, full == "updateLookup");
    }
}

public sealed class MongoChangeStream(MongoClientHandle handle, string db, string? coll, bool updateLookup) : IEngineStream
{
    public async Task RunAsync(IStreamSink sink, CancellationToken ct)
    {
        try
        {
            await foreach (var change in handle.Gateway.WatchAsync(db, coll, updateLookup, ct).ConfigureAwait(false))
                sink.Push(ToItem(change));
        }
        catch (Exception ex) when (ex is not OperationCanceledException && MongoErrors.CodeOf(ex) == MongoErrors.ChangeStreamNeedsReplicaSet)
        {
            throw new InvalidOperationException($"Change streams need a replica set or a sharded cluster: {ex.Message}", ex);
        }
    }

    public static MongoChangeItem ToItem(BsonDocument change)
    {
        string ts;
        if (change.GetValue("wallTime", BsonNull.Value) is BsonDateTime wall) ts = ImportExportService.IsoDate(wall);
        else if (change.GetValue("clusterTime", BsonNull.Value) is BsonTimestamp t)
            ts = DateTimeOffset.FromUnixTimeSeconds(t.Timestamp).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        else ts = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

        var ns = change.GetValue("ns", BsonNull.Value) as BsonDocument;
        var nsItem = new MongoChangeNs(ns?.GetValue("db", "").ToString() ?? "",
            ns is not null && ns.TryGetValue("coll", out var c) && c.IsString ? c.AsString : null);

        MongoUpdateDescription? update = null;
        if (change.GetValue("updateDescription", BsonNull.Value) is BsonDocument ud)
            update = new MongoUpdateDescription(
                Ejson.Canonical(ud.GetValue("updatedFields", new BsonDocument()), truncate: true),
                ud.GetValue("removedFields", new BsonArray()).AsBsonArray.Select(x => x.ToString() ?? "").ToList());

        return new MongoChangeItem(ts, change.GetValue("operationType", "unknown").ToString()!, nsItem,
            change.TryGetValue("documentKey", out var key) && !key.IsBsonNull ? Ejson.Canonical(key) : null,
            change.TryGetValue("fullDocument", out var full) && !full.IsBsonNull ? Ejson.Canonical(full, truncate: true) : null,
            update);
    }
}
