using System.IO.Compression;
using System.Xml.Linq;
using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests;

/// <summary>The .xlsx writer: unzipped and checked part by part (package structure, typed cells, escaping, limits).</summary>
public class XlsxWriterTests
{
    private static readonly XNamespace S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    private static readonly ColumnInfo[] Columns =
    [
        new("id", 0, "int", ColumnKinds.Int, false, Table: "Orders"),
        new("name", 1, "nvarchar", ColumnKinds.String, true),
        new("total", 2, "decimal", ColumnKinds.Decimal, true),
        new("paid", 3, "bit", ColumnKinds.Bool, true),
        new("on", 4, "date", ColumnKinds.Date, true),
        new("at", 5, "datetime2", ColumnKinds.DateTime, true),
        new("t", 6, "time", ColumnKinds.Time, true),
        new("data", 7, "varbinary", ColumnKinds.Binary, true),
        new("ratio", 8, "float", ColumnKinds.Float, true),
    ];

    private static async Task<byte[]> WriteAsync(Stream target, ColumnInfo[] columns, IEnumerable<object?[]> rows, int? maxRows = null, ExportOptions? options = null)
    {
        await using (var w = maxRows is int m ? new XlsxResultWriter(target, options ?? new ExportOptions(), m) : ExportFormats.Create(ExportFormats.Xlsx, target, options ?? new ExportOptions(), Dialect.TSql))
        {
            await w.BeginAsync(columns, CancellationToken.None);
            foreach (var r in rows) await w.WriteRowAsync(ValueConverter.ToWireRow(r), CancellationToken.None);
            await w.EndAsync(CancellationToken.None);
        }
        return target is MemoryStream ms ? ms.ToArray() : [];
    }

