using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Text.Json.Nodes;
using ClickHouse.Driver;
using ClickHouse.Driver.ADO;
using DbStudio.Core.Models;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Form spec (plan-batch3 WP-CH) and client settings for ClickHouse over HTTP(S) (ClickHouse.Driver). The engine supplies
/// its own <see cref="HttpClient"/> (connect timeout, certificate policy, infinite request timeout, and
/// <see cref="ChHttpObserver"/> to read the <c>X-ClickHouse-Summary</c> of every response).
/// </summary>
public static class ChConnections
{
    public const int DefaultHttpPort = 8123;
    public const int DefaultHttpsPort = 8443;
    public const int DefaultConnectTimeout = 15;
    public const int DefaultSessionTimeout = 3600;
    public const string DefaultDatabase = "default";
    public const string DefaultUser = "default";

    public static ConnectionFormSpec FormSpec { get; } = new(
    [
        new FormField("host", "Host", "text", Required: true, Placeholder: "localhost"),
        new FormField("port", "Port", "number", Default: JsonValue.Create(DefaultHttpPort),
            Help: "HTTP interface port: 8123 (http) or 8443 (https). ClickHouse Cloud uses 8443."),
        new FormField("protocol", "Protocol", "select", Default: JsonValue.Create("http"),
            Options: [new FormOption("http", "HTTP"), new FormOption("https", "HTTPS")]),
        new FormField("database", "Database", "text", Default: JsonValue.Create(DefaultDatabase)),
        new FormField("user", "User", "text", Default: JsonValue.Create(DefaultUser)),
        new FormField("password", "Password", "password"),
        new FormField("compression", "Compression", "bool", Default: JsonValue.Create(true),
            Help: "Compress request and response bodies (gzip)."),
        new FormField("skipCertificateValidation", "Skip certificate validation", "bool", Default: JsonValue.Create(false),
            VisibleWhen: new Dictionary<string, string> { ["protocol"] = "https" },
            Help: "Accept self-signed or otherwise untrusted server certificates."),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(DefaultConnectTimeout)),
        new FormField("sessionTimeout", "Session timeout (s)", "number", Default: JsonValue.Create(DefaultSessionTimeout),
            Help: "How long the server keeps an idle console session (SET values, temporary tables)."),
        new FormField("settings", "Settings", "text", Placeholder: "max_threads=4, max_memory_usage=10000000000",
            Help: "Server settings applied to every query: key=value, separated by commas or new lines."),
        new FormField("commandTimeout", "Command timeout (s)", "number", Default: JsonValue.Create(0),
            Help: "0 = no limit (sent as max_execution_time when set)."),
    ]);

    /// <summary>"https" when the profile says so (or the port is 8443/443), else "http".</summary>
    public static string Protocol(ConnectionProfile profile)
    {
        var p = profile.GetString("protocol")?.Trim().ToLowerInvariant();
        if (p is "https" or "http") return p;
        var port = profile.GetInt("port", DefaultHttpPort);
        return port is DefaultHttpsPort or 443 ? "https" : "http";
    }

    public static string Host(ConnectionProfile profile)
    {
        var host = profile.GetString("host")?.Trim();
        if (string.IsNullOrEmpty(host)) throw new ArgumentException("Host is required.", nameof(profile));
        // Tolerate a pasted URL ("https://abc.clickhouse.cloud:8443").
        if (Uri.TryCreate(host, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https") return uri.Host;
        return host;
    }

    public static int Port(ConnectionProfile profile)
    {
        var fallback = Protocol(profile) == "https" ? DefaultHttpsPort : DefaultHttpPort;
        var host = profile.GetString("host")?.Trim();
        if (host is not null && Uri.TryCreate(host, UriKind.Absolute, out var uri) && !uri.IsDefaultPort && !profile.Props.ContainsKey("port"))
            fallback = uri.Port;
        var port = profile.GetInt("port", fallback);
        if (port is < 1 or > 65535) throw new ArgumentException($"Port {port} is out of range (1-65535).", nameof(profile));
        return port;
    }

    public static string Database(ConnectionProfile profile, string? database = null) =>
        FirstNonEmpty(database, profile.GetString("database")) ?? DefaultDatabase;

    public static string User(ConnectionProfile profile) => FirstNonEmpty(profile.GetString("user")) ?? DefaultUser;

    /// <summary>
    /// Parses the "settings" field: <c>key=value</c> pairs separated by commas, semicolons or new lines. Keys must be
    /// setting names (letters, digits, underscores); values keep their text (quotes around a value are removed).
    /// </summary>
    public static Dictionary<string, string> ParseSettings(string? text)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(text)) return result;
        foreach (var raw in text.Split([',', ';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = raw.IndexOf('=');
            if (eq <= 0) throw new ArgumentException($"Setting '{raw}' must be written as key=value.");
            var key = raw[..eq].Trim();
            var value = raw[(eq + 1)..].Trim();
            if (!IsSettingName(key)) throw new ArgumentException($"'{key}' is not a valid setting name.");
            if (value.Length >= 2 && (value[0] == '\'' && value[^1] == '\'' || value[0] == '"' && value[^1] == '"')) value = value[1..^1];
            result[key] = value;
        }
        return result;
    }

    public static bool IsSettingName(string key) =>
        key.Length > 0 && key.Length <= 128 && (char.IsAsciiLetter(key[0]) || key[0] == '_') && key.All(c => char.IsAsciiLetterOrDigit(c) || c == '_');

    /// <summary>
    /// Client settings for one connection. <paramref name="sessionId"/> non-null = an HTTP session (console tabs: SET and
    /// temporary tables persist; requests of one session are serialized by the server).
    /// </summary>
    public static ClickHouseClientSettings Settings(ConnectionProfile profile, string? password, string? database, string? sessionId, HttpClient http)
    {
        ArgumentNullException.ThrowIfNull(profile);
        var settings = new ClickHouseClientSettings
        {
            Host = Host(profile),
            Port = (ushort)Port(profile),
            Protocol = Protocol(profile),
            Database = Database(profile, database),
            Username = User(profile),
            Password = password ?? "",
            UseCompression = profile.GetBool("compression", true),
            UseSession = sessionId is not null,
            SessionId = sessionId,
            SkipServerCertificateValidation = profile.GetBool("skipCertificateValidation"),
            HttpClient = http,
            // The driver's JSON/variant modes send settings that servers before 24.10 reject (UNKNOWN_SETTING):
            // JSON columns are read as text instead.
            JsonReadMode = JsonReadMode.None,
            JsonWriteMode = JsonWriteMode.None,
            ApplicationInfo = new Dictionary<string, string> { ["Rowlit"] = "1" },
        };
        foreach (var (k, v) in ParseSettings(profile.GetString("settings"))) settings.CustomSettings[k] = v;
        if (sessionId is not null)
        {
            var timeout = Math.Clamp(profile.GetInt("sessionTimeout", DefaultSessionTimeout), 1, 86_400);
            settings.CustomSettings["session_timeout"] = timeout.ToString(CultureInfo.InvariantCulture);
        }
        // A read-only query is cancelled on the server as soon as its HTTP connection closes (cancel, row cap).
        settings.CustomSettings.TryAdd("cancel_http_readonly_queries_on_client_close", "1");
        return settings;
    }

    /// <summary>The "connection string" shown for diagnostics (no password).</summary>
    public static string Describe(ConnectionProfile profile, string? database = null) =>
        $"{Protocol(profile)}://{User(profile)}@{Host(profile)}:{Port(profile).ToString(CultureInfo.InvariantCulture)}/{Database(profile, database)}";

    private static string? FirstNonEmpty(params string?[] values) =>
        values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrEmpty(v));

    // ------------------------------------------------------------------ HTTP transport

    private static readonly ConcurrentDictionary<(bool Skip, int ConnectTimeout), SocketsHttpHandler> Handlers = new();

    /// <summary>Shared socket handler per (certificate policy, connect timeout); never disposed (process lifetime).</summary>
    public static SocketsHttpHandler SharedHandler(ConnectionProfile profile)
    {
        var skip = Protocol(profile) == "https" && profile.GetBool("skipCertificateValidation");
        var connect = Math.Clamp(profile.GetInt("connectTimeout", DefaultConnectTimeout), 1, 600);
        return Handlers.GetOrAdd((skip, connect), key =>
        {
            var h = new SocketsHttpHandler
            {
                ConnectTimeout = TimeSpan.FromSeconds(key.ConnectTimeout),
                PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
                PooledConnectionLifetime = TimeSpan.FromMinutes(5),
                AutomaticDecompression = DecompressionMethods.All,
                MaxConnectionsPerServer = 64,
            };
            if (key.Skip)
                h.SslOptions = new SslClientAuthenticationOptions { RemoteCertificateValidationCallback = static (_, _, _, _) => true };
            return h;
        });
    }

    /// <summary>An HTTP client over the shared handler with an observer of response headers; no request timeout (queries may run long).</summary>
    public static (HttpClient Http, ChHttpObserver Observer) CreateHttp(ConnectionProfile profile, HttpMessageHandler? inner = null)
    {
        var observer = new ChHttpObserver(inner ?? SharedHandler(profile));
        var http = new HttpClient(observer, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        return (http, observer);
    }

    /// <summary>Opens a connection (one HTTP round trip: SELECT 1). Throws the driver error on bad credentials or an unreachable host.</summary>
    public static async Task<ChConnection> OpenAsync(ConnectionProfile profile, string? password, string? database, string? sessionId,
        CancellationToken ct, HttpMessageHandler? inner = null)
    {
        var (http, observer) = CreateHttp(profile, inner);
        ClickHouseConnection? conn = null;
        try
        {
            conn = new ClickHouseConnection(Settings(profile, password, database, sessionId, http));
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return new ChConnection(conn, http, observer);
        }
        catch
        {
            if (conn is not null) await conn.DisposeAsync().ConfigureAwait(false);
            http.Dispose();
            throw;
        }
    }
}

/// <summary>A driver connection with the HTTP client it owns.</summary>
public sealed class ChConnection(ClickHouseConnection connection, HttpClient http, ChHttpObserver observer) : IAsyncDisposable
{
    public ClickHouseConnection Connection { get; } = connection;
    public ChHttpObserver Observer { get; } = observer;

    public async ValueTask DisposeAsync()
    {
        await Connection.DisposeAsync().ConfigureAwait(false);
        http.Dispose();
    }
}

/// <summary>The <c>X-ClickHouse-Summary</c> header of a response (counts of the finished query).</summary>
public sealed record ChSummary(long ReadRows, long ReadBytes, long WrittenRows, long WrittenBytes, long ResultRows, long ElapsedNs)
{
    public static ChSummary? Parse(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return null;
        try
        {
            var o = JsonNode.Parse(header) as JsonObject;
            if (o is null) return null;
            long L(string k) => o[k] is JsonValue v && (v.TryGetValue<long>(out var l) ||
                (v.TryGetValue<string>(out var s) && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out l))) ? l : 0;
            return new ChSummary(L("read_rows"), L("read_bytes"), L("written_rows"), L("written_bytes"), L("result_rows"), L("elapsed_ns"));
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Records the response headers of every request: the summary per <c>query_id</c> (bounded) and the query id the server
/// assigned. Also the seam for unit tests (a fake inner handler stands in for the server).
/// </summary>
public sealed class ChHttpObserver(HttpMessageHandler inner) : DelegatingHandler(inner)
{
    private readonly ConcurrentDictionary<string, ChSummary> _summaries = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _order = new();

    /// <summary>Requests sent so far (tests).</summary>
    public int RequestCount => _requests;
    private int _requests;

    public ChSummary? SummaryOf(string? queryId) => queryId is not null && _summaries.TryGetValue(queryId, out var s) ? s : null;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _requests);
        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var id = response.Headers.TryGetValues("X-ClickHouse-Query-Id", out var ids) ? ids.FirstOrDefault() : null;
        if (id is not null && response.Headers.TryGetValues("X-ClickHouse-Summary", out var values)
            && ChSummary.Parse(values.LastOrDefault()) is { } summary)
        {
            _summaries[id] = summary;
            _order.Enqueue(id);
            while (_order.Count > 256 && _order.TryDequeue(out var old)) _summaries.TryRemove(old, out _);
        }
        return response;
    }

    protected override void Dispose(bool disposing)
    {
        // The inner handler is shared by every connection of the process: never dispose it here.
    }
}
