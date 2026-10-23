using DbStudio.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.MySql.Tests;

/// <summary>WP0 skeleton test: the module is discoverable and its registrations build. WP-MY extends or replaces it.</summary>
public sealed class SmokeTests
{
    [Fact]
    public void Module_is_discovered_and_configures()
    {
        var modules = EngineModules.Discover(typeof(MySqlModule).Assembly);
        var module = Assert.Single(modules, m => m is MySqlModule);

        var services = new ServiceCollection();
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        Assert.NotNull(sp);
    }
}
