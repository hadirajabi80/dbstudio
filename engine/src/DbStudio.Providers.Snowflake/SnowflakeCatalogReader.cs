using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Catalog reader over one pooled gateway connection (plan-batch3 WP-SF): everything comes from SHOW / DESCRIBE commands
/// and <c>GET_DDL</c>, which run in Snowflake's cloud services layer, so browsing never resumes a warehouse (no credits).
/// Names are addressed fully quoted (<c>"DB"."SCHEMA"</c>), so one connection serves every database.
/// <para>Mapping: TABLE / TRANSIENT / TEMPORARY / dynamic / external / hybrid / Iceberg tables → <c>table</c>; views →
/// <c>view</c>, materialized views → <c>mview</c>; procedures → <c>proc</c>; functions → <c>func</c> / <c>tablefunc</c>
/// (UDTFs); sequences → <c>sequence</c>. INFORMATION_SCHEMA is hidden. Stages, streams, tasks, pipes and file formats are
/// listed by the module's objects endpoint instead.</para>
/// </summary>
public sealed class SnowflakeCatalogReader : ICatalogReader
{
    public const string InformationSchema = "INFORMATION_SCHEMA";

    private readonly ConnectionProfile _profile;

    public SnowflakeCatalogReader(ISnowflakeGateway gateway, ConnectionProfile profile)
    {
        Gateway = gateway;
        _profile = profile;
    }

    public ISnowflakeGateway Gateway { get; }

    public ValueTask DisposeAsync() => Gateway.DisposeAsync();

    /// <summary>The profile's database (stored form) or null.</summary>
    public string? ProfileDatabase => Norm(_profile.GetString("database"));

    public string ProfileSchema => Norm(_profile.GetString("schema")) ?? SnowflakeConnectionStrings.DefaultSchema;

    private static string? Norm(string? v) => string.IsNullOrWhiteSpace(v) ? null : SnowflakeSql.Normalize(v);

    // ------------------------------------------------------------------ databases / schemas

