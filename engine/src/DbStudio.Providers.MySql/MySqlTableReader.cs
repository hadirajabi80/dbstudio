using DbStudio.Core.Services;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>One information_schema.COLUMNS row.</summary>
public sealed record MyColumn(string Table, string Name, string ColumnType, string DataType, bool Nullable, string Key, string Extra,
    string? Comment, int Ordinal, string? RawDefault, string? Generation, string? Charset, string? Collation)
{
    public bool IsAutoIncrement => Extra.Contains("auto_increment", StringComparison.OrdinalIgnoreCase);
    public bool IsGenerated => !string.IsNullOrWhiteSpace(Generation) || Extra.Contains("GENERATED", StringComparison.OrdinalIgnoreCase) && !Extra.Contains("DEFAULT_GENERATED", StringComparison.OrdinalIgnoreCase);
    public bool IsStored => Extra.Contains("STORED", StringComparison.OrdinalIgnoreCase) || Extra.Contains("PERSISTENT", StringComparison.OrdinalIgnoreCase);
    public bool IsInvisible => Extra.Contains("INVISIBLE", StringComparison.OrdinalIgnoreCase);
    public string? OnUpdate
    {
        get
        {
            var i = Extra.IndexOf("on update ", StringComparison.OrdinalIgnoreCase);
            return i < 0 ? null : Extra[(i + 10)..].Trim();
        }
    }
}

/// <summary>One key column (KEY_COLUMN_USAGE joined to TABLE_CONSTRAINTS).</summary>
public sealed record MyKeyColumn(string Table, string Constraint, string Type, string Column, int Position, string? RefSchema, string? RefTable, string? RefColumn);

/// <summary>One information_schema.STATISTICS row.</summary>
public sealed record MyIndexColumn(string Index, bool Unique, string? Column, int Seq, string IndexType, int? SubPart, bool Desc, string? Comment);

/// <summary>Reads table metadata shared by the catalog reader, the DDL generator and the designer.</summary>
public static class MySqlTableReader
{
    public static MyColumn ReadColumn(MySqlDataReader r) => new(
        MySqlDb.S(r, 0), MySqlDb.S(r, 1), MySqlDb.S(r, 2), MySqlDb.S(r, 9).ToLowerInvariant(), MySqlDb.S(r, 3) == "YES", MySqlDb.S(r, 4),
        MySqlDb.S(r, 5), NullIfEmpty(MySqlDb.Str(r, 6)), MySqlDb.Int(r, 7), MySqlDb.Str(r, 8), NullIfEmpty(MySqlDb.Str(r, 10)),
        MySqlDb.Str(r, 11), MySqlDb.Str(r, 12));

    public static MyKeyColumn ReadKey(MySqlDataReader r) => new(
        MySqlDb.S(r, 0), MySqlDb.S(r, 1), MySqlDb.S(r, 2), MySqlDb.S(r, 3), MySqlDb.Int(r, 4), MySqlDb.Str(r, 5), MySqlDb.Str(r, 6), MySqlDb.Str(r, 7));

    public static MyIndexColumn ReadIndex(MySqlDataReader r) => new(
        MySqlDb.S(r, 0), !MySqlDb.Bool(r, 1), MySqlDb.Str(r, 2), MySqlDb.Int(r, 3), MySqlDb.S(r, 4), r.IsDBNull(5) ? null : MySqlDb.Int(r, 5),
        MySqlDb.Str(r, 6) == "D", NullIfEmpty(MySqlDb.Str(r, 7)));

