using System.Globalization;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Deserializers;

namespace DbStudio.Sources.Kafka.Services;

/// <summary>
/// Produce (docs/PLAN-M2.md 7.4): string / json / hex values, or avro / protobuf / jsonschema against a registry subject
/// version (key and value independently), headers, explicit partition, compression; <c>acks=all</c>, flushed within 10 s.
/// READ_ONLY on read-only connections. At most 1000 messages per request (the UI's "Repeat N times").
/// </summary>
public sealed class ProduceService
{
    public const int MaxMessages = 1000;
    public const long MaxBatchBytes = 16L * 1024 * 1024;
    public static readonly string[] Compressions = ["none", "gzip", "snappy", "lz4", "zstd"];

    public async Task<IReadOnlyList<KafkaProduceResult>> ProduceAsync(KafkaClientHandle h, string topic, KafkaProduceRequest? req, CancellationToken ct)
    {
        var messages = req?.Messages ?? [];
        if (messages.Count == 0) throw EngineException.Validation("messages must contain at least one message.", new { field = "messages" });
        if (messages.Count > MaxMessages) throw EngineException.Validation($"At most {MaxMessages} messages per request.", new { field = "messages" });
        var keyFormat = KafkaFormats.Encoder(req!.KeyFormat, "keyFormat");
        var valueFormat = KafkaFormats.Encoder(req.ValueFormat, "valueFormat");
        var compression = (req.Compression ?? "none").Trim().ToLowerInvariant();
        if (!Compressions.Contains(compression))
            throw EngineException.Validation($"compression must be one of {string.Join(", ", Compressions)}.", new { field = "compression" });
        h.EnsureWritable($"producing to topic '{topic}'");

        var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
        var valueSchema = await SchemaAsync(h, req.Schema, valueFormat, "schema", ct).ConfigureAwait(false);
        var keySchema = await SchemaAsync(h, req.KeySchema, keyFormat, "keySchema", ct).ConfigureAwait(false);

        var records = new List<KProduceRecord>(messages.Count);
        long bytes = 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i] ?? throw EngineException.Validation($"messages[{i}] is null.", new { field = $"messages[{i}]" });
            if (m.Partition is { } p && meta.Partitions.All(x => x.Id != p))
                throw EngineException.Validation($"messages[{i}].partition {p} does not exist (0–{meta.Partitions.Count - 1}).", new { field = $"messages[{i}].partition" });
            var key = MessageCodec.Encode(m.Key, keyFormat, keySchema, null, $"messages[{i}].key");
            var value = MessageCodec.Encode(m.Value, valueFormat, valueSchema, null, $"messages[{i}].value");
            var headers = (m.Headers ?? []).Select((hd, j) => string.IsNullOrEmpty(hd?.Key)
                ? throw EngineException.Validation($"messages[{i}].headers[{j}].key is required.", new { field = $"messages[{i}].headers" })
                : new KHeader(hd.Key, hd.Value is null ? null : Encoding.UTF8.GetBytes(hd.Value))).ToList();
            var record = new KProduceRecord(key, value, headers, m.Partition);
            bytes += (key?.Length ?? 0) + (value?.Length ?? 0) + headers.Sum(x => x.Key.Length + (x.Value?.Length ?? 0));
            if (bytes > MaxBatchBytes) throw EngineException.Validation("The messages exceed 16 MB in total.", new { field = "messages" });
            records.Add(record);
        }
        var deliveries = await KafkaErrors.Call(() => h.Gateway.ProduceAsync(topic, records, compression == "none" ? null : compression, ct), topic)
            .ConfigureAwait(false);
        return deliveries.Select(d => new KafkaProduceResult(d.Partition, d.Offset, d.Timestamp)).ToList();
    }

    private static async Task<ParsedSchema?> SchemaAsync(KafkaClientHandle h, KafkaSchemaRef? reference, string format, string field, CancellationToken ct)
    {
        if (format is not ("avro" or "protobuf" or "jsonschema")) return null;
        if (reference is null || string.IsNullOrWhiteSpace(reference.Subject))
            throw EngineException.Validation($"{field}.subject is required for {format}.", new { field = $"{field}.subject" });
        if (!h.Schemas.Available) throw SchemaCache.NoRegistry();
        var version = reference.Version switch
        {
            null => "latest",
            { ValueKind: JsonValueKind.Number } n when n.TryGetInt32(out var v) && v > 0 => v.ToString(CultureInfo.InvariantCulture),
            { ValueKind: JsonValueKind.String } s when s.GetString() is "latest" => "latest",
            { ValueKind: JsonValueKind.String } s when int.TryParse(s.GetString(), out var v) && v > 0 => v.ToString(CultureInfo.InvariantCulture),
            _ => throw EngineException.Validation($"{field}.version must be a positive number or 'latest'.", new { field = $"{field}.version" }),
        };
        var parsed = await h.Schemas.GetVersionAsync(reference.Subject.Trim(), version, ct).ConfigureAwait(false);
        var expected = format switch { "avro" => "AVRO", "protobuf" => "PROTOBUF", _ => "JSON" };
        if (parsed.SchemaType != expected)
            throw EngineException.Validation($"Subject '{reference.Subject}' holds a {parsed.SchemaType} schema, not {format}.", new { field = $"{field}.subject" });
        return parsed;
    }
}
