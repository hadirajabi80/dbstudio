using System.Text.Json.Nodes;

namespace DbStudio.Core.Models;

// Enums serialize as camelCase strings (the Host registers JsonStringEnumConverter with camelCase naming).

/// <summary>
/// SQL dialect of a relational provider; wire tokens tsql | plsql | sqlite | pgsql | mysql | clickhouse | snowflake | cql
/// (<see cref="Services.DialectJsonConverter"/>). Batch 3: <see cref="MySql"/> serves MySQL and MariaDB, <see cref="Cql"/>
/// Cassandra/ScyllaDB. Per-dialect traits live in <see cref="DialectInfo"/>.
/// </summary>
public enum Dialect { TSql, PlSql, Sqlite, PgSql, MySql, ClickHouse, Snowflake, Cql }

/// <summary>
/// M2 (docs/PLAN-M2.md D1): provider family. Wire tokens relational | keyvalue | document | stream | search
/// (<see cref="Services.SourceKindJsonConverter"/>). Only relational providers have sessions and a SQL catalog.
/// Batch 3: <see cref="Search"/> is Elasticsearch/OpenSearch.
/// </summary>
public enum SourceKind { Relational, KeyValue, Document, Stream, Search }
public enum SessionState { Idle, Executing, Broken, Closed }
public enum TransactionMode { Auto, Manual }
public enum MessageSeverity { Info, Warning, Error }
public enum MessageSource { Server, DbmsOutput, Engine }
public enum BatchStatus { Ok, Error, Cancelled }
public enum ExecutionStatus { Ok, Error, Cancelled }

/// <summary>Saved connection. Secrets are never stored here (see ISecretStore).</summary>
public sealed class ConnectionProfile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>"sqlserver" | "oracle" | "sqlite" | "postgresql" | "mysql" | "mariadb" | "clickhouse" | "snowflake" | "cassandra" | "redis" | "mongodb" | "kafka" | "elasticsearch".</summary>
    public string ProviderId { get; set; } = "";
    public string? Color { get; set; }
    public string? Folder { get; set; }
    public bool ReadOnly { get; set; }
    /// <summary>Provider-specific fields keyed by ConnectionFormSpec field keys (server, auth, user, database, host, port, serviceName, path, ...).</summary>
    public Dictionary<string, JsonNode?> Props { get; set; } = new();
    public bool HasPassword { get; set; }
    public bool SavePassword { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }

    public string? GetString(string key) =>
        Props.TryGetValue(key, out var v) && v is not null ? v.GetValueKind() switch
        {
            System.Text.Json.JsonValueKind.String => v.GetValue<string>(),
            System.Text.Json.JsonValueKind.Null => null,
            _ => v.ToJsonString(),
        } : null;

    public bool GetBool(string key, bool fallback = false) =>
        Props.TryGetValue(key, out var v) && v is JsonValue jv
            ? jv.TryGetValue<bool>(out var b) ? b : bool.TryParse(jv.ToString(), out var p) ? p : fallback
            : fallback;

    public int GetInt(string key, int fallback) =>
        Props.TryGetValue(key, out var v) && v is JsonValue jv
            ? jv.TryGetValue<int>(out var i) ? i : int.TryParse(jv.ToString(), out var p) ? p : fallback
            : fallback;

    public IReadOnlyList<string> GetList(string key) =>
        Props.TryGetValue(key, out var v) && v is JsonArray arr
            ? arr.Select(x => x?.ToString() ?? "").Where(s => s.Length > 0).ToList()
            : GetString(key)?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
}

public sealed record ConnectionFormSpec(IReadOnlyList<FormField> Fields);

/// <summary>type: text | password | number | bool | select | file | list.</summary>
public sealed record FormField(
    string Key,
    string Label,
    string Type,
    bool Required = false,
    string? Placeholder = null,
    JsonNode? Default = null,
    IReadOnlyList<FormOption>? Options = null,
    /// <summary>Show only when every listed field equals the value, e.g. { "auth": "sql" }.</summary>
    IReadOnlyDictionary<string, string>? VisibleWhen = null,
    string? FileFilter = null,
    string? Help = null);

public sealed record FormOption(string Value, string Label);

public sealed record ServerInfo(string Version, string? ProductVersion, string? ServerName, string? User, string? Database);

public sealed record TestConnectionResult(bool Ok, ServerInfo? ServerInfo, long ElapsedMs, ErrorInfo? Error);

public sealed record SessionOptions(string SessionId, string? Database, TransactionMode TxMode, bool CaptureServerOutput);

public sealed record IdentifierRules(
    char QuoteOpen,
    char QuoteClose,
    /// <summary>"upper" (Oracle), "lower" (PostgreSQL), "preserve" (SQL Server, SQLite).</summary>
    string CaseFolding,
    IReadOnlySet<string> ReservedWords);

public sealed record SqlDiagnostic(int Line, int Col, int EndLine, int EndCol, string Severity, string? Code, string Message);
