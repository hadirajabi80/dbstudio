using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

internal static class T
{
    public static ConnectionProfile Profile(string uri = "mongodb://localhost:27017", bool readOnly = false, string? database = null,
        string id = "c_mongo", params (string Key, JsonNode? Value)[] props)
    {
        var p = new ConnectionProfile { Id = id, Name = "Shop Mongo", ProviderId = "mongodb", ReadOnly = readOnly };
        p.Props["uri"] = uri;
        if (database is not null) p.Props["database"] = database;
        foreach (var (k, v) in props) p.Props[k] = v;
        return p;
    }

    public static MongoClientHandle Handle(MongoFake fake, bool readOnly = false, string? database = null) =>
        new("c_mongo", Profile(readOnly: readOnly, database: database), fake,
            new ServerInfo("MongoDB 7.0.14 (replica set rs0)", "7.0.14", "localhost:27017", null, database), fake.HelloReply());

    /// <summary>A small shop: customers (mixed types), orders (status enum, items array), products, a view and indexes.</summary>
    public static MongoFake Shop()
    {
        var fake = new MongoFake();
        var customers = new List<BsonDocument>();
        for (var i = 1; i <= 20; i++)
            customers.Add(new BsonDocument
            {
                { "_id", i },
                { "name", $"Customer {i}" },
                { "email", $"c{i}@example.com" },
                { "tier", i % 3 == 0 ? "gold" : "silver" },
                { "phone", i % 2 == 0 ? new BsonString($"+1-555-{i:0000}") : new BsonInt64(5550000L + i) },
                { "address", new BsonDocument { { "city", i % 2 == 0 ? "Berlin" : "Paris" }, { "zip", 10000 + i } } },
                { "tags", i % 4 == 0 ? new BsonArray { "vip", "early" } : new BsonArray { "early" } },
            });
        fake.Seed("shop", "customers", customers);
        var statuses = new[] { "paid", "pending", "shipped", "cancelled" };
        var orders = new List<BsonDocument>();
        for (var i = 1; i <= 100; i++)
            orders.Add(new BsonDocument
            {
                { "_id", new ObjectId($"66f1{i:x20}") },
                { "customerId", (i % 20) + 1 },
                { "status", statuses[i % 4] },
                { "total", i * 10.5 },
                { "createdAt", new BsonDateTime(1_700_000_000_000L + i * 86_400_000L) },
                { "items", new BsonArray { new BsonDocument { { "sku", $"SKU-{i % 5}" }, { "qty", i % 3 + 1 }, { "price", 10.5 } } } },
            });
        fake.Seed("shop", "orders", orders);
        fake.Seed("shop", "products",
            """{ _id: 1, name: "Lamp", price: NumberDecimal("19.99"), stock: NumberLong(5), rating: 4 }""",
            """{ _id: 2, name: "Desk", price: NumberDecimal("199.00"), stock: NumberLong(2), rating: 4.5 }""",
            """{ _id: 3, name: "Chair", price: NumberDecimal("49.50"), stock: NumberLong(0), rating: "n/a" }""");
        fake.Index("shop", "orders", new BsonDocument { { "key", new BsonDocument { { "status", 1 }, { "createdAt", -1 } } }, { "name", "status_1_createdAt_-1" } });
        fake.Index("shop", "customers", new BsonDocument { { "key", new BsonDocument("email", 1) }, { "name", "email_1" }, { "unique", true } });
        fake.View("shop", "paid_orders", "orders", new BsonDocument("$match", new BsonDocument("status", "paid")));
        return fake;
    }

    public static BsonDocument Doc(string ejson) => BsonDocument.Parse(ejson);

    public static string TempDir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dbstudio-mongo-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}

public sealed class RecordingPublisher : IEventPublisher
{
    private readonly ConcurrentQueue<EngineEvent> _events = new();
    private readonly List<(Func<EngineEvent, bool> Pred, TaskCompletionSource<EngineEvent> Tcs)> _waiters = [];

    public IReadOnlyList<EngineEvent> All => _events.ToList();

    public void Publish(EngineEvent ev)
    {
        JsonSerializer.SerializeToUtf8Bytes(ev, ev.GetType(), CoreJson.Options);
        _events.Enqueue(ev);
        lock (_waiters)
        {
            foreach (var w in _waiters.Where(w => w.Pred(ev)).ToList())
            {
                _waiters.Remove(w);
                w.Tcs.TrySetResult(ev);
            }
        }
    }

    public async Task<TEvent> WaitAsync<TEvent>(Func<TEvent, bool> pred, int timeoutMs = 15000) where TEvent : EngineEvent
    {
        TaskCompletionSource<EngineEvent> tcs;
        lock (_waiters)
        {
            var hit = _events.OfType<TEvent>().FirstOrDefault(pred);
            if (hit is not null) return hit;
            tcs = new TaskCompletionSource<EngineEvent>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add((e => e is TEvent t && pred(t), tcs));
        }
        return (TEvent)await tcs.Task.WaitAsync(TimeSpan.FromMilliseconds(timeoutMs));
    }

    /// <summary>Waits for <c>job.done</c> of the job and returns it.</summary>
    public Task<JobDoneEvent> JobDone(string jobId) => WaitAsync<JobDoneEvent>(e => e.JobId == jobId);
}
