using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>
/// Dev Tools console (<c>POST /es/{cid}/console</c>): one raw request relative to the cluster. Methods GET, POST, PUT,
/// DELETE, HEAD; the path is sanitised (no scheme/host, no dot segments, no CR/LF, backslash or fragment). Read-only
/// connections allow GET/HEAD and the read-only POST APIs only. Elasticsearch error statuses are answered in the body.
/// </summary>
public sealed class ConsoleService
{
    private static readonly HashSet<string> Methods = new(StringComparer.Ordinal) { "GET", "POST", "PUT", "DELETE", "HEAD" };

    /// <summary>POST APIs that do not change data (first underscore segment of the path; `_plugins`/`_opendistro` + the next).</summary>
    private static readonly HashSet<string> ReadOnlyPost = new(StringComparer.Ordinal)
    {
        "_search", "_msearch", "_count", "_mget", "_field_caps", "_explain", "_analyze", "_validate", "_render", "_sql", "_eql",
        "_async_search", "_pit", "_termvectors", "_mtermvectors", "_plugins/_sql", "_plugins/_ppl", "_opendistro/_sql",
    };

    public async Task<EsConsoleResponse> RunAsync(EsClient c, EsConsoleRequest? req, CancellationToken ct)
    {
        var method = (req?.Method ?? "").Trim().ToUpperInvariant();
        if (!Methods.Contains(method)) throw EngineException.Validation($"Method '{req?.Method}' is not supported (GET, POST, PUT, DELETE, HEAD).", new { field = "method" });
        var path = SanitizePath(req?.Path);
        if (c.Profile.ReadOnly && !IsReadOnlyRequest(method, path))
            throw EngineException.ReadOnly(c.Profile.Name, $"{method} {PathOnly(path)}");

        byte[]? body = null;
        string? contentType = null;
        var text = req?.Body;
        if (!string.IsNullOrWhiteSpace(text) && method != "HEAD")
        {
            if (IsNdjson(path))
            {
                var normalized = NormalizeNdjson(text);
                body = Encoding.UTF8.GetBytes(normalized);
                contentType = "application/x-ndjson";
            }
            else
            {
                body = Encoding.UTF8.GetBytes(text.Trim());
                contentType = "application/json";
            }
        }
        var res = await c.Transport.SendAsync(new HttpMethod(method), path, body, contentType, ct, TimeSpan.FromMinutes(5), EsTransport.MaxConsoleBytes)
            .ConfigureAwait(false);
        return new EsConsoleResponse(res.Status, res.ReasonPhrase ?? "", res.ElapsedMs, res.ContentType, Pretty(res), res.Truncated);
    }

    /// <summary>"_cat/indices?v" → "/_cat/indices?v"; rejects absolute URLs, dot segments, CR/LF, backslashes and fragments.</summary>
    public static string SanitizePath(string? raw)
    {
        var p = (raw ?? "").Trim();
        if (p.Length == 0) return "/";
        if (p.IndexOfAny(['\r', '\n', '\\', '#', '\t']) >= 0 || p.Any(char.IsControl))
            throw EngineException.Validation("The path must not contain line breaks, tabs, backslashes or '#'.", new { field = "path" });
        if (p.Contains("://", StringComparison.Ordinal) || p.StartsWith("//", StringComparison.Ordinal))
            throw EngineException.Validation("Use a path relative to the cluster (e.g. /_cat/indices), not a URL.", new { field = "path" });
        if (!p.StartsWith('/')) p = "/" + p;
        var q = p.IndexOf('?');
        var pathPart = q >= 0 ? p[..q] : p;
        foreach (var seg in pathPart.Split('/'))
        {
            var decoded = Uri.UnescapeDataString(seg);
            if (decoded is "." or ".." || decoded.Contains('/') && decoded.Split('/').Any(s => s is "." or ".."))
                throw EngineException.Validation("The path must not contain '.' or '..' segments.", new { field = "path" });
        }
        if (pathPart.Contains(' ')) pathPart = pathPart.Replace(" ", "%20", StringComparison.Ordinal);
        return q >= 0 ? pathPart + p[q..] : pathPart;
    }

    private static string PathOnly(string path) => path.Split('?')[0];

    /// <summary>The first API segment of a path ("/shop/_search/template" → "_search"; "/_plugins/_sql" → "_plugins/_sql").</summary>
    internal static string? ApiOf(string path)
    {
        var segs = PathOnly(path).Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        for (var i = 0; i < segs.Length; i++)
        {
            if (!segs[i].StartsWith('_')) continue;
            if (segs[i] is "_plugins" or "_opendistro") return i + 1 < segs.Length ? $"{segs[i]}/{segs[i + 1]}" : segs[i];
            return segs[i];
        }
        return null;
    }

    public static bool IsReadOnlyRequest(string method, string path)
    {
        if (method is "GET" or "HEAD") return true;
        if (method != "POST") return false;
        var api = ApiOf(path);
        return api is not null && ReadOnlyPost.Contains(api);
    }

    internal static bool IsNdjson(string path)
    {
        var p = PathOnly(path);
        return p.EndsWith("/_bulk", StringComparison.Ordinal) || p == "/_bulk"
            || p.Contains("/_msearch", StringComparison.Ordinal);
    }

    /// <summary>One JSON value per line (pretty-printed objects typed over several lines are compacted), trailing newline.</summary>
    internal static string NormalizeNdjson(string text)
    {
        var sb = new StringBuilder();
        var bytes = Encoding.UTF8.GetBytes(text);
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { AllowMultipleValues = true, CommentHandling = JsonCommentHandling.Skip });
        try
        {
            while (reader.Read())
            {
                using var doc = JsonDocument.ParseValue(ref reader);
                sb.Append(JsonSerializer.Serialize(doc.RootElement, EsJson.Relaxed)).Append('\n');
            }
            return sb.ToString();
        }
        catch (JsonException)
        {
            // Not parseable: send as typed (Elasticsearch reports the line).
            var t = text.Replace("\r\n", "\n", StringComparison.Ordinal).Trim();
            return t + "\n";
        }
    }

    internal static string Pretty(EsResponse res)
    {
        if (res.Body.Length == 0) return "";
        var text = res.Text;
        if (res.Truncated || res.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true) return text;
        try
        {
            using var doc = JsonDocument.Parse(res.Body);
            return JsonSerializer.Serialize(doc.RootElement, EsJson.RelaxedIndented);
        }
        catch (JsonException)
        {
            return text;
        }
    }
}
