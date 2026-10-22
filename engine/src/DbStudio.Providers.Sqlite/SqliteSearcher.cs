using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// "Find in database" for SQLite: names and view/trigger bodies from <c>sqlite_master</c>, columns from
/// <c>pragma_table_info</c>, schemas = the attached databases. The catalog is small, so names and code are matched in the
/// engine without a SQL prefilter. The connection runs with <c>PRAGMA query_only</c>; <c>REGEXP</c> is .NET's regex.
/// </summary>
internal sealed class SqliteSearcher : IDatabaseSearcher
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(250);
    private static readonly string[] ShadowSuffixes = ["_data", "_idx", "_content", "_docsize", "_config", "_segments", "_segdir", "_stat", "_node", "_parent", "_rowid"];
    private readonly SqliteConnection _conn;

    public SqliteSearcher(SqliteConnection connection)
    {
        _conn = connection;
        Catalog = new SqliteCatalogReader(connection, new SqliteDdlGenerator());
        connection.CreateFunction("regexp", (string? pattern, object? value) => Regexp(pattern, value), isDeterministic: true);
    }

    public static async Task<SqliteSearcher> OpenAsync(ConnectionProfile profile, CancellationToken ct)
    {
        var connection = await SqliteConnections.OpenAsync(profile, forceReadOnly: false, ct).ConfigureAwait(false);
        try
        {
            await using (var pragma = connection.CreateCommand())
            {
                pragma.CommandText = "PRAGMA query_only = ON";
                await pragma.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            return new SqliteSearcher(connection);
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public Dialect Dialect => Dialect.Sqlite;
    public ICatalogReader Catalog { get; }

    public ValueTask DisposeAsync() => _conn.DisposeAsync();

    private static bool Regexp(string? pattern, object? value)
    {
        if (pattern is null || value is null or DBNull) return false;
        var text = value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture);
        if (string.IsNullOrEmpty(text)) return false;
        try
        {
            return Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant, RegexTimeout);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    /// <summary>No database level: the attached databases are the schemas.</summary>
    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    private sealed record Master(string Type, string Name, string Table, string? Sql)
    {
        public bool IsVirtual => Sql is not null && Sql.TrimStart().StartsWith("CREATE VIRTUAL", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<List<Master>> MastersAsync(string schema, CancellationToken ct)
    {
        var rows = new List<Master>();
        await using var cmd = _conn.CreateCommand();
        cmd.CommandText = $"SELECT type, name, tbl_name, sql FROM {SqliteNames.Quote(schema)}.sqlite_master " +
                          "WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite!_%' ESCAPE '!'";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            rows.Add(new Master(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3)));
        return rows;
    }

    private static bool IsShadow(Master m, List<Master> all) =>
        m.Type == "table" && ShadowSuffixes.Any(s => m.Name.EndsWith(s, StringComparison.OrdinalIgnoreCase)
            && all.Any(v => v.IsVirtual && v.Name.Equals(m.Name[..^s.Length], StringComparison.OrdinalIgnoreCase)));

    private static string TypeOf(Master m) => m.Type switch { "view" => ObjectTypes.View, "trigger" => ObjectTypes.Trigger, _ => ObjectTypes.Table };

    public async Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var masters = await MastersAsync(schema, ct).ConfigureAwait(false);
        return masters.Where(m => !IsShadow(m, masters)).Select(m => new SearchNameRow(schema, m.Name, TypeOf(m))).ToList();
    }

    public async Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        var masters = await MastersAsync(schema, ct).ConfigureAwait(false);
        var list = new List<SearchColumnRow>();
        foreach (var m in masters.Where(m => m.Type is "table" or "view" && !IsShadow(m, masters)))
        {
            try
            {
                await using var cmd = _conn.CreateCommand();
                cmd.CommandText = "SELECT name, type FROM pragma_table_info($table, $schema)";
                cmd.Parameters.AddWithValue("$table", m.Name);
                cmd.Parameters.AddWithValue("$schema", schema);
                await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
                while (await r.ReadAsync(ct).ConfigureAwait(false))
                    list.Add(new SearchColumnRow(schema, m.Name, TypeOf(m), r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1)));
            }
            catch (SqliteException)
            {
                // A view over a table that no longer exists has no columns: skip it.
            }
        }
        return list;
    }

    public async IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase,
        [EnumeratorCancellation] CancellationToken ct)
    {
        foreach (var m in await MastersAsync(schema, ct).ConfigureAwait(false))
            if (m.Type is "view" or "trigger" && m.Sql is not null) yield return new SearchCodeRow(schema, m.Name, TypeOf(m), m.Sql);
    }

    public async IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        await using var cmd = _conn.CreateCommand();
        cmd.CommandText = query.Sql;
        foreach (var (name, value) in query.Parameters) cmd.Parameters.AddWithValue("@" + name, value ?? DBNull.Value);
        await using var reg = ct.Register(static c => { try { ((SqliteCommand)c!).Cancel(); } catch { /* best effort */ } }, cmd);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var row = new object?[r.FieldCount];
            for (var i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : r.GetValue(i);
            yield return row;
        }
    }
}
