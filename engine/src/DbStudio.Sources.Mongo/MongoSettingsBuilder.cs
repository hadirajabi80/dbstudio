using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// Connection profile → <see cref="MongoClientSettings"/> (docs/PLAN-M2.md 6.1). Pure: no I/O except reading the CA file.
/// Credentials of the form are merged only when the URI has none; passwords never appear in messages.
/// </summary>
public static partial class MongoSettingsBuilder
{
    public const int DefaultConnectTimeoutSeconds = 10;

    /// <param name="resolveSrv">mongodb+srv: resolve the SRV/TXT records now (the driver does it in FromUrl). Tests pass false.</param>
    public static MongoClientSettings Build(ConnectionProfile profile, string? password, bool resolveSrv = true)
    {
        var uri = profile.GetString("uri")?.Trim();
        if (string.IsNullOrEmpty(uri))
            throw EngineException.Validation("The connection string is required (mongodb://… or mongodb+srv://…).", new { field = "uri" });
        if (!uri.StartsWith("mongodb://", StringComparison.OrdinalIgnoreCase) && !uri.StartsWith("mongodb+srv://", StringComparison.OrdinalIgnoreCase))
            throw EngineException.Validation("The connection string must start with mongodb:// or mongodb+srv://.", new { field = "uri" });

        MongoUrl url;
        try
        {
            url = new MongoUrl(uri);
        }
        catch (Exception ex) when (ex is MongoConfigurationException or FormatException or ArgumentException)
        {
            throw EngineException.Validation($"Invalid connection string: {Redact(ex.Message, uri)}", new { field = "uri" });
        }

        var srv = url.Scheme == MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDBPlusSrv;
        MongoClientSettings settings;
        try
        {
            if (srv && !resolveSrv)
            {
                var plain = new MongoUrlBuilder(uri) { Scheme = MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDB }.ToMongoUrl();
                settings = MongoClientSettings.FromUrl(plain);
                settings.Scheme = MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDBPlusSrv;
                settings.UseTls = !uri.Contains("tls=false", StringComparison.OrdinalIgnoreCase) && !uri.Contains("ssl=false", StringComparison.OrdinalIgnoreCase);
            }
            else settings = MongoClientSettings.FromUrl(url);
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException || (!srv && ex is MongoConfigurationException))
        {
            throw EngineException.Validation($"Invalid connection string: {Redact(ex.Message, uri)}", new { field = "uri" });
        }
        catch (Exception ex) when (srv && ex is not OperationCanceledException)
        {
            // SRV / TXT lookups (DnsClient) failed: the cluster cannot be found.
            throw EngineException.SourceUnavailable($"DNS lookup of the mongodb+srv host failed: {Redact(ex.Message, uri)}");
        }

        // ---- credentials
        var mechanism = profile.GetString("authMechanism")?.Trim();
        if (string.IsNullOrEmpty(mechanism) || mechanism.Equals("default", StringComparison.OrdinalIgnoreCase)) mechanism = null;
        if (mechanism is not null && mechanism is not ("SCRAM-SHA-256" or "SCRAM-SHA-1" or "MONGODB-X509" or "PLAIN"))
            throw EngineException.Validation($"Unknown authentication mechanism '{mechanism}'.", new { field = "authMechanism" });
        var authSource = NullIfEmpty(profile.GetString("authSource"));
        var uriHasCredentials = !string.IsNullOrEmpty(url.Username);
        var user = uriHasCredentials ? url.Username : NullIfEmpty(profile.GetString("user"));
        var pass = uriHasCredentials ? url.Password : NullIfEmpty(password);
        mechanism ??= url.AuthenticationMechanism;
        if (user is not null || mechanism is "MONGODB-X509")
        {
            if (uriHasCredentials && authSource is null && profile.GetString("authMechanism") is null or "default")
            {
                // Keep the URI's own credential (authSource / mechanism properties included) untouched.
            }
            else
            {
                var source = authSource ?? url.AuthenticationSource;
                settings.Credential = mechanism switch
                {
                    "MONGODB-X509" => MongoCredential.CreateMongoX509Credential(user),
                    "PLAIN" => MongoCredential.CreatePlainCredential(source ?? "$external", user!, pass ?? ""),
                    "SCRAM-SHA-256" or "SCRAM-SHA-1" => new MongoCredential(mechanism, new MongoInternalIdentity(source ?? url.DatabaseName ?? "admin", user!),
                        new PasswordEvidence(pass ?? "")),
                    _ => MongoCredential.CreateCredential(source ?? url.DatabaseName ?? "admin", user!, pass ?? ""),
                };
            }
        }

        // ---- TLS
        if (profile.GetBool("tls")) settings.UseTls = true;
        var allowInvalid = profile.GetBool("tlsAllowInvalid");
        if (allowInvalid)
        {
            settings.UseTls = true;
            settings.AllowInsecureTls = true;
        }
        var caFile = NullIfEmpty(profile.GetString("tlsCaFile"));
        if (caFile is not null)
        {
            settings.UseTls = true;
            var cas = LoadCertificates(caFile);
            settings.SslSettings = new SslSettings
            {
                CheckCertificateRevocation = false,
                ServerCertificateValidationCallback = (_, cert, _, errors) => allowInvalid || ValidateAgainstCa(cert, errors, cas),
            };
        }

        // ---- read preference, timeouts, app name
        var rp = NullIfEmpty(profile.GetString("readPreference"));
        if (rp is not null) settings.ReadPreference = new ReadPreference(ParseReadPreference(rp));

        var seconds = DefaultConnectTimeoutSeconds;
        if (profile.Props.TryGetValue("connectTimeout", out var node) && node is not null && !string.IsNullOrWhiteSpace(node.ToString()))
        {
            if (!double.TryParse(node.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var s)
                || s is < 1 or > 300)
                throw EngineException.Validation("The connect timeout must be between 1 and 300 seconds.", new { field = "connectTimeout" });
            seconds = (int)Math.Round(s);
        }
        settings.ConnectTimeout = TimeSpan.FromSeconds(seconds);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(seconds);
        settings.ApplicationName = NullIfEmpty(profile.GetString("appName")) ?? url.ApplicationName ?? "Rowlit";
        return settings;
    }

