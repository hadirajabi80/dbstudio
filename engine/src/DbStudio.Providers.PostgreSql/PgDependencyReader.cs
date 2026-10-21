using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// Object browser for PostgreSQL (WP3). Views: <c>pg_rewrite</c> → <c>pg_depend</c>; FKs: <c>pg_constraint</c>; triggers:
/// <c>pg_trigger</c>; sequences and types: column defaults / column types. PL/pgSQL and SQL routine bodies are not tracked
/// by pg_depend (except BEGIN ATOMIC bodies), so their text is scanned for the names of known relations and routines.
/// Connections come from a <see cref="PgCatalogReader"/> (one pooled connection per database).
/// </summary>
public sealed class PgDependencyReader(PgCatalogReader catalog) : IDependencyReader, IObjectListReader
{
    private const string BodyDetail = "referenced in body";

    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    internal static string RelationType(string relkind) => relkind switch
    {
        "v" => ObjectTypes.View,
        "m" => ObjectTypes.MView,
        "S" => ObjectTypes.Sequence,
        _ => ObjectTypes.Table,
    };

    internal static string RoutineType(string prokind, bool retset) =>
        prokind == "p" ? ObjectTypes.Proc : retset ? ObjectTypes.TableFunc : ObjectTypes.Func;

    // ------------------------------------------------------------------ dependencies

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(obj.Database, ct).ConfigureAwait(false);
        var db = obj.Database;
        var schema = obj.Schema ?? await PgDb.ScalarAsync(conn, PgCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) as string ?? "public";
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();
        ObjectRef Rel(string kind, string s, string n) => new(db, s, n, RelationType(kind));

