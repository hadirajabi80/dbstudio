using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>Small JSON helpers for Elasticsearch responses (the _cat APIs answer numbers as strings).</summary>
internal static class EsJson
{
    /// <summary>Request bodies, console output and export files: readable Unicode (Persian text stays as is).</summary>
    public static readonly JsonSerializerOptions Relaxed = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static readonly JsonSerializerOptions RelaxedIndented = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = true };

    public static JsonElement? Prop(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;

    /// <summary>Follows a dotted path ("version.number").</summary>
    public static JsonElement? Path(this JsonElement e, string path)
    {
        JsonElement? cur = e;
        foreach (var part in path.Split('.'))
        {
            cur = cur?.Prop(part);
            if (cur is null) return null;
        }
        return cur;
    }

    public static string? Str(this JsonElement e, string name) => e.Prop(name) is { } v ? AsString(v) : null;

    public static string? AsString(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        _ => v.GetRawText(),
    };

    public static long? Long(this JsonElement e, string name) => e.Prop(name) is { } v ? AsLong(v) : null;

    public static long? AsLong(JsonElement v)
    {
        if (v.ValueKind == JsonValueKind.Number) return v.TryGetInt64(out var l) ? l : (long)v.GetDouble();
        if (v.ValueKind == JsonValueKind.String)
        {
            var s = v.GetString();
            if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p)) return p;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return (long)d;
        }
        return null;
    }

    public static double? Double(this JsonElement e, string name) => e.Prop(name) is { } v ? AsDouble(v) : null;

    public static double? AsDouble(JsonElement v)
    {
        if (v.ValueKind == JsonValueKind.Number) return v.GetDouble();
        if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return d;
        return null;
    }

    public static int Int(this JsonElement e, string name, int fallback = 0) => e.Long(name) is { } l ? (int)l : fallback;

    public static bool? Bool(this JsonElement e, string name) => e.Prop(name) is { } v
        ? v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(v.GetString(), out var b) ? b : null,
            _ => null,
        }
        : null;

    public static IEnumerable<JsonElement> Items(this JsonElement? e) =>
        e is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray() : [];

    public static IEnumerable<JsonElement> Items(this JsonElement e) =>
        e.ValueKind == JsonValueKind.Array ? e.EnumerateArray() : [];

    public static JsonElement Element(JsonNode? node) => JsonSerializer.SerializeToElement(node, Relaxed);

    public static JsonNode? Node(JsonElement? e) => e is { } v && v.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) ? JsonNode.Parse(v.GetRawText()) : null;

    public static string Text(JsonNode? node) => node?.ToJsonString(Relaxed) ?? "null";

    public static string? Iso(long? epochMillis) =>
        epochMillis is { } ms ? DateTimeOffset.FromUnixTimeMilliseconds(ms).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) : null;
}
