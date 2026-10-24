using System.Globalization;
using ClickHouse.Driver;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.ClickHouse;

/// <summary>The SQL of the catalog reader (system tables; every value is a <c>{p:String}</c> parameter).</summary>
public static class ChCatalogQueries
{
    /// <summary>Databases hidden from the explorer (the system catalog is offered through completion and the system views).</summary>
    public static readonly string[] SystemDatabases = ["system", "INFORMATION_SCHEMA", "information_schema"];

    public const string ServerInfo = "SELECT version(), hostName(), currentUser(), currentDatabase(), timezone()";

    public const string Databases = """
        SELECT d.name, toInt64(countIf(t.name != '' AND NOT startsWith(t.name, '.inner'))) AS objects
        FROM system.databases d LEFT JOIN system.tables t ON t.database = d.name
        WHERE d.name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
        GROUP BY d.name ORDER BY d.name
        """;

    public const string Tables = """
        SELECT name, engine, comment, primary_key, sorting_key, partition_key, sampling_key, engine_full
        FROM system.tables
        WHERE database = {db:String} AND NOT is_temporary AND NOT startsWith(name, '.inner')
        ORDER BY name
        """;

    public const string Columns = """
        SELECT table, name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, position
        FROM system.columns
        WHERE database = {db:String} AND NOT startsWith(table, '.inner')
        ORDER BY table, position
        """;

    public const string TableColumns = """
        SELECT name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, position, compression_codec
        FROM system.columns
        WHERE database = {db:String} AND table = {t:String}
        ORDER BY position
        """;

    public const string TableInfo = """
        SELECT engine, comment, primary_key, sorting_key, partition_key, sampling_key, engine_full, total_rows, total_bytes,
            toTimeZone(metadata_modification_time, 'UTC'), create_table_query, as_select
        FROM system.tables
        WHERE database = {db:String} AND name = {t:String}
        """;

    public const string SkippingIndices = """
        SELECT name, type_full, expr, granularity
        FROM system.data_skipping_indices
        WHERE database = {db:String} AND table = {t:String}
        ORDER BY name
        """;

    public const string Functions = """
        SELECT name, create_query FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name
        """;

    public const string ShowCreate = "SHOW CREATE {kind} {name}";
}

/// <summary>
/// ClickHouse catalog (plan-batch3 WP-CH) over a sessionless HTTP connection. ClickHouse is single-level: the "schemas" are
/// databases (<c>system.databases</c>, minus system ones), <c>database</c> arguments are ignored. Tables of every engine are
/// <c>table</c>, <c>View</c> is <c>view</c>, <c>MaterializedView</c> is <c>mview</c>, dictionaries are <c>type</c> (comment
/// "Dictionary …"), SQL user-defined functions (global in ClickHouse) appear as <c>func</c> in the connection's default
/// database. The primary key is the table's PRIMARY KEY (the ORDER BY prefix); ClickHouse has no foreign keys and no
/// auto-increment.
/// </summary>
public sealed class ChCatalogReader : ICatalogReader
{
    private readonly ChConnection _ch;
    private readonly string _defaultDatabase;

    public ChCatalogReader(ChConnection connection, string defaultDatabase)
    {
        _ch = connection;
        _defaultDatabase = defaultDatabase;
    }

    internal ChConnection Channel => _ch;
    public string DefaultDatabase => _defaultDatabase;

    public ValueTask DisposeAsync() => _ch.DisposeAsync();

    private global::ClickHouse.Driver.ADO.ClickHouseConnection Conn => _ch.Connection;

    public Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    public Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => Task.FromResult<string?>(_defaultDatabase);

