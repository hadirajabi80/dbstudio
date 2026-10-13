using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle;

/// <summary>Connection form and connection-string building for Oracle (docs/PLAN.md 2.5 and 3.1).</summary>
public static class OracleConnectionStrings
{
    public const int DefaultPort = 1521;
    public const int DefaultConnectTimeout = 15;

    private static readonly Dictionary<string, string> Basic = new() { ["connectionType"] = "basic" };

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("connectionType", "Connection type", "select", Default: JsonValue.Create("basic"),
            Options: [new FormOption("basic", "Basic (host / service)"), new FormOption("tns", "TNS alias"), new FormOption("descriptor", "Connect descriptor")]),
        new FormField("host", "Host", "text", Required: true, Placeholder: "localhost", VisibleWhen: Basic),
        new FormField("port", "Port", "number", Default: JsonValue.Create(DefaultPort), VisibleWhen: Basic),
        new FormField("serviceName", "Service name", "text", Placeholder: "FREEPDB1", VisibleWhen: Basic,
            Help: "Use either a service name or a SID."),
        new FormField("sid", "SID", "text", VisibleWhen: Basic),
        new FormField("tnsAlias", "TNS alias", "text", Required: true, VisibleWhen: new Dictionary<string, string> { ["connectionType"] = "tns" },
            Help: "Resolved through tnsnames.ora in TNS_ADMIN."),
        new FormField("descriptor", "Connect descriptor", "text", Required: true,
            Placeholder: "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))",
            VisibleWhen: new Dictionary<string, string> { ["connectionType"] = "descriptor" }),
        new FormField("user", "User", "text", Required: true),
        new FormField("password", "Password", "password"),
        new FormField("role", "Role", "select", Default: JsonValue.Create("normal"),
            Options: [new FormOption("normal", "Normal"), new FormOption("sysdba", "SYSDBA"), new FormOption("sysoper", "SYSOPER")]),
        new FormField("extraSchemas", "Extra schemas to load", "list", Help: "Schemas loaded eagerly in addition to the current schema."),
    ]);

    /// <summary>The Data Source part for the profile's connection type.</summary>
    public static string DataSource(ConnectionProfile profile)
    {
        var type = (profile.GetString("connectionType") ?? "basic").Trim().ToLowerInvariant();
        switch (type)
        {
            case "basic":
            case "":
            {
                var host = profile.GetString("host")?.Trim();
                if (string.IsNullOrEmpty(host)) throw new ArgumentException("Host is required.", nameof(profile));
                var port = profile.GetInt("port", DefaultPort);
                if (port <= 0 || port > 65535) throw new ArgumentException($"Invalid port {port}.", nameof(profile));
                var service = profile.GetString("serviceName")?.Trim();
                var sid = profile.GetString("sid")?.Trim();
                string connectData = !string.IsNullOrEmpty(service) ? $"(SERVICE_NAME={service})"
                    : !string.IsNullOrEmpty(sid) ? $"(SID={sid})"
                    : throw new ArgumentException("Service name or SID is required.", nameof(profile));
                return $"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT={port}))(CONNECT_DATA={connectData}))";
            }
            case "tns":
            {
                var alias = profile.GetString("tnsAlias")?.Trim();
                return string.IsNullOrEmpty(alias) ? throw new ArgumentException("TNS alias is required.", nameof(profile)) : alias;
            }
            case "descriptor":
            {
                var d = profile.GetString("descriptor")?.Trim();
                return string.IsNullOrEmpty(d) ? throw new ArgumentException("Connect descriptor is required.", nameof(profile)) : d;
            }
            default:
                throw new ArgumentException($"Unsupported connection type '{type}'.", nameof(profile));
        }
    }

    /// <summary>Builds the connection string. Sessions use <paramref name="pooling"/> = false (statement cache off too).</summary>
    public static string Build(ConnectionProfile profile, string? password, bool pooling)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var b = new OracleConnectionStringBuilder
        {
            DataSource = DataSource(profile),
            Pooling = pooling,
            StatementCacheSize = 0,
            ConnectionTimeout = Math.Max(1, profile.GetInt("connectTimeout", DefaultConnectTimeout)),
        };
        var user = profile.GetString("user")?.Trim();
        if (!string.IsNullOrEmpty(user)) b.UserID = QuoteIfNeeded(user);
        if (password is not null) b.Password = QuoteIfNeeded(password);

        var role = (profile.GetString("role") ?? "normal").Trim().ToLowerInvariant();
        switch (role)
        {
            case "normal": case "": break;
            case "sysdba": b.DBAPrivilege = "SYSDBA"; break;
            case "sysoper": b.DBAPrivilege = "SYSOPER"; break;
            default: throw new ArgumentException($"Unsupported role '{role}'.", nameof(profile));
        }
        return b.ConnectionString;
    }

    /// <summary>
    /// Oracle passwords and user names containing characters outside [A-Za-z0-9_$#] must be double-quoted for the
    /// server (ODP.NET passes them through). A password that already contains a double quote cannot be quoted and is passed as-is.
    /// </summary>
    public static string QuoteIfNeeded(string value)
    {
        if (value.Length == 0 || value.StartsWith('"')) return value;
        foreach (var c in value)
        {
            if (!(char.IsAsciiLetterOrDigit(c) || c is '_' or '$' or '#'))
                return value.Contains('"') ? value : "\"" + value + "\"";
        }
        return value;
    }
}
