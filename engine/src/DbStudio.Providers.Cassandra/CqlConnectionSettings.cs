using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Cassandra;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Connection settings of a Cassandra / ScyllaDB profile (plan-batch3 WP-CS): the connection-dialog form spec and the
/// parsed values the cluster builder and the sessions use.
/// </summary>
public sealed record CqlConnectionSettings
{
    public const int DefaultPort = 9042;
    public const int DefaultPageSize = 1000;
    public const int MaxPageSize = 10_000;
    public const int DefaultConnectTimeoutSeconds = 10;
    public const int DefaultRequestTimeoutSeconds = 30;
    public const string DefaultConsistency = "LOCAL_QUORUM";
    public const string DefaultSerialConsistency = "SERIAL";

    public IReadOnlyList<string> ContactPoints { get; init; } = [];
    public int Port { get; init; } = DefaultPort;
    /// <summary>Local datacenter of the load-balancing policy; null = the datacenter of the first contact point.</summary>
    public string? LocalDc { get; init; }
    public string? Keyspace { get; init; }
    public string? User { get; init; }
    public bool Ssl { get; init; }
    public bool SslSkipVerify { get; init; }
    public string? CaFile { get; init; }
    public ConsistencyLevel Consistency { get; init; } = ConsistencyLevel.LocalQuorum;
    public ConsistencyLevel SerialConsistency { get; init; } = ConsistencyLevel.Serial;
    public int PageSize { get; init; } = DefaultPageSize;
    public int ConnectTimeoutSeconds { get; init; } = DefaultConnectTimeoutSeconds;
    public int RequestTimeoutSeconds { get; init; } = DefaultRequestTimeoutSeconds;
    /// <summary>DataStax Astra secure connect bundle (zip); replaces contact points, port and SSL.</summary>
    public string? CloudSecureBundle { get; init; }
    public bool ShowSystemKeyspaces { get; init; }

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("contactPoints", "Contact points", "text", Required: true, Placeholder: "localhost, 10.0.0.2",
            Help: "Hosts or IP addresses of one or more nodes, separated by commas (host:port is accepted).",
            VisibleWhen: null),
        new FormField("port", "Port", "number", Default: JsonValue.Create(DefaultPort)),
        new FormField("localDc", "Local datacenter", "text", Placeholder: "datacenter1",
            Help: "Queries go to this datacenter's nodes first. Empty: the datacenter of the first contact point."),
        new FormField("keyspace", "Keyspace", "text", Placeholder: "shop", Help: "Keyspace a new console starts in (USE)."),
        new FormField("user", "User", "text", Help: "Empty for clusters without authentication."),
        new FormField("password", "Password", "password"),
        new FormField("ssl", "Use SSL/TLS", "bool", Default: JsonValue.Create(false)),
        new FormField("sslSkipVerify", "Skip certificate verification", "bool", Default: JsonValue.Create(false),
            VisibleWhen: new Dictionary<string, string> { ["ssl"] = "true" }, Help: "Accept self-signed certificates."),
        new FormField("caFile", "CA certificate", "file", VisibleWhen: new Dictionary<string, string> { ["ssl"] = "true" },
            FileFilter: "Certificates|*.pem;*.crt;*.cer", Help: "Trust this certificate authority (PEM)."),
        new FormField("consistency", "Consistency", "select", Default: JsonValue.Create(DefaultConsistency),
            Options: ConsistencyOptions(includeSerial: false), Help: "Default consistency level of the consoles (CONSISTENCY in cqlsh)."),
        new FormField("serialConsistency", "Serial consistency", "select", Default: JsonValue.Create(DefaultSerialConsistency),
            Options: [new FormOption("SERIAL", "SERIAL"), new FormOption("LOCAL_SERIAL", "LOCAL_SERIAL")],
            Help: "Consistency of the Paxos phase of lightweight transactions (IF …)."),
        new FormField("pageSize", "Page size", "number", Default: JsonValue.Create(DefaultPageSize),
            Help: "Rows fetched per round trip (PAGING in cqlsh)."),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeoutSeconds)),
        new FormField("requestTimeout", "Request timeout (s)", "number", Default: JsonValue.Create(DefaultRequestTimeoutSeconds),
            Help: "Client-side timeout of one request (the server has its own read/write timeouts)."),
        new FormField("cloudSecureBundle", "Secure connect bundle", "file", FileFilter: "Secure connect bundle|*.zip",
            Help: "DataStax Astra: the bundle replaces contact points, port and SSL."),
        new FormField("showSystemKeyspaces", "Show system keyspaces", "bool", Default: JsonValue.Create(false),
            Help: "List system, system_schema, system_traces … in the explorer."),
    ]);

    public static IReadOnlyList<FormOption> ConsistencyOptions(bool includeSerial)
    {
        var names = new List<string> { "ONE", "TWO", "THREE", "QUORUM", "ALL", "LOCAL_ONE", "LOCAL_QUORUM", "EACH_QUORUM", "ANY" };
        if (includeSerial) names.AddRange(["SERIAL", "LOCAL_SERIAL"]);
        return names.Select(n => new FormOption(n, n)).ToList();
    }

    /// <summary>Parses a profile. Throws <see cref="ArgumentException"/> for missing contact points or invalid values.</summary>
    public static CqlConnectionSettings From(ConnectionProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var bundle = Blank(profile.GetString("cloudSecureBundle"));
        var points = profile.GetList("contactPoints").Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
        if (points.Count == 0)
        {
            // Older profiles / API callers may use "host".
            var host = Blank(profile.GetString("host"));
            if (host is not null) points.AddRange(host.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }
        if (points.Count == 0 && bundle is null) throw new ArgumentException("Contact points are required.", nameof(profile));
        var port = profile.GetInt("port", DefaultPort);
        if (port is < 1 or > 65535) throw new ArgumentException($"Port {port} is out of range (1-65535).", nameof(profile));
        return new CqlConnectionSettings
        {
            ContactPoints = points,
            Port = port,
            LocalDc = Blank(profile.GetString("localDc")),
            Keyspace = Blank(profile.GetString("keyspace")),
            User = Blank(profile.GetString("user")),
            Ssl = profile.GetBool("ssl"),
            SslSkipVerify = profile.GetBool("sslSkipVerify"),
            CaFile = Blank(profile.GetString("caFile")),
            Consistency = ParseConsistency(profile.GetString("consistency"), ConsistencyLevel.LocalQuorum),
            SerialConsistency = ParseConsistency(profile.GetString("serialConsistency"), ConsistencyLevel.Serial) is var s
                                && s is ConsistencyLevel.Serial or ConsistencyLevel.LocalSerial ? s : ConsistencyLevel.Serial,
            PageSize = Math.Clamp(profile.GetInt("pageSize", DefaultPageSize), 1, MaxPageSize),
            ConnectTimeoutSeconds = Math.Clamp(profile.GetInt("connectTimeout", DefaultConnectTimeoutSeconds), 1, 600),
            RequestTimeoutSeconds = Math.Clamp(profile.GetInt("requestTimeout", DefaultRequestTimeoutSeconds), 1, 86_400),
            CloudSecureBundle = bundle,
            ShowSystemKeyspaces = profile.GetBool("showSystemKeyspaces"),
        };
    }

    /// <summary>"LOCAL_QUORUM", "local_quorum", "LocalQuorum" → <see cref="ConsistencyLevel.LocalQuorum"/>; else <paramref name="fallback"/>.</summary>
    public static ConsistencyLevel ParseConsistency(string? text, ConsistencyLevel fallback) =>
        TryParseConsistency(text, out var level) ? level : fallback;

    public static bool TryParseConsistency(string? text, out ConsistencyLevel level)
    {
        level = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var key = text.Trim().Replace("_", "", StringComparison.Ordinal).Replace("-", "", StringComparison.Ordinal);
        return Enum.TryParse(key, ignoreCase: true, out level) && Enum.IsDefined(level);
    }

    /// <summary><see cref="ConsistencyLevel.LocalQuorum"/> → "LOCAL_QUORUM" (cqlsh spelling).</summary>
    public static string ConsistencyName(ConsistencyLevel level) => level switch
    {
        ConsistencyLevel.Any => "ANY",
        ConsistencyLevel.One => "ONE",
        ConsistencyLevel.Two => "TWO",
        ConsistencyLevel.Three => "THREE",
        ConsistencyLevel.Quorum => "QUORUM",
        ConsistencyLevel.All => "ALL",
        ConsistencyLevel.LocalQuorum => "LOCAL_QUORUM",
        ConsistencyLevel.EachQuorum => "EACH_QUORUM",
        ConsistencyLevel.Serial => "SERIAL",
        ConsistencyLevel.LocalSerial => "LOCAL_SERIAL",
        ConsistencyLevel.LocalOne => "LOCAL_ONE",
        _ => level.ToString().ToUpperInvariant(),
    };

    /// <summary>
    /// Identity of the cluster connection: two profiles (or two edits of one profile) share a driver <c>Cluster</c> only
    /// when every connection-level value and the password match.
    /// </summary>
    public string Fingerprint(string? password)
    {
        var sb = new StringBuilder();
        sb.Append(string.Join(",", ContactPoints)).Append('|').Append(Port.ToString(CultureInfo.InvariantCulture)).Append('|')
            .Append(LocalDc).Append('|').Append(User).Append('|').Append(Ssl).Append('|').Append(SslSkipVerify).Append('|')
            .Append(CaFile).Append('|').Append(CloudSecureBundle).Append('|')
            .Append(ConnectTimeoutSeconds.ToString(CultureInfo.InvariantCulture)).Append('|')
            .Append(RequestTimeoutSeconds.ToString(CultureInfo.InvariantCulture)).Append('|').Append(password);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())));
    }

    /// <summary>Human-readable description used as the "connection string" (no password).</summary>
    public string Describe()
    {
        var target = CloudSecureBundle is not null ? $"bundle={Path.GetFileName(CloudSecureBundle)}" : $"{string.Join(",", ContactPoints)}:{Port}";
        var parts = new List<string> { $"cql://{target}" };
        if (Keyspace is not null) parts.Add($"keyspace={Keyspace}");
        if (LocalDc is not null) parts.Add($"localDc={LocalDc}");
        if (User is not null) parts.Add($"user={User}");
        if (Ssl) parts.Add("ssl=true");
        parts.Add($"consistency={ConsistencyName(Consistency)}");
        return string.Join(";", parts);
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
