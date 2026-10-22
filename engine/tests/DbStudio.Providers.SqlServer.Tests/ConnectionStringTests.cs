using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer.Tests;

public sealed class ConnectionStringTests
{
    private static ConnectionProfile Profile(params (string Key, JsonNode? Value)[] props) => new()
    {
        Id = "c_test",
        ProviderId = "sqlserver",
        Props = props.ToDictionary(p => p.Key, p => p.Value),
    };

    public static TheoryData<string, string, bool, bool, string?, int> Combinations()
    {
        var data = new TheoryData<string, string, bool, bool, string?, int>();
        foreach (var auth in new[] { "sql", "windows" })
        foreach (var encrypt in new[] { "optional", "mandatory", "strict" })
        foreach (var trust in new[] { true, false })
        foreach (var pooling in new[] { true, false })
        foreach (var db in new[] { null, "AdventureWorks" })
            data.Add(auth, encrypt, trust, pooling, db, 7);
        return data;
    }

    [Theory]
    [MemberData(nameof(Combinations))]
    public void EveryFormCombination_BuildsExpectedString(string auth, string encrypt, bool trust, bool pooling, string? database, int timeout)
    {
        var profile = Profile(("server", @"host\SQLEXPRESS"), ("auth", auth), ("user", "app"), ("database", database),
            ("encrypt", encrypt), ("trustServerCertificate", trust), ("connectTimeout", timeout));
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(profile, "p@ss;word=1", pooling));

        Assert.Equal(@"host\SQLEXPRESS", b.DataSource);
        Assert.Equal("Rowlit", b.ApplicationName);
        Assert.False(b.MultipleActiveResultSets);
        Assert.Equal(pooling, b.Pooling);
        Assert.Equal(timeout, b.ConnectTimeout);
        Assert.Equal(trust, b.TrustServerCertificate);
        Assert.Equal(SqlServerConnectionStrings.ParseEncrypt(encrypt), b.Encrypt);
        Assert.Equal(database ?? "", b.InitialCatalog);
        if (auth == "windows")
        {
            Assert.True(b.IntegratedSecurity);
            Assert.Equal("", b.UserID);
            Assert.Equal("", b.Password);
        }
        else
        {
            Assert.False(b.IntegratedSecurity);
            Assert.Equal("app", b.UserID);
            Assert.Equal("p@ss;word=1", b.Password);
        }
    }

    [Fact]
    public void Defaults_WhenOptionalFieldsMissing()
    {
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(Profile(("server", "db,1433"), ("user", "sa")), "x", pooling: false));
        Assert.Equal("db,1433", b.DataSource);
        Assert.False(b.IntegratedSecurity);
        Assert.Equal(15, b.ConnectTimeout);
        Assert.True(b.TrustServerCertificate);
        Assert.Equal(SqlConnectionEncryptOption.Optional, b.Encrypt);
        Assert.False(b.Pooling);
    }

    [Fact]
    public void Provider_SessionString_HasPoolingOff()
    {
        var cs = new SqlServerProvider().BuildConnectionString(Profile(("server", "s"), ("auth", "sql"), ("user", "u")), "p");
        Assert.False(new SqlConnectionStringBuilder(cs).Pooling);
    }

    [Fact]
    public void StringTypedProps_AreAccepted()
    {
        // Values typed as strings by older UI builds ("true", "30") still work.
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(
            Profile(("server", "s"), ("trustServerCertificate", "false"), ("connectTimeout", "30"), ("encrypt", "Mandatory")), null, true));
        Assert.False(b.TrustServerCertificate);
        Assert.Equal(30, b.ConnectTimeout);
        Assert.Equal(SqlConnectionEncryptOption.Mandatory, b.Encrypt);
    }

    [Fact]
    public void NullPassword_IsOmitted()
    {
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(Profile(("server", "s"), ("user", "u")), null, true));
        Assert.Equal("", b.Password);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void MissingServer_Throws(string? server) =>
        Assert.Throws<ArgumentException>(() => SqlServerConnectionStrings.Build(Profile(("server", server)), null, false));

    [Fact]
    public void UnknownAuth_Throws() =>
        Assert.Throws<ArgumentException>(() => SqlServerConnectionStrings.Build(Profile(("server", "s"), ("auth", "kerberos-magic")), null, false));

    [Fact]
    public void UnknownEncrypt_Throws() =>
        Assert.Throws<ArgumentException>(() => SqlServerConnectionStrings.Build(Profile(("server", "s"), ("encrypt", "maybe")), null, false));

    [Fact]
    public void FormSpec_HasPlanFieldKeys()
    {
        var spec = new SqlServerProvider().FormSpec;
        Assert.Equal(new[] { "server", "auth", "user", "password", "database", "encrypt", "trustServerCertificate", "connectTimeout" },
            spec.Fields.Select(f => f.Key));
        var auth = spec.Fields.Single(f => f.Key == "auth");
        Assert.Equal(new[] { "sql", "windows" }, auth.Options!.Select(o => o.Value));
        Assert.Equal("sql", auth.Default!.GetValue<string>());
        Assert.Equal("sql", spec.Fields.Single(f => f.Key == "user").VisibleWhen!["auth"]);
        Assert.Equal("sql", spec.Fields.Single(f => f.Key == "password").VisibleWhen!["auth"]);
        Assert.Equal("password", spec.Fields.Single(f => f.Key == "password").Type);
        Assert.Equal("optional", spec.Fields.Single(f => f.Key == "encrypt").Default!.GetValue<string>());
        Assert.True(spec.Fields.Single(f => f.Key == "trustServerCertificate").Default!.GetValue<bool>());
        Assert.Equal(15, spec.Fields.Single(f => f.Key == "connectTimeout").Default!.GetValue<int>());
        Assert.True(spec.Fields.Single(f => f.Key == "server").Required);
    }

    [Fact]
    public void Provider_Identity()
    {
        var p = new SqlServerProvider();
        Assert.Equal("sqlserver", p.Id);
        Assert.Equal("Microsoft SQL Server", p.DisplayName);
        Assert.Equal(Dialect.TSql, p.Dialect);
        Assert.Equal(('[', ']', "preserve"), (p.Identifiers.QuoteOpen, p.Identifiers.QuoteClose, p.Identifiers.CaseFolding));
        Assert.Contains("SELECT", p.Identifiers.ReservedWords);
        Assert.Contains("select", p.Identifiers.ReservedWords);
        Assert.IsType<TSql.TSqlDdlGenerator>(p.DdlGenerator);
    }

    [Fact]
    public async Task TestAsync_UnreachableServer_ReturnsProviderError()
    {
        var profile = Profile(("server", "127.0.0.1,1"), ("user", "sa"), ("connectTimeout", 2));
        var result = await new SqlServerProvider().TestAsync(profile, "x", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(60));
        Assert.False(result.Ok);
        Assert.Null(result.ServerInfo);
        Assert.Equal("PROVIDER_ERROR", result.Error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(result.Error.Message));
    }
}
