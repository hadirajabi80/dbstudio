using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;
using MongoDB.Driver;
using MongoDB.Driver.Core.Configuration;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class MongoSettingsBuilderTests
{
    [Fact]
    public void Form_credentials_are_merged_when_the_uri_has_none()
    {
        var p = T.Profile("mongodb://db1:27017,db2:27017/shop?replicaSet=rs0", props: [("user", "app"), ("authSource", "admin")]);
        var s = MongoSettingsBuilder.Build(p, "s3cret");
        Assert.Equal("app", s.Credential.Username);
        Assert.Equal("admin", s.Credential.Source);
        Assert.Equal(2, s.Servers.Count());
        Assert.Equal("rs0", s.ReplicaSetName);
    }

    [Fact]
    public void Uri_credentials_win_over_the_form()
    {
        var p = T.Profile("mongodb://alice:pw@localhost/?authSource=shop", props: [("user", "bob")]);
        var s = MongoSettingsBuilder.Build(p, "other");
        Assert.Equal("alice", s.Credential.Username);
        Assert.Equal("shop", s.Credential.Source);
        Assert.Equal("alice", MongoSettingsBuilder.UserOf(p));
    }

    [Fact]
    public void Mechanisms_scram_x509_plain()
    {
        var scram = MongoSettingsBuilder.Build(T.Profile(props: [("user", "u"), ("authMechanism", "SCRAM-SHA-256")]), "pw");
        Assert.Equal("SCRAM-SHA-256", scram.Credential.Mechanism);
        var x509 = MongoSettingsBuilder.Build(T.Profile(props: [("authMechanism", "MONGODB-X509"), ("tls", true)]), null);
        Assert.Equal("MONGODB-X509", x509.Credential.Mechanism);
        Assert.True(x509.UseTls);
        var plain = MongoSettingsBuilder.Build(T.Profile(props: [("user", "ldap"), ("authMechanism", "PLAIN")]), "pw");
        Assert.Equal("PLAIN", plain.Credential.Mechanism);
        Assert.Equal("$external", plain.Credential.Source);
        Assert.Null(MongoSettingsBuilder.Build(T.Profile(props: [("authMechanism", "default")]), null).Credential);
    }

    [Fact]
    public void Srv_scheme_is_kept_without_resolving()
    {
        var s = MongoSettingsBuilder.Build(T.Profile("mongodb+srv://cluster0.abcd.mongodb.net/shop"), null, resolveSrv: false);
        Assert.True(s.UseTls);
        Assert.Equal(ConnectionStringScheme.MongoDBPlusSrv, s.Scheme);
    }

    [Fact]
    public void Tls_options_and_ca_file()
    {
        var dir = T.TempDir();
        var ca = Path.Combine(dir, "ca.pem");
        using (var rsa = System.Security.Cryptography.RSA.Create(2048))
        {
            var req = new System.Security.Cryptography.X509Certificates.CertificateRequest("CN=Test CA", rsa,
                System.Security.Cryptography.HashAlgorithmName.SHA256, System.Security.Cryptography.RSASignaturePadding.Pkcs1);
            req.CertificateExtensions.Add(new System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension(true, false, 0, true));
            using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
            File.WriteAllText(ca, cert.ExportCertificatePem());
        }
        var s = MongoSettingsBuilder.Build(T.Profile(props: [("tlsCaFile", ca)]), null);
        Assert.True(s.UseTls);
        Assert.NotNull(s.SslSettings.ServerCertificateValidationCallback);
        Assert.False(s.AllowInsecureTls);
        var insecure = MongoSettingsBuilder.Build(T.Profile(props: [("tlsAllowInvalid", true)]), null);
        Assert.True(insecure.UseTls);
        Assert.True(insecure.AllowInsecureTls);
        var missing = Assert.Throws<EngineException>(() => MongoSettingsBuilder.Build(T.Profile(props: [("tlsCaFile", Path.Combine(dir, "nope.pem"))]), null));
        Assert.Equal("tlsCaFile", Field(missing));
    }

    [Fact]
    public void Read_preference_timeouts_and_app_name()
    {
        var s = MongoSettingsBuilder.Build(T.Profile(props: [("readPreference", "secondaryPreferred"), ("connectTimeout", 3), ("appName", "Me")]), null);
        Assert.Equal(ReadPreferenceMode.SecondaryPreferred, s.ReadPreference.ReadPreferenceMode);
        Assert.Equal(TimeSpan.FromSeconds(3), s.ConnectTimeout);
        Assert.Equal(TimeSpan.FromSeconds(3), s.ServerSelectionTimeout);
        Assert.Equal("Me", s.ApplicationName);
        var d = MongoSettingsBuilder.Build(T.Profile(), null);
        Assert.Equal(TimeSpan.FromSeconds(10), d.ServerSelectionTimeout);
        Assert.Equal("DbStudio", d.ApplicationName);
        Assert.Equal("readPreference", Field(Assert.Throws<EngineException>(() => MongoSettingsBuilder.Build(T.Profile(props: [("readPreference", "fastest")]), null))));
        Assert.Equal("connectTimeout", Field(Assert.Throws<EngineException>(() => MongoSettingsBuilder.Build(T.Profile(props: [("connectTimeout", 0)]), null))));
    }

    [Theory]
    [InlineData("")]
    [InlineData("localhost:27017")]
    [InlineData("mongodb://")]
    [InlineData("mongodb://user:secret@host:notaport")]
    public void Invalid_uris_are_validation_errors_without_the_password(string uri)
    {
        var ex = Assert.Throws<EngineException>(() => MongoSettingsBuilder.Build(T.Profile(uri), null));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        Assert.Equal("uri", Field(ex));
        Assert.DoesNotContain("secret", ex.Message);
    }

    [Fact]
    public void Redact_strips_credentials() =>
        Assert.Equal("failed for mongodb://***@h:1/x", MongoSettingsBuilder.Redact("failed for mongodb://u:p@h:1/x", null));

    internal static string? Field(EngineException ex) => ex.Detail?.GetType().GetProperty("field")?.GetValue(ex.Detail) as string;
}

