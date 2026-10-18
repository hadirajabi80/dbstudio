using System.Data.Common;
using DbStudio.Core.Params;

namespace DbStudio.Providers.PostgreSql.Params;

/// <summary>
/// Positional / named binder (docs/PLAN-PG.md 2.4). M2-0 STUB registered as keyed "postgresql" (<see cref="Instance"/>);
/// PG-A implements it (typically as a <see cref="ParamBinderBase"/>).
/// </summary>
public sealed class PgParamBinder : IParamBinder
{
    public static readonly PgParamBinder Instance = new();

    public string ProviderId => "postgresql";

    public IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql) => throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public object? ReadOutput(DbParameter parameter) => throw new NotSupportedException(PostgreSqlProvider.NotYet);
}
