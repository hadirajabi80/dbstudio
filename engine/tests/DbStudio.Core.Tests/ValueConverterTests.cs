using System.Numerics;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests;

public class ValueConverterTests
{
    private static string Json(object? v) => JsonSerializer.Serialize(ValueConverter.ToWire(v), CoreJson.Options);

    [Fact]
    public void Nulls()
    {
        Assert.Null(ValueConverter.ToWire(null));
        Assert.Null(ValueConverter.ToWire(DBNull.Value));
    }

    [Theory]
    [InlineData(true, "true")]
    [InlineData((byte)7, "7")]
    [InlineData((short)-3, "-3")]
    [InlineData(int.MaxValue, "2147483647")]
    [InlineData(9007199254740992L, "9007199254740992")]
    [InlineData(-9007199254740992L, "-9007199254740992")]
    [InlineData(9007199254740993L, "\"9007199254740993\"")]
    [InlineData(long.MinValue, "\"-9223372036854775808\"")]
    [InlineData(1.5d, "1.5")]
    [InlineData(double.NaN, "\"NaN\"")]
    [InlineData(double.PositiveInfinity, "\"Infinity\"")]
    [InlineData(double.NegativeInfinity, "\"-Infinity\"")]
    public void Scalars(object value, string expectedJson) => Assert.Equal(expectedJson, Json(value));

    [Fact]
    public void Float_UsesShortestRepresentation() => Assert.Equal("0.1", Json(0.1f));

    [Fact]
    public void UInt64_AboveSafeRange_IsString() => Assert.Equal("\"18446744073709551615\"", Json(ulong.MaxValue));

    [Fact]
    public void Decimal_IsStringWithScalePreserved()
    {
        Assert.Equal("\"120.50\"", Json(120.50m));
        Assert.Equal("\"-0.0001\"", Json(-0.0001m));
        Assert.Equal("\"79228162514264337593543950335\"", Json(decimal.MaxValue));
        Assert.Equal("\"123456789012345678901234567890\"", Json(BigInteger.Parse("123456789012345678901234567890")));
    }

    [Fact]
    public void Dates_AreIsoWithoutZone()
    {
        Assert.Equal("2026-10-14T10:00:00.1234567", ValueConverter.ToWire(new DateTime(2026, 10, 14, 10, 0, 0).AddTicks(1234567)));
        Assert.Equal("2026-01-01T00:00:00", ValueConverter.ToWire(new DateTime(2026, 1, 1)));
        Assert.Equal("2026-01-01T00:00:00.5", ValueConverter.ToWire(new DateTime(2026, 1, 1, 0, 0, 0, 500)));
        // Kind is ignored: no conversion to local/UTC.
        Assert.Equal("2026-03-01T08:15:00", ValueConverter.ToWire(new DateTime(2026, 3, 1, 8, 15, 0, DateTimeKind.Utc)));
        Assert.Equal("2026-10-14", ValueConverter.ToWire(new DateOnly(2026, 10, 14)));
        Assert.Equal("10:00:00.1234567", ValueConverter.ToWire(new TimeOnly(10, 0, 0).Add(TimeSpan.FromTicks(1234567))));
        Assert.Equal("10:00:00.1234567", ValueConverter.ToWire(new TimeSpan(10, 0, 0) + TimeSpan.FromTicks(1234567)));
        Assert.Equal("23:59:59", ValueConverter.ToWire(new TimeSpan(23, 59, 59)));
        Assert.Equal("1.02:00:00", ValueConverter.ToWire(new TimeSpan(1, 2, 0, 0)));
        Assert.Equal("-00:00:05", ValueConverter.ToWire(TimeSpan.FromSeconds(-5)));
        Assert.Equal("2026-10-14T10:00:00+02:00", ValueConverter.ToWire(new DateTimeOffset(2026, 10, 14, 10, 0, 0, TimeSpan.FromHours(2))));
    }