        switch (obj.Type)
        {
            case ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc:
            {
                var routines = await PgDb.QueryAsync(conn, PgCatalogQueries.FindRoutines,
                    r => (Oid: PgDb.Oid(r, 0), Kind: r.GetString(1), Name: r.GetString(2), Schema: r.GetString(3)), ct, schema, obj.Name).ConfigureAwait(false);
                if (routines.Count == 0) throw EngineException.NotFound($"Routine {schema}.{obj.Name}");
                var root = new ObjectRef(db, routines[0].Schema, routines[0].Name, obj.Type);
                foreach (var r in routines)
                {
                    foreach (var d in await PgDb.QueryAsync(conn, PgDependencyQueries.RoutineDependsOnRelations, ReadRel, ct, r.Oid).ConfigureAwait(false))
                        uses.Add(new ObjectDependency(DependencyKinds.Uses, Rel(d.Kind, d.Schema, d.Name), null, true));
                    var src = await PgDb.ScalarAsync(conn, PgDependencyQueries.RoutineSource, ct, r.Oid).ConfigureAwait(false) as string;
                    uses.AddRange(await ResolveBodyAsync(conn, db, root.Schema!, src, ct).ConfigureAwait(false));
                    foreach (var v in await PgDb.QueryAsync(conn, PgDependencyQueries.ViewsUsing, ReadRel, ct, r.Oid, "pg_proc").ConfigureAwait(false))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Rel(v.Kind, v.Schema, v.Name), null, true));
                    foreach (var t in await PgDb.QueryAsync(conn, PgDependencyQueries.TriggersCalling,
                                 x => (Name: x.GetString(0), Schema: x.GetString(1), Table: x.GetString(2)), ct, r.Oid).ConfigureAwait(false))
                        usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, new ObjectRef(db, t.Schema, t.Name, ObjectTypes.Trigger), $"on {t.Table}", null));
                }
                usedBy.AddRange(await RoutinesMentioningAsync(conn, db, root, routines.Select(r => r.Oid).ToHashSet(), ct).ConfigureAwait(false));
                return DependencyGraphs.Build(root, uses, usedBy);
            }
            case ObjectTypes.Trigger:
            {
                var t = (await PgDb.QueryAsync(conn, PgDependencyQueries.FindTrigger,
                    r => (Oid: PgDb.Oid(r, 0), Rel: PgDb.Oid(r, 1), Fn: PgDb.Oid(r, 2), Schema: r.GetString(3), Table: r.GetString(4), Name: r.GetString(5)),
                    ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
                if (t.Name is null) throw EngineException.NotFound($"Trigger {schema}.{obj.Name}");
                var root = new ObjectRef(db, t.Schema, t.Name, ObjectTypes.Trigger);
                var rel = await FindRelationAsync(conn, t.Schema, t.Table, ct).ConfigureAwait(false);
                uses.Add(new ObjectDependency(DependencyKinds.Trigger, Rel(rel?.Kind ?? "r", t.Schema, t.Table), "fires on", null));
                foreach (var f in await PgDb.QueryAsync(conn, "SELECT p.prokind::text, p.proretset, n.nspname::text, p.proname::text FROM pg_proc p " +
                                 "JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = $1", ReadRoutine, ct, t.Fn).ConfigureAwait(false))
                    uses.Add(new ObjectDependency(DependencyKinds.Uses, new ObjectRef(db, f.Schema, f.Name, RoutineType(f.Kind, f.RetSet)), "trigger function", null));
                return DependencyGraphs.Build(root, uses, usedBy);
            }
            case ObjectTypes.Type:
            {
                var found = (await PgDb.QueryAsync(conn, PgCatalogQueries.FindType, r => (Oid: PgDb.Oid(r, 0), Name: r.GetString(2), Schema: r.GetString(3)),
                    ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
                if (found.Name is null) throw EngineException.NotFound($"Type {schema}.{obj.Name}");
                foreach (var c in await PgDb.QueryAsync(conn, PgDependencyQueries.TypeUsedBy, ReadRelColumn, ct, found.Oid).ConfigureAwait(false))
                    usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Rel(c.Kind, c.Schema, c.Name), $"column {c.Column}", true));
                return DependencyGraphs.Build(new ObjectRef(db, found.Schema, found.Name, ObjectTypes.Type), uses, usedBy);
            }
        }

        var relation = await FindRelationAsync(conn, schema, obj.Name, ct).ConfigureAwait(false)
                       ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var rootRef = new ObjectRef(db, relation.Schema, relation.Name, RelationType(relation.Kind));

        if (relation.Kind == "S")
        {
            foreach (var c in await PgDb.QueryAsync(conn, PgDependencyQueries.SequenceUsedBy, ReadRelColumn, ct, relation.Oid).ConfigureAwait(false))
                usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Rel(c.Kind, c.Schema, c.Name), $"default of {c.Column}", true));
        }
        else
        {
            // Foreign keys in both directions.
            foreach (var f in await PgDb.QueryAsync(conn, PgCatalogQueries.RelationForeignKeys, ReadFk, ct, relation.Oid).ConfigureAwait(false))
            {
                var detail = DependencyGraphs.FkDetail(f.Name, f.Columns, f.RefColumns);
                if (f.ParentOid == relation.Oid)
                    uses.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, f.RefSchema, f.RefTable, ObjectTypes.Table), detail, null));
                if (f.RefOid == relation.Oid)
                    usedBy.Add(new ObjectDependency(DependencyKinds.Fk, new ObjectRef(db, f.Schema, f.Table, ObjectTypes.Table), detail, null));
            }
            if (relation.Kind is "v" or "m")
            {
                foreach (var d in await PgDb.QueryAsync(conn, PgDependencyQueries.ViewUsesRelations, ReadRel, ct, relation.Oid).ConfigureAwait(false))
                    uses.Add(new ObjectDependency(DependencyKinds.Uses, Rel(d.Kind, d.Schema, d.Name), null, true));
                foreach (var f in await PgDb.QueryAsync(conn, PgDependencyQueries.ViewUsesRoutines, ReadRoutine, ct, relation.Oid).ConfigureAwait(false))
                    uses.Add(new ObjectDependency(DependencyKinds.Uses, new ObjectRef(db, f.Schema, f.Name, RoutineType(f.Kind, f.RetSet)), null, true));
            }
            foreach (var v in await PgDb.QueryAsync(conn, PgDependencyQueries.ViewsUsing, ReadRel, ct, relation.Oid, "pg_class").ConfigureAwait(false))
                usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, Rel(v.Kind, v.Schema, v.Name), null, true));
            foreach (var t in await PgDb.QueryAsync(conn, PgDependencyQueries.RelationTriggers,
                         r => (Name: r.GetString(0), FnSchema: r.GetString(1), Fn: r.GetString(2), Def: PgDb.Str(r, 3), Enabled: PgDb.Str(r, 4)), ct, relation.Oid).ConfigureAwait(false))
                usedBy.Add(new ObjectDependency(DependencyKinds.Trigger, new ObjectRef(db, relation.Schema, t.Name, ObjectTypes.Trigger),
                    TriggerTiming(t.Def) + (t.Enabled == "D" ? " (disabled)" : ""), null));
        }
        usedBy.AddRange(await RoutinesMentioningAsync(conn, db, rootRef, [], ct).ConfigureAwait(false));
        return DependencyGraphs.Build(rootRef, uses, usedBy);
    }

    /// <summary>"BEFORE INSERT OR UPDATE" from <c>CREATE TRIGGER x BEFORE INSERT OR UPDATE ON t …</c>.</summary>
    internal static string TriggerTiming(string? def)
    {
        if (string.IsNullOrEmpty(def)) return "";
        var m = System.Text.RegularExpressions.Regex.Match(def, @"\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return m.Success ? $"{m.Groups[1].Value.ToUpperInvariant()} {m.Groups[2].Value.ToUpperInvariant()}" : "";
    }

    private sealed record RelRow(string Kind, string Schema, string Name);
    private static RelRow ReadRel(NpgsqlDataReader r) => new(PgDb.Char(r, 0), r.GetString(1), r.GetString(2));

    private sealed record RelColumnRow(string Kind, string Schema, string Name, string Column);
    private static RelColumnRow ReadRelColumn(NpgsqlDataReader r) => new(PgDb.Char(r, 0), r.GetString(1), r.GetString(2), r.GetString(3));

    private sealed record RoutineRow(string Kind, bool RetSet, string Schema, string Name);
    private static RoutineRow ReadRoutine(NpgsqlDataReader r) => new(PgDb.Char(r, 0), PgDb.Bool(r, 1), r.GetString(2), r.GetString(3));

    private sealed record FkRow(string Name, string Schema, string Table, string RefSchema, string RefTable, string[] Columns, string[] RefColumns, uint ParentOid, uint RefOid);
    private static FkRow ReadFk(NpgsqlDataReader r) => new(r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5),
        PgDb.Strings(r, 8), PgDb.Strings(r, 9), PgDb.Oid(r, 10), PgDb.Oid(r, 11));

    private sealed record FoundRelation(uint Oid, string Kind, string Name, string Schema);

    private static async Task<FoundRelation?> FindRelationAsync(NpgsqlConnection conn, string schema, string name, CancellationToken ct) =>
        (await PgDb.QueryAsync(conn, PgCatalogQueries.FindRelation, r => new FoundRelation(PgDb.Oid(r, 0), PgDb.Char(r, 1), r.GetString(2), r.GetString(3)),
            ct, schema, name).ConfigureAwait(false)).FirstOrDefault();

    /// <summary>Relations and routines a routine body names (unqualified names prefer the routine's own schema).</summary>
    private static async Task<List<ObjectDependency>> ResolveBodyAsync(NpgsqlConnection conn, string? db, string ownSchema, string? src, CancellationToken ct)
    {
        var refs = DependencyGraphs.ReferencedNames(src, Dialect.PgSql);
        var result = new List<ObjectDependency>();
        if (refs.Count == 0) return result;
        var names = refs.Select(r => r.Name.ToLowerInvariant()).Distinct().ToArray();
        var candidates = new List<(string Type, string Schema, string Name)>();
        foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.RelationsNamed, ReadRel, ct, (object)names).ConfigureAwait(false))
            candidates.Add((RelationType(r.Kind), r.Schema, r.Name));
        foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.RoutinesNamed, ReadRoutine, ct, (object)names).ConfigureAwait(false))
            candidates.Add((RoutineType(r.Kind, r.RetSet), r.Schema, r.Name));
        foreach (var (qualifier, name) in refs.Distinct())
        {
            var same = candidates.Where(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (same.Count == 0) continue;
            var pick = qualifier is not null ? same.Where(c => c.Schema.Equals(qualifier, StringComparison.OrdinalIgnoreCase)).ToList() : [];
            if (pick.Count == 0 && qualifier is null)
            {
                pick = same.Where(c => c.Schema.Equals(ownSchema, StringComparison.OrdinalIgnoreCase)).ToList();
                if (pick.Count == 0) pick = same.Where(c => c.Schema == "public").ToList();
                if (pick.Count == 0 && same.Select(c => c.Schema).Distinct().Count() == 1) pick = same;
            }
            foreach (var c in pick) result.Add(new ObjectDependency(DependencyKinds.Uses, new ObjectRef(db, c.Schema, c.Name, c.Type), BodyDetail, false));
        }
        return result;
    }

    /// <summary>Routines (other than <paramref name="skip"/>) whose body names <paramref name="root"/>.</summary>
    private static async Task<List<ObjectDependency>> RoutinesMentioningAsync(NpgsqlConnection conn, string? db, ObjectRef root, HashSet<uint> skip, CancellationToken ct)
    {
        var result = new List<ObjectDependency>();
        var rows = await PgDb.QueryAsync(conn, PgDependencyQueries.RoutinesMentioning,
            r => (Oid: PgDb.Oid(r, 0), Kind: PgDb.Char(r, 1), RetSet: PgDb.Bool(r, 2), Schema: r.GetString(3), Name: r.GetString(4), Src: PgDb.Str(r, 5)),
            ct, root.Name.ToLowerInvariant()).ConfigureAwait(false);
        foreach (var p in rows)
        {
            if (skip.Contains(p.Oid)) continue;
            var hit = DependencyGraphs.ReferencedNames(p.Src, Dialect.PgSql).Any(x => x.Name.Equals(root.Name, StringComparison.OrdinalIgnoreCase)
                && (x.Qualifier is null ? p.Schema.Equals(root.Schema, StringComparison.OrdinalIgnoreCase) || root.Schema == "public"
                    : x.Qualifier.Equals(root.Schema, StringComparison.OrdinalIgnoreCase)));
            if (hit) result.Add(new ObjectDependency(DependencyKinds.UsedBy, new ObjectRef(db, p.Schema, p.Name, RoutineType(p.Kind, p.RetSet)), BodyDetail, false));
        }
        return result;
    }

    // ------------------------------------------------------------------ object list

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var conn = await catalog.ConnectionFor(database, ct).ConfigureAwait(false);
        var list = new List<ObjectListItem>();
        bool Want(string t) => type is null || type == t;

        foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.ListRelations,
                     r => (Kind: PgDb.Char(r, 0), Schema: r.GetString(1), Name: r.GetString(2), Rows: PgDb.Long(r, 3), Size: PgDb.Long(r, 4), Comment: PgDb.Str(r, 5)),
                     ct, schema).ConfigureAwait(false))
        {
            var t = RelationType(r.Kind);
            if (Want(t)) list.Add(new ObjectListItem(t, r.Schema, r.Name, t is ObjectTypes.Table or ObjectTypes.MView ? r.Rows : null, r.Size, null, null, r.Comment));
        }
        if (type is null or ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.ListRoutines,
                         r => (Kind: PgDb.Char(r, 0), RetSet: PgDb.Bool(r, 1), Schema: r.GetString(2), Name: r.GetString(3), Comment: PgDb.Str(r, 4)), ct, schema).ConfigureAwait(false))
            {
                var t = RoutineType(r.Kind, r.RetSet);
                if (Want(t) && seen.Add($"{t}|{r.Schema}|{r.Name}")) list.Add(new ObjectListItem(t, r.Schema, r.Name, null, null, null, null, r.Comment));
            }
        }
        if (Want(ObjectTypes.Type))
        {
            foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.ListTypes, r => (Schema: r.GetString(0), Name: r.GetString(1), Comment: PgDb.Str(r, 2)), ct, schema).ConfigureAwait(false))
                list.Add(new ObjectListItem(ObjectTypes.Type, r.Schema, r.Name, null, null, null, null, r.Comment));
        }
        if (Want(ObjectTypes.Trigger))
        {
            foreach (var r in await PgDb.QueryAsync(conn, PgDependencyQueries.ListTriggers,
                         r => (Schema: r.GetString(0), Name: r.GetString(1), Table: r.GetString(2), Comment: PgDb.Str(r, 3)), ct, schema).ConfigureAwait(false))
                list.Add(new ObjectListItem(ObjectTypes.Trigger, r.Schema, r.Name, null, null, null, null,
                    string.IsNullOrWhiteSpace(r.Comment) ? $"on {r.Table}" : $"on {r.Table}: {r.Comment}"));
        }
        list.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase) is var c && c != 0 ? c
            : string.Compare(a.Schema, b.Schema, StringComparison.OrdinalIgnoreCase));
        return list;
    }
}
