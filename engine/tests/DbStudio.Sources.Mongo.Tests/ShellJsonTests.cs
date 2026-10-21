using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class ShellJsonTests
{
    private static BsonDocument P(string text) => ShellJson.ParseDocument(text, "filter");
    private static BsonValue V(string text) => ShellJson.Parse(text, "value");

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("// only a comment\n")]
    [InlineData("/* block */")]
    public void Empty_text_is_an_empty_document(string text) => Assert.Equal(new BsonDocument(), P(text));

    [Fact]
    public void Plain_json() =>
        Assert.Equal(new BsonDocument { { "a", 1 }, { "b", "x" }, { "c", true }, { "d", BsonNull.Value }, { "e", new BsonArray { 1, 2 } } },
            P("""{"a": 1, "b": "x", "c": true, "d": null, "e": [1, 2]}"""));

    [Fact]
    public void Unquoted_keys_with_dots_and_dollars() =>
        Assert.Equal(new BsonDocument { { "address.city", "Paris" }, { "total", new BsonDocument("$gt", 100) } },
            P("{ address.city: 'Paris', total: { $gt: 100 } }"));

    [Fact]
    public void Trailing_commas_and_comments()
    {
        var d = P("""
            {
              status: "paid", // inline
              /* block */ tags: ["a", "b",],
            }
            """);
        Assert.Equal("paid", d["status"].AsString);
        Assert.Equal(2, d["tags"].AsBsonArray.Count);
    }

    [Fact]
    public void Single_quotes_and_js_escapes()
    {
        var d = P(@"{ a: 'it\'s', b: ""tab\there"", c: 'é\x41', d: 'line\nbreak', e: '\u{1F600}' }");
        Assert.Equal("it's", d["a"].AsString);
        Assert.Equal("tab\there", d["b"].AsString);
        Assert.Equal("éA", d["c"].AsString);
        Assert.Equal("line\nbreak", d["d"].AsString);
        Assert.Equal("😀", d["e"].AsString);
    }

    [Fact]
    public void Integers_widen_to_long_and_decimals_are_doubles()
    {
        Assert.Equal(BsonType.Int32, V("2147483647").BsonType);
        Assert.Equal(BsonType.Int64, V("2147483648").BsonType);
        Assert.Equal(BsonType.Int32, V("-2147483648").BsonType);
        Assert.Equal(-2147483648, V("-2147483648").AsInt32);
        Assert.Equal(BsonType.Double, V("1.5").BsonType);
        Assert.Equal(1e3, V("1e3").AsDouble);
        Assert.Equal(-0.25, V("-.25").AsDouble);
        Assert.Equal(255, V("0xFF").AsInt32);
    }

    [Fact]
    public void Special_numbers_and_literals()
    {
        Assert.True(double.IsNaN(V("NaN").AsDouble));
        Assert.Equal(double.PositiveInfinity, V("Infinity").AsDouble);
        Assert.Equal(double.NegativeInfinity, V("-Infinity").AsDouble);
        Assert.Equal(BsonUndefined.Value, V("undefined"));
        Assert.Equal(BsonNull.Value, V("null"));
        Assert.Equal(BsonBoolean.False, V("false"));
    }

    [Fact]
    public void Regex_literals_keep_sorted_flags()
    {
        var d = P(@"{ name: /^Al\/ice[/]x/mi }");
        var re = d["name"].AsBsonRegularExpression;
        Assert.Equal(@"^Al\/ice[/]x", re.Pattern);
        Assert.Equal("im", re.Options);
    }

    [Fact]
    public void Regex_with_invalid_flag_is_an_error() => Assert.Throws<ShellJsonException>(() => P("{ a: /x/g }"));

    [Fact]
    public void ObjectId_helper_with_and_without_new()
    {
        Assert.Equal(new ObjectId("66f1a2b3c4d5e6f708192a3b"), V("ObjectId(\"66f1a2b3c4d5e6f708192a3b\")").AsObjectId);
        Assert.Equal(new ObjectId("66f1a2b3c4d5e6f708192a3b"), V("new ObjectId('66f1a2b3c4d5e6f708192a3b')").AsObjectId);
        Assert.Equal(BsonType.ObjectId, V("ObjectId()").BsonType);
    }

    [Fact]
    public void Bad_ObjectId_is_positioned()
    {
        var ex = Assert.Throws<ShellJsonException>(() => P("{\n  _id: ObjectId(\"nothex\") }"));
        Assert.Equal(2, ex.Line);
        Assert.Equal(8, ex.Col);
        Assert.Equal("filter", ex.Field);
        Assert.Contains("24 hexadecimal", ex.Message);
    }

    [Fact]
    public void Dates_from_ISODate_Date_and_Date_now()
    {
        Assert.Equal(1_704_067_200_000, V("ISODate(\"2024-01-01T00:00:00Z\")").AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(1_704_067_200_000, V("ISODate('2024-01-01')").AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(1_704_060_000_000, V("new Date('2024-01-01T00:00:00+02:00')").AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(1_704_067_200_123, V("ISODate('2024-01-01T00:00:00.123Z')").AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(86_400_000, V("Date(86400000)").AsBsonDateTime.MillisecondsSinceEpoch);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.InRange(V("Date.now()").AsBsonDateTime.MillisecondsSinceEpoch, now - 5000, now + 5000);
        Assert.InRange(V("ISODate()").AsBsonDateTime.MillisecondsSinceEpoch, now - 5000, now + 5000);
    }

    [Fact]
    public void Number_helpers()
    {
        Assert.Equal(new BsonInt64(9007199254740993), V("NumberLong(\"9007199254740993\")"));
        Assert.Equal(new BsonInt64(42), V("NumberLong(42)"));
        Assert.Equal(new BsonInt64(7), V("Long(7)"));
        Assert.Equal(new BsonInt32(5), V("NumberInt(\"5\")"));
        Assert.Equal(new BsonInt32(6), V("Int32(6)"));
        Assert.Equal(Decimal128.Parse("19.99"), V("NumberDecimal(\"19.99\")").AsDecimal128);
        Assert.Equal(Decimal128.Parse("0.1"), V("Decimal128('0.1')").AsDecimal128);
        Assert.Equal(new BsonDouble(3), V("Double(3)"));
    }

    [Fact]
    public void Binary_helpers()
    {
        var b = V("BinData(0, \"AQID\")").AsBsonBinaryData;
        Assert.Equal(new byte[] { 1, 2, 3 }, b.Bytes);
        Assert.Equal(BsonBinarySubType.Binary, b.SubType);
        Assert.Equal(new byte[] { 0xde, 0xad }, V("HexData(128, 'dead')").AsBsonBinaryData.Bytes);
        var u = V("UUID('123e4567-e89b-12d3-a456-426614174000')").AsBsonBinaryData;
        Assert.Equal(BsonBinarySubType.UuidStandard, u.SubType);
        Assert.Equal(Guid.Parse("123e4567-e89b-12d3-a456-426614174000"), u.ToGuid(GuidRepresentation.Standard));
        Assert.Equal(BsonBinarySubType.UuidStandard, V("UUID()").AsBsonBinaryData.SubType);
        Assert.Equal(BsonBinarySubType.MD5, V("MD5('0123456789abcdef0123456789abcdef')").AsBsonBinaryData.SubType);
    }

    [Fact]
    public void Timestamp_MinKey_MaxKey_RegExp_Code_DBRef()
    {
        Assert.Equal(new BsonTimestamp(1700000000, 3), V("Timestamp(1700000000, 3)"));
        Assert.Equal(new BsonTimestamp(5, 6), V("Timestamp({ t: 5, i: 6 })"));
        Assert.Equal(BsonMinKey.Value, V("MinKey"));
        Assert.Equal(BsonMaxKey.Value, V("MaxKey()"));
        Assert.Equal(new BsonRegularExpression("^a", "i"), V("RegExp('^a', 'i')"));
        Assert.Equal(new BsonJavaScript("function () { return 1; }"), V("Code('function () { return 1; }')"));
        var r = V("DBRef('customers', 5)").AsBsonDocument;
        Assert.Equal("customers", r["$ref"].AsString);
        Assert.Equal(5, r["$id"].AsInt32);
    }

    [Fact]
    public void Canonical_extended_json_wrappers()
    {
        var d = P("""
            { "oid": {"$oid": "66f1a2b3c4d5e6f708192a3b"}, "d": {"$date": {"$numberLong": "1704067200000"}},
              "l": {"$numberLong": "12"}, "i": {"$numberInt": "3"}, "dbl": {"$numberDouble": "-Infinity"},
              "dec": {"$numberDecimal": "1.10"}, "bin": {"$binary": {"base64": "AQID", "subType": "80"}},
              "re": {"$regularExpression": {"pattern": "a+", "options": "si"}}, "ts": {"$timestamp": {"t": 7, "i": 8}},
              "min": {"$minKey": 1}, "max": {"$maxKey": 1}, "u": {"$undefined": true}, "sym": {"$symbol": "s"}, "code": {"$code": "x()"} }
            """);
        Assert.Equal(BsonType.ObjectId, d["oid"].BsonType);
        Assert.Equal(1_704_067_200_000, d["d"].AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(new BsonInt64(12), d["l"]);
        Assert.Equal(new BsonInt32(3), d["i"]);
        Assert.Equal(double.NegativeInfinity, d["dbl"].AsDouble);
        Assert.Equal(Decimal128.Parse("1.10"), d["dec"].AsDecimal128);
        Assert.Equal((BsonBinarySubType)0x80, d["bin"].AsBsonBinaryData.SubType);
        Assert.Equal(new BsonRegularExpression("a+", "is"), d["re"]);
        Assert.Equal(new BsonTimestamp(7, 8), d["ts"]);
        Assert.Equal(BsonMinKey.Value, d["min"]);
        Assert.Equal(BsonMaxKey.Value, d["max"]);
        Assert.Equal(BsonUndefined.Value, d["u"]);
        Assert.Equal(BsonType.Symbol, d["sym"].BsonType);
        Assert.Equal(BsonType.JavaScript, d["code"].BsonType);
    }

    [Fact]
    public void Relaxed_and_legacy_wrappers()
    {
        var d = P("""{ "d": {"$date": "2024-01-01T00:00:00Z"}, "n": {"$date": 1000}, "b": {"$binary": "AQID", "$type": "00"}, "u": {"$uuid": "123e4567-e89b-12d3-a456-426614174000"} }""");
        Assert.Equal(1_704_067_200_000, d["d"].AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(1000, d["n"].AsBsonDateTime.MillisecondsSinceEpoch);
        Assert.Equal(new byte[] { 1, 2, 3 }, d["b"].AsBsonBinaryData.Bytes);
        Assert.Equal(BsonBinarySubType.UuidStandard, d["u"].AsBsonBinaryData.SubType);
    }

    [Fact]
    public void Query_operator_regex_documents_are_kept() =>
        Assert.Equal(new BsonDocument("$regex", "^a").Add("$options", "i"), P("{ name: { $regex: '^a', $options: 'i' } }")["name"]);

    [Fact]
    public void Invalid_wrapper_values_are_errors() => Assert.Throws<ShellJsonException>(() => P("""{ a: { "$numberLong": "abc" } }"""));

    [Fact]
    public void Non_document_top_level_is_an_error_for_documents()
    {
        var ex = Assert.Throws<ShellJsonException>(() => P("[1, 2]"));
        Assert.Contains("Expected a document", ex.Message);
        Assert.Equal(new BsonArray { 1, 2 }, V("[1, 2]"));
    }

    [Theory]
    [InlineData("{ a: 1 ", "Unterminated document")]
    [InlineData("{ a: 'x }", "Unterminated string")]
    [InlineData("{ a 1 }", "Expected ':'")]
    [InlineData("{ a: 1 } x", "Unexpected text")]
    [InlineData("{ a: foo }", "Unknown identifier 'foo'")]
    [InlineData("{ a: Foo(1) }", "Unknown helper")]
    [InlineData("{ a: 1, a: 2 }", "Duplicate field name 'a'")]
    [InlineData("{ a: [1, 2 }", "Expected ',' or ']'")]
    [InlineData("{ a: /* x }", "Unterminated /* comment")]
    [InlineData("{ a: NumberInt(1, 2) }", "takes 1 argument")]
    public void Syntax_errors_name_the_problem(string text, string expected)
    {
        var ex = Assert.Throws<ShellJsonException>(() => P(text));
        Assert.Contains(expected, ex.Message);
        Assert.InRange(ex.Offset, 0, text.Length);
    }

    [Fact]
    public void Error_positions_count_lines_and_columns()
    {
        var ex = Assert.Throws<ShellJsonException>(() => P("{\n  a: 1,\n  b: @\n}"));
        Assert.Equal(3, ex.Line);
        Assert.Equal(6, ex.Col);
        Assert.Equal(15, ex.Offset);
    }

    [Fact]
    public void Nested_shell_document_round_trips_through_canonical_ejson()
    {
        var d = P("{ _id: ObjectId('66f1a2b3c4d5e6f708192a3b'), at: ISODate('2024-01-01'), n: NumberLong(1), items: [{ sku: 'a', qty: 2 }] }");
        var again = ShellJson.ParseDocument(Ejson.Canonical(d), "doc");
        Assert.Equal(d, again);
    }

    [Fact]
    public void ParseMany_reads_arrays_and_concatenated_documents()
    {
        Assert.Equal(3, ShellJson.ParseMany("[{a:1},{a:2},{a:3}]", "upload").Count());
        Assert.Equal(2, ShellJson.ParseMany("{a:1}\n{a:2}\n", "upload").Count());
        Assert.Equal(2, ShellJson.ParseMany("{a:1}, {a:2}", "upload").Count());
        Assert.Empty(ShellJson.ParseMany("  ", "upload"));
    }

    [Fact]
    public void TryParseIsoDate_accepts_common_forms()
    {
        Assert.True(ShellJson.TryParseIsoDate("2024-01-01T10:20:30+0100", out var a));
        Assert.Equal(DateTimeOffset.Parse("2024-01-01T09:20:30Z").ToUnixTimeMilliseconds(), a);
        Assert.True(ShellJson.TryParseIsoDate("2024-01-01 10:20", out _));
        Assert.False(ShellJson.TryParseIsoDate("yesterday", out _));
    }
}

public sealed class EjsonTests
{
    [Theory]
    [InlineData("ObjectId('66f1a2b3c4d5e6f708192a3b')", "{ \"$oid\" : \"66f1a2b3c4d5e6f708192a3b\" }")]
    [InlineData("NumberLong(5)", "{ \"$numberLong\" : \"5\" }")]
    [InlineData("NumberInt(5)", "{ \"$numberInt\" : \"5\" }")]
    [InlineData("1.5", "{ \"$numberDouble\" : \"1.5\" }")]
    [InlineData("NumberDecimal('1.10')", "{ \"$numberDecimal\" : \"1.10\" }")]
    [InlineData("ISODate('2024-01-01T00:00:00Z')", "{ \"$date\" : { \"$numberLong\" : \"1704067200000\" } }")]
    public void Values_are_canonical_ejson(string shell, string expected) => Assert.Equal(expected, Ejson.Canonical(ShellJson.Parse(shell, "v")));

    [Theory]
    [InlineData("{ a: ObjectId('66f1a2b3c4d5e6f708192a3b') }")]
    [InlineData("{ a: ISODate('2024-01-01T00:00:00.123Z') }")]
    [InlineData("{ a: NumberDecimal('12345678901234567890.123') }")]
    [InlineData("{ a: BinData(4, 'EjRWeBI0VngSNFZ4EjRWeA==') }")]
    [InlineData("{ a: NumberLong('9223372036854775807') }")]
    [InlineData("{ a: NumberInt(-1) }")]
    [InlineData("{ a: 0.1 }")]
    [InlineData("{ a: UUID('123e4567-e89b-12d3-a456-426614174000') }")]
    [InlineData("{ a: /x+/i }")]
    [InlineData("{ a: Timestamp(1, 2) }")]
    [InlineData("{ a: [[1, { b: [NumberLong(2)] }], []] }")]
    public void Canonical_round_trips_preserve_types(string shell)
    {
        var doc = ShellJson.ParseDocument(shell, "doc");
        var text = Ejson.Canonical(doc);
        Assert.Equal(doc, BsonDocument.Parse(text));
        Assert.Equal(doc, ShellJson.ParseDocument(text, "doc"));
    }

    [Fact]
    public void Long_strings_and_binaries_are_truncated_anywhere()
    {
        var big = new string('x', Ejson.MaxString + 1);
        var bytes = Enumerable.Range(0, Ejson.MaxBinary + 10).Select(i => (byte)i).ToArray();
        var doc = new BsonDocument
        {
            { "_id", 1 }, { "s", big }, { "small", "ok" },
            { "nested", new BsonDocument("arr", new BsonArray { big, new BsonBinaryData(bytes, BsonBinarySubType.UserDefined) }) },
        };
        var t = BsonDocument.Parse(Ejson.Canonical(doc, truncate: true));
        Assert.Equal(1000, t["s"]["$trunc"].AsString.Length);
        Assert.Equal(big.Length, t["s"]["len"].AsInt32);
        Assert.Equal("ok", t["small"].AsString);
        var bin = t["nested"]["arr"][1].AsBsonDocument;
        Assert.True(bin["binary"].AsBoolean);
        Assert.Equal("80", bin["subType"].AsString);
        Assert.Equal(bytes.Length, bin["len"].AsInt32);
        Assert.Equal(Convert.ToBase64String(bytes, 0, 256), bin["$trunc"].AsString);
        Assert.Equal(big, doc["s"].AsString); // the original is untouched
    }

    [Fact]
    public void Truncate_returns_the_same_instance_when_nothing_is_long()
    {
        var doc = new BsonDocument { { "a", "short" }, { "b", new BsonArray { 1 } } };
        Assert.Same(doc, Ejson.Truncate(doc));
    }

    [Fact]
    public void Relaxed_json_nodes_for_examples()
    {
        Assert.Equal(5, Ejson.ToJsonNode(new BsonInt64(5))!.GetValue<long>());
        Assert.Equal("2024-01-01T00:00:00Z", Ejson.ToJsonNode(new BsonDateTime(1_704_067_200_000))!["$date"]!.GetValue<string>());
        Assert.Null(Ejson.ToJsonNode(BsonNull.Value));
        Assert.Equal("""{"a":1}""", Ejson.Compact(new BsonDocument("a", 1)));
    }
}
