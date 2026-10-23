using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>
/// Elasticsearch error bodies (<c>{ error: { root_cause, type, reason, caused_by }, status }</c>, or an old-style string
/// <c>error</c>) → the REST error envelope. 404 → NOT_FOUND, 409 → 409 PROVIDER_ERROR (version conflicts), 401/403 →
/// PRIVILEGE, everything else → 422 PROVIDER_ERROR; <c>detail</c> is an <see cref="EsErrorDetail"/>.
/// </summary>
public static class EsErrors
{
    public const string PrivilegeNeeds = "Elasticsearch privilege for this API";

    public static EngineException FromResponse(EsResponse res)
    {
        var (type, reason, root) = Parse(res.Body);
        var message = type is null && reason is null
            ? $"Elasticsearch answered {res.Status} {res.ReasonPhrase}".TrimEnd()
            : type is null ? reason! : reason is null ? type : $"{type}: {reason}";
        var detail = new EsErrorDetail(res.Status, type, root);
        return res.Status switch
        {
            404 => new EngineException(404, ErrorCodes.NotFound, message, detail),
            409 => new EngineException(409, ErrorCodes.ProviderError, message, detail),
            401 => new EngineException(403, ErrorCodes.Privilege, $"Authentication failed: {message}", new { needs = PrivilegeNeeds, status = res.Status, esType = type, rootCause = root }),
            403 => new EngineException(403, ErrorCodes.Privilege, message, new { needs = PrivilegeNeeds, status = res.Status, esType = type, rootCause = root }),
            _ => new EngineException(422, ErrorCodes.ProviderError, message, detail),
        };
    }

    /// <summary>(type, reason, root cause reason when it adds information).</summary>
    internal static (string? Type, string? Reason, string? RootCause) Parse(byte[] body)
    {
        if (body.Length == 0) return (null, null, null);
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("error", out var err))
            {
                // OpenSearch security / proxies: { "message": "..." } or plain text
                return root.ValueKind == JsonValueKind.Object && root.Str("message") is { } m ? (null, m, null) : (null, null, null);
            }
            if (err.ValueKind == JsonValueKind.String) return (null, err.GetString(), null);
            var type = err.Str("type");
            var reason = err.Str("reason");
            string? rootCause = null;
            var rc = err.Prop("root_cause").Items().FirstOrDefault();
            if (rc.ValueKind == JsonValueKind.Object)
            {
                var rcReason = rc.Str("reason");
                var rcType = rc.Str("type");
                if (rcReason is not null && rcReason != reason) rootCause = rcType is null ? rcReason : $"{rcType}: {rcReason}";
            }
            if (rootCause is null && err.Prop("caused_by") is { } cb && cb.Str("reason") is { } cbReason && cbReason != reason)
                rootCause = cb.Str("type") is { } cbType ? $"{cbType}: {cbReason}" : cbReason;
            return (type, reason, rootCause);
        }
        catch (JsonException)
        {
            var text = Encoding.UTF8.GetString(body, 0, Math.Min(body.Length, 500)).Trim();
            return (null, text.Length == 0 ? null : text, null);
        }
    }
}
