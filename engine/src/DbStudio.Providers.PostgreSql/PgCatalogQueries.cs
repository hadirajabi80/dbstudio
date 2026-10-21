namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// The pg_catalog queries of the PostgreSQL catalog reader (docs/PLAN-PG.md 2.5). Every query binds positional
/// parameters (<c>$1</c> = the oid of the schema or object unless noted) and casts <c>name</c>/<c>"char"</c> columns to
/// text so they read as strings. PostgreSQL 12+ (prokind, relispartition, attgenerated).
/// </summary>
public static class PgCatalogQueries
{
    public const string ServerInfo =
        "SELECT version(), current_setting('server_version'), inet_server_addr()::text, current_user::text, current_database()::text";

    public const string Databases =
        "SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname";

    public const string CurrentDatabase = "SELECT current_database()::text";

    public const string DefaultSchema = "SELECT COALESCE(current_schema(), 'public')::text";

    /// <summary>Effective search path without pg_catalog (pg_temp is listed when the session created temp objects).</summary>
    public const string SearchPath = "SELECT array_remove(current_schemas(true), 'pg_catalog'::name)::text[]";

    /// <summary>User schemas with their 0-based position on the search path (null = not on it) and a cheap object count.</summary>
    public const string Schemas =
        "SELECT n.oid, n.nspname::text, array_position(array_remove(current_schemas(true), 'pg_catalog'::name), n.nspname) - 1 AS sp, " +
        "((SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition) " +
        "+ (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid))::int AS object_count " +
        "FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname";

    /// <summary>$1 = schema name; the exact name wins over a case-insensitive match.</summary>
    public const string SchemaOid =
        "SELECT oid, nspname::text FROM pg_namespace WHERE lower(nspname) = lower($1) ORDER BY (nspname = $1) DESC LIMIT 1";

    public const string Relations =
        "SELECT c.oid, c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class') " +
        "FROM pg_class c WHERE c.relnamespace = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition ORDER BY c.relname";

    /// <summary>All columns of the schema's relations: identity/serial (flag 1), generated (flag 2), default, comment.</summary>
    public const string Columns =
        "SELECT a.attrelid, a.attnum, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, " +
        "a.attidentity IN ('a','d') AS is_identity, a.attgenerated = 's' AS is_generated, pg_get_expr(d.adbin, d.adrelid) AS default_expr, " +
        "col_description(a.attrelid, a.attnum), COALESCE(pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%', false) AS is_serial " +
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
        "LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
        "WHERE c.relnamespace = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped " +
        "ORDER BY a.attrelid, a.attnum";

    public const string KeyConstraints =
        "SELECT con.conrelid, con.conname::text, con.contype::text, " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols " +
        "FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid " +
        "WHERE c.relnamespace = $1 AND con.contype IN ('p','u') ORDER BY con.conrelid, con.contype, con.conname";

    private const string ForeignKeySelect =
        "SELECT con.oid, con.conname::text, rn.nspname::text, rc.relname::text, fn.nspname::text, fc.relname::text, " +
        "con.confdeltype::text, con.confupdtype::text, " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols, " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS ref_cols, " +
        "con.conrelid, con.confrelid " +
        "FROM pg_constraint con JOIN pg_class rc ON rc.oid = con.conrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace " +
        "JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace " +
        "WHERE con.contype = 'f' ";

    /// <summary>Foreign keys in both directions: rows whose referencing or referenced table is in schema $1.</summary>
    public const string ForeignKeys = ForeignKeySelect + "AND (rc.relnamespace = $1 OR fc.relnamespace = $1) ORDER BY rc.relname, con.conname";

    /// <summary>Foreign keys of relation $1 (outgoing) or referencing it (incoming).</summary>
    public const string RelationForeignKeys = ForeignKeySelect + "AND (con.conrelid = $1 OR con.confrelid = $1) ORDER BY rc.relname, con.conname";

