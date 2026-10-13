using System.Text.Json;
using System.Text.Json.Serialization;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// JSON conventions shared by the REST API, the WebSocket and the engine's own files: camelCase properties,
/// enums as camelCase strings, <see cref="Dialect"/> as "tsql" | "plsql" | "sqlite".
/// </summary>
public static class CoreJson
{
    public static readonly JsonSerializerOptions Options = Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static readonly JsonSerializerOptions Indented = new(Options) { WriteIndented = true };

    public static JsonSerializerOptions Configure(JsonSerializerOptions o)
    {
        o.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        o.DictionaryKeyPolicy = null; // props / settings keys are kept verbatim
        o.PropertyNameCaseInsensitive = true;
        o.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
        o.NumberHandling = JsonNumberHandling.Strict;
        o.Converters.Insert(0, new DialectJsonConverter());
        o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return o;
    }

    public static string ToWire(Dialect d) => d switch
    {
        Dialect.TSql => "tsql",
        Dialect.PlSql => "plsql",
        Dialect.Sqlite => "sqlite",
        _ => d.ToString().ToLowerInvariant(),
    };

    public static Dialect? ParseDialect(string? s) => s?.Trim().ToLowerInvariant() switch
    {
        "tsql" => Dialect.TSql,
        "plsql" => Dialect.PlSql,
        "sqlite" => Dialect.Sqlite,
        _ => null,
    };
}

/// <summary>Serializes <see cref="Dialect"/> as the wire tokens (camelCase would give "tSql"/"plSql").</summary>
public sealed class DialectJsonConverter : JsonConverter<Dialect>
{
    public override Dialect Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
        return CoreJson.ParseDialect(s) ?? throw new JsonException($"Unknown dialect '{s}'. Expected tsql, plsql or sqlite.");
    }

    public override void Write(Utf8JsonWriter writer, Dialect value, JsonSerializerOptions options) => writer.WriteStringValue(CoreJson.ToWire(value));
}
