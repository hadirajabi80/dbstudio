using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle.Tests;

public sealed class OracleConnectionStringTests
{
    private static ConnectionProfile Profile(params (string Key, JsonNode? Value)[] props) => new()
    {
        Id = "c_test",
        ProviderId = "oracle",
        Props = props.ToDictionary(p => p.Key, p => p.Value),
    };

    public static TheoryData<string, string?, string?, string, bool> BasicCombinations()
    {
        var data = new TheoryData<string, string?, string?, string, bool>();
        foreach (var (service, sid) in new[] { ("FREEPDB1", (string?)null), (null, "XE"), ("ORCLPDB", "IGNORED") })
        foreach (var role in new[] { "normal", "sysdba", "sysoper" })
        foreach (var pooling in new[] { true, false })
            data.Add("db.example.com", service, sid, role, pooling);
        return data;
    }

    [Theory]
    [MemberData(nameof(BasicCombinations))]
    public void Basic_EveryCombination(string host, string? service, string? sid, string role, bool pooling)
    {
        var profile = Profile(("connectionType", "basic"), ("host", host), ("port", 1522), ("serviceName", service), ("sid", sid),
            ("user", "shop"), ("role", role));
        var b = new OracleConnectionStringBuilder(OracleConnectionStrings.Build(profile, "secret", pooling));

        var connectData = service is not null ? $"(SERVICE_NAME={service})" : $"(SID={sid})";
        Assert.Equal($"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT=1522))(CONNECT_DATA={connectData}))", b.DataSource);
        Assert.Equal("shop", b.UserID);
        Assert.Equal("secret", b.Password);
        Assert.Equal(pooling, b.Pooling);
        Assert.Equal(0, b.StatementCacheSize);
        Assert.Equal(role == "normal" ? "" : role.ToUpperInvariant(), b.DBAPrivilege);
    }

    [Fact]
    public void Basic_DefaultsPortAndType()
    {
        var b = new OracleConnectionStringBuilder(OracleConnectionStrings.Build(
            Profile(("host", "h"), ("serviceName", "svc"), ("user", "u")), null, false));
        Assert.Contains("(PORT=1521)", b.DataSource);
        Assert.Equal("", b.Password);
        Assert.False(b.Pooling);
        Assert.Equal(15, b.ConnectionTimeout);
    }

    [Fact]
    public void Tns_UsesAlias()
    {
        var b = new OracleConnectionStringBuilder(OracleConnectionStrings.Build(
            Profile(("connectionType", "tns"), ("tnsAlias", "PRODDB"), ("user", "u"), ("host", "ignored")), "p", true));
        Assert.Equal("PRODDB", b.DataSource);
    }

    [Fact]
    public void Descriptor_IsPassedThrough()
    {
        const string d = "(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCPS)(HOST=a)(PORT=2484)))(CONNECT_DATA=(SERVICE_NAME=s)))";
        var b = new OracleConnectionStringBuilder(OracleConnectionStrings.Build(Profile(("connectionType", "descriptor"), ("descriptor", d), ("user", "u")), "p", true));
        Assert.Equal(d, b.DataSource);
    }

    [Theory]
    [InlineData("basic", "host", null)]
    [InlineData("basic", "serviceName", null)]
    [InlineData("tns", "tnsAlias", "")]
    [InlineData("descriptor", "descriptor", " ")]
    public void MissingRequiredField_Throws(string type, string key, string? value)
    {
        var props = new Dictionary<string, JsonNode?> { ["connectionType"] = type, ["host"] = "h", ["serviceName"] = "s", ["user"] = "u", [key] = value };
        var profile = new ConnectionProfile { ProviderId = "oracle", Props = props };
        Assert.Throws<ArgumentException>(() => OracleConnectionStrings.Build(profile, null, false));
    }

    [Theory]
    [InlineData("ldap")]
    public void UnknownConnectionType_Throws(string type) =>
        Assert.Throws<ArgumentException>(() => OracleConnectionStrings.Build(Profile(("connectionType", type), ("user", "u")), null, false));

    [Fact]
    public void UnknownRole_Throws() =>
        Assert.Throws<ArgumentException>(() => OracleConnectionStrings.Build(Profile(("host", "h"), ("serviceName", "s"), ("role", "sysasm")), null, false));

    [Theory]
    [InlineData(0)]
    [InlineData(70000)]
    public void InvalidPort_Throws(int port) =>
        Assert.Throws<ArgumentException>(() => OracleConnectionStrings.Build(Profile(("host", "h"), ("serviceName", "s"), ("port", port)), null, false));

    [Theory]
    [InlineData("Secret123", "Secret123")]
    [InlineData("p_w$#1", "p_w$#1")]
    [InlineData("p@ss;word", "\"p@ss;word\"")]
    [InlineData("has space", "\"has space\"")]
    [InlineData("\"already\"", "\"already\"")]
    [InlineData("q\"uote!", "q\"uote!")]
    public void SpecialCharacters_AreQuoted(string input, string expected) => Assert.Equal(expected, OracleConnectionStrings.QuoteIfNeeded(input));

