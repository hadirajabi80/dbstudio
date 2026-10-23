using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Dependencies and the Objects tab for Snowflake.
/// <list type="bullet">
/// <item>Foreign keys (informational in Snowflake, but declared): SHOW IMPORTED / EXPORTED KEYS IN TABLE.</item>
/// <item>View references: the view texts of the schema (SHOW VIEWS, no warehouse) are scanned for the object's name; a
/// view's own text gives what it uses.</item>
/// <item>Cross-schema and routine references: <c>SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES</c> when the role may read it
/// (IMPORTED PRIVILEGES on the SNOWFLAKE database, a warehouse; up to three hours of latency); silently skipped
/// otherwise, with <see cref="AccountUsageNote"/> recorded.</item>
/// </list>
/// Object list: SHOW TABLES / VIEWS / USER PROCEDURES / USER FUNCTIONS / SEQUENCES with rows, bytes and created_on.
/// </summary>
public sealed class SnowflakeDependencyReader(SnowflakeCatalogReader catalog) : IDependencyReader, IObjectListReader
{
    public const string ObjectDependenciesSql =
        "SELECT REFERENCED_DATABASE, REFERENCED_SCHEMA, REFERENCED_OBJECT_NAME, REFERENCED_OBJECT_DOMAIN, " +
        "REFERENCING_DATABASE, REFERENCING_SCHEMA, REFERENCING_OBJECT_NAME, REFERENCING_OBJECT_DOMAIN, DEPENDENCY_TYPE " +
        "FROM SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES " +
        "WHERE (REFERENCED_DATABASE = :1 AND REFERENCED_SCHEMA = :2 AND REFERENCED_OBJECT_NAME = :3) " +
        "OR (REFERENCING_DATABASE = :1 AND REFERENCING_SCHEMA = :2 AND REFERENCING_OBJECT_NAME = :3) LIMIT 500";

    /// <summary>Why ACCOUNT_USAGE was not used for the last graph (null when it was).</summary>
    public string? AccountUsageNote { get; private set; }

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? catalog.ProfileSchema;
        var root = obj with { Database = db, Schema = schema };
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();

        if (obj.Type == ObjectTypes.Table)
        {
            var imported = await catalog.TryShowAsync(SnowflakeSql.ShowImportedKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
            var exported = await catalog.TryShowAsync(SnowflakeSql.ShowExportedKeysIn(db, schema, obj.Name), ct).ConfigureAwait(false);
            AddForeignKeys(db, imported, exported, uses, usedBy);
        }

        var tables = await catalog.TryShowAsync(SnowflakeSql.ShowTables(db, schema), ct).ConfigureAwait(false);
        var views = await catalog.TryShowAsync(SnowflakeSql.ShowViews(db, schema), ct).ConfigureAwait(false);
        AddViewReferences(root, tables, views, uses, usedBy);

        try
        {
            var deps = await catalog.Gateway.QueryAsync(ObjectDependenciesSql, [db, schema, obj.Name], ct).ConfigureAwait(false);
            AddAccountUsage(root, deps, uses, usedBy);
            AccountUsageNote = null;
        }
        catch (SnowflakeQueryException ex)
        {
            AccountUsageNote = ex.IsNoWarehouse
                ? "Cross-schema dependencies need a warehouse (SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES)."
                : "Cross-schema dependencies need IMPORTED PRIVILEGES on the SNOWFLAKE database (ACCOUNT_USAGE.OBJECT_DEPENDENCIES).";
        }
        return DependencyGraphs.Build(root, uses, usedBy);
    }