    [Fact]
    public void Guid_IsString()
    {
        var g = Guid.Parse("6f9619ff-8b86-d011-b42d-00c04fc964ff");
        Assert.Equal("6f9619ff-8b86-d011-b42d-00c04fc964ff", ValueConverter.ToWire(g));
    }

    [Fact]
    public void Binary_IsBase64PreviewWithLength()
    {
        Assert.Equal("{\"$bin\":\"AP8=\",\"len\":2}", Json(new byte[] { 0, 255 }));

        var big = Enumerable.Range(0, 20_000).Select(i => (byte)i).ToArray();
        var wire = Assert.IsType<BinaryValue>(ValueConverter.ToWire(big));
        Assert.Equal(20_000, wire.Len);
        Assert.Equal(Convert.ToBase64String(big, 0, ValueConverter.MaxBinaryPreviewBytes), wire.Bin);
        Assert.Same(big, wire.Full);
        Assert.DoesNotContain("Full", Json(big));
    }

    [Fact]
    public void LongStrings_AreTruncatedAt32K()
    {
        var exact = new string('x', ValueConverter.MaxStringChars);
        Assert.Same(exact, ValueConverter.ToWire(exact));

        var longer = new string('y', ValueConverter.MaxStringChars + 10);
        var t = Assert.IsType<TruncatedValue>(ValueConverter.ToWire(longer));
        Assert.Equal(ValueConverter.MaxStringChars + 10, t.Len);
        Assert.Equal(ValueConverter.MaxStringChars, t.Trunc.Length);
        Assert.Equal(longer, t.Full);
        var json = Json(longer);
        Assert.StartsWith("{\"$trunc\":\"yyy", json);
        Assert.EndsWith($"\",\"len\":{ValueConverter.MaxStringChars + 10}}}", json);
    }

    [Fact]
    public void Truncation_DoesNotSplitSurrogatePairs()
    {
        var s = new string('a', ValueConverter.MaxStringChars - 1) + "\U0001F600" + "tail";
        var t = Assert.IsType<TruncatedValue>(ValueConverter.ToWire(s));
        Assert.False(char.IsHighSurrogate(t.Trunc[^1]));
    }

    [Fact]
    public void Cursor_AndFallbacks()
    {
        Assert.Equal("{\"$cursor\":true}", JsonSerializer.Serialize(CursorValue.Instance, CoreJson.Options));
        Assert.Equal("c", ValueConverter.ToWire('c'));
        Assert.Equal("abc", ValueConverter.ToWire("abc".ToCharArray()));
        Assert.Equal("custom", ValueConverter.ToWire(new Custom()));
    }

    private sealed class Custom { public override string ToString() => "custom"; }

    [Fact]
    public void FullValue_ReturnsUntruncatedContent()
    {
        var longText = new string('z', 40_000);
        Assert.Equal(("string", longText, 40_000L), ValueConverter.FullValue(ValueConverter.ToWire(longText)));
        Assert.Equal(("binary", "AP8=", 2L), ValueConverter.FullValue(ValueConverter.ToWire(new byte[] { 0, 255 })));
        Assert.Equal(("string", (string?)null, 0L), ValueConverter.FullValue(null));
        Assert.Equal(("string", "1.5", 3L), ValueConverter.FullValue(1.5d));
        Assert.Equal(("string", "true", 4L), ValueConverter.FullValue(true));
    }

