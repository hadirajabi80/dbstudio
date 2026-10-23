using System.Globalization;
using System.Security;
using System.Text;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Snowflake;

/// <summary>The four supported authenticators (Snowflake.Data <c>authenticator=</c> values).</summary>
public static class SnowflakeAuth
{
    public const string Password = "snowflake", KeyPair = "snowflake_jwt", Browser = "externalbrowser", OAuth = "oauth";

    public static readonly IReadOnlyList<string> All = [Password, KeyPair, Browser, OAuth];
}

/// <summary>
/// Form spec (plan-batch3 WP-SF) and Snowflake.Data connection strings. Secrets never enter the connection string when the
/// driver offers a <see cref="SecureString"/> property (<c>Password</c>, <c>Token</c>); the key-pair passphrase has none, so
/// it is written escaped (<c>;</c> doubled). Sessions disable the driver's pool (a tab owns its server session: USE,
/// variables, an open transaction); catalog, designer and module connections are pooled.
/// </summary>
public static class SnowflakeConnectionStrings
{
    public const string DefaultQueryTag = "Rowlit";
    public const string ApplicationName = "Rowlit";
    public const int DefaultConnectTimeout = 60;
    public const string DefaultSchema = "PUBLIC";

    private static IReadOnlyDictionary<string, string> When(string authenticator) => new Dictionary<string, string> { ["authenticator"] = authenticator };

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("account", "Account", "text", Required: true, Placeholder: "orgname-account or xy12345.eu-central-1",
            Help: "Account identifier (the part before .snowflakecomputing.com); a full URL is accepted too."),
        new FormField("user", "User", "text", Placeholder: "JSMITH", Help: "Login name (optional for OAuth when the token names the user)."),
        new FormField("authenticator", "Authentication", "select", Default: JsonValue.Create(SnowflakeAuth.Password),
            Options:
            [
                new FormOption(SnowflakeAuth.Password, "Password"),
                new FormOption(SnowflakeAuth.KeyPair, "Key pair (JWT)"),
                new FormOption(SnowflakeAuth.Browser, "Browser SSO (externalbrowser)"),
                new FormOption(SnowflakeAuth.OAuth, "OAuth access token"),
            ]),
        new FormField("password", "Password", "password", VisibleWhen: When(SnowflakeAuth.Password)),
        new FormField("privateKeyFile", "Private key file", "file", VisibleWhen: When(SnowflakeAuth.KeyPair), FileFilter: "*.p8;*.pem;*.key",
            Help: "PKCS#8 private key (rsa_key.p8) whose public key is set on the user (ALTER USER … SET RSA_PUBLIC_KEY)."),
        new FormField("privateKeyPassphrase", "Key passphrase", "password", VisibleWhen: When(SnowflakeAuth.KeyPair),
            Help: "Only for an encrypted key (ENCRYPTED PRIVATE KEY)."),
        new FormField("token", "OAuth token", "password", VisibleWhen: When(SnowflakeAuth.OAuth),
            Help: "Access token from your identity provider (it expires: paste a fresh one when Snowflake rejects it)."),
        new FormField("warehouse", "Warehouse", "text", Placeholder: "COMPUTE_WH"),
        new FormField("database", "Database", "text", Placeholder: "SNOWFLAKE_SAMPLE_DATA"),
        new FormField("schema", "Schema", "text", Placeholder: DefaultSchema),
        new FormField("role", "Role", "text", Placeholder: "SYSADMIN", Help: "Empty = the user's default role."),
        new FormField("host", "Host (advanced)", "text", Placeholder: "account.privatelink.snowflakecomputing.com",
            Help: "Only for PrivateLink or custom hosts; derived from the account otherwise."),
        new FormField("clientSessionKeepAlive", "Keep session alive", "bool", Default: JsonValue.Create(false),
            Help: "Heartbeats keep idle tabs logged in beyond the 4-hour session timeout."),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
        new FormField("queryTag", "Query tag", "text", Default: JsonValue.Create(DefaultQueryTag),
            Help: "QUERY_TAG of every statement (shows in QUERY_HISTORY)."),
    ]);

    /// <summary>The connection string plus the secrets that travel as <see cref="SecureString"/> properties.</summary>
    public sealed record Built(string ConnectionString, SecureString? Password, SecureString? Token, string Authenticator, string Account);

    /// <summary>
    /// <c>xy12345.eu-central-1.snowflakecomputing.com</c>, <c>https://org-acct.snowflakecomputing.com/</c> → the account
    /// identifier and, for URLs with a custom host part, the host.
    /// </summary>
    public static (string Account, string? Host) NormalizeAccount(string? account, string? host)
    {
        var a = (account ?? "").Trim();
        var h = string.IsNullOrWhiteSpace(host) ? null : host.Trim();
        if (a.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) a = a[8..];
        else if (a.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) a = a[7..];
        var slash = a.IndexOf('/');
        if (slash >= 0) a = a[..slash];
        const string suffix = ".snowflakecomputing.com";
        if (a.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            var full = a;
            a = a[..^suffix.Length];
            if (a.Contains(".privatelink", StringComparison.OrdinalIgnoreCase)) h ??= full;
        }
        if (h is not null && h.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) h = h[8..].TrimEnd('/');
        return (a, h);
    }

    public static string AuthenticatorOf(ConnectionProfile profile)
    {
        var a = (profile.GetString("authenticator") ?? SnowflakeAuth.Password).Trim().ToLowerInvariant();
        return a switch
        {
            "" or "password" or "snowflake" => SnowflakeAuth.Password,
            "snowflake_jwt" or "jwt" or "keypair" or "key_pair" => SnowflakeAuth.KeyPair,
            "externalbrowser" or "sso" or "browser" => SnowflakeAuth.Browser,
            "oauth" => SnowflakeAuth.OAuth,
            var v => throw new ArgumentException($"Unsupported authenticator '{v}' (snowflake, snowflake_jwt, externalbrowser, oauth)."),
        };
    }

    /// <summary>
    /// Builds the Snowflake.Data connection string. <paramref name="pooling"/> = false for tab sessions. <paramref name="database"/>
    /// overrides the profile's database (the session opens on it). Validates the authenticator's required fields.
    /// </summary>
    public static Built Build(ConnectionProfile profile, string? password, bool pooling, string? database = null, string? application = null)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var (account, host) = NormalizeAccount(profile.GetString("account"), profile.GetString("host"));
        if (account.Length == 0) throw new ArgumentException("Account is required (e.g. orgname-accountname or xy12345.eu-central-1).", nameof(profile));
        var auth = AuthenticatorOf(profile);
        var user = profile.GetString("user")?.Trim();

        var parts = new List<(string Key, string Value)>
        {
            ("account", account),
            ("authenticator", auth),
        };
        if (host is not null) parts.Add(("host", host));
        if (!string.IsNullOrEmpty(user)) parts.Add(("user", user));
        SecureString? securePassword = null, secureToken = null;
        switch (auth)
        {
            case SnowflakeAuth.Password:
                if (string.IsNullOrEmpty(user)) throw new ArgumentException("User is required for password authentication.", nameof(profile));
                if (string.IsNullOrEmpty(password)) throw new ArgumentException("Password is required for password authentication.", nameof(profile));
                securePassword = Secure(password);
                break;
            case SnowflakeAuth.KeyPair:
            {
                if (string.IsNullOrEmpty(user)) throw new ArgumentException("User is required for key-pair authentication.", nameof(profile));
                var file = profile.GetString("privateKeyFile")?.Trim();
                if (string.IsNullOrEmpty(file)) throw new ArgumentException("Private key file is required for key-pair authentication.", nameof(profile));
                if (!File.Exists(file)) throw new ArgumentException($"Private key file '{file}' was not found.", nameof(profile));
                parts.Add(("private_key_file", file));
                var passphrase = profile.GetString("privateKeyPassphrase");
                if (!string.IsNullOrEmpty(passphrase)) parts.Add(("private_key_pwd", passphrase));
                break;
            }
            case SnowflakeAuth.Browser:
                if (string.IsNullOrEmpty(user)) throw new ArgumentException("User (your SSO login name) is required for browser SSO.", nameof(profile));
                // ID-token caching (in the engine's in-memory credential manager, see SnowflakeDriver): one browser
                // round trip per engine run instead of one per tab/catalog connection, when the account allows it
                // (ALTER ACCOUNT SET ALLOW_ID_TOKEN = TRUE).
                parts.Add(("client_store_temporary_credential", "true"));
                break;
            case SnowflakeAuth.OAuth:
            {
                var token = profile.GetString("token");
                if (string.IsNullOrEmpty(token)) token = password; // a token saved in the main password slot
                if (string.IsNullOrEmpty(token)) throw new ArgumentException("An OAuth access token is required.", nameof(profile));
                secureToken = Secure(token);
                break;
            }
        }

        var db = FirstNonEmpty(database, profile.GetString("database"));
        if (db is not null) parts.Add(("db", db));
        var schema = FirstNonEmpty(profile.GetString("schema"));
        if (schema is not null) parts.Add(("schema", schema));
        var warehouse = FirstNonEmpty(profile.GetString("warehouse"));
        if (warehouse is not null) parts.Add(("warehouse", warehouse));
        var role = FirstNonEmpty(profile.GetString("role"));
        if (role is not null) parts.Add(("role", role));

        var timeout = Math.Clamp(profile.GetInt("connectTimeout", DefaultConnectTimeout), 5, 3600);
        parts.Add(("connection_timeout", timeout.ToString(CultureInfo.InvariantCulture)));
        if (auth == SnowflakeAuth.Browser) parts.Add(("browser_response_timeout", Math.Max(timeout, 120).ToString(CultureInfo.InvariantCulture)));
        if (profile.GetBool("clientSessionKeepAlive")) parts.Add(("client_session_keep_alive", "true"));
        parts.Add(("query_tag", FirstNonEmpty(profile.GetString("queryTag")) ?? DefaultQueryTag));
        parts.Add(("application", application ?? ApplicationName));
        parts.Add(("poolingEnabled", pooling ? "true" : "false"));
        // Privacy: the driver's client telemetry (on by default since 5.6) stays off.
        parts.Add(("CLIENT_TELEMETRY_ENABLED", "false"));

        var sb = new StringBuilder();
        foreach (var (key, value) in parts)
        {
            if (sb.Length > 0) sb.Append(';');
            sb.Append(key).Append('=').Append(Escape(value));
        }
        return new Built(sb.ToString(), securePassword, secureToken, auth, account);
    }

    /// <summary>Snowflake.Data splits the connection string on <c>;</c>; a literal semicolon is written doubled.</summary>
    public static string Escape(string value) => value.Replace(";", ";;", StringComparison.Ordinal);

    private static SecureString Secure(string value)
    {
        var s = new SecureString();
        foreach (var c in value) s.AppendChar(c);
        s.MakeReadOnly();
        return s;
    }

    /// <summary>The connection string with secrets masked (logs, BuildConnectionString).</summary>
    public static string Masked(Built built) =>
        string.Join(';', built.ConnectionString.Split(';').Select(p =>
            p.StartsWith("private_key_pwd=", StringComparison.OrdinalIgnoreCase) ? "private_key_pwd=***" : p));

    private static string? FirstNonEmpty(params string?[] values) =>
        values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
