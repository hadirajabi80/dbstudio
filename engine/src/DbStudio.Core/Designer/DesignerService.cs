using System.Diagnostics;
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
/// <param name="sessions">Optional: names the tab sessions holding a lock that made an apply give up (logic-02).</param>
/// <param name="history">Optional: records every apply in the query history (features-r1-06).</param>
public sealed class DesignerService(ConnectionStore connections, ProviderRegistry providers, ProviderFeatures features, CatalogService catalog,
    SessionManager? sessions = null, HistoryService? history = null)
{
    private (ConnectionProfile Profile, ProviderRef Provider, string? Password) Resolve(string connectionId)
    {
        var profile = connections.WithSecrets(connections.Get(connectionId));
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

    public Task<DdlApplyResult> ApplyAsync(string connectionId, DdlApplyRequest? request, CancellationToken ct) =>
        ApplyAsync(connectionId, request, null, ct);

    /// <summary>
    /// Runs the statements on a dedicated connection (one transaction when requested). Every attempted apply is recorded
    /// in the query history under label <see cref="HistoryLabel"/>, successful or not (features-r1-06), so DDL changes
    /// stay auditable and can be re-run from History. Requests refused before anything runs (validation, read-only) are not.
    /// </summary>
    /// <param name="clientId">The UI client applying (names lock holders of other windows as such, design-r1-06).</param>
    public async Task<DdlApplyResult> ApplyAsync(string connectionId, DdlApplyRequest? request, string? clientId, CancellationToken ct)
    {
        if (request?.Statements is null || request.Statements.Count == 0 || request.Statements.All(string.IsNullOrWhiteSpace))
            throw EngineException.Validation("statements must contain at least one statement.", new { field = "statements" });
        var (profile, provider, password) = Resolve(connectionId);
        if (profile.ReadOnly)
            throw new EngineException(403, ErrorCodes.ReadOnly, $"The connection '{profile.Name}' is read-only: DDL is not allowed.");

        var normalized = request with { Database = Blank(request.Database), Schema = Blank(request.Schema) };
        var startedAt = DateTimeOffset.UtcNow;
        var sw = Stopwatch.StartNew();
        var status = ExecutionStatus.Error;
        string? error = null;
        long? elapsedMs = null;
        try
        {
            var result = await features.Database(provider.Id).ApplyAsync(profile, password, normalized, ct).ConfigureAwait(false);
            status = result.Ok ? ExecutionStatus.Ok : ExecutionStatus.Error;
            elapsedMs = result.ElapsedMs;
            return result;
        }
        catch (DdlFailedException failed) when (sessions is not null && LockWait.IsLockError(failed.ProviderError.Code))
        {
            // Same wording as executions: "Database is locked by another session: Console 1 (open transaction). ..."
            var described = LockWait.Describe(sessions.DescribeLockHolders(profile, null, clientId));
            var message = failed.Message.Replace(LockWait.Message + ".", described, StringComparison.Ordinal);
            error = message;
            throw new DdlFailedException(message, failed.FailedIndex, failed.Executed, failed.RolledBack, failed.ProviderError with { Message = described });
        }
        catch (OperationCanceledException)
        {
            status = ExecutionStatus.Cancelled;
            throw;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            throw;
        }
        finally
        {
            // Also after a partial (non-transactional) failure: what ran changed the catalog.
            Invalidate(connectionId, provider.Dialect, normalized);
            await RecordHistoryAsync(connectionId, provider.Dialect, normalized, startedAt, elapsedMs ?? sw.ElapsedMilliseconds, status, error)
                .ConfigureAwait(false);
        }
    }

    /// <summary>History label of designer applies (table/view designers, atomic "Edit:" runs).</summary>
    public const string HistoryLabel = "designer";

    private async Task RecordHistoryAsync(string connectionId, Dialect dialect, DdlApplyRequest request, DateTimeOffset startedAt, long elapsedMs,
        ExecutionStatus status, string? error)
    {
        if (history is null) return;
        try
        {
            await history.AddAsync(connectionId, request.Database, HistorySql(dialect, request.Statements), startedAt, elapsedMs, status,
                null, null, error, HistoryLabel, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // History is best effort: a failure to record must not turn a finished apply into an error.
        }
    }

    /// <summary>
    /// The applied statements as one re-runnable script: one per line, separated as the dialect's console splits batches
    /// (T-SQL GO, PL/SQL "/", else ";"), so a CREATE PROCEDURE stays alone in its batch when run again from History.
    /// </summary>
    internal static string HistorySql(Dialect dialect, IReadOnlyList<string> statements)
    {
        var list = statements.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).ToList();
        if (list.Count == 1) return list[0];
        return dialect switch
        {
            Dialect.TSql => string.Join("\nGO\n", list),
            Dialect.PlSql => string.Join("\n/\n", list),
            _ => string.Join("\n", list.Select(Terminate)),
        };

        // A trailing "-- comment" would swallow an appended ';': put it on its own line then.
        static string Terminate(string s) =>
            s.EndsWith(';') ? s : s[(s.LastIndexOf('\n') + 1)..].Contains("--", StringComparison.Ordinal) ? s + "\n;" : s + ";";
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
