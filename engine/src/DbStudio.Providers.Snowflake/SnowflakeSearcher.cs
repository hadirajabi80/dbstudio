using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// "Find in database" for Snowflake over the catalog reader's gateway. Names, columns and view texts come from SHOW
/// commands (no warehouse; the engine filters the exact matches); routine bodies from INFORMATION_SCHEMA.PROCEDURES /
/// FUNCTIONS (needs a warehouse: skipped without one); data queries bind the term as <c>:1</c> and need a warehouse.
/// The SNOWFLAKE and SNOWFLAKE_SAMPLE_DATA shares are not searched unless named.
/// </summary>
public sealed class SnowflakeSearcher(SnowflakeCatalogReader catalog) : IDatabaseSearcher
{
    public static readonly IReadOnlySet<string> SystemDatabases = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA" };

    public Dialect Dialect => Dialect.Snowflake;
    public ICatalogReader Catalog => catalog;

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public async Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) =>
        (await catalog.ListDatabasesAsync(ct).ConfigureAwait(false)).Where(d => !SystemDatabases.Contains(d)).ToList();

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        var list = new List<SearchNameRow>();
        var tables = await catalog.TryShowAsync(SnowflakeSql.ShowTables(db, schema), ct).ConfigureAwait(false);
        list.AddRange(tables.Rows.Select(r => new SearchNameRow(schema, tables.Str(r, "name") ?? "", ObjectTypes.Table)));
        var views = await catalog.TryShowAsync(SnowflakeSql.ShowViews(db, schema), ct).ConfigureAwait(false);
        list.AddRange(views.Rows.Select(r => new SearchNameRow(schema, views.Str(r, "name") ?? "",
            SnowflakeCatalogReader.Flag(views, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View)));
        var procs = await catalog.TryShowAsync(SnowflakeSql.ShowProcedures(db, schema), ct, $"SHOW PROCEDURES IN SCHEMA {SnowflakeSql.SchemaPath(db, schema)}").ConfigureAwait(false);
        list.AddRange(SnowflakeDependencyReader.Routines(procs, schema, true).Select(i => new SearchNameRow(schema, i.Name, i.Type)));
        var funcs = await catalog.TryShowAsync(SnowflakeSql.ShowFunctions(db, schema), ct).ConfigureAwait(false);
        list.AddRange(SnowflakeDependencyReader.Routines(funcs, schema, false).Select(i => new SearchNameRow(schema, i.Name, i.Type)));
        var seqs = await catalog.TryShowAsync(SnowflakeSql.ShowSequences(db, schema), ct).ConfigureAwait(false);
        list.AddRange(seqs.Rows.Select(r => new SearchNameRow(schema, seqs.Str(r, "name") ?? "", ObjectTypes.Sequence)));
        return list.Where(n => n.Name.Length > 0).ToList();
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        var views = await catalog.TryShowAsync(SnowflakeSql.ShowViews(db, schema), ct).ConfigureAwait(false);
        var viewTypes = views.Rows.ToDictionary(r => views.Str(r, "name") ?? "",
            r => SnowflakeCatalogReader.Flag(views, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View, StringComparer.Ordinal);
        var columns = await catalog.TryShowAsync(SnowflakeSql.ShowColumns(db, schema), ct).ConfigureAwait(false);
        return columns.Rows.Select(r =>
        {
            var table = columns.Str(r, "table_name") ?? "";
            var (type, _) = SnowflakeTypes.FromShowColumnsJson(columns.Str(r, "data_type"));
            return new SearchColumnRow(schema, table, viewTypes.GetValueOrDefault(table, ObjectTypes.Table), columns.Str(r, "column_name") ?? "", type);
        }).ToList();
    }

    public const string RoutineCodeSql =
        "SELECT PROCEDURE_NAME AS NAME, 'proc' AS TYPE, PROCEDURE_DEFINITION AS BODY FROM {0}.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = :1 " +
        "UNION ALL SELECT FUNCTION_NAME, IFF(DATA_TYPE LIKE 'TABLE%', 'tablefunc', 'func'), FUNCTION_DEFINITION FROM {0}.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA = :1";

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        var views = await catalog.TryShowAsync(SnowflakeSql.ShowViews(db, schema), ct).ConfigureAwait(false);
        foreach (var r in views.Rows)
        {
            var text = views.Str(r, "text");
            if (string.IsNullOrEmpty(text)) continue;
            yield return new SearchCodeRow(schema, views.Str(r, "name") ?? "",
                SnowflakeCatalogReader.Flag(views, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View, text);
        }
        Logs.Sql.SqlRowSet? routines = null;
        try
        {
            routines = await catalog.Gateway.QueryAsync(string.Format(System.Globalization.CultureInfo.InvariantCulture, RoutineCodeSql,
                SnowflakeSql.AlwaysQuote(db)), [schema], ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException)
        {
            // No warehouse / no privilege: routine bodies are not searched.
        }
        if (routines is null) yield break;
        foreach (var r in routines.Rows)
        {
            var body = routines.Str(r, "BODY");
            if (string.IsNullOrEmpty(body)) continue;
            yield return new SearchCodeRow(schema, routines.Str(r, "NAME") ?? "", routines.Str(r, "TYPE") ?? ObjectTypes.Func, body);
        }
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        // Generated queries name "SCHEMA"."TABLE" only (SearchSql.Qualify): prefix the database, the gateway has no USE.
        var sql = query.Sql;
        var from = sql.IndexOf(" FROM \"", StringComparison.Ordinal);
        if (from >= 0) sql = sql[..(from + 6)] + SnowflakeSql.AlwaysQuote(db) + "." + sql[(from + 6)..];
        var rs = await catalog.Gateway.QueryAsync(sql, query.Parameters.Select(p => p.Value).ToList(), ct).ConfigureAwait(false);
        foreach (var row in rs.Rows) yield return row;
    }
}
