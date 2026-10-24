using System.Collections;
using System.Globalization;
using Cassandra;

namespace DbStudio.Providers.Cassandra;

// system_schema model (Cassandra 3.0+, ScyllaDB): keyspaces, tables, materialized views, columns, UDTs, functions,
// aggregates, secondary indexes and triggers of one keyspace, read with SELECT * so that version-specific columns
// (Cassandra 3/4/5, ScyllaDB, DSE) are optional.

/// <param name="Kind">partition_key | clustering | regular | static.</param>
/// <param name="Position">Position within the partition/clustering key; -1 otherwise.</param>
/// <param name="ClusteringOrder">asc | desc | none.</param>
public sealed record CqlColumnMeta(string Name, string Type, string Kind, int Position, string ClusteringOrder)
{
    public bool IsPartitionKey => Kind == "partition_key";
    public bool IsClustering => Kind == "clustering";
    public bool IsKey => IsPartitionKey || IsClustering;
    public bool IsStatic => Kind == "static";
    public bool Desc => ClusteringOrder == "desc";
}

public sealed class CqlTableMeta
{
    public required string Keyspace { get; init; }
    public required string Name { get; init; }
    public bool IsView { get; init; }
    public string? BaseTable { get; init; }
    public string? WhereClause { get; init; }
    public bool IncludeAllColumns { get; init; }
    public List<CqlColumnMeta> Columns { get; init; } = [];
    /// <summary>WITH options as CQL literals, in DESCRIBE order.</summary>
    public List<KeyValuePair<string, string>> Options { get; init; } = [];
    public string? Comment { get; init; }
    public IReadOnlySet<string> Flags { get; init; } = new HashSet<string>();
    public Guid? Id { get; init; }

    public IReadOnlyList<CqlColumnMeta> PartitionKey => Columns.Where(c => c.IsPartitionKey).OrderBy(c => c.Position).ToList();
    public IReadOnlyList<CqlColumnMeta> Clustering => Columns.Where(c => c.IsClustering).OrderBy(c => c.Position).ToList();
    public IReadOnlyList<CqlColumnMeta> PrimaryKey => [.. PartitionKey, .. Clustering];
    public bool IsCounter => Flags.Contains("counter") || Columns.Any(c => c.Type == "counter");
    public bool IsCompactStorage => Flags.Contains("dense") || (Flags.Count > 0 && !Flags.Contains("compound"));

    public string? Option(string name) => Options.FirstOrDefault(o => o.Key == name).Value;

    /// <summary>Key columns first (partition, clustering), then static and regular columns by name (DESCRIBE order).</summary>
    public IReadOnlyList<CqlColumnMeta> OrderedColumns =>
        [.. PrimaryKey, .. Columns.Where(c => !c.IsKey).OrderBy(c => c.IsStatic ? 0 : 1).ThenBy(c => c.Name, StringComparer.Ordinal)];
}

public sealed record CqlTypeMeta(string Keyspace, string Name, IReadOnlyList<(string Name, string Type)> Fields);

public sealed record CqlFunctionMeta(string Keyspace, string Name, IReadOnlyList<string> ArgumentNames, IReadOnlyList<string> ArgumentTypes,
    string ReturnType, string Language, string Body, bool CalledOnNullInput, bool Deterministic, bool Monotonic)
{
    public string Signature => $"{Name}({string.Join(", ", ArgumentTypes)})";
}

public sealed record CqlAggregateMeta(string Keyspace, string Name, IReadOnlyList<string> ArgumentTypes, string StateFunction, string StateType,
    string? FinalFunction, string? InitCond, string ReturnType, bool Deterministic)
{
    public string Signature => $"{Name}({string.Join(", ", ArgumentTypes)})";
}

public sealed record CqlIndexMeta(string Keyspace, string Table, string Name, string Kind, IReadOnlyDictionary<string, string> Options)
{
    public string? Target => Options.GetValueOrDefault("target");
    public string? ClassName => Options.GetValueOrDefault("class_name");
    public bool IsSai => ClassName is { } c && (c.EndsWith("StorageAttachedIndex", StringComparison.Ordinal) || c.Equals("sai", StringComparison.OrdinalIgnoreCase));
}

public sealed record CqlTriggerMeta(string Keyspace, string Table, string Name, IReadOnlyDictionary<string, string> Options);

