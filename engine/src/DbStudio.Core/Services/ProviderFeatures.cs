using DbStudio.Core.Designer;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Core.Services;

/// <summary>
/// M1.5 per-provider capabilities (docs/PLAN-M1.5.md: "keyed DI services by provider id") — DDL scripters, designer
/// database access, plan readers and parameter binders — looked up by provider id, so <c>IDbProvider</c> stays as is.
/// </summary>
public sealed class ProviderFeatures
{
    private readonly Func<string, IDdlScripter?> _scripters;
    private readonly Func<string, IDesignerDatabase?> _databases;
    private readonly Func<string, IPlanReader?> _plans;
    private readonly Func<string, IParamBinder?> _binders;

    public ProviderFeatures(IEnumerable<IDdlScripter> scripters, IEnumerable<IDesignerDatabase> databases, IEnumerable<IPlanReader> plans,
        IEnumerable<IParamBinder> binders)
    {
        var s = scripters.ToDictionary(x => x.ProviderId, StringComparer.OrdinalIgnoreCase);
        var d = databases.ToDictionary(x => x.ProviderId, StringComparer.OrdinalIgnoreCase);
        var p = plans.ToDictionary(x => x.ProviderId, StringComparer.OrdinalIgnoreCase);
        var b = binders.ToDictionary(x => x.ProviderId, StringComparer.OrdinalIgnoreCase);
        _scripters = id => s.GetValueOrDefault(id);
        _databases = id => d.GetValueOrDefault(id);
        _plans = id => p.GetValueOrDefault(id);
        _binders = id => b.GetValueOrDefault(id);
    }

    private ProviderFeatures(IServiceProvider services)
    {
        _scripters = id => services.GetKeyedService<IDdlScripter>(id);
        _databases = id => services.GetKeyedService<IDesignerDatabase>(id);
        _plans = id => services.GetKeyedService<IPlanReader>(id);
        _binders = id => services.GetKeyedService<IParamBinder>(id);
    }

    /// <summary>Resolves the keyed services registered under the provider ids.</summary>
    public static ProviderFeatures FromServices(IServiceProvider services) => new(services);

    public IDdlScripter Scripter(string providerId) => _scripters(providerId) ?? throw NotSupported(providerId, "the table designer");
    public IDesignerDatabase Database(string providerId) => _databases(providerId) ?? throw NotSupported(providerId, "the table designer");
    public IPlanReader PlanReader(string providerId) => _plans(providerId) ?? throw NotSupported(providerId, "explain plans");
    public IParamBinder? Binder(string providerId) => _binders(providerId);

    private static EngineException NotSupported(string providerId, string what) =>
        new(400, ErrorCodes.NotSupported, $"The provider '{providerId}' does not support {what}.");
}