    private static Dictionary<string, XDocument> Unzip(byte[] bytes)
    {
        using var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read);
        return zip.Entries.ToDictionary(e => e.FullName, e =>
        {
            using var s = e.Open();
            return XDocument.Load(s); // throws on malformed XML
        });
    }

    private static XElement CellAt(XDocument sheet, string r) => sheet.Descendants(S + "c").Single(c => (string?)c.Attribute("r") == r);

    private static string? Text(XElement c) => (string?)c.Element(S + "is")?.Element(S + "t") ?? (string?)c.Element(S + "v");

    [Fact]
    public async Task Package_HasTheRequiredParts_AndValidXml()
    {
        var parts = Unzip(await WriteAsync(new MemoryStream(), Columns, [[1, "a", 1m, true, null, null, null, null, 0.5]]));
        foreach (var p in new[] { "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "docProps/core.xml", "docProps/app.xml" })
            Assert.True(parts.ContainsKey(p), p);
        var types = parts["[Content_Types].xml"].Root!;
        Assert.Contains(types.Elements(), e => (string?)e.Attribute("PartName") == "/xl/worksheets/sheet1.xml");
        var sheetName = (string?)parts["xl/workbook.xml"].Descendants(S + "sheet").Single().Attribute("name");
        Assert.Equal("Orders", sheetName);
        Assert.Equal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ExportFormats.ContentType(ExportFormats.Xlsx));
        Assert.Equal(".xlsx", ExportFormats.Extension(ExportFormats.Xlsx));
        Assert.True(ExportFormats.IsKnown("xlsx"));
    }

    [Fact]
    public async Task Cells_AreTyped()
    {
        var sheet = Unzip(await WriteAsync(new MemoryStream(), Columns,
        [
            [42, "Ali", 12.50m, true, new DateOnly(2026, 10, 14), new DateTime(2026, 10, 14, 12, 0, 0), new TimeOnly(6, 0), new byte[] { 0xAB, 0x01 }, 0.25],
            [43, null, 12345678901234567890.12m, false, new DateOnly(1899, 1, 1), null, null, null, double.NaN],
        ]))["xl/worksheets/sheet1.xml"];

        Assert.Null((string?)CellAt(sheet, "A2").Attribute("t")); // number
        Assert.Equal("42", Text(CellAt(sheet, "A2")));
        Assert.Equal("inlineStr", (string?)CellAt(sheet, "B2").Attribute("t"));
        Assert.Equal("Ali", Text(CellAt(sheet, "B2")));
        Assert.Equal("12.50", Text(CellAt(sheet, "C2")));
        Assert.Null((string?)CellAt(sheet, "C2").Attribute("t"));
        Assert.Equal(("b", "1"), ((string?)CellAt(sheet, "D2").Attribute("t"), Text(CellAt(sheet, "D2"))));
        Assert.Equal("46309", Text(CellAt(sheet, "E2"))); // 2026-10-14
        Assert.Equal("2", (string?)CellAt(sheet, "E2").Attribute("s"));
        Assert.Equal("46309.5", Text(CellAt(sheet, "F2")));
        Assert.Equal("3", (string?)CellAt(sheet, "F2").Attribute("s"));
        Assert.Equal("0.25", Text(CellAt(sheet, "G2")));
        Assert.Equal("4", (string?)CellAt(sheet, "G2").Attribute("s"));
        Assert.Equal("0xAB01", Text(CellAt(sheet, "H2")));
        Assert.Equal("0.25", Text(CellAt(sheet, "I2")));

        Assert.DoesNotContain(sheet.Descendants(S + "c"), c => (string?)c.Attribute("r") == "B3"); // NULL → no cell
        Assert.Equal("inlineStr", (string?)CellAt(sheet, "C3").Attribute("t")); // 22 digits: kept as text, not rounded
        Assert.Equal("12345678901234567890.12", Text(CellAt(sheet, "C3")));
        Assert.Equal("1899-01-01", Text(CellAt(sheet, "E3"))); // before Excel's epoch: text
        Assert.Equal("NaN", Text(CellAt(sheet, "I3")));
    }

    [Fact]
    public async Task Header_IsBoldAndFrozen_WithWidthsAndFilter()
    {
        var parts = Unzip(await WriteAsync(new MemoryStream(), Columns, [[1, new string('x', 30), 1m, true, null, null, null, null, 1.0]]));
        var sheet = parts["xl/worksheets/sheet1.xml"];
        Assert.All(sheet.Descendants(S + "row").First().Elements(S + "c"), c => Assert.Equal("1", (string?)c.Attribute("s")));
        Assert.Equal("id", Text(CellAt(sheet, "A1")));
        var pane = sheet.Descendants(S + "pane").Single();
        Assert.Equal(("frozen", "1", "A2"), ((string?)pane.Attribute("state"), (string?)pane.Attribute("ySplit"), (string?)pane.Attribute("topLeftCell")));
        var widths = sheet.Descendants(S + "col").Select(c => double.Parse((string)c.Attribute("width")!, System.Globalization.CultureInfo.InvariantCulture)).ToList();
        Assert.Equal(Columns.Length, widths.Count);
        Assert.True(widths[1] > 30, "name column fits its value");
        Assert.True(widths[0] >= 8 && widths[0] < 12);
        Assert.Equal("A1:I2", (string?)sheet.Descendants(S + "autoFilter").Single().Attribute("ref"));
        // sheetViews/cols must come before sheetData (schema order), autoFilter after it
        var order = sheet.Root!.Elements().Select(e => e.Name.LocalName).ToList();
        Assert.True(order.IndexOf("sheetViews") < order.IndexOf("cols") && order.IndexOf("cols") < order.IndexOf("sheetData") && order.IndexOf("sheetData") < order.IndexOf("autoFilter"));
        var bold = parts["xl/styles.xml"].Descendants(S + "font").ElementAt(1);
        Assert.NotNull(bold.Element(S + "b"));
        Assert.Equal("'Orders'!$A$1:$I$2", (string?)parts["xl/workbook.xml"].Descendants(S + "definedName").Single());
    }

    [Fact]
    public async Task Text_IsEscaped_ControlCharsStripped_UnicodeAndRtlKept()
    {
        var cols = new ColumnInfo[] { new("نام <&>", 0, "nvarchar", ColumnKinds.String, true) };
        var sheet = Unzip(await WriteAsync(new MemoryStream(), cols,
        [
            ["a<b>&\"c\"'"],
            ["bell\u0007 nul\u0000 esc\u001b tab\tline\nend"],
            ["سلام دنیا ✓ 😀"],
            ["  padded  "],
            ["lone \ud800 surrogate"],
            [new string('z', 40_000)],
        ]))["xl/worksheets/sheet1.xml"];
        Assert.Equal("نام <&>", Text(CellAt(sheet, "A1")));
        Assert.Equal("a<b>&\"c\"'", Text(CellAt(sheet, "A2")));
        Assert.Equal("bell nul esc tab\tline\nend", Text(CellAt(sheet, "A3")));
        Assert.Equal("preserve", (string?)CellAt(sheet, "A3").Descendants(S + "t").Single().Attribute(XNamespace.Xml + "space"));
        Assert.Equal("سلام دنیا ✓ 😀", Text(CellAt(sheet, "A4")));
        Assert.Equal("  padded  ", Text(CellAt(sheet, "A5")));
        Assert.Equal("lone  surrogate", Text(CellAt(sheet, "A6")));
        Assert.Equal(XlsxResultWriter.MaxCellChars, Text(CellAt(sheet, "A7"))!.Length);
    }

    [Fact]
    public async Task RowLimit_DropsTheRest_AndLeavesANote()
    {
        var cols = new ColumnInfo[] { new("n", 0, "int", ColumnKinds.Int, false) };
        var rows = Enumerable.Range(1, 400).Select(i => new object?[] { i });
        var sheet = Unzip(await WriteAsync(new MemoryStream(), cols, rows, maxRows: 10))["xl/worksheets/sheet1.xml"];
        var rowEls = sheet.Descendants(S + "row").ToList();
        Assert.Equal(10, rowEls.Count); // header + 8 data rows + the note
        Assert.Equal("8", Text(CellAt(sheet, "A9")));
        Assert.StartsWith("Excel row limit reached: 392 more row(s)", Text(CellAt(sheet, "A10")));
    }

    [Fact]
    public async Task NonSeekableTarget_GetsAValidPackage()
    {
        var inner = new MemoryStream();
        await WriteAsync(new ForwardOnlyStream(inner), Columns, Enumerable.Range(0, 300).Select(i => new object?[] { i, $"r{i}", null, null, null, null, null, null, null }));
        var sheet = Unzip(inner.ToArray())["xl/worksheets/sheet1.xml"];
        Assert.Equal(301, sheet.Descendants(S + "row").Count());
        Assert.Equal("r299", Text(CellAt(sheet, "B301")));
    }

    [Fact]
    public async Task NoRows_StillOpens()
    {
        var parts = Unzip(await WriteAsync(new MemoryStream(), Columns, []));
        Assert.Single(parts["xl/worksheets/sheet1.xml"].Descendants(S + "row"));
    }

    [Theory]
    [InlineData(0, "A")]
    [InlineData(25, "Z")]
    [InlineData(26, "AA")]
    [InlineData(701, "ZZ")]
    [InlineData(702, "AAA")]
    [InlineData(16383, "XFD")]
    public void ColumnNames(int index, string expected) => Assert.Equal(expected, XlsxResultWriter.ColumnName(index));

    [Theory]
    [InlineData("1900-01-01", 1)]
    [InlineData("1900-02-28", 59)]
    [InlineData("1900-03-01", 61)]
    [InlineData("2026-10-14T18:00:00", 46309.75)]
    public void DateSerials(string value, double expected)
    {
        Assert.True(XlsxResultWriter.TryDateSerial(value, out var serial));
        Assert.Equal(expected, serial, 9);
    }

    [Theory]
    [InlineData("12.50", true)]
    [InlineData("-0.001", true)]
    [InlineData("123456789012345", true)]
    [InlineData("1234567890123456", false)]
    [InlineData("1e400", false)]
    [InlineData("12a", false)]
    [InlineData("007", false)]
    public void ExactNumbers(string s, bool expected) => Assert.Equal(expected, XlsxResultWriter.ExactNumber(s));

    [Theory]
    [InlineData("dbo.Orders", "dbo.Orders")]
    [InlineData("a/b\\c?d*e[f]g:h", "abcdefgh")]
    [InlineData("", "Result")]
    [InlineData(null, "Result")]
    [InlineData("History", "Result")]
    [InlineData("'quoted'", "quoted")]
    public void SheetNames(string? name, string expected) => Assert.Equal(expected, XlsxResultWriter.SheetName(name));

    [Fact]
    public void SheetName_IsCappedAt31() => Assert.Equal(31, XlsxResultWriter.SheetName(new string('n', 50)).Length);

    private sealed class ForwardOnlyStream(Stream inner) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        // synchronous writes are refused, like an ASP.NET Core response body
        public override void Write(byte[] buffer, int offset, int count) => throw new InvalidOperationException("Synchronous writes are not allowed.");
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => inner.WriteAsync(buffer, cancellationToken);
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => inner.WriteAsync(buffer, offset, count, cancellationToken);
    }
}
