using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Designer;

/// <summary>
/// Turns table/view models into DDL for one dialect (docs/PLAN-M1.5.md 1.3). Pure (no I/O): registered as a keyed
/// singleton by provider id ("sqlserver", "oracle", "sqlite") so <c>IDbProvider</c> stays unchanged.
/// </summary>
public interface IDdlScripter
{
    string ProviderId { get; }

    /// <summary>Type list and feature flags for <c>GET .../designer/types</c>.</summary>
    DesignerTypesInfo GetTypes(DdlScriptContext context);

    /// <summary>CREATE TABLE when <paramref name="original"/> is null, else the ALTER (or rebuild) script.</summary>
    TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context);

    /// <summary>CREATE OR ALTER / OR REPLACE / DROP+CREATE view script.</summary>
    DdlScript ScriptView(ViewDefinition view, DdlScriptContext context);
}

/// <summary>
/// Database side of the designer for one provider: reads table/view models over a dedicated short-lived connection
/// and applies DDL scripts with the dialect's transaction semantics (never on a tab session or the catalog connection).
/// Registered as a keyed singleton by provider id.
/// </summary>
public interface IDesignerDatabase
{
    string ProviderId { get; }

    /// <summary>
    /// Scripting context: server version (SQLite "3.46.1", SQL Server "16.0.4135.4", Oracle "23.0.0.0"), default schema
    /// and — when <paramref name="table"/> is given and the dialect rebuilds tables (SQLite) — the dependent objects.
    /// </summary>
    Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct);

    Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct);

    Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct);

    /// <summary>
    /// Runs the statements in order. Transactional: one transaction, rolled back entirely on error (SQLite handles
    /// PRAGMA foreign_keys outside it and fails on <c>PRAGMA foreign_key_check</c> rows). Non-transactional (Oracle):
    /// autocommit per statement, stops at the first error. Throws <see cref="DdlFailedException"/>.
    /// </summary>
    Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct);
}

/// <summary>409 DDL_FAILED (docs/PLAN-M1.5.md 3.9): detail { failedIndex, executed, rolledBack, providerError }.</summary>
public sealed class DdlFailedException(string message, int failedIndex, int executed, bool rolledBack, ErrorInfo providerError)
    : EngineException(409, DesignerErrorCodes.DdlFailed, message,
        new DdlFailedDetail(failedIndex, executed, rolledBack, providerError))
{
    public int FailedIndex { get; } = failedIndex;
    public int Executed { get; } = executed;
    public bool RolledBack { get; } = rolledBack;
    public ErrorInfo ProviderError { get; } = providerError;
}

public sealed record DdlFailedDetail(int FailedIndex, int Executed, bool RolledBack, ErrorInfo ProviderError);

/// <summary>M1.5 error codes (additive to <see cref="ErrorCodes"/>).</summary>
public static class DesignerErrorCodes
{
    public const string SessionLimit = "SESSION_LIMIT", DdlFailed = "DDL_FAILED", NotEditable = "NOT_EDITABLE";
}

/// <summary>Helpers shared by the scripters.</summary>
public static class DdlText
{
    /// <summary>Statements that only control the transaction: apply skips them (it owns the transaction).</summary>
    public static bool IsTransactionControl(string sql)
    {
        var s = sql.Trim().TrimEnd(';').Trim().ToUpperInvariant();
        s = string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return s is "BEGIN" or "BEGIN TRANSACTION" or "BEGIN TRAN" or "BEGIN DEFERRED" or "BEGIN IMMEDIATE" or "BEGIN EXCLUSIVE"
            or "BEGIN DEFERRED TRANSACTION" or "BEGIN IMMEDIATE TRANSACTION" or "BEGIN EXCLUSIVE TRANSACTION"
            or "COMMIT" or "COMMIT TRANSACTION" or "COMMIT TRAN" or "END" or "END TRANSACTION" or "COMMIT WORK";
    }

    /// <summary>Splits "a, b" type arguments: "decimal(10, 2)" → ("decimal", ["10","2"]).</summary>
    public static (string Base, IReadOnlyList<string> Args) ParseType(string type)
    {
        var t = type.Trim();
        var open = t.IndexOf('(');
        if (open < 0 || !t.EndsWith(')')) return (t, []);
        var args = t[(open + 1)..^1].Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        return (t[..open].Trim(), args);
    }

    public static int? ArgInt(IReadOnlyList<string> args, int index) =>
        index < args.Count && int.TryParse(args[index], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;
}
