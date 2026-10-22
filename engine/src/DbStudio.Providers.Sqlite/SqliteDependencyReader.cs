using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// Object browser for SQLite (WP3). FKs come from <c>PRAGMA foreign_key_list</c> (through the catalog reader); SQLite does
/// not record dependencies of views and triggers, so their <c>sqlite_master.sql</c> is tokenized and the identifiers are
/// matched against the names of the schema's tables and views. Schemas are the attached databases.
/// </summary>
public sealed partial class SqliteDependencyReader(SqliteConnection connection) : IDependencyReader, IObjectListReader
{
    /// <summary>Tables up to this many rows are counted exactly; bigger ones show max(rowid) as an estimate.</summary>
    public const int CountLimit = 100_000;
    /// <summary>Above this many tables, row counts are skipped (the list must stay instant).</summary>
    public const int CountTablesMax = 200;

    private readonly SqliteCatalogReader _catalog = new(connection, new SqliteDdlGenerator());

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    private sealed record Master(string Type, string Name, string Table, string? Sql)
    {
        public bool IsVirtual => Sql is not null && Sql.TrimStart().StartsWith("CREATE VIRTUAL", StringComparison.OrdinalIgnoreCase);
        public bool WithoutRowId => Sql is not null && Regex.IsMatch(Sql, @"WITHOUT\s+ROWID", RegexOptions.IgnoreCase);
    }

    private static readonly string[] ShadowSuffixes = ["_data", "_idx", "_content", "_docsize", "_config", "_segments", "_segdir", "_stat", "_node", "_parent", "_rowid"];

    private static bool IsShadow(Master m, List<Master> all) =>
        m.Type == "table" && ShadowSuffixes.Any(s => m.Name.EndsWith(s, StringComparison.OrdinalIgnoreCase)
            && all.Any(v => v.IsVirtual && v.Name.Equals(m.Name[..^s.Length], StringComparison.OrdinalIgnoreCase)));

