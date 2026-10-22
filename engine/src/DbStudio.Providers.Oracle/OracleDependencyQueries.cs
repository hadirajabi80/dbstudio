namespace DbStudio.Providers.Oracle;

/// <summary>
/// Data dictionary SQL of the object browser (WP3): <c>ALL_DEPENDENCIES</c>, <c>ALL_CONSTRAINTS</c> (type R),
/// <c>ALL_TRIGGERS</c> and the Objects tab list (<c>ALL_OBJECTS</c> + <c>ALL_TABLES.NUM_ROWS</c>). Binds by name.
/// References to SYS / PUBLIC (STANDARD, DBMS_OUTPUT, public synonyms) are left out: they are noise in a dependency view.
/// </summary>
public static class OracleDependencyQueries
{
    public const string CurrentSchema = "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual";

    /// <summary>:owner, :name → object types (a package has PACKAGE and PACKAGE BODY).</summary>
    public const string FindObject =
        "SELECT object_type, object_name FROM all_objects WHERE owner=:owner AND object_name=:name AND generated='N'";

    /// <summary>What the object (all its parts, e.g. spec and body) references.</summary>
    public const string Uses =
        "SELECT DISTINCT referenced_owner, referenced_name, referenced_type FROM all_dependencies " +
        "WHERE owner=:owner AND name=:name AND referenced_owner NOT IN ('SYS','PUBLIC') AND referenced_type IN " +
        "('TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','SYNONYM','TYPE','TRIGGER')";

    /// <summary>Who references the object.</summary>
    public const string UsedBy =
        "SELECT DISTINCT owner, name, type FROM all_dependencies WHERE referenced_owner=:owner AND referenced_name=:name";

    /// <summary>FKs of table :name (outgoing): constraint, referenced owner/table, column pair, status.</summary>
    public const string ForeignKeysOut =
        "SELECT c.constraint_name, rc.owner, rc.table_name, cc.column_name, rcc.column_name, c.status FROM all_constraints c " +
        "JOIN all_constraints rc ON rc.owner=c.r_owner AND rc.constraint_name=c.r_constraint_name " +
        "JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name " +
        "JOIN all_cons_columns rcc ON rcc.owner=rc.owner AND rcc.constraint_name=rc.constraint_name AND rcc.position=cc.position " +
        "WHERE c.constraint_type='R' AND c.owner=:owner AND c.table_name=:name ORDER BY c.constraint_name, cc.position";

    /// <summary>FKs referencing table :name (incoming): constraint, referencing owner/table, column pair, status.</summary>
    public const string ForeignKeysIn =
        "SELECT c.constraint_name, c.owner, c.table_name, cc.column_name, rcc.column_name, c.status FROM all_constraints c " +
        "JOIN all_constraints rc ON rc.owner=c.r_owner AND rc.constraint_name=c.r_constraint_name " +
        "JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name " +
        "JOIN all_cons_columns rcc ON rcc.owner=rc.owner AND rcc.constraint_name=rc.constraint_name AND rcc.position=cc.position " +
        "WHERE c.constraint_type='R' AND rc.owner=:owner AND rc.table_name=:name ORDER BY c.owner, c.table_name, c.constraint_name, cc.position";

    /// <summary>Triggers on table/view :name.</summary>
    public const string Triggers =
        "SELECT owner, trigger_name, trigger_type, triggering_event, status FROM all_triggers WHERE table_owner=:owner AND table_name=:name ORDER BY trigger_name";

    /// <summary>The table/view trigger :name fires on.</summary>
    public const string TriggerParent =
        "SELECT table_owner, table_name, base_object_type FROM all_triggers WHERE owner=:owner AND trigger_name=:name";

    /// <summary>Objects tab: objects of :owner with row estimates, segment sizes (own schema only) and comments.</summary>
    public const string ObjectList =
        "SELECT o.object_name, o.object_type, o.created, o.last_ddl_time, t.num_rows, s.bytes, c.comments FROM all_objects o " +
        "LEFT JOIN all_tables t ON t.owner=o.owner AND t.table_name=o.object_name AND o.object_type='TABLE' " +
        "LEFT JOIN (SELECT segment_name, SUM(bytes) bytes FROM user_segments GROUP BY segment_name) s ON s.segment_name=o.object_name AND o.owner=USER " +
        "AND o.object_type IN ('TABLE','MATERIALIZED VIEW') " +
        "LEFT JOIN all_tab_comments c ON c.owner=o.owner AND c.table_name=o.object_name AND o.object_type IN ('TABLE','VIEW') " +
        "WHERE o.owner=:owner AND o.object_type IN (" + OracleCatalogQueries.ObjectTypeList + ") AND o.object_name NOT LIKE 'BIN$%' AND o.generated='N' " +
        "AND (o.object_type<>'TABLE' OR o.object_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner=:owner))";

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        [nameof(CurrentSchema)] = CurrentSchema, [nameof(FindObject)] = FindObject, [nameof(Uses)] = Uses, [nameof(UsedBy)] = UsedBy,
        [nameof(ForeignKeysOut)] = ForeignKeysOut, [nameof(ForeignKeysIn)] = ForeignKeysIn, [nameof(Triggers)] = Triggers,
        [nameof(TriggerParent)] = TriggerParent, [nameof(ObjectList)] = ObjectList,
    };
}
