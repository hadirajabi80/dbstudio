using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// Apache Kafka source (docs/PLAN-M2.md 7.1). <see cref="TestAsync"/> reads the cluster (DescribeCluster + metadata) and
/// probes the Schema Registry when configured (its failure is reported in the server text, not as a failure);
/// <see cref="OpenAsync"/> creates the shared <see cref="KafkaClientHandle"/>. Extra secrets (<c>sslKeyPassword</c>,
/// <c>schemaRegistrySecret</c>) are password-typed, so ConnectionStore keeps them in the secret store and restores them
/// into the profile passed here (D12). Tests swap the driver through the gateway/registry factories (D11).
/// </summary>
public sealed class KafkaProvider(
    Func<KafkaSettings, KafkaLogBuffer, IKafkaGateway>? gatewayFactory = null,
    Func<KafkaSettings, ISchemaRegistry?>? registryFactory = null) : IDataSourceProvider
{
    private readonly Func<KafkaSettings, KafkaLogBuffer, IKafkaGateway> _gateways = gatewayFactory ?? ((s, log) => new ConfluentKafkaGateway(s, log));
    private readonly Func<KafkaSettings, ISchemaRegistry?> _registries = registryFactory ?? DefaultRegistry;

    public string Id => "kafka";
    public string DisplayName => "Apache Kafka";
    public SourceKind Kind => SourceKind.Stream;
    public ConnectionFormSpec FormSpec => Spec;

    public static ConnectionFormSpec Spec { get; } = new(
    [
        new FormField("bootstrapServers", "Bootstrap servers", "text", Required: true, Placeholder: "host:9092,host2:9092"),
        new FormField("securityProtocol", "Security protocol", "select", Default: JsonValue.Create("PLAINTEXT"),
            Options:
            [
                new FormOption("PLAINTEXT", "PLAINTEXT"), new FormOption("SSL", "SSL"),
                new FormOption("SASL_PLAINTEXT", "SASL_PLAINTEXT"), new FormOption("SASL_SSL", "SASL_SSL"),
            ]),
        new FormField("saslMechanism", "SASL mechanism", "select", Default: JsonValue.Create("PLAIN"),
            Options:
            [
                new FormOption("PLAIN", "PLAIN"), new FormOption("SCRAM-SHA-256", "SCRAM-SHA-256"),
                new FormOption("SCRAM-SHA-512", "SCRAM-SHA-512"), new FormOption("OAUTHBEARER", "OAUTHBEARER"),
            ],
            Help: "SASL_PLAINTEXT and SASL_SSL only."),
        new FormField("user", "SASL user", "text"),
        new FormField("password", "SASL password", "password"),
        new FormField("sslCaLocation", "CA certificate", "file", FileFilter: "*.pem;*.crt;*.cer"),
        new FormField("sslCertLocation", "Client certificate", "file", FileFilter: "*.pem;*.crt;*.cer"),
        new FormField("sslKeyLocation", "Client key", "file", FileFilter: "*.pem;*.key"),
        new FormField("sslKeyPassword", "Client key password", "password"),
        new FormField("schemaRegistryUrl", "Schema Registry URL", "text", Placeholder: "http://localhost:8081"),
        new FormField("schemaRegistryUser", "Schema Registry user", "text"),
        new FormField("schemaRegistrySecret", "Schema Registry secret", "password"),
        new FormField("clientId", "Client id", "text", Default: JsonValue.Create("Rowlit")),
        new FormField("requestTimeoutMs", "Request timeout (ms)", "number", Default: JsonValue.Create(15000)),
        new FormField("extra", "Extra librdkafka settings", "text", Placeholder: "key=value;key2=value2",
            Help: "Passed to librdkafka as is (advanced)."),
    ]);

    private static ISchemaRegistry? DefaultRegistry(KafkaSettings s) =>
        s.HasSchemaRegistry ? new HttpSchemaRegistry(s.SchemaRegistryUrl!, s.SchemaRegistryUser, s.SchemaRegistrySecret,
            timeout: TimeSpan.FromMilliseconds(s.RequestTimeoutMs)) : null;

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        KafkaSettings settings;
        try { settings = KafkaSettings.From(profile, password); }
        catch (EngineException ex) { return new TestConnectionResult(false, null, 0, new ErrorInfo(ex.Code, ex.Message)); }

        var log = new KafkaLogBuffer(200);
        IKafkaGateway? gateway = null;
        ISchemaRegistry? registry = null;
        var library = "librdkafka";
        try
        {
            gateway = _gateways(settings, log);
            library = $"librdkafka {gateway.LibraryVersion}";
            registry = _registries(settings);
            var server = await DescribeAsync(gateway, registry, settings, log, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, server, sw.ElapsedMilliseconds, null);
        }
        catch (KafkaGatewayException ex)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds,
                new ErrorInfo(ErrorCodes.ProviderError, Explain(ex, log), Detail: library));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, new ErrorInfo(ErrorCodes.ProviderError, "The connection test timed out.", Detail: library));
        }
        catch (Exception ex) when (ex is DllNotFoundException or TypeInitializationException or BadImageFormatException or EntryPointNotFoundException)
        {
            // The native library could not be loaded (packaging problem, docs/PLAN-M2.md D8).
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds,
                new ErrorInfo(ErrorCodes.EngineError, $"librdkafka could not be loaded: {ex.GetBaseException().Message}", Detail: "librdkafka-missing"));
        }
        finally
        {
            gateway?.Dispose();
            (registry as IDisposable)?.Dispose();
        }
    }

    public async Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var settings = KafkaSettings.From(profile, password);
        var log = new KafkaLogBuffer();
        var gateway = _gateways(settings, log);
        ISchemaRegistry? registry = null;
        try
        {
            registry = _registries(settings);
            var server = await DescribeAsync(gateway, null, settings, log, ct).ConfigureAwait(false);
            return new KafkaClientHandle(profile.Id, profile, settings, gateway, registry, log, server);
        }
        catch (KafkaGatewayException ex)
        {
            gateway.Dispose();
            (registry as IDisposable)?.Dispose();
            throw EngineException.SourceUnavailable(Explain(ex, log), new { connectionId = profile.Id });
        }
        catch
        {
            gateway.Dispose();
            (registry as IDisposable)?.Dispose();
            throw;
        }
    }

    /// <summary>"Kafka 3.8 (3 brokers, controller 1)", product version from the brokers' inter.broker.protocol.version.</summary>
    internal static async Task<ServerInfo> DescribeAsync(IKafkaGateway gateway, ISchemaRegistry? registry, KafkaSettings settings, KafkaLogBuffer log, CancellationToken ct)
    {
        KClusterInfo cluster;
        try { cluster = await gateway.DescribeClusterAsync(ct).ConfigureAwait(false); }
        catch (KafkaGatewayException ex) when (ex.Kind is KafkaErrorKind.Unknown or KafkaErrorKind.Authorization)
        {
            // Old brokers / no DESCRIBE on the cluster: fall back to plain metadata.
            var md = await gateway.MetadataAsync(null, ct).ConfigureAwait(false);
            cluster = new KClusterInfo(null, null, md.Brokers);
        }
        var version = await BrokerVersionAsync(gateway, cluster, ct).ConfigureAwait(false);
        var text = $"Kafka{(version is null ? "" : " " + version)} ({cluster.Nodes.Count} broker{(cluster.Nodes.Count == 1 ? "" : "s")}"
            + (cluster.ControllerId is { } c ? $", controller {c})" : ")");
        if (registry is not null)
        {
            try
            {
                await registry.SubjectsAsync(ct).ConfigureAwait(false);
                text += "; Schema Registry ok";
            }
            catch (EngineException ex)
            {
                text += $"; warning: {ex.Message}";
            }
        }
        var controllerHost = cluster.Nodes.FirstOrDefault(n => n.Id == cluster.ControllerId) is { } ctl ? $"{ctl.Host}:{ctl.Port}" : settings.FirstBootstrap;
        return new ServerInfo(text, version, controllerHost, settings.User, null);
    }

    private static async Task<string?> BrokerVersionAsync(IKafkaGateway gateway, KClusterInfo cluster, CancellationToken ct)
    {
        var broker = cluster.Nodes.FirstOrDefault(n => n.Id == cluster.ControllerId) ?? cluster.Nodes.FirstOrDefault();
        if (broker is null) return null;
        try
        {
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TimeSpan.FromSeconds(5));
            var configs = await gateway.DescribeConfigsAsync(KConfigResource.Broker, broker.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), budget.Token)
                .ConfigureAwait(false);
            var ibp = configs.FirstOrDefault(c => c.Name == "inter.broker.protocol.version")?.Value;
            if (string.IsNullOrEmpty(ibp)) return null;
            var dash = ibp.IndexOf('-');
            return dash > 0 ? ibp[..dash] : ibp;
        }
        catch (Exception ex) when (ex is KafkaGatewayException or OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>The driver message plus the last librdkafka error ("Connect to ipv4#127.0.0.1:1 failed: Connection refused").</summary>
    internal static string Explain(KafkaGatewayException ex, KafkaLogBuffer log)
    {
        var last = log.LastError()?.Message;
        var message = ex.Kind switch
        {
            KafkaErrorKind.Timeout or KafkaErrorKind.Unreachable => $"Cannot reach the Kafka brokers: {ex.Message}",
            KafkaErrorKind.Authentication => $"Authentication failed: {ex.Message}",
            _ => ex.Message,
        };
        return last is not null && !message.Contains(last, StringComparison.Ordinal) ? $"{message} ({last})" : message;
    }
}