    /// <summary>The user of the profile (URI user wins), for <see cref="ServerInfo.User"/>.</summary>
    public static string? UserOf(ConnectionProfile profile)
    {
        try
        {
            var uri = profile.GetString("uri");
            if (!string.IsNullOrWhiteSpace(uri))
            {
                var url = new MongoUrl(uri.Trim());
                if (!string.IsNullOrEmpty(url.Username)) return url.Username;
            }
        }
        catch (Exception ex) when (ex is MongoConfigurationException or FormatException or ArgumentException)
        {
            // fall through
        }
        return NullIfEmpty(profile.GetString("user"));
    }

    public static ReadPreferenceMode ParseReadPreference(string value) => value.Trim().ToLowerInvariant() switch
    {
        "primary" => ReadPreferenceMode.Primary,
        "primarypreferred" => ReadPreferenceMode.PrimaryPreferred,
        "secondary" => ReadPreferenceMode.Secondary,
        "secondarypreferred" => ReadPreferenceMode.SecondaryPreferred,
        "nearest" => ReadPreferenceMode.Nearest,
        _ => throw EngineException.Validation($"Unknown read preference '{value}'.", new { field = "readPreference" }),
    };

    internal static X509Certificate2Collection LoadCertificates(string path)
    {
        if (!File.Exists(path)) throw EngineException.Validation($"The CA file '{path}' does not exist.", new { field = "tlsCaFile" });
        var collection = new X509Certificate2Collection();
        try
        {
            var text = File.ReadAllText(path);
            if (text.Contains("-----BEGIN CERTIFICATE-----", StringComparison.Ordinal)) collection.ImportFromPem(text);
            else collection.Add(X509CertificateLoader.LoadCertificateFromFile(path));
        }
        catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or IOException)
        {
            throw EngineException.Validation($"The CA file '{path}' could not be read: {ex.Message}", new { field = "tlsCaFile" });
        }
        if (collection.Count == 0) throw EngineException.Validation($"The CA file '{path}' holds no certificate.", new { field = "tlsCaFile" });
        return collection;
    }

    /// <summary>Accepts the server certificate when it chains to one of <paramref name="cas"/> (host name errors still fail).</summary>
    internal static bool ValidateAgainstCa(X509Certificate? certificate, SslPolicyErrors errors, X509Certificate2Collection cas)
    {
        if (errors == SslPolicyErrors.None) return true;
        if (certificate is null || (errors & (SslPolicyErrors.RemoteCertificateNotAvailable | SslPolicyErrors.RemoteCertificateNameMismatch)) != 0)
            return false;
        using var cert = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.AddRange(cas);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
        return chain.Build(cert);
    }

    /// <summary>Removes the connection string (and any user:password@ part) from a driver message.</summary>
    public static string Redact(string message, string? uri)
    {
        if (!string.IsNullOrEmpty(uri)) message = message.Replace(uri, RedactUri(uri), StringComparison.Ordinal);
        return CredentialsInUri().Replace(message, "$1***@");
    }

    public static string RedactUri(string uri) => CredentialsInUri().Replace(uri, "$1***@");

    [GeneratedRegex(@"(mongodb(?:\+srv)?://)[^@/\s]+@", RegexOptions.IgnoreCase)]
    private static partial Regex CredentialsInUri();

    private static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