    public static void AddForeignKeys(string db, SqlRowSet imported, SqlRowSet exported, List<ObjectDependency> uses, List<ObjectDependency> usedBy)
    {
        foreach (var (_, _, fk) in SnowflakeCatalogReader.ForeignKeys(imported, outgoing: true))
            uses.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, fk.RefSchema, fk.RefTable, ObjectTypes.Table),
                DependencyGraphs.FkDetail(fk.Name, fk.Columns, fk.RefColumns), null));
        foreach (var (schema, table, fk) in SnowflakeCatalogReader.ForeignKeys(exported, outgoing: false))
            usedBy.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, schema, table, ObjectTypes.Table),
                DependencyGraphs.FkDetail(fk.Name, fk.Columns, fk.RefColumns), null));
    }

    /// <summary>Same-schema view references from the view texts (SHOW VIEWS "text").</summary>
    public static void AddViewReferences(ObjectRef root, SqlRowSet tables, SqlRowSet views, List<ObjectDependency> uses, List<ObjectDependency> usedBy)
    {
        var known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var r in tables.Rows) if (tables.Str(r, "name") is { } n) known[n] = ObjectTypes.Table;
        foreach (var r in views.Rows)
            if (views.Str(r, "name") is { } n) known[n] = SnowflakeCatalogReader.Flag(views, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View;

        foreach (var r in views.Rows)
        {
            var name = views.Str(r, "name");
            var text = views.Str(r, "text");
            if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(text)) continue;
            var refs = BodyReferences(text, root.Schema);
            var type = known.GetValueOrDefault(name, ObjectTypes.View);
            if (name.Equals(root.Name, StringComparison.Ordinal))
            {
                // Only same-schema names are resolved from the text (a qualifier may be a table alias); other schemas come
                // from ACCOUNT_USAGE.
                foreach (var (schema, n) in refs)
                {
                    if ((schema is null || schema.Equals(root.Schema, StringComparison.OrdinalIgnoreCase)) && known.TryGetValue(n, out var t))
                        uses.Add(new ObjectDependency(DependencyKinds.Uses, new ObjectRef(root.Database, root.Schema, Canonical(known, n), t), null, null));
                }
            }
            else if (refs.Any(x => x.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase)
                                   && (x.Schema is null || x.Schema.Equals(root.Schema, StringComparison.OrdinalIgnoreCase))))
            {
                usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, new ObjectRef(root.Database, root.Schema, name, type), null, null));
            }
        }
    }

    private static string Canonical(Dictionary<string, string> known, string name) =>
        known.Keys.FirstOrDefault(k => k.Equals(name, StringComparison.OrdinalIgnoreCase)) ?? name;

    /// <summary>(schema, name) pairs referenced by a body (identifier chains; <c>db.s.t</c> gives (s, t)).</summary>
    public static List<(string? Schema, string Name)> BodyReferences(string body, string? defaultSchema)
    {
        _ = defaultSchema;
        return DependencyGraphs.ReferencedNames(body, Dialect.Snowflake)
            .Select(x => (x.Qualifier is null ? null : SnowflakeSql.Normalize(x.Qualifier), x.Name.StartsWith('"') ? x.Name : x.Name))
            .ToList();
    }

    public static void AddAccountUsage(ObjectRef root, SqlRowSet deps, List<ObjectDependency> uses, List<ObjectDependency> usedBy)
    {
        foreach (var r in deps.Rows)
        {
            var referencedName = deps.Str(r, "REFERENCED_OBJECT_NAME") ?? "";
            var referencingName = deps.Str(r, "REFERENCING_OBJECT_NAME") ?? "";
            var isReferenced = referencedName == root.Name && deps.Str(r, "REFERENCED_SCHEMA") == root.Schema;
            var kind = deps.Str(r, "DEPENDENCY_TYPE");
            if (isReferenced)
            {
                var o = new ObjectRef(deps.Str(r, "REFERENCING_DATABASE"), deps.Str(r, "REFERENCING_SCHEMA"), referencingName,
                    TypeOfDomain(deps.Str(r, "REFERENCING_OBJECT_DOMAIN")));
                usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, o, kind is null ? null : kind.ToLowerInvariant().Replace('_', ' '), null));
            }
            else if (referencingName == root.Name && deps.Str(r, "REFERENCING_SCHEMA") == root.Schema)
            {
                var o = new ObjectRef(deps.Str(r, "REFERENCED_DATABASE"), deps.Str(r, "REFERENCED_SCHEMA"), referencedName,
                    TypeOfDomain(deps.Str(r, "REFERENCED_OBJECT_DOMAIN")));
                uses.Add(new ObjectDependency(DependencyKinds.Uses, o, kind is null ? null : kind.ToLowerInvariant().Replace('_', ' '), null));
            }
        }
    }

    /// <summary>ACCOUNT_USAGE object domains ("TABLE", "VIEW", "MATERIALIZED VIEW", "FUNCTION", "PROCEDURE", "SEQUENCE", "STREAM" …).</summary>
    public static string TypeOfDomain(string? domain) => (domain ?? "").ToUpperInvariant() switch
    {
        "VIEW" or "SECURE VIEW" => ObjectTypes.View,
        "MATERIALIZED VIEW" => ObjectTypes.MView,
        "FUNCTION" or "EXTERNAL FUNCTION" => ObjectTypes.Func,
        "PROCEDURE" => ObjectTypes.Proc,
        "SEQUENCE" => ObjectTypes.Sequence,
        _ => ObjectTypes.Table,
    };

    // ------------------------------------------------------------------ object list

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var db = await catalog.DatabaseOrCurrentAsync(database, ct).ConfigureAwait(false);
        var scope = string.IsNullOrEmpty(schema) ? $"DATABASE {SnowflakeSql.AlwaysQuote(db)}" : $"SCHEMA {SnowflakeSql.SchemaPath(db, schema)}";
        bool Want(params string[] types) => type is null || types.Contains(type);
        var list = new List<ObjectListItem>();
        if (Want(ObjectTypes.Table))
            list.AddRange(Tables(await catalog.TryShowAsync($"SHOW TABLES IN {scope}", ct).ConfigureAwait(false), schema));
        if (Want(ObjectTypes.View, ObjectTypes.MView))
            list.AddRange(Views(await catalog.TryShowAsync($"SHOW VIEWS IN {scope}", ct).ConfigureAwait(false), schema).Where(i => type is null || i.Type == type));
        if (Want(ObjectTypes.Proc))
            list.AddRange(Routines(await catalog.TryShowAsync($"SHOW USER PROCEDURES IN {scope}", ct, $"SHOW PROCEDURES IN {scope}").ConfigureAwait(false), schema, true));
        if (Want(ObjectTypes.Func, ObjectTypes.TableFunc))
            list.AddRange(Routines(await catalog.TryShowAsync($"SHOW USER FUNCTIONS IN {scope}", ct).ConfigureAwait(false), schema, false).Where(i => type is null || i.Type == type));
        if (Want(ObjectTypes.Sequence))
            list.AddRange(Sequences(await catalog.TryShowAsync($"SHOW SEQUENCES IN {scope}", ct).ConfigureAwait(false), schema));
        return list.Where(i => !string.Equals(i.Schema, SnowflakeCatalogReader.InformationSchema, StringComparison.OrdinalIgnoreCase)).ToList();
    }

    private static string? SchemaOf(SqlRowSet rs, object?[] r, string? fallback) => rs.Str(r, "schema_name") ?? fallback;

    public static IEnumerable<ObjectListItem> Tables(SqlRowSet rs, string? schema) => rs.Rows.Select(r => new ObjectListItem(
        ObjectTypes.Table, SchemaOf(rs, r, schema), rs.Str(r, "name") ?? "", rs.Long(r, "rows"), rs.Long(r, "bytes"), null,
        SnowflakeCatalogReader.ParseTime(rs.Str(r, "created_on")), SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "comment"))));

    public static IEnumerable<ObjectListItem> Views(SqlRowSet rs, string? schema) => rs.Rows.Select(r => new ObjectListItem(
        SnowflakeCatalogReader.Flag(rs, r, "is_materialized") ? ObjectTypes.MView : ObjectTypes.View, SchemaOf(rs, r, schema), rs.Str(r, "name") ?? "",
        null, null, null, SnowflakeCatalogReader.ParseTime(rs.Str(r, "created_on")), SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "comment"))));

    public static IEnumerable<ObjectListItem> Routines(SqlRowSet rs, string? schema, bool procedures) => rs.Rows
        .Where(r => !SnowflakeCatalogReader.Flag(rs, r, "is_builtin"))
        .Select(r => new ObjectListItem(
            procedures ? ObjectTypes.Proc : SnowflakeCatalogReader.Flag(rs, r, "is_table_function") ? ObjectTypes.TableFunc : ObjectTypes.Func,
            SchemaOf(rs, r, schema), rs.Str(r, "name") ?? "", null, null, null, SnowflakeCatalogReader.ParseTime(rs.Str(r, "created_on")),
            rs.Str(r, "description") is "user-defined function" or "user-defined procedure" ? null : SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "description"))))
        .DistinctBy(i => (i.Type, i.Schema, i.Name));

    public static IEnumerable<ObjectListItem> Sequences(SqlRowSet rs, string? schema) => rs.Rows.Select(r => new ObjectListItem(
        ObjectTypes.Sequence, SchemaOf(rs, r, schema), rs.Str(r, "name") ?? "", null, null, null,
        SnowflakeCatalogReader.ParseTime(rs.Str(r, "created_on")), SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "comment"))));
}
