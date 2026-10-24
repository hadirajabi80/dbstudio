using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>Connection settings of an Elasticsearch / OpenSearch profile (form spec keys of <see cref="EsProvider.Spec"/>).</summary>
public sealed record EsSettings
{
    public required IReadOnlyList<Uri> Urls { get; init; }
    /// <summary>none | basic | apiKey | bearer.</summary>
    public string Auth { get; init; } = "none";
    public string? User { get; init; }
    public string? Password { get; init; }
    public string? ApiKey { get; init; }
    public string? Token { get; init; }
    public bool TlsSkipVerify { get; init; }
    public string? CaFile { get; init; }
    public TimeSpan ConnectTimeout { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(60);
    /// <summary>auto | elasticsearch | opensearch.</summary>
    public string Flavor { get; init; } = "auto";

    public static EsSettings From(ConnectionProfile profile, string? password)
    {
        var raw = profile.GetList("url");
        if (raw.Count == 0) throw EngineException.Validation("An Elasticsearch URL is required (http://host:9200).", new { field = "url" });
        var urls = new List<Uri>();
        foreach (var r in raw) urls.Add(ParseUrl(r));

        var auth = (profile.GetString("auth") ?? "none").Trim().ToLowerInvariant() switch
        {
            "" or "none" => "none",
            "basic" => "basic",
            "apikey" or "api_key" or "api-key" => "apiKey",
            "bearer" or "token" => "bearer",
            var other => throw EngineException.Validation($"Unknown authentication '{other}' (none, basic, apiKey, bearer).", new { field = "auth" }),
        };
        var flavor = (profile.GetString("flavor") ?? "auto").Trim().ToLowerInvariant() switch
        {
            "" or "auto" => "auto",
            "elasticsearch" or "es" => "elasticsearch",
            "opensearch" or "os" => "opensearch",
            var other => throw EngineException.Validation($"Unknown flavor '{other}' (auto, elasticsearch, opensearch).", new { field = "flavor" }),
        };
        var connect = profile.GetInt("connectTimeout", 10);
        if (connect <= 0 || connect > 600) connect = 10;
        var settings = new EsSettings
        {
            Urls = urls,
            Auth = auth,
            User = Blank(profile.GetString("user")),
            Password = string.IsNullOrEmpty(password) ? Blank(profile.GetString("password")) : password,
            ApiKey = Blank(profile.GetString("apiKey")),
            Token = Blank(profile.GetString("token")),
            TlsSkipVerify = profile.GetBool("tlsSkipVerify"),
            CaFile = Blank(profile.GetString("caFile")),
            ConnectTimeout = TimeSpan.FromSeconds(connect),
            Flavor = flavor,
        };
        if (auth == "basic" && settings.User is null) throw EngineException.Validation("A user is required for basic authentication.", new { field = "user" });
        if (auth == "apiKey" && settings.ApiKey is null) throw EngineException.Validation("An API key is required.", new { field = "apiKey" });
        if (auth == "bearer" && settings.Token is null) throw EngineException.Validation("A bearer token is required.", new { field = "token" });
        if (settings.CaFile is not null && !File.Exists(settings.CaFile))
            throw EngineException.Validation($"The CA certificate file '{settings.CaFile}' does not exist.", new { field = "caFile" });
        return settings;
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    /// <summary>"localhost:9200" → http://localhost:9200/; only http(s), no query or fragment.</summary>
    internal static Uri ParseUrl(string raw)
    {
        var s = raw.Trim();
        if (!s.Contains("://", StringComparison.Ordinal)) s = "http://" + s;
        if (!Uri.TryCreate(s, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) || string.IsNullOrEmpty(uri.Host))
            throw EngineException.Validation($"'{raw}' is not an http(s) URL.", new { field = "url" });
        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw EngineException.Validation($"'{raw}': the URL must not have a query or fragment.", new { field = "url" });
        if (!string.IsNullOrEmpty(uri.UserInfo))
            throw EngineException.Validation($"'{raw}': put the user and password into the authentication fields, not the URL.", new { field = "url" });
        var path = uri.AbsolutePath.TrimEnd('/');
        return new Uri($"{uri.Scheme}://{uri.Authority}{path}/");
    }

    public string FirstHost => Urls[0].Authority;
}
