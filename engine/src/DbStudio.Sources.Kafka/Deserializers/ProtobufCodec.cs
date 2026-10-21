using System.Buffers;
using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Google.Protobuf.Reflection;
using ProtoBuf.Reflection;

namespace DbStudio.Sources.Kafka.Deserializers;

/// <summary>
/// Protobuf payloads of the Confluent wire format without generated classes (docs/PLAN-M2.md 7.4): the registry's .proto
/// text is parsed with protobuf-net.Reflection into descriptors, and the binary message is walked field by field into
/// proto3-style JSON (field names, enums by name, bytes base64, 64-bit integers as numbers when JS-safe, else strings).
/// Encoding does the reverse for produce. Message indexes (after the schema id) pick the message type in the file.
/// </summary>
public sealed class ProtobufSchema
{
    private readonly Dictionary<string, DescriptorProto> _messages = new(StringComparer.Ordinal);
    private readonly Dictionary<string, EnumDescriptorProto> _enums = new(StringComparer.Ordinal);
    private readonly FileDescriptorProto _main;

    private ProtobufSchema(FileDescriptorSet set, FileDescriptorProto main)
    {
        _main = main;
        foreach (var f in set.Files)
        {
            var prefix = string.IsNullOrEmpty(f.Package) ? "." : $".{f.Package}.";
            foreach (var m in f.MessageTypes) Index(prefix, m);
            foreach (var e in f.EnumTypes) _enums[prefix + e.Name] = e;
        }
    }

    private void Index(string prefix, DescriptorProto m)
    {
        var full = prefix + m.Name;
        _messages[full] = m;
        foreach (var n in m.NestedTypes) Index(full + ".", n);
        foreach (var e in m.EnumTypes) _enums[$"{full}.{e.Name}"] = e;
    }

