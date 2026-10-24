using System.Data.Common;
using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// MySQL / MariaDB result types (plan-batch3 WP-MY): unsigned integers (BIGINT UNSIGNED above 2^53 as text), DECIMAL at
/// full precision (as text, through <see cref="MySqlDecimal"/>), BIT(n) as a bit string, YEAR as an int, ENUM/SET as
/// text, JSON as json, spatial values as WKB binary, DATE as a date, DATETIME/TIMESTAMP as datetimes, TIME as a duration,
/// and zero dates (0000-00-00) as NULL with a warning.
/// </summary>
public static class MySqlTypes
{
    public const string ZeroDateWarning = "Zero dates (0000-00-00) cannot be represented and are shown as NULL.";

    /// <summary>"INT UNSIGNED" → "int", "VARCHAR(20)" → "varchar".</summary>
    public static string BaseName(string? dbType)
    {
        var n = ValueConverter.NormalizeTypeName(dbType);
        foreach (var suffix in new[] { " unsigned zerofill", " unsigned", " zerofill", " signed" })
            if (n.EndsWith(suffix, StringComparison.Ordinal)) n = n[..^suffix.Length];
        return n;
    }

    private static readonly HashSet<string> Spatial = new(StringComparer.Ordinal)
    {
        "geometry", "point", "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection", "geomcollection",
    };

    public static string KindFor(string? dbType, Type? clr)
    {
        var n = BaseName(dbType);
        if (Spatial.Contains(n) || n is "vector") return ColumnKinds.Binary;
        return n switch
        {
            "bit" => ColumnKinds.String,
            "year" => ColumnKinds.Int,
            "enum" or "set" => ColumnKinds.String,
            "json" => ColumnKinds.Json,
            "tinyint" or "smallint" or "mediumint" or "int" or "integer" or "bigint" => ColumnKinds.Int,
            "decimal" or "numeric" or "dec" or "fixed" or "newdecimal" => ColumnKinds.Decimal,
            "float" or "double" or "real" or "double precision" => ColumnKinds.Float,
            "date" or "newdate" => ColumnKinds.Date,
            "datetime" or "timestamp" => ColumnKinds.DateTime,
            "time" => ColumnKinds.Time,
            "char" or "varchar" or "tinytext" or "text" or "mediumtext" or "longtext" or "inet4" or "inet6" or "uuid" or "string" or "var_string" => ColumnKinds.String,
            "binary" or "varbinary" or "tinyblob" or "blob" or "mediumblob" or "longblob" => ColumnKinds.Binary,
            "null" => ColumnKinds.Other,
            _ => ValueConverter.KindFor(clr, dbType, Dialect.MySql),
        };
    }

    /// <summary>Reads one cell as a wire value; <paramref name="warn"/> collects per-batch warnings (zero dates).</summary>
    public static object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column, Action<string>? warn)
    {
        if (reader.IsDBNull(ordinal)) return null;
        var my = reader as MySqlDataReader ?? (reader as MySqlStatementReader)?.Current;
        switch (column.Kind)
        {
            case ColumnKinds.Decimal when my is not null:
                try { return my.GetMySqlDecimal(ordinal).ToString(); }
                catch (Exception ex) when (ex is InvalidCastException or FormatException) { break; }
            case ColumnKinds.Date:
            {
                var v = reader.GetValue(ordinal);
                if (v is DateTime d)
                {
                    if (d == DateTime.MinValue) { warn?.Invoke(ZeroDateWarning); return null; }
                    return DateOnly.FromDateTime(d).ToString(ValueConverter.DateFormat, CultureInfo.InvariantCulture);
                }
                return ValueConverter.ToWire(v);
            }
            case ColumnKinds.DateTime:
            {
                var v = reader.GetValue(ordinal);
                if (v is DateTime dt && dt == DateTime.MinValue) { warn?.Invoke(ZeroDateWarning); return null; }
                return ValueConverter.ToWire(v);
            }
        }
        object value;
        try
        {
            value = reader.GetValue(ordinal);
        }
        catch (Exception ex) when (ex is OverflowException or InvalidCastException or MySqlConversionException or FormatException)
        {
            // e.g. a DECIMAL(65,30) beyond System.Decimal on a reader without GetMySqlDecimal
            return my is not null ? Encoding.UTF8.GetString(RawBytes(my, ordinal)) : null;
        }
        return Convert(value, column);
    }

    private static byte[] RawBytes(MySqlDataReader r, int ordinal)
    {
        var len = r.GetBytes(ordinal, 0, null, 0, 0);
        var buf = new byte[len];
        r.GetBytes(ordinal, 0, buf, 0, (int)len);
        return buf;
    }

    /// <summary>Provider value → wire value with the MySQL rules (BIT(n) → bit string, geometry → WKB).</summary>
    public static object? Convert(object? value, ColumnInfo column)
    {
        switch (value)
        {
            case null or DBNull:
                return null;
            case ulong bits when BaseName(column.DbType) == "bit":
                return BitString(bits, column.Size);
            case MySqlGeometry g:
                return new BinaryValue(g.Value.Length > 4 ? g.Value[4..] : g.Value);
            case MySqlDecimal md:
                return md.ToString();
            case MySqlDateTime mdt:
                return mdt.IsValidDateTime ? ValueConverter.ToWire(mdt.GetDateTime()) : null;
            default:
                return ValueConverter.ToWire(value);
        }
    }

    /// <summary>A BIT(n) value as its binary digits, zero-padded to the column width ("1010" for b'1010' in BIT(4)).</summary>
    public static string BitString(ulong bits, int? width)
    {
        var s = System.Convert.ToString((long)bits, 2);
        var w = width is > 0 and <= 64 ? width.Value : 1;
        return s.Length >= w ? s : new string('0', w - s.Length) + s;
    }
}
