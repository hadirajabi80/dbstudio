namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// pg_catalog queries of the object browser (WP3): <c>pg_depend</c>/<c>pg_rewrite</c> for views, <c>pg_constraint</c> FKs,
/// <c>pg_trigger</c>, and the Objects tab list (<c>pg_class.reltuples</c>, <c>pg_total_relation_size</c>). PL/pgSQL bodies
/// are not tracked by pg_depend, so routine bodies are scanned for names (see <see cref="PgDependencyReader"/>).
/// Parameters are positional; <c>$1</c> is an oid unless noted.
/// </summary>
public static class PgDependencyQueries
{
    public const string UserSchema = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

    /// <summary>$1 = schema, $2 = trigger name → trigger oid, table oid, function oid, table schema, table name, trigger name.</summary>
    public const string FindTrigger =
        "SELECT t.oid, t.tgrelid, t.tgfoid, n.nspname::text, c.relname::text, t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE lower(n.nspname) = lower($1) AND lower(t.tgname) = lower($2) AND NOT t.tgisinternal " +
        "ORDER BY (t.tgname = $2) DESC LIMIT 1";

    /// <summary>Relations a view's rewrite rule reads (tables, views, sequences), other than the view itself.</summary>
    public const string ViewUsesRelations =
        "SELECT DISTINCT c.relkind::text, n.nspname::text, c.relname::text FROM pg_rewrite r " +
        "JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_class'::regclass " +
        "JOIN pg_class c ON c.oid = d.refobjid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE r.ev_class = $1 AND d.refobjid <> $1 AND " + UserSchema;

    /// <summary>Functions a view's rewrite rule calls.</summary>
    public const string ViewUsesRoutines =
        "SELECT DISTINCT p.prokind::text, p.proretset, n.nspname::text, p.proname::text FROM pg_rewrite r " +
        "JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_proc'::regclass " +
        "JOIN pg_proc p ON p.oid = d.refobjid JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE r.ev_class = $1 AND " + UserSchema;

    /// <summary>Views and materialized views reading relation or function $1 (refclassid $2 = 'pg_class' or 'pg_proc').</summary>
    public const string ViewsUsing =
        "SELECT DISTINCT v.relkind::text, n.nspname::text, v.relname::text FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid " +
        "JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace n ON n.oid = v.relnamespace " +
        "WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = $2::regclass AND d.refobjid = $1 AND r.ev_class <> $1";

    /// <summary>Non-internal triggers on relation $1: name, function schema, function name, definition.</summary>
    public const string RelationTriggers =
        "SELECT t.tgname::text, pn.nspname::text, p.proname::text, pg_get_triggerdef(t.oid, true), t.tgenabled::text FROM pg_trigger t " +
        "JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname";

    /// <summary>Triggers calling function $1: trigger name, table schema, table name.</summary>
    public const string TriggersCalling =
        "SELECT t.tgname::text, n.nspname::text, c.relname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE t.tgfoid = $1 AND NOT t.tgisinternal";

    /// <summary>Relations whose column defaults use sequence $1 (serial / nextval).</summary>
    public const string SequenceUsedBy =
        "SELECT DISTINCT c.relkind::text, n.nspname::text, c.relname::text, a.attname::text FROM pg_depend d JOIN pg_attrdef ad ON ad.oid = d.objid " +
        "JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum " +
        "WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = $1";

    /// <summary>Relations with a column of type $1 (enums, domains, composites).</summary>
    public const string TypeUsedBy =
        "SELECT DISTINCT c.relkind::text, n.nspname::text, c.relname::text, a.attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE a.atttypid = $1 AND a.attnum > 0 AND NOT a.attisdropped " +
        "AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition";

    /// <summary>Relations a SQL-standard routine body (BEGIN ATOMIC, PostgreSQL 14+) depends on; $1 = routine oid.</summary>
    public const string RoutineDependsOnRelations =
        "SELECT DISTINCT c.relkind::text, n.nspname::text, c.relname::text FROM pg_depend d JOIN pg_class c ON c.oid = d.refobjid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE d.classid = 'pg_proc'::regclass AND d.objid = $1 " +
        "AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'n' AND " + UserSchema;

