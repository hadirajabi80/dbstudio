using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// PostgreSQL provider (docs/PLAN-PG.md 2, Npgsql 9.x). M2-0 STUB: id, dialect, form spec and identifier rules are final;
/// every connection method throws <see cref="NotSupportedException"/> (400 NOT_SUPPORTED) until PG-A implements it.
/// </summary>
public sealed class PostgreSqlProvider : IDbProvider
{
    internal const string NotYet = "PostgreSQL support is not implemented yet (package PG-A).";

    public string Id => "postgresql";
    public string DisplayName => "PostgreSQL";
    public Dialect Dialect => Dialect.PgSql;
    public ConnectionFormSpec FormSpec => PgConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new PgDdlGenerator();
    public ISqlDiagnostics? Diagnostics => null;
    public IdentifierRules Identifiers { get; } = new('"', '"', "lower", PgReservedWords.All);

    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        PgConnectionStrings.Build(profile, password, pooling: false);

    public Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);

    public Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);

    public Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct) =>
        throw new NotSupportedException(NotYet);
}

/// <summary>M2-0 STUB of the table DDL generator (PG-A).</summary>
public sealed class PgDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details) => throw new NotSupportedException(PostgreSqlProvider.NotYet);
}