    /// <summary>Functions, procedures, aggregates and window functions (one row per overload).</summary>
    public const string Routines =
        "SELECT p.oid, p.proname::text, p.prokind::text, p.proretset, pg_get_function_result(p.oid), obj_description(p.oid, 'pg_proc'), " +
        "l.lanname::text, p.pronargdefaults, p.proargnames, " +
        "COALESCE(p.proargmodes::text[], array_fill('i'::text, ARRAY[p.pronargs::int])) AS modes, " +
        "(SELECT array_agg(format_type(u.t, NULL) ORDER BY u.ord) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY u(t, ord)) AS arg_types, " +
        "t.typrelid, t.typtype::text, format_type(p.prorettype, NULL) " +
        "FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang JOIN pg_type t ON t.oid = p.prorettype " +
        "WHERE p.pronamespace = $1 AND p.prokind IN ('f','p','a','w') ORDER BY p.proname, p.oid";

    /// <summary>Columns of the relations that set-returning functions of schema $1 return (RETURNS SETOF table).</summary>
    public const string RoutineRowColumns =
        "SELECT p.oid, a.attname::text, format_type(a.atttypid, a.atttypmod) " +
        "FROM pg_proc p JOIN pg_type t ON t.oid = p.prorettype JOIN pg_attribute a ON a.attrelid = t.typrelid " +
        "WHERE p.pronamespace = $1 AND t.typrelid <> 0 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY p.oid, a.attnum";

    public const string Sequences =
        "SELECT c.oid, c.relname::text, obj_description(c.oid, 'pg_class'), format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, " +
        "s.seqmin, s.seqmax, s.seqcycle, s.seqcache, " +
        "(SELECT d.refobjid::regclass::text || '.' || quote_ident(a.attname) FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid " +
        " WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i') LIMIT 1) AS owned_by " +
        "FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE c.relnamespace = $1 ORDER BY c.relname";

    /// <summary>Enums, domains, standalone composite types and ranges of schema $1.</summary>
    public const string Types =
        "SELECT t.oid, t.typname::text, t.typtype::text, obj_description(t.oid, 'pg_type'), " +
        "CASE WHEN t.typtype = 'e' THEN (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) END AS labels, " +
        "CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base_type, t.typrelid, " +
        "CASE WHEN t.typtype = 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid) END AS range_subtype, t.typnotnull " +
        "FROM pg_type t LEFT JOIN pg_class c ON c.oid = t.typrelid " +
        "WHERE t.typnamespace = $1 AND t.typtype IN ('e','d','c','r') AND t.typcategory <> 'A' AND (t.typtype <> 'c' OR c.relkind = 'c') ORDER BY t.typname";

    public const string CompositeTypeColumns =
        "SELECT t.oid, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull " +
        "FROM pg_type t JOIN pg_attribute a ON a.attrelid = t.typrelid " +
        "WHERE t.typnamespace = $1 AND t.typtype = 'c' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY t.oid, a.attnum";

    public const string Triggers =
        "SELECT t.oid, t.tgname::text, c.relname::text, pg_get_triggerdef(t.oid, true), obj_description(t.oid, 'pg_trigger') " +
        "FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = $1 AND NOT t.tgisinternal ORDER BY c.relname, t.tgname";

    // ------------------------------------------------------------------ object level ($1 = schema name, $2 = object name)

    public const string FindRelation =
        "SELECT c.oid, c.relkind::text, c.relname::text, n.nspname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE lower(n.nspname) = lower($1) AND lower(c.relname) = lower($2) AND c.relkind IN ('r','p','v','m','f','S') " +
        "ORDER BY (n.nspname = $1 AND c.relname = $2) DESC, (c.relname = $2) DESC LIMIT 1";

    public const string FindRoutines =
        "SELECT p.oid, p.prokind::text, p.proname::text, n.nspname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE lower(n.nspname) = lower($1) AND lower(p.proname) = lower($2) ORDER BY (p.proname = $2) DESC, p.oid";

