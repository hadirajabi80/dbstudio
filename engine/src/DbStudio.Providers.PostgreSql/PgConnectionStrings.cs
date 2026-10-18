using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Providers.PostgreSql;

/// <summary>Form spec (final, docs/PLAN-PG.md 2.1) and connection string builder (M2-0 STUB: PG-A implements Build).</summary>
public static class PgConnectionStrings
{
    public const int DefaultPort = 5432;
    public const int DefaultConnectTimeout = 15;

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("host", "Host", "text", Required: true, Placeholder: "localhost"),
        new FormField("port", "Port", "number", Default: JsonValue.Create(DefaultPort)),
        new FormField("database", "Database", "text", Placeholder: "postgres"),
        new FormField("user", "User", "text", Required: true),
        new FormField("password", "Password", "password"),
        new FormField("sslMode", "SSL mode", "select", Default: JsonValue.Create("prefer"),
            Options:
            [
                new FormOption("disable", "Disable"), new FormOption("allow", "Allow"), new FormOption("prefer", "Prefer"),
                new FormOption("require", "Require"), new FormOption("verify-ca", "Verify CA"), new FormOption("verify-full", "Verify full"),
            ]),
        new FormField("trustServerCertificate", "Trust server certificate", "bool", Default: JsonValue.Create(false),
            Help: "Accept self-signed certificates with require."),
        new FormField("searchPath", "Search path", "text", Placeholder: "\"$user\", public",
            Help: "Session search_path (leave empty for the server/role default)."),
        new FormField("applicationName", "Application name", "text", Default: JsonValue.Create("DbStudio")),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
        new FormField("options", "Server options", "text", Placeholder: "-c statement_timeout=0",
            Help: "Extra -c name=value server options (advanced)."),
    ]);

    /// <summary>NpgsqlConnectionStringBuilder from the profile (PLAN-PG 2.1). M2-0 STUB.</summary>
    public static string Build(ConnectionProfile profile, string? password, bool pooling, string? database = null) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);
}
