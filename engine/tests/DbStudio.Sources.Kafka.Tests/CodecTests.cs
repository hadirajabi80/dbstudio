using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Deserializers;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

// docs/PLAN-M2.md 7.4 deserializers: string/json/hex/int32/int64/avro/protobuf/jsonschema/auto and the produce encoders.
public sealed class CodecTests
{
    public const string OrderAvro = """
        {"type":"record","name":"Order","namespace":"shop","fields":[
          {"name":"id","type":"long"},{"name":"customer","type":"string"},{"name":"total","type":"double"},
          {"name":"status","type":{"type":"enum","name":"Status","symbols":["NEW","PAID"]}},
          {"name":"note","type":["null","string"],"default":null},
          {"name":"tags","type":{"type":"array","items":"string"}},
          {"name":"attrs","type":{"type":"map","values":"int"}},
          {"name":"created","type":{"type":"long","logicalType":"timestamp-millis"}}]}
        """;

    public const string OrderProto = """
        syntax = "proto3";
        package shop;
        enum Status { NEW = 0; PAID = 1; }
        message Order {
          int64 id = 1;
          string customer = 2;
          double total = 3;
          Status status = 4;
          repeated string tags = 5;
          map<string, int32> attrs = 6;
          Item item = 7;
          repeated int32 qty = 8;
          sint32 delta = 9;
          message Item { string sku = 1; }
        }
        message Other { string name = 1; }
        """;

    private static MessageCodec Codec(FakeSchemaRegistry? sr = null) =>
        new(new SchemaCache(sr is null ? null : new HttpSchemaRegistry("http://registry.test", null, null, sr)));

    private static ValueTask<KafkaDecoded> Decode(MessageCodec c, byte[]? data, string format, bool full = false) => c.DecodeAsync(data, format, full, CancellationToken.None);

    [Fact]
    public async Task String_decodes_utf8()
    {
        var d = await Decode(Codec(), Encoding.UTF8.GetBytes("héllo ✓"), "string");
        Assert.Equal("héllo ✓", d.Text);
        Assert.Null(d.Error);
    }

    [Fact]
    public async Task Invalid_utf8_falls_back_to_hex_and_is_flagged()
    {
        var d = await Decode(Codec(), [0xff, 0xfe, 0x41], "string");
        Assert.Equal("fffe41", d.Text);
        Assert.Equal("fffe41", d.Hex);
        Assert.Contains("UTF-8", d.Error);
    }

    [Fact]
    public async Task Null_payload_is_a_null_text()
    {
        var d = await Decode(Codec(), null, "json");
        Assert.Null(d.Text);
        Assert.Equal("json", d.Format);
    }

    [Fact]
    public async Task Json_is_parsed()
    {
        var d = await Decode(Codec(), Encoding.UTF8.GetBytes("""{"id":1,"tags":["a"]}"""), "json");
        Assert.Equal(1, d.Json!.Value.GetProperty("id").GetInt32());
        Assert.Null(d.Error);
    }

    [Fact]
    public async Task Invalid_json_keeps_the_text_and_reports_the_error()
    {
        var d = await Decode(Codec(), Encoding.UTF8.GetBytes("{oops"), "json");
        Assert.Equal("{oops", d.Text);
        Assert.Null(d.Json);
        Assert.StartsWith("Invalid JSON", d.Error);
    }

    [Fact]
    public async Task Hex_shows_lowercase_bytes()
    {
        var d = await Decode(Codec(), [0x00, 0xab, 0x10], "hex");
        Assert.Equal("00ab10", d.Text);
    }

    [Theory]
    [InlineData(new byte[] { 0, 0, 1, 0 }, "int32", "256")]
    [InlineData(new byte[] { 0xff, 0xff, 0xff, 0xff }, "int32", "-1")]
    [InlineData(new byte[] { 0, 0, 0, 0, 0, 0, 0, 42 }, "int64", "42")]
    public async Task Integers_are_big_endian(byte[] data, string format, string expected)
    {
        var d = await Decode(Codec(), data, format);
        Assert.Equal(expected, d.Text);
        Assert.Null(d.Error);
    }

