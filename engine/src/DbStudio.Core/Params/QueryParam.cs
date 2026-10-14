using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using DbStudio.Core.Services;

namespace DbStudio.Core.Params;

/// <summary>
/// One bind value of <c>ExecuteRequest.params</c> (docs/PLAN-M1.5.md 3.8, ui/src/api/types.ts <c>QueryParam</c>).
/// </summary>
/// <param name="Name">Without prefix (<c>id</c> for <c>@id</c>/<c>:id</c>); numeric ("1") = positional. A leading @/:/$ is tolerated.</param>
/// <param name="Kind">See <see cref="ParamKinds"/>.</param>
/// <param name="Value">JSON value: number or string for numbers, ISO strings for dates, base64 for binary, null.</param>
/// <param name="Direction">"in" (default) | "out" | "inout"; <c>refcursor</c> is always out.</param>
/// <param name="Size">Size of out/inout string/binary params (default 4000).</param>
public sealed record QueryParam(string Name, string Kind, JsonNode? Value = null, string? Direction = null, int? Size = null)
{
    /// <summary>The name without a leading @ : $ or ?.</summary>
    [JsonIgnore] public string BareName => ParamNames.Bare(Name);

    /// <summary>True when the name is a 1-based position ("1", "2", ...).</summary>
    [JsonIgnore] public bool IsPositional => ParamNames.IsPositional(Name);

    [JsonIgnore] public string EffectiveDirection =>
        Kind == ParamKinds.RefCursor ? ParamDirections.Out : (Direction ?? ParamDirections.In).ToLowerInvariant();

    [JsonIgnore] public bool IsOutput => EffectiveDirection is ParamDirections.Out or ParamDirections.InOut;
}

/// <summary>Value of an out/inout parameter after execution (<c>exec.done.outParams</c>).</summary>
public sealed record OutParamValue(string Name, object? Value);

public static class ParamKinds
{
    public const string Int = "int", String = "string", Decimal = "decimal", Float = "float", Bool = "bool", Date = "date",
        DateTime = "datetime", DateTimeOffset = "datetimeoffset", Time = "time", Guid = "guid", Binary = "binary",
        Null = "null", RefCursor = "refcursor";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        Int, String, Decimal, Float, Bool, Date, DateTime, DateTimeOffset, Time, Guid, Binary, Null, RefCursor,
    };
}

public static class ParamDirections
{
    public const string In = "in", Out = "out", InOut = "inout";
}

public static class ParamNames
{
    public static string Bare(string name)
    {
        var n = name.Trim();
        return n.Length > 0 && n[0] is '@' or ':' or '$' or '?' ? n[1..] : n;
    }

    public static bool IsPositional(string name)
    {
        var bare = Bare(name);
        return bare.Length > 0 && bare.All(char.IsAsciiDigit);
    }
}