    [Theory]
    [InlineData(typeof(int), "int", null, ColumnKinds.Int)]
    [InlineData(typeof(long), "bigint", null, ColumnKinds.Int)]
    [InlineData(typeof(bool), "bit", null, ColumnKinds.Bool)]
    [InlineData(typeof(decimal), "decimal", null, ColumnKinds.Decimal)]
    [InlineData(typeof(decimal), "money", null, ColumnKinds.Decimal)]
    [InlineData(typeof(double), "float", null, ColumnKinds.Float)]
    [InlineData(typeof(string), "nvarchar(50)", null, ColumnKinds.String)]
    [InlineData(typeof(string), "xml", null, ColumnKinds.Xml)]
    [InlineData(typeof(string), "json", null, ColumnKinds.Json)]
    [InlineData(typeof(DateTime), "date", Dialect.TSql, ColumnKinds.Date)]
    [InlineData(typeof(DateTime), "datetime2", null, ColumnKinds.DateTime)]
    [InlineData(typeof(TimeSpan), "time", null, ColumnKinds.Time)]
    [InlineData(typeof(DateTimeOffset), "datetimeoffset", null, ColumnKinds.DateTimeOffset)]
    [InlineData(typeof(Guid), "uniqueidentifier", null, ColumnKinds.Guid)]
    [InlineData(typeof(byte[]), "varbinary", null, ColumnKinds.Binary)]
    [InlineData(typeof(byte[]), "timestamp", Dialect.TSql, ColumnKinds.Binary)] // rowversion
    [InlineData(typeof(object), "sql_variant", null, ColumnKinds.Other)]
    [InlineData(typeof(string), "hierarchyid", null, ColumnKinds.Other)]
    // Oracle
    [InlineData(typeof(decimal), "NUMBER", Dialect.PlSql, ColumnKinds.Decimal)]
    [InlineData(typeof(DateTime), "DATE", Dialect.PlSql, ColumnKinds.DateTime)]
    [InlineData(typeof(DateTime), "TIMESTAMP(6)", Dialect.PlSql, ColumnKinds.DateTime)]
    [InlineData(typeof(DateTimeOffset), "TIMESTAMP(6) WITH TIME ZONE", Dialect.PlSql, ColumnKinds.DateTimeOffset)]
    [InlineData(typeof(string), "VARCHAR2", Dialect.PlSql, ColumnKinds.String)]
    [InlineData(typeof(string), "CLOB", Dialect.PlSql, ColumnKinds.String)]
    [InlineData(typeof(object), "RefCursor", Dialect.PlSql, ColumnKinds.Cursor)]
    [InlineData(typeof(string), "INTERVAL DAY TO SECOND", Dialect.PlSql, ColumnKinds.String)]
    // SQLite: declared types and affinity
    [InlineData(typeof(long), "INTEGER", Dialect.Sqlite, ColumnKinds.Int)]
    [InlineData(typeof(double), "DECIMAL(12,2)", Dialect.Sqlite, ColumnKinds.Decimal)]
    [InlineData(typeof(long), "BOOLEAN", Dialect.Sqlite, ColumnKinds.Bool)]
    [InlineData(typeof(string), "DATETIME", Dialect.Sqlite, ColumnKinds.DateTime)]
    [InlineData(typeof(string), "VARYING CHARACTER(255)", Dialect.Sqlite, ColumnKinds.String)]
    [InlineData(typeof(long), "UNSIGNED BIG INT", Dialect.Sqlite, ColumnKinds.Int)]
    [InlineData(typeof(string), "", Dialect.Sqlite, ColumnKinds.String)]
    [InlineData(typeof(double), "MYREALTYPE", Dialect.Sqlite, ColumnKinds.Float)]
    public void KindFor(Type clr, string dbType, Dialect? dialect, string expected) =>
        Assert.Equal(expected, ValueConverter.KindFor(clr, dbType, dialect));

    [Fact]
    public void KindFor_UnknownEverything_IsOther() => Assert.Equal(ColumnKinds.Other, ValueConverter.KindFor(null, null));

    [Theory]
    [InlineData("NVARCHAR(50)", "nvarchar")]
    [InlineData("  timestamp(6)  with  time zone ", "timestamp with time zone")]
    [InlineData("decimal(18, 2)", "decimal")]
    [InlineData(null, "")]
    public void NormalizeTypeName(string? input, string expected) => Assert.Equal(expected, ValueConverter.NormalizeTypeName(input));
}
