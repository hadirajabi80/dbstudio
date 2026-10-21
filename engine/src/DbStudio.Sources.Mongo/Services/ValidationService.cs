using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>Collection validation rules (docs/PLAN-M2.md 6.5): read from listCollections options, written with collMod.</summary>
public sealed class ValidationService
{
    public async Task<MongoValidation> GetAsync(MongoClientHandle h, string db, string coll, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        var list = await h.Gateway.ListCollectionsAsync(db, new BsonDocument("name", coll), ct).ConfigureAwait(false);
        if (list.Count == 0) throw DbStudio.Core.Services.EngineException.NotFound($"Collection '{db}.{coll}'");
        var options = list[0].GetValue("options", new BsonDocument()) as BsonDocument ?? [];
        var validator = options.GetValue("validator", BsonNull.Value) as BsonDocument;
        return new MongoValidation
        {
            Validator = validator is { ElementCount: > 0 } ? Ejson.Canonical(validator) : null,
            Level = options.GetValue("validationLevel", BsonNull.Value) is BsonString l ? l.Value : "strict",
            Action = options.GetValue("validationAction", BsonNull.Value) is BsonString a ? a.Value : "error",
        };
    }

    public async Task<MongoValidation> SetAsync(MongoClientHandle h, string db, string coll, MongoValidation req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        h.EnsureWritable("change validation");
        var level = req.Level ?? "strict";
        var action = req.Action ?? "error";
        if (level is not ("off" or "strict" or "moderate")) throw MongoValidate.Fail("level", "level is off, strict or moderate.");
        if (action is not ("error" or "warn" or "errorAndLog")) throw MongoValidate.Fail("action", "action is error, warn or errorAndLog.");
        var validator = string.IsNullOrWhiteSpace(req.Validator) ? new BsonDocument() : ShellJson.ParseDocument(req.Validator, "validator");
        await h.Gateway.RunCommandAsync(db, new BsonDocument
        {
            { "collMod", coll }, { "validator", validator }, { "validationLevel", level }, { "validationAction", action },
        }, ct).ConfigureAwait(false);
        return await GetAsync(h, db, coll, ct).ConfigureAwait(false);
    }
}
