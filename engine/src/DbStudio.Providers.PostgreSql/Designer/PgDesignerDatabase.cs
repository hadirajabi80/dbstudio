using DbStudio.Core.Designer;
using DbStudio.Core.Models;

namespace DbStudio.Providers.PostgreSql.Designer;

/// <summary>Designer database access (docs/PLAN-PG.md 2.7). M2-0 STUB registered as keyed "postgresql"; PG-A implements it.</summary>
public sealed class PgDesignerDatabase : IDesignerDatabase
{
    public string ProviderId => "postgresql";

    public Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);
}
