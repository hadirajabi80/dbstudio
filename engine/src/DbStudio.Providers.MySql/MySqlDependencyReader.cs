using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.MySql;

/// <summary>
/// Object browser for MySQL / MariaDB (plan-batch3 WP-MY): foreign keys from KEY_COLUMN_USAGE, triggers from TRIGGERS,
/// and the names referenced by view, routine, trigger and event bodies (information_schema definitions scanned with the
/// MySQL tokenizer and matched against the schema's objects; qualified names may point into other databases). The
/// object list reads TABLES statistics (rows, data + index size, create/update time), ROUTINES, TRIGGERS and EVENTS.
/// </summary>
public sealed class MySqlDependencyReader(MySqlCatalogReader catalog) : IDependencyReader, IObjectListReader
{
    private const string BodyDetail = "referenced in body";

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    private sealed record Body(string Schema, string Name, string Type, string? Text, string? Detail);

    private sealed record Named(string Schema, string Name, string Type);

    // ------------------------------------------------------------------ dependencies

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var conn = catalog.Connection;
        var schema = await catalog.SchemaOf(obj, ct).ConfigureAwait(false);
        var objects = await ObjectsAsync(schema, ct).ConfigureAwait(false);
        var bodies = await BodiesAsync(schema, ct).ConfigureAwait(false);
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();

        var root = objects.FirstOrDefault(o => o.Name.Equals(obj.Name, StringComparison.OrdinalIgnoreCase) && SameFamily(o.Type, obj.Type))
                   ?? objects.FirstOrDefault(o => o.Name.Equals(obj.Name, StringComparison.OrdinalIgnoreCase))
                   ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var rootRef = new ObjectRef(null, root.Schema, root.Name, root.Type);

