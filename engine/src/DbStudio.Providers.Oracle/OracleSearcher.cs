using System.Globalization;
using System.Runtime.CompilerServices;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle;

/// <summary>"Find in database" for Oracle on one pooled catalog connection. No database level: schemas are the owners.</summary>
public sealed class OracleSearcher : IDatabaseSearcher
{
    private readonly OracleConnection _conn;

    public OracleSearcher(OracleConnection openConnection)
    {
        _conn = openConnection;
        Catalog = new OracleCatalogReader(openConnection, ownsConnection: false);
    }

    public Dialect Dialect => Dialect.PlSql;
    public ICatalogReader Catalog { get; }

    public ValueTask DisposeAsync() => _conn.DisposeAsync();

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    private static (string, object?)[] Params(string schema, string? like) => like is null ? [("owner", schema)] : [("owner", schema), ("p", like)];

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var rows = await OracleDb.QueryAsync(_conn, OracleSearchQueries.Names(like is not null, matchCase),
            r => (Owner: r.GetString(0), Name: r.GetString(1), Type: OracleDependencyReader.MapType(OracleDb.Str(r, 2))), ct, Params(schema, like)).ConfigureAwait(false);
        return rows.Where(r => r.Type is not null).Select(r => new SearchNameRow(r.Owner, r.Name, r.Type!)).Distinct().ToList();
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        return await OracleDb.QueryAsync(_conn, OracleSearchQueries.Columns(like is not null, matchCase), r => new SearchColumnRow(
                r.GetString(0), r.GetString(1), OracleDependencyReader.MapType(OracleDb.Str(r, 2)) ?? ObjectTypes.Table, r.GetString(3),
                TypeText(OracleDb.Str(r, 4), OracleDb.Int(r, 5), OracleDb.Int(r, 6), OracleDb.Int(r, 7))),
            ct, Params(schema, like)).ConfigureAwait(false);
    }

    /// <summary>VARCHAR2(100), NUMBER(10,2), DATE…</summary>
    public static string? TypeText(string? type, int? charLength, int? precision, int? scale)
    {
        if (type is null) return null;
        if (type is "VARCHAR2" or "NVARCHAR2" or "CHAR" or "NCHAR" or "VARCHAR" && charLength is > 0)
            return $"{type}({charLength.Value.ToString(CultureInfo.InvariantCulture)})";
        if (type == "NUMBER" && precision is not null)
            return scale is > 0 ? $"NUMBER({precision},{scale})" : $"NUMBER({precision})";
        return type;
    }

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var p = Params(schema, like);
        foreach (var row in await OracleDb.QueryAsync(_conn, OracleSearchQueries.Source(like is not null, matchCase),
                     r => (Owner: r.GetString(0), Name: r.GetString(1), Type: OracleDependencyReader.MapType(OracleDb.Str(r, 2)), Line: OracleDb.Int(r, 3) ?? 1,
                         Text: OracleDb.Str(r, 4) ?? ""), ct, p).ConfigureAwait(false))
        {
            if (row.Type is not null) yield return new SearchCodeRow(row.Owner, row.Name, row.Type, row.Text.TrimEnd('\n', '\r'), row.Line);
        }
        // LONG columns: read whole, matched in the engine.
        var owner = ("owner", (object?)schema);
        foreach (var v in await OracleDb.QueryAsync(_conn, OracleSearchQueries.Views, r => (Owner: r.GetString(0), Name: r.GetString(1), Text: OracleDb.Str(r, 2)), ct, owner)
                     .ConfigureAwait(false))
            if (v.Text is not null) yield return new SearchCodeRow(v.Owner, v.Name, ObjectTypes.View, v.Text);
        foreach (var v in await OracleDb.QueryAsync(_conn, OracleSearchQueries.MViews, r => (Owner: r.GetString(0), Name: r.GetString(1), Text: OracleDb.Str(r, 2)), ct, owner)
                     .ConfigureAwait(false))
            if (v.Text is not null) yield return new SearchCodeRow(v.Owner, v.Name, ObjectTypes.MView, v.Text);
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        using var cmd = OracleDb.Command(_conn, query.Sql, query.Parameters.ToArray());
        await using var reg = ct.Register(static c => { try { ((OracleCommand)c!).Cancel(); } catch { /* best effort */ } }, cmd);
        using var r = (OracleDataReader)await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var row = new object?[r.FieldCount];
            for (var i = 0; i < row.Length; i++)
            {
                if (r.IsDBNull(i)) continue;
                try
                {
                    row[i] = r.GetValue(i);
                }
                catch (Exception ex) when (ex is InvalidCastException or OverflowException)
                {
                    // NUMBER beyond decimal's range: its text.
                    row[i] = r.GetOracleValue(i)?.ToString();
                }
            }
            yield return row;
        }
    }
}