    public const string FindType =
        "SELECT t.oid, t.typtype::text, t.typname::text, n.nspname::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace " +
        "WHERE lower(n.nspname) = lower($1) AND lower(t.typname) = lower($2) AND t.typtype IN ('e','d','c','r') AND t.typcategory <> 'A' " +
        "ORDER BY (t.typname = $2) DESC LIMIT 1";

    public const string FindTrigger =
        "SELECT t.oid, t.tgfoid, c.relname::text, n.nspname::text, t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE lower(n.nspname) = lower($1) AND lower(t.tgname) = lower($2) AND NOT t.tgisinternal " +
        "ORDER BY (t.tgname = $2) DESC LIMIT 1";

    // ------------------------------------------------------------------ details ($1 = relation oid)

    public const string RelationColumns =
        "SELECT a.attnum, a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, a.attidentity::text, a.attgenerated::text, " +
        "pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), " +
        "CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN (SELECT quote_ident(co.collname) FROM pg_collation co WHERE co.oid = a.attcollation) END, " +
        "(SELECT s.seqstart FROM pg_sequence s WHERE s.seqrelid = pg_get_serial_sequence(a.attrelid::regclass::text, a.attname)::regclass) AS id_start, " +
        "(SELECT s.seqincrement FROM pg_sequence s WHERE s.seqrelid = pg_get_serial_sequence(a.attrelid::regclass::text, a.attname)::regclass) AS id_inc " +
        "FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
        "WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum";

    public const string RelationIndexes =
        "SELECT ic.relname::text, i.indisunique, i.indisprimary, am.amname::text, i.indnkeyatts, pg_get_indexdef(i.indexrelid), " +
        "pg_get_expr(i.indpred, i.indrelid), " +
        "(SELECT array_agg(COALESCE(a.attname::text, pg_get_indexdef(i.indexrelid, k.ord::int, true)) ORDER BY k.ord) " +
        " FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols, " +
        "(SELECT array_agg((o.opt & 1) = 1 ORDER BY o.ord) FROM unnest(i.indoption::int2[]) WITH ORDINALITY o(opt, ord)) AS descs, " +
        "EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p','u','x')) AS backs_constraint " +
        "FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam " +
        "WHERE i.indrelid = $1 ORDER BY ic.relname";

