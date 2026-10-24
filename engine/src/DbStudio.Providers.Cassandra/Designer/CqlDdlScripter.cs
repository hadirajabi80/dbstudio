using System.Globalization;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Cassandra.Designer;

/// <summary>
/// CQL table designer (plan-batch3 WP-CS) on the generic table model. Cassandra concepts map onto it as follows (until the
/// designer gets CQL-specific panels, see docs/wp-notes/WP-CS.md):
/// <list type="bullet">
/// <item>primary key columns in order = partition key columns, then clustering columns;</item>
/// <item>a unique constraint named <c>partition_key</c> lists the partition key columns (default: the first key column);</item>
/// <item>an index named <c>clustering_order</c> gives the clustering order (DESC per column; default ASC);</item>
/// <item>a column whose comment is <c>static</c> is a STATIC column (Cassandra has no column comments);</item>
/// <item>check constraints are table options: name = option, expression = CQL value (<c>default_time_to_live</c> /
/// <c>86400</c>, <c>compaction</c> / <c>{'class': 'LeveledCompactionStrategy'}</c>); the table comment is <c>comment</c>;</item>
/// <item>other indexes are secondary indexes (SAI on Cassandra 5+); foreign keys and other unique constraints do not exist in
/// CQL and are ignored with a warning.</item>
/// </list>
/// DDL is not transactional. ALTER supports ADD/DROP columns, RENAME of key columns, WITH options and indexes; a changed
/// primary key, a renamed table or a changed column type cannot be altered and fail validation with an explanation.
/// </summary>
public sealed class CqlDdlScripter : IDdlScripter
{
    public const string PartitionKeyConstraint = "partition_key";
    public const string ClusteringOrderIndex = "clustering_order";

