using System.Buffers;
using System.Globalization;
using System.Text.Json;
using Avro;
using Avro.Generic;
using Avro.IO;
using Avro.Util;

namespace DbStudio.Sources.Kafka.Deserializers;

/// <summary>
/// Avro payloads of the Confluent wire format (docs/PLAN-M2.md 7.4): binary datum ⇄ plain JSON (not the Avro JSON encoding:
/// unions are unwrapped, bytes/fixed are base64, logical types are ISO strings / numbers). Encoding accepts the plain form
/// and the Avro JSON union form (<c>{"string": "x"}</c>).
/// </summary>
public static class AvroCodec
{
    /// <summary>Parses a writer schema with its references (referenced schemas first, into the same <see cref="SchemaNames"/>).</summary>
    public static Schema Parse(string schema, IEnumerable<string>? referencedSchemas = null)
    {
        var refs = referencedSchemas?.ToList() ?? [];
        if (refs.Count == 0) return Schema.Parse(schema);
        // Schema.Parse(string, SchemaNames, string) is internal in Apache.Avro 1.12; it is the only way to resolve named
        // types across registry references.
        var parse = typeof(Schema).GetMethod("Parse", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public,
            [typeof(string), typeof(SchemaNames), typeof(string)]) ?? throw new FormatException("This Avro library cannot resolve schema references.");
        var names = new SchemaNames();
        try
        {
            foreach (var r in refs) parse.Invoke(null, [r, names, null]);
            return (Schema)parse.Invoke(null, [schema, names, null])!;
        }
        catch (System.Reflection.TargetInvocationException ex) when (ex.InnerException is not null) { throw ex.InnerException; }
    }

