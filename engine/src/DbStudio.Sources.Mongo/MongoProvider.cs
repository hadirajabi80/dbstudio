using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using MongoDB.Bson;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// MongoDB source (docs/PLAN-M2.md 6.1): <c>mongodb://</c> and <c>mongodb+srv://</c>, one shared <see cref="MongoClient"/>
/// per connection (<see cref="MongoClientHandle"/>). The handshake runs <c>{ hello: 1 }</c> + <c>{ buildInfo: 1 }</c> on admin.
/// </summary>
public sealed class MongoProvider : IDataSourceProvider
{
    private readonly Func<ConnectionProfile, string?, CancellationToken, Task<IMongoGateway>> _gatewayFactory;

    public MongoProvider() : this(DefaultGatewayAsync)
    {
    }

    /// <summary>Tests: open handles over a fake gateway.</summary>
    internal MongoProvider(Func<ConnectionProfile, string?, CancellationToken, Task<IMongoGateway>> gatewayFactory) =>
        _gatewayFactory = gatewayFactory;

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

    private static async Task<IMongoGateway> DefaultGatewayAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        // mongodb+srv resolves SRV/TXT records synchronously inside the driver: bound it by the connect timeout.
        var timeout = TimeSpan.FromSeconds(Math.Clamp(profile.GetInt("connectTimeout", MongoSettingsBuilder.DefaultConnectTimeoutSeconds), 1, 300) + 1);
        var build = Task.Run(() => MongoSettingsBuilder.Build(profile, password), CancellationToken.None);
        MongoClientSettings settings;
        try
        {
            settings = await build.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw EngineException.SourceUnavailable($"Resolving the connection string took longer than {timeout.TotalSeconds - 1:0} s (DNS).");
        }
        return new DriverMongoGateway(new MongoClient(settings));
    }

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        IMongoGateway? gateway = null;
        try
        {
            gateway = await _gatewayFactory(profile, password, ct).ConfigureAwait(false);
            var (server, _) = await HandshakeAsync(gateway, profile, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, server, sw.ElapsedMilliseconds, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (EngineException e) when (e.Code == ErrorCodes.Validation)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, new ErrorInfo(ErrorCodes.Validation, e.Message));
        }
        catch (Exception ex)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, new ErrorInfo(ErrorCodes.SourceUnavailable, Describe(ex, profile)));
        }
        finally
        {
            if (gateway is not null) await gateway.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var gateway = await _gatewayFactory(profile, password, ct).ConfigureAwait(false);
        try
        {
            var (server, hello) = await HandshakeAsync(gateway, profile, ct).ConfigureAwait(false);
            return new MongoClientHandle(profile.Id, profile, gateway, server, hello);
        }
        catch (Exception ex)
        {
            await gateway.DisposeAsync().ConfigureAwait(false);
            if (ex is OperationCanceledException && ct.IsCancellationRequested) throw;
            if (ex is EngineException) throw;
            throw EngineException.SourceUnavailable(Describe(ex, profile), new { connectionId = profile.Id, providerId = Id });
        }
    }

    /// <summary><c>hello</c> + <c>buildInfo</c> → "MongoDB 7.0.14 (replica set rs0)".</summary>
    internal static async Task<(ServerInfo Server, BsonDocument Hello)> HandshakeAsync(IMongoGateway gateway, ConnectionProfile profile, CancellationToken ct)
    {
        var hello = await gateway.RunCommandAsync("admin", new BsonDocument("hello", 1), ct).ConfigureAwait(false);
        string? version = null;
        try
        {
            var build = await gateway.RunCommandAsync("admin", new BsonDocument("buildInfo", 1), ct).ConfigureAwait(false);
            version = build.GetValue("version", BsonNull.Value) is BsonString s ? s.Value : null;
        }
        catch (MongoCommandException)
        {
            // buildInfo denied: keep the topology only.
        }
        var topology = TopologyLabel(hello);
        var host = HostOf(hello) ?? FirstHost(profile);
        var database = string.IsNullOrWhiteSpace(profile.GetString("database")) ? null : profile.GetString("database")!.Trim();
        var server = new ServerInfo($"MongoDB {version ?? "(unknown version)"} ({topology})", version, host, MongoSettingsBuilder.UserOf(profile), database);
        return (server, hello);
    }

    internal static string TopologyLabel(BsonDocument hello) =>
        hello.GetValue("msg", BsonNull.Value) is BsonString { Value: "isdbgrid" } ? "sharded cluster"
        : hello.GetValue("setName", BsonNull.Value) is BsonString set ? $"replica set {set.Value}"
        : hello.Contains("serviceId") ? "load balanced"
        : "standalone";

    internal static string? HostOf(BsonDocument hello)
    {
        if (hello.GetValue("primary", BsonNull.Value) is BsonString p) return p.Value;
        if (hello.GetValue("me", BsonNull.Value) is BsonString me) return me.Value;
        if (hello.GetValue("hosts", BsonNull.Value) is BsonArray { Count: > 0 } hosts) return hosts[0].ToString();
        return null;
    }

    internal static string? FirstHost(ConnectionProfile profile)
    {
        try
        {
            var url = new MongoUrl(profile.GetString("uri")!.Trim());
            return url.Scheme == MongoDB.Driver.Core.Configuration.ConnectionStringScheme.MongoDBPlusSrv
                ? url.Server.Host
                : url.Servers.FirstOrDefault()?.ToString();
        }
        catch (Exception ex) when (ex is MongoConfigurationException or FormatException or ArgumentException or NullReferenceException)
        {
            return null;
        }
    }

    /// <summary>A short, credential-free description of a connection failure (server selection timeouts name the cause).</summary>
    internal static string Describe(Exception ex, ConnectionProfile? profile = null)
    {
        var message = ex.Message;
        if (ex is TimeoutException && message.Contains("selecting a server", StringComparison.Ordinal))
        {
            var cut = message.IndexOf(" using ", StringComparison.Ordinal);
            var head = cut > 0 ? message[..cut] : "A timeout occurred selecting a server";
            var reason = HeartbeatReason(message);
            message = reason is null ? head + "." : $"{head}: {reason}";
        }
        else if (ex.InnerException is { } inner && ex is MongoConnectionException && !string.IsNullOrWhiteSpace(inner.Message))
        {
            message = $"{ex.Message} {inner.Message}";
        }
        return MongoSettingsBuilder.Redact(message, profile?.GetString("uri"));
    }

    private static string? HeartbeatReason(string message)
    {
        var at = message.IndexOf("HeartbeatException: \"", StringComparison.Ordinal);
        if (at < 0) return null;
        var text = message[(at + 21)..];
        var segments = text.Split("--->", StringSplitOptions.TrimEntries);
        var last = segments[^1];
        foreach (var stop in new[] { "\r\n", "\n", "   at ", "\" }", "\"," })
        {
            var i = last.IndexOf(stop, StringComparison.Ordinal);
            if (i > 0) last = last[..i];
        }
        var colon = last.IndexOf(": ", StringComparison.Ordinal);
        if (colon > 0 && last[..colon].Contains("Exception", StringComparison.Ordinal)) last = last[(colon + 2)..];
        last = last.Trim().TrimEnd('"');
        return last.Length == 0 ? null : last;
    }
}