    private async Task<string> SchemaAsync(string? schema, CancellationToken ct)
    {
        var want = schema ?? SqliteCatalogReader.MainSchema;
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "PRAGMA database_list";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var name = r.GetString(1);
            if (!name.Equals("temp", StringComparison.OrdinalIgnoreCase) && name.Equals(want, StringComparison.OrdinalIgnoreCase)) return name;
        }
        throw EngineException.NotFound($"Schema (attached database) '{want}'");
    }

    private async Task<List<string>> SchemasAsync(CancellationToken ct)
    {
        var list = new List<string>();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "PRAGMA database_list";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var name = r.GetString(1);
            if (!name.Equals("temp", StringComparison.OrdinalIgnoreCase)) list.Add(name);
        }
        return list;
    }

    private async Task<List<Master>> MastersAsync(string schema, CancellationToken ct)
    {
        var rows = new List<Master>();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT type, name, tbl_name, sql FROM {SqliteNames.Quote(schema)}.sqlite_master " +
                          "WHERE type IN ('table','view','trigger','index') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            rows.Add(new Master(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3)));
        return rows;
    }

    private static string TypeOf(Master m) => m.Type switch { "view" => ObjectTypes.View, "trigger" => ObjectTypes.Trigger, _ => ObjectTypes.Table };

    [GeneratedRegex(@"\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(.+?)\s+ON\s", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex TriggerTimingRegex();

    internal static string TriggerTiming(string? sql)
    {
        var m = sql is null ? null : TriggerTimingRegex().Match(sql);
        if (m is null || !m.Success) return "";
        return Regex.Replace($"{m.Groups[1].Value} {m.Groups[2].Value}", @"\s+", " ").ToUpperInvariant();
    }

    /// <summary>Names (tables/views of <paramref name="byName"/>) referenced by a view or trigger body.</summary>
    private static IEnumerable<Master> Referenced(Master body, string schema, Dictionary<string, Master> byName)
    {
        foreach (var (qualifier, name) in DependencyGraphs.ReferencedNames(body.Sql, Dialect.Sqlite).Distinct())
        {
            // alias.column, NEW.column, other_db.table: not an object of this schema.
            if (qualifier is not null && !qualifier.Equals(schema, StringComparison.OrdinalIgnoreCase)) continue;
            if (byName.TryGetValue(name, out var m) && !m.Name.Equals(body.Name, StringComparison.OrdinalIgnoreCase)) yield return m;
        }
    }

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        var schema = await SchemaAsync(obj.Schema, ct).ConfigureAwait(false);
        var masters = (await MastersAsync(schema, ct).ConfigureAwait(false)).Where(m => m.Type != "index").ToList();
        var root = masters.FirstOrDefault(m => m.Name.Equals(obj.Name, StringComparison.OrdinalIgnoreCase))
                   ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var rootRef = new ObjectRef(null, schema, root.Name, TypeOf(root));
        var relations = masters.Where(m => m.Type is "table" or "view" && !IsShadow(m, masters))
            .GroupBy(m => m.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        ObjectRef Ref(Master m) => new(null, schema, m.Name, TypeOf(m));
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();

        if (root.Type == "table")
        {
            var catalog = await _catalog.LoadSchemaAsync(null, schema, ct).ConfigureAwait(false);
            foreach (var o in catalog.Objects.Where(o => o.Type == ObjectTypes.Table))
            {
                foreach (var fk in o.ForeignKeys)
                {
                    var detail = DependencyGraphs.FkDetail(fk.Name, fk.Columns, fk.RefColumns);
                    if (o.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase))
                        uses.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(null, fk.RefSchema ?? schema, fk.RefTable, ObjectTypes.Table), detail, null));
                    if (fk.RefTable.Equals(root.Name, StringComparison.OrdinalIgnoreCase)
                        && (fk.RefSchema is null || fk.RefSchema.Equals(schema, StringComparison.OrdinalIgnoreCase)))
                        usedBy.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(null, schema, o.Name, ObjectTypes.Table), detail, null));
                }
            }
        }

        var onRoot = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in masters.Where(m => m.Type == "trigger" && m.Table.Equals(root.Name, StringComparison.OrdinalIgnoreCase) && root.Type != "trigger"))
        {
            onRoot.Add(t.Name);
            usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(t), TriggerTiming(t.Sql), null));
        }
        if (root.Type == "trigger" && relations.TryGetValue(root.Table, out var parent))
            uses.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(parent), "fires on", null));

        if (root.Type is "view" or "trigger")
        {
            foreach (var m in Referenced(root, schema, relations))
            {
                if (root.Type == "trigger" && m.Name.Equals(root.Table, StringComparison.OrdinalIgnoreCase)) continue;
                uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(m), null, null));
            }
        }
        foreach (var body in masters.Where(m => m.Type is "view" or "trigger" && !onRoot.Contains(m.Name) && !m.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase)))
        {
            if (Referenced(body, schema, relations).Any(m => m.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase)))
                usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(body), body.Type == "trigger" ? $"on {body.Table}" : null, null));
        }
        return DependencyGraphs.Build(rootRef, uses, usedBy);
    }

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var schemas = schema is null ? await SchemasAsync(ct).ConfigureAwait(false) : [await SchemaAsync(schema, ct).ConfigureAwait(false)];
        var list = new List<ObjectListItem>();
        foreach (var s in schemas)
        {
            var masters = await MastersAsync(s, ct).ConfigureAwait(false);
            var sizes = await SizesAsync(s, masters, ct).ConfigureAwait(false);
            var objects = masters.Where(m => m.Type != "index" && !IsShadow(m, masters) && (type is null || TypeOf(m) == type)).ToList();
            var tables = objects.Count(m => m.Type == "table");
            foreach (var m in objects)
            {
                long? rows = m.Type == "table" && tables <= CountTablesMax ? await CountAsync(s, m, ct).ConfigureAwait(false) : null;
                var comment = m.Type == "trigger" ? $"on {m.Table}" : m.IsVirtual ? "virtual table" : null;
                list.Add(new ObjectListItem(TypeOf(m), s, m.Name, rows, sizes.TryGetValue(m.Name, out var b) ? b : null, null, null, comment));
            }
        }
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return list;
    }

    private async Task<long?> CountAsync(string schema, Master table, CancellationToken ct)
    {
        if (table.IsVirtual) return null;
        try
        {
            await using var cmd = connection.CreateCommand();
            var q = $"{SqliteNames.Quote(schema)}.{SqliteNames.Quote(table.Name)}";
            cmd.CommandText = $"SELECT count(*) FROM (SELECT 1 FROM {q} LIMIT {CountLimit + 1})";
            var n = Convert.ToInt64(await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false));
            if (n <= CountLimit || table.WithoutRowId) return n;
            cmd.CommandText = $"SELECT max(_rowid_) FROM {q}";
            var max = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
            return max is null or DBNull ? n : Math.Max(n, Convert.ToInt64(max));
        }
        catch (DbException)
        {
            return null;
        }
    }

    /// <summary>Bytes per table (its indexes included) from the dbstat virtual table, when the build has it.</summary>
    private async Task<Dictionary<string, long>> SizesAsync(string schema, List<Master> masters, CancellationToken ct)
    {
        var result = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        var owner = masters.Where(m => m.Type == "index").ToDictionary(m => m.Name, m => m.Table, StringComparer.OrdinalIgnoreCase);
        try
        {
            await using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT name, sum(pgsize) FROM dbstat($schema) GROUP BY name";
            cmd.Parameters.AddWithValue("$schema", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var name = r.GetString(0);
                var table = owner.GetValueOrDefault(name) ?? (name.StartsWith("sqlite_autoindex_", StringComparison.OrdinalIgnoreCase)
                    ? masters.FirstOrDefault(m => m.Type == "table" && name.StartsWith($"sqlite_autoindex_{m.Name}_", StringComparison.OrdinalIgnoreCase))?.Name ?? name
                    : name);
                result[table] = result.GetValueOrDefault(table) + r.GetInt64(1);
            }
        }
        catch (DbException)
        {
            // No dbstat in this SQLite build: sizes stay empty.
        }
        return result;
    }
}