    public static JsonElement Decode(Schema schema, ReadOnlySpan<byte> payload)
    {
        using var ms = new MemoryStream(payload.ToArray(), writable: false);
        var reader = new GenericDatumReader<object?>(schema, schema);
        var datum = reader.Read(null, new BinaryDecoder(ms));
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer)) Write(w, datum, schema);
        using var doc = JsonDocument.Parse(buffer.WrittenMemory);
        return doc.RootElement.Clone();
    }

    public static byte[] Encode(Schema schema, JsonElement value)
    {
        var datum = ToDatum(schema, value, "$");
        using var ms = new MemoryStream();
        new GenericDatumWriter<object?>(schema).Write(datum, new BinaryEncoder(ms));
        return ms.ToArray();
    }

    // ---------------------------------------------------------------- decode

    private static void Write(Utf8JsonWriter w, object? v, Schema schema)
    {
        switch (v)
        {
            case null: w.WriteNullValue(); return;
            case bool b: w.WriteBooleanValue(b); return;
            case int i: w.WriteNumberValue(i); return;
            case long l: w.WriteNumberValue(l); return;
            case float f when float.IsFinite(f): w.WriteNumberValue(f); return;
            case double d when double.IsFinite(d): w.WriteNumberValue(d); return;
            case float f: w.WriteStringValue(f.ToString(CultureInfo.InvariantCulture)); return;
            case double d: w.WriteStringValue(d.ToString(CultureInfo.InvariantCulture)); return;
            case string s: w.WriteStringValue(s); return;
            case byte[] bytes: w.WriteStringValue(Convert.ToBase64String(bytes)); return;
            case Guid g: w.WriteStringValue(g.ToString()); return;
            case DateTime dt:
                var schemaLogical = Unwrap(schema, v) is LogicalSchema ls ? ls.LogicalTypeName : null;
                w.WriteStringValue(schemaLogical == "date"
                    ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : DateTime.SpecifyKind(dt, dt.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : dt.Kind).ToString("O", CultureInfo.InvariantCulture));
                return;
            case TimeSpan ts: w.WriteStringValue(ts.ToString("c", CultureInfo.InvariantCulture)); return;
            case AvroDecimal dec:
                var text = dec.ToString(null, CultureInfo.InvariantCulture);
                if (decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var m)) w.WriteNumberValue(m);
                else w.WriteStringValue(text);
                return;
            case GenericEnum e: w.WriteStringValue(e.Value); return;
            case GenericFixed fx: w.WriteStringValue(Convert.ToBase64String(fx.Value)); return;
            case GenericRecord rec:
                w.WriteStartObject();
                foreach (var field in rec.Schema.Fields)
                {
                    w.WritePropertyName(field.Name);
                    rec.TryGetValue(field.Name, out var fv);
                    Write(w, fv, field.Schema);
                }
                w.WriteEndObject();
                return;
            case IDictionary<string, object?> map:
                var valueSchema = Unwrap(schema, v) is MapSchema ms ? ms.ValueSchema : schema;
                w.WriteStartObject();
                foreach (var (k, mv) in map)
                {
                    w.WritePropertyName(k);
                    Write(w, mv, valueSchema);
                }
                w.WriteEndObject();
                return;
            case System.Collections.IEnumerable list:
                var itemSchema = Unwrap(schema, v) is ArraySchema arr ? arr.ItemSchema : schema;
                w.WriteStartArray();
                foreach (var item in list) Write(w, item, itemSchema);
                w.WriteEndArray();
                return;
            default:
                w.WriteStringValue(Convert.ToString(v, CultureInfo.InvariantCulture));
                return;
        }
    }

    /// <summary>The branch of a union that fits a decoded value (for item/value schemas and logical names).</summary>
    private static Schema Unwrap(Schema schema, object? v)
    {
        if (schema is not UnionSchema u) return schema;
        foreach (var s in u.Schemas)
        {
            var fits = (s, v) switch
            {
                (MapSchema, IDictionary<string, object?>) => true,
                (ArraySchema, System.Collections.IEnumerable and not string and not byte[]) => true,
                (LogicalSchema, DateTime or TimeSpan or Guid or AvroDecimal) => true,
                _ => false,
            };
            if (fits) return s;
        }
        return schema;
    }

    // ---------------------------------------------------------------- encode

    private static object? ToDatum(Schema schema, JsonElement v, string path)
    {
        switch (schema)
        {
            case UnionSchema u: return UnionDatum(u, v, path);
            case LogicalSchema l: return LogicalDatum(l, v, path);
            case RecordSchema r:
                if (v.ValueKind != JsonValueKind.Object) throw Fail(path, $"expected an object for record {r.Fullname}");
                var rec = new GenericRecord(r);
                foreach (var f in r.Fields)
                {
                    if (v.TryGetProperty(f.Name, out var fv)) rec.Add(f.Name, ToDatum(f.Schema, fv, $"{path}.{f.Name}"));
                    else if (f.DefaultValue is not null)
                    {
                        using var d = JsonDocument.Parse(f.DefaultValue.ToString(Newtonsoft.Json.Formatting.None));
                        // A union field's default belongs to its first branch.
                        var target = f.Schema is UnionSchema us ? us.Schemas[0] : f.Schema;
                        rec.Add(f.Name, ToDatum(target, d.RootElement, $"{path}.{f.Name}"));
                    }
                    else throw Fail($"{path}.{f.Name}", "required field is missing");
                }
                return rec;
            case EnumSchema e:
                var symbol = v.ValueKind == JsonValueKind.String ? v.GetString()! : throw Fail(path, $"expected a symbol of {e.Fullname}");
                if (!e.Symbols.Contains(symbol)) throw Fail(path, $"'{symbol}' is not a symbol of {e.Fullname} ({string.Join(", ", e.Symbols)})");
                return new GenericEnum(e, symbol);
            case FixedSchema fx:
                var fb = Bytes(v, path);
                if (fb.Length != fx.Size) throw Fail(path, $"fixed {fx.Fullname} needs {fx.Size} bytes, got {fb.Length}");
                return new GenericFixed(fx, fb);
            case ArraySchema a:
                if (v.ValueKind != JsonValueKind.Array) throw Fail(path, "expected an array");
                return v.EnumerateArray().Select((x, i) => ToDatum(a.ItemSchema, x, $"{path}[{i}]")).ToArray();
            case MapSchema m:
                if (v.ValueKind != JsonValueKind.Object) throw Fail(path, "expected an object (map)");
                var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var p in v.EnumerateObject()) dict[p.Name] = ToDatum(m.ValueSchema, p.Value, $"{path}.{p.Name}");
                return dict;
            case PrimitiveSchema p: return Primitive(p.Tag, v, path);
            default: throw Fail(path, $"unsupported Avro type {schema.Tag}");
        }
    }

    private static object? UnionDatum(UnionSchema u, JsonElement v, string path)
    {
        // Avro JSON encoding: {"type name": value}.
        if (v.ValueKind == JsonValueKind.Object)
        {
            var list = v.EnumerateObject().ToList();
            if (list.Count == 1)
            {
                var branch = u.Schemas.FirstOrDefault(s => BranchName(s) == list[0].Name || s.Name == list[0].Name);
                if (branch is not null) return ToDatum(branch, list[0].Value, path);
            }
        }
        if (v.ValueKind == JsonValueKind.Null)
        {
            if (u.Schemas.Any(s => s.Tag == Schema.Type.Null)) return null;
            throw Fail(path, "null is not allowed here");
        }
        var errors = new List<string>();
        foreach (var s in u.Schemas.Where(s => s.Tag != Schema.Type.Null))
        {
            try { return ToDatum(s, v, path); }
            catch (FormatException ex) { errors.Add(ex.Message); }
        }
        throw Fail(path, $"value matches no union branch ({string.Join("; ", errors)})");
    }

    private static string BranchName(Schema s) => s is NamedSchema n ? n.Fullname : s is LogicalSchema l ? l.BaseSchema.Name : s.Name;

    private static object? LogicalDatum(LogicalSchema l, JsonElement v, string path)
    {
        switch (l.LogicalTypeName)
        {
            case "uuid":
                return v.ValueKind == JsonValueKind.String && Guid.TryParse(v.GetString(), out var g) ? g : throw Fail(path, "expected a UUID string");
            case "date":
                if (v.ValueKind == JsonValueKind.Number) return DateTime.UnixEpoch.AddDays(v.GetInt32());
                return v.ValueKind == JsonValueKind.String && DateTime.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)
                    ? DateTime.SpecifyKind(d.Date, DateTimeKind.Utc) : throw Fail(path, "expected a date (yyyy-MM-dd or days since epoch)");
            case "timestamp-millis" or "timestamp-micros" or "local-timestamp-millis" or "local-timestamp-micros":
                if (v.ValueKind == JsonValueKind.Number)
                {
                    var n = v.GetInt64();
                    return l.LogicalTypeName.EndsWith("millis", StringComparison.Ordinal)
                        ? DateTime.UnixEpoch.AddMilliseconds(n) : DateTime.UnixEpoch.AddTicks(n * 10);
                }
                return v.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var ts)
                    ? ts.UtcDateTime : throw Fail(path, "expected an ISO timestamp or epoch number");
            case "time-millis" or "time-micros":
                if (v.ValueKind == JsonValueKind.Number)
                    return l.LogicalTypeName == "time-millis" ? TimeSpan.FromMilliseconds(v.GetInt64()) : TimeSpan.FromTicks(v.GetInt64() * 10);
                return v.ValueKind == JsonValueKind.String && TimeSpan.TryParse(v.GetString(), CultureInfo.InvariantCulture, out var t)
                    ? t : throw Fail(path, "expected a time (HH:mm:ss) or a number");
            case "decimal":
                var text = v.ValueKind switch
                {
                    JsonValueKind.Number => v.GetRawText(),
                    JsonValueKind.String => v.GetString()!,
                    _ => throw Fail(path, "expected a decimal number"),
                };
                if (!decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var dec)) throw Fail(path, $"'{text}' is not a decimal");
                var scale = l.GetProperty("scale") is { } s && int.TryParse(s.Trim('"'), out var sc) ? sc : 0;
                return new AvroDecimal(Math.Round(dec, scale));
            default:
                return ToDatum(l.BaseSchema, v, path);
        }
    }

    private static object? Primitive(Schema.Type tag, JsonElement v, string path)
    {
        try
        {
            return tag switch
            {
                Schema.Type.Null => v.ValueKind == JsonValueKind.Null ? null : throw Fail(path, "expected null"),
                Schema.Type.Boolean => v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : throw Fail(path, "expected true/false"),
                Schema.Type.Int => v.ValueKind == JsonValueKind.Number ? v.GetInt32() : throw Fail(path, "expected an int"),
                Schema.Type.Long => v.ValueKind == JsonValueKind.Number ? v.GetInt64()
                    : v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var l) ? l
                    : throw Fail(path, "expected a long"),
                Schema.Type.Float => v.ValueKind == JsonValueKind.Number ? v.GetSingle() : throw Fail(path, "expected a float"),
                Schema.Type.Double => v.ValueKind == JsonValueKind.Number ? v.GetDouble() : throw Fail(path, "expected a double"),
                Schema.Type.String => v.ValueKind == JsonValueKind.String ? v.GetString() : throw Fail(path, "expected a string"),
                Schema.Type.Bytes => Bytes(v, path),
                _ => throw Fail(path, $"unsupported primitive {tag}"),
            };
        }
        catch (FormatException) { throw; }
        catch (InvalidOperationException) { throw Fail(path, $"value does not fit {tag.ToString().ToLowerInvariant()}"); }
    }

    private static byte[] Bytes(JsonElement v, string path)
    {
        if (v.ValueKind != JsonValueKind.String) throw Fail(path, "expected base64 bytes");
        try { return Convert.FromBase64String(v.GetString()!); }
        catch (FormatException) { throw Fail(path, "expected base64 bytes"); }
    }

    private static FormatException Fail(string path, string message) => new($"{path}: {message}");
}
