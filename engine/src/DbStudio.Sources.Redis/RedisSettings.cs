using System.Net;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis;

public enum RedisMode { Standalone, Cluster, Sentinel }

/// <summary>
/// The connection profile of a Redis source, validated (docs/PLAN-M2.md 5.1). Built once per open; also used by
/// <see cref="RawRedisConnection"/> (MONITOR, transactions, blocking commands) to reach the same server.
/// </summary>
public sealed record RedisSettings(
    RedisMode Mode,
    IReadOnlyList<(string Host, int Port)> Endpoints,
    string? ServiceName,
    string? User,
    string? Password,
    int Database,
    bool Tls,
    bool TlsSkipVerify,
    string KeyDelimiter,
    int ScanCount,
    int ConnectTimeoutSeconds)
{
    public const int DefaultPort = 6379;
    public const int DefaultSentinelPort = 26379;

    public static RedisSettings From(ConnectionProfile p, string? password)
    {
        var modeText = (p.GetString("mode") ?? "standalone").Trim().ToLowerInvariant();
        var mode = modeText switch
        {
            "standalone" or "" => RedisMode.Standalone,
            "cluster" => RedisMode.Cluster,
            "sentinel" => RedisMode.Sentinel,
            _ => throw EngineException.Validation($"Unknown Redis mode '{modeText}' (standalone, cluster or sentinel).", new { field = "mode" }),
        };

        List<(string, int)> endpoints;
        switch (mode)
        {
            case RedisMode.Standalone:
                var host = p.GetString("host")?.Trim();
                if (string.IsNullOrEmpty(host)) throw EngineException.Validation("Host is required.", new { field = "host" });
                var port = p.GetInt("port", DefaultPort);
                // "host:port" typed into the host field wins over the port field (IPv6 needs [brackets]).
                endpoints = (host.StartsWith('[') || host.Count(c => c == ':') == 1) && TryParseEndpoint(host, port, out var hp)
                    ? [hp]
                    : [(host, port)];
                break;
            case RedisMode.Cluster:
                endpoints = ParseList(p.GetList("nodes"), DefaultPort, "nodes");
                if (endpoints.Count == 0) throw EngineException.Validation("Cluster nodes are required (host:port, ...).", new { field = "nodes" });
                break;
            default:
                endpoints = ParseList(p.GetList("sentinels"), DefaultSentinelPort, "sentinels");
                if (endpoints.Count == 0) throw EngineException.Validation("Sentinels are required (host:port, ...).", new { field = "sentinels" });
                break;
        }
        foreach (var (_, port) in endpoints)
            if (port is < 1 or > 65535) throw EngineException.Validation($"Port {port} is out of range.", new { field = "port" });

        var db = mode == RedisMode.Cluster ? 0 : p.GetInt("db", 0);
        if (db is < 0 or > 10_000) throw EngineException.Validation("Database must be between 0 and the server's database count.", new { field = "db" });
        var delimiter = p.GetString("keyDelimiter");
        var scanCount = Math.Clamp(p.GetInt("scanCount", 500), 10, 10_000);
        var timeout = Math.Clamp(p.GetInt("connectTimeout", 5), 1, 120);
        var user = p.GetString("user")?.Trim();
        var service = p.GetString("serviceName")?.Trim();
        return new RedisSettings(mode, endpoints, mode == RedisMode.Sentinel ? (string.IsNullOrEmpty(service) ? "mymaster" : service) : null,
            string.IsNullOrEmpty(user) ? null : user, string.IsNullOrEmpty(password) ? null : password, db,
            p.GetBool("tls"), p.GetBool("tlsSkipVerify"), string.IsNullOrEmpty(delimiter) ? ":" : delimiter, scanCount, timeout);
    }

    private static List<(string, int)> ParseList(IReadOnlyList<string> items, int defaultPort, string field)
    {
        var list = new List<(string, int)>();
        foreach (var raw in items.SelectMany(i => i.Split([',', ' ', ';', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
        {
            if (!TryParseEndpoint(raw, defaultPort, out var ep))
                throw EngineException.Validation($"'{raw}' is not a host:port endpoint.", new { field });
            list.Add(ep);
        }
        return list;
    }

    internal static bool TryParseEndpoint(string text, int defaultPort, out (string Host, int Port) endpoint)
    {
        endpoint = default;
        text = text.Trim();
        if (text.Length == 0) return false;
        string host;
        var port = defaultPort;
        if (text.StartsWith('['))
        {
            var close = text.IndexOf(']');
            if (close < 0) return false;
            host = text[1..close];
            var rest = text[(close + 1)..];
            if (rest.StartsWith(':') && !int.TryParse(rest[1..], out port)) return false;
        }
        else
        {
            var colon = text.LastIndexOf(':');
            if (colon > 0 && text.IndexOf(':') == colon)
            {
                host = text[..colon];
                if (!int.TryParse(text[(colon + 1)..], out port)) return false;
            }
            else host = text;
        }
        if (host.Length == 0 || port is < 1 or > 65535) return false;
        endpoint = (host, port);
        return true;
    }

    /// <summary>StackExchange.Redis options (docs/PLAN-M2.md 5.1 BuildConfiguration).</summary>
    public ConfigurationOptions BuildConfiguration()
    {
        var o = new ConfigurationOptions
        {
            User = User,
            Password = Password,
            Ssl = Tls,
            AbortOnConnectFail = false,
            ConnectTimeout = ConnectTimeoutSeconds * 1000,
            SyncTimeout = Math.Max(5000, ConnectTimeoutSeconds * 1000),
            AsyncTimeout = Math.Max(10_000, ConnectTimeoutSeconds * 2000),
            ConnectRetry = 1,
            ClientName = "Rowlit",
            AllowAdmin = true,
            DefaultDatabase = Mode == RedisMode.Cluster ? null : Database,
            KeepAlive = 30,
            // The engine is long-lived and shared: reconnect quietly in the background.
            ReconnectRetryPolicy = new ExponentialRetry(500, 10_000),
        };
        foreach (var (host, port) in Endpoints)
        {
            if (IPAddress.TryParse(host, out var ip)) o.EndPoints.Add(new IPEndPoint(ip, port));
            else o.EndPoints.Add(host, port);
        }
        if (Tls)
        {
            o.SslHost = Endpoints[0].Host;
            if (TlsSkipVerify) o.CertificateValidation += (_, _, _, _) => true;
        }
        if (Mode == RedisMode.Sentinel)
        {
            o.ServiceName = ServiceName;
            o.TieBreaker = "";
        }
        return o;
    }

    public string Describe() => Mode switch
    {
        RedisMode.Standalone => $"{Endpoints[0].Host}:{Endpoints[0].Port}",
        RedisMode.Cluster => $"cluster {string.Join(",", Endpoints.Select(e => $"{e.Host}:{e.Port}"))}",
        _ => $"sentinel {ServiceName} via {string.Join(",", Endpoints.Select(e => $"{e.Host}:{e.Port}"))}",
    };
}
