using DbStudio.Core.Plans;
using DbStudio.Core.Services;

namespace DbStudio.Providers.PostgreSql.Plans;

/// <summary>EXPLAIN (FORMAT JSON) reader (docs/PLAN-PG.md 2.8). M2-0 STUB registered as keyed "postgresql"; PG-A implements it.</summary>
public sealed class PgPlanReader : IPlanReader
{
    public string ProviderId => "postgresql";

    public ExplainScript CreateScript(ExplainInput input) => throw new NotSupportedException(PostgreSqlProvider.NotYet);

    public Task<PlanResult> BuildAsync(ExplainInput input, IReadOnlyList<CapturedResultSet> captured, AdoSessionBase session, CancellationToken ct) =>
        throw new NotSupportedException(PostgreSqlProvider.NotYet);
}
