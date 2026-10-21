using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

/// <summary>Schema Registry REST fake served through an HttpMessageHandler (docs/PLAN-M2.md 7.6).</summary>
public sealed class FakeSchemaRegistry : HttpMessageHandler
{
    public sealed record Entry(string Subject, int Version, int Id, string Type, string Schema, IReadOnlyList<SrReference> References);

    private readonly List<Entry> _entries = [];
    private int _nextId = 1;
    public readonly ConcurrentQueue<string> Requests = new();
    public bool Down { get; set; }
    public bool RequireAuth { get; set; }

    public Entry Register(string subject, string type, string schema, params SrReference[] refs)
    {
        lock (_entries)
        {
            var version = _entries.Count(e => e.Subject == subject) + 1;
            var e = new Entry(subject, version, _nextId++, type, schema, refs);
            _entries.Add(e);
            return e;
        }
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath.Trim('/');
        Requests.Enqueue(path);
        if (Down) throw new HttpRequestException("Connection refused (fake registry down)");
        if (RequireAuth && request.Headers.Authorization is null) return Task.FromResult(Json(HttpStatusCode.Unauthorized, new { error_code = 401, message = "Unauthorized" }));
        var parts = path.Split('/').Select(Uri.UnescapeDataString).ToArray();
        lock (_entries)
        {
            object? body = parts switch
            {
                ["subjects"] => _entries.Select(e => e.Subject).Distinct().ToList(),
                ["subjects", var s, "versions"] => _entries.Where(e => e.Subject == s).Select(e => e.Version).ToList() is { Count: > 0 } v ? v : null,
                ["subjects", var s, "versions", var ver] => Find(s, ver) is { } e ? Wire(e) : null,
                ["schemas", "ids", var id] => _entries.FirstOrDefault(e => e.Id.ToString() == id) is { } e
                    ? new { schema = e.Schema, schemaType = e.Type, references = Refs(e) } : null,
                ["schemas", "ids", var id, "versions"] => _entries.Where(e => e.Id.ToString() == id).Select(e => new { subject = e.Subject, version = e.Version }).ToList(),
                _ => null,
            };
            return Task.FromResult(body is null
                ? Json(HttpStatusCode.NotFound, new { error_code = 40401, message = $"Subject or version not found: {path}" })
                : Json(HttpStatusCode.OK, body));
        }
    }

    private Entry? Find(string subject, string version) => version == "latest"
        ? _entries.Where(e => e.Subject == subject).MaxBy(e => e.Version)
        : _entries.FirstOrDefault(e => e.Subject == subject && e.Version.ToString() == version);

    private static object Wire(Entry e) => new { subject = e.Subject, version = e.Version, id = e.Id, schemaType = e.Type, schema = e.Schema, references = Refs(e) };

    private static object Refs(Entry e) => e.References.Select(r => new { name = r.Name, subject = r.Subject, version = r.Version }).ToList();

    private static HttpResponseMessage Json(HttpStatusCode code, object body) =>
        new(code) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    /// <summary>Confluent wire format: magic 0 + big-endian schema id + payload.</summary>
    public static byte[] Frame(int id, byte[] payload, byte[]? protobufIndexes = null)
    {
        var header = new byte[5];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(1), id);
        return [.. header, .. protobufIndexes ?? [], .. payload];
    }
}

/// <summary>A <see cref="KafkaClientHandle"/> over <see cref="KafkaFake"/> (and optionally <see cref="FakeSchemaRegistry"/>).</summary>
public sealed class Harness : IAsyncDisposable
{
    public KafkaFake Fake { get; } = new();
    public FakeSchemaRegistry Registry { get; } = new();
    public KafkaClientHandle Handle { get; }

    public Harness(bool readOnly = false, bool withRegistry = true)
    {
        var profile = Profile("c_k", readOnly, withRegistry);
        var settings = KafkaSettings.From(profile, null);
        ISchemaRegistry? sr = withRegistry ? new HttpSchemaRegistry("http://registry.test", null, null, Registry) : null;
        Handle = new KafkaClientHandle("c_k", profile, settings, Fake, sr, new KafkaLogBuffer(), new ServerInfo("Kafka 3.8 (3 brokers, controller 1)", "3.8", "broker1:9092", null, null));
    }

    public static ConnectionProfile Profile(string id = "c_k", bool readOnly = false, bool withRegistry = true) => new()
    {
        Id = id, Name = "Kafka Test", ProviderId = "kafka", ReadOnly = readOnly,
        Props = new()
        {
            ["bootstrapServers"] = "broker1:9092",
            ["securityProtocol"] = "PLAINTEXT",
            ["schemaRegistryUrl"] = withRegistry ? "http://registry.test" : null,
        },
    };

    public ValueTask DisposeAsync() => Handle.DisposeAsync();
}

/// <summary>Event publisher that records events (job/stream assertions).</summary>
public sealed class Events : IEventPublisher
{
    private readonly ConcurrentQueue<EngineEvent> _all = new();
    public IReadOnlyList<EngineEvent> All => _all.ToList();
    public void Publish(EngineEvent ev) => _all.Enqueue(ev);

    public async Task<T> WaitFor<T>(Func<T, bool> predicate, int timeoutMs = 10_000) where T : EngineEvent
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < until)
        {
            if (_all.OfType<T>().FirstOrDefault(predicate) is { } hit) return hit;
            await Task.Delay(10);
        }
        throw new TimeoutException($"No {typeof(T).Name} matched in {timeoutMs} ms. Events: {string.Join(", ", _all.Select(e => e.GetType().Name))}");
    }
}

public static class Util
{
    public static async Task WaitUntil(Func<bool> condition, int timeoutMs = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(10);
        }
    }

    public static JsonElement Json(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    public static string Text(KafkaDecoded d) => d.Text switch { string s => s, TruncatedValue t => t.Full, null => "<null>", var o => o.ToString()! };
}