/// <summary>
/// Validates <see cref="QueryParam"/>s and converts their JSON values to CLR values (provider-neutral). Providers map
/// the CLR value to their own parameter types.
/// </summary>
public static class ParamValues
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>Throws VALIDATION for unknown kinds/directions, duplicate names and unparsable values.</summary>
    public static void Validate(IReadOnlyList<QueryParam>? parameters)
    {
        if (parameters is null) return;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < parameters.Count; i++)
        {
            var p = parameters[i] ?? throw EngineException.Validation($"params[{i}] is null.", new { field = $"params[{i}]" });
            if (string.IsNullOrWhiteSpace(p.Name) || p.BareName.Length == 0)
                throw EngineException.Validation($"params[{i}].name is required.", new { field = $"params[{i}].name" });
            if (!ParamKinds.All.Contains(p.Kind ?? ""))
                throw EngineException.Validation($"params[{i}].kind '{p.Kind}' is not one of {string.Join(", ", ParamKinds.All)}.", new { field = $"params[{i}].kind" });
            if (p.Direction is not null && p.Direction.ToLowerInvariant() is not (ParamDirections.In or ParamDirections.Out or ParamDirections.InOut))
                throw EngineException.Validation($"params[{i}].direction must be in, out or inout.", new { field = $"params[{i}].direction" });
            if (p.Size is < 0) throw EngineException.Validation($"params[{i}].size must be >= 0.", new { field = $"params[{i}].size" });
            if (!names.Add(p.BareName))
                throw EngineException.Validation($"Parameter '{p.BareName}' is given twice.", new { field = $"params[{i}].name" });
            if (p.EffectiveDirection != ParamDirections.Out)
            {
                try { ToClr(p); }
                catch (FormatException ex) { throw EngineException.Validation($"Parameter '{p.BareName}': {ex.Message}", new { field = $"params[{i}].value" }); }
            }
        }
    }

    /// <summary>
    /// CLR value of an input param: null (→ DBNull) | long | decimal | double | bool | DateTime | DateTimeOffset |
    /// TimeSpan | Guid | byte[] | string. Throws <see cref="FormatException"/> for values that do not match the kind.
    /// </summary>
    public static object? ToClr(QueryParam p)
    {
        var v = p.Value;
        if (v is null || p.Kind is ParamKinds.Null or ParamKinds.RefCursor) return null;
        if (v is not JsonValue jv) throw new FormatException("objects and arrays are not valid parameter values.");
        var kind = jv.GetValueKind();
        if (kind == JsonValueKind.Null) return null;
        var text = kind == JsonValueKind.String ? jv.GetValue<string>() : jv.ToJsonString();

        switch (p.Kind)
        {
            case ParamKinds.String:
                return kind == JsonValueKind.String ? text : text;
            case ParamKinds.Int:
                if (kind is JsonValueKind.True or JsonValueKind.False) return kind == JsonValueKind.True ? 1L : 0L;
                if (long.TryParse(text.Trim(), NumberStyles.Integer, Inv, out var l)) return l;
                if (decimal.TryParse(text.Trim(), NumberStyles.Float, Inv, out var dl) && decimal.Truncate(dl) == dl && dl is >= long.MinValue and <= long.MaxValue) return (long)dl;
                throw new FormatException($"'{text}' is not an integer.");
            case ParamKinds.Decimal:
                if (decimal.TryParse(text.Trim(), NumberStyles.Float, Inv, out var m)) return m;
                throw new FormatException($"'{text}' is not a decimal number.");
            case ParamKinds.Float:
                if (double.TryParse(text.Trim(), NumberStyles.Float, Inv, out var d)) return d;
                throw new FormatException($"'{text}' is not a number.");
            case ParamKinds.Bool:
                if (kind is JsonValueKind.True or JsonValueKind.False) return kind == JsonValueKind.True;
                return text.Trim().ToLowerInvariant() switch
                {
                    "true" or "1" or "yes" or "y" => true,
                    "false" or "0" or "no" or "n" => false,
                    _ => throw new FormatException($"'{text}' is not a boolean."),
                };
            case ParamKinds.Date:
                if (DateOnly.TryParseExact(text.Trim(), "yyyy-MM-dd", Inv, DateTimeStyles.None, out var dateOnly)) return dateOnly.ToDateTime(TimeOnly.MinValue);
                if (DateTime.TryParse(text.Trim(), Inv, DateTimeStyles.RoundtripKind, out var dd)) return dd.Date;
                throw new FormatException($"'{text}' is not a date (yyyy-MM-dd).");
            case ParamKinds.DateTime:
                if (DateTime.TryParse(text.Trim(), Inv, DateTimeStyles.RoundtripKind, out var dt))
                    return dt.Kind == DateTimeKind.Utc ? dt : DateTime.SpecifyKind(dt, DateTimeKind.Unspecified);
                throw new FormatException($"'{text}' is not a date/time (ISO 8601).");
            case ParamKinds.DateTimeOffset:
                if (DateTimeOffset.TryParse(text.Trim(), Inv, DateTimeStyles.None, out var dto)) return dto;
                throw new FormatException($"'{text}' is not a date/time with offset (ISO 8601).");
            case ParamKinds.Time:
                if (TimeSpan.TryParse(text.Trim(), Inv, out var ts)) return ts;
                throw new FormatException($"'{text}' is not a time (HH:mm:ss).");
            case ParamKinds.Guid:
                if (Guid.TryParse(text.Trim(), out var g)) return g;
                throw new FormatException($"'{text}' is not a GUID.");
            case ParamKinds.Binary:
                return FromBinaryText(text);
            default:
                throw new FormatException($"Unknown parameter kind '{p.Kind}'.");
        }
    }

    /// <summary>Base64, or hex with a 0x prefix.</summary>
    public static byte[] FromBinaryText(string text)
    {
        var t = text.Trim();
        if (t.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            try { return Convert.FromHexString(t[2..]); }
            catch (FormatException) { throw new FormatException("binary values must be base64 or 0x-prefixed hex."); }
        }
        try { return Convert.FromBase64String(t); }
        catch (FormatException) { throw new FormatException("binary values must be base64 or 0x-prefixed hex."); }
    }

    /// <summary>Wire value of an output parameter value read back from the driver.</summary>
    public static object? ToWire(object? value) => value is null or DBNull ? null : ValueConverter.ToWire(value);
}
