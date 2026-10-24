using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>
/// Elasticsearch 7/8 and OpenSearch 1/2 source (plan-batch3 WP-ES, D4). <see cref="TestAsync"/> reads <c>GET /</c> and
/// <c>_cluster/health</c>; <see cref="OpenAsync"/> creates the shared <see cref="EsClient"/>. The flavor comes from the
/// profile or from <c>GET /</c> (<c>version.distribution</c> / tagline). <c>apiKey</c> and <c>token</c> are
/// password-typed, so ConnectionStore keeps them in the secret store and restores them into the profile passed here.
/// </summary>
public sealed class EsProvider(Func<EsSettings, HttpMessageHandler?>? handlerFactory = null) : IDataSourceProvider
{
    private readonly Func<EsSettings, HttpMessageHandler?> _handlers = handlerFactory ?? (_ => null);

    public string Id => "elasticsearch";
    public string DisplayName => "Elasticsearch / OpenSearch";
    public SourceKind Kind => SourceKind.Search;
    public ConnectionFormSpec FormSpec => Spec;

    private static readonly Dictionary<string, string> BasicOnly = new() { ["auth"] = "basic" };

    public static ConnectionFormSpec Spec { get; } = new(
    [
        new FormField("url", "URL", "text", Required: true, Placeholder: "http://localhost:9200",
            Help: "One or more node URLs, comma separated (https://node1:9200,https://node2:9200)."),
        new FormField("auth", "Authentication", "select", Default: JsonValue.Create("none"),
            Options:
            [
                new FormOption("none", "None"), new FormOption("basic", "User and password"),
                new FormOption("apiKey", "API key"), new FormOption("bearer", "Bearer token"),
            ]),
        new FormField("user", "User", "text", VisibleWhen: BasicOnly),
        new FormField("password", "Password", "password", VisibleWhen: BasicOnly),
        new FormField("apiKey", "API key", "password", VisibleWhen: new Dictionary<string, string> { ["auth"] = "apiKey" },
            Help: "The encoded key, or id:api_key."),
        new FormField("token", "Bearer token", "password", VisibleWhen: new Dictionary<string, string> { ["auth"] = "bearer" }),
        new FormField("tlsSkipVerify", "Skip TLS verification", "bool", Default: JsonValue.Create(false),
            Help: "Accept any server certificate (self-signed development clusters)."),
        new FormField("caFile", "CA certificate", "file", FileFilter: "*.pem;*.crt;*.cer"),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(10)),
        new FormField("flavor", "Flavor", "select", Default: JsonValue.Create("auto"),
            Options: [new FormOption("auto", "Detect"), new FormOption("elasticsearch", "Elasticsearch"), new FormOption("opensearch", "OpenSearch")]),
    ]);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        EsSettings settings;
        try { settings = EsSettings.From(profile, password); }
        catch (EngineException ex) { return new TestConnectionResult(false, null, 0, new ErrorInfo(ex.Code, ex.Message)); }
        EsTransport? transport = null;
        try
        {
            transport = new EsTransport(settings, _handlers(settings));
            var (_, _, server) = await DescribeAsync(transport, settings, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, server, sw.ElapsedMilliseconds, null);
        }
        catch (EngineException ex)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, new ErrorInfo(ex.Code == ErrorCodes.Privilege ? ErrorCodes.ProviderError : ex.Code, ex.Message));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, new ErrorInfo(ErrorCodes.ProviderError, ex.Message));
        }
        finally
        {
            transport?.Dispose();
        }
    }

    public async Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var settings = EsSettings.From(profile, password);
        var transport = new EsTransport(settings, _handlers(settings));
        try
        {
            var (flavor, version, server) = await DescribeAsync(transport, settings, ct).ConfigureAwait(false);
            return new EsClient(profile, transport, flavor, version, server);
        }
        catch (EngineException ex) when (ex.Code is ErrorCodes.Privilege or ErrorCodes.ProviderError or ErrorCodes.NotFound)
        {
            transport.Dispose();
            throw EngineException.SourceUnavailable(ex.Message, new { connectionId = profile.Id });
        }
        catch
        {
            transport.Dispose();
            throw;
        }
    }

    /// <summary>"Elasticsearch 8.15.3 (cluster docker-cluster, green, 1 node)".</summary>
    internal static async Task<(string Flavor, string Version, ServerInfo Server)> DescribeAsync(EsTransport transport, EsSettings settings, CancellationToken ct)
    {
        var root = await transport.GetAsync("", ct).ConfigureAwait(false);
        var flavor = settings.Flavor != "auto" ? settings.Flavor : DetectFlavor(root);
        var version = root.Path("version.number") is { } v ? EsJson.AsString(v) ?? "" : "";
        var cluster = root.Str("cluster_name") ?? "";
        string? status = null;
        int? nodes = null;
        if (await transport.TryGetAsync("_cluster/health", ct).ConfigureAwait(false) is { } health)
        {
            status = health.Str("status");
            nodes = health.Int("number_of_nodes");
        }
        var product = flavor == "opensearch" ? "OpenSearch" : "Elasticsearch";
        var parts = new List<string>();
        if (cluster.Length > 0) parts.Add($"cluster {cluster}");
        if (status is not null) parts.Add(status);
        if (nodes is { } n) parts.Add($"{n} node{(n == 1 ? "" : "s")}");
        var text = $"{product} {version}".TrimEnd() + (parts.Count > 0 ? $" ({string.Join(", ", parts)})" : "");
        var user = settings.Auth == "basic" ? settings.User : null;
        return (flavor, version, new ServerInfo(text, version.Length > 0 ? version : null, cluster.Length > 0 ? cluster : settings.FirstHost, user, null));
    }

    internal static string DetectFlavor(JsonElement root)
    {
        if (root.Path("version.distribution") is { } d && string.Equals(EsJson.AsString(d), "opensearch", StringComparison.OrdinalIgnoreCase)) return "opensearch";
        if (root.Str("tagline") is { } t && t.Contains("OpenSearch", StringComparison.OrdinalIgnoreCase)) return "opensearch";
        return "elasticsearch";
    }
}
