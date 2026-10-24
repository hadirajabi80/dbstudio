using System.Buffers.Binary;
using System.Collections;
using System.Globalization;
using System.Net;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// CQL type names, column kinds, wire values and bind values (plan-batch3 WP-CS "Values"): uuid/timeuuid → guid,
/// timestamp → datetimeoffset (UTC), date/time/duration as text, varint/decimal exact, blob → binary, collections, tuples,
/// UDTs and vectors → JSON text. UDT values arrive from the driver as raw bytes (no CLR mapping): <see cref="Decode"/>
/// reads the CQL binary format with the column's type metadata.
/// </summary>
public static class CqlValues
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    // ------------------------------------------------------------------ type names / kinds

    /// <summary>CQL type text of a column ("frozen&lt;address&gt;" is reported as "address": the driver does not expose frozenness).</summary>
    public static string TypeName(ColumnTypeCode code, IColumnInfo? info) => Effective(code, info) switch
    {
        ColumnTypeCode.Ascii => "ascii",
        ColumnTypeCode.Bigint => "bigint",
        ColumnTypeCode.Blob => "blob",
        ColumnTypeCode.Boolean => "boolean",
        ColumnTypeCode.Counter => "counter",
        ColumnTypeCode.Decimal => "decimal",
        ColumnTypeCode.Double => "double",
        ColumnTypeCode.Float => "float",
        ColumnTypeCode.Int => "int",
        ColumnTypeCode.Text or ColumnTypeCode.Varchar => "text",
        ColumnTypeCode.Timestamp => "timestamp",
        ColumnTypeCode.Uuid => "uuid",
        ColumnTypeCode.Varint => "varint",
        ColumnTypeCode.Timeuuid => "timeuuid",
        ColumnTypeCode.Inet => "inet",
        ColumnTypeCode.Date => "date",
        ColumnTypeCode.Time => "time",
        ColumnTypeCode.SmallInt => "smallint",
        ColumnTypeCode.TinyInt => "tinyint",
        ColumnTypeCode.Duration => "duration",
        ColumnTypeCode.List when info is ListColumnInfo l => $"list<{TypeName(l.ValueTypeCode, l.ValueTypeInfo)}>",
        ColumnTypeCode.Set when info is SetColumnInfo s => $"set<{TypeName(s.KeyTypeCode, s.KeyTypeInfo)}>",
        ColumnTypeCode.Map when info is MapColumnInfo m => $"map<{TypeName(m.KeyTypeCode, m.KeyTypeInfo)}, {TypeName(m.ValueTypeCode, m.ValueTypeInfo)}>",
        ColumnTypeCode.Tuple when info is TupleColumnInfo t => $"tuple<{string.Join(", ", t.Elements.Select(e => TypeName(e.TypeCode, e.TypeInfo)))}>",
        ColumnTypeCode.Udt when info is UdtColumnInfo u => UdtShortName(u.Name),
        ColumnTypeCode.Custom when info is VectorColumnInfo v => $"vector<{TypeName(v.ValueTypeCode, v.ValueTypeInfo)}, {v.Dimensions}>",
        ColumnTypeCode.Custom when info is CustomColumnInfo c => $"'{c.CustomTypeName}'",
        _ => code.ToString().ToLowerInvariant(),
    };

    private static string UdtShortName(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot >= 0 ? name[(dot + 1)..] : name;
    }

    public static string KindFor(ColumnTypeCode code, IColumnInfo? info) => Effective(code, info) switch
    {
        ColumnTypeCode.Ascii or ColumnTypeCode.Text or ColumnTypeCode.Varchar or ColumnTypeCode.Inet or ColumnTypeCode.Duration => ColumnKinds.String,
        ColumnTypeCode.Int or ColumnTypeCode.Bigint or ColumnTypeCode.Counter or ColumnTypeCode.SmallInt or ColumnTypeCode.TinyInt => ColumnKinds.Int,
        ColumnTypeCode.Varint or ColumnTypeCode.Decimal => ColumnKinds.Decimal,
        ColumnTypeCode.Double or ColumnTypeCode.Float => ColumnKinds.Float,
        ColumnTypeCode.Boolean => ColumnKinds.Bool,
        ColumnTypeCode.Uuid or ColumnTypeCode.Timeuuid => ColumnKinds.Guid,
        ColumnTypeCode.Timestamp => ColumnKinds.DateTimeOffset,
        ColumnTypeCode.Date => ColumnKinds.Date,
        ColumnTypeCode.Time => ColumnKinds.Time,
        ColumnTypeCode.Blob => ColumnKinds.Binary,
        ColumnTypeCode.Custom when info is not VectorColumnInfo => ColumnKinds.Other,
        _ => ColumnKinds.Json,
    };

    public static bool IsComplex(ColumnTypeCode code, IColumnInfo? info = null) =>
        Effective(code, info) is ColumnTypeCode.List or ColumnTypeCode.Set or ColumnTypeCode.Map or ColumnTypeCode.Tuple or ColumnTypeCode.Udt
            or ColumnTypeCode.Custom;

    /// <summary>The driver reports <c>duration</c> as a custom type (DurationType) on some protocol versions: treat it as Duration.</summary>
    public static ColumnTypeCode Effective(ColumnTypeCode code, IColumnInfo? info) =>
        code == ColumnTypeCode.Custom && info is CustomColumnInfo c && c.CustomTypeName.EndsWith("DurationType", StringComparison.Ordinal)
            ? ColumnTypeCode.Duration : code;

    public static ColumnInfo Describe(CqlColumn c, int ordinal) => new(
        Name: c.Name,
        Ordinal: ordinal,
        DbType: TypeName(c.TypeCode, c.TypeInfo),
        Kind: KindFor(c.TypeCode, c.TypeInfo),
        Nullable: true,
        Table: string.IsNullOrEmpty(c.Table) ? null : c.Table,
        Schema: string.IsNullOrEmpty(c.Keyspace) ? null : c.Keyspace);

    // ------------------------------------------------------------------ wire values

    /// <summary>A driver value as a wire value (see the class summary).</summary>
    public static object? ToWire(object? value, ColumnTypeCode code, IColumnInfo? info)
    {
        if (value is null) return null;
        code = Effective(code, info);
        switch (code)
        {
            case ColumnTypeCode.Timestamp when value is DateTimeOffset dto:
                return dto.ToUniversalTime().ToString(ValueConverter.DateTimeOffsetFormat, Inv);
            case ColumnTypeCode.Date when value is LocalDate ld:
                return ld.ToString();
            case ColumnTypeCode.Time when value is LocalTime lt:
                return FormatTime(lt);
            case ColumnTypeCode.Duration:
            case ColumnTypeCode.Inet:
                return value.ToString();
            case ColumnTypeCode.Decimal when value is decimal m:
                return m.ToString(Inv);
            case ColumnTypeCode.Varint when value is BigInteger bi:
                return bi.ToString(Inv);
            case ColumnTypeCode.Blob when value is byte[] b:
                return new BinaryValue(b);
        }
        if (IsComplex(code) || (code == ColumnTypeCode.Custom && info is VectorColumnInfo))
        {
            if (code == ColumnTypeCode.Custom && info is CustomColumnInfo && value is byte[] raw) return new BinaryValue(raw);
            var node = ToJsonNode(value, code, info);
            return ValueConverter.Text(node?.ToJsonString(JsonOptions) ?? "null");
        }
        return ValueConverter.ToWire(value);
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string FormatTime(LocalTime t)
    {
        var s = $"{t.Hour:00}:{t.Minute:00}:{t.Second:00}";
        return t.Nanoseconds == 0 ? s : s + "." + t.Nanoseconds.ToString("000000000", Inv).TrimEnd('0');
    }

    /// <summary>JSON form of a (possibly nested) value: lists/sets/tuples/vectors → arrays, maps/UDTs → objects.</summary>
    public static JsonNode? ToJsonNode(object? value, ColumnTypeCode code, IColumnInfo? info)
    {
        if (value is null) return null;
        code = Effective(code, info);
        switch (code)
        {
            case ColumnTypeCode.Udt when info is UdtColumnInfo udt:
                return value is byte[] bytes ? DecodeUdt(bytes, udt) : JsonValue.Create(value.ToString());
            case ColumnTypeCode.List when info is ListColumnInfo l:
                return Array((IEnumerable)value, l.ValueTypeCode, l.ValueTypeInfo);
            case ColumnTypeCode.Set when info is SetColumnInfo s:
                return Array((IEnumerable)value, s.KeyTypeCode, s.KeyTypeInfo);
            case ColumnTypeCode.Custom when info is VectorColumnInfo v && value is IEnumerable ve:
                return Array(ve, v.ValueTypeCode, v.ValueTypeInfo);
            case ColumnTypeCode.Map when info is MapColumnInfo m && value is IDictionary dict:
                {
                    var obj = new JsonObject();
                    foreach (DictionaryEntry e in dict)
                    {
                        var key = ToJsonNode(e.Key, m.KeyTypeCode, m.KeyTypeInfo);
                        var keyText = key is JsonValue kv && kv.TryGetValue<string>(out var ks) ? ks : key?.ToJsonString() ?? "null";
                        obj[keyText] = ToJsonNode(e.Value, m.ValueTypeCode, m.ValueTypeInfo);
                    }
                    return obj;
                }
            case ColumnTypeCode.Tuple when info is TupleColumnInfo t && value is System.Runtime.CompilerServices.ITuple tuple:
                {
                    var arr = new JsonArray();
                    for (var i = 0; i < tuple.Length; i++)
                        arr.Add(ToJsonNode(tuple[i], i < t.Elements.Count ? t.Elements[i].TypeCode : ColumnTypeCode.Custom, i < t.Elements.Count ? t.Elements[i].TypeInfo : null));
                    return arr;
                }
            case ColumnTypeCode.Tuple when info is TupleColumnInfo t2 && value is byte[] tb:
                return DecodeTuple(tb, t2);
        }
        return Scalar(value, code);
    }

    private static JsonArray Array(IEnumerable items, ColumnTypeCode code, IColumnInfo? info)
    {
        var arr = new JsonArray();
        foreach (var item in items) arr.Add(ToJsonNode(item, code, info));
        return arr;
    }

    private static JsonNode? Scalar(object value, ColumnTypeCode code) => value switch
    {
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        int i => JsonValue.Create(i),
        short sh => JsonValue.Create(sh),
        sbyte sb => JsonValue.Create(sb),
        long l => JsonValue.Create(l),
        float f => float.IsFinite(f) ? JsonValue.Create(f) : JsonValue.Create(f.ToString(Inv)),
        double d => double.IsFinite(d) ? JsonValue.Create(d) : JsonValue.Create(d.ToString(Inv)),
        decimal m => JsonNode.Parse(m.ToString(Inv)),
        BigInteger bi => JsonNode.Parse(bi.ToString(Inv)),
        Guid g => JsonValue.Create(g.ToString("D")),
        TimeUuid tu => JsonValue.Create(tu.ToString()),
        DateTimeOffset dto => JsonValue.Create(dto.ToUniversalTime().ToString(ValueConverter.DateTimeOffsetFormat, Inv)),
        LocalDate ld => JsonValue.Create(ld.ToString()),
        LocalTime lt => JsonValue.Create(FormatTime(lt)),
        byte[] bytes => JsonValue.Create("0x" + Convert.ToHexString(bytes).ToLowerInvariant()),
        _ => JsonValue.Create(value.ToString()),
    };

    // ------------------------------------------------------------------ binary decoding (UDTs and their fields)

    public static JsonObject DecodeUdt(byte[] bytes, UdtColumnInfo udt)
    {
        var obj = new JsonObject();
        var pos = 0;
        foreach (var f in udt.Fields)
        {
            if (pos + 4 > bytes.Length) { obj[f.Name] = null; continue; }
            var len = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(pos));
            pos += 4;
            if (len < 0) { obj[f.Name] = null; continue; }
            var slice = bytes.AsSpan(pos, Math.Min(len, bytes.Length - pos)).ToArray();
            pos += len;
            obj[f.Name] = DecodeNode(slice, f.TypeCode, f.TypeInfo);
        }
        return obj;
    }

    private static JsonArray DecodeTuple(byte[] bytes, TupleColumnInfo t)
    {
        var arr = new JsonArray();
        var pos = 0;
        foreach (var e in t.Elements)
        {
            if (pos + 4 > bytes.Length) { arr.Add(null); continue; }
            var len = BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(pos));
            pos += 4;
            if (len < 0) { arr.Add(null); continue; }
            arr.Add(DecodeNode(bytes.AsSpan(pos, len).ToArray(), e.TypeCode, e.TypeInfo));
            pos += len;
        }
        return arr;
    }

    /// <summary>Decodes one serialized value (native protocol v3+ encoding) to its JSON form.</summary>
    public static JsonNode? DecodeNode(byte[] b, ColumnTypeCode code, IColumnInfo? info)
    {
        var value = Decode(b, code, info);
        return value is JsonNode node ? node : value is null ? null : ToJsonNode(value, code, info);
    }

    /// <summary>Decodes a serialized value to a CLR value (collections/UDTs/tuples to JSON nodes).</summary>
    public static object? Decode(byte[] b, ColumnTypeCode code, IColumnInfo? info)
    {
        code = Effective(code, info);
        var s = b.AsSpan();
        switch (code)
        {
            case ColumnTypeCode.Ascii:
            case ColumnTypeCode.Text:
            case ColumnTypeCode.Varchar:
                return Encoding.UTF8.GetString(b);
            case ColumnTypeCode.Int: return BinaryPrimitives.ReadInt32BigEndian(s);
            case ColumnTypeCode.Bigint:
            case ColumnTypeCode.Counter: return BinaryPrimitives.ReadInt64BigEndian(s);
            case ColumnTypeCode.SmallInt: return BinaryPrimitives.ReadInt16BigEndian(s);
            case ColumnTypeCode.TinyInt: return (sbyte)b[0];
            case ColumnTypeCode.Boolean: return b.Length > 0 && b[0] != 0;
            case ColumnTypeCode.Double: return BinaryPrimitives.ReadDoubleBigEndian(s);
            case ColumnTypeCode.Float: return BinaryPrimitives.ReadSingleBigEndian(s);
            case ColumnTypeCode.Varint: return new BigInteger(s, isUnsigned: false, isBigEndian: true);
            case ColumnTypeCode.Decimal:
                {
                    var scale = BinaryPrimitives.ReadInt32BigEndian(s);
                    var unscaled = new BigInteger(s[4..], isUnsigned: false, isBigEndian: true);
                    return DecimalText(unscaled, scale);
                }
            case ColumnTypeCode.Uuid:
            case ColumnTypeCode.Timeuuid: return GuidFromBigEndian(s);
            case ColumnTypeCode.Timestamp: return DateTimeOffset.FromUnixTimeMilliseconds(BinaryPrimitives.ReadInt64BigEndian(s));
            case ColumnTypeCode.Date:
                {
                    var days = (long)BinaryPrimitives.ReadUInt32BigEndian(s) - (1L << 31);
                    return DateOnly.FromDateTime(DateTime.UnixEpoch).AddDays((int)days).ToString("yyyy-MM-dd", Inv);
                }
            case ColumnTypeCode.Time:
                {
                    var ns = BinaryPrimitives.ReadInt64BigEndian(s);
                    return FormatTime(new LocalTime(ns));
                }
            case ColumnTypeCode.Inet: return new IPAddress(b).ToString();
            case ColumnTypeCode.Blob: return b;
            case ColumnTypeCode.Duration:
                {
                    var pos = 0;
                    var months = (int)ReadSignedVInt(b, ref pos);
                    var days = (int)ReadSignedVInt(b, ref pos);
                    var nanos = ReadSignedVInt(b, ref pos);
                    return new Duration(months, days, nanos).ToString();
                }
            case ColumnTypeCode.Udt when info is UdtColumnInfo udt: return DecodeUdt(b, udt);
            case ColumnTypeCode.Tuple when info is TupleColumnInfo t: return DecodeTuple(b, t);
            case ColumnTypeCode.List when info is ListColumnInfo l: return DecodeCollection(b, l.ValueTypeCode, l.ValueTypeInfo);
            case ColumnTypeCode.Set when info is SetColumnInfo st: return DecodeCollection(b, st.KeyTypeCode, st.KeyTypeInfo);
            case ColumnTypeCode.Map when info is MapColumnInfo m:
                {
                    var obj = new JsonObject();
                    var pos = 0;
                    var n = BinaryPrimitives.ReadInt32BigEndian(s);
                    pos += 4;
                    for (var i = 0; i < n; i++)
                    {
                        var k = ReadBytes(b, ref pos);
                        var v = ReadBytes(b, ref pos);
                        var key = k is null ? null : DecodeNode(k, m.KeyTypeCode, m.KeyTypeInfo);
                        var keyText = key is JsonValue kv && kv.TryGetValue<string>(out var ks) ? ks : key?.ToJsonString() ?? "null";
                        obj[keyText] = v is null ? null : DecodeNode(v, m.ValueTypeCode, m.ValueTypeInfo);
                    }
                    return obj;
                }
            default:
                return b;
        }
    }

    private static JsonArray DecodeCollection(byte[] b, ColumnTypeCode code, IColumnInfo? info)
    {
        var arr = new JsonArray();
        var pos = 0;
        var n = BinaryPrimitives.ReadInt32BigEndian(b.AsSpan());
        pos += 4;
        for (var i = 0; i < n; i++)
        {
            var e = ReadBytes(b, ref pos);
            arr.Add(e is null ? null : DecodeNode(e, code, info));
        }
        return arr;
    }

    private static byte[]? ReadBytes(byte[] b, ref int pos)
    {
        var len = BinaryPrimitives.ReadInt32BigEndian(b.AsSpan(pos));
        pos += 4;
        if (len < 0) return null;
        var r = b.AsSpan(pos, len).ToArray();
        pos += len;
        return r;
    }

    private static long ReadSignedVInt(byte[] b, ref int pos)
    {
        var first = b[pos++];
        var extra = BitOperations.LeadingZeroCount((uint)(~first & 0xFF)) - 24;
        long value = first & (0xFF >> extra);
        for (var i = 0; i < extra; i++) value = (value << 8) | b[pos++];
        return (long)((ulong)value >> 1) ^ -(value & 1);
    }

    private static Guid GuidFromBigEndian(ReadOnlySpan<byte> s) => new(s[..16], bigEndian: true);

    private static string DecimalText(BigInteger unscaled, int scale)
    {
        if (scale <= 0) return (unscaled * BigInteger.Pow(10, -scale)).ToString(Inv);
        var neg = unscaled.Sign < 0;
        var digits = BigInteger.Abs(unscaled).ToString(Inv).PadLeft(scale + 1, '0');
        var text = digits[..^scale] + "." + digits[^scale..];
        return neg ? "-" + text : text;
    }

    // ------------------------------------------------------------------ bind values

    /// <summary>
    /// Converts a parameter's CLR value (<see cref="DbStudio.Core.Params.ParamValues.ToClr"/>: long/decimal/double/bool/
    /// DateTime/DateTimeOffset/TimeSpan/Guid/byte[]/string) to the CLR type the driver serializes for the bind marker's CQL type.
    /// Complex types are not bound (they are inlined as literals, see <see cref="Literal"/>).
    /// </summary>
    public static object? ToBind(object? v, ColumnTypeCode code, IColumnInfo? info)
    {
        if (v is null) return null;
        code = Effective(code, info);
        try
        {
            switch (code)
            {
                case ColumnTypeCode.Int: return Convert.ToInt32(Num(v), Inv);
                case ColumnTypeCode.SmallInt: return Convert.ToInt16(Num(v), Inv);
                case ColumnTypeCode.TinyInt: return Convert.ToSByte(Num(v), Inv);
                case ColumnTypeCode.Bigint:
                case ColumnTypeCode.Counter: return Convert.ToInt64(Num(v), Inv);
                case ColumnTypeCode.Varint: return v is string vs ? BigInteger.Parse(vs.Trim(), NumberStyles.AllowLeadingSign, Inv) : new BigInteger(Convert.ToDecimal(Num(v), Inv));
                case ColumnTypeCode.Decimal: return Convert.ToDecimal(Num(v), Inv);
                case ColumnTypeCode.Double: return Convert.ToDouble(Num(v), Inv);
                case ColumnTypeCode.Float: return Convert.ToSingle(Num(v), Inv);
                case ColumnTypeCode.Boolean:
                    return v switch
                    {
                        bool b => b,
                        string s => s.Trim().ToLowerInvariant() is "1" or "true" or "yes" or "y" or "t",
                        _ => Convert.ToDecimal(v, Inv) != 0,
                    };
                case ColumnTypeCode.Ascii:
                case ColumnTypeCode.Text:
                case ColumnTypeCode.Varchar:
                    return v is string str ? str : Convert.ToString(v is DateTime dt ? dt.ToString("O", Inv) : v, Inv);
                case ColumnTypeCode.Uuid:
                case ColumnTypeCode.Timeuuid:
                    return v is Guid g ? g : Guid.Parse(v.ToString()!.Trim());
                case ColumnTypeCode.Timestamp:
                    return v switch
                    {
                        DateTimeOffset dto => dto,
                        DateTime d => new DateTimeOffset(d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : DateTime.SpecifyKind(d, DateTimeKind.Utc)),
                        long ms => DateTimeOffset.FromUnixTimeMilliseconds(ms),
                        _ => DateTimeOffset.Parse(v.ToString()!, Inv, DateTimeStyles.AssumeUniversal),
                    };
                case ColumnTypeCode.Date:
                    return v switch
                    {
                        DateTime d => new LocalDate(d.Year, d.Month, d.Day),
                        DateTimeOffset o => new LocalDate(o.Year, o.Month, o.Day),
                        _ => LocalDate.Parse(v.ToString()!.Trim()[..Math.Min(10, v.ToString()!.Trim().Length)]),
                    };
                case ColumnTypeCode.Time:
                    return v switch
                    {
                        TimeSpan ts => new LocalTime(ts.Ticks * 100),
                        DateTime d => new LocalTime(d.TimeOfDay.Ticks * 100),
                        _ => LocalTime.Parse(v.ToString()!.Trim()),
                    };
                case ColumnTypeCode.Duration: return Duration.Parse(v.ToString()!.Trim());
                case ColumnTypeCode.Inet: return IPAddress.Parse(v.ToString()!.Trim());
                case ColumnTypeCode.Blob:
                    return v is byte[] bytes ? bytes : DbStudio.Core.Params.ParamValues.FromBinaryText(v.ToString()!);
                default:
                    return v;
            }
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or InvalidCastException or ArgumentException)
        {
            throw new FormatException($"'{v}' is not a valid {TypeName(code, info)} value: {ex.Message}", ex);
        }
    }

    private static object Num(object v) => v is string s ? decimal.Parse(s.Trim(), NumberStyles.Float, Inv) : v is bool b ? (b ? 1 : 0) : v;

    /// <summary>
    /// A CQL literal for a value of a (complex) type: JSON text from the grid (arrays, objects) or a scalar. Lists and
    /// vectors <c>[…]</c>, sets <c>{…}</c>, maps <c>{k: v}</c>, UDTs <c>{field: v}</c>, tuples <c>(…)</c>.
    /// </summary>
    public static string Literal(object? v, ColumnTypeCode code, IColumnInfo? info)
    {
        if (v is null) return "null";
        code = Effective(code, info);
        if (IsComplex(code) || (code == ColumnTypeCode.Custom && info is VectorColumnInfo))
        {
            JsonNode? node;
            if (v is string text)
            {
                var trimmed = text.Trim();
                if (trimmed.Length == 0) return "null";
                try { node = JsonNode.Parse(trimmed); }
                catch (JsonException ex) { throw new FormatException($"'{text}' is not valid JSON for {TypeName(code, info)}: {ex.Message}", ex); }
            }
            else node = JsonValue.Create(v.ToString());
            return LiteralOf(node, code, info);
        }
        return ScalarLiteral(ToBind(v, code, info), code);
    }

    private static string LiteralOf(JsonNode? node, ColumnTypeCode code, IColumnInfo? info)
    {
        if (node is null) return "null";
        switch (code)
        {
            case ColumnTypeCode.List when info is ListColumnInfo l:
                return "[" + string.Join(", ", Items(node).Select(x => LiteralOf(x, l.ValueTypeCode, l.ValueTypeInfo))) + "]";
            case ColumnTypeCode.Custom when info is VectorColumnInfo v:
                return "[" + string.Join(", ", Items(node).Select(x => LiteralOf(x, v.ValueTypeCode, v.ValueTypeInfo))) + "]";
            case ColumnTypeCode.Set when info is SetColumnInfo s:
                return "{" + string.Join(", ", Items(node).Select(x => LiteralOf(x, s.KeyTypeCode, s.KeyTypeInfo))) + "}";
            case ColumnTypeCode.Tuple when info is TupleColumnInfo t:
                {
                    var items = Items(node).ToList();
                    return "(" + string.Join(", ", t.Elements.Select((e, i) => LiteralOf(i < items.Count ? items[i] : null, e.TypeCode, e.TypeInfo))) + ")";
                }
            case ColumnTypeCode.Map when info is MapColumnInfo m:
                {
                    if (node is not JsonObject o) throw new FormatException("A map value must be a JSON object.");
                    return "{" + string.Join(", ", o.Select(kv =>
                        LiteralOf(JsonValue.Create(kv.Key), m.KeyTypeCode, m.KeyTypeInfo) + ": " + LiteralOf(kv.Value, m.ValueTypeCode, m.ValueTypeInfo))) + "}";
                }
            case ColumnTypeCode.Udt when info is UdtColumnInfo u:
                {
                    if (node is not JsonObject o) throw new FormatException($"A {UdtShortName(u.Name)} value must be a JSON object.");
                    var parts = new List<string>();
                    foreach (var f in u.Fields)
                    {
                        var key = o.FirstOrDefault(kv => string.Equals(kv.Key, f.Name, StringComparison.OrdinalIgnoreCase));
                        if (key.Key is null) continue;
                        parts.Add(CqlText.Quote(f.Name) + ": " + LiteralOf(key.Value, f.TypeCode, f.TypeInfo));
                    }
                    return "{" + string.Join(", ", parts) + "}";
                }
        }
        object? scalar = node switch
        {
            JsonValue jv when jv.GetValueKind() == JsonValueKind.String => jv.GetValue<string>(),
            JsonValue jv when jv.GetValueKind() is JsonValueKind.True or JsonValueKind.False => jv.GetValue<bool>(),
            JsonValue jv when jv.GetValueKind() == JsonValueKind.Number => decimal.TryParse(jv.ToJsonString(), NumberStyles.Float, Inv, out var d) ? d : jv.ToJsonString(),
            _ => node.ToJsonString(),
        };
        if (code is ColumnTypeCode.Udt or ColumnTypeCode.Tuple or ColumnTypeCode.List or ColumnTypeCode.Set or ColumnTypeCode.Map) return scalar?.ToString() ?? "null";
        return ScalarLiteral(ToBind(scalar, code, info), code);
    }

    private static IEnumerable<JsonNode?> Items(JsonNode node) =>
        node is JsonArray a ? a : throw new FormatException("A list, set, tuple or vector value must be a JSON array.");

    public static string ScalarLiteral(object? v, ColumnTypeCode code) => v switch
    {
        null => "null",
        string s => code is ColumnTypeCode.Ascii or ColumnTypeCode.Text or ColumnTypeCode.Varchar ? CqlText.Literal(s) : s,
        bool b => b ? "true" : "false",
        DateTimeOffset dto => CqlText.Literal(dto.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffZ", Inv)),
        LocalDate ld => CqlText.Literal(ld.ToString()),
        LocalTime lt => CqlText.Literal(FormatTime(lt)),
        Guid g => g.ToString("D"),
        byte[] bytes => "0x" + Convert.ToHexString(bytes).ToLowerInvariant(),
        IPAddress ip => CqlText.Literal(ip.ToString()),
        Duration d => d.ToString(),
        float f => f.ToString("R", Inv),
        double d => d.ToString("R", Inv),
        IFormattable f => f.ToString(null, Inv),
        _ => CqlText.Literal(v.ToString() ?? ""),
    };
}