    public static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private static readonly HashSet<string> QuotedDefaultTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set", "date", "time", "datetime", "timestamp", "year",
        "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "json", "inet4", "inet6", "uuid",
    };

    /// <summary>
    /// The DEFAULT as an SQL expression, or null for none. MySQL reports literals unquoted (and expressions with EXTRA
    /// DEFAULT_GENERATED); MariaDB 10.2.7+ reports literals quoted and "NULL" for a NULL default.
    /// </summary>
    public static string? DefaultExpression(MyColumn c, bool mariaDb)
    {
        var raw = c.RawDefault;
        if (raw is null || c.IsGenerated) return null;
        if (mariaDb)
        {
            if (raw == "NULL") return null;
            return raw;
        }
        if (c.Extra.Contains("DEFAULT_GENERATED", StringComparison.OrdinalIgnoreCase))
        {
            var e = raw.Trim();
            if (e.StartsWith("CURRENT_TIMESTAMP", StringComparison.OrdinalIgnoreCase) || e.StartsWith("now(", StringComparison.OrdinalIgnoreCase)) return e;
            return e.StartsWith('(') ? e : "(" + e + ")";
        }
        if (c.DataType == "bit" && raw.StartsWith("b'", StringComparison.OrdinalIgnoreCase)) return raw;
        if (QuotedDefaultTypes.Contains(c.DataType))
        {
            if (raw.Equals("CURRENT_TIMESTAMP", StringComparison.OrdinalIgnoreCase)) return raw;
            return MySqlSqlText.Literal(raw);
        }
        return raw;
    }

    public static async Task<List<MyColumn>> ColumnsAsync(MySqlConnection conn, string schema, string table, CancellationToken ct) =>
        await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.TableColumns, ReadColumn, ct, schema, table).ConfigureAwait(false);

    public static async Task<List<MyKeyColumn>> KeysAsync(MySqlConnection conn, string schema, string table, CancellationToken ct) =>
        await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.TableKeyColumns, ReadKey, ct, schema, table).ConfigureAwait(false);

    public static async Task<List<MyIndexColumn>> IndexesAsync(MySqlConnection conn, string schema, string table, CancellationToken ct) =>
        await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.Indexes, ReadIndex, ct, schema, table).ConfigureAwait(false);

    public static async Task<Dictionary<string, (string OnDelete, string OnUpdate)>> ActionsAsync(MySqlConnection conn, string schema, string table, CancellationToken ct) =>
        (await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.ReferentialActions, r => (Name: MySqlDb.S(r, 0), Del: MySqlDb.S(r, 1), Upd: MySqlDb.S(r, 2)), ct, schema, table)
            .ConfigureAwait(false)).GroupBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => (g.First().Del, g.First().Upd), StringComparer.OrdinalIgnoreCase);

    public static async Task<List<(string Name, string Clause)>> ChecksAsync(MySqlConnection conn, MySqlFlavor flavor, string schema, string table, CancellationToken ct)
    {
        if (!flavor.HasCheckConstraints) return [];
        try
        {
            return await MySqlDb.QueryAsync(conn, flavor.IsMariaDb ? MySqlCatalogQueries.CheckConstraintsMariaDb : MySqlCatalogQueries.CheckConstraints,
                r => (MySqlDb.S(r, 0), MySqlDb.S(r, 1)), ct, schema, table).ConfigureAwait(false);
        }
        catch (MySqlException ex) when (ex.Number is 1054 or 1109 or 1146)
        {
            return [];
        }
    }

    /// <summary>The (schema, name, type) of a table/view/sequence, or null.</summary>
    public static async Task<(string Name, string Type, string? Comment, string? Engine, long? Rows, long? Size, DateTimeOffset? Created, DateTimeOffset? Updated, string? Collation, long? AutoIncrement)?>
        TableInfoAsync(MySqlConnection conn, string schema, string name, CancellationToken ct)
    {
        var rows = await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.TableInfo, r => (
            Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Comment: NullIfEmpty(MySqlDb.Str(r, 2)), Engine: MySqlDb.Str(r, 3), Rows: MySqlDb.Long(r, 4),
            Size: MySqlDb.Long(r, 5), Created: MySqlDb.Time(r, 6), Updated: MySqlDb.Time(r, 7), Collation: MySqlDb.Str(r, 8), AutoIncrement: MySqlDb.Long(r, 9)),
            ct, schema, name).ConfigureAwait(false);
        if (rows.Count == 0) return null;
        // exact spelling first (lower_case_table_names=0 servers can hold "Orders" and "orders")
        var hit = rows.FirstOrDefault(x => x.Name == name);
        return hit.Name is null ? rows[0] : hit;
    }

    /// <summary>TABLE_TYPE → catalog type: BASE TABLE / SYSTEM VERSIONED → table, VIEW / SYSTEM VIEW → view, SEQUENCE → sequence.</summary>
    public static string ObjectType(string tableType) => tableType.ToUpperInvariant() switch
    {
        "VIEW" or "SYSTEM VIEW" => Core.Models.ObjectTypes.View,
        "SEQUENCE" => Core.Models.ObjectTypes.Sequence,
        _ => Core.Models.ObjectTypes.Table,
    };

    public static EngineException NotFound(string what) => EngineException.NotFound(what);
}
