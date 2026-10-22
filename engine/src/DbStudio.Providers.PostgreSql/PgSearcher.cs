using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// "Find in database" for PostgreSQL over the catalog reader's pooled connections (one per database: a PostgreSQL
/// connection is bound to its database). Data queries run in a read-only transaction.
/// </summary>
public sealed class PgSearcher(PgCatalogReader catalog) : IDatabaseSearcher
{
    public Dialect Dialect => Dialect.PgSql;
    public ICatalogReader Catalog => catalog;

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => catalog.ListDatabasesAsync(ct);

    private static object?[] Params(string schema, string? like) => like is null ? [schema] : [schema, like];

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(database, ct).ConfigureAwait(false);
        return await PgDb.QueryAsync(conn, PgSearchQueries.Names(like is not null, matchCase),
            r => new SearchNameRow(r.GetString(0), r.GetString(1), r.GetString(2)), ct, Params(schema, like)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(database, ct).ConfigureAwait(false);
        return await PgDb.QueryAsync(conn, PgSearchQueries.Columns(like is not null, matchCase),
            r => new SearchColumnRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), PgDb.Str(r, 4)), ct, Params(schema, like)).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(database, ct).ConfigureAwait(false);
        await using var cmd = PgDb.Command(conn, PgSearchQueries.Code(like is not null, matchCase), Params(schema, like));
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            if (r.IsDBNull(3)) continue;
            yield return new SearchCodeRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3));
        }
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(database, ct).ConfigureAwait(false);
        // Generated queries bind their single value (the term) positionally as $1 (SearchSql.Param).
        await using var tx = await conn.BeginTransactionAsync(ct).ConfigureAwait(false);
        await using (var ro = PgDb.Command(conn, "SET TRANSACTION READ ONLY"))
        {
            ro.Transaction = tx;
            await ro.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        await using var cmd = PgDb.Command(conn, query.Sql, query.Parameters.Select(p => p.Value).ToArray());
        cmd.Transaction = tx;
        await using (var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false))
        {
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var row = new object?[r.FieldCount];
                for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : Value(r, i);
                yield return row;
            }
        }
        await tx.RollbackAsync(CancellationToken.None).ConfigureAwait(false);
    }

    /// <summary>A value as read; types without a CLR mapping (enums, ranges…) as text.</summary>
    private static object? Value(NpgsqlDataReader r, int i)
    {
        try
        {
            return r.GetValue(i);
        }
        catch (InvalidCastException)
        {
            return r.GetFieldValue<string>(i);
        }
    }
}
