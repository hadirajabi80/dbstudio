using System.Data.Common;
using System.Globalization;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using Oracle.ManagedDataAccess.Client;
using Oracle.ManagedDataAccess.Types;

namespace DbStudio.Providers.Oracle.Params;

/// <summary>
/// Oracle parameter binding (docs/PLAN-M1.5.md A2): <c>:name</c> / <c>:1</c> host binds (outside strings, comments
/// and trigger bodies) bind by name (<c>BindByName = true</c>). A <c>refcursor</c> param is an output
/// <see cref="OracleDbType.RefCursor"/> whose rows are returned as an extra result set. Typed binds: int → NUMBER
/// (Int64), decimal → NUMBER, float → BINARY_DOUBLE, bool → NUMBER 1/0, date → DATE, datetime → TIMESTAMP,
/// datetimeoffset → TIMESTAMP WITH TIME ZONE, time → INTERVAL DAY TO SECOND, guid → RAW(16) (big-endian, like SYS_GUID),
/// binary → RAW/BLOB, string → VARCHAR2.
/// </summary>
public sealed class OracleParamBinder : ParamBinderBase
{
    public static readonly OracleParamBinder Instance = new();

    public override string ProviderId => "oracle";

    public override IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql)
    {
        var tokens = OracleSqlText.Tokenize(sql).ToList();
        if (OracleSqlText.FindCreatedUnit(sql) is { ObjectType: "TRIGGER" }) return [];
        var result = new List<ParamPlaceholder>();
        foreach (var t in tokens)
        {
            if (t.Kind != OracleTokenKind.Bind) continue;
            result.Add(new ParamPlaceholder(BindName(t.Text), t.Offset));
        }
        return result;
    }

    /// <summary>":x" → "x", ":\"Mixed\"" → "Mixed".</summary>
    public static string BindName(string bindText)
    {
        var name = bindText.StartsWith(':') ? bindText[1..] : bindText;
        return name.Length >= 2 && name[0] == '"' && name[^1] == '"' ? name[1..^1] : name;
    }

    protected override DbParameter CreateParameter(DbCommand command, QueryParam p, string? placeholderName)
    {
        var parameter = new OracleParameter { ParameterName = placeholderName ?? p.BareName, Direction = DirectionOf(p) };
        if (p.Kind == ParamKinds.RefCursor)
        {
            parameter.OracleDbType = OracleDbType.RefCursor;
            parameter.Direction = System.Data.ParameterDirection.Output;
            return parameter;
        }
        var value = p.EffectiveDirection == ParamDirections.Out ? null : ParamValues.ToClr(p);
        switch (p.Kind)
        {
            case ParamKinds.Int:
                if (p.IsOutput) { parameter.OracleDbType = OracleDbType.Decimal; parameter.Value = value is long lo ? (decimal)lo : DBNull.Value; }
                else { parameter.OracleDbType = OracleDbType.Int64; parameter.Value = value ?? DBNull.Value; }
                break;
            case ParamKinds.Decimal:
                parameter.OracleDbType = OracleDbType.Decimal;
                // NUMBER holds 38 digits, System.Decimal only 28-29: a longer value (1/3 read back from the grid) is bound
                // as an OracleDecimal from its text, so it is neither rounded nor fails the "verify unchanged" comparison.
                parameter.Value = p.EffectiveDirection != ParamDirections.Out && ExactDecimal(p) is { } exact ? exact : value ?? DBNull.Value;
                break;
            case ParamKinds.Float:
                parameter.OracleDbType = OracleDbType.BinaryDouble;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Bool:
                parameter.OracleDbType = OracleDbType.Int32;
                parameter.Value = value is bool b ? (b ? 1 : 0) : DBNull.Value;
                break;
            case ParamKinds.Date:
                parameter.OracleDbType = OracleDbType.Date;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.DateTime:
                parameter.OracleDbType = OracleDbType.TimeStamp;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.DateTimeOffset:
                parameter.OracleDbType = OracleDbType.TimeStampTZ;
                parameter.Value = value is DateTimeOffset dto
                    ? new OracleTimeStampTZ(dto.DateTime, FormatOffset(dto.Offset))
                    : DBNull.Value;
                break;
            case ParamKinds.Time:
                parameter.OracleDbType = OracleDbType.IntervalDS;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Guid:
                parameter.OracleDbType = OracleDbType.Raw;
                parameter.Size = 16;
                parameter.Value = value is Guid g ? g.ToByteArray(bigEndian: true) : DBNull.Value;
                break;
            case ParamKinds.Binary:
                var bytes = value as byte[];
                parameter.OracleDbType = bytes is { Length: > 2000 } ? OracleDbType.Blob : OracleDbType.Raw;
                if (p.IsOutput) parameter.Size = OutSize(p, 2000);
                parameter.Value = (object?)bytes ?? DBNull.Value;
                break;
            default: // string, null
                parameter.OracleDbType = value is string { Length: > 32767 } ? OracleDbType.Clob : OracleDbType.Varchar2;
                if (p.IsOutput) parameter.Size = OutSize(p, 4000);
                parameter.Value = value ?? DBNull.Value;
                break;
        }
        return parameter;
    }

    /// <summary>
    /// The value of a decimal param as an <see cref="OracleDecimal"/> when System.Decimal would lose digits of it (more than
    /// 28 significant digits, or an exponent outside its range); null when System.Decimal holds it exactly.
    /// </summary>
    public static OracleDecimal? ExactDecimal(QueryParam p)
    {
        if (p.Value is not System.Text.Json.Nodes.JsonValue jv) return null;
        var text = (jv.GetValueKind() == System.Text.Json.JsonValueKind.String ? jv.GetValue<string>() : jv.ToJsonString()).Trim();
        if (text.Length == 0) return null;
        if (decimal.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var m) && SameNumber(m, text)) return null;
        try
        {
            return ParseExact(NormalizeNumberText(text));
        }
        catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentException or OracleTypeException)
        {
            return null; // ParamValues.ToClr reports values that are not numbers
        }
    }

    /// <summary>
    /// True when <paramref name="m"/> keeps every significant digit written in <paramref name="text"/>: System.Decimal
    /// rounds after 28-29 digits (and turns 1E-40 into 0) without failing. The magnitude cannot differ otherwise (an
    /// overflow fails TryParse), so comparing the significant digits is enough.
    /// </summary>
    private static bool SameNumber(decimal m, string text) =>
        SignificantDigits(text) == SignificantDigits(m.ToString(CultureInfo.InvariantCulture));

    /// <summary>"-001.2300E+5" → "123": the mantissa digits without sign, point, leading and trailing zeros.</summary>
    private static string SignificantDigits(string text)
    {
        var e = text.IndexOfAny(['e', 'E']);
        var mantissa = e < 0 ? text : text[..e];
        return new string(mantissa.Where(char.IsAsciiDigit).ToArray()).Trim('0');
    }

    /// <summary>
    /// Plain decimal text → OracleDecimal with all of its digits. A NUMBER keeps up to 40 significant digits (1/3 reads
    /// back as 0.3333…3 with 40 threes) but OracleDecimal.Parse fails above 38, so the digits are parsed in chunks and
    /// combined with OracleDecimal arithmetic (exact: only powers of ten and integer chunks are involved).
    /// </summary>
    public static OracleDecimal ParseExact(string plain)
    {
        var t = plain.Trim();
        var negative = t.StartsWith('-');
        t = t.TrimStart('-', '+');
        var point = t.IndexOf('.');
        var scale = point < 0 ? 0 : t.Length - point - 1;
        var digits = (point < 0 ? t : t.Remove(point, 1)).TrimStart('0');
        if (digits.Length == 0) return OracleDecimal.Zero;
        if (digits.Any(c => !char.IsAsciiDigit(c))) throw new FormatException($"'{plain}' is not a number.");
        var value = OracleDecimal.Zero;
        for (var i = 0; i < digits.Length; i += 18)
        {
            var chunk = digits.Substring(i, Math.Min(18, digits.Length - i));
            value = OracleDecimal.Add(OracleDecimal.Multiply(value, Pow10(chunk.Length)), OracleDecimal.Parse(chunk));
        }
        if (scale > 0) value = OracleDecimal.Multiply(value, OracleDecimal.Parse("0." + new string('0', scale - 1) + "1"));
        return negative ? OracleDecimal.Negate(value) : value;

        static OracleDecimal Pow10(int n) => OracleDecimal.Parse("1" + new string('0', n));
    }

    /// <summary>OracleDecimal.Parse takes plain decimal text: "1.5E+3" is expanded to "1500".</summary>
    private static string NormalizeNumberText(string text)
    {
        var e = text.IndexOfAny(['e', 'E']);
        if (e < 0) return text;
        var exponent = int.Parse(text[(e + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var mantissa = text[..e];
        var negative = mantissa.StartsWith('-');
        mantissa = mantissa.TrimStart('-', '+');
        var point = mantissa.IndexOf('.');
        var digits = mantissa.Replace(".", "", StringComparison.Ordinal);
        var intLen = (point < 0 ? mantissa.Length : point) + exponent;
        string result;
        if (intLen <= 0) result = "0." + new string('0', -intLen) + digits;
        else if (intLen >= digits.Length) result = digits + new string('0', intLen - digits.Length);
        else result = digits[..intLen] + "." + digits[intLen..];
        return (negative ? "-" : "") + result;
    }

    private static string FormatOffset(TimeSpan offset) =>
        (offset < TimeSpan.Zero ? "-" : "+") + offset.Duration().ToString(@"hh\:mm", CultureInfo.InvariantCulture);

    public override object? ReadOutput(DbParameter parameter) => ToWire(parameter.Value);

    /// <summary>Oracle provider types → wire values.</summary>
    public static object? ToWire(object? value) => value switch
    {
        null or DBNull => null,
        INullable { IsNull: true } => null,
        OracleDecimal d => d.ToString(),
        OracleString s => ValueConverter.Text(s.Value),
        OracleDate d => ValueConverter.ToWire(d.Value),
        OracleTimeStamp t => ValueConverter.ToWire(t.Value),
        OracleTimeStampLTZ t => ValueConverter.ToWire(t.Value),
        OracleTimeStampTZ tz => ValueConverter.ToWire(new DateTimeOffset(DateTime.SpecifyKind(tz.Value, DateTimeKind.Unspecified), tz.GetTimeZoneOffset())),
        OracleIntervalDS ds => ds.ToString(),
        OracleIntervalYM ym => ym.ToString(),
        OracleBinary b => ValueConverter.ToWire(b.Value),
        OracleClob c => ValueConverter.Text(c.Value),
        OracleBlob bl => ValueConverter.ToWire(bl.Value),
        OracleRefCursor => CursorValue.Instance,
        _ => ParamValues.ToWire(value),
    };
}