    public string ProviderId => CassandraProvider.ProviderId;

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("text", "none", "text", "string"),
        new("ascii", "none", "ascii", "string"),
        new("varchar", "none", "varchar", "string"),
        new("int", "none", "int", "number"),
        new("bigint", "none", "bigint", "number"),
        new("smallint", "none", "smallint", "number"),
        new("tinyint", "none", "tinyint", "number"),
        new("varint", "none", "varint", "number"),
        new("decimal", "none", "decimal", "number"),
        new("double", "none", "double", "number"),
        new("float", "none", "float", "number"),
        new("counter", "none", "counter", "number"),
        new("boolean", "none", "boolean", "other"),
        new("uuid", "none", "uuid", "other"),
        new("timeuuid", "none", "timeuuid", "other"),
        new("timestamp", "none", "timestamp", "date"),
        new("date", "none", "date", "date"),
        new("time", "none", "time", "date"),
        new("duration", "none", "duration", "date"),
        new("inet", "none", "inet", "other"),
        new("blob", "none", "blob", "binary"),
        new("list", "none", "list<text>", "other"),
        new("set", "none", "set<text>", "other"),
        new("map", "none", "map<text, text>", "other"),
        new("tuple", "none", "tuple<int, text>", "other"),
        new("frozen", "none", "frozen<list<text>>", "other"),
        new("vector", "none", "vector<float, 3>", "other"),
    ],
    new DesignerFeatures(Identity: false, Computed: false, ClusteredIndexes: false, IncludedColumns: false, FilteredIndexes: false,
        OnUpdateAction: false, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: false, Autoincrement: false, Schemas: true));

    /// <summary>The Cassandra shape of a model: partition key, clustering columns with order, static columns, options.</summary>
    public sealed record CqlShape(IReadOnlyList<string> Partition, IReadOnlyList<(string Name, bool Desc)> Clustering,
        IReadOnlySet<string> Static, IReadOnlyList<KeyValuePair<string, string>> Options);

    public static bool IsPartitionKeyConstraint(UniqueModel u) =>
        u.Name is { } n && Normalize(n) is "partition_key" or "partitionkey";

    public static bool IsClusteringOrderIndex(IndexModel i) => Normalize(i.Name) is "clustering_order" or "clusteringorder" || i.Clustered;

    private static string Normalize(string s) => s.Trim().Replace(' ', '_').ToLowerInvariant();

    public static CqlShape ShapeOf(TableModel t)
    {
        var pk = t.PrimaryKey?.Columns ?? [];
        if (pk.Count == 0) throw new ArgumentException("A Cassandra table needs a primary key (partition key, then clustering columns): mark at least one key column.");
        var declared = t.Uniques.FirstOrDefault(IsPartitionKeyConstraint)?.Columns;
        var partition = declared is { Count: > 0 } ? pk.Where(c => declared.Contains(c, StringComparer.OrdinalIgnoreCase)).ToList() : [pk[0]];
        if (declared is { Count: > 0 } && declared.Any(c => !pk.Contains(c, StringComparer.OrdinalIgnoreCase)))
            throw new ArgumentException("Every partition key column must also be a primary key column.");
        if (partition.Count == 0) partition = [pk[0]];
        var order = t.Indexes.FirstOrDefault(IsClusteringOrderIndex);
        var clustering = pk.Where(c => !partition.Contains(c, StringComparer.OrdinalIgnoreCase))
            .Select(c => (c, order?.Columns.FirstOrDefault(x => x.Name.Equals(c, StringComparison.OrdinalIgnoreCase))?.Desc ?? false)).ToList();
        var statics = t.Columns.Where(c => string.Equals(c.Comment?.Trim(), "static", StringComparison.OrdinalIgnoreCase))
            .Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (clustering.Count == 0 && statics.Count > 0) throw new ArgumentException("STATIC columns need clustering columns (a primary key with more than the partition key).");
        foreach (var s in statics)
            if (pk.Contains(s, StringComparer.OrdinalIgnoreCase)) throw new ArgumentException($"Key column '{s}' cannot be STATIC.");
        var options = new List<KeyValuePair<string, string>>();
        if (!string.IsNullOrWhiteSpace(t.Comment)) options.Add(new("comment", CqlText.Literal(t.Comment.Trim())));
        foreach (var ck in t.Checks)
        {
            var (name, value) = OptionOf(ck);
            if (name == "comment" && options.Any(o => o.Key == "comment")) continue;
            options.Add(new(name, value));
        }
        return new CqlShape(partition, clustering, statics, options);
    }

    /// <summary>A check constraint as a table option: (name, CQL value). "name = value" in the expression also works.</summary>
    public static (string Name, string Value) OptionOf(CheckModel ck)
    {
        var expr = ck.Expression.Trim();
        var name = ck.Name?.Trim();
        if (string.IsNullOrEmpty(name))
        {
            var eq = expr.IndexOf('=');
            if (eq <= 0) throw new ArgumentException($"Table option '{expr}' needs a name (check name = option, expression = value).");
            name = expr[..eq].Trim();
            expr = expr[(eq + 1)..].Trim();
        }
        if (!name.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_')) throw new ArgumentException($"'{name}' is not a table option name.");
        if (expr.Length == 0) throw new ArgumentException($"Table option '{name}' needs a value.");
        return (name.ToLowerInvariant(), expr);
    }

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        DesignerValidation.ValidateTable(desired, requireIndexNames: true);
        var keyspace = string.IsNullOrWhiteSpace(desired.Schema) ? original?.Schema ?? context.DefaultSchema : desired.Schema;
        if (string.IsNullOrWhiteSpace(keyspace)) throw new ArgumentException("Choose a keyspace for the table.");
        desired = desired with { Schema = keyspace };
        var warnings = new List<string>();
        if (desired.ForeignKeys.Count > 0) warnings.Add("Cassandra has no foreign keys; they are ignored (model relations with denormalised query tables).");
        if (desired.Uniques.Any(u => !IsPartitionKeyConstraint(u))) warnings.Add("Cassandra has no unique constraints; only \"partition_key\" is used (the partition key columns).");
        if (desired.Columns.Any(c => c.Default is not null || c.Identity is not null || c.Computed is not null || c.Autoincrement))
            warnings.Add("Cassandra columns have no defaults, identities or computed values; they are ignored.");
        if (desired.Columns.Any(c => !string.IsNullOrWhiteSpace(c.Comment) && !string.Equals(c.Comment.Trim(), "static", StringComparison.OrdinalIgnoreCase)))
            warnings.Add("Cassandra has no column comments (a column comment \"static\" makes the column STATIC); other comments are ignored.");

        var shape = ShapeOf(desired);
        var diff = TableDiff.Compute(original is null ? null : original with { Schema = original.Schema ?? keyspace }, desired);
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTableSql(desired, shape), DdlKinds.Create));
            foreach (var ix in desired.Indexes.Where(i => !IsClusteringOrderIndex(i)))
                statements.Add(new DdlStatement(CreateIndexSql(keyspace, desired.Name, ix, context), DdlKinds.Index));
            return new TableScript(statements, false, false, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, false, warnings, diff.Changes);
        ScriptAlter(original!, desired, shape, diff, context, statements, warnings);
        if (diff.ColumnsReordered) warnings.Add("Cassandra orders columns itself (key columns first, then by name); the order is not changed.");
        return new TableScript(statements, false, false, warnings, diff.Changes);
    }

    public static string CreateTableSql(TableModel t, CqlShape shape)
    {
        var sb = new StringBuilder();
        sb.Append("CREATE TABLE ").Append(CqlText.Qualify(t.Schema, t.Name)).Append(" (\n");
        var lines = t.Columns.Select(c => $"    {CqlText.Quote(c.Name)} {c.Type.Trim()}{(shape.Static.Contains(c.Name) ? " STATIC" : "")}").ToList();
        lines.Add("    " + CqlDdl.PrimaryKeyText(shape.Partition, shape.Clustering.Select(c => c.Name).ToList()));
        sb.Append(string.Join(",\n", lines)).Append("\n)");
        var with = new List<string>();
        if (shape.Clustering.Any(c => c.Desc))
            with.Add("CLUSTERING ORDER BY (" + string.Join(", ", shape.Clustering.Select(c => $"{CqlText.Quote(c.Name)} {(c.Desc ? "DESC" : "ASC")}")) + ")");
        with.AddRange(shape.Options.Select(o => $"{o.Key} = {o.Value}"));
        if (with.Count > 0) sb.Append(" WITH ").Append(string.Join("\n    AND ", with));
        return sb.ToString();
    }

    /// <summary>Major version of a release version ("5.0.2" → 5); 0 when unknown.</summary>
    public static int Major(string? version) =>
        version is not null && int.TryParse(version.Split('.')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var m) ? m : 0;

    public static string CreateIndexSql(string keyspace, string table, IndexModel ix, DdlScriptContext context)
    {
        if (ix.Columns.Count != 1) throw new ArgumentException($"Index {ix.Name}: a Cassandra index covers exactly one column.");
        if (ix.Unique) throw new ArgumentException($"Index {ix.Name}: Cassandra has no unique indexes.");
        var col = CqlText.Quote(ix.Columns[0].Name);
        // keys(m) / values(m) / entries(m) / full(f) targets are kept in Filter (read back from system_schema.indexes).
        var target = ix.Filter is { } fn && fn.Trim().ToLowerInvariant() is "keys" or "values" or "entries" or "full"
            ? $"{fn.Trim().ToLowerInvariant()}({col})" : col;
        var sai = Major(context.ServerVersion) >= 5;
        return $"CREATE INDEX IF NOT EXISTS {CqlText.Quote(ix.Name)} ON {CqlText.Qualify(keyspace, table)} ({target})" + (sai ? " USING 'sai'" : "");
    }

    private static void ScriptAlter(TableModel original, TableModel desired, CqlShape shape, TableDiffResult d, DdlScriptContext context,
        List<DdlStatement> statements, List<string> warnings)
    {
        var keyspace = desired.Schema!;
        var table = CqlText.Qualify(original.Schema ?? keyspace, original.Name);
        if (!original.Name.Equals(desired.Name, StringComparison.Ordinal))
            throw new ArgumentException("Cassandra cannot rename a table: create the new table and copy the data (e.g. with Export/Import).");
        if (!string.Equals(original.Schema ?? keyspace, keyspace, StringComparison.Ordinal))
            throw new ArgumentException("Cassandra cannot move a table to another keyspace.");

        var oldShape = ShapeOf(original);
        var renames = d.Renames;
        string Renamed(string name) => renames.TryGetValue(name, out var n) ? n : name;
        var oldKey = oldShape.Partition.Select(Renamed).Concat(oldShape.Clustering.Select(c => Renamed(c.Name))).ToList();
        var newKey = shape.Partition.Concat(shape.Clustering.Select(c => c.Name)).ToList();
        if (!oldKey.SequenceEqual(newKey, StringComparer.OrdinalIgnoreCase) || oldShape.Partition.Count != shape.Partition.Count)
            throw new ArgumentException("The primary key of a Cassandra table cannot change (partition key, clustering columns): create a new table and copy the data.");
        if (!oldShape.Clustering.Select(c => c.Desc).SequenceEqual(shape.Clustering.Select(c => c.Desc)))
            throw new ArgumentException("The clustering order of a Cassandra table cannot change after creation.");

        foreach (var m in d.Matched)
        {
            if (m.TypeChanged)
                throw new ArgumentException($"Column '{m.Old.Name}': Cassandra cannot change a column's type ({m.Old.Type} → {m.New.Type}). Add a new column instead.");
            var wasStatic = oldShape.Static.Contains(m.Old.Name);
            if (wasStatic != shape.Static.Contains(m.New.Name))
                throw new ArgumentException($"Column '{m.New.Name}': STATIC cannot be added or removed after creation.");
        }
        foreach (var m in d.Renamed)
        {
            if (!newKey.Contains(m.New.Name, StringComparer.OrdinalIgnoreCase))
                throw new ArgumentException($"Column '{m.Old.Name}': Cassandra renames only primary key columns. Add a new column instead.");
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME {CqlText.Quote(m.Old.Name)} TO {CqlText.Quote(m.New.Name)}", DdlKinds.Rename));
        }
        foreach (var c in d.Dropped)
        {
            if (oldKey.Contains(c.Name, StringComparer.OrdinalIgnoreCase)) throw new ArgumentException($"Primary key column '{c.Name}' cannot be dropped.");
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP {CqlText.Quote(c.Name)}", DdlKinds.Drop,
                "Dropping a column removes its data from every row (the space is reclaimed by compaction)."));
        }
        foreach (var c in d.Added)
        {
            if (newKey.Contains(c.Name, StringComparer.OrdinalIgnoreCase)) throw new ArgumentException($"Column '{c.Name}' cannot be added to the primary key.");
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {CqlText.Quote(c.Name)} {c.Type.Trim()}{(shape.Static.Contains(c.Name) ? " STATIC" : "")}", DdlKinds.Alter));
        }

        // Options: changed or new ones are set; removed ones go back to the server default where one is known.
        var before = oldShape.Options.ToDictionary(o => o.Key, o => o.Value, StringComparer.Ordinal);
        var after = shape.Options.ToDictionary(o => o.Key, o => o.Value, StringComparer.Ordinal);
        var set = new List<string>();
        foreach (var (k, v) in after)
            if (!before.TryGetValue(k, out var old) || !SameValue(old, v)) set.Add($"{k} = {v}");
        foreach (var k in before.Keys.Where(k => !after.ContainsKey(k)))
        {
            if (DefaultOptions.TryGetValue(k, out var def)) set.Add($"{k} = {def}");
            else warnings.Add($"Option {k} was removed from the model but has no known default; it keeps its value.");
        }
        if (set.Count > 0) statements.Add(new DdlStatement($"ALTER TABLE {table} WITH {string.Join("\n    AND ", set)}", DdlKinds.Alter));

        foreach (var ix in d.IndexesDropped.Where(i => !IsClusteringOrderIndex(i)))
            statements.Add(new DdlStatement($"DROP INDEX IF EXISTS {CqlText.Qualify(keyspace, ix.Name)}", DdlKinds.Drop));
        foreach (var ix in d.IndexesAdded.Where(i => !IsClusteringOrderIndex(i)))
            statements.Add(new DdlStatement(CreateIndexSql(keyspace, desired.Name, ix, context), DdlKinds.Index));
    }

    private static bool SameValue(string a, string b) =>
        string.Equals(string.Join(' ', a.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)),
            string.Join(' ', b.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)), StringComparison.Ordinal);

    /// <summary>Server defaults of the common table options (Cassandra 4/5), used when an option is removed from the model.</summary>
    public static readonly IReadOnlyDictionary<string, string> DefaultOptions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["comment"] = "''",
        ["default_time_to_live"] = "0",
        ["gc_grace_seconds"] = "864000",
        ["bloom_filter_fp_chance"] = "0.01",
        ["crc_check_chance"] = "1.0",
        ["memtable_flush_period_in_ms"] = "0",
        ["min_index_interval"] = "128",
        ["max_index_interval"] = "2048",
        ["speculative_retry"] = "'99p'",
        ["additional_write_policy"] = "'99p'",
        ["read_repair"] = "'BLOCKING'",
        ["caching"] = "{'keys': 'ALL', 'rows_per_partition': 'NONE'}",
        ["compaction"] = "{'class': 'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy', 'max_threshold': '32', 'min_threshold': '4'}",
        ["compression"] = "{'chunk_length_in_kb': '16', 'class': 'org.apache.cassandra.io.compress.LZ4Compressor'}",
        ["cdc"] = "false",
        ["allow_auto_snapshot"] = "true",
        ["incremental_backups"] = "true",
        ["memtable"] = "'default'",
    };

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var keyspace = string.IsNullOrWhiteSpace(view.Schema) ? context.DefaultSchema : view.Schema;
        var body = view.Body.Trim().TrimEnd(';').Trim();
        if (body.Length == 0) throw new ArgumentException("The view needs a body: SELECT … FROM … WHERE … IS NOT NULL PRIMARY KEY (…).");
        var statements = new List<DdlStatement>();
        var warnings = new List<string> { "Materialized views are experimental in Cassandra and must be enabled on the server (materialized_views_enabled)." };
        if (view.OriginalName is { } original)
            statements.Add(new DdlStatement($"DROP MATERIALIZED VIEW IF EXISTS {CqlText.Qualify(keyspace, original)}", DdlKinds.Drop,
                "A materialized view cannot be altered: it is dropped and rebuilt from the base table."));
        statements.Add(new DdlStatement($"CREATE MATERIALIZED VIEW {CqlText.Qualify(keyspace, view.Name)} AS\n{body}", DdlKinds.Create));
        return new DdlScript(statements, view.OriginalName is not null, false, warnings);
    }
}
