using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>
/// The database profiler level (docs/PLAN-M2.md 8.1, the Logs "Profiler" source's setter): read with
/// <c>{ profile: -1 }</c>, written with <c>{ profile: level, slowms, sampleRate }</c> (<c>db.setProfilingLevel</c>).
/// Writing is refused on read-only profiles (403 READ_ONLY "change the profiling level").
/// </summary>
public sealed class ProfilingService
{
    public async Task<MongoProfiling> GetAsync(MongoClientHandle h, string db, CancellationToken ct)
    {
        MongoValidate.Db(db);
        var r = await h.Gateway.RunCommandAsync(db, new BsonDocument("profile", -1), ct).ConfigureAwait(false);
        return new MongoProfiling
        {
            Level = r.GetValue("was", 0).ToInt32(),
            Slowms = r.GetValue("slowms", 100).ToInt32(),
            SampleRate = r.TryGetValue("sampleRate", out var s) && s.IsNumeric ? s.ToDouble() : 1.0,
        };
    }

    public async Task<MongoProfiling> SetAsync(MongoClientHandle h, string db, MongoProfiling req, CancellationToken ct)
    {
        MongoValidate.Db(db);
        if (req.Level is not (0 or 1 or 2)) throw MongoValidate.Fail("level", "level is 0 (off), 1 (slow operations) or 2 (all operations).");
        if (req.Slowms is { } ms) MongoValidate.Range(ms, 0, 3_600_000, "slowms");
        if (req.SampleRate is { } rate && (double.IsNaN(rate) || rate < 0 || rate > 1)) throw MongoValidate.Fail("sampleRate", "sampleRate must be between 0 and 1.");
        h.EnsureWritable("change the profiling level");
        var cmd = new BsonDocument("profile", req.Level.Value);
        if (req.Slowms is { } slow) cmd["slowms"] = slow;
        if (req.SampleRate is { } sample) cmd["sampleRate"] = sample;
        await h.Gateway.RunCommandAsync(db, cmd, ct).ConfigureAwait(false);
        return await GetAsync(h, db, ct).ConfigureAwait(false);
    }
}
