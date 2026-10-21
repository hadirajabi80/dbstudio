using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Export;

/// <summary>
/// Excel workbook (Office Open XML, .xlsx) with one sheet, written with <see cref="ZipArchive"/> + <see cref="XmlWriter"/>
/// (no dependency): typed cells (numbers, booleans, dates as serials with a date format, text as inline strings), a bold
/// frozen header row with an auto filter, and column widths measured on the first rows. Rows beyond Excel's
/// 1,048,576-row limit are dropped and counted in a note on the last row. ui/src/components/Grid/xlsx.ts writes the
/// same parts for client-side exports.
/// </summary>
public sealed partial class XlsxResultWriter : IResultWriter
{
    /// <summary>Excel's row limit (header included).</summary>
    public const int MaxRows = 1_048_576;
    public const int MaxColumns = 16_384;
    /// <summary>Excel's limit for the text of one cell.</summary>
    public const int MaxCellChars = 32_767;
    /// <summary>Rows buffered before the sheet data starts, to size the columns.</summary>
    private const int SampleRows = 200;

    private const int StyleHeader = 1, StyleDate = 2, StyleDateTime = 3, StyleTime = 4;

    private readonly Stream _target;
    private readonly Stream _zipStream;
    private readonly bool _ownsZipStream;
    private readonly ZipArchive _zip;
    private readonly ExportOptions _options;
    private ColumnInfo[] _columns = [];
    private Stream? _sheetEntry;
    private XmlWriter? _xml;
    private readonly List<object?[]> _sample = [];
    private bool _sheetStarted;
    private long _rowIndex = 1; // the header is row 1
    private long _dropped;
    private bool _ended;

    private static readonly XmlWriterSettings XmlSettings = new()
    {
        Encoding = new UTF8Encoding(false),
        CheckCharacters = false, // text is sanitized by Clean (control characters are stripped)
        CloseOutput = false,
    };

    private const string NsMain = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private const string NsRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private const string NsPkgRel = "http://schemas.openxmlformats.org/package/2006/relationships";

    private readonly int _maxRows;

    public XlsxResultWriter(Stream stream, ExportOptions options) : this(stream, options, MaxRows) { }

    /// <param name="maxRows">Sheet row limit (tests use a small one).</param>
    internal XlsxResultWriter(Stream stream, ExportOptions options, int maxRows)
    {
        _maxRows = Math.Max(3, maxRows);
        _target = stream;
        // ZipArchive writes synchronously; a non-seekable target (an HTTP response) gets the archive through a temp file.
        if (stream.CanSeek)
        {
            _zipStream = stream;
        }
        else
        {
            _zipStream = new FileStream(Path.Combine(Path.GetTempPath(), $"dbstudio-{Guid.NewGuid():N}.xlsx.tmp"), FileMode.CreateNew,
                FileAccess.ReadWrite, FileShare.None, 64 * 1024, FileOptions.DeleteOnClose);
            _ownsZipStream = true;
        }
        _zip = new ZipArchive(_zipStream, ZipArchiveMode.Create, leaveOpen: true, Encoding.UTF8);
        _options = options;
    }

    public Task BeginAsync(ColumnInfo[] columns, CancellationToken ct)
    {
        _columns = columns.Length > MaxColumns ? columns[..MaxColumns] : columns;
        WritePart("[Content_Types].xml", ContentTypes);
        WritePart("_rels/.rels", RootRels);
        WritePart("docProps/app.xml", AppProps);
        WritePart("docProps/core.xml", CoreProps(DateTime.UtcNow));
        WritePart("xl/_rels/workbook.xml.rels", WorkbookRels);
        WritePart("xl/styles.xml", Styles);
        return Task.CompletedTask;
    }

    public Task WriteRowAsync(object?[] row, CancellationToken ct)
    {
        if (!_sheetStarted)
        {
            _sample.Add(row);
            if (_sample.Count >= SampleRows) StartSheet();
            return Task.CompletedTask;
        }
        WriteDataRow(row);
        return Task.CompletedTask;
    }

