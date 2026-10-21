namespace DbStudio.Providers.SqlServer;

/// <summary>
/// T-SQL of the object browser (WP3): dependencies and the Objects tab list. Plain rows only (no STRING_AGG, no
/// OBJECT_SCHEMA_NAME on the other side of a reference): runs on SQL Server 2008+ / compatibility level 100 and with
/// odd ownership chains. Every string here is parsed with ScriptDom by the unit tests.
/// </summary>
public static class SqlServerDependencyQueries
{
    /// <summary>@schema, @name → object_id, type (triggers included; they live in sys.objects too).</summary>
    public const string FindObject =
        "SELECT TOP (1) o.object_id, o.type, s.name, o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "WHERE s.name=@schema AND o.name=@name AND o.is_ms_shipped=0 ORDER BY CASE WHEN o.name COLLATE Latin1_General_BIN=@name THEN 0 ELSE 1 END";

    public const string DefaultSchema = "SELECT SCHEMA_NAME()";

    /// <summary>Objects the root's definition references (views, routines, triggers; same database only).</summary>
    public const string Uses =
        "SELECT DISTINCT o.type, s.name, o.name, d.is_schema_bound_reference " +
        "FROM sys.sql_expression_dependencies d JOIN sys.objects o ON o.object_id=d.referenced_id JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "WHERE d.referencing_id=@id AND d.referencing_class=1 AND d.referenced_id IS NOT NULL AND d.referenced_id<>@id";

    /// <summary>Views, routines and triggers whose definition references the root.</summary>
    public const string UsedBy =
        "SELECT DISTINCT o.type, s.name, o.name, d.is_schema_bound_reference " +
        "FROM sys.sql_expression_dependencies d JOIN sys.objects o ON o.object_id=d.referencing_id JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "WHERE d.referenced_id=@id AND d.referencing_class=1 AND d.referencing_id<>@id";

    private const string FkColumns =
        "FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id " +
        "JOIN sys.objects po ON po.object_id=fk.parent_object_id JOIN sys.schemas ps ON ps.schema_id=po.schema_id " +
        "JOIN sys.objects ro ON ro.object_id=fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=ro.schema_id " +
        "JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id " +
        "JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id ";

    /// <summary>Foreign keys of the root (outgoing): constraint, referenced schema/table, column pair, disabled.</summary>
    public const string ForeignKeysOut =
        "SELECT fk.name, rs.name, ro.name, pc.name, rc.name, fk.is_disabled " + FkColumns +
        "WHERE fk.parent_object_id=@id ORDER BY fk.name, fkc.constraint_column_id";

    /// <summary>Foreign keys referencing the root (incoming): constraint, referencing schema/table, column pair, disabled.</summary>
    public const string ForeignKeysIn =
        "SELECT fk.name, ps.name, po.name, pc.name, rc.name, fk.is_disabled " + FkColumns +
        "WHERE fk.referenced_object_id=@id ORDER BY ps.name, po.name, fk.name, fkc.constraint_column_id";

    /// <summary>DML triggers on the root table or view.</summary>
    public const string Triggers =
        "SELECT t.object_id, s.name, t.name, t.is_disabled, t.is_instead_of_trigger " +
        "FROM sys.triggers t JOIN sys.objects o ON o.object_id=t.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "WHERE t.parent_id=@id ORDER BY t.name";

    /// <summary>Events of the root table's triggers (one row per trigger and event).</summary>
    public const string TriggerEvents =
        "SELECT te.object_id, te.type_desc FROM sys.trigger_events te JOIN sys.triggers t ON t.object_id=te.object_id WHERE t.parent_id=@id";

    /// <summary>The table or view a trigger fires on.</summary>
    public const string TriggerParent =
        "SELECT o.type, s.name, o.name FROM sys.triggers t JOIN sys.objects o ON o.object_id=t.parent_id JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "WHERE t.object_id=@id";

    /// <summary>Objects tab: every user object of one schema (@schema) or of the whole database (@schema NULL).</summary>
    public const string ObjectList =
        "SELECT o.object_id, o.type, s.name, o.name, o.create_date, o.modify_date, CAST(ep.value AS nvarchar(4000)) AS comment " +
        "FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id " +
        "LEFT JOIN sys.extended_properties ep ON ep.major_id=o.object_id AND ep.minor_id=0 AND ep.class=1 AND ep.name='MS_Description' " +
        "WHERE o.is_ms_shipped=0 AND o.type IN (" + SqlServerCatalogQueries.ObjectTypeList + ") AND (@schema IS NULL OR s.name=@schema) AND " +
        SqlServerCatalogQueries.SchemaFilter;

    /// <summary>Row counts and reserved bytes per object (needs VIEW DATABASE STATE).</summary>
    public const string PartitionStats =
        "SELECT ps.object_id, SUM(CASE WHEN ps.index_id IN (0,1) THEN ps.row_count ELSE 0 END), SUM(ps.reserved_page_count) * 8192 " +
        "FROM sys.dm_db_partition_stats ps GROUP BY ps.object_id";

    /// <summary>Fallback without VIEW DATABASE STATE: row counts only (sys.partitions is visible with metadata rights).</summary>
    public const string PartitionRows =
        "SELECT p.object_id, SUM(p.rows) FROM sys.partitions p WHERE p.index_id IN (0,1) GROUP BY p.object_id";

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        [nameof(FindObject)] = FindObject, [nameof(DefaultSchema)] = DefaultSchema, [nameof(Uses)] = Uses, [nameof(UsedBy)] = UsedBy,
        [nameof(ForeignKeysOut)] = ForeignKeysOut, [nameof(ForeignKeysIn)] = ForeignKeysIn, [nameof(Triggers)] = Triggers,
        [nameof(TriggerEvents)] = TriggerEvents, [nameof(TriggerParent)] = TriggerParent, [nameof(ObjectList)] = ObjectList,
        [nameof(PartitionStats)] = PartitionStats, [nameof(PartitionRows)] = PartitionRows,
    };
}
