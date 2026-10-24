using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Catalog of a Cassandra connection (plan-batch3 WP-CS): keyspaces are the schemas (single-level, like Oracle); objects are
/// tables (<c>table</c>), materialized views (<c>mview</c>), UDTs (<c>type</c>) and functions/aggregates (<c>func</c>).
/// Columns carry their key role in the comment ("partition key", "partition key (1 of 2)", "clustering key ASC|DESC",
/// "static"); IsPk marks partition and clustering columns. Reads go over the cluster's shared catalog session.
/// </summary>
public sealed class CqlCatalogReader : ICatalogReader
{
    private readonly CqlClusterPool.Lease _lease;
    private readonly Dictionary<string, CqlKeyspaceMeta?> _keyspaces = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal CqlCatalogReader(CqlClusterPool.Lease lease, ISession session)
    {
        _lease = lease;
        Session = session;
        Schema = new CqlSchemaReader(session);
    }

    public ISession Session { get; }
    public CqlSchemaReader Schema { get; }
    public CqlConnectionSettings Settings => _lease.Settings;
    public ICluster Cluster => _lease.Cluster;

    public ValueTask DisposeAsync() => _lease.DisposeAsync();

    /// <summary>A keyspace's metadata (read once per reader).</summary>
    public async Task<CqlKeyspaceMeta?> KeyspaceAsync(string keyspace, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_keyspaces.TryGetValue(keyspace, out var cached)) return cached;
            var meta = await Schema.LoadKeyspaceAsync(keyspace).WaitAsync(ct).ConfigureAwait(false);
            _keyspaces[keyspace] = meta;
            return meta;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CqlKeyspaceMeta> RequireKeyspaceAsync(string? keyspace, CancellationToken ct)
    {
        var ks = keyspace ?? await GetDefaultSchemaAsync(null, ct).ConfigureAwait(false);
        return await KeyspaceAsync(ks, ct).ConfigureAwait(false) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Keyspace '{ks}'");
    }