    [Fact]
    public async Task Integer_with_wrong_length_is_an_error_with_hex()
    {
        var d = await Decode(Codec(), [1, 2, 3], "int32");
        Assert.Contains("exactly 4 bytes", d.Error);
        Assert.Equal("010203", d.Hex);
    }

    [Fact]
    public async Task Long_text_is_truncated_at_32_KB_unless_full()
    {
        var big = new string('x', 40_000);
        var cut = await Decode(Codec(), Encoding.UTF8.GetBytes(big), "string");
        var t = Assert.IsType<TruncatedValue>(cut.Text);
        Assert.Equal(40_000, t.Len);
        Assert.Equal(32 * 1024, t.Trunc.Length);
        Assert.Equal(big, cut.FullText);
        var full = await Decode(Codec(), Encoding.UTF8.GetBytes(big), "string", full: true);
        Assert.Equal(big, full.Text);
    }

    [Fact]
    public async Task Truncated_text_serializes_as_trunc_object()
    {
        var d = await Decode(Codec(), Encoding.UTF8.GetBytes(new string('y', 33_000)), "json");
        var json = JsonSerializer.SerializeToElement(d, CoreJson.Options);
        Assert.Equal(33_000, json.GetProperty("text").GetProperty("len").GetInt32());
        Assert.False(json.TryGetProperty("json", out _));
        Assert.False(json.TryGetProperty("schemaId", out _));
    }

    [Fact]
    public async Task Auto_detects_json_and_plain_strings()
    {
        var c = Codec();
        Assert.Equal("json", (await Decode(c, Encoding.UTF8.GetBytes("  [1,2]"), "auto")).Format);
        Assert.Equal("string", (await Decode(c, Encoding.UTF8.GetBytes("plain"), "auto")).Format);
        Assert.Equal("string", (await Decode(c, Encoding.UTF8.GetBytes("{not json"), "auto")).Format);
    }

    [Fact]
    public async Task Avro_without_registry_reports_not_configured()
    {
        var d = await Decode(Codec(), FakeSchemaRegistry.Frame(1, [2]), "avro");
        Assert.Contains("No Schema Registry", d.Error);
    }

    [Fact]
    public async Task Avro_requires_the_wire_format()
    {
        var sr = new FakeSchemaRegistry();
        var d = await Decode(Codec(sr), Encoding.UTF8.GetBytes("hello"), "avro");
        Assert.Contains("wire format", d.Error);
    }

    private static byte[] AvroOrder(FakeSchemaRegistry sr, out int id)
    {
        var e = sr.Register("orders-value", "AVRO", OrderAvro);
        id = e.Id;
        var schema = AvroCodec.Parse(OrderAvro);
        var payload = AvroCodec.Encode(schema, Util.Json("""
            {"id":10231,"customer":"cust-42","total":120.5,"status":"PAID","note":{"string":"rush"},
             "tags":["a","b"],"attrs":{"x":1},"created":"2026-10-18T14:02:11Z"}
            """));
        return FakeSchemaRegistry.Frame(e.Id, payload);
    }

    [Fact]
    public async Task Avro_decodes_records_enums_unions_arrays_maps_and_logical_types()
    {
        var sr = new FakeSchemaRegistry();
        var data = AvroOrder(sr, out var id);
        var d = await Decode(Codec(sr), data, "avro");
        Assert.Null(d.Error);
        Assert.Equal(id, d.SchemaId);
        Assert.Equal("orders-value", d.SchemaSubject);
        var j = d.Json!.Value;
        Assert.Equal(10231, j.GetProperty("id").GetInt64());
        Assert.Equal("PAID", j.GetProperty("status").GetString());
        Assert.Equal("rush", j.GetProperty("note").GetString());
        Assert.Equal(2, j.GetProperty("tags").GetArrayLength());
        Assert.Equal(1, j.GetProperty("attrs").GetProperty("x").GetInt32());
        Assert.StartsWith("2026-10-18T14:02:11", j.GetProperty("created").GetString());
    }

