using System.Runtime.CompilerServices;
using ClickHouse.Driver.ADO.Parameters;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;

namespace DbStudio.Providers.ClickHouse;

/// <summary>The SQL of "Find in database" (names, columns, view/MV/dictionary/function code).</summary>
public static class ChSearchQueries
{
    private static string Like(bool hasLike, bool matchCase, string expr) =>
        hasLike ? $" AND {expr} {(matchCase ? "like" : "ilike")} {{like:String}}" : "";

    public static string Names(bool hasLike, bool matchCase) => $$"""
        SELECT database, name, engine FROM system.tables
        WHERE database = {db:String} AND NOT is_temporary AND NOT startsWith(name, '.inner'){{Like(hasLike, matchCase, "name")}}
        ORDER BY name
        """;

    public static string Functions(bool hasLike, bool matchCase) => $$"""
        SELECT name FROM system.functions WHERE origin = 'SQLUserDefined'{{Like(hasLike, matchCase, "name")}} ORDER BY name
        """;

    public static string Columns(bool hasLike, bool matchCase) => $$"""
        SELECT c.database, c.table, t.engine, c.name, c.type
        FROM system.columns c JOIN system.tables t ON t.database = c.database AND t.name = c.table
        WHERE c.database = {db:String} AND NOT startsWith(c.table, '.inner'){{Like(hasLike, matchCase, "c.name")}}
        ORDER BY c.table, c.position
        """;

    public static string Code(bool hasLike, bool matchCase) => $$"""
        SELECT database, name, engine, create_table_query FROM system.tables
        WHERE database = {db:String} AND engine IN ('View', 'MaterializedView', 'Dictionary', 'LiveView', 'WindowView')
            {{Like(hasLike, matchCase, "create_table_query")}}
        ORDER BY name
        """;

    public static string FunctionCode(bool hasLike, bool matchCase) => $$"""
        SELECT name, create_query FROM system.functions WHERE origin = 'SQLUserDefined'{{Like(hasLike, matchCase, "create_query")}} ORDER BY name
        """;
}

/// <summary>"Find in database" for ClickHouse over the catalog reader's connection. The LIKE prefilter escapes with a backslash (SearchSql.EscapeOf).</summary>
public sealed class ChSearcher(ChCatalogReader catalog) : IDatabaseSearcher
{
    public Dialect Dialect => Dialect.ClickHouse;
    public ICatalogReader Catalog => catalog;

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    /// <summary>Single-level: no database list (the schemas are the databases).</summary>
    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    private static (string, object?)[] P(string schema, string? like) => like is null ? [("db", schema)] : [("db", schema), ("like", like)];

    private bool IsDefault(string schema) => string.Equals(schema, catalog.DefaultDatabase, StringComparison.Ordinal);

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var conn = catalog.Channel.Connection;
        var rows = await ChDb.QueryAsync(conn, ChSearchQueries.Names(like is not null, matchCase),
            r => new SearchNameRow(ChDb.S(r, 0), ChDb.S(r, 1), ChCatalogReader.ObjectType(ChDb.Str(r, 2))), ct, P(schema, like)).ConfigureAwait(false);
        if (IsDefault(schema))
        {
            try
            {
                rows.AddRange(await ChDb.QueryAsync(conn, ChSearchQueries.Functions(like is not null, matchCase),
                    r => new SearchNameRow(schema, ChDb.S(r, 0), ObjectTypes.Func), ct, like is null ? [] : [("like", like)]).ConfigureAwait(false));
            }
            catch (global::ClickHouse.Driver.ClickHouseServerException) { }
        }
        return rows;
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct) =>
        await ChDb.QueryAsync(catalog.Channel.Connection, ChSearchQueries.Columns(like is not null, matchCase),
            r => new SearchColumnRow(ChDb.S(r, 0), ChDb.S(r, 1), ChCatalogReader.ObjectType(ChDb.Str(r, 2)), ChDb.S(r, 3), ChDb.Str(r, 4)),
            ct, P(schema, like)).ConfigureAwait(false);

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var conn = catalog.Channel.Connection;
        var rows = await ChDb.QueryAsync(conn, ChSearchQueries.Code(like is not null, matchCase),
            r => new SearchCodeRow(ChDb.S(r, 0), ChDb.S(r, 1), ChCatalogReader.ObjectType(ChDb.Str(r, 2)), ChDb.S(r, 3)), ct, P(schema, like)).ConfigureAwait(false);
        foreach (var row in rows) if (row.Text.Length > 0) yield return row;
        if (!IsDefault(schema)) yield break;
        List<SearchCodeRow> funcs;
        try
        {
            funcs = await ChDb.QueryAsync(conn, ChSearchQueries.FunctionCode(like is not null, matchCase),
                r => new SearchCodeRow(schema, ChDb.S(r, 0), ObjectTypes.Func, ChDb.S(r, 1)), ct, like is null ? [] : [("like", like)]).ConfigureAwait(false);
        }
        catch (global::ClickHouse.Driver.ClickHouseServerException)
        {
            yield break;
        }
        foreach (var f in funcs) yield return f;
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        var conn = catalog.Channel.Connection;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = query.Sql;
        // Generated queries bind the term as {p:String} (SearchSql.Param); they only read.
        foreach (var (name, value) in query.Parameters)
            cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = name, ClickHouseType = "String", Value = value ?? "" });
        cmd.CustomSettings["max_execution_time"] = 60;
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var row = new object?[r.FieldCount];
            for (var i = 0; i < row.Length; i++)
            {
                var w = r.IsDBNull(i) ? null : ChTypes.ToWire(r.GetValue(i), r.GetDataTypeName(i));
                row[i] = w is DbStudio.Core.Services.TruncatedValue t ? t.Full : w;
            }
            yield return row;
        }
    }
}