        if (root.Type is ObjectTypes.Table or ObjectTypes.View)
        {
            var keys = await MySqlTableReader.KeysAsync(conn, schema, root.Name, ct).ConfigureAwait(false);
            foreach (var g in keys.Where(k => k.Type == "FOREIGN KEY").GroupBy(k => k.Constraint, StringComparer.Ordinal))
            {
                var cols = g.OrderBy(x => x.Position).ToList();
                uses.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(null, cols[0].RefSchema ?? schema, cols[0].RefTable ?? "", ObjectTypes.Table),
                    DependencyGraphs.FkDetail(g.Key, cols.Select(c => c.Column), cols.Select(c => c.RefColumn ?? "")), null));
            }
            var incoming = await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.ReferencingKeys,
                r => (Schema: MySqlDb.S(r, 0), Table: MySqlDb.S(r, 1), Constraint: MySqlDb.S(r, 2), Column: MySqlDb.S(r, 3), Position: MySqlDb.Int(r, 4), Ref: MySqlDb.S(r, 5)),
                ct, schema, root.Name).ConfigureAwait(false);
            foreach (var g in incoming.GroupBy(x => (x.Schema, x.Table, x.Constraint)))
            {
                var cols = g.OrderBy(x => x.Position).ToList();
                usedBy.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(null, g.Key.Schema, g.Key.Table, ObjectTypes.Table),
                    DependencyGraphs.FkDetail(g.Key.Constraint, cols.Select(c => c.Column), cols.Select(c => c.Ref)), null));
            }
            foreach (var t in await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.TableTriggers,
                         r => (Name: MySqlDb.S(r, 0), Timing: MySqlDb.S(r, 1), Event: MySqlDb.S(r, 2)), ct, schema, root.Name).ConfigureAwait(false))
                usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, new ObjectRef(null, schema, t.Name, ObjectTypes.Trigger), $"{t.Timing} {t.Event}", null));
        }

        if (root.Type == ObjectTypes.Trigger)
        {
            var tr = (await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.FindTrigger,
                r => (Schema: MySqlDb.S(r, 1), Table: MySqlDb.S(r, 2)), ct, schema, root.Name).ConfigureAwait(false)).FirstOrDefault();
            if (tr.Table is not null)
                uses.Add(new ObjectDependency(DependencyKinds.Trigger, new ObjectRef(null, tr.Schema, tr.Table, ObjectTypes.Table), "fires on", null));
        }

        // Body references: what the root's body names, and the bodies that name the root.
        var own = bodies.FirstOrDefault(b => b.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase) && SameFamily(b.Type, root.Type));
        if (own is not null)
        {
            foreach (var target in Resolve(own, objects, schema))
                if (!(target.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase) && SameFamily(target.Type, root.Type)))
                    uses.Add(new ObjectDependency(DependencyKinds.Uses, new ObjectRef(null, target.Schema, target.Name, target.Type), BodyDetail, own.Type == ObjectTypes.View));
        }
        foreach (var b in bodies)
        {
            if (ReferenceEquals(b, own)) continue;
            if (Resolve(b, objects, schema).Any(t => t.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase) && t.Schema.Equals(root.Schema, StringComparison.OrdinalIgnoreCase)
                                                    && SameFamily(t.Type, root.Type)))
                usedBy.Add(new ObjectDependency(b.Type == ObjectTypes.Trigger ? DependencyKinds.Trigger : DependencyKinds.UsedBy,
                    new ObjectRef(null, b.Schema, b.Name, b.Type), b.Type == ObjectTypes.Trigger ? b.Detail : BodyDetail, b.Type == ObjectTypes.View));
        }
        return DependencyGraphs.Build(rootRef, uses, usedBy);
    }

    private static bool SameFamily(string a, string b)
    {
        static string F(string t) => t is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc ? "routine" : t is ObjectTypes.View or ObjectTypes.Table or ObjectTypes.Sequence ? "relation" : t;
        return F(a) == F(b);
    }

    /// <summary>Objects of the schema a body names (unqualified names) plus qualified names of other schemas.</summary>
    private static IEnumerable<Named> Resolve(Body body, IReadOnlyList<Named> objects, string schema)
    {
        var refs = DependencyGraphs.ReferencedNames(body.Text, Dialect.MySql);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (qualifier, name) in refs)
        {
            if (qualifier is not null && !qualifier.Equals(schema, StringComparison.OrdinalIgnoreCase))
            {
                // other database: only views/tables of it are known by name here; report as a table reference
                if (seen.Add(qualifier + "." + name) && body.Type == ObjectTypes.View)
                    yield return new Named(qualifier, name, ObjectTypes.Table);
                continue;
            }
            foreach (var o in objects.Where(o => o.Name.Equals(name, StringComparison.OrdinalIgnoreCase) && o.Type != ObjectTypes.Trigger))
                if (seen.Add(o.Schema + "." + o.Name + "|" + o.Type)) yield return o;
        }
    }

    private async Task<List<Named>> ObjectsAsync(string schema, CancellationToken ct)
    {
        var conn = catalog.Connection;
        var list = new List<Named>();
        foreach (var t in await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.Tables, r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1)), ct, schema).ConfigureAwait(false))
            list.Add(new Named(schema, t.Name, MySqlTableReader.ObjectType(t.Type)));
        foreach (var r in await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.Routines, r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1)), ct, schema).ConfigureAwait(false))
            list.Add(new Named(schema, r.Name, r.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase) ? ObjectTypes.Func : ObjectTypes.Proc));
        foreach (var t in await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.Triggers, r => MySqlDb.S(r, 0), ct, schema).ConfigureAwait(false))
            list.Add(new Named(schema, t, ObjectTypes.Trigger));
        try
        {
            foreach (var e in await MySqlDb.QueryAsync(conn, MySqlCatalogQueries.Events, r => MySqlDb.S(r, 0), ct, schema).ConfigureAwait(false))
                if (!list.Any(o => o.Type == ObjectTypes.Proc && o.Name.Equals(e, StringComparison.OrdinalIgnoreCase))) list.Add(new Named(schema, e, ObjectTypes.Proc));
        }
        catch (MySqlConnector.MySqlException) { /* no EVENT privilege */ }
        return list;
    }

    private async Task<List<Body>> BodiesAsync(string schema, CancellationToken ct)
    {
        var conn = catalog.Connection;
        var list = new List<Body>();
        foreach (var v in await MySqlDb.QueryAsync(conn, "SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = @p0",
                     r => (Name: MySqlDb.S(r, 0), Def: MySqlDb.Str(r, 1)), ct, schema).ConfigureAwait(false))
            list.Add(new Body(schema, v.Name, ObjectTypes.View, v.Def, null));
        foreach (var r in await MySqlDb.QueryAsync(conn, "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0",
                     r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Def: MySqlDb.Str(r, 2)), ct, schema).ConfigureAwait(false))
            list.Add(new Body(schema, r.Name, r.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase) ? ObjectTypes.Func : ObjectTypes.Proc, r.Def, null));
        foreach (var t in await MySqlDb.QueryAsync(conn, "SELECT TRIGGER_NAME, ACTION_STATEMENT, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0",
                     r => (Name: MySqlDb.S(r, 0), Def: MySqlDb.Str(r, 1), Timing: MySqlDb.S(r, 2), Event: MySqlDb.S(r, 3), Table: MySqlDb.S(r, 4)), ct, schema).ConfigureAwait(false))
            list.Add(new Body(schema, t.Name, ObjectTypes.Trigger, t.Def, $"{t.Timing} {t.Event} on {t.Table}"));
        try
        {
            foreach (var e in await MySqlDb.QueryAsync(conn, "SELECT EVENT_NAME, EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0",
                         r => (Name: MySqlDb.S(r, 0), Def: MySqlDb.Str(r, 1)), ct, schema).ConfigureAwait(false))
                list.Add(new Body(schema, e.Name, ObjectTypes.Proc, e.Def, "event"));
        }
        catch (MySqlConnector.MySqlException) { }
        return list;
    }

    // ------------------------------------------------------------------ object list

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var conn = catalog.Connection;
        var schemas = schema is not null ? [schema] : (await catalog.ListSchemasAsync(null, ct).ConfigureAwait(false)).Select(s => s.Name).ToList();
        var list = new List<ObjectListItem>();
        bool Want(string t) => type is null || type == t;
        foreach (var s in schemas)
        {
            foreach (var t in await MySqlDb.QueryAsync(conn,
                         "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT " +
                         "FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0",
                         r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Rows: MySqlDb.Long(r, 2), Size: MySqlDb.Long(r, 3), Created: MySqlDb.Time(r, 4),
                             Updated: MySqlDb.Time(r, 5), Comment: MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 6))), ct, s).ConfigureAwait(false))
            {
                var ot = MySqlTableReader.ObjectType(t.Type);
                if (!Want(ot)) continue;
                list.Add(new ObjectListItem(ot, s, t.Name, ot == ObjectTypes.Table ? t.Rows : null, ot == ObjectTypes.Table ? t.Size : null, t.Updated ?? t.Created, t.Created,
                    ot == ObjectTypes.View && t.Comment == "VIEW" ? null : t.Comment));
            }
            if (type is null or ObjectTypes.Proc or ObjectTypes.Func)
            {
                foreach (var r in await MySqlDb.QueryAsync(conn,
                             "SELECT ROUTINE_NAME, ROUTINE_TYPE, CREATED, LAST_ALTERED, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = @p0",
                             r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Created: MySqlDb.Time(r, 2), Altered: MySqlDb.Time(r, 3), Comment: MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 4))),
                             ct, s).ConfigureAwait(false))
                {
                    var ot = r.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase) ? ObjectTypes.Func : ObjectTypes.Proc;
                    if (Want(ot)) list.Add(new ObjectListItem(ot, s, r.Name, null, null, r.Altered, r.Created, r.Comment));
                }
                if (Want(ObjectTypes.Proc))
                {
                    try
                    {
                        foreach (var e in await MySqlDb.QueryAsync(conn,
                                     "SELECT EVENT_NAME, CREATED, LAST_ALTERED, EVENT_COMMENT, STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0",
                                     r => (Name: MySqlDb.S(r, 0), Created: MySqlDb.Time(r, 1), Altered: MySqlDb.Time(r, 2), Comment: MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 3)), Status: MySqlDb.S(r, 4)),
                                     ct, s).ConfigureAwait(false))
                            list.Add(new ObjectListItem(ObjectTypes.Proc, s, e.Name, null, null, e.Altered, e.Created,
                                $"event ({e.Status.ToLowerInvariant()})" + (e.Comment is null ? "" : ": " + e.Comment)));
                    }
                    catch (MySqlConnector.MySqlException) { }
                }
            }
            if (Want(ObjectTypes.Trigger))
            {
                foreach (var t in await MySqlDb.QueryAsync(conn,
                             "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, CREATED FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0",
                             r => (Name: MySqlDb.S(r, 0), Table: MySqlDb.S(r, 1), Timing: MySqlDb.S(r, 2), Event: MySqlDb.S(r, 3), Created: MySqlDb.Time(r, 4)), ct, s).ConfigureAwait(false))
                    list.Add(new ObjectListItem(ObjectTypes.Trigger, s, t.Name, null, null, null, t.Created, $"{t.Timing} {t.Event} on {t.Table}"));
            }
        }
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase) is var c && c != 0 ? c
            : string.Compare(a.Schema, b.Schema, StringComparison.OrdinalIgnoreCase));
        return list;
    }
}