    [Fact]
    public async Task Auto_uses_the_registry_for_the_magic_byte()
    {
        var sr = new FakeSchemaRegistry();
        var d = await Decode(Codec(sr), AvroOrder(sr, out _), "auto");
        Assert.Equal("avro", d.Format);
        Assert.Equal("cust-42", d.Json!.Value.GetProperty("customer").GetString());
    }

    [Fact]
    public async Task Schemas_are_cached_per_id()
    {
        var sr = new FakeSchemaRegistry();
        var data = AvroOrder(sr, out var id);
        var c = Codec(sr);
        await Decode(c, data, "avro");
        await Decode(c, data, "avro");
        Assert.Single(sr.Requests, r => r == $"schemas/ids/{id}");
    }

    [Fact]
    public async Task Unknown_schema_id_is_a_decode_error_not_a_failure()
    {
        var sr = new FakeSchemaRegistry();
        var d = await Decode(Codec(sr), FakeSchemaRegistry.Frame(99, [1, 2]), "avro");
        Assert.Contains("Schema Registry", d.Error);
        Assert.NotNull(d.Hex);
    }

    [Fact]
    public async Task Wrong_schema_type_is_reported()
    {
        var sr = new FakeSchemaRegistry();
        var data = AvroOrder(sr, out _);
        var d = await Decode(Codec(sr), data, "protobuf");
        Assert.Contains("is AVRO", d.Error);
    }

    [Fact]
    public void Avro_encode_applies_defaults_and_rejects_bad_values()
    {
        var schema = AvroCodec.Parse(OrderAvro);
        var noNote = AvroCodec.Encode(schema, Util.Json("""{"id":1,"customer":"c","total":1,"status":"NEW","tags":[],"attrs":{},"created":0}"""));
        Assert.NotEmpty(noNote);
        var ex = Assert.Throws<FormatException>(() => AvroCodec.Encode(schema,
            Util.Json("""{"id":1,"customer":"c","total":1,"status":"LOST","tags":[],"attrs":{},"created":0}""")));
        Assert.Contains("$.status", ex.Message);
        var missing = Assert.Throws<FormatException>(() => AvroCodec.Encode(schema, Util.Json("""{"id":1}""")));
        Assert.Contains("$.customer", missing.Message);
    }

    [Fact]
    public void Avro_references_resolve_named_types()
    {
        const string customer = """{"type":"record","name":"Customer","namespace":"shop","fields":[{"name":"name","type":"string"}]}""";
        const string order = """{"type":"record","name":"Wrapped","namespace":"shop","fields":[{"name":"who","type":"shop.Customer"}]}""";
        var schema = AvroCodec.Parse(order, [customer]);
        var bytes = AvroCodec.Encode(schema, Util.Json("""{"who":{"name":"Ada"}}"""));
        Assert.Equal("Ada", AvroCodec.Decode(schema, bytes).GetProperty("who").GetProperty("name").GetString());
    }

