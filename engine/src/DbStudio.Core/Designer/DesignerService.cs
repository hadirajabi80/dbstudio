using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Designer;

/// <summary>
/// Orchestrates the designer endpoints (docs/PLAN-M1.5.md 3.9): resolves the connection's provider-specific scripter
/// and database access, validates input, and after a successful apply invalidates the catalog (catalog.changed push).
/// DDL never runs on a tab session or the catalog connection: <see cref="IDesignerDatabase"/> opens its own.
/// </summary>
public sealed class DesignerService(ConnectionStore connections, ProviderRegistry providers, ProviderFeatures features, CatalogService catalog)
{
    private (ConnectionProfile Profile, ProviderRef Provider, string? Password) Resolve(string connectionId)
    {
        var profile = connections.Get(connectionId);
        var provider = providers.Get(profile.ProviderId);
        return (profile, new ProviderRef(provider.Id, provider.Dialect), connections.GetPassword(connectionId));
    }

    private readonly record struct ProviderRef(string Id, Dialect Dialect);

    public async Task<DesignerTypesInfo> GetTypesAsync(string connectionId, string? database, CancellationToken ct)
    {
        var (profile, provider, password) = Resolve(connectionId);
        var context = await features.Database(provider.Id).GetScriptContextAsync(profile, password, database, null, null, ct).ConfigureAwait(false);
        return features.Scripter(provider.Id).GetTypes(context);
    }

    public Task<TableModel> GetTableAsync(string connectionId, string? database, string? schema, string name, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var (profile, provider, password) = Resolve(connectionId);
        return features.Database(provider.Id).ReadTableAsync(profile, password, Blank(database), Blank(schema), name.Trim(), ct);
    }

    public async Task<TableScript> ScriptTableAsync(string connectionId, string? database, TableModel? original, TableModel? desired, CancellationToken ct)
    {
        if (desired is null) throw EngineException.Validation("desired is required.", new { field = "desired" });
        var (profile, provider, password) = Resolve(connectionId);
        var context = await features.Database(provider.Id)
            .GetScriptContextAsync(profile, password, Blank(database), original?.Schema ?? desired.Schema, original?.Name, ct).ConfigureAwait(false);
        try
        {
            return features.Scripter(provider.Id).ScriptTable(original, desired, context);
        }
        catch (ArgumentException ex)
        {
            throw EngineException.Validation(ex.Message, new { field = "desired" });
        }
    }

    public Task<ViewModel> GetViewAsync(string connectionId, string? database, string? schema, string name, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var (profile, provider, password) = Resolve(connectionId);
        return features.Database(provider.Id).ReadViewAsync(profile, password, Blank(database), Blank(schema), name.Trim(), ct);
    }

    public async Task<DdlScript> ScriptViewAsync(string connectionId, string? database, ViewDefinition? view, CancellationToken ct)
    {
        if (view is null) throw EngineException.Validation("A request body is required.");
        if (string.IsNullOrWhiteSpace(view.Name)) throw EngineException.Validation("name is required.", new { field = "name" });
        if (string.IsNullOrWhiteSpace(view.Body)) throw EngineException.Validation("body is required.", new { field = "body" });
        var (profile, provider, password) = Resolve(connectionId);
        var context = await features.Database(provider.Id).GetScriptContextAsync(profile, password, Blank(database), view.Schema, null, ct).ConfigureAwait(false);
        try
        {
            return features.Scripter(provider.Id).ScriptView(view, context);
        }
        catch (ArgumentException ex)
        {
            throw EngineException.Validation(ex.Message, new { field = "body" });
        }
    }

    public async Task<DdlApplyResult> ApplyAsync(string connectionId, DdlApplyRequest? request, CancellationToken ct)
    {
        if (request?.Statements is null || request.Statements.Count == 0 || request.Statements.All(string.IsNullOrWhiteSpace))
            throw EngineException.Validation("statements must contain at least one statement.", new { field = "statements" });
        var (profile, provider, password) = Resolve(connectionId);
        if (profile.ReadOnly)
            throw new EngineException(403, ErrorCodes.ReadOnly, $"The connection '{profile.Name}' is read-only: DDL is not allowed.");

        var normalized = request with { Database = Blank(request.Database), Schema = Blank(request.Schema) };
        try
        {
            return await features.Database(provider.Id).ApplyAsync(profile, password, normalized, ct).ConfigureAwait(false);
        }
        finally
        {
            // Also after a partial (non-transactional) failure: what ran changed the catalog.
            Invalidate(connectionId, provider.Dialect, normalized);
        }
    }

    private void Invalidate(string connectionId, Dialect dialect, DdlApplyRequest request)
    {
        var targets = new List<DdlTarget>();
        foreach (var sql in request.Statements)
        {
            if (string.IsNullOrWhiteSpace(sql)) continue;
            targets.AddRange(StatementClassifier.Classify(sql, dialect).DdlTargets);
        }
        // sp_rename / EXEC / PRAGMA-driven changes are not DDL to the classifier: refresh the target schema anyway.
        targets.Add(new DdlTarget("ALTER", ObjectTypes.Table, request.Database, request.Schema, null, DdlScope.Object));
        try
        {
            catalog.InvalidateAfterDdl(connectionId, dialect, request.Database, targets);
        }
        catch (EngineException)
        {
            // The connection was deleted meanwhile.
        }
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