    /// <param name="imports">Referenced schemas by import name (registry references), e.g. <c>"other.proto" → text</c>.</param>
    public static ProtobufSchema Parse(string schema, IReadOnlyDictionary<string, string>? imports = null)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal) { ["__main.proto"] = schema };
        foreach (var (name, text) in imports ?? new Dictionary<string, string>()) files[name] = text;
        var set = new FileDescriptorSet { FileSystem = new MemoryFileSystem(files), AllowNameOnlyImport = true };
        if (!set.Add("__main.proto", true, new StringReader(schema))) throw new FormatException("Invalid .proto schema.");
        try { set.Process(); }
        catch (Exception ex) when (ex is not FormatException) { throw new FormatException($"Invalid .proto schema: {ex.Message}", ex); }
        var errors = set.GetErrors().Where(e => e.IsError).ToList();
        if (errors.Count > 0) throw new FormatException("Invalid .proto schema: " + string.Join("; ", errors.Select(e => e.Message)));
        var main = set.Files.FirstOrDefault(f => f.Name == "__main.proto") ?? set.Files.FirstOrDefault(f => f.IncludeInOutput)
            ?? throw new FormatException("Invalid .proto schema: no file was parsed.");
        return new ProtobufSchema(set, main);
    }

    /// <summary>Message type addressed by Confluent message indexes ([] or [0] = first top-level message).</summary>
    public DescriptorProto MessageAt(IReadOnlyList<int> indexes)
    {
        if (_main.MessageTypes.Count == 0) throw new FormatException("The schema defines no message type.");
        if (indexes.Count == 0) return _main.MessageTypes[0];
        if (indexes[0] >= _main.MessageTypes.Count) throw new FormatException($"Message index {indexes[0]} is out of range.");
        var m = _main.MessageTypes[indexes[0]];
        for (var i = 1; i < indexes.Count; i++)
        {
            if (indexes[i] >= m.NestedTypes.Count) throw new FormatException($"Nested message index {indexes[i]} is out of range.");
            m = m.NestedTypes[indexes[i]];
        }
        return m;
    }

    /// <summary>Full name (".pkg.Msg") to message indexes, for produce with a named message.</summary>
    public IReadOnlyList<int> IndexesOf(string? messageName)
    {
        if (string.IsNullOrEmpty(messageName)) return [0];
        for (var i = 0; i < _main.MessageTypes.Count; i++)
        {
            var path = Find(_main.MessageTypes[i], messageName.TrimStart('.'), [i]);
            if (path is not null) return path;
        }
        throw new FormatException($"Message type '{messageName}' is not defined in the schema.");
    }

    private static List<int>? Find(DescriptorProto m, string name, List<int> path)
    {
        if (m.Name == name || name.EndsWith("." + m.Name, StringComparison.Ordinal) && path.Count == 1) return path;
        for (var j = 0; j < m.NestedTypes.Count; j++)
        {
            var r = Find(m.NestedTypes[j], name.Contains('.') ? name[(name.IndexOf('.') + 1)..] : name, [.. path, j]);
            if (r is not null && (name == m.NestedTypes[j].Name || name.EndsWith("." + m.NestedTypes[j].Name, StringComparison.Ordinal))) return r;
        }
        return null;
    }

    // ---------------------------------------------------------------- decode

    public JsonElement Decode(DescriptorProto message, ReadOnlySpan<byte> payload)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer))
        {
            var r = new WireReader(payload.ToArray());
            WriteMessage(w, message, ref r, payload.Length);
        }
        using var doc = JsonDocument.Parse(buffer.WrittenMemory);
        return doc.RootElement.Clone();
    }

    private void WriteMessage(Utf8JsonWriter w, DescriptorProto message, ref WireReader r, int end)
    {
        // Collect values per field first: repeated fields may be interleaved on the wire.
        var values = new SortedDictionary<int, List<Action<Utf8JsonWriter>>>();
        var unknown = new List<string>();
        while (r.Pos < end)
        {
            var tag = r.Varint();
            var number = (int)(tag >> 3);
            var wire = (int)(tag & 7);
            var field = message.Fields.FirstOrDefault(f => f.Number == number);
            if (field is null)
            {
                unknown.Add(number.ToString(CultureInfo.InvariantCulture));
                r.Skip(wire);
                continue;
            }
            if (!values.TryGetValue(number, out var list)) values[number] = list = [];
            if (wire == 2 && IsPackable(field.type))
            {
                var len = (int)r.Varint();
                var stop = r.Pos + len;
                while (r.Pos < stop) list.Add(Scalar(field, ref r, WireTypeOf(field.type)));
                continue;
            }
            list.Add(Value(field, ref r, wire));
        }

        w.WriteStartObject();
        foreach (var (number, list) in values)
        {
            var field = message.Fields.First(f => f.Number == number);
            w.WritePropertyName(field.Name);
            var entry = MapEntryOf(field);
            if (entry is not null)
            {
                w.WriteStartObject();
                foreach (var write in list) write(w); // map entries write "key": value pairs
                w.WriteEndObject();
            }
            else if (field.label == FieldDescriptorProto.Label.LabelRepeated)
            {
                w.WriteStartArray();
                foreach (var write in list) write(w);
                w.WriteEndArray();
            }
            else list[^1](w); // last one wins
        }
        if (unknown.Count > 0)
        {
            w.WritePropertyName("$unknownFields");
            w.WriteStartArray();
            foreach (var u in unknown.Distinct()) w.WriteNumberValue(int.Parse(u, CultureInfo.InvariantCulture));
            w.WriteEndArray();
        }
        w.WriteEndObject();
    }

    private Action<Utf8JsonWriter> Value(FieldDescriptorProto field, ref WireReader r, int wire)
    {
        if (field.type is FieldDescriptorProto.Type.TypeMessage)
        {
            if (wire != 2) throw new FormatException($"Field {field.Name}: expected length-delimited message.");
            var len = (int)r.Varint();
            var bytes = r.Bytes(len);
            var msg = Message(field.TypeName);
            if (msg.Options?.MapEntry == true)
            {
                var sub = new WireReader(bytes);
                string key = "";
                Action<Utf8JsonWriter> val = w => w.WriteNullValue();
                var keyField = msg.Fields.First(f => f.Number == 1);
                var valField = msg.Fields.FirstOrDefault(f => f.Number == 2);
                while (sub.Pos < bytes.Length)
                {
                    var tag = sub.Varint();
                    var n = (int)(tag >> 3);
                    var wt = (int)(tag & 7);
                    if (n == 1) key = KeyText(keyField, ref sub, wt);
                    else if (n == 2 && valField is not null) val = Value(valField, ref sub, wt);
                    else sub.Skip(wt);
                }
                return w =>
                {
                    w.WritePropertyName(key);
                    val(w);
                };
            }
            var buffer = new ArrayBufferWriter<byte>();
            using (var inner = new Utf8JsonWriter(buffer))
            {
                var sub = new WireReader(bytes);
                WriteMessage(inner, msg, ref sub, bytes.Length);
            }
            var json = Encoding.UTF8.GetString(buffer.WrittenSpan);
            return w => w.WriteRawValue(json, skipInputValidation: true);
        }
        if (field.type is FieldDescriptorProto.Type.TypeGroup) throw new FormatException($"Field {field.Name}: groups are not supported.");
        return Scalar(field, ref r, wire);
    }

    private string KeyText(FieldDescriptorProto keyField, ref WireReader r, int wire)
    {
        var write = Scalar(keyField, ref r, wire);
        var buffer = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(buffer)) write(w);
        using var doc = JsonDocument.Parse(buffer.WrittenMemory);
        return doc.RootElement.ValueKind == JsonValueKind.String ? doc.RootElement.GetString()! : doc.RootElement.GetRawText();
    }

    private Action<Utf8JsonWriter> Scalar(FieldDescriptorProto field, ref WireReader r, int wire)
    {
        switch (field.type)
        {
            case FieldDescriptorProto.Type.TypeString:
            {
                var s = Encoding.UTF8.GetString(r.Bytes((int)r.Varint()));
                return w => w.WriteStringValue(s);
            }
            case FieldDescriptorProto.Type.TypeBytes:
            {
                var b = Convert.ToBase64String(r.Bytes((int)r.Varint()));
                return w => w.WriteStringValue(b);
            }
            case FieldDescriptorProto.Type.TypeBool:
            {
                var b = r.Varint() != 0;
                return w => w.WriteBooleanValue(b);
            }
            case FieldDescriptorProto.Type.TypeInt32:
            {
                var v = (int)(long)r.Varint();
                return w => w.WriteNumberValue(v);
            }
            case FieldDescriptorProto.Type.TypeUint32:
            {
                var v = (uint)r.Varint();
                return w => w.WriteNumberValue(v);
            }
            case FieldDescriptorProto.Type.TypeSint32:
            {
                var u = (uint)r.Varint();
                var v = (int)(u >> 1) ^ -(int)(u & 1);
                return w => w.WriteNumberValue(v);
            }
            case FieldDescriptorProto.Type.TypeInt64: return Long((long)r.Varint());
            case FieldDescriptorProto.Type.TypeUint64: return ULong(r.Varint());
            case FieldDescriptorProto.Type.TypeSint64:
            {
                var u = r.Varint();
                return Long((long)(u >> 1) ^ -(long)(u & 1));
            }
            case FieldDescriptorProto.Type.TypeFixed32:
            {
                var v = BinaryPrimitives.ReadUInt32LittleEndian(r.Bytes(4));
                return w => w.WriteNumberValue(v);
            }
            case FieldDescriptorProto.Type.TypeSfixed32:
            {
                var v = BinaryPrimitives.ReadInt32LittleEndian(r.Bytes(4));
                return w => w.WriteNumberValue(v);
            }
            case FieldDescriptorProto.Type.TypeFloat:
            {
                var v = BinaryPrimitives.ReadSingleLittleEndian(r.Bytes(4));
                return w => { if (float.IsFinite(v)) w.WriteNumberValue(v); else w.WriteStringValue(v.ToString(CultureInfo.InvariantCulture)); };
            }
            case FieldDescriptorProto.Type.TypeFixed64: return ULong(BinaryPrimitives.ReadUInt64LittleEndian(r.Bytes(8)));
            case FieldDescriptorProto.Type.TypeSfixed64: return Long(BinaryPrimitives.ReadInt64LittleEndian(r.Bytes(8)));
            case FieldDescriptorProto.Type.TypeDouble:
            {
                var v = BinaryPrimitives.ReadDoubleLittleEndian(r.Bytes(8));
                return w => { if (double.IsFinite(v)) w.WriteNumberValue(v); else w.WriteStringValue(v.ToString(CultureInfo.InvariantCulture)); };
            }
            case FieldDescriptorProto.Type.TypeEnum:
            {
                var n = (int)(long)r.Varint();
                var name = _enums.TryGetValue(field.TypeName, out var e) ? e.Values.FirstOrDefault(x => x.Number == n)?.Name : null;
                return w => { if (name is not null) w.WriteStringValue(name); else w.WriteNumberValue(n); };
            }
            default:
                r.Skip(wire);
                return w => w.WriteNullValue();
        }
    }

    private const long MaxSafe = 9007199254740991;

    private static Action<Utf8JsonWriter> Long(long v) => v is >= -MaxSafe and <= MaxSafe
        ? w => w.WriteNumberValue(v) : w => w.WriteStringValue(v.ToString(CultureInfo.InvariantCulture));

    private static Action<Utf8JsonWriter> ULong(ulong v) => v <= MaxSafe
        ? w => w.WriteNumberValue(v) : w => w.WriteStringValue(v.ToString(CultureInfo.InvariantCulture));

    // ---------------------------------------------------------------- encode

    public byte[] Encode(DescriptorProto message, JsonElement value)
    {
        var buf = new ArrayBufferWriter<byte>();
        EncodeMessage(buf, message, value, "$");
        return buf.WrittenSpan.ToArray();
    }

    private void EncodeMessage(ArrayBufferWriter<byte> buf, DescriptorProto message, JsonElement value, string path)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new FormatException($"{path}: expected an object for {message.Name}.");
        foreach (var p in value.EnumerateObject())
        {
            var field = message.Fields.FirstOrDefault(f => f.Name == p.Name || f.JsonName == p.Name)
                ?? throw new FormatException($"{path}.{p.Name}: {message.Name} has no such field.");
            var fp = $"{path}.{p.Name}";
            if (p.Value.ValueKind == JsonValueKind.Null) continue;
            if (MapEntryOf(field) is { } entry)
            {
                if (p.Value.ValueKind != JsonValueKind.Object) throw new FormatException($"{fp}: expected an object (map).");
                var keyField = entry.Fields.First(f => f.Number == 1);
                var valField = entry.Fields.First(f => f.Number == 2);
                foreach (var kv in p.Value.EnumerateObject())
                {
                    var sub = new ArrayBufferWriter<byte>();
                    using (var keyDoc = JsonDocument.Parse(KeyJson(keyField, kv.Name))) EncodeField(sub, keyField, keyDoc.RootElement, $"{fp}.{kv.Name}");
                    EncodeField(sub, valField, kv.Value, $"{fp}.{kv.Name}");
                    WriteTag(buf, field.Number, 2);
                    WriteVarint(buf, (ulong)sub.WrittenCount);
                    buf.Write(sub.WrittenSpan);
                }
            }
            else if (field.label == FieldDescriptorProto.Label.LabelRepeated)
            {
                if (p.Value.ValueKind != JsonValueKind.Array) throw new FormatException($"{fp}: expected an array.");
                if (IsPackable(field.type))
                {
                    var sub = new ArrayBufferWriter<byte>();
                    var i = 0;
                    foreach (var item in p.Value.EnumerateArray()) WriteScalar(sub, field, item, $"{fp}[{i++}]");
                    WriteTag(buf, field.Number, 2);
                    WriteVarint(buf, (ulong)sub.WrittenCount);
                    buf.Write(sub.WrittenSpan);
                }
                else
                {
                    var i = 0;
                    foreach (var item in p.Value.EnumerateArray()) EncodeField(buf, field, item, $"{fp}[{i++}]");
                }
            }
            else EncodeField(buf, field, p.Value, fp);
        }
    }

    private static string KeyJson(FieldDescriptorProto keyField, string key) =>
        keyField.type is FieldDescriptorProto.Type.TypeString ? JsonSerializer.Serialize(key)
        : keyField.type is FieldDescriptorProto.Type.TypeBool ? key.ToLowerInvariant() : key;

    private void EncodeField(ArrayBufferWriter<byte> buf, FieldDescriptorProto field, JsonElement v, string path)
    {
        if (field.type is FieldDescriptorProto.Type.TypeMessage)
        {
            var sub = new ArrayBufferWriter<byte>();
            EncodeMessage(sub, Message(field.TypeName), v, path);
            WriteTag(buf, field.Number, 2);
            WriteVarint(buf, (ulong)sub.WrittenCount);
            buf.Write(sub.WrittenSpan);
            return;
        }
        WriteTag(buf, field.Number, WireTypeOf(field.type));
        WriteScalar(buf, field, v, path);
    }

    private void WriteScalar(ArrayBufferWriter<byte> buf, FieldDescriptorProto field, JsonElement v, string path)
    {
        try
        {
            switch (field.type)
            {
                case FieldDescriptorProto.Type.TypeString:
                    var s = Encoding.UTF8.GetBytes(v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new FormatException($"{path}: expected a string."));
                    WriteVarint(buf, (ulong)s.Length);
                    buf.Write(s);
                    break;
                case FieldDescriptorProto.Type.TypeBytes:
                    var b = Convert.FromBase64String(v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new FormatException($"{path}: expected base64 bytes."));
                    WriteVarint(buf, (ulong)b.Length);
                    buf.Write(b);
                    break;
                case FieldDescriptorProto.Type.TypeBool:
                    WriteVarint(buf, v.ValueKind switch { JsonValueKind.True => 1UL, JsonValueKind.False => 0UL, _ => throw new FormatException($"{path}: expected true/false.") });
                    break;
                case FieldDescriptorProto.Type.TypeInt32: WriteVarint(buf, (ulong)(long)Int(v, path, int.MinValue, int.MaxValue)); break;
                case FieldDescriptorProto.Type.TypeInt64: WriteVarint(buf, (ulong)Int(v, path, long.MinValue, long.MaxValue)); break;
                case FieldDescriptorProto.Type.TypeUint32: WriteVarint(buf, (ulong)Int(v, path, 0, uint.MaxValue)); break;
                case FieldDescriptorProto.Type.TypeUint64: WriteVarint(buf, UInt(v, path)); break;
                case FieldDescriptorProto.Type.TypeSint32:
                    var i32 = (int)Int(v, path, int.MinValue, int.MaxValue);
                    WriteVarint(buf, (uint)((i32 << 1) ^ (i32 >> 31)));
                    break;
                case FieldDescriptorProto.Type.TypeSint64:
                    var i64 = Int(v, path, long.MinValue, long.MaxValue);
                    WriteVarint(buf, (ulong)((i64 << 1) ^ (i64 >> 63)));
                    break;
                case FieldDescriptorProto.Type.TypeFixed32: Fixed(buf, 4, s2 => BinaryPrimitives.WriteUInt32LittleEndian(s2, (uint)Int(v, path, 0, uint.MaxValue))); break;
                case FieldDescriptorProto.Type.TypeSfixed32: Fixed(buf, 4, s2 => BinaryPrimitives.WriteInt32LittleEndian(s2, (int)Int(v, path, int.MinValue, int.MaxValue))); break;
                case FieldDescriptorProto.Type.TypeFixed64: Fixed(buf, 8, s2 => BinaryPrimitives.WriteUInt64LittleEndian(s2, UInt(v, path))); break;
                case FieldDescriptorProto.Type.TypeSfixed64: Fixed(buf, 8, s2 => BinaryPrimitives.WriteInt64LittleEndian(s2, Int(v, path, long.MinValue, long.MaxValue))); break;
                case FieldDescriptorProto.Type.TypeFloat: Fixed(buf, 4, s2 => BinaryPrimitives.WriteSingleLittleEndian(s2, (float)Num(v, path))); break;
                case FieldDescriptorProto.Type.TypeDouble: Fixed(buf, 8, s2 => BinaryPrimitives.WriteDoubleLittleEndian(s2, Num(v, path))); break;
                case FieldDescriptorProto.Type.TypeEnum:
                    int number;
                    if (v.ValueKind == JsonValueKind.Number) number = v.GetInt32();
                    else
                    {
                        var name = v.GetString();
                        number = _enums.TryGetValue(field.TypeName, out var e) && e.Values.FirstOrDefault(x => x.Name == name) is { } ev
                            ? ev.Number : throw new FormatException($"{path}: '{name}' is not a value of {field.TypeName.TrimStart('.')}.");
                    }
                    WriteVarint(buf, (ulong)(long)number);
                    break;
                default: throw new FormatException($"{path}: unsupported field type {field.type}.");
            }
        }
        catch (InvalidOperationException) { throw new FormatException($"{path}: wrong JSON type for {field.type}."); }
    }

    private static long Int(JsonElement v, string path, long min, long max)
    {
        long n = v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt64(out var x) => x,
            JsonValueKind.String when long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var y) => y,
            _ => throw new FormatException($"{path}: expected an integer."),
        };
        if (n < min || n > max) throw new FormatException($"{path}: {n} is out of range.");
        return n;
    }

    private static ulong UInt(JsonElement v, string path) => v.ValueKind switch
    {
        JsonValueKind.Number when v.TryGetUInt64(out var x) => x,
        JsonValueKind.String when ulong.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var y) => y,
        _ => throw new FormatException($"{path}: expected an unsigned integer."),
    };

    private static double Num(JsonElement v, string path) => v.ValueKind switch
    {
        JsonValueKind.Number => v.GetDouble(),
        JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
        _ => throw new FormatException($"{path}: expected a number."),
    };

    private static void Fixed(ArrayBufferWriter<byte> buf, int size, SpanAction write)
    {
        var span = buf.GetSpan(size)[..size];
        write(span);
        buf.Advance(size);
    }

    private delegate void SpanAction(Span<byte> span);

    private static void WriteTag(ArrayBufferWriter<byte> buf, int number, int wire) => WriteVarint(buf, ((ulong)number << 3) | (uint)wire);

    internal static void WriteVarint(IBufferWriter<byte> buf, ulong v)
    {
        var span = buf.GetSpan(10);
        var i = 0;
        while (v >= 0x80)
        {
            span[i++] = (byte)(v | 0x80);
            v >>= 7;
        }
        span[i++] = (byte)v;
        buf.Advance(i);
    }

    private DescriptorProto Message(string typeName) =>
        _messages.TryGetValue(typeName, out var m) ? m : throw new FormatException($"Unknown message type {typeName}.");

    private DescriptorProto? MapEntryOf(FieldDescriptorProto field) =>
        field.type is FieldDescriptorProto.Type.TypeMessage && field.label == FieldDescriptorProto.Label.LabelRepeated
            && _messages.TryGetValue(field.TypeName, out var m) && m.Options?.MapEntry == true ? m : null;

    private static bool IsPackable(FieldDescriptorProto.Type t) => t is not (FieldDescriptorProto.Type.TypeString or FieldDescriptorProto.Type.TypeBytes
        or FieldDescriptorProto.Type.TypeMessage or FieldDescriptorProto.Type.TypeGroup);

    private static int WireTypeOf(FieldDescriptorProto.Type t) => t switch
    {
        FieldDescriptorProto.Type.TypeDouble or FieldDescriptorProto.Type.TypeFixed64 or FieldDescriptorProto.Type.TypeSfixed64 => 1,
        FieldDescriptorProto.Type.TypeFloat or FieldDescriptorProto.Type.TypeFixed32 or FieldDescriptorProto.Type.TypeSfixed32 => 5,
        FieldDescriptorProto.Type.TypeString or FieldDescriptorProto.Type.TypeBytes or FieldDescriptorProto.Type.TypeMessage => 2,
        _ => 0,
    };

    private ref struct WireReader(byte[] data)
    {
        private readonly byte[] _data = data;
        public int Pos;

        public ulong Varint()
        {
            ulong result = 0;
            for (var shift = 0; shift < 70; shift += 7)
            {
                if (Pos >= _data.Length) throw new FormatException("Truncated protobuf varint.");
                var b = _data[Pos++];
                result |= (ulong)(b & 0x7f) << shift;
                if (b < 0x80) return result;
            }
            throw new FormatException("Malformed protobuf varint.");
        }

        public byte[] Bytes(int len)
        {
            if (len < 0 || Pos + len > _data.Length) throw new FormatException("Truncated protobuf field.");
            var b = _data.AsSpan(Pos, len).ToArray();
            Pos += len;
            return b;
        }

        public void Skip(int wire)
        {
            switch (wire)
            {
                case 0: Varint(); break;
                case 1: Bytes(8); break;
                case 2: Bytes((int)Varint()); break;
                case 5: Bytes(4); break;
                default: throw new FormatException($"Unsupported protobuf wire type {wire}.");
            }
        }
    }

    private sealed class MemoryFileSystem(IReadOnlyDictionary<string, string> files) : IFileSystem
    {
        public bool Exists(string path) => files.ContainsKey(Norm(path));

        public TextReader? OpenText(string path) => files.TryGetValue(Norm(path), out var text) ? new StringReader(text) : null;

        private static string Norm(string path) => path.Replace('\\', '/').TrimStart('/');
    }
}

