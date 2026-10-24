using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>Form spec and connection-string building for MySQL / MariaDB (MySqlConnector, plan-batch3 WP-MY).</summary>
public static class MySqlConnectionStrings
{
    public const int DefaultPort = 3306;
    public const int DefaultConnectTimeout = 15;
    public const string DefaultCharset = "utf8mb4";
    public const string ApplicationName = "Rowlit";

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("host", "Host", "text", Required: true, Placeholder: "localhost"),
        new FormField("port", "Port", "number", Default: JsonValue.Create(DefaultPort)),
        new FormField("database", "Database", "text", Placeholder: "shop", Help: "Default database (USE); leave empty to pick one later."),
        new FormField("user", "User", "text", Required: true),
        new FormField("password", "Password", "password"),
        new FormField("sslMode", "SSL mode", "select", Default: JsonValue.Create("preferred"),
            Options:
            [
                new FormOption("none", "None"), new FormOption("preferred", "Preferred"), new FormOption("required", "Required"),
                new FormOption("verifyca", "Verify CA"), new FormOption("verifyfull", "Verify full"),
            ]),
        new FormField("sslCa", "CA certificate", "file", FileFilter: "Certificates|*.pem;*.crt;*.cer|All files|*.*",
            Help: "PEM file of the CA for Verify CA / Verify full."),
        new FormField("allowPublicKeyRetrieval", "Allow public key retrieval", "bool", Default: JsonValue.Create(false),
            Help: "caching_sha2_password / sha256_password without TLS: let the client fetch the server's RSA key."),
        new FormField("charset", "Character set", "text", Default: JsonValue.Create(DefaultCharset)),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
        new FormField("compress", "Compress", "bool", Default: JsonValue.Create(false)),
        new FormField("serverVariables", "Session variables", "text", Placeholder: "sql_mode='ANSI_QUOTES',time_zone='+00:00'",
            Help: "Comma-separated name=value pairs applied with SET SESSION after connecting."),
    ]);

    /// <summary>
    /// The MySqlConnector connection string. Sessions use <paramref name="pooling"/> = false (session state, USE, user
    /// variables and transactions belong to the tab); catalog/designer/search connections are pooled. <paramref name="database"/>
    /// overrides the profile's database.
    /// </summary>
    public static string Build(ConnectionProfile profile, string? password, bool pooling, string? database = null) =>
        Builder(profile, password, pooling, database).ConnectionString;

    public static MySqlConnectionStringBuilder Builder(ConnectionProfile profile, string? password, bool pooling, string? database = null)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var host = profile.GetString("host")?.Trim();
        if (string.IsNullOrEmpty(host)) throw new ArgumentException("Host is required.", nameof(profile));
        var port = profile.GetInt("port", DefaultPort);
        if (port is < 1 or > 65535) throw new ArgumentException($"Port {port} is out of range (1-65535).", nameof(profile));

        var b = new MySqlConnectionStringBuilder
        {
            Server = host,
            Port = (uint)port,
            Pooling = pooling,
            ConnectionTimeout = (uint)Math.Clamp(profile.GetInt("connectTimeout", DefaultConnectTimeout), 1, 3600),
            DefaultCommandTimeout = 0,
            SslMode = ParseSslMode(profile.GetString("sslMode")),
            AllowPublicKeyRetrieval = profile.GetBool("allowPublicKeyRetrieval"),
            CharacterSet = FirstNonEmpty(profile.GetString("charset")) ?? DefaultCharset,
            UseCompression = profile.GetBool("compress"),
            AllowUserVariables = true,
            AllowLoadLocalInfile = false,
            UseAffectedRows = true,
            TreatTinyAsBoolean = false,
            ConvertZeroDateTime = true,
            GuidFormat = MySqlGuidFormat.None,
            ApplicationName = ApplicationName,
            // Cancel sends KILL QUERY on a side connection; give it a few seconds before the driver gives up waiting.
            CancellationTimeout = 5,
            IgnoreCommandTransaction = true,
            Keepalive = 30,
        };
        var db = FirstNonEmpty(database, profile.GetString("database"));
        if (db is not null) b.Database = db;
        var user = profile.GetString("user")?.Trim();
        if (!string.IsNullOrEmpty(user)) b.UserID = user;
        if (password is not null) b.Password = password;
        var ca = profile.GetString("sslCa")?.Trim();
        if (!string.IsNullOrEmpty(ca)) b.SslCa = ca;
        return b;
    }

    public static MySqlSslMode ParseSslMode(string? value) => (value ?? "").Trim().ToLowerInvariant().Replace("-", "").Replace("_", "") switch
    {
        "" or "preferred" or "prefer" => MySqlSslMode.Preferred,
        "none" or "disable" or "disabled" or "false" or "off" => MySqlSslMode.None,
        "required" or "require" or "true" or "on" => MySqlSslMode.Required,
        "verifyca" => MySqlSslMode.VerifyCA,
        "verifyfull" or "verifyidentity" => MySqlSslMode.VerifyFull,
        var v => throw new ArgumentException($"Unsupported SSL mode '{v}' (none, preferred, required, verifyca, verifyfull)."),
    };

    /// <summary>
    /// "a=1, b='x,y'" → [("a","1"), ("b","'x,y'")]: the session variables of the profile, validated (names are identifiers,
    /// values are not split inside quotes or parentheses).
    /// </summary>
    public static IReadOnlyList<(string Name, string Value)> ParseServerVariables(string? text)
    {
        var list = new List<(string, string)>();
        if (string.IsNullOrWhiteSpace(text)) return list;
        var parts = new List<string>();
        var sb = new System.Text.StringBuilder();
        char quote = '\0';
        var depth = 0;
        foreach (var ch in text)
        {
            if (quote != '\0') { sb.Append(ch); if (ch == quote) quote = '\0'; continue; }
            if (ch is '\'' or '"') { quote = ch; sb.Append(ch); continue; }
            if (ch == '(') depth++;
            if (ch == ')') depth = Math.Max(0, depth - 1);
            if (ch == ',' && depth == 0) { parts.Add(sb.ToString()); sb.Clear(); continue; }
            sb.Append(ch);
        }
        parts.Add(sb.ToString());
        foreach (var raw in parts.Select(p => p.Trim()).Where(p => p.Length > 0))
        {
            var eq = raw.IndexOf('=');
            if (eq <= 0) throw new ArgumentException($"Session variable '{raw}' must be name=value.");
            var name = raw[..eq].Trim();
            if (name.StartsWith("@@", StringComparison.Ordinal)) name = name[2..];
            if (name.StartsWith("session.", StringComparison.OrdinalIgnoreCase)) name = name[8..];
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z_][A-Za-z0-9_]*$"))
                throw new ArgumentException($"'{name}' is not a valid session variable name.");
            var value = raw[(eq + 1)..].Trim();
            if (value.Length == 0 || value.Contains(';')) throw new ArgumentException($"Session variable '{name}' has an invalid value.");
            list.Add((name, value));
        }
        return list;
    }

    /// <summary>The statements run once after a session/catalog connection opened (session variables, read-only).</summary>
    public static IReadOnlyList<string> InitStatements(ConnectionProfile profile, bool session)
    {
        var list = new List<string>();
        var vars = ParseServerVariables(profile.GetString("serverVariables"));
        if (vars.Count > 0) list.Add("SET SESSION " + string.Join(", ", vars.Select(v => $"{v.Name} = {v.Value}")));
        if (profile.ReadOnly && session) list.Add("SET SESSION TRANSACTION READ ONLY");
        return list;
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
