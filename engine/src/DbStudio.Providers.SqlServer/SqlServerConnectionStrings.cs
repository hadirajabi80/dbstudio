using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>Connection form and connection-string building for SQL Server (docs/PLAN.md 2.5 and 3.1).</summary>
public static class SqlServerConnectionStrings
{
    public const string ApplicationName = "DbStudio";
    public const int DefaultConnectTimeout = 15;

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("server", "Server", "text", Required: true, Placeholder: "localhost\\SQLEXPRESS or host,1433"),
        new FormField("auth", "Authentication", "select", Default: JsonValue.Create("sql"),
            Options: [new FormOption("sql", "SQL Login"), new FormOption("windows", "Windows Authentication")]),
        new FormField("user", "User", "text", VisibleWhen: new Dictionary<string, string> { ["auth"] = "sql" }),
        new FormField("password", "Password", "password", VisibleWhen: new Dictionary<string, string> { ["auth"] = "sql" }),
        new FormField("database", "Database", "text", Placeholder: "default database of the login"),
        new FormField("encrypt", "Encrypt", "select", Default: JsonValue.Create("optional"),
            Options: [new FormOption("optional", "Optional"), new FormOption("mandatory", "Mandatory"), new FormOption("strict", "Strict (TDS 8.0)")]),
        new FormField("trustServerCertificate", "Trust server certificate", "bool", Default: JsonValue.Create(true)),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
    ]);

    /// <summary>Builds the connection string. Sessions use <paramref name="pooling"/> = false so session state belongs to the tab.</summary>
    public static string Build(ConnectionProfile profile, string? password, bool pooling)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var server = profile.GetString("server")?.Trim();
        if (string.IsNullOrEmpty(server))
            throw new ArgumentException("Server is required.", nameof(profile));

        var b = new SqlConnectionStringBuilder
        {
            DataSource = server,
            ApplicationName = ApplicationName,
            MultipleActiveResultSets = false,
            Pooling = pooling,
            ConnectTimeout = Math.Max(0, profile.GetInt("connectTimeout", DefaultConnectTimeout)),
            TrustServerCertificate = profile.GetBool("trustServerCertificate", true),
            Encrypt = ParseEncrypt(profile.GetString("encrypt")),
        };

        var auth = (profile.GetString("auth") ?? "sql").Trim().ToLowerInvariant();
        switch (auth)
        {
            case "windows":
            case "integrated":
                b.IntegratedSecurity = true;
                break;
            case "sql":
            case "":
                b.IntegratedSecurity = false;
                var user = profile.GetString("user");
                if (!string.IsNullOrEmpty(user)) b.UserID = user;
                if (password is not null) b.Password = password;
                break;
            default:
                throw new ArgumentException($"Unsupported authentication '{auth}'.", nameof(profile));
        }

        var db = profile.GetString("database")?.Trim();
        if (!string.IsNullOrEmpty(db)) b.InitialCatalog = db;
        return b.ConnectionString;
    }

    public static SqlConnectionEncryptOption ParseEncrypt(string? value) => (value ?? "").Trim().ToLowerInvariant() switch
    {
        "" or "optional" or "false" or "no" => SqlConnectionEncryptOption.Optional,
        "mandatory" or "true" or "yes" => SqlConnectionEncryptOption.Mandatory,
        "strict" => SqlConnectionEncryptOption.Strict,
        var v => throw new ArgumentException($"Unsupported encrypt option '{v}'."),
    };
}
