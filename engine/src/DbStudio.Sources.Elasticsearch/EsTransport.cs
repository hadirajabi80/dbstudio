using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>One HTTP answer of Elasticsearch (any status).</summary>
public sealed class EsResponse(int status, string? reasonPhrase, string? contentType, byte[] body, long elapsedMs, bool truncated = false)
{
    public int Status { get; } = status;
    public string? ReasonPhrase { get; } = reasonPhrase;
    public string? ContentType { get; } = contentType;
    public byte[] Body { get; } = body;
    public long ElapsedMs { get; } = elapsedMs;
    public bool Truncated { get; } = truncated;
    public bool Ok => Status is >= 200 and < 300;

    public JsonElement Json()
    {
        if (Body.Length == 0) return JsonSerializer.SerializeToElement<object?>(null);
        using var doc = JsonDocument.Parse(Body);
        return doc.RootElement.Clone();
    }

    public string Text => Encoding.UTF8.GetString(Body);
}

/// <summary>
/// HTTP transport of one connection (plan-batch3 D4: plain HttpClient + System.Text.Json). Several URLs fail over on
/// connection errors and stick to the last node that answered; authentication headers per <see cref="EsSettings.Auth"/>;
/// TLS: skip verification or trust a CA file. Network failures and timeouts throw 503 SOURCE_UNAVAILABLE; HTTP error
/// statuses are returned (<see cref="SendAsync"/>) or mapped by <see cref="EsErrors"/> (the JSON helpers).
/// </summary>
public sealed class EsTransport : IDisposable
{
    /// <summary>Console answers are cut here.</summary>
    public const int MaxConsoleBytes = 5 * 1024 * 1024;

    private readonly EsSettings _settings;
    private readonly HttpClient _http;
    private readonly AuthenticationHeaderValue? _auth;
    private int _current;

