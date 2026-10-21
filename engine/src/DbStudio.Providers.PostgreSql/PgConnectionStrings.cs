using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>Form spec (docs/PLAN-PG.md 2.1) and connection-string building for PostgreSQL (Npgsql).</summary>
public static class PgConnectionStrings
{
    public const int DefaultPort = 5432;
    public const int DefaultConnectTimeout = 15;
    public const string DefaultDatabase = "postgres";
    public const string DefaultApplicationName = "DbStudio";
    public const string ReadOnlyOption = "-c default_transaction_read_only=on";

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
        new FormField("applicationName", "Application name", "text", Default: JsonValue.Create(DefaultApplicationName)),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
        new FormField("options", "Server options", "text", Placeholder: "-c statement_timeout=0",
            Help: "Extra -c name=value server options (advanced)."),
    ]);

    /// <summary>
    /// Builds the Npgsql connection string. Sessions use <paramref name="pooling"/> = false so session state (search_path,
    /// SET, temp tables, an open transaction) belongs to the tab; catalog, designer and diagnostics connections are pooled.
    /// <paramref name="database"/> overrides the profile's database (PostgreSQL connections are bound to one database).
    /// A read-only profile adds <c>-c default_transaction_read_only=on</c> to the server options.
    /// </summary>
    public static string Build(ConnectionProfile profile, string? password, bool pooling, string? database = null) =>
        Builder(profile, password, pooling, database).ConnectionString;

    /// <summary>The builder behind <see cref="Build"/> (callers add options such as a different ApplicationName).</summary>
    public static NpgsqlConnectionStringBuilder Builder(ConnectionProfile profile, string? password, bool pooling, string? database = null)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var host = profile.GetString("host")?.Trim();
        if (string.IsNullOrEmpty(host)) throw new ArgumentException("Host is required.", nameof(profile));
        var port = profile.GetInt("port", DefaultPort);
        if (port is < 1 or > 65535) throw new ArgumentException($"Port {port} is out of range (1-65535).", nameof(profile));

        var sslMode = ParseSslMode(profile.GetString("sslMode"));
        // "Trust server certificate": accept a self-signed certificate. Npgsql 8+ does not validate certificates in
        // Require mode, so the verify modes fall back to Require when the user trusts the certificate.
        if (profile.GetBool("trustServerCertificate") && sslMode is SslMode.VerifyCA or SslMode.VerifyFull) sslMode = SslMode.Require;

        var b = new NpgsqlConnectionStringBuilder
        {
            Host = host,
            Port = port,
            Database = FirstNonEmpty(database, profile.GetString("database")) ?? DefaultDatabase,
            ApplicationName = FirstNonEmpty(profile.GetString("applicationName")) ?? DefaultApplicationName,
            Timeout = Math.Clamp(profile.GetInt("connectTimeout", DefaultConnectTimeout), 0, 1024),
            Pooling = pooling,
            IncludeErrorDetail = true,
            Multiplexing = false,
            KeepAlive = 30,
            SslMode = sslMode,
            Enlist = false,
        };
        var user = profile.GetString("user")?.Trim();
        if (!string.IsNullOrEmpty(user)) b.Username = user;
        if (password is not null) b.Password = password;
        var searchPath = profile.GetString("searchPath")?.Trim();
        if (!string.IsNullOrEmpty(searchPath)) b.SearchPath = searchPath;
        var options = profile.GetString("options")?.Trim() ?? "";
        if (profile.ReadOnly) options = (options + " " + ReadOnlyOption).Trim();
        if (options.Length > 0) b.Options = options;
        return b;
    }

    public static SslMode ParseSslMode(string? value) => (value ?? "").Trim().ToLowerInvariant() switch
    {
        "" or "prefer" => SslMode.Prefer,
        "disable" or "false" or "off" => SslMode.Disable,
        "allow" => SslMode.Allow,
        "require" or "true" or "on" => SslMode.Require,
        "verify-ca" or "verifyca" => SslMode.VerifyCA,
        "verify-full" or "verifyfull" => SslMode.VerifyFull,
        var v => throw new ArgumentException($"Unsupported SSL mode '{v}' (disable, allow, prefer, require, verify-ca, verify-full)."),
    };

    private static string? FirstNonEmpty(params string?[] values) =>
        values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