public sealed class MongoProviderTests
{
    private static MongoProvider Over(MongoFake fake) => new((_, _, _) => Task.FromResult<IMongoGateway>(fake));

    [Fact]
    public async Task Test_reports_server_info_of_a_replica_set()
    {
        var fake = new MongoFake();
        var r = await Over(fake).TestAsync(T.Profile(database: "shop", props: [("user", "app")]), "pw", CancellationToken.None);
        Assert.True(r.Ok);
        Assert.Equal("MongoDB 7.0.14 (replica set rs0)", r.ServerInfo!.Version);
        Assert.Equal("7.0.14", r.ServerInfo.ProductVersion);
        Assert.Equal("localhost:27017", r.ServerInfo.ServerName);
        Assert.Equal("app", r.ServerInfo.User);
        Assert.Equal("shop", r.ServerInfo.Database);
        Assert.True(fake.Disposed);
    }

    [Fact]
    public async Task Standalone_and_sharded_labels()
    {
        var fake = new MongoFake { Standalone = true };
        Assert.Equal("MongoDB 7.0.14 (standalone)", (await Over(fake).TestAsync(T.Profile(), null, CancellationToken.None)).ServerInfo!.Version);
        Assert.Equal("sharded cluster", MongoProvider.TopologyLabel(new BsonDocument("msg", "isdbgrid")));
    }

    [Fact]
    public async Task Failures_are_returned_as_source_unavailable()
    {
        var fake = new MongoFake();
        fake.Fail("hello", new TimeoutException("A timeout occurred after 2000ms selecting a server using CompositeServerSelector{ x }. Client view of cluster state is { Servers : [{ HeartbeatException: \"MongoDB.Driver.MongoConnectionException: An exception occurred while opening a connection to the server.\r\n ---> System.Net.Sockets.SocketException (10061): No connection could be made because the target machine actively refused it. 127.0.0.1:1\r\n   at X\" }] }"));
        var r = await Over(fake).TestAsync(T.Profile(), null, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.SourceUnavailable, r.Error!.Code);
        Assert.Equal("A timeout occurred after 2000ms selecting a server: No connection could be made because the target machine actively refused it. 127.0.0.1:1",
            r.Error.Message);
    }

