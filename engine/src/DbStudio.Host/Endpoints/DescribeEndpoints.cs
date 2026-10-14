using DbStudio.Core.Catalog;
using DbStudio.Core.Params;
using DbStudio.Core.Sample;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

/// <summary>M1.5: POST /sessions/{sid}/describe and POST /sample-db (docs/PLAN-M1.5.md 3.8).</summary>
public static class DescribeEndpoints
{
    public static RouteGroupBuilder MapDescribe(this RouteGroupBuilder api)
    {
        api.MapPost("/sessions/{sid}/describe", (string sid, DescribeRequestDto? req, DescribeService describe, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("A request body is required.");
            return describe.DescribeAsync(sid, req.Sql, req.Params, ct);
        });
        return api;
    }

    public static RouteGroupBuilder MapSampleDb(this RouteGroupBuilder api)
    {
        api.MapPost("/sample-db", async (SampleDbRequestDto? req, SampleDatabase sample, SessionManager sessions, CatalogService catalog, CancellationToken ct) =>
        {
            var reset = req?.Reset ?? false;
            if (reset && sample.FindProfile() is { } existing)
            {
                // The file is replaced: close sessions that hold it open and forget cached metadata.
                await sessions.CloseAllForConnectionAsync(existing.Id);
                catalog.Forget(existing.Id);
            }
            return await sample.EnsureAsync(reset, ct);
        });
        return api;
    }
}
