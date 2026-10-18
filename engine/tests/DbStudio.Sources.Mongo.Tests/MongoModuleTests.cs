using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Sources.Mongo.Tests;

/// <summary>M2-0 skeleton test: the module is discoverable and registers the Mongo provider.</summary>
public sealed class MongoModuleTests
{
    [Fact]
    public void Module_is_discovered_and_registers_the_provider()
    {
        var modules = EngineModules.Discover(typeof(MongoModule).Assembly);
        var module = Assert.Single(modules, m => m is MongoModule);

        var services = new ServiceCollection();
        module.ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        var provider = Assert.Single(sp.GetServices<IDataSourceProvider>());

        Assert.Equal("mongodb", provider.Id);
        Assert.Equal(SourceKind.Document, provider.Kind);
        Assert.NotEmpty(provider.FormSpec.Fields);
    }
}
