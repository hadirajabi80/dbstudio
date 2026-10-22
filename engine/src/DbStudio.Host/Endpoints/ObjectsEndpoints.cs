using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Host.Endpoints;

/// <summary>
/// Object browser (WP3): the Objects tab list with statistics and the Dependencies section of the object tab.
///   GET /connections/{id}/catalog/objects?database&amp;schema&amp;type        → ObjectListItem[]
///   GET /connections/{id}/catalog/dependencies?database&amp;schema&amp;name&amp;type → DependencyGraph
/// </summary>
public static class ObjectsEndpoints
{
    private static readonly HashSet<string> KnownTypes =
    [
        ObjectTypes.Table, ObjectTypes.View, ObjectTypes.MView, ObjectTypes.Proc, ObjectTypes.Func, ObjectTypes.TableFunc,
        ObjectTypes.Synonym, ObjectTypes.Sequence, ObjectTypes.Package, ObjectTypes.Type, ObjectTypes.Trigger,
    ];

    public static RouteGroupBuilder MapObjects(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections/{id}/catalog");

        g.MapGet("/objects", async (string id, string? database, string? schema, string? type, ConnectionStore connections, ProviderRegistry providers,
            CancellationToken ct) =>
        {
            var t = Type(type, required: false);
            var (browser, profile, password) = Resolve(id, connections, providers);
            await using var reader = await browser.OpenObjectListReaderAsync(profile, password, ct).ConfigureAwait(false);
            return await reader.ListAsync(Blank(database), Blank(schema), t, ct).ConfigureAwait(false);
        });

        g.MapGet("/dependencies", async (string id, string? database, string? schema, string? name, string? type, ConnectionStore connections,
            ProviderRegistry providers, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
            var obj = new ObjectRef(Blank(database), Blank(schema), name, Type(type, required: true)!);
            var (browser, profile, password) = Resolve(id, connections, providers);
            await using var reader = await browser.OpenDependencyReaderAsync(profile, password, ct).ConfigureAwait(false);
            return await reader.GetDependenciesAsync(obj, ct).ConfigureAwait(false);
        });

        return api;
    }

    private static (IObjectBrowserProvider Browser, ConnectionProfile Profile, string? Password) Resolve(string id, ConnectionStore connections,
        ProviderRegistry providers)
    {
        var profile = connections.Get(id);
        return (ProviderFeatures.ObjectBrowser(providers.Get(profile.ProviderId)), profile, connections.GetPassword(id));
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static string? Type(string? type, bool required)
    {
        if (string.IsNullOrWhiteSpace(type)) return required ? ObjectTypes.Table : null;
        var t = type.Trim().ToLowerInvariant();
        if (!KnownTypes.Contains(t)) throw EngineException.Validation($"Unknown object type '{type}'.", new { field = "type" });
        return t;
    }
}
