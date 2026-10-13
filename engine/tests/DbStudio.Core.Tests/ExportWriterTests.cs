using System.Text;
using System.Text.Json;
using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests;

public class ExportWriterTests
{
    private static readonly ColumnInfo[] Columns =
    [
        new("id", 0, "int", ColumnKinds.Int, false),
        new("name", 1, "nvarchar", ColumnKinds.String, true),
        new("total", 2, "decimal", ColumnKinds.Decimal, true),
        new("data", 3, "varbinary", ColumnKinds.Binary, true),
        new("at", 4, "datetime2", ColumnKinds.DateTime, true),
    ];

    private static async Task<string> WriteAsync(string format, ExportOptions options, Dialect dialect, ColumnInfo[] columns, params object?[][] rows)
    {
        using var ms = new MemoryStream();
        await using (var w = ExportFormats.Create(format, ms, options, dialect))
        {
            await w.BeginAsync(columns, CancellationToken.None);
            foreach (var r in rows) await w.WriteRowAsync(ValueConverter.ToWireRow(r), CancellationToken.None);
            await w.EndAsync(CancellationToken.None);
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    [Fact]
    public async Task Csv_Rfc4180()
    {
        var csv = await WriteAsync(ExportFormats.Csv, new ExportOptions(), Dialect.TSql, Columns,
            [1, "plain", 1.50m, new byte[] { 0xAB, 0x01 }, new DateTime(2026, 1, 2, 3, 4, 5)],
            [2, "has,comma", null, null, null],
            [3, "has \"quote\"", -2m, null, null],
            [4, "multi\r\nline", 0m, null, null],
            [5, "", 0m, null, null]);

        Assert.Equal(
            "id,name,total,data,at\r\n" +
            "1,plain,1.50,0xAB01,2026-01-02T03:04:05\r\n" +
            "2,\"has,comma\",,,\r\n" +
            "3,\"has \"\"quote\"\"\",-2,,\r\n" +
            "4,\"multi\r\nline\",0,,\r\n" +
            "5,,0,,\r\n", csv);
        Assert.False(csv.StartsWith('﻿'));
    }

    [Fact]
    public async Task Csv_Options_DelimiterNullAsNoHeader()
    {
        var csv = await WriteAsync(ExportFormats.Csv, new ExportOptions(Delimiter: ";", Header: false, NullAs: "NULL"), Dialect.TSql,
            Columns[..2], [1, null], [2, "a;b"]);
        Assert.Equal("1;NULL\r\n2;\"a;b\"\r\n", csv);

        var tsv = await WriteAsync(ExportFormats.Csv, new ExportOptions(Delimiter: "\\t"), Dialect.TSql, Columns[..2], [1, "x"]);
        Assert.Equal("id\tname\r\n1\tx\r\n", tsv);
    }

    [Fact]
    public async Task Csv_WritesFullLongText()
    {
        var text = new string('q', 50_000);
        var csv = await WriteAsync(ExportFormats.Csv, new ExportOptions(Header: false), Dialect.TSql, Columns[..2], [1, text]);
        Assert.Equal($"1,{text}\r\n", csv);
    }

    [Fact]
    public async Task Json_ArrayOfObjects()
    {
        var json = await WriteAsync(ExportFormats.Json, new ExportOptions(), Dialect.TSql,
            [.. Columns, new ColumnInfo("id", 5, "int", ColumnKinds.Int, false)],
            [1, "a\"b", 12345678901234567890.12m, new byte[] { 1, 2 }, null, 7]);
        using var doc = JsonDocument.Parse(json);
        var row = Assert.Single(doc.RootElement.EnumerateArray().ToList());
        Assert.Equal(1, row.GetProperty("id").GetInt32());
        Assert.Equal("a\"b", row.GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Number, row.GetProperty("total").ValueKind);
        Assert.Equal("12345678901234567890.12", row.GetProperty("total").GetRawText());
        Assert.Equal("AQI=", row.GetProperty("data").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("at").ValueKind);
        Assert.Equal(7, row.GetProperty("id_2").GetInt32());
    }

    [Fact]
    public async Task SqlInsert_TSql()
    {
        var sql = await WriteAsync(ExportFormats.SqlInsert, new ExportOptions(TableName: "dbo.Target"), Dialect.TSql, Columns,
            [1, "O'Brien", 1.5m, new byte[] { 0xFF }, new DateTime(2026, 1, 2)]);
        Assert.Equal("INSERT INTO dbo.Target (id, name, total, data, at) VALUES (1, N'O''Brien', 1.5, 0xFF, '2026-01-02T00:00:00');\r\n", sql);
    }

    [Fact]
    public async Task SqlInsert_OracleAndSqlite()
    {
        ColumnInfo[] cols = [new("ID", 0, "NUMBER", ColumnKinds.Decimal, false), new("Mixed Name", 1, "VARCHAR2", ColumnKinds.String, true),
            new("D", 2, "DATE", ColumnKinds.DateTime, true), new("B", 3, "RAW", ColumnKinds.Binary, true)];
        var ora = await WriteAsync(ExportFormats.SqlInsert, new ExportOptions(TableName: "SHOP.T"), Dialect.PlSql, cols,
            [10m, "x", new DateTime(2026, 5, 6, 7, 8, 9), new byte[] { 0x0A }]);
        Assert.Equal("INSERT INTO SHOP.T (ID, \"Mixed Name\", D, B) VALUES (10, 'x', TIMESTAMP '2026-05-06 07:08:09', HEXTORAW('0A'));\r\n", ora);

        var lite = await WriteAsync(ExportFormats.SqlInsert, new ExportOptions(), Dialect.Sqlite,
            [new ColumnInfo("order", 0, "INTEGER", ColumnKinds.Int, false, Table: "items"), new ColumnInfo("b", 1, "BLOB", ColumnKinds.Binary, true, Table: "items")],
            [1L, new byte[] { 1, 2 }], [2L, null]);
        Assert.Equal("INSERT INTO items (\"order\", b) VALUES (1, X'0102');\r\nINSERT INTO items (\"order\", b) VALUES (2, NULL);\r\n", lite);
    }

    [Fact]
    public void UnknownFormat_IsValidationError()
    {
        var ex = Assert.Throws<EngineException>(() => ExportFormats.Create("xlsx", new MemoryStream(), new ExportOptions(), Dialect.TSql));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }
}
