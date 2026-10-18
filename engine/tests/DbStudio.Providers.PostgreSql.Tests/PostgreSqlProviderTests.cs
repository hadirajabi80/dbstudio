using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>M2-0 skeleton test (PG-A replaces the stubs and extends this project per docs/PLAN-PG.md 2.9).</summary>
public sealed class PostgreSqlProviderTests
{
    [Fact]
    public void Provider_contract_values_are_final()
    {
        var p = new PostgreSqlProvider();
        Assert.Equal("postgresql", p.Id);
        Assert.Equal(Dialect.PgSql, p.Dialect);
        Assert.Equal("pgsql", CoreJson.ToWire(p.Dialect));
        Assert.Equal("lower", p.Identifiers.CaseFolding);
        Assert.Contains(p.FormSpec.Fields, f => f.Key == "host" && f.Required);
        Assert.Contains(p.FormSpec.Fields, f => f.Key == "password" && f.Type == "password");
    }
}
