using DbStudio.Providers.Conformance;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>The shared provider conformance suite against SQL Server (skipped without Docker).</summary>
public sealed class SqlServerConformanceTests(SqlServerFixture fixture) : ProviderConformanceTests<SqlServerFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        // Seeding errors must fail loudly instead of silently skipping the suite.
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}
