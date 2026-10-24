using System.Data;
using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// "Find in database" for MySQL / MariaDB over the catalog reader's connection: names (tables, views, sequences,
/// routines, triggers, events), columns, code (view / routine / trigger / event definitions) and table data in a
/// read-only transaction. Single-level: the databases are the schemas.
/// </summary>
public sealed class MySqlSearcher(MySqlCatalogReader catalog) : IDatabaseSearcher
{
    public Dialect Dialect => Dialect.MySql;
    public ICatalogReader Catalog => catalog;

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    private static string Filter(string expr, bool prefilter, bool matchCase) =>
        prefilter ? " AND " + SearchSql.LikePredicate(Dialect.MySql, expr, "@p1", matchCase) : "";

    private static object?[] Params(string schema, string? like) => like is null ? [schema] : [schema, like];

    public static string NamesSql(bool prefilter, bool matchCase) =>
        "SELECT TABLE_SCHEMA, TABLE_NAME, CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' WHEN 'SYSTEM VIEW' THEN 'view' WHEN 'SEQUENCE' THEN 'sequence' ELSE 'table' END " +
        "FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0" + Filter("TABLE_NAME", prefilter, matchCase) +
        " UNION ALL SELECT ROUTINE_SCHEMA, ROUTINE_NAME, CASE ROUTINE_TYPE WHEN 'FUNCTION' THEN 'func' ELSE 'proc' END " +
        "FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0" + Filter("ROUTINE_NAME", prefilter, matchCase) +
        " UNION ALL SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'trigger' FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0" +
        Filter("TRIGGER_NAME", prefilter, matchCase) +
        " UNION ALL SELECT EVENT_SCHEMA, EVENT_NAME, 'proc' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0" + Filter("EVENT_NAME", prefilter, matchCase);

    public static string ColumnsSql(bool prefilter, bool matchCase) =>
        "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, CASE t.TABLE_TYPE WHEN 'VIEW' THEN 'view' WHEN 'SYSTEM VIEW' THEN 'view' ELSE 'table' END, c.COLUMN_NAME, c.COLUMN_TYPE " +
        "FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME " +
        "WHERE c.TABLE_SCHEMA = @p0" + Filter("c.COLUMN_NAME", prefilter, matchCase) + " ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";

    public static string CodeSql(bool prefilter, bool matchCase) =>
        "SELECT TABLE_SCHEMA, TABLE_NAME, 'view', VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = @p0" + Filter("VIEW_DEFINITION", prefilter, matchCase) +
        " UNION ALL SELECT ROUTINE_SCHEMA, ROUTINE_NAME, CASE ROUTINE_TYPE WHEN 'FUNCTION' THEN 'func' ELSE 'proc' END, ROUTINE_DEFINITION " +
        "FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0 AND ROUTINE_DEFINITION IS NOT NULL" + Filter("ROUTINE_DEFINITION", prefilter, matchCase) +
        " UNION ALL SELECT TRIGGER_SCHEMA, TRIGGER_NAME, 'trigger', ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0" +
        Filter("ACTION_STATEMENT", prefilter, matchCase) +
        " UNION ALL SELECT EVENT_SCHEMA, EVENT_NAME, 'proc', EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0" +
        Filter("EVENT_DEFINITION", prefilter, matchCase);

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct) =>
        await MySqlDb.QueryAsync(catalog.Connection, NamesSql(like is not null, matchCase),
            r => new SearchNameRow(MySqlDb.S(r, 0), MySqlDb.S(r, 1), MySqlDb.S(r, 2)), ct, Params(schema, like)).ConfigureAwait(false);

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct) =>
        await MySqlDb.QueryAsync(catalog.Connection, ColumnsSql(like is not null, matchCase),
            r => new SearchColumnRow(MySqlDb.S(r, 0), MySqlDb.S(r, 1), MySqlDb.S(r, 2), MySqlDb.S(r, 3), MySqlDb.Str(r, 4)), ct, Params(schema, like)).ConfigureAwait(false);

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase, [EnumeratorCancellation] CancellationToken ct)
    {
        await using var cmd = MySqlDb.Command(catalog.Connection, CodeSql(like is not null, matchCase), Params(schema, like));
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var text = MySqlDb.Str(r, 3);
            if (text is null) continue;
            yield return new SearchCodeRow(MySqlDb.S(r, 0), MySqlDb.S(r, 1), MySqlDb.S(r, 2), text);
        }
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        var conn = catalog.Connection;
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.RepeatableRead, true, ct).ConfigureAwait(false);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = query.Sql;
        cmd.Transaction = tx;
        foreach (var (name, value) in query.Parameters) cmd.Parameters.AddWithValue("@" + name, value ?? DBNull.Value);
        await using (var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false))
        {
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var row = new object?[r.FieldCount];
                for (var i = 0; i < row.Length; i++)
                {
                    if (r.IsDBNull(i)) continue;
                    try { row[i] = r.GetValue(i); }
                    catch (Exception ex) when (ex is InvalidCastException or OverflowException or MySqlConversionException) { row[i] = r.GetString(i); }
                }
                yield return row;
            }
        }
        await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
    }

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        ["Names"] = NamesSql(false, false), ["NamesLike"] = NamesSql(true, false), ["NamesLikeCase"] = NamesSql(true, true),
        ["Columns"] = ColumnsSql(false, false), ["ColumnsLike"] = ColumnsSql(true, false),
        ["Code"] = CodeSql(false, false), ["CodeLike"] = CodeSql(true, false),
    };
}
