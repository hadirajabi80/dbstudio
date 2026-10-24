using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Dependencies and the Objects-tab list for Cassandra (plan-batch3 WP-CS): materialized views and their base tables,
/// secondary/SAI indexes and triggers of a table, UDT usage (tables, views, other UDTs, functions) and functions used by
/// aggregates. Object statistics come from <c>system.size_estimates</c> (estimated partitions and mean partition size of
/// the node answering).
/// </summary>
public sealed class CqlObjectBrowser(CqlCatalogReader catalog) : IDependencyReader, IObjectListReader
{
    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    private static readonly HashSet<string> NativeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "ascii", "bigint", "blob", "boolean", "counter", "date", "decimal", "double", "duration", "float", "inet", "int", "smallint", "text",
        "time", "timestamp", "timeuuid", "tinyint", "uuid", "varchar", "varint", "list", "set", "map", "tuple", "frozen", "vector", "empty",
    };

    /// <summary>User-defined type names referenced by a CQL type text ("list&lt;frozen&lt;shop.address&gt;&gt;" → (shop, address)).</summary>
    public static IEnumerable<(string? Keyspace, string Name)> TypeReferences(string typeText)
    {
        var tokens = CqlText.Tokenize(typeText);
        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (!t.IsName || (i > 0 && tokens[i - 1].IsPunct('.'))) continue;
            if (t.Kind == CqlTokenKind.Word && NativeTypes.Contains(t.Value)) continue;
            if (i + 2 < tokens.Count && tokens[i + 1].IsPunct('.') && tokens[i + 2].IsName) yield return (t.Name, tokens[i + 2].Name);
            else yield return (null, t.Name);
        }
    }

    private static bool Refers(string typeText, string keyspace, string type) =>
        TypeReferences(typeText).Any(r => r.Name == type && (r.Keyspace is null || r.Keyspace == keyspace));

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        var ks = await catalog.RequireKeyspaceAsync(obj.Schema, ct).ConfigureAwait(false);
        var root = obj with { Schema = ks.Name };
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();
        ObjectRef Ref(string name, string type) => new(null, ks.Name, name, type);

        void TypeUses(IEnumerable<(string Owner, string TypeText)> typed)
        {
            foreach (var (owner, typeText) in typed)
                foreach (var (refKs, name) in TypeReferences(typeText))
                    if (ks.Types.Any(t => t.Name == name) && (refKs is null || refKs == ks.Name))
                        uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(name, ObjectTypes.Type), owner, null));
        }

        switch (obj.Type)
        {
            case ObjectTypes.Table:
            case ObjectTypes.MView:
                {
                    var t = ks.Table(obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Table '{ks.Name}.{obj.Name}'");
                    root = root with { Name = t.Name, Type = t.IsView ? ObjectTypes.MView : ObjectTypes.Table };
                    TypeUses(t.Columns.Select(c => ($"column {c.Name}", c.Type)));
                    if (t.IsView && t.BaseTable is { } baseTable)
                        uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(baseTable, ObjectTypes.Table), "base table" + (t.WhereClause is { } w ? $" WHERE {w}" : ""), null));
                    foreach (var v in ks.Views.Where(v => v.BaseTable == t.Name))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(v.Name, ObjectTypes.MView), $"materialized view, PRIMARY KEY {CqlDdl.PrimaryKeyText(v)[12..]}", null));
                    foreach (var i in ks.Indexes.Where(i => i.Table == t.Name))
                        usedBy.Add(new ObjectDependency(DependencyKinds.Index, Ref(i.Name, "index"), $"{(i.IsSai ? "SAI" : i.Kind == "CUSTOM" ? "custom" : "secondary")} index on {i.Target}", null));
                    foreach (var tr in ks.Triggers.Where(x => x.Table == t.Name))
                        usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(tr.Name, ObjectTypes.Trigger), tr.Options.GetValueOrDefault("class"), null));
                    break;
                }
            case ObjectTypes.Type:
                {
                    var u = ks.Types.FirstOrDefault(x => x.Name == obj.Name) ?? throw DbStudio.Core.Services.EngineException.NotFound($"Type '{obj.Name}'");
                    TypeUses(u.Fields.Select(f => ($"field {f.Name}", f.Type)));
                    foreach (var t in ks.Tables.Concat(ks.Views))
                        foreach (var c in t.Columns.Where(c => Refers(c.Type, ks.Name, u.Name)))
                            usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(t.Name, t.IsView ? ObjectTypes.MView : ObjectTypes.Table), $"column {c.Name} {c.Type}", null));
                    foreach (var other in ks.Types.Where(x => x.Name != u.Name))
                        foreach (var f in other.Fields.Where(f => Refers(f.Type, ks.Name, u.Name)))
                            usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(other.Name, ObjectTypes.Type), $"field {f.Name} {f.Type}", null));
                    foreach (var f in ks.Functions.Where(f => f.ArgumentTypes.Append(f.ReturnType).Any(x => Refers(x, ks.Name, u.Name))))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(f.Name, ObjectTypes.Func), f.Signature, null));
                    foreach (var a in ks.Aggregates.Where(a => a.ArgumentTypes.Append(a.StateType).Append(a.ReturnType).Any(x => Refers(x, ks.Name, u.Name))))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(a.Name, ObjectTypes.Func), "aggregate " + a.Signature, null));
                    break;
                }
            case ObjectTypes.Func:
            case ObjectTypes.Proc:
                {
                    foreach (var f in ks.Functions.Where(f => f.Name == obj.Name))
                        TypeUses(f.ArgumentTypes.Append(f.ReturnType).Select(x => (f.Signature, x)));
                    foreach (var a in ks.Aggregates.Where(a => a.Name == obj.Name))
                    {
                        TypeUses(a.ArgumentTypes.Append(a.StateType).Append(a.ReturnType).Select(x => (a.Signature, x)));
                        uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(a.StateFunction, ObjectTypes.Func), "state function", null));
                        if (!string.IsNullOrEmpty(a.FinalFunction))
                            uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(a.FinalFunction, ObjectTypes.Func), "final function", null));
                    }
                    foreach (var a in ks.Aggregates.Where(a => a.StateFunction == obj.Name || a.FinalFunction == obj.Name))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(a.Name, ObjectTypes.Func),
                            $"aggregate {a.Signature} ({(a.StateFunction == obj.Name ? "state" : "final")} function)", null));
                    break;
                }
        }
        return DependencyGraphs.Build(root, uses, usedBy);
    }

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var keyspaces = schema is not null
            ? [schema]
            : (await catalog.ListSchemasAsync(null, ct).ConfigureAwait(false)).Select(s => s.Name).Where(n => !CqlSchemaReader.IsSystem(n)).ToList();
        var items = new List<ObjectListItem>();
        foreach (var name in keyspaces)
        {
            var ks = await catalog.KeyspaceAsync(name, ct).ConfigureAwait(false);
            if (ks is null) continue;
            Dictionary<string, (long Partitions, long MeanSize)> sizes;
            try { sizes = await catalog.Schema.SizeEstimatesAsync(ks.Name).WaitAsync(ct).ConfigureAwait(false); }
            catch (global::Cassandra.DriverException) { sizes = []; }
            bool Want(string t) => type is null || type == t;
            if (Want(ObjectTypes.Table))
                foreach (var t in ks.Tables)
                    items.Add(Item(ObjectTypes.Table, ks.Name, t, sizes));
            if (Want(ObjectTypes.MView))
                foreach (var v in ks.Views)
                    items.Add(Item(ObjectTypes.MView, ks.Name, v, sizes));
            if (Want(ObjectTypes.Type))
                foreach (var u in ks.Types)
                    items.Add(new ObjectListItem(ObjectTypes.Type, ks.Name, u.Name, null, null, null, null, $"{u.Fields.Count} field(s)"));
            if (Want(ObjectTypes.Func))
            {
                foreach (var f in ks.Functions) items.Add(new ObjectListItem(ObjectTypes.Func, ks.Name, f.Name, null, null, null, null, $"{f.Signature} → {f.ReturnType} ({f.Language})"));
                foreach (var a in ks.Aggregates) items.Add(new ObjectListItem(ObjectTypes.Func, ks.Name, a.Name, null, null, null, null, $"aggregate {a.Signature} → {a.ReturnType}"));
            }
        }
        return items;
    }

    private static ObjectListItem Item(string type, string keyspace, CqlTableMeta t, Dictionary<string, (long Partitions, long MeanSize)> sizes)
    {
        long? rows = null, bytes = null;
        if (sizes.TryGetValue(t.Name, out var s))
        {
            rows = s.Partitions;
            bytes = s.Partitions * s.MeanSize;
        }
        var comment = string.IsNullOrEmpty(t.Comment) ? CqlDdl.PrimaryKeyText(t) : t.Comment;
        return new ObjectListItem(type, keyspace, t.Name, rows, bytes, null, null, comment);
    }
}