    [Fact]
    public void PasswordWithSemicolon_RoundTripsThroughBuilder()
    {
        var b = new OracleConnectionStringBuilder(OracleConnectionStrings.Build(Profile(("host", "h"), ("serviceName", "s"), ("user", "u")), "a;b=c", false));
        Assert.Equal("\"a;b=c\"", b.Password);
    }

    [Fact]
    public void Provider_SessionString_HasPoolingOff()
    {
        var cs = new OracleProvider().BuildConnectionString(Profile(("host", "h"), ("serviceName", "s"), ("user", "u")), "p");
        var b = new OracleConnectionStringBuilder(cs);
        Assert.False(b.Pooling);
        Assert.Equal(0, b.StatementCacheSize);
    }

    [Fact]
    public void FormSpec_HasPlanFieldKeys()
    {
        var spec = new OracleProvider().FormSpec;
        Assert.Equal(new[] { "connectionType", "host", "port", "serviceName", "sid", "tnsAlias", "descriptor", "user", "password", "role", "extraSchemas" },
            spec.Fields.Select(f => f.Key));
        Assert.Equal(new[] { "basic", "tns", "descriptor" }, spec.Fields.Single(f => f.Key == "connectionType").Options!.Select(o => o.Value));
        Assert.Equal(new[] { "normal", "sysdba", "sysoper" }, spec.Fields.Single(f => f.Key == "role").Options!.Select(o => o.Value));
        Assert.Equal("list", spec.Fields.Single(f => f.Key == "extraSchemas").Type);
        Assert.Equal(1521, spec.Fields.Single(f => f.Key == "port").Default!.GetValue<int>());
        Assert.Equal("basic", spec.Fields.Single(f => f.Key == "host").VisibleWhen!["connectionType"]);
        Assert.Equal("tns", spec.Fields.Single(f => f.Key == "tnsAlias").VisibleWhen!["connectionType"]);
        Assert.Equal("descriptor", spec.Fields.Single(f => f.Key == "descriptor").VisibleWhen!["connectionType"]);
    }

    [Fact]
    public void Provider_Identity()
    {
        var p = new OracleProvider();
        Assert.Equal("oracle", p.Id);
        Assert.Equal(Dialect.PlSql, p.Dialect);
        Assert.Null(p.Diagnostics);
        Assert.Equal(('"', '"', "upper"), (p.Identifiers.QuoteOpen, p.Identifiers.QuoteClose, p.Identifiers.CaseFolding));
        Assert.Contains("ROWNUM", p.Identifiers.ReservedWords);
        Assert.IsType<OracleDdlGenerator>(p.DdlGenerator);
    }
}

/// <summary>PLAN risk R1: ODP.NET Core (net8.0 build) on .NET 10.</summary>
public sealed class OracleDriverSmokeTests
{
    [Fact]
    public async Task OpenToBogusHost_FailsWithNetworkError_NotTypeLoad()
    {
        var profile = new ConnectionProfile
        {
            ProviderId = "oracle",
            Props = new Dictionary<string, JsonNode?>
            {
                ["host"] = "nonexistent-host.invalid", ["port"] = 1521, ["serviceName"] = "FREEPDB1", ["user"] = "shop", ["connectTimeout"] = 5,
            },
        };
        var sw = Stopwatch.StartNew();
        await using var conn = new OracleConnection(OracleConnectionStrings.Build(profile, "x", pooling: false));
        var ex = await Assert.ThrowsAsync<OracleException>(() => conn.OpenAsync()).WaitAsync(TimeSpan.FromSeconds(60));
        // ORA-12545 (host unknown) / ORA-12154 / ORA-50201 / ORA-125xx network family: anything but a type-load failure.
        Assert.True(ex.Number is >= 12150 and <= 12699 or >= 50000, $"Unexpected ORA-{ex.Number}: {ex.Message}");
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(60));
    }

    [Fact]
    public async Task TestAsync_BogusHost_ReturnsProviderError()
    {
        var profile = new ConnectionProfile
        {
            ProviderId = "oracle",
            Props = new Dictionary<string, JsonNode?>
            {
                ["host"] = "127.0.0.1", ["port"] = 1, ["serviceName"] = "FREEPDB1", ["user"] = "shop", ["connectTimeout"] = 3,
            },
        };
        var result = await new OracleProvider().TestAsync(profile, "x", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(60));
        Assert.False(result.Ok);
        Assert.Equal("PROVIDER_ERROR", result.Error!.Code);
        Assert.NotNull(result.Error.ProviderCode);
        Assert.StartsWith("ORA-", result.Error.Detail);
    }
}