    public async Task EndAsync(CancellationToken ct)
    {
        if (_ended) return;
        _ended = true;
        if (!_sheetStarted) StartSheet();
        var xml = _xml!;
        var filterRef = _columns.Length > 0 ? $"A1:{ColumnName(_columns.Length - 1)}{_rowIndex.ToString(CultureInfo.InvariantCulture)}" : null;
        if (_dropped > 0)
        {
            _rowIndex++;
            xml.WriteStartElement("row", NsMain);
            xml.WriteAttributeString("r", _rowIndex.ToString(CultureInfo.InvariantCulture));
            InlineString(xml, CellRef(0, _rowIndex),
                $"Excel row limit reached: {_dropped.ToString("N0", CultureInfo.InvariantCulture)} more row(s) were not exported. Export as CSV to get every row.", 0);
            xml.WriteEndElement();
        }
        xml.WriteEndElement(); // sheetData
        if (filterRef is not null)
        {
            xml.WriteStartElement("autoFilter", NsMain);
            xml.WriteAttributeString("ref", filterRef);
            xml.WriteEndElement();
        }
        xml.WriteStartElement("pageMargins", NsMain);
        foreach (var (k, v) in new[] { ("left", "0.7"), ("right", "0.7"), ("top", "0.75"), ("bottom", "0.75"), ("header", "0.3"), ("footer", "0.3") })
            xml.WriteAttributeString(k, v);
        xml.WriteEndElement();
        xml.WriteEndElement(); // worksheet
        xml.WriteEndDocument();
        xml.Flush();
        xml.Dispose();
        _xml = null;
        _sheetEntry!.Dispose();
        _sheetEntry = null;
        // written last: the filter's defined name spans the rows written
        var sheetName = SheetName(_options.TableName ?? _columns.FirstOrDefault(c => !string.IsNullOrEmpty(c.Table))?.Table);
        WritePart("xl/workbook.xml", Workbook(sheetName, filterRef));
        _zip.Dispose();
        if (_ownsZipStream)
        {
            _zipStream.Position = 0;
            await _zipStream.CopyToAsync(_target, 64 * 1024, ct).ConfigureAwait(false);
        }
        await _target.FlushAsync(ct).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        _xml?.Dispose();
        _sheetEntry?.Dispose();
        if (!_ended) _zip.Dispose();
        if (_ownsZipStream) await _zipStream.DisposeAsync().ConfigureAwait(false);
    }

    // ------------------------------------------------------------ sheet

    private void StartSheet()
    {
        _sheetStarted = true;
        var entry = _zip.CreateEntry("xl/worksheets/sheet1.xml", CompressionLevel.Fastest);
        _sheetEntry = entry.Open();
        var xml = _xml = XmlWriter.Create(_sheetEntry, XmlSettings);
        xml.WriteStartDocument(true);
        xml.WriteStartElement("worksheet", NsMain);
        xml.WriteAttributeString("xmlns", "r", null, NsRel);

        xml.WriteStartElement("sheetViews", NsMain);
        xml.WriteStartElement("sheetView", NsMain);
        xml.WriteAttributeString("workbookViewId", "0");
        if (_columns.Length > 0)
        {
            xml.WriteStartElement("pane", NsMain);
            xml.WriteAttributeString("ySplit", "1");
            xml.WriteAttributeString("topLeftCell", "A2");
            xml.WriteAttributeString("activePane", "bottomLeft");
            xml.WriteAttributeString("state", "frozen");
            xml.WriteEndElement();
            xml.WriteStartElement("selection", NsMain);
            xml.WriteAttributeString("pane", "bottomLeft");
            xml.WriteAttributeString("activeCell", "A2");
            xml.WriteAttributeString("sqref", "A2");
            xml.WriteEndElement();
        }
        xml.WriteEndElement();
        xml.WriteEndElement();

        xml.WriteStartElement("sheetFormatPr", NsMain);
        xml.WriteAttributeString("defaultRowHeight", "15");
        xml.WriteEndElement();

        if (_columns.Length > 0)
        {
            xml.WriteStartElement("cols", NsMain);
            for (var i = 0; i < _columns.Length; i++)
            {
                xml.WriteStartElement("col", NsMain);
                var n = (i + 1).ToString(CultureInfo.InvariantCulture);
                xml.WriteAttributeString("min", n);
                xml.WriteAttributeString("max", n);
                xml.WriteAttributeString("width", ColumnWidth(_columns[i], i, _sample).ToString("0.##", CultureInfo.InvariantCulture));
                xml.WriteAttributeString("customWidth", "1");
                xml.WriteEndElement();
            }
            xml.WriteEndElement();
        }

        xml.WriteStartElement("sheetData", NsMain);
        if (_columns.Length > 0)
        {
            xml.WriteStartElement("row", NsMain);
            xml.WriteAttributeString("r", "1");
            for (var i = 0; i < _columns.Length; i++)
                InlineString(xml, CellRef(i, 1), string.IsNullOrEmpty(_columns[i].Name) ? $"column{i + 1}" : _columns[i].Name, StyleHeader);
            xml.WriteEndElement();
        }
        foreach (var row in _sample) WriteDataRow(row);
        _sample.Clear();
    }

