using DbStudio.Providers.Conformance;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>The shared provider conformance suite against Oracle Free 23ai (skipped without Docker).</summary>
public sealed class OracleConformanceTests(OracleFixture fixture) : ProviderConformanceTests<OracleFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}