    public Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    public Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => Task.FromResult(Settings.Keyspace);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        var keyspaces = await Schema.KeyspacesAsync().WaitAsync(ct).ConfigureAwait(false);
        var counts = await Schema.ObjectCountsAsync().WaitAsync(ct).ConfigureAwait(false);
        return keyspaces
            .Where(k => Settings.ShowSystemKeyspaces || !CqlSchemaReader.IsSystem(k.Name) || k.Name == Settings.Keyspace)
            .Select(k => new SchemaInfo(k.Name, counts.GetValueOrDefault(k.Name)))
            .ToList();
    }

    public async Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct)
    {
        var keyspaces = await Schema.KeyspacesAsync().WaitAsync(ct).ConfigureAwait(false);
        if (Settings.Keyspace is { } ks && keyspaces.Any(k => k.Name == ks)) return ks;
        return keyspaces.Select(k => k.Name).FirstOrDefault(n => !CqlSchemaReader.IsSystem(n)) ?? Settings.Keyspace ?? "system";
    }

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        var ks = await KeyspaceAsync(schema, ct).ConfigureAwait(false);
        if (ks is null) return new SchemaCatalog(null, schema, []);
        var objects = new List<CatalogObject>();
        foreach (var t in ks.Tables) objects.Add(TableObject(t, ObjectTypes.Table));
        foreach (var v in ks.Views) objects.Add(TableObject(v, ObjectTypes.MView));
        foreach (var u in ks.Types)
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Type,
                Name = u.Name,
                Schema = schema,
                Comment = "user-defined type",
                Columns = u.Fields.Select(f => new CatalogColumn(f.Name, f.Type, true, false)).ToList(),
            });
        foreach (var f in ks.Functions)
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Func,
                Name = f.Name,
                Schema = schema,
                Comment = $"function, {f.Language}",
                Parameters = [.. f.ArgumentNames.Select((n, i) => new ParamInfo(n, i < f.ArgumentTypes.Count ? f.ArgumentTypes[i] : "", "in", false)),
                    new ParamInfo("", f.ReturnType, "return", false)],
            });
        foreach (var a in ks.Aggregates)
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Func,
                Name = a.Name,
                Schema = schema,
                Comment = "aggregate",
                Parameters = [.. a.ArgumentTypes.Select((t, i) => new ParamInfo($"arg{i + 1}", t, "in", false)), new ParamInfo("", a.ReturnType, "return", false)],
            });
        return new SchemaCatalog(null, schema, objects);
    }

    internal static CatalogObject TableObject(CqlTableMeta t, string type) => new()
    {
        Type = type,
        Name = t.Name,
        Schema = t.Keyspace,
        Comment = string.IsNullOrEmpty(t.Comment) ? null : t.Comment,
        Columns = t.OrderedColumns.Select(c => new CatalogColumn(c.Name, c.Type, !c.IsKey, c.IsKey, 0, RoleComment(t, c))).ToList(),
        PrimaryKey = t.PrimaryKey.Select(c => c.Name).ToList(),
    };

    /// <summary>"partition key", "partition key (1 of 2)", "clustering key ASC|DESC", "static" or null.</summary>
    public static string? RoleComment(CqlTableMeta t, CqlColumnMeta c)
    {
        if (c.IsPartitionKey)
        {
            var n = t.PartitionKey.Count;
            return n == 1 ? "partition key" : $"partition key ({c.Position + 1} of {n})";
        }
        if (c.IsClustering) return c.Desc ? "clustering key DESC" : "clustering key ASC";
        return c.IsStatic ? "static" : null;
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        var ks = await RequireKeyspaceAsync(obj.Schema, ct).ConfigureAwait(false);
        if (obj.Type == ObjectTypes.Type)
        {
            var u = ks.Types.FirstOrDefault(x => x.Name == obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Type '{obj.Name}'");
            return new ObjectDetails(obj with { Schema = ks.Name },
                u.Fields.Select((f, i) => new ColumnDetail(f.Name, f.Type, true, null, false, false, false, null, i + 1)).ToList(),
                [], [], [], [], [], null, null, null);
        }
        if (obj.Type is ObjectTypes.Func or ObjectTypes.Proc)
        {
            var f = ks.Functions.FirstOrDefault(x => x.Name == obj.Name);
            var parameters = f is not null
                ? [.. f.ArgumentNames.Select((n, i) => new ParamInfo(n, i < f.ArgumentTypes.Count ? f.ArgumentTypes[i] : "", "in", false)), new ParamInfo("", f.ReturnType, "return", false)]
                : ks.Aggregates.FirstOrDefault(x => x.Name == obj.Name) is { } a
                    ? a.ArgumentTypes.Select((t, i) => new ParamInfo($"arg{i + 1}", t, "in", false)).Append(new ParamInfo("", a.ReturnType, "return", false)).ToList()
                    : throw DbStudio.Core.Services.EngineException.NotFound($"Function '{obj.Name}'");
            return new ObjectDetails(obj with { Schema = ks.Name }, [], [], [], [], [], parameters, null, null, null);
        }

        var t = ks.Table(obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Table '{obj.Schema}.{obj.Name}'");
        var ordinal = 0;
        var columns = t.OrderedColumns.Select(c => new ColumnDetail(c.Name, c.Type, !c.IsKey, null, c.IsKey, false, false, RoleComment(t, c), ++ordinal)).ToList();
        var indexes = new List<IndexDetail>
        {
            new("PRIMARY KEY", true, t.PrimaryKey.Select(c => c.Name).ToList(), CqlDdl.PrimaryKeyText(t), IsPrimaryKey: true),
        };
        foreach (var i in ks.Indexes.Where(i => i.Table == t.Name))
            indexes.Add(new IndexDetail(i.Name, false, i.Target is { } target ? [target] : [], i.IsSai ? "SAI" : i.Kind == "CUSTOM" ? i.ClassName ?? "CUSTOM" : "secondary"));
        var triggers = ks.Triggers.Where(x => x.Table == t.Name).Select(x => x.Name).ToList();
        long? estimate = null;
        try
        {
            var sizes = await Schema.SizeEstimatesAsync(ks.Name).WaitAsync(ct).ConfigureAwait(false);
            if (sizes.TryGetValue(t.Name, out var s)) estimate = s.Partitions;
        }
        catch (DriverException) { /* estimates are optional */ }
        return new ObjectDetails(obj with { Schema = ks.Name, Type = t.IsView ? ObjectTypes.MView : ObjectTypes.Table },
            columns, indexes, [], [], triggers, [], estimate, null, null);
    }

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        var ks = await RequireKeyspaceAsync(obj.Schema, ct).ConfigureAwait(false);
        var described = await DescribeAsync(obj, ks.Name, ct).ConfigureAwait(false);
        if (described is not null) return new DdlResult(described, "stored");
        return new DdlResult(GeneratedDdl(ks, obj), "generated");
    }

    /// <summary>Generated DDL of one object (table with its indexes and views, view, type, function/aggregate, keyspace).</summary>
    public static string GeneratedDdl(CqlKeyspaceMeta ks, ObjectRef obj)
    {
        switch (obj.Type)
        {
            case ObjectTypes.Type:
                return CqlDdl.Type(ks.Types.FirstOrDefault(x => x.Name == obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Type '{obj.Name}'"));
            case ObjectTypes.Func:
            case ObjectTypes.Proc:
                {
                    var parts = ks.Functions.Where(x => x.Name == obj.Name).Select(CqlDdl.Function)
                        .Concat(ks.Aggregates.Where(x => x.Name == obj.Name).Select(CqlDdl.Aggregate)).ToList();
                    if (parts.Count == 0) throw DbStudio.Core.Services.EngineException.NotFound($"Function '{obj.Name}'");
                    return string.Join("\n\n", parts);
                }
            case "schema":
            case "keyspace":
                return CqlDdl.WholeKeyspace(ks);
            default:
                {
                    var t = ks.Table(obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Table '{ks.Name}.{obj.Name}'");
                    return CqlDdl.TableWithDependents(ks, t);
                }
        }
    }

    /// <summary>Server-side DESCRIBE (Cassandra 4.0+); null when the server cannot (Cassandra 3, ScyllaDB &lt; 5) or fails.</summary>
    private async Task<string?> DescribeAsync(ObjectRef obj, string keyspace, CancellationToken ct)
    {
        var what = obj.Type switch
        {
            ObjectTypes.Table => "TABLE",
            ObjectTypes.MView => "MATERIALIZED VIEW",
            ObjectTypes.Type => "TYPE",
            ObjectTypes.Func or ObjectTypes.Proc => null, // FUNCTION needs the signature for overloads; generated text is exact
            _ => null,
        };
        if (what is null) return null;
        try
        {
            var rs = await Session.ExecuteAsync(new SimpleStatement($"DESCRIBE {what} {CqlText.Qualify(keyspace, obj.Name)}")).WaitAsync(ct).ConfigureAwait(false);
            if (rs.Columns is null || !rs.Columns.Any(c => c.Name == "create_statement")) return null;
            var parts = rs.Select(r => r.GetValue<string>("create_statement")).Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
            return parts.Count == 0 ? null : string.Join("\n\n", parts);
        }
        catch (Exception ex) when (ex is DriverException)
        {
            return null;
        }
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) => Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);
}