public sealed class CqlKeyspaceMeta
{
    public required string Name { get; init; }
    public bool DurableWrites { get; init; } = true;
    public IReadOnlyDictionary<string, string> Replication { get; init; } = new Dictionary<string, string>();
    public List<CqlTableMeta> Tables { get; init; } = [];
    public List<CqlTableMeta> Views { get; init; } = [];
    public List<CqlTypeMeta> Types { get; init; } = [];
    public List<CqlFunctionMeta> Functions { get; init; } = [];
    public List<CqlAggregateMeta> Aggregates { get; init; } = [];
    public List<CqlIndexMeta> Indexes { get; init; } = [];
    public List<CqlTriggerMeta> Triggers { get; init; } = [];

    public CqlTableMeta? Table(string name) =>
        Tables.FirstOrDefault(t => t.Name == name) ?? Views.FirstOrDefault(t => t.Name == name)
        ?? Tables.FirstOrDefault(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
        ?? Views.FirstOrDefault(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
}

/// <summary>Reads the system_schema tables over a (catalog) session.</summary>
public sealed class CqlSchemaReader(ISession session)
{
    /// <summary>Keyspaces Cassandra / ScyllaDB / DSE create for themselves.</summary>
    public static readonly IReadOnlySet<string> SystemKeyspaces = new HashSet<string>(StringComparer.Ordinal)
    {
        "system", "system_schema", "system_auth", "system_distributed", "system_traces", "system_views", "system_virtual_schema",
        "system_distributed_everywhere", "system_replicated_keys", "system_cluster_metadata", "system_auth_v2",
        "dse_system", "dse_security", "dse_perf", "dse_leases", "dse_insights", "dse_insights_local", "dse_system_local", "solr_admin",
        "OpsCenter", "dse_analytics", "cfs", "cfs_archive", "HiveMetaStore", "spark_system",
    };

    public static bool IsSystem(string keyspace) => SystemKeyspaces.Contains(keyspace);

    public ISession Session { get; } = session;

    private async Task<IReadOnlyList<Row>> RowsAsync(string cql, params object[] values)
    {
        var stmt = new SimpleStatement(cql, values).SetPageSize(5000);
        var rs = await Session.ExecuteAsync(stmt).ConfigureAwait(false);
        return rs.ToList(); // auto paging
    }

    public async Task<IReadOnlyList<(string Name, bool DurableWrites, IReadOnlyDictionary<string, string> Replication)>> KeyspacesAsync()
    {
        var rows = await RowsAsync("SELECT * FROM system_schema.keyspaces").ConfigureAwait(false);
        return rows.Select(r => (Str(r, "keyspace_name") ?? "", Bool(r, "durable_writes") ?? true, Map(r, "replication")))
            .Where(k => k.Item1.Length > 0).OrderBy(k => k.Item1, StringComparer.Ordinal).ToList();
    }

    /// <summary>Table and view names with their type, per keyspace (cheap counts for the explorer).</summary>
    public async Task<Dictionary<string, int>> ObjectCountsAsync()
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var table in new[] { "tables", "views", "types", "functions", "aggregates" })
        {
            IReadOnlyList<Row> rows;
            try { rows = await RowsAsync($"SELECT keyspace_name FROM system_schema.{table}").ConfigureAwait(false); }
            catch (InvalidQueryException) { continue; }
            foreach (var r in rows)
            {
                var ks = Str(r, "keyspace_name");
                if (ks is null) continue;
                counts[ks] = counts.GetValueOrDefault(ks) + 1;
            }
        }
        return counts;
    }

