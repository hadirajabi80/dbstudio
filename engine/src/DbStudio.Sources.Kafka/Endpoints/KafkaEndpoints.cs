using System.Text.Json;
using Confluent.Kafka;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Deserializers;
using DbStudio.Sources.Kafka.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Sources.Kafka.Endpoints;

public static class KafkaEndpointsHelpers
{
    public const string ClientHeader = "X-DbStudio-Client";

    /// <summary>The connection's Kafka client (opens lazily; 503 SOURCE_UNAVAILABLE; 400 when the connection is not Kafka).</summary>
    public static async Task<KafkaClientHandle> HandleAsync(SourceClientManager clients, string cid, CancellationToken ct) =>
        await clients.GetAsync(cid, ct).ConfigureAwait(false) as KafkaClientHandle
            ?? throw EngineException.Validation($"Connection '{cid}' is not a Kafka connection.", new { field = "connectionId" });

    public static string? ClientId(HttpContext http) => ClientPresence.Normalize(http.Request.Headers[ClientHeader].ToString());

    /// <summary>Route values keep an encoded '/' as %2F (group ids and subjects may contain '/').</summary>
    public static string Segment(string value) => value.Replace("%2F", "/", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// REST surface of the Kafka source (docs/PLAN-M2.md 7.2–7.5) under <c>/api/v1/kafka/{cid}</c>, plus
/// <c>GET /api/v1/kafka/library</c> (librdkafka version: loads the native library, used by the native smoke, D8).
/// Writes (create/alter/partitions/delete/purge/produce/offset reset/delete group) answer 403 READ_ONLY on read-only
/// connections.
/// </summary>
public static class KafkaEndpoints
{
    public static RouteGroupBuilder MapKafka(this RouteGroupBuilder api)
    {
        api.MapGet("/kafka/library", () => new KafkaLibraryInfo(KafkaNative.Version, Library.Version,
            Library.DebugContexts?.ToList() ?? [], KafkaNative.LoadedFrom));

        var g = api.MapGroup("/kafka/{cid}");
        g.AddEndpointFilter(async (ctx, next) =>
        {
            try { return await next(ctx).ConfigureAwait(false); }
            catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex); }
        });

        g.MapGet("/cluster", async (string cid, SourceClientManager clients, ClusterService cluster, CancellationToken ct) =>
            await cluster.ClusterAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), ct));

        g.MapGet("/brokers/{brokerId:int}/configs", async (string cid, int brokerId, SourceClientManager clients, ClusterService cluster, CancellationToken ct) =>
            await cluster.BrokerConfigsAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), brokerId, ct));

        // ---- topics
        g.MapGet("/topics", async (string cid, bool? includeInternal, SourceClientManager clients, TopicService topics, CancellationToken ct) =>
            await topics.ListAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), includeInternal ?? false, ct));

        g.MapPost("/topics", async (string cid, KafkaCreateTopicRequest? req, SourceClientManager clients, TopicService topics, CancellationToken ct) =>
        {
            await topics.CreateAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), req, ct);
            return Results.NoContent();
        });

        g.MapGet("/topics/{topic}", async (string cid, string topic, SourceClientManager clients, TopicService topics, CancellationToken ct) =>
            await topics.DetailAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), ct));

        g.MapPut("/topics/{topic}/configs", async (string cid, string topic, KafkaAlterConfigsRequest? req, SourceClientManager clients, TopicService topics,
            CancellationToken ct) =>
        {
            await topics.AlterConfigsAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), req, ct);
            return Results.NoContent();
        });

        g.MapPost("/topics/{topic}/partitions", async (string cid, string topic, KafkaAddPartitionsRequest? req, SourceClientManager clients,
            TopicService topics, CancellationToken ct) =>
        {
            await topics.AddPartitionsAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), req, ct);
            return Results.NoContent();
        });

        g.MapDelete("/topics/{topic}", async (string cid, string topic, SourceClientManager clients, TopicService topics, CancellationToken ct) =>
        {
            await topics.DeleteAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), ct);
            return Results.NoContent();
        });

        g.MapPost("/topics/{topic}/purge", async (string cid, string topic, KafkaPurgeRequest? req, SourceClientManager clients, TopicService topics,
            CancellationToken ct) =>
            await topics.PurgeAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), req, ct));

        // ---- messages
        g.MapPost("/topics/{topic}/messages", async (string cid, string topic, KafkaFetchRequest? req, HttpContext http, SourceClientManager clients,
            StreamManager streams, JobManager jobs, FetchRelays relays, MessageBrowser browser, CancellationToken ct) =>
        {
            var options = FetchOptions.From(req);
            var name = TopicService.ValidateName(topic, "topic");
            var h = await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct);
            await TopicService.TopicMetaAsync(h, name, ct); // 404 before anything starts
            var owner = KafkaEndpointsHelpers.ClientId(http);
            var relay = relays.Register();
            StreamInfo stream;
            try
            {
                stream = await streams.OpenAsync("kafka.fetch", cid, JsonSerializer.SerializeToElement(new { token = relay.Token, topic = name }), owner, ct);
            }
            catch
            {
                relays.Forget(relay);
                throw;
            }
            var jobId = jobs.Start("kafka.fetch", cid, owner, async (ctx, jct) =>
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(jct, relay.Closed);
                try
                {
                    var sink = await relay.Sink.WaitAsync(linked.Token);
                    // The UI subscribes to the stream id from this 202 response; give it a moment before the first batch.
                    await Task.Delay(150, linked.Token);
                    return await browser.FetchAsync(h, name, options, m => sink.Push(m), (d, t, m) => ctx.Report(d, t, m), linked.Token);
                }
                catch (OperationCanceledException) when (relay.Closed.IsCancellationRequested && !jct.IsCancellationRequested)
                {
                    return null; // the stream was closed by the UI
                }
                finally
                {
                    relay.Complete();
                }
            });
            return Results.Json(new KafkaFetchStarted(jobId, stream.StreamId), CoreJson.Options, statusCode: 202);
        });

        g.MapGet("/topics/{topic}/messages/{partition:int}/{offset:long}", async (string cid, string topic, int partition, long offset, string? keyFormat,
            string? valueFormat, SourceClientManager clients, MessageBrowser browser, CancellationToken ct) =>
            await browser.GetAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), partition, offset,
                KafkaFormats.Decoder(keyFormat, "keyFormat", "string"), KafkaFormats.Decoder(valueFormat, "valueFormat"), ct));

        g.MapPost("/topics/{topic}/produce", async (string cid, string topic, KafkaProduceRequest? req, SourceClientManager clients, ProduceService producer,
            CancellationToken ct) =>
            await producer.ProduceAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), TopicService.ValidateName(topic, "topic"), req, ct));

        // ---- consumer groups
        g.MapGet("/groups", async (string cid, SourceClientManager clients, GroupService groups, CancellationToken ct) =>
            await groups.ListAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), ct));

        g.MapGet("/groups/{groupId}", async (string cid, string groupId, SourceClientManager clients, GroupService groups, CancellationToken ct) =>
            await groups.DetailAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), KafkaEndpointsHelpers.Segment(groupId), ct));

        g.MapPost("/groups/{groupId}/offsets", async (string cid, string groupId, KafkaOffsetResetRequest? req, SourceClientManager clients, GroupService groups,
            CancellationToken ct) =>
            await groups.ResetAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), KafkaEndpointsHelpers.Segment(groupId), req, ct));

        g.MapDelete("/groups/{groupId}", async (string cid, string groupId, SourceClientManager clients, GroupService groups, CancellationToken ct) =>
        {
            await groups.DeleteAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), KafkaEndpointsHelpers.Segment(groupId), ct);
            return Results.NoContent();
        });

        // ---- schema registry
        g.MapGet("/schemas/subjects", async (string cid, SourceClientManager clients, SchemaService schemas, CancellationToken ct) =>
            await schemas.SubjectsAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), ct));

        g.MapGet("/schemas/subjects/{subject}/versions/{version}", async (string cid, string subject, string version, SourceClientManager clients,
            SchemaService schemas, CancellationToken ct) =>
            await schemas.VersionAsync(await KafkaEndpointsHelpers.HandleAsync(clients, cid, ct), KafkaEndpointsHelpers.Segment(subject), version, ct));

        return api;
    }
}