/// <summary>Confluent Protobuf message-index prefix (zig-zag varint count, then indexes; a single 0 means [0]).</summary>
public static class ProtobufIndexes
{
    public static IReadOnlyList<int> Read(ReadOnlySpan<byte> data, out int consumed)
    {
        var pos = 0;
        var count = ZigZag(data, ref pos);
        var list = new List<int>();
        if (count == 0) list.Add(0);
        else
        {
            if (count < 0 || count > 100) throw new FormatException("Invalid Protobuf message indexes.");
            for (var i = 0; i < count; i++) list.Add(ZigZag(data, ref pos));
        }
        consumed = pos;
        return list;
    }

    public static byte[] Write(IReadOnlyList<int> indexes)
    {
        var buf = new ArrayBufferWriter<byte>();
        if (indexes.Count == 1 && indexes[0] == 0)
        {
            buf.Write([(byte)0]);
            return buf.WrittenSpan.ToArray();
        }
        ProtobufSchema.WriteVarint(buf, Zig(indexes.Count));
        foreach (var i in indexes) ProtobufSchema.WriteVarint(buf, Zig(i));
        return buf.WrittenSpan.ToArray();
    }

    private static ulong Zig(int v) => (uint)((v << 1) ^ (v >> 31));

    private static int ZigZag(ReadOnlySpan<byte> data, ref int pos)
    {
        uint result = 0;
        for (var shift = 0; shift < 35; shift += 7)
        {
            if (pos >= data.Length) throw new FormatException("Truncated Protobuf message indexes.");
            var b = data[pos++];
            result |= (uint)(b & 0x7f) << shift;
            if (b < 0x80) return (int)(result >> 1) ^ -(int)(result & 1);
        }
        throw new FormatException("Malformed Protobuf message indexes.");
    }
}