    /// <param name="handler">Tests: a fake server (HttpMessageHandler); otherwise a SocketsHttpHandler from the settings.</param>
    public EsTransport(EsSettings settings, HttpMessageHandler? handler = null)
    {
        _settings = settings;
        _http = new HttpClient(handler ?? CreateHandler(settings), disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Rowlit");
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        _auth = AuthHeader(settings);
    }

    public EsSettings Settings => _settings;

    /// <summary>The base URL requests currently go to.</summary>
    public Uri CurrentUrl => _settings.Urls[Volatile.Read(ref _current) % _settings.Urls.Count];

    internal static AuthenticationHeaderValue? AuthHeader(EsSettings s) => s.Auth switch
    {
        "basic" => new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{s.User}:{s.Password}"))),
        // An "id:key" pair is encoded; an already encoded key is sent as is.
        "apiKey" => new AuthenticationHeaderValue("ApiKey", s.ApiKey!.Contains(':', StringComparison.Ordinal)
            ? Convert.ToBase64String(Encoding.UTF8.GetBytes(s.ApiKey)) : s.ApiKey),
        "bearer" => new AuthenticationHeaderValue("Bearer", s.Token),
        _ => null,
    };

    private static SocketsHttpHandler CreateHandler(EsSettings s)
    {
        var handler = new SocketsHttpHandler
        {
            ConnectTimeout = s.ConnectTimeout,
            PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            UseProxy = false,
        };
        if (s.TlsSkipVerify)
        {
            handler.SslOptions.RemoteCertificateValidationCallback = (_, _, _, _) => true;
        }
        else if (s.CaFile is { } caFile)
        {
            var roots = new X509Certificate2Collection();
            roots.ImportFromPemFile(caFile);
            if (roots.Count == 0) roots.Add(X509CertificateLoader.LoadCertificateFromFile(caFile));
            handler.SslOptions.RemoteCertificateValidationCallback = (_, cert, _, errors) =>
            {
                if (errors == SslPolicyErrors.None) return true;
                if (cert is null || (errors & SslPolicyErrors.RemoteCertificateNotAvailable) != 0) return false;
                using var chain = new X509Chain();
                chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                chain.ChainPolicy.CustomTrustStore.AddRange(roots);
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                // The CA file vouches for the chain; a host name mismatch still fails.
                return chain.Build(new X509Certificate2(cert)) && (errors & SslPolicyErrors.RemoteCertificateNameMismatch) == 0;
            };
        }
        return handler;
    }

    /// <summary>
    /// Sends one request to the current node, failing over to the next URL on connection errors. Any HTTP status is
    /// returned. <paramref name="maxBytes"/> cuts the body (console); null reads it whole.
    /// </summary>
    public async Task<EsResponse> SendAsync(HttpMethod method, string pathAndQuery, byte[]? body, string? contentType, CancellationToken ct,
        TimeSpan? timeout = null, int? maxBytes = null)
    {
        var urls = _settings.Urls;
        var start = Volatile.Read(ref _current);
        Exception? last = null;
        for (var attempt = 0; attempt < urls.Count; attempt++)
        {
            var index = (start + attempt) % urls.Count;
            var url = urls[index];
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(timeout ?? _settings.RequestTimeout);
            var sw = Stopwatch.StartNew();
            try
            {
                using var req = new HttpRequestMessage(method, new Uri(url, pathAndQuery.TrimStart('/')));
                if (_auth is not null) req.Headers.Authorization = _auth;
                if (body is not null)
                {
                    req.Content = new ByteArrayContent(body);
                    req.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType ?? "application/json");
                }
                using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, budget.Token).ConfigureAwait(false);
                var (bytes, truncated) = await ReadAsync(res, maxBytes, budget.Token).ConfigureAwait(false);
                Volatile.Write(ref _current, index);
                return new EsResponse((int)res.StatusCode, res.ReasonPhrase, res.Content.Headers.ContentType?.MediaType, bytes, sw.ElapsedMilliseconds, truncated);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException ex)
            {
                // Request timeout: do not resend (the request may have been executed); report it.
                throw EngineException.SourceUnavailable(
                    $"Elasticsearch at {url.Authority} did not answer within {(timeout ?? _settings.RequestTimeout).TotalSeconds:0} s.", new { url = url.ToString(), reason = ex.Message });
            }
            catch (HttpRequestException ex)
            {
                last = ex;
                if (IsTls(ex)) break; // the next node has the same certificate setup
            }
        }
        throw EngineException.SourceUnavailable(Describe(last), new { url = urls[start % urls.Count].ToString() });
    }

    private static async Task<(byte[], bool)> ReadAsync(HttpResponseMessage res, int? maxBytes, CancellationToken ct)
    {
        if (maxBytes is null) return (await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false), false);
        await using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var ms = new MemoryStream();
        var buffer = new byte[81920];
        var truncated = false;
        int n;
        while ((n = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            var room = maxBytes.Value - (int)ms.Length;
            if (n > room)
            {
                ms.Write(buffer, 0, Math.Max(0, room));
                truncated = true;
                break;
            }
            ms.Write(buffer, 0, n);
        }
        return (ms.ToArray(), truncated);
    }

    private static bool IsTls(Exception ex) => ex.GetBaseException() is AuthenticationException || ex.InnerException is AuthenticationException;

    internal string Describe(Exception? ex)
    {
        var hosts = string.Join(", ", _settings.Urls.Select(u => u.Authority));
        if (ex is null) return $"Cannot reach Elasticsearch at {hosts}.";
        if (IsTls(ex))
            return $"TLS handshake with {hosts} failed: {ex.GetBaseException().Message} (set a CA certificate or enable 'Skip TLS verification' for self-signed certificates).";
        var inner = ex.GetBaseException().Message;
        return $"Cannot reach Elasticsearch at {hosts}: {inner}";
    }

    // ---- JSON helpers (non-2xx → EsErrors)

    public async Task<JsonElement> JsonAsync(HttpMethod method, string pathAndQuery, JsonNode? body, CancellationToken ct, TimeSpan? timeout = null)
    {
        var res = await SendAsync(method, pathAndQuery, body is null ? null : Encoding.UTF8.GetBytes(EsJson.Text(body)), "application/json", ct, timeout)
            .ConfigureAwait(false);
        if (!res.Ok) throw EsErrors.FromResponse(res);
        return res.Json();
    }

    public Task<JsonElement> GetAsync(string pathAndQuery, CancellationToken ct) => JsonAsync(HttpMethod.Get, pathAndQuery, null, ct);

    /// <summary>Like <see cref="GetAsync"/> but null on any Elasticsearch error (optional APIs: stats, data streams, templates).</summary>
    public async Task<JsonElement?> TryGetAsync(string pathAndQuery, CancellationToken ct)
    {
        var res = await SendAsync(HttpMethod.Get, pathAndQuery, null, null, ct).ConfigureAwait(false);
        if (!res.Ok) return null;
        try { return res.Json(); }
        catch (JsonException) { return null; }
    }

    public async Task<JsonElement> NdjsonAsync(string pathAndQuery, byte[] body, CancellationToken ct, TimeSpan? timeout = null)
    {
        var res = await SendAsync(HttpMethod.Post, pathAndQuery, body, "application/x-ndjson", ct, timeout).ConfigureAwait(false);
        if (!res.Ok) throw EsErrors.FromResponse(res);
        return res.Json();
    }

    public void Dispose() => _http.Dispose();

    /// <summary>Path segment for an index / alias / pattern / document id.</summary>
    public static string Seg(string value) => Uri.EscapeDataString(value);
}