    public const string RelationConstraints =
        "SELECT con.conname::text, con.contype::text, pg_get_constraintdef(con.oid, true), " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) " +
        "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols, con.convalidated " +
        "FROM pg_constraint con WHERE con.conrelid = $1 AND con.contype IN ('p','u','c','f','x') " +
        "ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, con.conname";

    public const string RelationTriggers =
        "SELECT t.tgname::text, pg_get_triggerdef(t.oid, true), t.tgfoid FROM pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname";

    public const string RelationInfo =
        "SELECT c.relname::text, n.nspname::text, c.relkind::text, c.relpersistence::text, obj_description(c.oid, 'pg_class'), " +
        "CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, c.reloptions::text[], " +
        "CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, " +
        "CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1";

    public const string ForeignTableInfo =
        "SELECT s.srvname::text, ft.ftoptions::text[] FROM pg_foreign_table ft JOIN pg_foreign_server s ON s.oid = ft.ftserver WHERE ft.ftrelid = $1";

    /// <summary>$1 = routine oid.</summary>
    public const string RoutineDetail =
        "SELECT p.proname::text, p.prokind::text, p.pronargdefaults, p.proargnames, " +
        "COALESCE(p.proargmodes::text[], array_fill('i'::text, ARRAY[p.pronargs::int])) AS modes, " +
        "(SELECT array_agg(format_type(u.t, NULL) ORDER BY u.ord) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY u(t, ord)) AS arg_types, " +
        "pg_get_function_result(p.oid), pg_get_function_identity_arguments(p.oid), obj_description(p.oid, 'pg_proc') " +
        "FROM pg_proc p WHERE p.oid = $1";

    /// <summary>$1 = function oid (fails with 42809 for aggregates).</summary>
    public const string FunctionDefinition = "SELECT pg_get_functiondef($1)";

    /// <summary>$1 = aggregate oid.</summary>
    public const string AggregateDefinition =
        "SELECT pg_get_function_identity_arguments(a.aggfnoid), a.aggtransfn::regproc::text, format_type(a.aggtranstype, NULL), " +
        "NULLIF(a.aggfinalfn::oid, 0)::regproc::text, a.agginitval, NULLIF(a.aggcombinefn::oid, 0)::regproc::text " +
        "FROM pg_aggregate a WHERE a.aggfnoid = $1";

    /// <summary>$1 = sequence oid.</summary>
    public const string SequenceDefinition =
        "SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcycle, s.seqcache, " +
        "(SELECT d.refobjid::regclass::text || '.' || quote_ident(a.attname) FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid " +
        " WHERE d.classid = 'pg_class'::regclass AND d.objid = s.seqrelid AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a' LIMIT 1) AS owned_by, " +
        "obj_description(s.seqrelid, 'pg_class') FROM pg_sequence s WHERE s.seqrelid = $1";

    /// <summary>$1 = type oid.</summary>
    public const string TypeDetail =
        "SELECT t.typname::text, t.typtype::text, obj_description(t.oid, 'pg_type'), " +
        "(SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), " +
        "format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault, t.typrelid, " +
        "(SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid) " +
        "FROM pg_type t WHERE t.oid = $1";

    /// <summary>$1 = domain oid.</summary>
    public const string DomainConstraints =
        "SELECT con.conname::text, pg_get_constraintdef(con.oid, true) FROM pg_constraint con WHERE con.contypid = $1 ORDER BY con.conname";

    /// <summary>$1 = composite relation oid (pg_type.typrelid).</summary>
    public const string CompositeAttributes =
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum";

    /// <summary>$1 = trigger oid.</summary>
    public const string TriggerDefinition =
        "SELECT pg_get_triggerdef(t.oid, true), pg_get_functiondef(t.tgfoid), obj_description(t.oid, 'pg_trigger') FROM pg_trigger t WHERE t.oid = $1";

    /// <summary>Every query, for the syntax smoke test against a live server and the lexer balance test.</summary>
    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        [nameof(ServerInfo)] = ServerInfo, [nameof(Databases)] = Databases, [nameof(CurrentDatabase)] = CurrentDatabase,
        [nameof(DefaultSchema)] = DefaultSchema, [nameof(SearchPath)] = SearchPath, [nameof(Schemas)] = Schemas, [nameof(SchemaOid)] = SchemaOid,
        [nameof(Relations)] = Relations, [nameof(Columns)] = Columns, [nameof(KeyConstraints)] = KeyConstraints,
        [nameof(ForeignKeys)] = ForeignKeys, [nameof(RelationForeignKeys)] = RelationForeignKeys, [nameof(Routines)] = Routines,
        [nameof(RoutineRowColumns)] = RoutineRowColumns, [nameof(Sequences)] = Sequences, [nameof(Types)] = Types,
        [nameof(CompositeTypeColumns)] = CompositeTypeColumns, [nameof(Triggers)] = Triggers, [nameof(FindRelation)] = FindRelation,
        [nameof(FindRoutines)] = FindRoutines, [nameof(FindType)] = FindType, [nameof(FindTrigger)] = FindTrigger,
        [nameof(RelationColumns)] = RelationColumns, [nameof(RelationIndexes)] = RelationIndexes, [nameof(RelationConstraints)] = RelationConstraints,
        [nameof(RelationTriggers)] = RelationTriggers, [nameof(RelationInfo)] = RelationInfo, [nameof(ForeignTableInfo)] = ForeignTableInfo,
        [nameof(RoutineDetail)] = RoutineDetail, [nameof(FunctionDefinition)] = FunctionDefinition, [nameof(AggregateDefinition)] = AggregateDefinition,
        [nameof(SequenceDefinition)] = SequenceDefinition, [nameof(TypeDetail)] = TypeDetail, [nameof(DomainConstraints)] = DomainConstraints,
        [nameof(CompositeAttributes)] = CompositeAttributes, [nameof(TriggerDefinition)] = TriggerDefinition,
    };
}
