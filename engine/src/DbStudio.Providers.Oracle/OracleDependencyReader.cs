using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle;

/// <summary>
/// Object browser for Oracle (WP3): <c>ALL_DEPENDENCIES</c> (PL/SQL is tracked by the server), FKs from
/// <c>ALL_CONSTRAINTS</c>, triggers from <c>ALL_TRIGGERS</c>, and the object list. Schemas are owners; the database
/// argument is ignored (Oracle has no database level here).
/// </summary>
public sealed class OracleDependencyReader(OracleConnection connection) : IDependencyReader, IObjectListReader
{
    public ValueTask DisposeAsync() => connection.DisposeAsync();

    /// <summary>Dictionary type → catalog token (bodies map to their spec).</summary>
    public static string? MapType(string? oracleType) => oracleType switch
    {
        "PACKAGE BODY" => ObjectTypes.Package,
        "TYPE BODY" => ObjectTypes.Type,
        _ => OracleTypeText.ObjectType(oracleType),
    };

    private async Task<string> OwnerAsync(string? schema, CancellationToken ct) =>
        schema ?? await OracleDb.ScalarAsync(connection, OracleDependencyQueries.CurrentSchema, ct).ConfigureAwait(false) as string
        ?? throw EngineException.Validation("schema is required.", new { field = "schema" });

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        var owner = await OwnerAsync(obj.Schema, ct).ConfigureAwait(false);
        var p = new[] { ("owner", (object?)owner), ("name", (object?)obj.Name) };
        var types = await OracleDb.QueryAsync(connection, OracleDependencyQueries.FindObject, r => OracleDb.Str(r, 0) ?? "", ct, p).ConfigureAwait(false);
        if (types.Count == 0) throw EngineException.NotFound($"Object {owner}.{obj.Name}");
        var root = new ObjectRef(obj.Database, owner, obj.Name, obj.Type);
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();
        ObjectRef Ref(string o, string n, string t) => new(obj.Database, o, n, t);

        if (types.Contains("TABLE"))
        {
            var fkOut = await OracleDb.QueryAsync(connection, OracleDependencyQueries.ForeignKeysOut, ReadFk, ct, p).ConfigureAwait(false);
            foreach (var g in fkOut.GroupBy(f => f.Name))
            {
                var f = g.First();
                uses.Add(new ObjectDependency(DependencyKinds.Fk, Ref(f.Owner, f.Table, ObjectTypes.Table),
                    DependencyGraphs.FkDetail(g.Key, g.Select(x => x.Column), g.Select(x => x.RefColumn)) + (f.Status == "DISABLED" ? " (disabled)" : ""), null));
            }
            var fkIn = await OracleDb.QueryAsync(connection, OracleDependencyQueries.ForeignKeysIn, ReadFk, ct, p).ConfigureAwait(false);
            foreach (var g in fkIn.GroupBy(f => (f.Owner, f.Table, f.Name)))
            {
                var f = g.First();
                usedBy.Add(new ObjectDependency(DependencyKinds.Fk, Ref(f.Owner, f.Table, ObjectTypes.Table),
                    DependencyGraphs.FkDetail(f.Name, g.Select(x => x.Column), g.Select(x => x.RefColumn)) + (f.Status == "DISABLED" ? " (disabled)" : ""), null));
            }
        }

