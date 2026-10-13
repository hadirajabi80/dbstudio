using System.Collections;
using System.Globalization;
using System.Numerics;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// Converts provider values to wire values (docs/PLAN.md 2.4) and maps column types to <see cref="ColumnInfo.Kind"/>.
/// <list type="bullet">
/// <item>null / DBNull → null; bool → bool; 8..32-bit integers → number</item>
/// <item>int64/uint64 → number when |v| ≤ 2^53, else string; BigInteger → string</item>
/// <item>float/double → number; NaN/±Infinity → "NaN"/"Infinity"/"-Infinity"</item>
/// <item>decimal (and provider NUMBER types, via <see cref="ToWire"/> on their string form) → string, precision preserved</item>
/// <item>DateTime → "2026-10-14T10:00:00.1234567" (no zone, trailing zero fraction digits trimmed);
///       DateOnly → "2026-10-14"; TimeOnly/TimeSpan → "10:00:00.1234567"; DateTimeOffset → ISO with offset</item>
/// <item>Guid → string; byte[] → <see cref="BinaryValue"/>; strings longer than 32 K chars → <see cref="TruncatedValue"/></item>
/// <item>anything else → invariant <c>ToString()</c> (same truncation)</item>
/// </list>
/// Thread-safe and allocation-light; all members are static.
/// </summary>
public static class ValueConverter
{
    /// <summary>Strings longer than this many UTF-16 chars are sent as <see cref="TruncatedValue"/>.</summary>
    public const int MaxStringChars = 32 * 1024;

    /// <summary>Binary values carry at most this many bytes (base64) on the wire.</summary>
    public const int MaxBinaryPreviewBytes = 8 * 1024;

    /// <summary>2^53: the largest integer magnitude a JavaScript number represents exactly.</summary>
    public const long MaxSafeInteger = 9_007_199_254_740_992L;

    public const string DateTimeFormat = "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF";
    public const string DateFormat = "yyyy-MM-dd";
    public const string TimeFormat = "HH:mm:ss.FFFFFFF";
    public const string DateTimeOffsetFormat = "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>Converts one provider value (as returned by <c>DbDataReader.GetValue</c>) to its wire value.</summary>
    public static object? ToWire(object? value)
    {
        switch (value)
        {
            case null:
            case DBNull:
                return null;
            case string s:
                return Text(s);
            case bool:
            case int:
            case short:
            case byte:
            case sbyte:
            case ushort:
                return value;
            case uint ui:
                return (long)ui;
            case long l:
                return l is >= -MaxSafeInteger and <= MaxSafeInteger ? l : l.ToString(Inv);
            case ulong ul:
                return ul <= MaxSafeInteger ? (long)ul : ul.ToString(Inv);
            case double d:
                return Floating(d);
            case float f:
                // Round-trip through the shortest float text so 0.1f is sent as 0.1, not 0.10000000149011612.
                return float.IsFinite(f) ? double.Parse(f.ToString("R", Inv), Inv) : Floating(f);
            case Half h:
                return Floating((double)h);
            case decimal m:
                return m.ToString(Inv);
            case BigInteger bi:
                return bi.ToString(Inv);
            case DateTime dt:
                return FormatDateTime(dt);
            case DateTimeOffset dto:
                return dto.ToString(DateTimeOffsetFormat, Inv);
            case DateOnly d:
                return d.ToString(DateFormat, Inv);
            case TimeOnly t:
                return t.ToString(TimeFormat, Inv);
            case TimeSpan ts:
                return FormatTimeSpan(ts);
            case Guid g:
                return g.ToString("D");
            case byte[] bytes:
                return new BinaryValue(bytes);
            case char c:
                return c.ToString();
            case char[] chars:
                return Text(new string(chars));
            case BinaryValue or TruncatedValue or CursorValue:
                return value;
            case IFormattable formattable:
                return Text(formattable.ToString(null, Inv));
            default:
                return Text(value.ToString() ?? "");
        }
    }

    /// <summary>Converts a whole row in place-free fashion.</summary>
    public static object?[] ToWireRow(object?[] values)
    {
        var row = new object?[values.Length];
        for (var i = 0; i < values.Length; i++) row[i] = ToWire(values[i]);
        return row;
    }