    [Fact]
    public void Protobuf_round_trips_scalars_enums_repeated_maps_and_nested_messages()
    {
        var schema = ProtobufSchema.Parse(OrderProto);
        var msg = schema.MessageAt([0]);
        var input = Util.Json("""
            {"id":10231,"customer":"cust-42","total":120.5,"status":"PAID","tags":["a","b"],"attrs":{"x":1,"y":2},
             "item":{"sku":"SKU-1"},"qty":[1,2,300],"delta":-5}
            """);
        var bytes = schema.Encode(msg, input);
        var j = schema.Decode(msg, bytes);
        Assert.Equal(10231, j.GetProperty("id").GetInt64());
        Assert.Equal("PAID", j.GetProperty("status").GetString());
        Assert.Equal(["a", "b"], j.GetProperty("tags").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal(2, j.GetProperty("attrs").GetProperty("y").GetInt32());
        Assert.Equal("SKU-1", j.GetProperty("item").GetProperty("sku").GetString());
        Assert.Equal([1, 2, 300], j.GetProperty("qty").EnumerateArray().Select(e => e.GetInt32()));
        Assert.Equal(-5, j.GetProperty("delta").GetInt32());
        Assert.Equal(120.5, j.GetProperty("total").GetDouble());
    }

    [Fact]
    public void Protobuf_rejects_unknown_fields_on_encode()
    {
        var schema = ProtobufSchema.Parse(OrderProto);
        var ex = Assert.Throws<FormatException>(() => schema.Encode(schema.MessageAt([0]), Util.Json("""{"nope":1}""")));
        Assert.Contains("nope", ex.Message);
    }

    [Fact]
    public void Protobuf_invalid_schema_is_reported()
    {
        Assert.Throws<FormatException>(() => ProtobufSchema.Parse("syntax = \"proto3\"; message { broken"));
    }

    [Theory]
    [InlineData(new[] { 0 }, new byte[] { 0 })]
    [InlineData(new[] { 1 }, new byte[] { 2, 2 })]
    [InlineData(new[] { 0, 1 }, new byte[] { 4, 0, 2 })]
    public void Protobuf_message_indexes_use_zigzag_varints(int[] indexes, byte[] wire)
    {
        Assert.Equal(wire, ProtobufIndexes.Write(indexes));
        Assert.Equal(indexes, ProtobufIndexes.Read(wire, out var used));
        Assert.Equal(wire.Length, used);
    }

    [Fact]
    public async Task Protobuf_decodes_through_the_registry_with_message_indexes()
    {
        var sr = new FakeSchemaRegistry();
        var e = sr.Register("other-value", "PROTOBUF", OrderProto);
        var schema = ProtobufSchema.Parse(OrderProto);
        var payload = schema.Encode(schema.MessageAt([1]), Util.Json("""{"name":"second"}"""));
        var d = await Decode(Codec(sr), FakeSchemaRegistry.Frame(e.Id, payload, ProtobufIndexes.Write([1])), "auto");
        Assert.Equal("protobuf", d.Format);
        Assert.Equal("second", d.Json!.Value.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Jsonschema_payload_is_json_after_the_header()
    {
        var sr = new FakeSchemaRegistry();
        var e = sr.Register("events-value", "JSON", """{"type":"object"}""");
        var d = await Decode(Codec(sr), FakeSchemaRegistry.Frame(e.Id, Encoding.UTF8.GetBytes("""{"a":1}""")), "jsonschema");
        Assert.Equal("jsonschema", d.Format);
        Assert.Equal(1, d.Json!.Value.GetProperty("a").GetInt32());
    }

    [Fact]
    public void Encode_plain_formats_and_validation()
    {
        Assert.Equal("hi"u8.ToArray(), MessageCodec.Encode("hi", "string", null, null, "value"));
        Assert.Equal(new byte[] { 0xde, 0xad }, MessageCodec.Encode("0xDE AD", "hex", null, null, "value"));
        Assert.Null(MessageCodec.Encode(null, "json", null, null, "value"));
        var bad = Assert.Throws<EngineException>(() => MessageCodec.Encode("{x", "json", null, null, "messages[0].value"));
        Assert.Equal(ErrorCodes.Validation, bad.Code);
        Assert.Contains("messages[0].value", bad.Message);
        Assert.Throws<EngineException>(() => MessageCodec.Encode("zz", "hex", null, null, "value"));
        Assert.Throws<EngineException>(() => MessageCodec.Encode("{}", "avro", null, null, "value"));
    }

    [Fact]
    public void Format_names_are_validated()
    {
        Assert.Equal("auto", KafkaFormats.Decoder(null, "valueFormat"));
        Assert.Equal("int64", KafkaFormats.Decoder("INT64", "valueFormat"));
        var ex = Assert.Throws<EngineException>(() => KafkaFormats.Decoder("xml", "valueFormat"));
        Assert.Contains("valueFormat", ex.Message);
        Assert.Throws<EngineException>(() => KafkaFormats.Encoder("int32", "keyFormat"));
    }
}