        var triggerNames = new HashSet<string>(StringComparer.Ordinal);
        if (types.Contains("TABLE") || types.Contains("VIEW"))
        {
            foreach (var t in await OracleDb.QueryAsync(connection, OracleDependencyQueries.Triggers,
                         r => (Owner: OracleDb.Str(r, 0)!, Name: OracleDb.Str(r, 1)!, Type: OracleDb.Str(r, 2) ?? "", Event: OracleDb.Str(r, 3) ?? "", Status: OracleDb.Str(r, 4)),
                         ct, p).ConfigureAwait(false))
            {
                triggerNames.Add(t.Name);
                var timing = t.Type.Replace(" EACH ROW", "", StringComparison.Ordinal).Replace(" STATEMENT", "", StringComparison.Ordinal).Trim();
                usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(t.Owner, t.Name, ObjectTypes.Trigger),
                    $"{timing} {t.Event}".Trim() + (t.Status == "DISABLED" ? " (disabled)" : ""), null));
            }
        }
        if (types.Contains("TRIGGER"))
        {
            foreach (var t in await OracleDb.QueryAsync(connection, OracleDependencyQueries.TriggerParent,
                         r => (Owner: OracleDb.Str(r, 0), Name: OracleDb.Str(r, 1), Base: OracleDb.Str(r, 2)), ct, p).ConfigureAwait(false))
            {
                if (t.Owner is null || t.Name is null) continue; // schema / database triggers
                uses.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(t.Owner, t.Name, t.Base?.Trim() == "VIEW" ? ObjectTypes.View : ObjectTypes.Table), "fires on", null));
            }
        }

        foreach (var d in await OracleDb.QueryAsync(connection, OracleDependencyQueries.Uses,
                     r => (Owner: OracleDb.Str(r, 0)!, Name: OracleDb.Str(r, 1)!, Type: OracleDb.Str(r, 2)), ct, p).ConfigureAwait(false))
        {
            var t = MapType(d.Type);
            if (t is null) continue;
            // The trigger's own table is listed above ("fires on").
            if (types.Contains("TRIGGER") && uses.Any(u => u.Kind == DependencyKinds.Trigger && u.Object.Name == d.Name && u.Object.Schema == d.Owner)) continue;
            uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(d.Owner, d.Name, t), null, null));
        }
        foreach (var d in await OracleDb.QueryAsync(connection, OracleDependencyQueries.UsedBy,
                     r => (Owner: OracleDb.Str(r, 0)!, Name: OracleDb.Str(r, 1)!, Type: OracleDb.Str(r, 2)), ct, p).ConfigureAwait(false))
        {
            var t = MapType(d.Type);
            if (t is null || (t == ObjectTypes.Trigger && triggerNames.Contains(d.Name))) continue;
            usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(d.Owner, d.Name, t), null, null));
        }
        return DependencyGraphs.Build(root, uses, usedBy);
    }

    private sealed record FkRow(string Name, string Owner, string Table, string Column, string RefColumn, string? Status);

    private static FkRow ReadFk(OracleDataReader r) =>
        new(OracleDb.Str(r, 0)!, OracleDb.Str(r, 1)!, OracleDb.Str(r, 2)!, OracleDb.Str(r, 3) ?? "", OracleDb.Str(r, 4) ?? "", OracleDb.Str(r, 5));

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var owner = await OwnerAsync(schema, ct).ConfigureAwait(false);
        static DateTimeOffset? Dto(object? v) => v is DateTime d ? new DateTimeOffset(DateTime.SpecifyKind(d, DateTimeKind.Unspecified), TimeSpan.Zero) : null;
        var rows = await OracleDb.QueryAsync(connection, OracleDependencyQueries.ObjectList, r => (
            Name: OracleDb.Str(r, 0)!, Type: OracleDb.Str(r, 1), Created: r.IsDBNull(2) ? null : r.GetValue(2), Modified: r.IsDBNull(3) ? null : r.GetValue(3),
            Rows: OracleDb.Long(r, 4), Bytes: OracleDb.Long(r, 5), Comment: OracleDb.Str(r, 6)), ct, ("owner", owner)).ConfigureAwait(false);
        var list = new List<ObjectListItem>(rows.Count);
        foreach (var o in rows)
        {
            var t = MapType(o.Type);
            if (t is null || (type is not null && t != type)) continue;
            list.Add(new ObjectListItem(t, owner, o.Name, o.Rows, o.Bytes, Dto(o.Modified), Dto(o.Created), o.Comment));
        }
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return list;
    }
}