    /// <summary>Text value with the 32 K truncation rule applied.</summary>
    public static object Text(string s) => s.Length > MaxStringChars ? new TruncatedValue(s) : s;

    public static string FormatDateTime(DateTime dt) => dt.ToString(DateTimeFormat, Inv);

    /// <summary>"10:00:00.1234567"; negative or ≥ 24h spans use the constant "c" format ("1.02:00:00").</summary>
    public static string FormatTimeSpan(TimeSpan ts) =>
        ts >= TimeSpan.Zero && ts < TimeSpan.FromDays(1)
            ? TimeOnly.FromTimeSpan(ts).ToString(TimeFormat, Inv)
            : ts.ToString("c", Inv);

    private static object Floating(double d)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsPositiveInfinity(d)) return "Infinity";
        if (double.IsNegativeInfinity(d)) return "-Infinity";
        return d;
    }

    /// <summary>
    /// The complete (untruncated) value of a wire cell, for full-cell fetch and exports.
    /// Returns ("string", text) or ("binary", base64); null cells return (string, null).
    /// </summary>
    public static (string Kind, string? Value, long Length) FullValue(object? wire)
    {
        switch (wire)
        {
            case null: return ("string", null, 0);
            case BinaryValue b: return ("binary", Convert.ToBase64String(b.Full), b.Len);
            case TruncatedValue t: return ("string", t.Full, t.Len);
            default:
                var text = ToInvariantString(wire);
                return ("string", text, text.Length);
        }
    }

    /// <summary>Invariant text of a wire value (numbers, bools as true/false, binary as base64).</summary>
    public static string ToInvariantString(object? wire) => wire switch
    {
        null => "",
        string s => s,
        bool b => b ? "true" : "false",
        double d => d.ToString("R", Inv),
        float f => f.ToString("R", Inv),
        IFormattable f => f.ToString(null, Inv),
        _ => wire.ToString() ?? "",
    };

    /// <summary>Approximate managed size of a wire value in bytes (used by the result store's memory cap).</summary>
    public static long EstimateSize(object? wire) => wire switch
    {
        null => 8,
        string s => 24 + 2L * s.Length,
        BinaryValue b => 48 + b.Full.LongLength + 2L * b.Bin.Length,
        TruncatedValue t => 48 + 2L * t.Full.Length + 2L * t.Trunc.Length,
        _ => 24,
    };

    // ---------------------------------------------------------------- column kinds

    /// <summary>
    /// Maps a column to a <see cref="ColumnInfo.Kind"/> token from its CLR field type and provider type name.
    /// The provider type name wins when it is recognised (e.g. SQL Server <c>date</c> vs <c>datetime</c>, both CLR DateTime);
    /// otherwise the CLR type decides; for SQLite, declared-type affinity rules are applied last.
    /// </summary>
    public static string KindFor(Type? clrType, string? dbTypeName, Dialect? dialect = null)
    {
        clrType = clrType is null ? null : Nullable.GetUnderlyingType(clrType) ?? clrType;
        var name = NormalizeTypeName(dbTypeName);

        // Binary CLR types are always binary (SQL Server "timestamp" is rowversion, not a date).
        if (clrType == typeof(byte[])) return ColumnKinds.Binary;

        if (name.Length > 0)
        {
            if (name is "date" && dialect == Dialect.PlSql) return ColumnKinds.DateTime; // Oracle DATE has a time part
            if (KindByTypeName.TryGetValue(name, out var byName))
            {
                // A provider may report a numeric name for a string-typed CLR value (e.g. NUMBER read as string): keep the name.
                return byName;
            }
            if (name.StartsWith("timestamp", StringComparison.Ordinal))
                return name.Contains("time zone", StringComparison.Ordinal) && !name.Contains("local", StringComparison.Ordinal)
                    ? ColumnKinds.DateTimeOffset
                    : ColumnKinds.DateTime;
            if (name.StartsWith("interval", StringComparison.Ordinal)) return ColumnKinds.String;
        }

        var byClr = KindByClrType(clrType);
        if (byClr is not null && (dialect != Dialect.Sqlite || name.Length == 0)) return byClr;

        if (name.Length > 0 && (dialect == Dialect.Sqlite || clrType is null || clrType == typeof(object)))
        {
            var affinity = SqliteAffinityKind(name);
            if (affinity is not null) return affinity;
        }

        return byClr ?? ColumnKinds.Other;
    }

    /// <summary>Lower-case type name without length/precision suffix: "NVARCHAR(50)" → "nvarchar", "TIMESTAMP(6) WITH TIME ZONE" → "timestamp with time zone".</summary>
    public static string NormalizeTypeName(string? dbTypeName)
    {
        if (string.IsNullOrWhiteSpace(dbTypeName)) return "";
        var s = dbTypeName.Trim().ToLowerInvariant();
        var open = s.IndexOf('(');
        while (open >= 0)
        {
            var close = s.IndexOf(')', open);
            s = close < 0 ? s[..open] : s[..open] + s[(close + 1)..];
            open = s.IndexOf('(');
        }
        return string.Join(' ', s.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    private static string? KindByClrType(Type? t)
    {
        if (t is null || t == typeof(object)) return null;
        if (t == typeof(bool)) return ColumnKinds.Bool;
        if (t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort) || t == typeof(int)
            || t == typeof(uint) || t == typeof(long) || t == typeof(ulong) || t == typeof(BigInteger))
            return ColumnKinds.Int;
        if (t == typeof(float) || t == typeof(double) || t == typeof(Half)) return ColumnKinds.Float;
        if (t == typeof(decimal)) return ColumnKinds.Decimal;
        if (t == typeof(DateTime)) return ColumnKinds.DateTime;
        if (t == typeof(DateOnly)) return ColumnKinds.Date;
        if (t == typeof(TimeOnly) || t == typeof(TimeSpan)) return ColumnKinds.Time;
        if (t == typeof(DateTimeOffset)) return ColumnKinds.DateTimeOffset;
        if (t == typeof(Guid)) return ColumnKinds.Guid;
        if (t == typeof(byte[])) return ColumnKinds.Binary;
        if (t == typeof(string) || t == typeof(char[]) || t == typeof(char)) return ColumnKinds.String;
        if (typeof(IEnumerable).IsAssignableFrom(t)) return ColumnKinds.Other;
        return null;
    }

    /// <summary>SQLite type affinity rules (sqlite.org/datatype3.html §3.1), plus date/bool hints.</summary>
    private static string? SqliteAffinityKind(string name)
    {
        if (name.Contains("int", StringComparison.Ordinal)) return ColumnKinds.Int;
        if (name.Contains("char", StringComparison.Ordinal) || name.Contains("clob", StringComparison.Ordinal)
            || name.Contains("text", StringComparison.Ordinal)) return ColumnKinds.String;
        if (name.Contains("blob", StringComparison.Ordinal)) return ColumnKinds.Binary;
        if (name.Contains("real", StringComparison.Ordinal) || name.Contains("floa", StringComparison.Ordinal)
            || name.Contains("doub", StringComparison.Ordinal)) return ColumnKinds.Float;
        if (name.Contains("bool", StringComparison.Ordinal)) return ColumnKinds.Bool;
        if (name.Contains("datetime", StringComparison.Ordinal) || name.Contains("timestamp", StringComparison.Ordinal)) return ColumnKinds.DateTime;
        if (name.Contains("date", StringComparison.Ordinal)) return ColumnKinds.Date;
        if (name.Contains("time", StringComparison.Ordinal)) return ColumnKinds.Time;
        if (name.Contains("json", StringComparison.Ordinal)) return ColumnKinds.Json;
        if (name.Contains("num", StringComparison.Ordinal) || name.Contains("dec", StringComparison.Ordinal)) return ColumnKinds.Decimal;
        return null;
    }

    private static readonly Dictionary<string, string> KindByTypeName = new(StringComparer.Ordinal)
    {
        // integers
        ["int"] = ColumnKinds.Int, ["integer"] = ColumnKinds.Int, ["bigint"] = ColumnKinds.Int, ["smallint"] = ColumnKinds.Int,
        ["tinyint"] = ColumnKinds.Int, ["mediumint"] = ColumnKinds.Int, ["int2"] = ColumnKinds.Int, ["int4"] = ColumnKinds.Int,
        ["int8"] = ColumnKinds.Int, ["unsigned big int"] = ColumnKinds.Int, ["binary_integer"] = ColumnKinds.Int,
        ["pls_integer"] = ColumnKinds.Int, ["simple_integer"] = ColumnKinds.Int,
        // booleans
        ["bit"] = ColumnKinds.Bool, ["bool"] = ColumnKinds.Bool, ["boolean"] = ColumnKinds.Bool,
        // floating point
        ["real"] = ColumnKinds.Float, ["float"] = ColumnKinds.Float, ["double"] = ColumnKinds.Float,
        ["double precision"] = ColumnKinds.Float, ["binary_float"] = ColumnKinds.Float, ["binary_double"] = ColumnKinds.Float,
        // exact numerics
        ["decimal"] = ColumnKinds.Decimal, ["numeric"] = ColumnKinds.Decimal, ["number"] = ColumnKinds.Decimal,
        ["money"] = ColumnKinds.Decimal, ["smallmoney"] = ColumnKinds.Decimal, ["dec"] = ColumnKinds.Decimal,
        // text
        ["char"] = ColumnKinds.String, ["varchar"] = ColumnKinds.String, ["nchar"] = ColumnKinds.String,
        ["nvarchar"] = ColumnKinds.String, ["text"] = ColumnKinds.String, ["ntext"] = ColumnKinds.String,
        ["varchar2"] = ColumnKinds.String, ["nvarchar2"] = ColumnKinds.String, ["clob"] = ColumnKinds.String,
        ["nclob"] = ColumnKinds.String, ["long"] = ColumnKinds.String, ["string"] = ColumnKinds.String,
        ["character"] = ColumnKinds.String, ["varying character"] = ColumnKinds.String, ["native character"] = ColumnKinds.String,
        ["character varying"] = ColumnKinds.String, ["sysname"] = ColumnKinds.String, ["rowid"] = ColumnKinds.String,
        ["urowid"] = ColumnKinds.String, ["varchar_ignorecase"] = ColumnKinds.String,
        // dates and times
        ["date"] = ColumnKinds.Date, ["time"] = ColumnKinds.Time, ["datetime"] = ColumnKinds.DateTime,
        ["datetime2"] = ColumnKinds.DateTime, ["smalldatetime"] = ColumnKinds.DateTime,
        ["datetimeoffset"] = ColumnKinds.DateTimeOffset,
        // misc
        ["uniqueidentifier"] = ColumnKinds.Guid, ["uuid"] = ColumnKinds.Guid,
        ["binary"] = ColumnKinds.Binary, ["varbinary"] = ColumnKinds.Binary, ["image"] = ColumnKinds.Binary,
        ["blob"] = ColumnKinds.Binary, ["raw"] = ColumnKinds.Binary, ["long raw"] = ColumnKinds.Binary,
        ["bfile"] = ColumnKinds.Binary, ["rowversion"] = ColumnKinds.Binary,
        ["json"] = ColumnKinds.Json, ["xml"] = ColumnKinds.Xml, ["xmltype"] = ColumnKinds.Xml,
        ["ref cursor"] = ColumnKinds.Cursor, ["refcursor"] = ColumnKinds.Cursor, ["sys_refcursor"] = ColumnKinds.Cursor,
        ["sql_variant"] = ColumnKinds.Other, ["hierarchyid"] = ColumnKinds.Other, ["geography"] = ColumnKinds.Other,
        ["geometry"] = ColumnKinds.Other,
    };
}

/// <summary><see cref="ColumnInfo.Kind"/> tokens (identical to the wire values).</summary>
public static class ColumnKinds
{
    public const string Int = "int", Float = "float", Decimal = "decimal", String = "string", Bool = "bool",
        Date = "date", Time = "time", DateTime = "datetime", DateTimeOffset = "datetimeoffset", Guid = "guid",
        Binary = "binary", Json = "json", Xml = "xml", Cursor = "cursor", Other = "other";
}
