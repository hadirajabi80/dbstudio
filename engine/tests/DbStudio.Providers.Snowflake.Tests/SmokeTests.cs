using DbStudio.Core.Designer;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs;
using DbStudio.Logs.Sql;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>The module is discoverable and registers the provider and its keyed services.</summary>
public sealed class SmokeTests
{
    [Fact]
    public void Module_is_discovered_and_registers_the_provider()
    {
        var modules = EngineModules.Discover(typeof(SnowflakeModule).Assembly);
        var module = Assert.Single(modules, m => m is SnowflakeModule);

        var services = new ServiceCollection();
        services.AddSingleton<ISqlRunnerFactory>(new FixtureSqlRunner());
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        var provider = Assert.Single(sp.GetServices<IDbProvider>());
        Assert.Equal(("snowflake", Core.Models.Dialect.Snowflake), (provider.Id, provider.Dialect));
        Assert.Equal("upper", provider.Identifiers.CaseFolding);
        Assert.IsAssignableFrom<IObjectBrowserProvider>(provider);
        Assert.NotNull(sp.GetRequiredKeyedService<IDdlScripter>("snowflake"));
        Assert.NotNull(sp.GetRequiredKeyedService<IDesignerDatabase>("snowflake"));
        Assert.NotNull(sp.GetRequiredKeyedService<IPlanReader>("snowflake"));
        Assert.NotNull(sp.GetRequiredKeyedService<IParamBinder>("snowflake"));
        Assert.Same(sp.GetRequiredKeyedService<ILogSource>("snowflake"), sp.GetRequiredKeyedService<IActivitySource>("snowflake"));
    }

    [Fact]
    public async Task Test_connection_reports_validation_errors_without_throwing()
    {
        var provider = new SnowflakeProvider(new FakeGatewayFactory());
        var profile = SfTestProfiles.Shop();
        var result = await provider.TestAsync(profile, null, CancellationToken.None); // password missing
        Assert.False(result.Ok);
        Assert.Equal(ErrorCodes.Validation, result.Error!.Code);
        Assert.DoesNotContain("pw", provider.BuildConnectionString(profile, "pw"));
    }
}