    public Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct) => Task.FromResult(_defaultDatabase);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct) =>
        await ChDb.QueryAsync(Conn, ChCatalogQueries.Databases, r => new SchemaInfo(ChDb.S(r, 0), (int)(ChDb.Long(r, 1) ?? 0)), ct).ConfigureAwait(false);

    /// <summary>The object type token of a <c>system.tables.engine</c>.</summary>
    public static string ObjectType(string? engine) => engine switch
    {
        "View" or "LiveView" or "WindowView" => ObjectTypes.View,
        "MaterializedView" => ObjectTypes.MView,
        "Dictionary" => ObjectTypes.Type,
        _ => ObjectTypes.Table,
    };

    /// <summary>Column flags: 2 = computed (MATERIALIZED / ALIAS), 4 = hidden (EPHEMERAL), 8 = never written by DML (ALIAS).</summary>
    public static int ColumnFlags(string? defaultKind) => defaultKind switch
    {
        "MATERIALIZED" => 2,
        "ALIAS" => 2 | 8,
        "EPHEMERAL" => 4,
        _ => 0,
    };

    /// <summary>Column names of a key expression ("id, toDate(ts)" → ["id"] when only id is a plain column).</summary>
    public static List<string> KeyColumns(string? keyExpression, ICollection<string> columns)
    {
        var list = new List<string>();
        if (string.IsNullOrWhiteSpace(keyExpression)) return list;
        var expr = keyExpression.Trim();
        if (expr.StartsWith("tuple(", StringComparison.Ordinal) && expr.EndsWith(')')) expr = expr[6..^1];
        foreach (var part in ChTypes.SplitArgs(expr))
        {
            var name = part.Trim().Trim('`');
            var match = columns.FirstOrDefault(c => string.Equals(c, name, StringComparison.Ordinal));
            if (match is not null && !list.Contains(match)) list.Add(match);
        }
        return list;
    }

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        var tables = await ChDb.QueryAsync(Conn, ChCatalogQueries.Tables, r => (
            Name: ChDb.S(r, 0), Engine: ChDb.S(r, 1), Comment: ChDb.Str(r, 2), PrimaryKey: ChDb.Str(r, 3), SortingKey: ChDb.Str(r, 4)),
            ct, ("db", schema)).ConfigureAwait(false);
        var columns = (await ChDb.QueryAsync(Conn, ChCatalogQueries.Columns, r => (
                Table: ChDb.S(r, 0), Name: ChDb.S(r, 1), Type: ChDb.S(r, 2), DefaultKind: ChDb.Str(r, 3), Comment: ChDb.Str(r, 5),
                InPk: ChDb.Bool(r, 6)),
            ct, ("db", schema)).ConfigureAwait(false))
            .GroupBy(c => c.Table, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        var objects = new List<CatalogObject>(tables.Count);
        foreach (var t in tables)
        {
            var type = ObjectType(t.Engine);
            var cols = columns.GetValueOrDefault(t.Name) ?? [];
            var pk = type == ObjectTypes.Table
                ? KeyColumns(t.PrimaryKey is { Length: > 0 } ? t.PrimaryKey : t.SortingKey, cols.Select(c => c.Name).ToList())
                : [];
            objects.Add(new CatalogObject
            {
                Type = type,
                Name = t.Name,
                Schema = schema,
                Comment = CommentOf(t.Engine, t.Comment),
                Columns = cols.Select(c => new CatalogColumn(c.Name, c.Type, ChTypes.IsNullable(c.Type), pk.Contains(c.Name),
                    ColumnFlags(c.DefaultKind), string.IsNullOrEmpty(c.Comment) ? null : c.Comment)).ToList(),
                PrimaryKey = pk,
            });
        }

        if (string.Equals(schema, _defaultDatabase, StringComparison.Ordinal))
        {
            try
            {
                foreach (var (name, _) in await ChDb.QueryAsync(Conn, ChCatalogQueries.Functions, r => (ChDb.S(r, 0), ChDb.Str(r, 1)), ct).ConfigureAwait(false))
                    objects.Add(new CatalogObject { Type = ObjectTypes.Func, Name = name, Schema = schema, Comment = "SQL user-defined function" });
            }
            catch (ClickHouseServerException)
            {
                // No access to system.functions: no UDFs listed.
            }
        }
        return new SchemaCatalog(null, schema, objects);
    }

    /// <summary>Engine as comment prefix: "MergeTree · customer orders", dictionaries "Dictionary".</summary>
    public static string? CommentOf(string? engine, string? comment)
    {
        var c = string.IsNullOrWhiteSpace(comment) ? null : comment.Trim();
        if (engine == "Dictionary") return c is null ? "Dictionary" : "Dictionary: " + c;
        return c;
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var db = obj.Schema ?? _defaultDatabase;
        var refOut = obj with { Schema = db, Database = null };
        if (obj.Type == ObjectTypes.Func)
            return new ObjectDetails(refOut, [], [], [], [], [], [], null, null, null);

        var info = (await ChDb.QueryAsync(Conn, ChCatalogQueries.TableInfo, r => (
            Engine: ChDb.S(r, 0), PrimaryKey: ChDb.Str(r, 2), SortingKey: ChDb.Str(r, 3), TotalRows: ChDb.Long(r, 7),
            Modified: ChDb.Time(r, 9)), ct, ("db", db), ("t", obj.Name)).ConfigureAwait(false)).FirstOrDefault();
        if (info == default) throw EngineException.NotFound($"{obj.Type} {db}.{obj.Name}");

        var cols = await ReadColumnsAsync(db, obj.Name, ct).ConfigureAwait(false);
        var names = cols.Select(c => c.Name).ToList();
        var pk = KeyColumns(info.PrimaryKey is { Length: > 0 } ? info.PrimaryKey : info.SortingKey, names);
        var columns = cols.Select((c, i) => new ColumnDetail(c.Name, c.Type, ChTypes.IsNullable(c.Type),
            c.DefaultKind is "DEFAULT" or "MATERIALIZED" or "ALIAS" or "EPHEMERAL" && !string.IsNullOrEmpty(c.DefaultExpr) ? c.DefaultExpr : null,
            pk.Contains(c.Name), false, c.DefaultKind is "MATERIALIZED" or "ALIAS", c.Comment, i + 1)).ToList();

        var indexes = new List<IndexDetail>();
        if (pk.Count > 0) indexes.Add(new IndexDetail("PRIMARY KEY", false, pk, "primary key (sparse)", IsPrimaryKey: true));
        if (ObjectType(info.Engine) == ObjectTypes.Table)
        {
            try
            {
                indexes.AddRange(await ChDb.QueryAsync(Conn, ChCatalogQueries.SkippingIndices, r => new IndexDetail(ChDb.S(r, 0), false,
                    [ChDb.S(r, 2)], $"{ChDb.S(r, 1)} GRANULARITY {ChDb.Long(r, 3) ?? 1}"), ct, ("db", db), ("t", obj.Name)).ConfigureAwait(false));
            }
            catch (ClickHouseServerException)
            {
                // system.data_skipping_indices missing on very old servers.
            }
        }
        return new ObjectDetails(refOut, columns, indexes, [], [], [], [], info.TotalRows, null, info.Modified);
    }

    internal sealed record RawColumn(string Name, string Type, string? DefaultKind, string? DefaultExpr, string? Comment, bool InPk, bool InSort, string? Codec);

    internal async Task<List<RawColumn>> ReadColumnsAsync(string db, string table, CancellationToken ct) =>
        await ChDb.QueryAsync(Conn, ChCatalogQueries.TableColumns, r => new RawColumn(ChDb.S(r, 0), ChDb.S(r, 1),
            NullIfEmpty(ChDb.Str(r, 2)), NullIfEmpty(ChDb.Str(r, 3)), NullIfEmpty(ChDb.Str(r, 4)), ChDb.Bool(r, 5), ChDb.Bool(r, 6),
            NullIfEmpty(ChDb.Str(r, 8))), ct, ("db", db), ("t", table)).ConfigureAwait(false);

    private static string? NullIfEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var db = obj.Schema ?? _defaultDatabase;
        if (obj.Type == ObjectTypes.Func)
        {
            var q = await ChDb.ScalarAsync(Conn, "SELECT create_query FROM system.functions WHERE origin = 'SQLUserDefined' AND name = {n:String}",
                ct, ("n", obj.Name)).ConfigureAwait(false) as string;
            if (string.IsNullOrWhiteSpace(q)) throw EngineException.NotFound($"function {obj.Name}");
            return new DdlResult(q.Trim() + ";", "stored");
        }
        var kind = obj.Type == ObjectTypes.Type ? "DICTIONARY" : "TABLE";
        try
        {
            var ddl = await ChDb.ScalarAsync(Conn, $"SHOW CREATE {kind} {ChSqlText.Qualified(db, obj.Name)}", ct).ConfigureAwait(false) as string;
            if (!string.IsNullOrWhiteSpace(ddl)) return new DdlResult(ddl.Trim() + ";", "stored");
        }
        catch (ClickHouseServerException ex) when (ex.ErrorCode is ChErrors.UnknownTable or 390 or 36)
        {
            throw EngineException.NotFound($"{obj.Type} {db}.{obj.Name}");
        }
        throw EngineException.NotFound($"{obj.Type} {db}.{obj.Name}");
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);

    public static string Invariant(long v) => v.ToString(CultureInfo.InvariantCulture);
}
