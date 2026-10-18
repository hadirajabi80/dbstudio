using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// Apache Kafka source (docs/PLAN-M2.md 7.1). M2-0 SKELETON: id, kind and form spec are final; <see cref="TestAsync"/>
/// reports NOT_SUPPORTED and <see cref="OpenAsync"/> throws until M2-K adds Confluent.Kafka and the real client.
/// Extra secrets (<c>sslKeyPassword</c>, <c>schemaRegistrySecret</c>) are password-typed, so ConnectionStore keeps them in
/// the secret store and restores them into the profile passed to <see cref="OpenAsync"/> (docs/PLAN-M2.md D12).
/// </summary>
public sealed class KafkaProvider : IDataSourceProvider
{
    internal const string NotYet = "Kafka support is not implemented yet (package M2-K).";

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
        new FormField("clientId", "Client id", "text", Default: JsonValue.Create("DbStudio")),
        new FormField("requestTimeoutMs", "Request timeout (ms)", "number", Default: JsonValue.Create(15000)),
        new FormField("extra", "Extra librdkafka settings", "text", Placeholder: "key=value;key2=value2",
            Help: "Passed to librdkafka as is (advanced)."),
    ]);

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        Task.FromResult(new TestConnectionResult(false, null, 0, new ErrorInfo(ErrorCodes.NotSupported, NotYet)));

    public Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);
}
