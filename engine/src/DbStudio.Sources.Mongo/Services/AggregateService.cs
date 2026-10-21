using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>
/// Aggregation builder (docs/PLAN-M2.md 6.4): full runs and per-stage previews. Previews never execute <c>$out</c> /
/// <c>$merge</c>; a full run with a write stage is READ_ONLY-guarded and returns no documents.
/// </summary>
public sealed class AggregateService
{
    public const int MaxLimit = 1000;

    /// <summary>The stages that run for a request (preview slice, write stage dropped from previews).</summary>
    public static (List<BsonDocument> Stages, bool WriteStageSkipped, bool WriteStage) Plan(IReadOnlyList<BsonDocument> pipeline, int? previewStage)
    {
        var stages = pipeline.ToList();
        var skipped = false;
        if (previewStage is { } n)
        {
            if (n < 0 || n >= Math.Max(1, stages.Count))
                throw MongoValidate.Fail("previewStage", $"previewStage must be between 0 and {Math.Max(0, stages.Count - 1)}.");
            if (stages.Count > 0) stages = stages.Take(n + 1).ToList();
            if (stages.Count > 0 && MongoValidate.IsWriteStage(stages[^1]))
            {
                stages.RemoveAt(stages.Count - 1);
                skipped = true;
            }
        }
        var write = stages.Count > 0 && MongoValidate.IsWriteStage(stages[^1]);
        return (stages, skipped, write);
    }

    public async Task<MongoAggregateResponse> RunAsync(MongoClientHandle h, string db, string coll, MongoAggregateRequest req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        MongoValidate.Coll(coll);
        MongoValidate.Range(req.Limit, 1, MaxLimit, "limit");
        MongoValidate.Range(req.Skip, 0, int.MaxValue, "skip");
        var maxTime = MongoValidate.MaxTime(req.MaxTimeMs, req.PreviewStage is null ? 60_000 : 10_000);
        var pipeline = MongoValidate.Pipeline(req.Pipeline);
        var (stages, skipped, write) = Plan(pipeline, req.PreviewStage);
        var spec = new AggregateSpec(req.AllowDiskUse, maxTime);
        if (write)
        {
            h.EnsureWritable("run $out/$merge");
            await h.Gateway.AggregateAsync(db, coll, stages, spec, ct).ConfigureAwait(false);
            return new MongoAggregateResponse([], false, skipped ? true : null);
        }
        if (req.Skip > 0) stages.Add(new BsonDocument("$skip", req.Skip));
        stages.Add(new BsonDocument("$limit", req.Limit + 1));
        var docs = await h.Gateway.AggregateAsync(db, coll, stages, spec, ct).ConfigureAwait(false);
        var truncated = docs.Count > req.Limit;
        return new MongoAggregateResponse(docs.Take(req.Limit).Select(d => Ejson.Canonical(d, truncate: true)).ToList(), truncated,
            skipped ? true : null);
    }
}
