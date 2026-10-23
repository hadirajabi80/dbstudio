using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Snowflake type mapping. Result columns: the driver's <c>GetDataTypeName</c> (FIXED, REAL, TEXT, BINARY, BOOLEAN, DATE,
/// TIME, TIMESTAMP_NTZ/LTZ/TZ, VARIANT, OBJECT, ARRAY, MAP, GEOGRAPHY, GEOMETRY, VECTOR, DECFLOAT) plus precision/scale
/// become wire kinds and SQL type names; catalog columns (<c>SHOW COLUMNS … data_type</c> JSON) become SQL type text.
/// <list type="bullet">
/// <item>NUMBER(p, 0) → int (values beyond ±2^53 travel as exact strings); NUMBER(p, s&gt;0) and DECFLOAT → decimal (string);</item>
/// <item>FLOAT → float; VARCHAR → string; BINARY → binary; BOOLEAN → bool; DATE → date; TIME → time;</item>
/// <item>TIMESTAMP_NTZ → datetime; TIMESTAMP_LTZ / TIMESTAMP_TZ → datetimeoffset;</item>
/// <item>VARIANT / OBJECT / ARRAY / MAP / GEOGRAPHY / GEOMETRY / VECTOR → json (their JSON text).</item>
/// </list>
/// </summary>
public static class SnowflakeTypes
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>VARCHAR without a length is VARCHAR(16777216) (the maximum).</summary>
    public const long MaxVarcharLength = 16_777_216;
    public const long MaxBinaryLength = 8_388_608;

    public static string KindFor(string? sfType, int? precision, int? scale)
    {
        switch ((sfType ?? "").Trim().ToUpperInvariant())
        {
            case "FIXED":
            case "NUMBER":
            case "NUMERIC":
            case "DECIMAL":
                return (scale ?? 0) == 0 ? ColumnKinds.Int : ColumnKinds.Decimal;
            case "INT": case "INTEGER": case "BIGINT": case "SMALLINT": case "TINYINT": case "BYTEINT":
                return ColumnKinds.Int;
            case "DECFLOAT":
                return ColumnKinds.Decimal;
            case "REAL": case "FLOAT": case "FLOAT4": case "FLOAT8": case "DOUBLE": case "DOUBLE PRECISION":
                return ColumnKinds.Float;
            case "TEXT": case "VARCHAR": case "STRING": case "CHAR": case "CHARACTER": case "NCHAR": case "NVARCHAR":
                return ColumnKinds.String;
            case "BINARY": case "VARBINARY":
                return ColumnKinds.Binary;
            case "BOOLEAN":
                return ColumnKinds.Bool;
            case "DATE":
                return ColumnKinds.Date;
            case "TIME":
                return ColumnKinds.Time;
            case "TIMESTAMP_NTZ": case "DATETIME": case "TIMESTAMP":
                return ColumnKinds.DateTime;
            case "TIMESTAMP_LTZ": case "TIMESTAMP_TZ":
                return ColumnKinds.DateTimeOffset;
            case "VARIANT": case "OBJECT": case "ARRAY": case "MAP": case "GEOGRAPHY": case "GEOMETRY": case "VECTOR":
                return ColumnKinds.Json;
            default:
                return ColumnKinds.Other;
        }
    }

    /// <summary>SQL spelling of a result column type: FIXED(38,0) → NUMBER(38,0), TEXT(100) → VARCHAR(100).</summary>
    public static string SqlName(string? sfType, long? length, int? precision, int? scale)
    {
        var t = (sfType ?? "").Trim().ToUpperInvariant();
        return t switch
        {
            "FIXED" => precision is > 0 ? $"NUMBER({precision.Value.ToString(Inv)},{(scale ?? 0).ToString(Inv)})" : "NUMBER",
            "REAL" => "FLOAT",
            "TEXT" => length is > 0 and < MaxVarcharLength ? $"VARCHAR({length.Value.ToString(Inv)})" : "VARCHAR",
            "BINARY" => length is > 0 and < MaxBinaryLength ? $"BINARY({length.Value.ToString(Inv)})" : "BINARY",
            "TIME" or "TIMESTAMP_NTZ" or "TIMESTAMP_LTZ" or "TIMESTAMP_TZ" => scale is >= 0 and < 9 ? $"{t}({scale.Value.ToString(Inv)})" : t,
            "" => "UNKNOWN",
            _ => t,
        };
    }

    /// <summary>
    /// <c>SHOW COLUMNS</c> data_type JSON (<c>{"type":"FIXED","precision":38,"scale":0,"nullable":true}</c>) → type text
    /// ("NUMBER(38,0)") and nullability. Plain type text (DESCRIBE) is returned as is.
    /// </summary>
    public static (string Type, bool Nullable) FromShowColumnsJson(string? dataType)
    {
        if (string.IsNullOrWhiteSpace(dataType)) return ("VARCHAR", true);
        var s = dataType.Trim();
        if (!s.StartsWith('{')) return (s, true);
        try
        {
            using var doc = JsonDocument.Parse(s);
            var root = doc.RootElement;
            var type = Str(root, "type") ?? "VARCHAR";
            var nullable = !root.TryGetProperty("nullable", out var n) || n.ValueKind != JsonValueKind.False;
            int? precision = Int(root, "precision"), scale = Int(root, "scale");
            long? length = Long(root, "length");
            var text = type.ToUpperInvariant() switch
            {
                "FIXED" => $"NUMBER({(precision ?? 38).ToString(Inv)},{(scale ?? 0).ToString(Inv)})",
                "REAL" => "FLOAT",
                "TEXT" => root.TryGetProperty("fixed", out var f) && f.ValueKind == JsonValueKind.True
                    ? $"CHAR({(length ?? 1).ToString(Inv)})"
                    : length is > 0 and < MaxVarcharLength ? $"VARCHAR({length.Value.ToString(Inv)})" : "VARCHAR",
                "BINARY" => length is > 0 and < MaxBinaryLength ? $"BINARY({length.Value.ToString(Inv)})" : "BINARY",
                "TIME" or "TIMESTAMP_NTZ" or "TIMESTAMP_LTZ" or "TIMESTAMP_TZ" =>
                    scale is >= 0 and < 9 ? $"{type.ToUpperInvariant()}({scale.Value.ToString(Inv)})" : type.ToUpperInvariant(),
                "VECTOR" => $"VECTOR({Str(root, "vectorElementType") ?? "FLOAT"}, {(Int(root, "dimension") ?? 0).ToString(Inv)})",
                var other => other,
            };
            return (text, nullable);
        }
        catch (JsonException)
        {
            return (s, true);
        }
    }

    private static string? Str(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static int? Int(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
    private static long? Long(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var i) ? i : null;

    /// <summary>Base type for comparisons: "NUMBER(38,0)" → "NUMBER", "STRING" → "VARCHAR", "INT" → "NUMBER".</summary>
    public static string Normalize(string type)
    {
        var t = type.Trim().ToUpperInvariant();
        var paren = t.IndexOf('(');
        if (paren >= 0) t = t[..paren].Trim();
        return t switch
        {
            "INT" or "INTEGER" or "BIGINT" or "SMALLINT" or "TINYINT" or "BYTEINT" or "DECIMAL" or "NUMERIC" => "NUMBER",
            "STRING" or "TEXT" or "CHARACTER VARYING" or "NVARCHAR" or "NVARCHAR2" or "CHAR VARYING" or "NCHAR VARYING" => "VARCHAR",
            "CHARACTER" or "NCHAR" => "CHAR",
            "FLOAT4" or "FLOAT8" or "DOUBLE" or "DOUBLE PRECISION" or "REAL" => "FLOAT",
            "VARBINARY" => "BINARY",
            "DATETIME" => "TIMESTAMP_NTZ",
            _ => t,
        };
    }

    /// <summary>Reads one result cell as a wire value.</summary>
    public static object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column)
    {
        if (reader.IsDBNull(ordinal)) return null;
        switch (column.Kind)
        {
            case ColumnKinds.Int:
            {
                object raw;
                try { raw = reader.GetValue(ordinal); }
                catch (OverflowException) { return reader.GetString(ordinal); }
                return raw switch
                {
                    decimal d when d >= long.MinValue && d <= long.MaxValue && decimal.Truncate(d) == d => ValueConverter.ToWire((long)d),
                    decimal d => d.ToString(Inv),
                    string text => text,
                    var v => ValueConverter.ToWire(v),
                };
            }
            case ColumnKinds.Decimal:
            {
                try
                {
                    return reader.GetValue(ordinal) switch
                    {
                        decimal d => d.ToString(Inv),
                        var v => ValueConverter.ToWire(v),
                    };
                }
                catch (OverflowException)
                {
                    return reader.GetString(ordinal);
                }
            }
            case ColumnKinds.Date:
                return reader.GetValue(ordinal) switch
                {
                    DateTime dt => dt.ToString(ValueConverter.DateFormat, Inv),
                    var v => ValueConverter.ToWire(v),
                };
            case ColumnKinds.Time:
                return reader.GetValue(ordinal) switch
                {
                    DateTime dt => TimeOnly.FromDateTime(dt).ToString(ValueConverter.TimeFormat, Inv),
                    TimeSpan ts => ValueConverter.ToWire(ts),
                    var v => ValueConverter.ToWire(v),
                };
            case ColumnKinds.Json:
                return ValueConverter.ToWire(reader.GetValue(ordinal) is string json ? json : reader.GetString(ordinal));
            default:
                try
                {
                    return ValueConverter.ToWire(reader.GetValue(ordinal));
                }
                catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException)
                {
                    return reader.GetString(ordinal);
                }
        }
    }

    /// <summary>Column descriptors from the driver's schema table (ColumnSize, NumericPrecision, NumericScale, AllowDBNull, ProviderType).</summary>
    public static ColumnInfo[] Describe(DbDataReader reader)
    {
        DataTable? schema = null;
        try { schema = reader.GetSchemaTable(); } catch (Exception) { /* not available */ }
        var columns = new ColumnInfo[reader.FieldCount];
        for (var i = 0; i < columns.Length; i++)
        {
            var row = schema is not null && i < schema.Rows.Count ? schema.Rows[i] : null;
            string name;
            try { name = reader.GetName(i); } catch { name = $"COLUMN{i + 1}"; }
            string sfType;
            try { sfType = reader.GetDataTypeName(i); } catch { sfType = Cell(row, "ProviderType") ?? ""; }
            var length = LongCell(row, "ColumnSize");
            var precision = (int?)LongCell(row, "NumericPrecision");
            var scale = (int?)LongCell(row, "NumericScale");
            var nullable = row is null || row.Table.Columns.Contains("AllowDBNull") is false || row["AllowDBNull"] is not false;
            var kind = KindFor(sfType, precision, scale);
            columns[i] = new ColumnInfo(
                Name: name,
                Ordinal: i,
                DbType: SqlName(sfType, length, precision, scale),
                Kind: kind,
                Nullable: nullable,
                Size: kind is ColumnKinds.String or ColumnKinds.Binary && length is > 0 and <= int.MaxValue ? (int)length.Value : null,
                Precision: kind is ColumnKinds.Decimal && precision is > 0 ? precision : null,
                Scale: kind is ColumnKinds.Decimal or ColumnKinds.DateTime or ColumnKinds.DateTimeOffset or ColumnKinds.Time && scale is >= 0 ? scale : null);
        }
        return columns;
    }

    private static string? Cell(DataRow? row, string column) =>
        row is null || !row.Table.Columns.Contains(column) || row[column] is DBNull ? null : Convert.ToString(row[column], Inv);

    private static long? LongCell(DataRow? row, string column)
    {
        if (row is null || !row.Table.Columns.Contains(column) || row[column] is DBNull or null) return null;
        try { return Convert.ToInt64(row[column], Inv); } catch (Exception) { return null; }
    }
}