    private void WriteDataRow(object?[] row)
    {
        // the last sheet row is kept for the "row limit reached" note
        if (_rowIndex >= _maxRows - 1)
        {
            _dropped++;
            return;
        }
        _rowIndex++;
        var xml = _xml!;
        xml.WriteStartElement("row", NsMain);
        xml.WriteAttributeString("r", _rowIndex.ToString(CultureInfo.InvariantCulture));
        for (var i = 0; i < row.Length && i < _columns.Length; i++) WriteCell(xml, CellRef(i, _rowIndex), row[i], _columns[i]);
        xml.WriteEndElement();
    }

    private static void WriteCell(XmlWriter xml, string cellRef, object? v, ColumnInfo column)
    {
        switch (v)
        {
            case null or CursorValue:
                return; // empty cell
            case bool b:
                Cell(xml, cellRef, "b", b ? "1" : "0", 0);
                return;
            case long l when Math.Abs((double)l) >= 1e15:
                InlineString(xml, cellRef, l.ToString(CultureInfo.InvariantCulture), 0); // more digits than an Excel number keeps
                return;
            case int or long or short or byte or sbyte or ushort or uint:
                Cell(xml, cellRef, null, Convert.ToString(v, CultureInfo.InvariantCulture)!, 0);
                return;
            case double d when double.IsFinite(d):
                Cell(xml, cellRef, null, d.ToString("R", CultureInfo.InvariantCulture), 0);
                return;
            case float f when float.IsFinite(f):
                Cell(xml, cellRef, null, ((double)f).ToString("R", CultureInfo.InvariantCulture), 0);
                return;
        }

        var text = ExportFormats.FullText(v) ?? "";
        if (v is string s)
        {
            switch (column.Kind)
            {
                case ColumnKinds.Int or ColumnKinds.Decimal or ColumnKinds.Float when ExactNumber(s):
                    Cell(xml, cellRef, null, s, 0);
                    return;
                case ColumnKinds.Date when TryDateSerial(s, out var serial):
                    Cell(xml, cellRef, null, serial.ToString("0.###########", CultureInfo.InvariantCulture), StyleDate);
                    return;
                case ColumnKinds.DateTime when TryDateSerial(s, out var serial):
                    Cell(xml, cellRef, null, serial.ToString("0.###########", CultureInfo.InvariantCulture), Math.Abs(serial % 1) < 1e-12 && !s.Contains('T') ? StyleDate : StyleDateTime);
                    return;
                case ColumnKinds.Time when TryTimeFraction(s, out var fraction):
                    Cell(xml, cellRef, null, fraction.ToString("0.###########", CultureInfo.InvariantCulture), StyleTime);
                    return;
            }
        }
        InlineString(xml, cellRef, text, 0);
    }

    private static void Cell(XmlWriter xml, string cellRef, string? type, string value, int style)
    {
        xml.WriteStartElement("c", NsMain);
        xml.WriteAttributeString("r", cellRef);
        if (style != 0) xml.WriteAttributeString("s", style.ToString(CultureInfo.InvariantCulture));
        if (type is not null) xml.WriteAttributeString("t", type);
        xml.WriteElementString("v", NsMain, value);
        xml.WriteEndElement();
    }

    private static void InlineString(XmlWriter xml, string cellRef, string text, int style)
    {
        xml.WriteStartElement("c", NsMain);
        xml.WriteAttributeString("r", cellRef);
        if (style != 0) xml.WriteAttributeString("s", style.ToString(CultureInfo.InvariantCulture));
        xml.WriteAttributeString("t", "inlineStr");
        xml.WriteStartElement("is", NsMain);
        xml.WriteStartElement("t", NsMain);
        var clean = Clean(text);
        if (clean.Length > 0 && (char.IsWhiteSpace(clean[0]) || char.IsWhiteSpace(clean[^1]) || clean.Contains('\n')))
            xml.WriteAttributeString("xml", "space", null, "preserve");
        xml.WriteString(clean);
        xml.WriteEndElement();
        xml.WriteEndElement();
        xml.WriteEndElement();
    }