    [Fact]
    public async Task Bad_uri_is_a_validation_result()
    {
        var r = await new MongoProvider().TestAsync(T.Profile("nope"), null, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.Validation, r.Error!.Code);
    }

    [Fact]
    public async Task Open_returns_a_handle_and_failures_throw_source_unavailable()
    {
        var fake = new MongoFake();
        var client = await Over(fake).OpenAsync(T.Profile(), null, CancellationToken.None);
        var h = Assert.IsType<MongoClientHandle>(client);
        Assert.Same(fake, h.Gateway);
        Assert.Null(h.Client);
        Assert.Null(h.Database("shop"));
        Assert.True(await h.PingAsync(CancellationToken.None));

        var broken = new MongoFake();
        broken.Fail("hello", new MongoConnectionException(MongoFake.Connection, "connection refused"));
        var ex = await Assert.ThrowsAsync<EngineException>(() => Over(broken).OpenAsync(T.Profile(), null, CancellationToken.None));
        Assert.Equal(ErrorCodes.SourceUnavailable, ex.Code);
        Assert.True(broken.Disposed);
    }

    [Fact]
    public async Task Real_driver_against_a_closed_port_fails_fast_with_source_unavailable()
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var r = await new MongoProvider().TestAsync(T.Profile("mongodb://127.0.0.1:1/?directConnection=true", props: [("connectTimeout", 1)]), null,
            CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(ErrorCodes.SourceUnavailable, r.Error!.Code);
        Assert.InRange(sw.Elapsed.TotalSeconds, 0, 8);
    }

    [Fact]
    public void Form_spec_is_unchanged() =>
        Assert.Equal(["uri", "user", "password", "authSource", "authMechanism", "database", "tls", "tlsCaFile", "tlsAllowInvalid", "readPreference",
            "connectTimeout", "appName"], MongoProvider.Spec.Fields.Select(f => f.Key));
}

public sealed class MongoErrorsTests
{
    [Fact]
    public void Unauthorized_maps_to_privilege_with_needs()
    {
        var e = MongoErrors.Map(MongoFake.Unauthorized("shop", "find", "orders"))!;
        Assert.Equal(403, e.Status);
        Assert.Equal(ErrorCodes.Privilege, e.Code);
        Assert.Equal("find on shop.orders", e.Detail!.GetType().GetProperty("needs")!.GetValue(e.Detail));
        Assert.Equal("listDatabases on admin", MongoErrors.NeedsOf("not authorized on admin to execute command { listDatabases: 1, $db: \"admin\" }"));
    }

    [Fact]
    public void Command_errors_and_timeouts_are_provider_errors()
    {
        var e = MongoErrors.Map(MongoFake.Command(2, "BadValue", "unknown operator: $foo"))!;
        Assert.Equal((422, ErrorCodes.ProviderError), (e.Status, e.Code));
        Assert.Equal(2, e.Detail!.GetType().GetProperty("providerCode")!.GetValue(e.Detail));
        Assert.Equal("BadValue", e.Detail.GetType().GetProperty("codeName")!.GetValue(e.Detail));
        var t = MongoErrors.Map(MongoFake.Timeout())!;
        Assert.Equal(422, t.Status);
        Assert.Equal("MaxTimeMSExpired", t.Detail!.GetType().GetProperty("codeName")!.GetValue(t.Detail));
        Assert.True(MongoErrors.IsTimeout(MongoFake.Command(50, "MaxTimeMSExpired", "x")));
    }

    [Fact]
    public void Connection_failures_are_source_unavailable_and_parse_errors_validation()
    {
        Assert.True(MongoErrors.IsConnectionFailure(new TimeoutException("x")));
        Assert.Equal(ErrorCodes.SourceUnavailable, MongoErrors.Map(new TimeoutException("x"))!.Code);
        var v = MongoErrors.Map(new ShellJsonException("bad", "filter", 3, 1, 4))!;
        Assert.Equal((400, ErrorCodes.Validation), (v.Status, v.Code));
        Assert.Equal("filter", MongoSettingsBuilderTests.Field(v));
        Assert.Null(MongoErrors.Map(new InvalidOperationException()));
    }
}
