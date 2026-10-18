using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Redis;

/// <summary>
/// Redis source (docs/PLAN-M2.md 5.1). M2-0 SKELETON: id, kind and form spec are final; <see cref="TestAsync"/> reports
/// NOT_SUPPORTED and <see cref="OpenAsync"/> throws until M2-R adds StackExchange.Redis and the real client.
/// </summary>
public sealed class RedisProvider : IDataSourceProvider
{
    internal const string NotYet = "Redis support is not implemented yet (package M2-R).";

    public string Id => "redis";
    public string DisplayName => "Redis";
    public SourceKind Kind => SourceKind.KeyValue;
    public ConnectionFormSpec FormSpec => Spec;

    private static Dictionary<string, string> When(string mode) => new() { ["mode"] = mode };

    public static ConnectionFormSpec Spec { get; } = new(
    [
        new FormField("mode", "Mode", "select", Default: JsonValue.Create("standalone"),
            Options: [new FormOption("standalone", "Standalone"), new FormOption("cluster", "Cluster"), new FormOption("sentinel", "Sentinel")]),
        new FormField("host", "Host", "text", Required: true, Placeholder: "localhost", VisibleWhen: When("standalone")),
        new FormField("port", "Port", "number", Default: JsonValue.Create(6379), VisibleWhen: When("standalone")),
        new FormField("nodes", "Cluster nodes", "list", Placeholder: "host1:6379,host2:6379", VisibleWhen: When("cluster")),
        new FormField("sentinels", "Sentinels", "list", Placeholder: "host1:26379,host2:26379", VisibleWhen: When("sentinel")),
        new FormField("serviceName", "Service name", "text", Default: JsonValue.Create("mymaster"), VisibleWhen: When("sentinel")),
        new FormField("user", "User", "text", Help: "ACL user (empty = default user)."),
        new FormField("password", "Password", "password"),
        new FormField("db", "Database", "number", Default: JsonValue.Create(0), Help: "Standalone and sentinel only."),
        new FormField("tls", "Use TLS", "bool", Default: JsonValue.Create(false)),
        new FormField("tlsSkipVerify", "Skip certificate verification", "bool", Default: JsonValue.Create(false)),
        new FormField("keyDelimiter", "Key delimiter", "text", Default: JsonValue.Create(":")),
        new FormField("scanCount", "SCAN count", "number", Default: JsonValue.Create(500)),
        new FormField("connectTimeout", "Connect timeout (s)", "number", Default: JsonValue.Create(5)),
    ]);

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        Task.FromResult(new TestConnectionResult(false, null, 0, new ErrorInfo(ErrorCodes.NotSupported, NotYet)));

    public Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);
}