    /// <summary>Source text of routine $1 (SQL / PL/pgSQL only).</summary>
    public const string RoutineSource =
        "SELECT p.prosrc FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = $1 AND l.lanname IN ('sql','plpgsql')";

    /// <summary>
    /// Candidate routines whose body mentions $1 (a lower-case name; confirmed with the tokenizer): oid, kind, set-returning,
    /// schema, name, source.
    /// </summary>
    public const string RoutinesMentioning =
        "SELECT p.oid, p.prokind::text, p.proretset, n.nspname::text, p.proname::text, p.prosrc FROM pg_proc p " +
        "JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang " +
        "WHERE l.lanname IN ('sql','plpgsql') AND " + UserSchema + " AND strpos(lower(p.prosrc), $1) > 0 LIMIT 500";

    /// <summary>Relations named like one of $1 (lower-case names, text[]) in user schemas.</summary>
    public const string RelationsNamed =
        "SELECT c.relkind::text, n.nspname::text, c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition AND lower(c.relname) = ANY($1) AND " + UserSchema;

    /// <summary>Routines named like one of $1 (lower-case names, text[]) in user schemas.</summary>
    public const string RoutinesNamed =
        "SELECT DISTINCT p.prokind::text, p.proretset, n.nspname::text, p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE lower(p.proname) = ANY($1) AND " + UserSchema;

    // ------------------------------------------------------------------ object list ($1 = schema name or NULL)

    public const string ListRelations =
        "SELECT c.relkind::text, n.nspname::text, c.relname::text, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, " +
        "CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END, obj_description(c.oid, 'pg_class') " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition AND ($1::text IS NULL OR n.nspname = $1::text) AND " + UserSchema;

    public const string ListRoutines =
        "SELECT p.prokind::text, p.proretset, n.nspname::text, p.proname::text, obj_description(p.oid, 'pg_proc') FROM pg_proc p " +
        "JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ($1::text IS NULL OR n.nspname = $1::text) AND " + UserSchema;

    public const string ListTypes =
        "SELECT n.nspname::text, t.typname::text, obj_description(t.oid, 'pg_type') FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace " +
        "LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE t.typtype IN ('e','d','c','r') AND t.typcategory <> 'A' AND (t.typtype <> 'c' OR c.relkind = 'c') " +
        "AND ($1::text IS NULL OR n.nspname = $1::text) AND " + UserSchema;

    public const string ListTriggers =
        "SELECT n.nspname::text, t.tgname::text, c.relname::text, obj_description(t.oid, 'pg_trigger') FROM pg_trigger t " +
        "JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE NOT t.tgisinternal AND ($1::text IS NULL OR n.nspname = $1::text) AND " + UserSchema;

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        [nameof(FindTrigger)] = FindTrigger, [nameof(ViewUsesRelations)] = ViewUsesRelations, [nameof(ViewUsesRoutines)] = ViewUsesRoutines,
        [nameof(ViewsUsing)] = ViewsUsing, [nameof(RelationTriggers)] = RelationTriggers, [nameof(TriggersCalling)] = TriggersCalling,
        [nameof(SequenceUsedBy)] = SequenceUsedBy, [nameof(TypeUsedBy)] = TypeUsedBy, [nameof(RoutineDependsOnRelations)] = RoutineDependsOnRelations,
        [nameof(RoutineSource)] = RoutineSource, [nameof(RoutinesMentioning)] = RoutinesMentioning, [nameof(RelationsNamed)] = RelationsNamed,
        [nameof(RoutinesNamed)] = RoutinesNamed, [nameof(ListRelations)] = ListRelations, [nameof(ListRoutines)] = ListRoutines,
        [nameof(ListTypes)] = ListTypes, [nameof(ListTriggers)] = ListTriggers,
    };
}
