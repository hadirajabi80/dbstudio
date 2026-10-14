using System.Globalization;
using System.Security.Cryptography;

namespace DbStudio.Host;

/// <summary>
/// Command line of the engine: <c>--port N</c> (0/absent = random free port), <c>--token T</c>, <c>--dev</c>
/// (CORS for the Vite dev server, default token "dev-token", console logs on stderr), <c>--parent-pid P</c>
/// (exit when that process ends).
/// </summary>
public sealed class EngineOptions
{
    public const string DevToken = "dev-token";

    public int Port { get; init; }
    public string Token { get; init; } = "";
    public bool Dev { get; init; }
    public int? ParentPid { get; init; }

    /// <summary>Origins allowed by CORS and for WebSocket upgrades.</summary>
    public IReadOnlySet<string> AllowedOrigins => Dev
        ? new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "dbstudio://app", "http://localhost:5173", "http://127.0.0.1:5173" }
        : new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "dbstudio://app" };

    /// <summary>
    /// CORS / WebSocket origin check. Always allows the fixed <see cref="AllowedOrigins"/>; with <c>--dev</c> also any
    /// <c>http://localhost:&lt;port&gt;</c> or <c>http://127.0.0.1:&lt;port&gt;</c> (Vite on any port).
    /// </summary>
    public bool IsOriginAllowed(string? origin)
    {
        if (string.IsNullOrEmpty(origin)) return false;
        if (AllowedOrigins.Contains(origin)) return true;
        if (!Dev || !Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme == Uri.UriSchemeHttp
            && (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || uri.Host == "127.0.0.1")
            && uri.AbsolutePath == "/" && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.UserInfo)
            && origin.TrimEnd('/').Equals($"{uri.Scheme}://{uri.Authority}", StringComparison.OrdinalIgnoreCase);
    }

    public static EngineOptions Parse(string[] args)
    {
        int port = 0;
        string? token = null;
        var dev = false;
        int? parentPid = null;
        for (var i = 0; i < args.Length; i++)
        {
            var a = args[i];
            string? Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value for {a}.");
            switch (a)
            {
                case "--port":
                    port = int.Parse(Next()!, CultureInfo.InvariantCulture);
                    if (port is < 0 or > 65535) throw new ArgumentException("--port must be between 0 and 65535.");
                    break;
                case "--token":
                    token = Next();
                    break;
                case "--dev":
                    dev = true;
                    break;
                case "--parent-pid":
                    parentPid = int.Parse(Next()!, CultureInfo.InvariantCulture);
                    break;
                default:
                    if (a.StartsWith("--port=", StringComparison.Ordinal)) port = int.Parse(a[7..], CultureInfo.InvariantCulture);
                    else if (a.StartsWith("--token=", StringComparison.Ordinal)) token = a[8..];
                    else if (a.StartsWith("--parent-pid=", StringComparison.Ordinal)) parentPid = int.Parse(a[13..], CultureInfo.InvariantCulture);
                    // Unknown arguments are ignored so launchers can add their own.
                    break;
            }
        }
        token = string.IsNullOrWhiteSpace(token) ? (dev ? DevToken : NewToken()) : token;
        return new EngineOptions { Port = port, Token = token, Dev = dev, ParentPid = parentPid };
    }

    /// <summary>32 random bytes, base64url without padding.</summary>
    public static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
