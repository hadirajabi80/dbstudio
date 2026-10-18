using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Core.Services;

/// <summary>A provider as listed by <c>GET /providers</c>: <see cref="Dialect"/> is null for non-relational sources.</summary>
public sealed record SourceProviderDescriptor(string Id, string DisplayName, Dialect? Dialect, ConnectionFormSpec FormSpec, SourceKind Kind);

/// <summary>
/// M2 (docs/PLAN-M2.md D1): every provider id the engine knows — the relational <see cref="IDbProvider"/>s of
/// <see cref="ProviderRegistry"/> (wrapped in <see cref="RelationalSourceAdapter"/>) plus the registered
/// <see cref="IDataSourceProvider"/>s (Redis, MongoDB, Kafka). SQL code paths keep using <see cref="ProviderRegistry"/>.
/// </summary>
public sealed class SourceRegistry
{
    /// <summary>Display order of <c>GET /providers</c> (unknown ids follow, by id).</summary>
    public static readonly IReadOnlyList<string> DisplayOrder = ["sqlserver", "oracle", "postgresql", "sqlite", "redis", "mongodb", "kafka"];

    private readonly Dictionary<string, IDataSourceProvider> _byId = new(StringComparer.OrdinalIgnoreCase);
    private readonly ProviderRegistry _relational;

    public SourceRegistry(ProviderRegistry relational, IEnumerable<IDataSourceProvider> sources)
    {
        _relational = relational;
        foreach (var p in relational.All) _byId.TryAdd(p.Id, new RelationalSourceAdapter(p));
        foreach (var s in sources)
        {
            // A relational provider id always wins; a module must not shadow it.
            if (!_byId.TryAdd(s.Id, s)) Debug.WriteLine($"Duplicate data source provider id '{s.Id}' ignored.");
        }
    }

    /// <summary>Every provider in <see cref="DisplayOrder"/>.</summary>
    public IReadOnlyList<IDataSourceProvider> All =>
        _byId.Values.OrderBy(p => Rank(p.Id)).ThenBy(p => p.Id, StringComparer.OrdinalIgnoreCase).ToList();

    public ProviderRegistry Relational => _relational;

    /// <summary>400 VALIDATION for an unknown id.</summary>
    public IDataSourceProvider Get(string providerId) =>
        Find(providerId) ?? throw EngineException.Validation($"Unknown provider '{providerId}'.", new { field = "providerId" });

    public IDataSourceProvider? Find(string? providerId) =>
        providerId is not null && _byId.TryGetValue(providerId, out var p) ? p : null;

    /// <summary>Kind of a provider id (400 VALIDATION when unknown).</summary>
    public SourceKind KindOf(string providerId) => Get(providerId).Kind;

    public bool IsRelational(string providerId) => Find(providerId)?.Kind == SourceKind.Relational;

    /// <summary>The relational dialect of a provider id, null for non-relational or unknown ids.</summary>
    public Dialect? DialectOf(string providerId) => _relational.Find(providerId)?.Dialect;

    /// <summary>Wire list of <c>GET /providers</c>, in <see cref="DisplayOrder"/>.</summary>
    public IReadOnlyList<SourceProviderDescriptor> Describe() =>
        All.Select(p => new SourceProviderDescriptor(p.Id, p.DisplayName, DialectOf(p.Id), p.FormSpec, p.Kind)).ToList();

    private static int Rank(string id)
    {
        for (var i = 0; i < DisplayOrder.Count; i++)
        {
            if (string.Equals(DisplayOrder[i], id, StringComparison.OrdinalIgnoreCase)) return i;
        }
        return DisplayOrder.Count;
    }
}

/// <summary>
/// Presents a relational <see cref="IDbProvider"/> as an <see cref="IDataSourceProvider"/> of kind relational.
/// Relational connections use tab sessions (<see cref="SessionManager"/>), so <see cref="OpenAsync"/> is not supported.
/// </summary>
public sealed class RelationalSourceAdapter(IDbProvider provider) : IDataSourceProvider
{
    public IDbProvider Provider { get; } = provider;
    public string Id => Provider.Id;
    public string DisplayName => Provider.DisplayName;
    public SourceKind Kind => SourceKind.Relational;
    public ConnectionFormSpec FormSpec => Provider.FormSpec;

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        Provider.TestAsync(profile, password, ct);

    public Task<IDataSourceClient> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw EngineException.Validation($"'{Provider.DisplayName}' connections use sessions (POST /sessions), not source clients.");
}
