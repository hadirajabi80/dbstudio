using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Export;

/// <summary>Export options (ui/src/api/types.ts ExportOptions).</summary>
public sealed record ExportOptions(string? Delimiter = null, bool? Header = null, string? NullAs = null, string? TableName = null);

/// <summary>Streams one result set (wire values, see <see cref="ValueConverter"/>) into a file format.</summary>
public interface IResultWriter : IAsyncDisposable
{
    Task BeginAsync(ColumnInfo[] columns, CancellationToken ct);
    Task WriteRowAsync(object?[] row, CancellationToken ct);
    Task EndAsync(CancellationToken ct);
}

public static class ExportFormats
{
    public const string Csv = "csv", Json = "json", SqlInsert = "sql-insert", Xlsx = "xlsx";

    public static bool IsKnown(string? format) => format is Csv or Json or SqlInsert or Xlsx;

    /// <summary>Binary formats (no charset in the Content-Type).</summary>
    public static bool IsBinary(string format) => format is Xlsx;

    public static string Extension(string format) => format switch { Json => ".json", SqlInsert => ".sql", Xlsx => ".xlsx", _ => ".csv" };

    public static string ContentType(string format) => format switch
    {
        Json => "application/json",
        SqlInsert => "application/sql",
        Xlsx => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "text/csv",
    };

    /// <summary>Creates a writer over <paramref name="stream"/> (UTF-8 without BOM). The stream is left open.</summary>
    public static IResultWriter Create(string format, Stream stream, ExportOptions options, Dialect dialect) => format switch
    {
        Csv => new CsvResultWriter(stream, options),
        Json => new JsonResultWriter(stream),
        SqlInsert => new SqlInsertResultWriter(stream, options, dialect),
        Xlsx => new XlsxResultWriter(stream, options),
        _ => throw EngineException.Validation($"Unknown export format '{format}'. Expected csv, json, sql-insert or xlsx."),
    };

    /// <summary>Text of a cell for text formats: full values (not the 32 KB wire preview), binary as 0x-hex.</summary>
    internal static string? FullText(object? wire) => wire switch
    {
        null => null,
        string s => s,
        TruncatedValue t => t.Full,
        BinaryValue b => "0x" + Convert.ToHexString(b.Full),
        CursorValue => null,
        bool v => v ? "true" : "false",
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        float f => f.ToString("R", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => wire.ToString(),
    };
}

/// <summary>RFC 4180 CSV: CRLF records, fields quoted when they contain the delimiter, a quote, CR or LF; quotes doubled.</summary>
public sealed class CsvResultWriter : IResultWriter
{
    private readonly StreamWriter _writer;
    private readonly string _delimiter;
    private readonly bool _header;
    private readonly string _nullAs;

    public CsvResultWriter(Stream stream, ExportOptions options)
    {
        _writer = new StreamWriter(stream, new UTF8Encoding(false), 64 * 1024, leaveOpen: true) { NewLine = "\r\n" };
        _delimiter = string.IsNullOrEmpty(options.Delimiter) ? "," : options.Delimiter == "\\t" ? "\t" : options.Delimiter;
        _header = options.Header ?? true;
        _nullAs = options.NullAs ?? "";
    }

    public async Task BeginAsync(ColumnInfo[] columns, CancellationToken ct)
    {
        if (!_header) return;
        await WriteRecordAsync(columns.Select(c => (string?)c.Name).ToArray(), nullAsIs: true).ConfigureAwait(false);
    }

    public Task WriteRowAsync(object?[] row, CancellationToken ct) =>
        WriteRecordAsync(row.Select(ExportFormats.FullText).ToArray(), nullAsIs: false);

    private async Task WriteRecordAsync(string?[] fields, bool nullAsIs)
    {
        for (var i = 0; i < fields.Length; i++)
        {
            if (i > 0) await _writer.WriteAsync(_delimiter).ConfigureAwait(false);
            var f = fields[i] ?? (nullAsIs ? "" : _nullAs);
            await _writer.WriteAsync(Escape(f, _delimiter)).ConfigureAwait(false);
        }
        await _writer.WriteLineAsync().ConfigureAwait(false);
    }

