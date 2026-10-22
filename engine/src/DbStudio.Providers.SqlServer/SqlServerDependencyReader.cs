using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>
/// Object browser for SQL Server (WP3): <c>sys.sql_expression_dependencies</c> for views/routines/triggers,
/// <c>sys.foreign_keys</c> for FKs, <c>sys.triggers</c> for triggers; the object list with
/// <c>sys.dm_db_partition_stats</c> (falling back to <c>sys.partitions</c> without VIEW DATABASE STATE).
/// </summary>
public sealed class SqlServerDependencyReader(SqlConnection connection) : IDependencyReader, IObjectListReader
{
    private readonly SqlConnection _conn = connection;

    public ValueTask DisposeAsync() => _conn.DisposeAsync();

    private async Task UseAsync(string? database, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(database) || string.Equals(database, _conn.Database, StringComparison.Ordinal)) return;
        await SqlDb.ExecuteAsync(_conn, "USE " + SqlServerNames.Quote(database), ct).ConfigureAwait(false);
    }

    private static string? Type(string code) => SqlServerCatalogReader.MapType(code.Trim());

    // ------------------------------------------------------------------ dependencies

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        await UseAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? await SqlDb.ScalarAsync<string>(_conn, SqlServerDependencyQueries.DefaultSchema, ct).ConfigureAwait(false) ?? "dbo";
        var found = (await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.FindObject,
                r => (Id: r.GetInt32(0), Type: r.GetString(1).Trim(), Schema: r.GetString(2), Name: r.GetString(3)), ct,
                ("@schema", schema), ("@name", obj.Name)).ConfigureAwait(false)).FirstOrDefault();
        if (found.Name is null) throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var db = obj.Database;
        var root = new ObjectRef(db, found.Schema, found.Name, Type(found.Type) ?? obj.Type);
        var id = ("@id", (object?)found.Id);

        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();
        ObjectRef Ref(string code, string s, string n) => new(db, s, n, Type(code) ?? ObjectTypes.Table);

        // Foreign keys (one row per column pair, grouped by constraint).
        var fkOut = await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.ForeignKeysOut, ReadFk, ct, id).ConfigureAwait(false);
        foreach (var g in fkOut.GroupBy(f => f.Name))
        {
            var f = g.First();
            uses.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, f.Schema, f.Table, ObjectTypes.Table),
                DependencyGraphs.FkDetail(g.Key, g.Select(x => x.Column), g.Select(x => x.RefColumn)) + (f.Disabled ? " (disabled)" : ""), null));
        }
        var fkIn = await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.ForeignKeysIn, ReadFk, ct, id).ConfigureAwait(false);
        foreach (var g in fkIn.GroupBy(f => (f.Schema, f.Table, f.Name)))
        {
            var f = g.First();
            usedBy.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, f.Schema, f.Table, ObjectTypes.Table),
                DependencyGraphs.FkDetail(f.Name, g.Select(x => x.Column), g.Select(x => x.RefColumn)) + (f.Disabled ? " (disabled)" : ""), null));
        }

        // Definitions: what the root references and who references it.
        foreach (var d in await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.Uses, ReadExpr, ct, id).ConfigureAwait(false))
        {
            if (Type(d.Type) is null) continue;
            uses.Add(new ObjectDependency(DependencyKinds.Uses, Ref(d.Type, d.Schema, d.Name), null, d.SchemaBound));
        }

        // Triggers of a table/view.
        var triggers = await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.Triggers,
            r => (Id: r.GetInt32(0), Schema: r.GetString(1), Name: r.GetString(2), Disabled: SqlDb.Bool(r, 3), InsteadOf: SqlDb.Bool(r, 4)), ct, id).ConfigureAwait(false);
        var triggerNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (triggers.Count > 0)
        {
            var events = (await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.TriggerEvents, r => (Id: r.GetInt32(0), Event: SqlDb.Str(r, 1) ?? ""), ct, id)
                .ConfigureAwait(false)).ToLookup(e => e.Id, e => e.Event);
            foreach (var t in triggers)
            {
                triggerNames.Add(t.Name);
                var ev = string.Join(", ", events[t.Id].Select(e => e.ToUpperInvariant()).Distinct());
                var detail = $"{(t.InsteadOf ? "INSTEAD OF" : "AFTER")}{(ev.Length > 0 ? " " + ev : "")}{(t.Disabled ? " (disabled)" : "")}";
                usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, new ObjectRef(db, t.Schema, t.Name, ObjectTypes.Trigger), detail, null));
            }
        }

        foreach (var d in await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.UsedBy, ReadExpr, ct, id).ConfigureAwait(false))
        {
            var t = Type(d.Type);
            if (t is null || (t == ObjectTypes.Trigger && triggerNames.Contains(d.Name))) continue;
            usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Ref(d.Type, d.Schema, d.Name), null, d.SchemaBound));
        }

        // A trigger uses the table it fires on.
        if (root.Type == ObjectTypes.Trigger)
        {
            foreach (var p in await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.TriggerParent,
                         r => (Type: r.GetString(0).Trim(), Schema: r.GetString(1), Name: r.GetString(2)), ct, id).ConfigureAwait(false))
                uses.Add(new ObjectDependency(DependencyKinds.Trigger, Ref(p.Type, p.Schema, p.Name), "fires on", null));
        }

        return DependencyGraphs.Build(root, uses, usedBy);
    }

    private sealed record FkRow(string Name, string Schema, string Table, string Column, string RefColumn, bool Disabled);

    private static FkRow ReadFk(SqlDataReader r) =>
        new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), SqlDb.Bool(r, 5));

    private sealed record ExprRow(string Type, string Schema, string Name, bool? SchemaBound);

    private static ExprRow ReadExpr(SqlDataReader r) =>
        new(r.GetString(0).Trim(), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetBoolean(3));

    // ------------------------------------------------------------------ object list

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        var rows = await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.ObjectList, r => (
            Id: r.GetInt32(0), Type: r.GetString(1).Trim(), Schema: r.GetString(2), Name: r.GetString(3),
            Created: r.IsDBNull(4) ? (DateTime?)null : r.GetDateTime(4), Modified: r.IsDBNull(5) ? (DateTime?)null : r.GetDateTime(5),
            Comment: SqlDb.Str(r, 6)), ct, ("@schema", schema)).ConfigureAwait(false);

        var stats = new Dictionary<int, (long? Rows, long? Bytes)>();
        try
        {
            foreach (var s in await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.PartitionStats,
                         r => (Id: r.GetInt32(0), Rows: r.IsDBNull(1) ? (long?)null : Convert.ToInt64(r.GetValue(1)), Bytes: r.IsDBNull(2) ? (long?)null : Convert.ToInt64(r.GetValue(2))),
                         ct).ConfigureAwait(false))
                stats[s.Id] = (s.Rows, s.Bytes);
        }
        catch (SqlException)
        {
            // No VIEW DATABASE STATE (or an old Azure tier): row counts from sys.partitions, no sizes.
            try
            {
                foreach (var s in await SqlDb.QueryAsync(_conn, SqlServerDependencyQueries.PartitionRows,
                             r => (Id: r.GetInt32(0), Rows: r.IsDBNull(1) ? (long?)null : Convert.ToInt64(r.GetValue(1))), ct).ConfigureAwait(false))
                    stats[s.Id] = (s.Rows, null);
            }
            catch (SqlException)
            {
                // Statistics are best effort.
            }
        }

        static DateTimeOffset? Dto(DateTime? d) => d is DateTime v ? new DateTimeOffset(DateTime.SpecifyKind(v, DateTimeKind.Unspecified), TimeSpan.Zero) : null;
        var list = new List<ObjectListItem>(rows.Count);
        foreach (var o in rows)
        {
            var t = Type(o.Type);
            if (t is null || (type is not null && t != type)) continue;
            var tabular = t is ObjectTypes.Table or ObjectTypes.View;
            var st = tabular && stats.TryGetValue(o.Id, out var x) ? x : (null, null);
            // Views only have statistics when indexed.
            if (t == ObjectTypes.View && st.Rows is null) st = (null, null);
            list.Add(new ObjectListItem(t, o.Schema, o.Name, st.Rows, st.Bytes, Dto(o.Modified), Dto(o.Created), o.Comment));
        }
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase) is var c && c != 0 ? c
            : string.Compare(a.Schema, b.Schema, StringComparison.OrdinalIgnoreCase));
        return list;
    }
}