    // ------------------------------------------------------------ values (pure, unit tested)

    /// <summary>Removes characters XML 1.0 cannot carry (C0 controls except tab/CR/LF, lone surrogates, U+FFFE/FFFF) and caps the length.</summary>
    public static string Clean(string s)
    {
        StringBuilder? sb = null;
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            bool ok;
            if (char.IsHighSurrogate(c))
            {
                ok = i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]);
                if (ok)
                {
                    sb?.Append(c).Append(s[i + 1]);
                    i++;
                    continue;
                }
            }
            else ok = !char.IsLowSurrogate(c) && (c >= 0x20 ? c is not ('￾' or '￿') : c is '\t' or '\n' or '\r');
            if (ok)
            {
                sb?.Append(c);
                continue;
            }
            sb ??= new StringBuilder(s.Length).Append(s, 0, i);
        }
        var r = sb?.ToString() ?? s;
        if (r.Length > MaxCellChars) r = r[..MaxCellChars];
        return r;
    }

    [GeneratedRegex(@"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")]
    private static partial Regex NumberText();

    /// <summary>A decimal text that an Excel number (IEEE double, 15 significant digits) holds without loss.</summary>
    public static bool ExactNumber(string s)
    {
        if (!NumberText().IsMatch(s)) return false;
        var mantissa = s.Split('e', 'E')[0].TrimStart('-').Replace(".", "", StringComparison.Ordinal).TrimStart('0');
        // trailing zeros of a fraction ("12.50") do not count, those of an integer do
        if (s.Contains('.')) mantissa = mantissa.TrimEnd('0');
        return mantissa.Length <= 15 && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d);
    }

    private static readonly DateTime Epoch = new(1899, 12, 30, 0, 0, 0, DateTimeKind.Unspecified);

    /// <summary>Excel serial of a wire date / datetime ("2026-10-14", "2026-10-14T10:00:00.5"); false before 1900-01-01.</summary>
    public static bool TryDateSerial(string s, out double serial)
    {
        serial = 0;
        if (!DateTime.TryParseExact(s, ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFFFFFF", "yyyy-MM-dd HH:mm:ss"],
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt))
            return false;
        if (dt.Year < 1900) return false;
        serial = (dt - Epoch).TotalDays;
        // Excel's day 60 is the fictitious 1900-02-29: dates before March 1900 are one lower
        if (serial < 61) serial -= 1;
        return true;
    }

    /// <summary>Fraction of a day of a wire time ("10:00:00.5"); false for spans of a day or more.</summary>
    public static bool TryTimeFraction(string s, out double fraction)
    {
        fraction = 0;
        if (!TimeSpan.TryParseExact(s, [@"hh\:mm\:ss\.FFFFFFF", @"hh\:mm\:ss"], CultureInfo.InvariantCulture, out var ts)) return false;
        if (ts < TimeSpan.Zero || ts >= TimeSpan.FromDays(1)) return false;
        fraction = ts.TotalDays;
        return true;
    }

    /// <summary>0 → "A", 25 → "Z", 26 → "AA".</summary>
    public static string ColumnName(int index)
    {
        var sb = new StringBuilder(3);
        for (var n = index + 1; n > 0; n = (n - 1) / 26) sb.Insert(0, (char)('A' + (n - 1) % 26));
        return sb.ToString();
    }

    private static string CellRef(int col, long row) => ColumnName(col) + row.ToString(CultureInfo.InvariantCulture);

    /// <summary>Width in characters: header and the sampled values (longest line), within 8..60; dates get room for their format.</summary>
    public static double ColumnWidth(ColumnInfo column, int index, IReadOnlyList<object?[]> sample)
    {
        var max = Math.Max(4, DisplayLength(column.Name) + 2); // the header carries the filter button
        var floor = column.Kind switch
        {
            ColumnKinds.Date => 11,
            ColumnKinds.DateTime => 20,
            ColumnKinds.Time => 10,
            _ => 0,
        };
        foreach (var row in sample)
        {
            if (index >= row.Length || row[index] is null) continue;
            var text = ExportFormats.FullText(row[index]) ?? "";
            if (text.Length > 200) text = text[..200];
            foreach (var line in text.Split('\n')) max = Math.Max(max, DisplayLength(line));
        }
        return Math.Clamp(Math.Max(max + 1, floor), 8, 60);
    }

    /// <summary>Approximate width in Excel character units (wide East Asian characters count double).</summary>
    private static int DisplayLength(string s)
    {
        var n = 0;
        foreach (var c in s) n += c is >= 'ᄀ' and (<= 'ᅟ' or (>= '⺀' and <= '꓏') or (>= '가' and <= '힣') or (>= '豈' and <= '﫿') or (>= '＀' and <= '｠')) ? 2 : 1;
        return n;
    }

    /// <summary>A valid sheet name (≤ 31 chars, none of : \ / ? * [ ], not starting or ending with an apostrophe).</summary>
    public static string SheetName(string? name)
    {
        var s = new string((name ?? "").Where(c => c is not (':' or '\\' or '/' or '?' or '*' or '[' or ']') && !char.IsControl(c)).ToArray()).Trim().Trim('\'');
        if (s.Length > 31) s = s[..31];
        return s.Length == 0 || s.Equals("History", StringComparison.OrdinalIgnoreCase) ? "Result" : s;
    }

    // ------------------------------------------------------------ static parts

    private void WritePart(string path, string xml)
    {
        var entry = _zip.CreateEntry(path, CompressionLevel.Fastest);
        using var s = entry.Open();
        var bytes = Encoding.UTF8.GetBytes(xml);
        s.Write(bytes, 0, bytes.Length);
    }

    private static string Esc(string s) => System.Security.SecurityElement.Escape(Clean(s)) ?? "";

    private const string ContentTypes =
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">""" +
        """<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>""" +
        """<Default Extension="xml" ContentType="application/xml"/>""" +
        """<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>""" +
        """<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>""" +
        """<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>""" +
        """<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>""" +
        """<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>""" +
        "</Types>";

    private const string RootRels =
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        $"""<Relationships xmlns="{NsPkgRel}">""" +
        """<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>""" +
        """<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>""" +
        """<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>""" +
        "</Relationships>";

    private const string AppProps =
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        """<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DbStudio</Application></Properties>""";

    private static string CoreProps(DateTime utc)
    {
        var at = utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
        return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
               """<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" """ +
               """xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">""" +
               "<dc:creator>DbStudio</dc:creator>" +
               $"""<dcterms:created xsi:type="dcterms:W3CDTF">{at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{at}</dcterms:modified>""" +
               "</cp:coreProperties>";
    }

    private static string Workbook(string sheetName, string? filterRef) =>
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        $"""<workbook xmlns="{NsMain}" xmlns:r="{NsRel}">""" +
        """<bookViews><workbookView/></bookViews>""" +
        $"""<sheets><sheet name="{Esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>""" +
        (filterRef is not null
            ? $"""<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">{Esc(QuoteSheet(sheetName) + "!" + AbsoluteRef(filterRef))}</definedName></definedNames>"""
            : "") +
        "</workbook>";

    /// <summary>"A1:C10" → "$A$1:$C$10".</summary>
    private static string AbsoluteRef(string range) =>
        string.Join(':', range.Split(':').Select(p => "$" + new string(p.TakeWhile(char.IsLetter).ToArray()) + "$" + new string(p.SkipWhile(char.IsLetter).ToArray())));

    private static string QuoteSheet(string name) => "'" + name.Replace("'", "''", StringComparison.Ordinal) + "'";

    private const string WorkbookRels =
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        $"""<Relationships xmlns="{NsPkgRel}">""" +
        """<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>""" +
        """<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>""" +
        "</Relationships>";

    /// <summary>cellXfs: 0 default, 1 bold header, 2 date, 3 date + time, 4 time.</summary>
    private const string Styles =
        """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>""" +
        $"""<styleSheet xmlns="{NsMain}">""" +
        """<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/><numFmt numFmtId="165" formatCode="yyyy\-mm\-dd\ hh:mm:ss"/><numFmt numFmtId="166" formatCode="hh:mm:ss"/></numFmts>""" +
        """<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>""" +
        """<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>""" +
        """<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>""" +
        """<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>""" +
        """<cellXfs count="5">""" +
        """<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>""" +
        """<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>""" +
        """<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>""" +
        """<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>""" +
        """<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>""" +
        "</cellXfs>" +
        """<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>""" +
        "</styleSheet>";
}
