using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Kafka.Tests;

/// <summary>M2-0 skeleton test: the module is discoverable and registers the Kafka provider.</summary>
public sealed class KafkaModuleTests
{
    [Fact]
    public void Module_is_discovered_and_registers_the_provider()
    {
        var modules = EngineModules.Discover(typeof(KafkaModule).Assembly);
        var module = Assert.Single(modules, m => m is KafkaModule);

        var services = new ServiceCollection();
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        var provider = Assert.Single(sp.GetServices<IDataSourceProvider>());

        Assert.Equal("kafka", provider.Id);
        Assert.Equal(SourceKind.Stream, provider.Kind);
        Assert.NotEmpty(provider.FormSpec.Fields);
    }
}
