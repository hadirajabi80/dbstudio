using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Core.Services;

/// <summary>All registered <see cref="IDbProvider"/>s, by id and dialect.</summary>
public sealed class ProviderRegistry
{
    private readonly Dictionary<string, IDbProvider> _byId;

    public ProviderRegistry(IEnumerable<IDbProvider> providers)
    {
        _byId = new Dictionary<string, IDbProvider>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in providers) _byId.TryAdd(p.Id, p);
    }

    public IReadOnlyCollection<IDbProvider> All => _byId.Values;

    public IDbProvider Get(string providerId) =>
        _byId.TryGetValue(providerId, out var p) ? p : throw EngineException.Validation($"Unknown provider '{providerId}'.");

    public IDbProvider? Find(string providerId) => _byId.GetValueOrDefault(providerId);

    public IDbProvider? ForDialect(Dialect dialect) => _byId.Values.FirstOrDefault(p => p.Dialect == dialect);
}
