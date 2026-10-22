using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// The connection settings of a Kafka profile (docs/PLAN-M2.md 7.1), validated. Secrets: <c>password</c> (SASL) comes
/// from the secret store as the main password; <c>sslKeyPassword</c> and <c>schemaRegistrySecret</c> are restored into
/// the profile props by ConnectionStore.WithSecrets (D12).
/// </summary>
public sealed record KafkaSettings
{
    public static readonly string[] Protocols = ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"];
    public static readonly string[] Mechanisms = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER"];

    public required string BootstrapServers { get; init; }
    public string SecurityProtocol { get; init; } = "PLAINTEXT";
    public string SaslMechanism { get; init; } = "PLAIN";
    public string? User { get; init; }
    public string? Password { get; init; }
    public string? SslCaLocation { get; init; }
    public string? SslCertLocation { get; init; }
    public string? SslKeyLocation { get; init; }
    public string? SslKeyPassword { get; init; }
    public string? SchemaRegistryUrl { get; init; }
    public string? SchemaRegistryUser { get; init; }
    public string? SchemaRegistrySecret { get; init; }
    public string ClientId { get; init; } = "Rowlit";
    public int RequestTimeoutMs { get; init; } = 15000;
    public IReadOnlyDictionary<string, string> Extra { get; init; } = new Dictionary<string, string>();

    public bool UsesSasl => SecurityProtocol.StartsWith("SASL_", StringComparison.Ordinal);
    public bool UsesSsl => SecurityProtocol is "SSL" or "SASL_SSL";
    public bool HasSchemaRegistry => !string.IsNullOrWhiteSpace(SchemaRegistryUrl);
    public string FirstBootstrap => BootstrapServers.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? BootstrapServers;

    /// <summary>Reads and validates a profile; 400 VALIDATION naming the field on bad input.</summary>
    public static KafkaSettings From(ConnectionProfile profile, string? password)
    {
        var bootstrap = profile.GetString("bootstrapServers")?.Trim();
        if (string.IsNullOrEmpty(bootstrap))
            throw EngineException.Validation("Bootstrap servers are required (host:9092,host2:9092).", new { field = "bootstrapServers" });
        foreach (var server in bootstrap.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var colon = server.LastIndexOf(':');
            if (colon <= 0 || !int.TryParse(server[(colon + 1)..], out var port) || port is < 1 or > 65535)
                throw EngineException.Validation($"Bootstrap server '{server}' must be host:port.", new { field = "bootstrapServers" });
        }

        var protocol = (profile.GetString("securityProtocol") ?? "PLAINTEXT").Trim().ToUpperInvariant();
        if (!Protocols.Contains(protocol))
            throw EngineException.Validation($"Unknown security protocol '{protocol}'.", new { field = "securityProtocol" });
        var mechanism = (profile.GetString("saslMechanism") ?? "PLAIN").Trim().ToUpperInvariant();
        if (!Mechanisms.Contains(mechanism))
            throw EngineException.Validation($"Unknown SASL mechanism '{mechanism}'.", new { field = "saslMechanism" });

        var user = Blank(profile.GetString("user"));
        if (protocol.StartsWith("SASL_", StringComparison.Ordinal) && mechanism != "OAUTHBEARER" && user is null)
            throw EngineException.Validation("A SASL user is required for SASL_PLAINTEXT / SASL_SSL.", new { field = "user" });

        var timeout = profile.GetInt("requestTimeoutMs", 15000);
        if (timeout is < 1000 or > 300_000)
            throw EngineException.Validation("Request timeout must be between 1000 and 300000 ms.", new { field = "requestTimeoutMs" });

        var registry = Blank(profile.GetString("schemaRegistryUrl"));
        if (registry is not null && (!Uri.TryCreate(registry, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https")))
            throw EngineException.Validation("Schema Registry URL must be an http(s) URL.", new { field = "schemaRegistryUrl" });

        return new KafkaSettings
        {
            BootstrapServers = bootstrap,
            SecurityProtocol = protocol,
            SaslMechanism = mechanism,
            User = user,
            Password = password ?? Blank(profile.GetString("password")),
            SslCaLocation = Blank(profile.GetString("sslCaLocation")),
            SslCertLocation = Blank(profile.GetString("sslCertLocation")),
            SslKeyLocation = Blank(profile.GetString("sslKeyLocation")),
            SslKeyPassword = Blank(profile.GetString("sslKeyPassword")),
            SchemaRegistryUrl = registry?.TrimEnd('/'),
            SchemaRegistryUser = Blank(profile.GetString("schemaRegistryUser")),
            SchemaRegistrySecret = Blank(profile.GetString("schemaRegistrySecret")),
            ClientId = Blank(profile.GetString("clientId")) ?? "Rowlit",
            RequestTimeoutMs = timeout,
            Extra = ParseExtra(profile.GetString("extra")),
        };
    }

    /// <summary><c>key=value;key2=value2</c> (newlines also separate). 400 VALIDATION (field extra) on a malformed pair.</summary>
    public static IReadOnlyDictionary<string, string> ParseExtra(string? extra)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(extra)) return result;
        foreach (var raw in extra.Split([';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = raw.IndexOf('=');
            if (eq <= 0) throw EngineException.Validation($"Extra setting '{raw}' must be key=value.", new { field = "extra" });
            var key = raw[..eq].Trim();
            if (key.Contains("password", StringComparison.OrdinalIgnoreCase) || key.Contains("secret", StringComparison.OrdinalIgnoreCase))
                throw EngineException.Validation($"Extra setting '{key}' looks like a secret; use the password fields (they are kept in the OS secret store).",
                    new { field = "extra" });
            result[key] = raw[(eq + 1)..].Trim();
        }
        return result;
    }

    /// <summary>The librdkafka configuration (bootstrap, security, timeouts, extra) shared by admin, consumers and producers.</summary>
    public Dictionary<string, string> ToClientConfig()
    {
        var c = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["bootstrap.servers"] = BootstrapServers,
            ["client.id"] = ClientId,
            ["security.protocol"] = SecurityProtocol.ToLowerInvariant(),
            ["socket.timeout.ms"] = RequestTimeoutMs.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["socket.connection.setup.timeout.ms"] = Math.Min(RequestTimeoutMs, 30_000).ToString(System.Globalization.CultureInfo.InvariantCulture),
            // Do not spin on unreachable brokers for ever: back off quickly up to 5 s.
            ["reconnect.backoff.max.ms"] = "5000",
            ["log.connection.close"] = "false",
        };
        if (UsesSasl)
        {
            c["sasl.mechanism"] = SaslMechanism;
            if (User is not null) c["sasl.username"] = User;
            if (Password is not null) c["sasl.password"] = Password;
        }
        if (UsesSsl)
        {
            if (SslCaLocation is not null) c["ssl.ca.location"] = SslCaLocation;
            if (SslCertLocation is not null) c["ssl.certificate.location"] = SslCertLocation;
            if (SslKeyLocation is not null) c["ssl.key.location"] = SslKeyLocation;
            if (SslKeyPassword is not null) c["ssl.key.password"] = SslKeyPassword;
        }
        foreach (var (k, v) in Extra) c[k] = v;
        return c;
    }

    /// <summary>Config for logs and the walkthrough: secrets masked.</summary>
    public IReadOnlyDictionary<string, string> Describe() =>
        ToClientConfig().ToDictionary(kv => kv.Key, kv => kv.Key.Contains("password", StringComparison.Ordinal) ? "********" : kv.Value);

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
