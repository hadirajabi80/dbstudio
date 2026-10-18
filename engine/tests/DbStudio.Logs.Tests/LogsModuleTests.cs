using DbStudio.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Logs.Tests;

/// <summary>M2-0 skeleton test: the logs module is discoverable and configures without errors.</summary>
public sealed class LogsModuleTests
{
    [Fact]
    public void Module_is_discovered()
    {
        var module = Assert.Single(EngineModules.Discover(typeof(LogsModule).Assembly), m => m is LogsModule);
        var services = new ServiceCollection();
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        Assert.NotNull(sp);
    }
}
