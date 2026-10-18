using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// MongoDB source (docs/PLAN-M2.md 6.1). M2-0 SKELETON: id, kind and form spec are final; <see cref="TestAsync"/> reports
/// NOT_SUPPORTED and <see cref="OpenAsync"/> throws until M2-M adds MongoDB.Driver and the real client.
/// </summary>
public sealed class MongoProvider : IDataSourceProvider
{
    internal const string NotYet = "MongoDB support is not implemented yet (package M2-M).";

    public string Id => "mongodb";
    public string DisplayName => "MongoDB";
    public SourceKind Kind => SourceKind.Document;
    public ConnectionFormSpec FormSpec => Spec;

    public static ConnectionFormSpec Spec { get; } = new(
    [
        new FormField("uri", "Connection string", "text", Required: true,
            Placeholder: "mongodb://localhost:27017 or mongodb+srv://cluster.example.net"),
        new FormField("user", "User", "text", Help: "Merged into the URI only when it has no credentials."),
        new FormField("password", "Password", "password"),
        new FormField("authSource", "Auth database", "text", Placeholder: "admin"),
        new FormField("authMechanism", "Auth mechanism", "select", Default: JsonValue.Create("default"),
            Options:
            [
                new FormOption("default", "Default"), new FormOption("SCRAM-SHA-256", "SCRAM-SHA-256"), new FormOption("SCRAM-SHA-1", "SCRAM-SHA-1"),
                new FormOption("MONGODB-X509", "X.509"), new FormOption("PLAIN", "PLAIN (LDAP)"),
            ]),
        new FormField("database", "Database", "text", Help: "Default database for the explorer (empty = list all)."),
        new FormField("tls", "Use TLS", "bool", Default: JsonValue.Create(false)),
        new FormField("tlsCaFile", "CA file", "file", FileFilter: "*.pem;*.crt;*.cer"),
        new FormField("tlsAllowInvalid", "Allow invalid certificates", "bool", Default: JsonValue.Create(false)),
        new FormField("readPreference", "Read preference", "select", Default: JsonValue.Create("primary"),
            Options:
            [
                new FormOption("primary", "Primary"), new FormOption("primaryPreferred", "Primary preferred"),
                new FormOption("secondary", "Secondary"), new FormOption("secondaryPreferred", "Secondary preferred"),
                new FormOption("nearest", "Nearest"),
            ]),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(10)),
        new FormField("appName", "App name", "text", Default: JsonValue.Create("DbStudio")),
    ]);

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        Task.FromResult(new TestConnectionResult(false, null, 0, new ErrorInfo(ErrorCodes.NotSupported, NotYet)));

    public Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);
}
