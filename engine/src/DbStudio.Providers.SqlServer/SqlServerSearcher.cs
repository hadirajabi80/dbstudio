using System.Data;
using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>
/// "Find in database" for SQL Server on one pooled catalog connection; other databases are reached with <c>USE</c>, like
/// the catalog reader (which shares the connection).
/// </summary>
public sealed class SqlServerSearcher : IDatabaseSearcher
{
    private readonly SqlConnection _conn;
    private readonly SqlServerCatalogReader _catalog;

    public SqlServerSearcher(SqlConnection openConnection)
    {
        _conn = openConnection;
        _catalog = new SqlServerCatalogReader(openConnection, ownsConnection: false);
    }

    public Dialect Dialect => Dialect.TSql;
    public ICatalogReader Catalog => _catalog;

    public ValueTask DisposeAsync() => _conn.DisposeAsync();

    private async Task UseAsync(string? database, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(database) || string.Equals(database, _conn.Database, StringComparison.Ordinal)) return;
        await SqlDb.ExecuteAsync(_conn, "USE " + SqlServerNames.Quote(database), ct).ConfigureAwait(false);
    }

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => _catalog.ListDatabasesAsync(ct);

    private static (string, object?)[] Params(string schema, string? like) =>
        like is null ? [("@schema", schema)] : [("@schema", schema), ("@p", like)];

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        var rows = await SqlDb.QueryAsync(_conn, SqlServerSearchQueries.Names(like is not null, matchCase),
            r => (Schema: r.GetString(0), Name: r.GetString(1), Type: SqlServerCatalogReader.MapType(r.GetString(2).Trim())), ct, Params(schema, like)).ConfigureAwait(false);
        return rows.Where(r => r.Type is not null).Select(r => new SearchNameRow(r.Schema, r.Name, r.Type!)).ToList();
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        return await SqlDb.QueryAsync(_conn, SqlServerSearchQueries.Columns(like is not null, matchCase), r => new SearchColumnRow(
                r.GetString(0), r.GetString(1), SqlServerCatalogReader.MapType(r.GetString(2).Trim()) ?? ObjectTypes.Table, r.GetString(3),
                r.IsDBNull(4) ? null : SqlServerNames.TypeText(r.GetString(4), r.GetInt16(5), r.GetByte(6), r.GetByte(7), r.GetInt32(8) == 1)),
            ct, Params(schema, like)).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        await using var cmd = SqlDb.Command(_conn, SqlServerSearchQueries.Code(like is not null, matchCase), Params(schema, like));
        await using var r = await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var s = r.GetString(0);
            var name = r.GetString(1);
            var type = SqlServerCatalogReader.MapType(r.GetString(2).Trim());
            var text = r.GetString(3);
            if (type is not null) yield return new SearchCodeRow(s, name, type, text);
        }
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        await using var cmd = SqlDb.Command(_conn, query.Sql, query.Parameters.Select(p => ("@" + p.Name, p.Value)).ToArray());
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var row = new object?[r.FieldCount];
            for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : r.GetValue(i);
            yield return row;
        }
    }
}
