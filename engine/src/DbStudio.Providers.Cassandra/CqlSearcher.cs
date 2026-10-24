using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// "Find in database" for Cassandra: object names, columns (and UDT fields) and code (UDF bodies, materialized-view
/// WHERE clauses) from system_schema. Table data is not searched (CQL cannot filter a non-key column without an index):
/// <see cref="SearchSql.TextExpression"/> returns null for CQL, so the service never asks for data queries.
/// </summary>
public sealed class CqlSearcher(CqlCatalogReader catalog) : IDatabaseSearcher
{
    public Dialect Dialect => Dialect.Cql;
    public ICatalogReader Catalog => catalog;

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    // The LIKE prefilter is not needed: system_schema of one keyspace is small and the service does the exact match.

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var ks = await catalog.KeyspaceAsync(schema, ct).ConfigureAwait(false);
        if (ks is null) return [];
        var rows = new List<SearchNameRow>();
        rows.AddRange(ks.Tables.Select(t => new SearchNameRow(ks.Name, t.Name, ObjectTypes.Table)));
        rows.AddRange(ks.Views.Select(t => new SearchNameRow(ks.Name, t.Name, ObjectTypes.MView)));
        rows.AddRange(ks.Types.Select(t => new SearchNameRow(ks.Name, t.Name, ObjectTypes.Type)));
        rows.AddRange(ks.Functions.Select(f => f.Name).Concat(ks.Aggregates.Select(a => a.Name)).Distinct(StringComparer.Ordinal)
            .Select(n => new SearchNameRow(ks.Name, n, ObjectTypes.Func)));
        rows.AddRange(ks.Triggers.Select(t => new SearchNameRow(ks.Name, t.Name, ObjectTypes.Trigger)));
        return rows;
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var ks = await catalog.KeyspaceAsync(schema, ct).ConfigureAwait(false);
        if (ks is null) return [];
        var rows = new List<SearchColumnRow>();
        foreach (var t in ks.Tables.Concat(ks.Views))
            rows.AddRange(t.OrderedColumns.Select(c => new SearchColumnRow(ks.Name, t.Name, t.IsView ? ObjectTypes.MView : ObjectTypes.Table, c.Name, c.Type)));
        foreach (var u in ks.Types)
            rows.AddRange(u.Fields.Select(f => new SearchColumnRow(ks.Name, u.Name, ObjectTypes.Type, f.Name, f.Type)));
        return rows;
    }

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase, [EnumeratorCancellation] CancellationToken ct)
    {
        var ks = await catalog.KeyspaceAsync(schema, ct).ConfigureAwait(false);
        if (ks is null) yield break;
        foreach (var f in ks.Functions) yield return new SearchCodeRow(ks.Name, f.Name, ObjectTypes.Func, CqlDdl.Function(f));
        foreach (var v in ks.Views) yield return new SearchCodeRow(ks.Name, v.Name, ObjectTypes.MView, CqlDdl.View(v));
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        await Task.CompletedTask.ConfigureAwait(false);
        yield break;
    }
}
