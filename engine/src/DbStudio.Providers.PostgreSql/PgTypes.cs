using System.Collections;
using System.Globalization;
using System.Numerics;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Npgsql;
using NpgsqlTypes;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// PostgreSQL data type names → <see cref="ColumnInfo.Kind"/> and reader values → wire values (docs/PLAN-PG.md 2.3).
/// Arrays travel as PostgreSQL array literals (<c>{1,2,NULL,"a b"}</c>), intervals in PostgreSQL's own text form
/// (<c>1 year 2 mons 3 days 04:05:06.5</c>), timestamptz as ISO with <c>+00:00</c>; types Npgsql cannot read become
/// their text form (or a placeholder) instead of failing the result set.
/// </summary>
public static class PgTypes
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>Lower-case type name without modifiers: "character varying(20)" → "character varying", "numeric(12,2)[]" → "numeric[]".</summary>
    public static string Normalize(string? dataTypeName)
    {
        if (string.IsNullOrWhiteSpace(dataTypeName)) return "";
        var s = dataTypeName.Trim().ToLowerInvariant();
        var sb = new StringBuilder(s.Length);
        var depth = 0;
        foreach (var ch in s)
        {
            if (ch == '(') { depth++; continue; }
            if (ch == ')') { depth = Math.Max(0, depth - 1); continue; }
            if (depth == 0) sb.Append(ch);
        }
        return string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries)).Replace(" []", "[]");
    }

    public static bool IsArray(string? dataTypeName) => Normalize(dataTypeName).EndsWith("[]", StringComparison.Ordinal) || (dataTypeName?.StartsWith('_') ?? false);

    /// <summary>Kind of a PostgreSQL column type (the name as Npgsql reports it, e.g. "timestamp with time zone", "integer[]", "public.order_status").</summary>
    public static string KindFor(string? dataTypeName, Type? clrType = null)
    {
        var name = Normalize(dataTypeName);
        if (name.EndsWith("[]", StringComparison.Ordinal)) return ColumnKinds.String;
        var bare = name.Contains('.') && !name.StartsWith("pg_catalog.", StringComparison.Ordinal) ? name : name.Replace("pg_catalog.", "");
        switch (bare)
        {
            case "smallint" or "integer" or "bigint" or "int2" or "int4" or "int8" or "oid" or "serial" or "bigserial" or "smallserial":
                return ColumnKinds.Int;
            case "numeric" or "decimal" or "money":
                return ColumnKinds.Decimal;
            case "real" or "double precision" or "float4" or "float8":
                return ColumnKinds.Float;
            case "boolean" or "bool":
                return ColumnKinds.Bool;
            case "uuid":
                return ColumnKinds.Guid;
            case "json" or "jsonb":
                return ColumnKinds.Json;
            case "xml":
                return ColumnKinds.Xml;
            case "bytea":
                return ColumnKinds.Binary;
            case "date":
                return ColumnKinds.Date;
            case "time without time zone" or "time" or "time with time zone" or "timetz":
                return ColumnKinds.Time;
            case "timestamp without time zone" or "timestamp":
                return ColumnKinds.DateTime;
            case "timestamp with time zone" or "timestamptz":
                return ColumnKinds.DateTimeOffset;
            case "text" or "character varying" or "varchar" or "character" or "char" or "bpchar" or "name" or "citext" or "\"char\""
                or "interval" or "inet" or "cidr" or "macaddr" or "macaddr8" or "bit" or "bit varying" or "varbit" or "hstore"
                or "tsvector" or "tsquery" or "pg_lsn" or "xid" or "xid8" or "cid" or "tid" or "regclass" or "regtype" or "regproc"
                or "regprocedure" or "regoper" or "regnamespace" or "regrole" or "record" or "refcursor" or "unknown" or "jsonpath"
                or "ltree" or "lquery":
                return ColumnKinds.String;
            case "point" or "line" or "lseg" or "box" or "path" or "polygon" or "circle"
                or "int4range" or "int8range" or "numrange" or "tsrange" or "tstzrange" or "daterange"
                or "int4multirange" or "int8multirange" or "nummultirange" or "tsmultirange" or "tstzmultirange" or "datemultirange"
                or "geometry" or "geography":
                return ColumnKinds.Other;
            case "void":
                return ColumnKinds.String;
        }
        // Enums, domains, composites and extension types: Npgsql reports their (qualified) name; enums read as text.
        if (clrType is null || clrType == typeof(object) || clrType == typeof(string)) return ColumnKinds.String;
        var byClr = ValueConverter.KindFor(clrType, null, Dialect.PgSql);
        return byClr == ColumnKinds.Other && typeof(IEnumerable).IsAssignableFrom(clrType) ? ColumnKinds.String : byClr;
    }

    /// <summary>
    /// Reads one cell as a wire value with PostgreSQL rendering. Never throws for type support issues: falls back to
    /// the text form, then to "(unsupported type …)".
    /// </summary>
    public static object? ReadValue(NpgsqlDataReader reader, int ordinal, ColumnInfo column, Action<string>? warn = null)
    {
        if (reader.IsDBNull(ordinal)) return null;
        var name = Normalize(column.DbType);
        try
        {
            switch (name)
            {
                case "date":
                    return ValueConverter.ToWire(reader.GetFieldValue<DateOnly>(ordinal));
                case "time without time zone" or "time":
                    return ValueConverter.ToWire(reader.GetFieldValue<TimeSpan>(ordinal));
                case "time with time zone" or "timetz":
                    return reader.GetFieldValue<DateTimeOffset>(ordinal).ToString("HH:mm:ss.FFFFFFFzzz", Inv);
                case "timestamp with time zone" or "timestamptz":
                    return ValueConverter.ToWire(reader.GetFieldValue<DateTimeOffset>(ordinal).ToUniversalTime());
                case "timestamp without time zone" or "timestamp":
                    return ValueConverter.ToWire(DateTime.SpecifyKind(reader.GetFieldValue<DateTime>(ordinal), DateTimeKind.Unspecified));
                case "interval":
                    return IntervalText(reader.GetFieldValue<NpgsqlInterval>(ordinal));
                case "numeric" or "decimal" or "money":
                    return ReadNumeric(reader, ordinal, column, warn);
                case "refcursor":
                    return reader.GetFieldValue<string>(ordinal);
                case "bit" or "bit varying" or "varbit":
                    return reader.GetValue(ordinal) switch
                    {
                        BitArray bits => BitText(bits),
                        bool b => b ? "1" : "0",
                        var other => ValueConverter.ToWire(other),
                    };
            }
            return ToWire(reader.GetValue(ordinal));
        }
        catch (Exception ex) when (ex is InvalidCastException or NotSupportedException or OverflowException or ArgumentException or InvalidOperationException)
        {
            try
            {
                return ValueConverter.Text(reader.GetFieldValue<string>(ordinal));
            }
            catch (Exception ex2) when (ex2 is InvalidCastException or NotSupportedException or ArgumentException or InvalidOperationException)
            {
                return $"(unsupported type {column.DbType})";
            }
        }
    }

    private static object? ReadNumeric(NpgsqlDataReader reader, int ordinal, ColumnInfo column, Action<string>? warn)
    {
        try
        {
            return reader.GetDecimal(ordinal).ToString(Inv);
        }
        catch (Exception ex) when (ex is OverflowException or InvalidCastException)
        {
            // Beyond System.Decimal (28-29 digits, NaN, ±Infinity): exact BigInteger when integral, else double.
            try
            {
                return reader.GetFieldValue<BigInteger>(ordinal).ToString(Inv);
            }
            catch (Exception ex2) when (ex2 is OverflowException or InvalidCastException or ArgumentException)
            {
                var d = reader.GetDouble(ordinal);
                warn?.Invoke($"Column {column.Name}: a numeric value exceeds 28 digits and is shown as a double (precision may be lost).");
                return double.IsFinite(d) ? d.ToString("R", Inv) : ValueConverter.ToWire(d);
            }
        }
    }

    /// <summary>Wire value of an arbitrary Npgsql value (arrays, ranges, geometry, network types, bit strings, hstore, records).</summary>
    public static object? ToWire(object? value) => value switch
    {
        null or DBNull => null,
        string or byte[] => ValueConverter.ToWire(value),
        NpgsqlInterval iv => IntervalText(iv),
        BitArray bits => BitText(bits),
        Array array => ValueConverter.Text(ArrayLiteral(array)),
        IDictionary<string, string?> hstore => ValueConverter.Text(HstoreText(hstore)),
        DateTimeOffset dto => ValueConverter.ToWire(dto.ToUniversalTime()),
        DateTime dt when dt.Kind == DateTimeKind.Utc => ValueConverter.ToWire(new DateTimeOffset(dt)),
        DateTime dt => ValueConverter.ToWire(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified)),
        _ => ValueConverter.ToWire(value),
    };

    /// <summary>PostgreSQL interval output (postgres style): "1 year 2 mons 3 days 04:05:06.5", "-1 days", "00:00:00".</summary>
    public static string IntervalText(NpgsqlInterval iv)
    {
        var parts = new List<string>();
        var years = iv.Months / 12;
        var months = iv.Months % 12;
        if (years != 0) parts.Add($"{years} year{(years == 1 ? "" : "s")}");
        if (months != 0) parts.Add($"{months} mon{(months == 1 ? "" : "s")}");
        if (iv.Days != 0) parts.Add($"{iv.Days} day{(iv.Days == 1 ? "" : "s")}");
        var micros = iv.Time;
        if (micros != 0 || parts.Count == 0)
        {
            var negative = micros < 0;
            var abs = negative ? -(decimal)micros : micros;
            var totalSeconds = Math.Floor(abs / 1_000_000m);
            var frac = abs - totalSeconds * 1_000_000m;
            var hours = Math.Floor(totalSeconds / 3600m);
            var minutes = Math.Floor((totalSeconds - hours * 3600m) / 60m);
            var seconds = totalSeconds - hours * 3600m - minutes * 60m;
            var text = $"{hours.ToString("00", Inv)}:{minutes.ToString("00", Inv)}:{seconds.ToString("00", Inv)}";
            if (frac > 0) text += "." + ((long)frac).ToString("000000", Inv).TrimEnd('0');
            parts.Add((negative ? "-" : "") + text);
        }
        return string.Join(' ', parts);
    }

    /// <summary>PostgreSQL array literal: <c>{1,2,NULL,"a b"}</c>, multi-dimensional arrays nest (<c>{{1,2},{3,4}}</c>).</summary>
    public static string ArrayLiteral(Array array)
    {
        var sb = new StringBuilder();
        if (array.Rank <= 1)
        {
            AppendList(sb, array.Cast<object?>());
            return sb.ToString();
        }
        AppendDimension(sb, array, 0, new int[array.Rank]);
        return sb.ToString();
    }

    private static void AppendDimension(StringBuilder sb, Array array, int dim, int[] index)
    {
        sb.Append('{');
        var lower = array.GetLowerBound(dim);
        var upper = array.GetUpperBound(dim);
        for (var i = lower; i <= upper; i++)
        {
            if (i > lower) sb.Append(',');
            index[dim] = i;
            if (dim == array.Rank - 1) AppendElement(sb, array.GetValue(index));
            else AppendDimension(sb, array, dim + 1, index);
        }
        sb.Append('}');
    }

    private static void AppendList(StringBuilder sb, IEnumerable<object?> items)
    {
        sb.Append('{');
        var first = true;
        foreach (var item in items)
        {
            if (!first) sb.Append(',');
            first = false;
            AppendElement(sb, item);
        }
        sb.Append('}');
    }

    private static void AppendElement(StringBuilder sb, object? item)
    {
        switch (item)
        {
            case null or DBNull:
                sb.Append("NULL");
                return;
            case byte[] bytes:
                sb.Append("\"\\\\x").Append(Convert.ToHexStringLower(bytes)).Append('"');
                return;
            case Array nested:
                sb.Append(ArrayLiteral(nested));
                return;
            case bool b:
                sb.Append(b ? 't' : 'f');
                return;
        }
        var text = ElementText(item);
        if (NeedsArrayQuotes(text)) sb.Append('"').Append(text.Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
        else sb.Append(text);
    }

    private static string ElementText(object item) => item switch
    {
        string s => s,
        NpgsqlInterval iv => IntervalText(iv),
        BitArray bits => BitText(bits),
        DateTimeOffset dto => dto.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss.FFFFFFFzzz", Inv),
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", Inv).TrimEnd('.'),
        DateOnly d => d.ToString("yyyy-MM-dd", Inv),
        TimeSpan ts => ValueConverter.FormatTimeSpan(ts),
        TimeOnly t => t.ToString("HH:mm:ss.FFFFFFF", Inv).TrimEnd('.'),
        double d => d.ToString("R", Inv),
        float f => f.ToString("R", Inv),
        IFormattable f => f.ToString(null, Inv),
        _ => item.ToString() ?? "",
    };

    private static bool NeedsArrayQuotes(string text) =>
        text.Length == 0 || text.Equals("NULL", StringComparison.OrdinalIgnoreCase)
        || text.Any(ch => ch is '{' or '}' or ',' or '"' or '\\' || char.IsWhiteSpace(ch));

    /// <summary>bit/varbit as '0'/'1' digits.</summary>
    public static string BitText(BitArray bits)
    {
        var chars = new char[bits.Length];
        for (var i = 0; i < bits.Length; i++) chars[i] = bits[i] ? '1' : '0';
        return new string(chars);
    }

    /// <summary>hstore output: <c>"k"=>"v", "n"=>NULL</c>.</summary>
    public static string HstoreText(IEnumerable<KeyValuePair<string, string?>> pairs) =>
        string.Join(", ", pairs.Select(kv => $"\"{Escape(kv.Key)}\"=>{(kv.Value is null ? "NULL" : "\"" + Escape(kv.Value) + "\"")}"));

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>The designer/catalog form of a type: "character varying(20)" → "varchar(20)", "timestamp with time zone" → "timestamptz".</summary>
    public static string ShortTypeName(string formatType)
    {
        var t = formatType.Trim();
        static string Replace(string s, string from, string to) =>
            s.StartsWith(from, StringComparison.Ordinal) ? to + s[from.Length..] : s;
        // "timestamp(3) with time zone" → "timestamptz(3)"
        foreach (var (head, tail, shortName) in new[]
                 {
                     ("timestamp", " with time zone", "timestamptz"), ("timestamp", " without time zone", "timestamp"),
                     ("time", " with time zone", "timetz"), ("time", " without time zone", "time"),
                 })
        {
            if (!t.StartsWith(head, StringComparison.Ordinal)) continue;
            var arr = t.EndsWith("[]", StringComparison.Ordinal) ? "[]" : "";
            var body = arr.Length > 0 ? t[..^2] : t;
            if (!body.EndsWith(tail, StringComparison.Ordinal)) continue;
            var middle = body[head.Length..^tail.Length]; // "" or "(3)"
            if (middle.Length > 0 && !(middle.StartsWith('(') && middle.EndsWith(')'))) continue;
            return shortName + middle + arr;
        }
        t = Replace(t, "character varying", "varchar");
        t = Replace(t, "bit varying", "varbit");
        if (t.StartsWith("character", StringComparison.Ordinal) && (t.Length == 9 || t[9] is '(' or '[')) t = "char" + t[9..];
        return t;
    }
}
