using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Bson.IO;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// Extended JSON output (docs/PLAN-M2.md 6.3): documents travel to the UI as canonical EJSON text; find / aggregate /
/// change-stream output replaces strings longer than <see cref="MaxString"/> chars and binaries larger than
/// <see cref="MaxBinary"/> bytes by <c>{"$trunc": …, "len": n}</c> markers (anywhere in the tree).
/// </summary>
public static class Ejson
{
    public const int MaxString = 32_768, KeepString = 1_000, MaxBinary = 8_192, KeepBinary = 256;

    private static readonly JsonWriterSettings CanonicalSettings = new() { OutputMode = JsonOutputMode.CanonicalExtendedJson };
    private static readonly JsonWriterSettings RelaxedSettings = new() { OutputMode = JsonOutputMode.RelaxedExtendedJson };
    private static readonly JsonWriterSettings RelaxedIndentedSettings = new() { OutputMode = JsonOutputMode.RelaxedExtendedJson, Indent = true };
    private static readonly JsonWriterSettings CanonicalIndentedSettings = new() { OutputMode = JsonOutputMode.CanonicalExtendedJson, Indent = true };

    /// <summary>Canonical EJSON text of a document or value; <paramref name="truncate"/> applies the <c>$trunc</c> markers.</summary>
    public static string Canonical(BsonValue value, bool truncate = false) =>
        (truncate ? Truncate(value) : value).ToJson(CanonicalSettings);

    /// <summary>Relaxed EJSON text (numbers as JSON numbers, dates as ISO strings).</summary>
    public static string Relaxed(BsonValue value, bool indent = false) => value.ToJson(indent ? RelaxedIndentedSettings : RelaxedSettings);

    public static string Write(BsonValue value, bool canonical, bool indent) =>
        value.ToJson(canonical ? indent ? CanonicalIndentedSettings : CanonicalSettings : indent ? RelaxedIndentedSettings : RelaxedSettings);

    /// <summary>Relaxed EJSON as a JSON node (schema examples, stats); null for BSON null.</summary>
    public static JsonNode? ToJsonNode(BsonValue value) => value.IsBsonNull ? null : JsonNode.Parse(Relaxed(value));

    /// <summary>Compact relaxed JSON for explain predicates (single line, minimal spaces).</summary>
    public static string Compact(BsonValue value)
    {
        try
        {
            return JsonNode.Parse(Relaxed(value))?.ToJsonString() ?? "null";
        }
        catch (System.Text.Json.JsonException)
        {
            return Relaxed(value);
        }
    }

    /// <summary>
    /// The value with long strings / large binaries replaced by <c>$trunc</c> markers; returns the same instance when
    /// nothing needs truncating (no copy for the common case).
    /// </summary>
    public static BsonValue Truncate(BsonValue value)
    {
        switch (value)
        {
            case BsonString s when s.Value.Length > MaxString:
                return new BsonDocument { { "$trunc", s.Value[..KeepString] }, { "len", s.Value.Length } };
            case BsonBinaryData b when b.Bytes.Length > MaxBinary:
                return new BsonDocument
                {
                    { "$trunc", Convert.ToBase64String(b.Bytes, 0, KeepBinary) },
                    { "len", b.Bytes.Length },
                    { "binary", true },
                    { "subType", ((byte)b.SubType).ToString("x2") },
                };
            case BsonDocument d:
            {
                BsonDocument? copy = null;
                for (var i = 0; i < d.ElementCount; i++)
                {
                    var el = d.GetElement(i);
                    var t = Truncate(el.Value);
                    if (copy is null && ReferenceEquals(t, el.Value)) continue;
                    if (copy is null)
                    {
                        copy = new BsonDocument(allowDuplicateNames: true);
                        for (var j = 0; j < i; j++) copy.Add(d.GetElement(j));
                    }
                    copy.Add(el.Name, t);
                }
                return copy ?? d;
            }
            case BsonArray a:
            {
                BsonArray? copy = null;
                for (var i = 0; i < a.Count; i++)
                {
                    var t = Truncate(a[i]);
                    if (copy is null && ReferenceEquals(t, a[i])) continue;
                    if (copy is null)
                    {
                        copy = new BsonArray(a.Count);
                        for (var j = 0; j < i; j++) copy.Add(a[j]);
                    }
                    copy.Add(t);
                }
                return copy ?? a;
            }
            default:
                return value;
        }
    }
}