    public static string Escape(string field, string delimiter)
    {
        var needsQuotes = field.Contains(delimiter, StringComparison.Ordinal) || field.Contains('"') || field.Contains('\r') || field.Contains('\n');
        return needsQuotes ? "\"" + field.Replace("\"", "\"\"") + "\"" : field;
    }

    public Task EndAsync(CancellationToken ct) => _writer.FlushAsync(ct);

    public ValueTask DisposeAsync() => _writer.DisposeAsync();
}

/// <summary>JSON array of objects keyed by column name (duplicates get _2, _3 ...). Exact numerics are written as JSON numbers.</summary>
public sealed partial class JsonResultWriter(Stream stream) : IResultWriter
{
    private readonly Utf8JsonWriter _json = new(stream, new JsonWriterOptions { Indented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    private JsonEncodedText[] _names = [];
    private ColumnInfo[] _columns = [];

    [GeneratedRegex(@"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")]
    private static partial Regex JsonNumber();

    public Task BeginAsync(ColumnInfo[] columns, CancellationToken ct)
    {
        _columns = columns;
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        _names = columns.Select(c =>
        {
            var name = string.IsNullOrEmpty(c.Name) ? $"column{c.Ordinal + 1}" : c.Name;
            if (seen.TryGetValue(name, out var n)) { seen[name] = n + 1; name = $"{name}_{n + 1}"; }
            else seen[name] = 1;
            return JsonEncodedText.Encode(name);
        }).ToArray();
        _json.WriteStartArray();
        return Task.CompletedTask;
    }

    public async Task WriteRowAsync(object?[] row, CancellationToken ct)
    {
        _json.WriteStartObject();
        for (var i = 0; i < row.Length && i < _names.Length; i++)
        {
            _json.WritePropertyName(_names[i]);
            WriteValue(row[i], _columns[i]);
        }
        _json.WriteEndObject();
        if (_json.BytesPending > 64 * 1024) await _json.FlushAsync(ct).ConfigureAwait(false);
    }

    private void WriteValue(object? v, ColumnInfo column)
    {
        switch (v)
        {
            case null or CursorValue: _json.WriteNullValue(); break;
            case bool b: _json.WriteBooleanValue(b); break;
            case int i: _json.WriteNumberValue(i); break;
            case long l: _json.WriteNumberValue(l); break;
            case short s: _json.WriteNumberValue(s); break;
            case byte by: _json.WriteNumberValue(by); break;
            case double d: _json.WriteNumberValue(d); break;
            case float f: _json.WriteNumberValue(f); break;
            case string s when column.Kind is ColumnKinds.Decimal or ColumnKinds.Int && JsonNumber().IsMatch(s): _json.WriteRawValue(s); break;
            case BinaryValue bin: _json.WriteBase64StringValue(bin.Full); break;
            case TruncatedValue t: _json.WriteStringValue(t.Full); break;
            default: _json.WriteStringValue(ExportFormats.FullText(v)); break;
        }
    }

    public async Task EndAsync(CancellationToken ct)
    {
        _json.WriteEndArray();
        await _json.FlushAsync(ct).ConfigureAwait(false);
    }

    public ValueTask DisposeAsync() => _json.DisposeAsync();
}

/// <summary>One <c>INSERT INTO t (cols) VALUES (...);</c> per row with dialect-specific literals.</summary>
public sealed partial class SqlInsertResultWriter : IResultWriter
{
    private readonly StreamWriter _writer;
    private readonly ExportOptions _options;
    private readonly Dialect _dialect;
    private string _prefix = "";
    private ColumnInfo[] _columns = [];

    [GeneratedRegex(@"^[A-Za-z_][A-Za-z0-9_]*$")]
    private static partial Regex SimpleIdentifier();

    [GeneratedRegex(@"^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$")]
    private static partial Regex Numeric();

    private static readonly HashSet<string> CommonReserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "select", "from", "where", "order", "group", "by", "table", "index", "key", "primary", "user", "date", "level",
        "size", "number", "comment", "desc", "asc", "values", "insert", "update", "delete", "default", "check", "column",
        "file", "type", "view", "uid", "session", "option", "row", "rows", "start", "end", "transaction", "references",
    };

    public SqlInsertResultWriter(Stream stream, ExportOptions options, Dialect dialect)
    {
        _writer = new StreamWriter(stream, new UTF8Encoding(false), 64 * 1024, leaveOpen: true) { NewLine = "\r\n" };
        _options = options;
        _dialect = dialect;
    }

    public Task BeginAsync(ColumnInfo[] columns, CancellationToken ct)
    {
        _columns = columns;
        var table = !string.IsNullOrWhiteSpace(_options.TableName)
            ? _options.TableName!.Trim()
            : columns.Select(c => c.Table).FirstOrDefault(t => !string.IsNullOrEmpty(t)) is { } t
                ? (columns.First(c => c.Table == t).Schema is { Length: > 0 } s ? QuoteIfNeeded(s) + "." : "") + QuoteIfNeeded(t)
                : "exported_rows";
        _prefix = $"INSERT INTO {table} ({string.Join(", ", columns.Select(c => QuoteIfNeeded(c.Name)))}) VALUES (";
        return Task.CompletedTask;
    }

    public async Task WriteRowAsync(object?[] row, CancellationToken ct)
    {
        var sb = new StringBuilder(_prefix, _prefix.Length + row.Length * 12);
        for (var i = 0; i < row.Length; i++)
        {
            if (i > 0) sb.Append(", ");
            sb.Append(Literal(row[i], i < _columns.Length ? _columns[i] : null));
        }
        sb.Append(");");
        await _writer.WriteLineAsync(sb.ToString()).ConfigureAwait(false);
    }

    private string QuoteIfNeeded(string name)
    {
        if (SimpleIdentifier().IsMatch(name) && !CommonReserved.Contains(name)
            && !(_dialect == Dialect.PlSql && name != name.ToUpperInvariant()))
            return name;
        return DialectInfo.QuoteIdentifier(_dialect, name);
    }

    internal string Literal(object? v, ColumnInfo? column)
    {
        switch (v)
        {
            case null or CursorValue: return "NULL";
            case bool b: return _dialect == Dialect.Cql ? (b ? "true" : "false") : b ? "1" : "0";
            case int or long or short or byte or sbyte or ushort: return Convert.ToString(v, CultureInfo.InvariantCulture)!;
            case double d: return d.ToString("R", CultureInfo.InvariantCulture);
            case float f: return f.ToString("R", CultureInfo.InvariantCulture);
            case BinaryValue bin:
                var hex = Convert.ToHexString(bin.Full);
                return _dialect switch
                {
                    Dialect.TSql or Dialect.MySql or Dialect.Cql => "0x" + hex,
                    Dialect.PlSql => $"HEXTORAW('{hex}')",
                    Dialect.ClickHouse => $"unhex('{hex}')",
                    Dialect.Snowflake => $"TO_BINARY('{hex}', 'HEX')",
                    _ => $"X'{hex}'",
                };
        }

        var text = ExportFormats.FullText(v) ?? "";
        var kind = column?.Kind;
        // CQL: uuid / timeuuid are unquoted; collections, tuples and UDTs (kind json) need CQL literal syntax
        if (_dialect == Dialect.Cql && kind == ColumnKinds.Guid && Guid.TryParse(text, out _)) return text;
        if (_dialect == Dialect.Cql && kind == ColumnKinds.Json) return CqlLiterals.FromJson(text, column!.DbType);
        if (kind is ColumnKinds.Decimal or ColumnKinds.Int or ColumnKinds.Float && Numeric().IsMatch(text)) return text;
        if (_dialect == Dialect.PlSql)
        {
            if (kind == ColumnKinds.Date && text.Length == 10) return $"DATE '{text}'";
            if (kind is ColumnKinds.DateTime or ColumnKinds.DateTimeOffset && text.Length >= 19 && text[10] == 'T')
                return $"TIMESTAMP '{text.Replace('T', ' ')}'";
        }
        var escaped = text.Replace("'", "''");
        if (DialectInfo.BackslashStringEscapes(_dialect)) escaped = escaped.Replace("\\", "\\\\");
        return _dialect == Dialect.TSql && kind is ColumnKinds.String or ColumnKinds.Json or ColumnKinds.Xml or ColumnKinds.Other or null
            ? $"N'{escaped}'"
            : $"'{escaped}'";
    }

    public Task EndAsync(CancellationToken ct) => _writer.FlushAsync(ct);

    public ValueTask DisposeAsync() => _writer.DisposeAsync();
}