    public async Task<CqlKeyspaceMeta?> LoadKeyspaceAsync(string keyspace)
    {
        var ksRows = await RowsAsync("SELECT * FROM system_schema.keyspaces WHERE keyspace_name = ?", keyspace).ConfigureAwait(false);
        if (ksRows.Count == 0) return null;
        var ksRow = ksRows[0];
        var columnRows = await RowsAsync("SELECT * FROM system_schema.columns WHERE keyspace_name = ?", keyspace).ConfigureAwait(false);
        var columns = columnRows.GroupBy(r => Str(r, "table_name") ?? "", StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(r => new CqlColumnMeta(
                Str(r, "column_name") ?? "", Str(r, "type") ?? "", Str(r, "kind") ?? "regular", Int(r, "position") ?? -1,
                (Str(r, "clustering_order") ?? "none").ToLowerInvariant())).ToList(), StringComparer.Ordinal);

        var meta = new CqlKeyspaceMeta
        {
            Name = keyspace,
            DurableWrites = Bool(ksRow, "durable_writes") ?? true,
            Replication = Map(ksRow, "replication"),
        };

        foreach (var r in await RowsAsync("SELECT * FROM system_schema.tables WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
        {
            var name = Str(r, "table_name") ?? "";
            meta.Tables.Add(new CqlTableMeta
            {
                Keyspace = keyspace,
                Name = name,
                Columns = columns.GetValueOrDefault(name) ?? [],
                Options = Options(r, isView: false),
                Comment = Str(r, "comment"),
                Flags = Set(r, "flags"),
                Id = Uuid(r, "id"),
            });
        }
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.views WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
        {
            var name = Str(r, "view_name") ?? "";
            meta.Views.Add(new CqlTableMeta
            {
                Keyspace = keyspace,
                Name = name,
                IsView = true,
                BaseTable = Str(r, "base_table_name"),
                WhereClause = Str(r, "where_clause"),
                IncludeAllColumns = Bool(r, "include_all_columns") ?? false,
                Columns = columns.GetValueOrDefault(name) ?? [],
                Options = Options(r, isView: true),
                Comment = Str(r, "comment"),
                Id = Uuid(r, "id"),
            });
        }
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.types WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
        {
            var names = List(r, "field_names");
            var types = List(r, "field_types");
            meta.Types.Add(new CqlTypeMeta(keyspace, Str(r, "type_name") ?? "",
                names.Select((n, i) => (n, i < types.Count ? types[i] : "")).ToList()));
        }
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.functions WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
        {
            meta.Functions.Add(new CqlFunctionMeta(keyspace, Str(r, "function_name") ?? "", List(r, "argument_names"), List(r, "argument_types"),
                Str(r, "return_type") ?? "", Str(r, "language") ?? "java", Str(r, "body") ?? "", Bool(r, "called_on_null_input") ?? false,
                Bool(r, "deterministic") ?? false, Bool(r, "monotonic") ?? false));
        }
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.aggregates WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
        {
            meta.Aggregates.Add(new CqlAggregateMeta(keyspace, Str(r, "aggregate_name") ?? "", List(r, "argument_types"), Str(r, "state_func") ?? "",
                Str(r, "state_type") ?? "", Str(r, "final_func"), Str(r, "initcond"), Str(r, "return_type") ?? "", Bool(r, "deterministic") ?? false));
        }
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.indexes WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
            meta.Indexes.Add(new CqlIndexMeta(keyspace, Str(r, "table_name") ?? "", Str(r, "index_name") ?? "", Str(r, "kind") ?? "COMPOSITES", Map(r, "options")));
        foreach (var r in await TryRowsAsync("SELECT * FROM system_schema.triggers WHERE keyspace_name = ?", keyspace).ConfigureAwait(false))
            meta.Triggers.Add(new CqlTriggerMeta(keyspace, Str(r, "table_name") ?? "", Str(r, "trigger_name") ?? "", Map(r, "options")));

        meta.Tables.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        meta.Views.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        meta.Types.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
        return meta;
    }

    private async Task<IReadOnlyList<Row>> TryRowsAsync(string cql, params object[] values)
    {
        try { return await RowsAsync(cql, values).ConfigureAwait(false); }
        catch (InvalidQueryException) { return []; } // table missing on this version
    }

    /// <summary>system.size_estimates of the node answering: (partitions, mean partition size) summed over the token ranges.</summary>
    public async Task<Dictionary<string, (long Partitions, long MeanSize)>> SizeEstimatesAsync(string keyspace)
    {
        var result = new Dictionary<string, (long, long)>(StringComparer.Ordinal);
        IReadOnlyList<Row> rows;
        try { rows = await RowsAsync("SELECT table_name, partitions_count, mean_partition_size FROM system.size_estimates WHERE keyspace_name = ?", keyspace).ConfigureAwait(false); }
        catch (Exception ex) when (ex is InvalidQueryException or UnauthorizedException) { return result; }
        foreach (var g in rows.GroupBy(r => Str(r, "table_name") ?? "", StringComparer.Ordinal))
        {
            long partitions = 0, weighted = 0;
            foreach (var r in g)
            {
                var p = Long(r, "partitions_count") ?? 0;
                partitions += p;
                weighted += p * (Long(r, "mean_partition_size") ?? 0);
            }
            result[g.Key] = (partitions, partitions > 0 ? weighted / partitions : 0);
        }
        return result;
    }

    // ------------------------------------------------------------------ table options

    /// <summary>Options in DESCRIBE order; values are CQL literals.</summary>
    private static readonly string[] OptionOrder =
    [
        "additional_write_policy", "allow_auto_snapshot", "bloom_filter_fp_chance", "caching", "cdc", "comment", "compaction", "compression",
        "memtable", "crc_check_chance", "dclocal_read_repair_chance", "default_time_to_live", "extensions", "gc_grace_seconds",
        "incremental_backups", "max_index_interval", "memtable_flush_period_in_ms", "min_index_interval", "read_repair",
        "read_repair_chance", "speculative_retry", "paxos_grace_seconds", "tombstone_gc",
    ];

    private static List<KeyValuePair<string, string>> Options(Row r, bool isView)
    {
        var list = new List<KeyValuePair<string, string>>();
        foreach (var name in OptionOrder)
        {
            if (isView && name == "default_time_to_live") continue;
            if (!Has(r, name) || r.IsNull(name)) continue;
            var value = r.GetValue<object>(name);
            var literal = OptionLiteral(value);
            if (literal is null) continue;
            if (name == "extensions" && literal == "{}") continue;
            list.Add(new(name, literal));
        }
        return list;
    }

    public static string? OptionLiteral(object? value) => value switch
    {
        null => null,
        string s => CqlText.Literal(s),
        bool b => b ? "true" : "false",
        double d => d.ToString("0.0###############", CultureInfo.InvariantCulture),
        float f => ((double)f).ToString("0.0###############", CultureInfo.InvariantCulture),
        int or long or short => Convert.ToString(value, CultureInfo.InvariantCulture),
        IDictionary<string, string> m => "{" + string.Join(", ", m.OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => CqlText.Literal(kv.Key) + ": " + CqlText.Literal(kv.Value))) + "}",
        IDictionary<string, byte[]> ext => ext.Count == 0 ? "{}" : "{" + string.Join(", ", ext.Select(kv => CqlText.Literal(kv.Key) + ": 0x" + Convert.ToHexString(kv.Value).ToLowerInvariant())) + "}",
        _ => null,
    };

    // ------------------------------------------------------------------ row helpers

    /// <summary>The row has this column (system tables differ between versions).</summary>
    public static bool Has(Row r, string c) => r.GetColumn(c) is not null;

    public static string? Str(Row r, string c) => Has(r, c) && !r.IsNull(c) ? Convert.ToString(r.GetValue<object>(c), CultureInfo.InvariantCulture) : null;
    public static bool? Bool(Row r, string c) => Has(r, c) && !r.IsNull(c) && r.GetValue<object>(c) is bool b ? b : null;
    public static int? Int(Row r, string c) => Has(r, c) && !r.IsNull(c) ? Convert.ToInt32(r.GetValue<object>(c), CultureInfo.InvariantCulture) : null;
    public static long? Long(Row r, string c) => Has(r, c) && !r.IsNull(c) ? Convert.ToInt64(r.GetValue<object>(c), CultureInfo.InvariantCulture) : null;
    public static Guid? Uuid(Row r, string c) => Has(r, c) && !r.IsNull(c) && r.GetValue<object>(c) is Guid g ? g : null;

    public static IReadOnlyDictionary<string, string> Map(Row r, string c)
    {
        if (!Has(r, c) || r.IsNull(c)) return new Dictionary<string, string>();
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (r.GetValue<object>(c) is IDictionary d)
            foreach (DictionaryEntry e in d) result[e.Key.ToString() ?? ""] = e.Value?.ToString() ?? "";
        return result;
    }

    public static IReadOnlyList<string> List(Row r, string c)
    {
        if (!Has(r, c) || r.IsNull(c)) return [];
        return r.GetValue<object>(c) is IEnumerable e and not string ? e.Cast<object?>().Select(x => x?.ToString() ?? "").ToList() : [];
    }

    public static IReadOnlySet<string> Set(Row r, string c) => new HashSet<string>(List(r, c), StringComparer.Ordinal);
}
