using System.Text.Json;
using System.Text.Json.Serialization;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// JSON conventions shared by the REST API, the WebSocket and the engine's own files: camelCase properties,
/// enums as camelCase strings, <see cref="Dialect"/> as "tsql" | "plsql" | "sqlite" | "pgsql" | "mysql" | "clickhouse" | "snowflake" | "cql",
/// <see cref="SourceKind"/> as "relational" | "keyvalue" | "document" | "stream" | "search".
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
        o.Converters.Insert(1, new SourceKindJsonConverter());
        o.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return o;
    }

    public static string ToWire(Dialect d) => d switch
    {
        Dialect.TSql => "tsql",
        Dialect.PlSql => "plsql",
        Dialect.Sqlite => "sqlite",
        Dialect.PgSql => "pgsql",
        Dialect.MySql => "mysql",
        Dialect.ClickHouse => "clickhouse",
        Dialect.Snowflake => "snowflake",
        Dialect.Cql => "cql",
        _ => d.ToString().ToLowerInvariant(),
    };

    public static Dialect? ParseDialect(string? s) => s?.Trim().ToLowerInvariant() switch
    {
        "tsql" => Dialect.TSql,
        "plsql" => Dialect.PlSql,
        "sqlite" => Dialect.Sqlite,
        "pgsql" => Dialect.PgSql,
        "mysql" => Dialect.MySql,
        "clickhouse" => Dialect.ClickHouse,
        "snowflake" => Dialect.Snowflake,
        "cql" => Dialect.Cql,
        _ => null,
    };

    public static string ToWire(SourceKind k) => k switch
    {
        SourceKind.Relational => "relational",
        SourceKind.KeyValue => "keyvalue",
        SourceKind.Document => "document",
        SourceKind.Stream => "stream",
        SourceKind.Search => "search",
        _ => k.ToString().ToLowerInvariant(),
    };

    public static SourceKind? ParseSourceKind(string? s) => s?.Trim().ToLowerInvariant() switch
    {
        "relational" => SourceKind.Relational,
        "keyvalue" => SourceKind.KeyValue,
        "document" => SourceKind.Document,
        "stream" => SourceKind.Stream,
        "search" => SourceKind.Search,
        _ => null,
    };
}

/// <summary>Serializes <see cref="Dialect"/> as the wire tokens (camelCase would give "tSql"/"plSql").</summary>
public sealed class DialectJsonConverter : JsonConverter<Dialect>
{
    public override Dialect Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
        return CoreJson.ParseDialect(s) ?? throw new JsonException($"Unknown dialect '{s}'. Expected tsql, plsql, sqlite, pgsql, mysql, clickhouse, snowflake or cql.");
    }

    public override void Write(Utf8JsonWriter writer, Dialect value, JsonSerializerOptions options) => writer.WriteStringValue(CoreJson.ToWire(value));
}

/// <summary>M2: serializes <see cref="SourceKind"/> as relational | keyvalue | document | stream | search (camelCase would give "keyValue").</summary>
public sealed class SourceKindJsonConverter : JsonConverter<SourceKind>
{
    public override SourceKind Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var s = reader.TokenType == JsonTokenType.String ? reader.GetString() : null;
        return CoreJson.ParseSourceKind(s) ?? throw new JsonException($"Unknown source kind '{s}'. Expected relational, keyvalue, document, stream or search.");
    }

    public override void Write(Utf8JsonWriter writer, SourceKind value, JsonSerializerOptions options) => writer.WriteStringValue(CoreJson.ToWire(value));
}