    public async Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct)
    {
        var rs = await Gateway.QueryAsync(SnowflakeSql.ShowDatabases, ct).ConfigureAwait(false);
        return rs.Rows.Select(r => rs.Str(r, "name")).Where(n => !string.IsNullOrEmpty(n)).Select(n => n!).ToList();
    }

    public async Task<string?> GetCurrentDatabaseAsync(CancellationToken ct)
    {
        if (ProfileDatabase is { } db) return db;
        var rs = await Gateway.QueryAsync("SELECT CURRENT_DATABASE() AS DATABASE_NAME", ct).ConfigureAwait(false);
        return rs.Rows.Count == 0 ? null : rs.Str(rs.Rows[0], "DATABASE_NAME");
    }

    internal async Task<string> DatabaseOrCurrentAsync(string? database, CancellationToken ct)
    {
        var db = Norm(database) ?? await GetCurrentDatabaseAsync(ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(db))
            throw EngineException.Validation("No database selected: pick a database (or set one in the connection).", new { field = "database" });
        return db;
    }

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        var db = Norm(database) ?? await GetCurrentDatabaseAsync(ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(db)) return [];
        var rs = await Gateway.QueryAsync(SnowflakeSql.ShowSchemas(db), ct).ConfigureAwait(false);
        return rs.Rows.Select(r => rs.Str(r, "name") ?? "")
            .Where(n => n.Length > 0 && !n.Equals(InformationSchema, StringComparison.OrdinalIgnoreCase))
            .Select(n => new SchemaInfo(n)).ToList();
    }

    public Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct) => Task.FromResult(ProfileSchema);

    // ------------------------------------------------------------------ schema snapshot

    /// <summary>A SHOW command that may be refused (privileges) or unknown on older accounts: empty instead of failing the schema.</summary>
    internal async Task<SqlRowSet> TryShowAsync(string sql, CancellationToken ct, string? fallback = null)
    {
        try
        {
            return await Gateway.QueryAsync(sql, ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException) when (fallback is not null)
        {
            return await TryShowAsync(fallback, ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException ex) when (ex.IsPrivilege || ex.IsNotFoundOrDenied || ex.ErrorCode is 1003 or 2140)
        {
            return new SqlRowSet([], []);
        }
    }

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(schema);
        var db = await DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        var sc = schema.Trim();

        SqlRowSet tables;
        try
        {
            tables = await Gateway.QueryAsync(SnowflakeSql.ShowTables(db, sc), ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
        {
            throw EngineException.NotFound($"Schema '{sc}' in database '{db}'");
        }
        var views = await TryShowAsync(SnowflakeSql.ShowViews(db, sc), ct).ConfigureAwait(false);
        var columns = await TryShowAsync(SnowflakeSql.ShowColumns(db, sc), ct).ConfigureAwait(false);
        var pks = await TryShowAsync(SnowflakeSql.ShowPrimaryKeys(db, sc), ct).ConfigureAwait(false);
        var fks = await TryShowAsync(SnowflakeSql.ShowImportedKeys(db, sc), ct).ConfigureAwait(false);
        var procs = await TryShowAsync(SnowflakeSql.ShowProcedures(db, sc), ct, $"SHOW PROCEDURES IN SCHEMA {SnowflakeSql.SchemaPath(db, sc)}").ConfigureAwait(false);
        var funcs = await TryShowAsync(SnowflakeSql.ShowFunctions(db, sc), ct).ConfigureAwait(false);
        var seqs = await TryShowAsync(SnowflakeSql.ShowSequences(db, sc), ct).ConfigureAwait(false);
        return BuildSchema(db, sc, tables, views, columns, pks, fks, procs, funcs, seqs);
    }

    /// <summary>Pure assembly of the schema snapshot from the SHOW results (unit-tested over recorded fixtures).</summary>
    public static SchemaCatalog BuildSchema(string database, string schema, SqlRowSet tables, SqlRowSet views, SqlRowSet columns, SqlRowSet pks,
        SqlRowSet fks, SqlRowSet procs, SqlRowSet funcs, SqlRowSet seqs)
    {
        var colsByTable = new Dictionary<string, List<object?[]>>(StringComparer.Ordinal);
        foreach (var r in columns.Rows)
        {
            var t = columns.Str(r, "table_name");
            if (t is null) continue;
            if (!colsByTable.TryGetValue(t, out var list)) colsByTable[t] = list = [];
            list.Add(r);
        }
        var pkByTable = pks.Rows.GroupBy(r => pks.Str(r, "table_name") ?? "")
            .ToDictionary(g => g.Key, g => g.OrderBy(r => pks.Long(r, "key_sequence") ?? 0).Select(r => pks.Str(r, "column_name") ?? "").ToList(), StringComparer.Ordinal);
        var fkByTable = ForeignKeys(fks, outgoing: true).GroupBy(f => f.Table).ToDictionary(g => g.Key, g => g.Select(f => f.Ref).ToList(), StringComparer.Ordinal);

        var objects = new List<CatalogObject>();
        foreach (var r in tables.Rows)
        {
            var name = tables.Str(r, "name");
            if (string.IsNullOrEmpty(name)) continue;
            var pk = pkByTable.GetValueOrDefault(name) ?? [];
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Table,
                Name = name,
                Schema = schema,
                Comment = NullIfEmpty(tables.Str(r, "comment")),
                Columns = CatalogColumns(columns, colsByTable.GetValueOrDefault(name), pk),
                PrimaryKey = pk,
                ForeignKeys = fkByTable.GetValueOrDefault(name) ?? [],
            });
        }
        foreach (var r in views.Rows)
        {
            var name = views.Str(r, "name");
            if (string.IsNullOrEmpty(name)) continue;
            objects.Add(new CatalogObject
            {
                Type = Flag(views, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View,
                Name = name,
                Schema = schema,
                Comment = NullIfEmpty(views.Str(r, "comment")),
                Columns = CatalogColumns(columns, colsByTable.GetValueOrDefault(name), []),
            });
        }
        foreach (var r in procs.Rows)
        {
            if (IsBuiltin(procs, r)) continue;
            var name = procs.Str(r, "name");
            if (string.IsNullOrEmpty(name) || objects.Any(o => o.Type == ObjectTypes.Proc && o.Name == name)) continue;
            var (args, returns) = SnowflakeSql.ParseArguments(procs.Str(r, "arguments"));
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Proc,
                Name = name,
                Schema = schema,
                Comment = DescriptionOf(procs, r),
                Parameters = UnnamedParameters(args, null),
            });
        }
        foreach (var r in funcs.Rows)
        {
            if (IsBuiltin(funcs, r)) continue;
            var name = funcs.Str(r, "name");
            if (string.IsNullOrEmpty(name)) continue;
            var table = Flag(funcs, r, "is_table_function");
            var type = table ? ObjectTypes.TableFunc : ObjectTypes.Func;
            if (objects.Any(o => o.Type == type && o.Name == name)) continue;
            var (args, returns) = SnowflakeSql.ParseArguments(funcs.Str(r, "arguments"));
            objects.Add(new CatalogObject
            {
                Type = type,
                Name = name,
                Schema = schema,
                Comment = DescriptionOf(funcs, r),
                Parameters = UnnamedParameters(args, table ? null : returns),
                Columns = table ? TableFunctionColumns(returns) : [],
            });
        }
        foreach (var r in seqs.Rows)
        {
            var name = seqs.Str(r, "name");
            if (string.IsNullOrEmpty(name)) continue;
            objects.Add(new CatalogObject { Type = ObjectTypes.Sequence, Name = name, Schema = schema, Comment = NullIfEmpty(seqs.Str(r, "comment")) });
        }

        return new SchemaCatalog(database, schema, objects);
    }

    private static bool IsBuiltin(SqlRowSet rs, object?[] r) => rs.IndexOf("is_builtin") >= 0 && Flag(rs, r, "is_builtin");

    /// <summary>"user-defined function" / "user-defined procedure" is Snowflake's placeholder description.</summary>
    private static string? DescriptionOf(SqlRowSet rs, object?[] r)
    {
        var d = NullIfEmpty(rs.Str(r, "description"));
        return d is "user-defined function" or "user-defined procedure" ? null : d;
    }

    internal static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    /// <summary>Snowflake's "Y"/"N", "true"/"false" flags.</summary>
    internal static bool Flag(SqlRowSet rs, object?[] r, string column) => rs.Str(r, column)?.Trim().ToUpperInvariant() is "Y" or "YES" or "TRUE" or "1" or "ON";

    private static List<ParamInfo> UnnamedParameters(IReadOnlyList<string> args, string? returns)
    {
        var list = args.Select((a, i) => new ParamInfo("ARG" + (i + 1).ToString(CultureInfo.InvariantCulture), a, "in", false)).ToList();
        if (returns is not null) list.Add(new ParamInfo("", returns, "return", false));
        return list;
    }

    /// <summary><c>TABLE (ID NUMBER, NAME VARCHAR)</c> → columns of a UDTF.</summary>
    internal static List<CatalogColumn> TableFunctionColumns(string? returns)
    {
        if (string.IsNullOrWhiteSpace(returns)) return [];
        var r = returns.Trim();
        if (!r.StartsWith("TABLE", StringComparison.OrdinalIgnoreCase)) return [];
        var open = r.IndexOf('(');
        var close = r.LastIndexOf(')');
        if (open < 0 || close <= open) return [];
        return SnowflakeSql.ParseSignature(r[open..(close + 1)]).Where(p => p.Name.Length > 0)
            .Select(p => new CatalogColumn(p.Name, p.TypeText, true, false)).ToList();
    }

    private static List<CatalogColumn> CatalogColumns(SqlRowSet columns, List<object?[]>? rows, IReadOnlyList<string> pk)
    {
        if (rows is null) return [];
        var pkSet = new HashSet<string>(pk, StringComparer.Ordinal);
        return rows.Select(r =>
        {
            var name = columns.Str(r, "column_name") ?? "";
            var (type, nullable) = SnowflakeTypes.FromShowColumnsJson(columns.Str(r, "data_type"));
            var flags = 0;
            if (!string.IsNullOrWhiteSpace(columns.Str(r, "autoincrement"))) flags |= 1;
            if (!string.IsNullOrWhiteSpace(columns.Str(r, "expression"))) flags |= 2;
            return new CatalogColumn(name, type, nullable, pkSet.Contains(name), flags, NullIfEmpty(columns.Str(r, "comment")));
        }).ToList();
    }

    /// <summary>One FK per constraint from SHOW IMPORTED (outgoing) / EXPORTED (incoming) KEYS rows (one row per column).</summary>
    internal static List<(string Schema, string Table, ForeignKeyRef Ref)> ForeignKeys(SqlRowSet fks, bool outgoing)
    {
        var list = new List<(string, string, ForeignKeyRef)>();
        foreach (var g in fks.Rows.GroupBy(r => (fks.Str(r, "fk_schema_name") ?? "", fks.Str(r, "fk_table_name") ?? "", fks.Str(r, "fk_name") ?? "")))
        {
            var rows = g.OrderBy(r => fks.Long(r, "key_sequence") ?? 0).ToList();
            var first = rows[0];
            var fk = new ForeignKeyRef(
                g.Key.Item3,
                rows.Select(r => fks.Str(r, "fk_column_name") ?? "").ToList(),
                fks.Str(first, "pk_schema_name"),
                fks.Str(first, "pk_table_name") ?? "",
                rows.Select(r => fks.Str(r, "pk_column_name") ?? "").ToList());
            list.Add((g.Key.Item1, g.Key.Item2, fk));
        }
        _ = outgoing;
        return list;
    }

    // ------------------------------------------------------------------ object details

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        var db = await DatabaseOrCurrentAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? ProfileSchema;
        var reference = obj with { Database = db, Schema = schema };
        switch (obj.Type)
        {
            case ObjectTypes.Proc:
            case ObjectTypes.Func:
            case ObjectTypes.TableFunc:
            {
                var routine = await FindRoutineAsync(db, schema, obj.Name, obj.Type == ObjectTypes.Proc, ct).ConfigureAwait(false);
                var parameters = routine is null ? [] : await RoutineParametersAsync(db, schema, routine.Value, ct).ConfigureAwait(false);
                return new ObjectDetails(reference, [], [], [], [], [], parameters, null, routine?.Created, null);
            }
            case ObjectTypes.Sequence:
            {
                var rs = await Gateway.QueryAsync(SnowflakeSql.ShowSequenceLike(db, schema, obj.Name), ct).ConfigureAwait(false);
                var r = rs.Rows.FirstOrDefault(x => rs.Str(x, "name") == obj.Name) ?? throw EngineException.NotFound($"Sequence {schema}.{obj.Name}");
                return new ObjectDetails(reference, [], [], [], [], [], [], null, ParseTime(rs.Str(r, "created_on")), null);
            }
        }

        var isView = obj.Type is ObjectTypes.View or ObjectTypes.MView;
        SqlRowSet describe;
        try
        {
            describe = await Gateway.QueryAsync(isView ? SnowflakeSql.DescribeView(db, schema, obj.Name) : SnowflakeSql.DescribeTable(db, schema, obj.Name), ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
        {
            throw EngineException.NotFound($"{(isView ? "View" : "Table")} {schema}.{obj.Name}");
        }
        var columns = DescribeColumns(describe);
        var meta = await TryShowAsync(isView ? SnowflakeSql.ShowViewLike(db, schema, obj.Name) : SnowflakeSql.ShowTableLike(db, schema, obj.Name), ct).ConfigureAwait(false);
        var metaRow = meta.Rows.FirstOrDefault(r => meta.Str(r, "name") == obj.Name);
        if (isView)
            return new ObjectDetails(reference, columns, [], [], [], [], [], null, metaRow is null ? null : ParseTime(meta.Str(metaRow, "created_on")), null);

        var pks = await TryShowAsync(SnowflakeSql.ShowPrimaryKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
        var uks = await TryShowAsync(SnowflakeSql.ShowUniqueKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
        var imported = await TryShowAsync(SnowflakeSql.ShowImportedKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
        var exported = await TryShowAsync(SnowflakeSql.ShowExportedKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
        return BuildTableDetails(reference, columns, metaRow is null ? null : (meta, metaRow), pks, uks, imported, exported);
    }

    /// <summary>Pure assembly of a table's details (fixtures-tested).</summary>
    public static ObjectDetails BuildTableDetails(ObjectRef reference, IReadOnlyList<ColumnDetail> columns, (SqlRowSet Rs, object?[] Row)? meta,
        SqlRowSet pks, SqlRowSet uks, SqlRowSet imported, SqlRowSet exported)
    {
        var indexes = new List<IndexDetail>();
        var pkRows = pks.Rows.OrderBy(r => pks.Long(r, "key_sequence") ?? 0).ToList();
        if (pkRows.Count > 0)
            indexes.Add(new IndexDetail(pks.Str(pkRows[0], "constraint_name") ?? "PRIMARY KEY", true,
                pkRows.Select(r => pks.Str(r, "column_name") ?? "").ToList(), "primary key (not enforced)", IsPrimaryKey: true));
        foreach (var g in uks.Rows.GroupBy(r => uks.Str(r, "constraint_name") ?? ""))
            indexes.Add(new IndexDetail(g.Key, true, g.OrderBy(r => uks.Long(r, "key_sequence") ?? 0).Select(r => uks.Str(r, "column_name") ?? "").ToList(), "unique (not enforced)"));
        long? rows = null;
        DateTimeOffset? created = null;
        if (meta is { } m)
        {
            rows = m.Rs.Long(m.Row, "rows");
            created = ParseTime(m.Rs.Str(m.Row, "created_on"));
            var clusterBy = NullIfEmpty(m.Rs.Str(m.Row, "cluster_by"));
            if (clusterBy is not null) indexes.Add(new IndexDetail("CLUSTER BY", false, ClusterKeys(clusterBy), "clustering key"));
        }
        var fks = ForeignKeys(imported, outgoing: true).Select(f => f.Ref).ToList();
        var referencedBy = ForeignKeys(exported, outgoing: false)
            .Select(f => new ReferencedBy(f.Schema, f.Table, f.Ref.Name, f.Ref.Columns)).ToList();
        return new ObjectDetails(reference, columns, indexes, fks, referencedBy, [], [], rows, created, null);
    }

    /// <summary>"LINEAR(ORDER_DATE, TO_DATE(TS))" → ["ORDER_DATE", "TO_DATE(TS)"].</summary>
    public static List<string> ClusterKeys(string clusterBy)
    {
        var s = clusterBy.Trim();
        if (s.StartsWith("LINEAR(", StringComparison.OrdinalIgnoreCase) && s.EndsWith(')')) s = s[7..^1];
        else if (s.StartsWith('(') && s.EndsWith(')')) s = s[1..^1];
        return SnowflakeSql.SplitTopLevel(s).Select(x => x.Trim()).ToList();
    }

    /// <summary>DESCRIBE TABLE / VIEW rows (name, type, kind, null?, default, primary key, unique key, check, expression, comment).</summary>
    public static List<ColumnDetail> DescribeColumns(SqlRowSet d)
    {
        var list = new List<ColumnDetail>();
        var ordinal = 0;
        foreach (var r in d.Rows)
        {
            var kind = d.Str(r, "kind") ?? "COLUMN";
            if (!kind.Equals("COLUMN", StringComparison.OrdinalIgnoreCase) && !kind.Equals("VIRTUAL", StringComparison.OrdinalIgnoreCase)) continue;
            var def = NullIfEmpty(d.Str(r, "default"));
            var identity = def is not null && IsIdentityDefault(def);
            var expression = NullIfEmpty(d.Str(r, "expression"));
            list.Add(new ColumnDetail(
                Name: d.Str(r, "name") ?? "",
                Type: d.Str(r, "type") ?? "",
                Nullable: Flag(d, r, "null?"),
                Default: identity ? null : def,
                IsPk: Flag(d, r, "primary key"),
                IsIdentity: identity,
                IsComputed: expression is not null || kind.Equals("VIRTUAL", StringComparison.OrdinalIgnoreCase),
                Comment: NullIfEmpty(d.Str(r, "comment")),
                Ordinal: ++ordinal));
        }
        return list;
    }

    /// <summary>"IDENTITY START 1 INCREMENT 1 ORDER" / "AUTOINCREMENT START 1 INCREMENT 1".</summary>
    public static bool IsIdentityDefault(string def) =>
        def.StartsWith("IDENTITY", StringComparison.OrdinalIgnoreCase) || def.StartsWith("AUTOINCREMENT", StringComparison.OrdinalIgnoreCase);

    /// <summary>(start, increment) of an identity default text.</summary>
    public static (long Start, long Increment) IdentityOf(string def)
    {
        long start = 1, inc = 1;
        var parts = def.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i + 1 < parts.Length; i++)
        {
            if (parts[i].Equals("START", StringComparison.OrdinalIgnoreCase)) long.TryParse(parts[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out start);
            if (parts[i].Equals("INCREMENT", StringComparison.OrdinalIgnoreCase)) long.TryParse(parts[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out inc);
        }
        var paren = def.IndexOf('(');
        if (paren > 0 && def.EndsWith(')'))
        {
            var args = def[(paren + 1)..^1].Split(',', StringSplitOptions.TrimEntries);
            if (args.Length >= 1) long.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out start);
            if (args.Length >= 2) long.TryParse(args[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out inc);
        }
        return (start, inc == 0 ? 1 : inc);
    }

    /// <summary>"2026-10-01 09:15:42.123 -0700" (SHOW created_on) → time.</summary>
    public static DateTimeOffset? ParseTime(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        string[] formats = ["yyyy-MM-dd HH:mm:ss.fff zzz", "yyyy-MM-dd HH:mm:ss.fff K", "yyyy-MM-dd HH:mm:ss zzz", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", "yyyy-MM-dd HH:mm:ss.FFFFFFF"];
        // "-0700" → "-07:00" for the zzz pattern
        if (t.Length > 5 && (t[^5] is '+' or '-') && char.IsDigit(t[^1]) && t[^3] != ':') t = t[..^2] + ":" + t[^2..];
        if (DateTimeOffset.TryParseExact(t, formats, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var dto)) return dto;
        return DateTimeOffset.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out dto) ? dto : null;
    }

    // ------------------------------------------------------------------ routines

    public readonly record struct RoutineRow(string Name, bool Procedure, IReadOnlyList<string> ArgTypes, string? Returns, bool TableFunction,
        DateTimeOffset? Created, string? Language);

    /// <summary>Overloads of one routine name (SHOW USER PROCEDURES / FUNCTIONS LIKE).</summary>
    internal async Task<List<RoutineRow>> RoutineOverloadsAsync(string db, string schema, string name, bool procedure, CancellationToken ct)
    {
        var rs = procedure
            ? await TryShowAsync(SnowflakeSql.ShowProcedureLike(db, schema, name), ct,
                $"SHOW PROCEDURES LIKE {SnowflakeSql.ShowLikeExact(name)} IN SCHEMA {SnowflakeSql.SchemaPath(db, schema)}").ConfigureAwait(false)
            : await TryShowAsync(SnowflakeSql.ShowFunctionLike(db, schema, name), ct).ConfigureAwait(false);
        return rs.Rows.Where(r => rs.Str(r, "name") == name && !IsBuiltin(rs, r)).Select(r =>
        {
            var (args, returns) = SnowflakeSql.ParseArguments(rs.Str(r, "arguments"));
            return new RoutineRow(name, procedure, args, returns, !procedure && Flag(rs, r, "is_table_function"), ParseTime(rs.Str(r, "created_on")),
                NullIfEmpty(rs.Str(r, "language")));
        }).ToList();
    }

    internal async Task<RoutineRow?> FindRoutineAsync(string db, string schema, string name, bool procedure, CancellationToken ct)
    {
        var rows = await RoutineOverloadsAsync(db, schema, name, procedure, ct).ConfigureAwait(false);
        if (rows.Count == 0 && !procedure) rows = await RoutineOverloadsAsync(db, schema, name, true, ct).ConfigureAwait(false);
        return rows.Count == 0 ? null : rows[0];
    }

    /// <summary>Named parameters from DESCRIBE PROCEDURE/FUNCTION (property "signature", "returns").</summary>
    internal async Task<IReadOnlyList<ParamInfo>> RoutineParametersAsync(string db, string schema, RoutineRow routine, CancellationToken ct)
    {
        SqlRowSet d;
        try
        {
            d = await Gateway.QueryAsync(SnowflakeSql.DescribeRoutine(routine.Procedure, db, schema, routine.Name, routine.ArgTypes), ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException)
        {
            return UnnamedParameters(routine.ArgTypes, routine.Procedure || routine.TableFunction ? null : routine.Returns);
        }
        return DescribeRoutineParameters(d, routine);
    }

    public static List<ParamInfo> DescribeRoutineParameters(SqlRowSet d, RoutineRow routine)
    {
        var props = Properties(d);
        var list = SnowflakeSql.ParseSignature(props.GetValueOrDefault("signature"));
        if (list.Count == 0 && routine.ArgTypes.Count > 0) list = UnnamedParameters(routine.ArgTypes, null);
        var returns = props.GetValueOrDefault("returns") ?? routine.Returns;
        if (!routine.Procedure && !routine.TableFunction && returns is not null) list.Add(new ParamInfo("", returns, "return", false));
        return list;
    }

    /// <summary>DESCRIBE FUNCTION / PROCEDURE rows (property, value) as a dictionary.</summary>
    public static Dictionary<string, string> Properties(SqlRowSet d)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in d.Rows)
        {
            var k = d.Str(r, "property");
            if (k is not null) map[k] = d.Str(r, "value") ?? "";
        }
        return map;
    }

    // ------------------------------------------------------------------ DDL

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        var db = await DatabaseOrCurrentAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? ProfileSchema;
        if (obj.Type is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc)
        {
            var procedure = obj.Type == ObjectTypes.Proc;
            var overloads = await RoutineOverloadsAsync(db, schema, obj.Name, procedure, ct).ConfigureAwait(false);
            if (overloads.Count == 0) throw EngineException.NotFound($"Routine {schema}.{obj.Name}");
            var sb = new StringBuilder();
            foreach (var o in overloads)
            {
                var ddl = await DdlTextAsync(procedure ? "PROCEDURE" : "FUNCTION", db, schema, obj.Name, o.ArgTypes, ct).ConfigureAwait(false);
                if (sb.Length > 0) sb.Append("\n\n");
                sb.Append(ddl.TrimEnd());
            }
            return new DdlResult(sb.ToString() + "\n", "stored");
        }
        var type = obj.Type switch
        {
            ObjectTypes.View or ObjectTypes.MView => "VIEW",
            ObjectTypes.Sequence => "SEQUENCE",
            _ => "TABLE",
        };
        try
        {
            return new DdlResult(Terminate(await DdlTextAsync(type, db, schema, obj.Name, null, ct).ConfigureAwait(false)), "stored");
        }
        catch (SnowflakeQueryException ex) when (type == "TABLE" && !ex.IsNotFoundOrDenied)
        {
            // GET_DDL refused (e.g. a share without the privilege): generate it from DESCRIBE.
            var details = await GetObjectDetailsAsync(obj with { Database = db, Schema = schema }, ct).ConfigureAwait(false);
            return new DdlResult(new SnowflakeDdlGenerator().GenerateTableDdl(obj with { Database = db, Schema = schema }, details), "generated");
        }
        catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
        {
            throw EngineException.NotFound($"{obj.Type} {schema}.{obj.Name}");
        }
    }

    internal async Task<string> DdlTextAsync(string type, string db, string schema, string name, IReadOnlyList<string>? args, CancellationToken ct)
    {
        var rs = await Gateway.QueryAsync(SnowflakeSql.GetDdl(type, db, schema, name, args), ct).ConfigureAwait(false);
        return rs.Rows.Count == 0 ? "" : SqlCells.Str(rs.Rows[0][0]) ?? "";
    }

    private static string Terminate(string ddl)
    {
        var t = ddl.TrimEnd();
        return t.EndsWith(';') ? t + "\n" : t + ";\n";
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);
}
