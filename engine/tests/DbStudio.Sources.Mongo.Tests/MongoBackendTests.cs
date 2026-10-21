using System.Text;
using DbStudio.Sources.Mongo.Endpoints;
using DbStudio.Sources.Mongo.Services;
using MongoDB.Bson;
using Testcontainers.MongoDb;

namespace DbStudio.Sources.Mongo.Tests;

/// <summary>
/// Real MongoDB for the integration suite: <c>DBSTUDIO_MONGO_URI</c> when set, else (with <c>DBSTUDIO_IT=1</c>) a
/// Testcontainers <c>mongo:7</c> single-node replica set (<c>--replSet rs0</c>, initiated) so change streams work.
/// </summary>
public static class MongoBackend
{
    public const string Image = "mongo:7";

    private static readonly Lazy<Task<(string? Uri, string? SkipReason)>> s_backend = new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(string? Uri, string? SkipReason)> GetAsync() => s_backend.Value;

    private static async Task<(string?, string?)> StartAsync()
    {
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_MONGO_URI");
        if (!string.IsNullOrWhiteSpace(external)) return (external, null);
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") != "1")
            return (null, "MongoDB integration tests need DBSTUDIO_IT=1 (Docker) or DBSTUDIO_MONGO_URI.");
        try
        {
            // Testcontainers.MongoDb 4.x keeps authentication on for a replica set even with an empty user name (the
            // keyfile it needs turns auth on), and then hands out a connection string without credentials: every write
            // failed with "requires authentication" / a closed stream. Use its default root user, which the URI carries.
            var container = new MongoDbBuilder(Image).WithReplicaSet("rs0").Build();
            await container.StartAsync().ConfigureAwait(false);
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
            };
            var uri = container.GetConnectionString();
            if (!uri.Contains("directConnection=", StringComparison.OrdinalIgnoreCase)) uri += (uri.Contains('?') ? "&" : "?") + "directConnection=true";
            return (uri, null);
        }
        catch (Exception ex)
        {
            return (null, $"Docker/MongoDB container unavailable: {ex.GetType().Name}: {ex.Message}");
        }
    }
}

public sealed class MongoBackendTests : IAsyncLifetime
{
    private MongoClientHandle? _h;
    private readonly string _db = "dbstudio_it_" + Guid.NewGuid().ToString("N")[..8];

    public async Task InitializeAsync()
    {
        var (uri, _) = await MongoBackend.GetAsync();
        if (uri is null) return;
        _h = (MongoClientHandle)await new MongoProvider().OpenAsync(T.Profile(uri), null, CancellationToken.None);
        var docs = Enumerable.Range(1, 300).Select(i => new BsonDocument
        {
            { "_id", i }, { "status", i % 3 == 0 ? "paid" : "open" }, { "total", i * 1.5 }, { "at", new BsonDateTime(1_700_000_000_000L + i * 1000L) },
            { "items", new BsonArray { new BsonDocument { { "sku", $"S{i % 4}" }, { "qty", i % 5 } } } },
        }).ToList();
        await _h.Gateway.InsertManyAsync(_db, "orders", docs, true, CancellationToken.None);
    }

    public async Task DisposeAsync()
    {
        if (_h is null) return;
        try { await _h.Gateway.DropDatabaseAsync(_db, CancellationToken.None); } catch { /* best effort */ }
        await _h.DisposeAsync();
    }

    private async Task<MongoClientHandle> Handle()
    {
        var (uri, skip) = await MongoBackend.GetAsync();
        Skip.If(uri is null, skip);
        return _h!;
    }

    [SkippableFact]
    public async Task Find_count_and_aggregate()
    {
        var h = await Handle();
        var find = await new DocumentsService().FindAsync(h, _db, "orders", new MongoFindRequest { Filter = "{ status: 'paid' }", Sort = "{ total: -1 }", Limit = 5 }, default);
        Assert.Equal(new MongoCount(100, true), find.Count);
        Assert.Equal(450.0, BsonDocument.Parse(find.Docs[0])["total"].AsDouble);
        var agg = await new AggregateService().RunAsync(h, _db, "orders", new MongoAggregateRequest
        {
            Pipeline = ["{ $group: { _id: '$status', n: { $sum: 1 } } }", "{ $sort: { _id: 1 } }"], Limit = 10, MaxTimeMs = 10_000,
        }, default);
        Assert.Equal(2, agg.Docs.Count);
        Assert.False(agg.Truncated);
        Assert.Matches(@"^MongoDB \S+ \((replica set \w+|standalone)\)$", h.Server.Version);
    }

    [SkippableFact]
    public async Task Explain_and_index_stats()
    {
        var h = await Handle();
        var idx = new IndexesService();
        await idx.CreateAsync(h, _db, "orders", new MongoCreateIndexRequest
        {
            Key = [new MongoIndexKeyPartRequest { Field = "status", Type = 1 }, new MongoIndexKeyPartRequest { Field = "at", Type = -1 }],
        }, _ => throw new InvalidOperationException("should finish inline"), default);
        var ex = await new ExplainService().ExplainAsync(h, _db, "orders", new MongoExplainRequest { Kind = "find", Verbosity = "executionStats", Filter = "{ status: 'paid' }" }, default);
        Assert.Contains("status_1_at_-1", ex.Summary.Indexes);
        Assert.False(ex.Summary.Collscan);
        Assert.Equal(100, ex.Summary.NReturned);
        var scan = await new ExplainService().ExplainAsync(h, _db, "orders", new MongoExplainRequest
        {
            Kind = "aggregate", Verbosity = "executionStats", Pipeline = ["{ $match: { total: { $gt: 10 } } }", "{ $group: { _id: '$status', s: { $sum: '$total' } } }"],
        }, default);
        Assert.True(scan.Summary.Collscan);
        var list = await idx.ListAsync(h, _db, "orders", default);
        Assert.All(list, i => Assert.NotNull(i.Usage));
        Assert.All(list, i => Assert.NotNull(i.Size));
    }

    [SkippableFact]
    public async Task Change_stream_delivers_inserts()
    {
        var h = await Handle();
        var server = await new ExplorerService().ServerAsync(h, default);
        Skip.If(server.Type != "replicaSet", "change streams need a replica set");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await using var e = h.Gateway.WatchAsync(_db, "orders", false, cts.Token).GetAsyncEnumerator(cts.Token);
        var next = e.MoveNextAsync().AsTask();
        await Task.Delay(500);
        await h.Gateway.InsertManyAsync(_db, "orders", [new BsonDocument("_id", 9999)], true, default);
        Assert.True(await next);
        var item = MongoChangeStream.ToItem(e.Current);
        Assert.Equal("insert", item.OperationType);
        Assert.Contains("9999", item.DocumentKey);
    }

    [SkippableFact]
    public async Task Import_ten_thousand_documents()
    {
        var h = await Handle();
        var sb = new StringBuilder();
        for (var i = 0; i < 10_000; i++) sb.Append("{ n: ").Append(i).Append(", at: ISODate('2024-01-01'), tag: 't").Append(i % 7).Append("' }\n");
        var plan = ImportExportService.ParseImport(new MongoImportRequest { Format = "jsonl", Upload = sb.ToString(), BatchSize = 1000 });
        var r = await new ImportExportService().ImportAsync(h, _db, "bulk", plan, null, default);
        Assert.Equal(10_000, r.Inserted);
        Assert.Equal(0, r.Failed);
        Assert.Equal(10_000, await h.Gateway.CountDocumentsAsync(_db, "bulk", [], null, default));
    }
}
