using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka.Deserializers;

/// <summary>Format names of the browser (deserializers) and of produce (serializers), docs/PLAN-M2.md 7.4.</summary>
public static class KafkaFormats
{
    public static readonly string[] Decoders = ["string", "json", "hex", "int32", "int64", "avro", "protobuf", "jsonschema", "auto"];
    public static readonly string[] Encoders = ["string", "json", "hex", "avro", "protobuf", "jsonschema"];

    public static string Decoder(string? format, string field, string fallback = "auto") => Check(format, field, fallback, Decoders);

    public static string Encoder(string? format, string field, string fallback = "string") => Check(format, field, fallback, Encoders);

    private static string Check(string? format, string field, string fallback, string[] allowed)
    {
        var f = string.IsNullOrWhiteSpace(format) ? fallback : format.Trim().ToLowerInvariant();
        return allowed.Contains(f) ? f : throw EngineException.Validation($"{field} must be one of {string.Join(", ", allowed)}.", new { field });
    }
}

/// <summary>
/// Turns key/value/header bytes into <see cref="KafkaDecoded"/> (docs/PLAN-M2.md 7.4): string (UTF-8; invalid bytes fall
/// back to hex, flagged), json, hex, int32/int64 (big-endian), avro/protobuf/jsonschema through the Schema Registry
/// (Confluent wire format: magic byte 0, 4-byte big-endian schema id, Protobuf message indexes), and auto. Text longer than
/// 32 KB is truncated (<c>{$trunc,len}</c>) unless <c>full</c>; search runs on <see cref="KafkaDecoded.FullText"/>.
/// </summary>
public sealed class MessageCodec(SchemaCache schemas)
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, throwOnInvalidBytes: true);
    private const int MaxHexBytes = 16 * 1024;

    public SchemaCache Schemas => schemas;

    public async ValueTask<KafkaDecoded> DecodeAsync(byte[]? data, string format, bool full, CancellationToken ct)
    {
        if (data is null) return new KafkaDecoded { Format = format, Text = null };
        try
        {
            return format switch
            {
                "string" => Utf8(data, "string", full),
                "json" => Json(data, full),
                "hex" => Hex(data, full),
                "int32" => Int(data, 4, full),
                "int64" => Int(data, 8, full),
                "avro" or "protobuf" or "jsonschema" => await RegistryAsync(data, format, full, ct).ConfigureAwait(false),
                _ => await AutoAsync(data, full, ct).ConfigureAwait(false),
            };
        }
        catch (EngineException ex) when (ex.Code is ErrorCodes.NotSupported or ErrorCodes.ProviderError or ErrorCodes.NotFound or ErrorCodes.Privilege)
        {
            return WithError(Hex(data, full) with { Format = format }, ex.Message);
        }
    }

    private async ValueTask<KafkaDecoded> AutoAsync(byte[] data, bool full, CancellationToken ct)
    {
        if (schemas.Available && IsWire(data, out _))
        {
            var decoded = await RegistryAsync(data, "auto", full, ct).ConfigureAwait(false);
            if (decoded.Error is null) return decoded;
        }
        var first = FirstNonSpace(data);
        if (first is (byte)'{' or (byte)'[')
        {
            var json = Json(data, full);
            if (json.Error is null) return json with { Format = "json" };
        }
        return Utf8(data, "string", full);
    }

    private async ValueTask<KafkaDecoded> RegistryAsync(byte[] data, string format, bool full, CancellationToken ct)
    {
        if (!IsWire(data, out var id))
            return WithError(Hex(data, full) with { Format = format }, "Not in the Schema Registry wire format (magic byte 0 + schema id).");
        if (!schemas.Available) throw SchemaCache.NoRegistry();
        var schema = await schemas.GetAsync(id, ct).ConfigureAwait(false);
        var payload = data.AsSpan(5);
        JsonElement json;
        string actual;
        try
        {
            switch (schema.SchemaType)
            {
                case "AVRO" when format is "avro" or "auto":
                    json = AvroCodec.Decode(schema.Avro!, payload);
                    actual = "avro";
                    break;
                case "PROTOBUF" when format is "protobuf" or "auto":
                    var indexes = ProtobufIndexes.Read(payload, out var used);
                    json = schema.Protobuf!.Decode(schema.Protobuf.MessageAt(indexes), payload[used..]);
                    actual = "protobuf";
                    break;
                case "JSON" when format is "jsonschema" or "auto":
                    using (var doc = JsonDocument.Parse(payload.ToArray())) json = doc.RootElement.Clone();
                    actual = "jsonschema";
                    break;
                default:
                    return WithError(Hex(data, full) with { Format = format, SchemaId = id, SchemaSubject = schema.Subject },
                        $"Schema {id} is {schema.SchemaType}, not {format}.");
            }
        }
        catch (Exception ex) when (ex is FormatException or JsonException or Avro.AvroException or IOException or ArgumentException or IndexOutOfRangeException or InvalidCastException)
        {
            return WithError(Hex(data, full) with { Format = format, SchemaId = id, SchemaSubject = schema.Subject }, $"Could not decode with schema {id}: {ex.Message}");
        }
        var text = json.GetRawText();
        return new KafkaDecoded
        {
            Format = actual, Text = Cut(text, full), Json = text.Length <= ValueConverter.MaxStringChars || full ? json : null,
            SchemaId = id, SchemaSubject = schema.Subject, FullText = text,
        };
    }

    public static bool IsWire(byte[] data, out int schemaId)
    {
        schemaId = 0;
        if (data.Length < 5 || data[0] != 0) return false;
        schemaId = BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(1, 4));
        return schemaId > 0;
    }

    private static KafkaDecoded Utf8(byte[] data, string format, bool full)
    {
        try
        {
            var s = StrictUtf8.GetString(data);
            return new KafkaDecoded { Format = format, Text = Cut(s, full), FullText = s };
        }
        catch (DecoderFallbackException)
        {
            return WithError(Hex(data, full) with { Format = format }, "Not valid UTF-8; shown as hex.");
        }
    }

    private static KafkaDecoded Json(byte[] data, bool full)
    {
        var s = Utf8(data, "json", full);
        if (s.Error is not null) return s;
        try
        {
            using var doc = JsonDocument.Parse(data);
            var tooLong = s.FullText!.Length > ValueConverter.MaxStringChars && !full;
            return s with { Json = tooLong ? null : doc.RootElement.Clone() };
        }
        catch (JsonException ex)
        {
            return s with { Error = $"Invalid JSON: {ex.Message}" };
        }
    }

    private static KafkaDecoded Hex(byte[] data, bool full)
    {
        var shown = full ? data : data.AsSpan(0, Math.Min(data.Length, MaxHexBytes)).ToArray();
        var hex = Convert.ToHexStringLower(shown);
        object text = shown.Length < data.Length ? new TruncatedHex(hex, data.Length * 2) : hex;
        return new KafkaDecoded { Format = "hex", Text = text, Hex = hex, FullText = hex };
    }

    private static KafkaDecoded Int(byte[] data, int size, bool full)
    {
        var format = size == 4 ? "int32" : "int64";
        if (data.Length != size) return WithError(Hex(data, full) with { Format = format }, $"{format} needs exactly {size} bytes, got {data.Length}.");
        var text = size == 4 ? BinaryPrimitives.ReadInt32BigEndian(data).ToString(System.Globalization.CultureInfo.InvariantCulture)
            : BinaryPrimitives.ReadInt64BigEndian(data).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new KafkaDecoded { Format = format, Text = text, Hex = Convert.ToHexStringLower(data), FullText = text };
    }

    private static KafkaDecoded WithError(KafkaDecoded d, string error) => d with { Error = error };

    private static object Cut(string s, bool full) => full ? s : ValueConverter.Text(s);

    private static byte FirstNonSpace(byte[] data)
    {
        foreach (var b in data) if (b is not ((byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n')) return b;
        return 0;
    }

    /// <summary>The <c>{$trunc,len}</c> form for hex text (len = full hex length).</summary>
    private sealed class TruncatedHex(string shown, long len)
    {
        [System.Text.Json.Serialization.JsonPropertyName("$trunc")] public string Trunc { get; } = shown;
        [System.Text.Json.Serialization.JsonPropertyName("len")] public long Len { get; } = len;
    }

    // ---------------------------------------------------------------- produce

    /// <summary>Serializes produce input: string / json (validated) / hex / avro / protobuf / jsonschema (with a registry subject).</summary>
    public static byte[]? Encode(string? text, string format, ParsedSchema? schema, string? protobufMessage, string field)
    {
        if (text is null) return null;
        switch (format)
        {
            case "string": return Encoding.UTF8.GetBytes(text);
            case "json":
                try { using (JsonDocument.Parse(text)) { } }
                catch (JsonException ex) { throw EngineException.Validation($"{field} is not valid JSON: {ex.Message}", new { field }); }
                return Encoding.UTF8.GetBytes(text);
            case "hex":
                var compact = new string(text.Where(c => !char.IsWhiteSpace(c)).ToArray());
                if (compact.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) compact = compact[2..];
                try { return Convert.FromHexString(compact); }
                catch (FormatException) { throw EngineException.Validation($"{field} is not valid hex.", new { field }); }
        }
        if (schema is null) throw EngineException.Validation($"{field}: format {format} needs a Schema Registry subject.", new { field });
        JsonElement json;
        try
        {
            using var doc = JsonDocument.Parse(text);
            json = doc.RootElement.Clone();
        }
        catch (JsonException ex) { throw EngineException.Validation($"{field} is not valid JSON: {ex.Message}", new { field }); }

        var header = new byte[5];
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(1), schema.Id);
        try
        {
            switch (format)
            {
                case "avro" when schema.Avro is not null:
                    return [.. header, .. AvroCodec.Encode(schema.Avro, json)];
                case "protobuf" when schema.Protobuf is not null:
                    var indexes = schema.Protobuf.IndexesOf(protobufMessage);
                    return [.. header, .. ProtobufIndexes.Write(indexes), .. schema.Protobuf.Encode(schema.Protobuf.MessageAt(indexes), json)];
                case "jsonschema" when schema.SchemaType == "JSON":
                    return [.. header, .. Encoding.UTF8.GetBytes(json.GetRawText())];
                default:
                    throw EngineException.Validation($"{field}: schema {schema.Id} is {schema.SchemaType}, not {format}.", new { field });
            }
        }
        catch (Exception ex) when (ex is FormatException or Avro.AvroException or InvalidCastException or ArgumentException)
        {
            throw EngineException.Validation($"{field} does not match schema {schema.Id}: {ex.Message}", new { field });
        }
    }
}
