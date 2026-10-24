namespace DbStudio.Providers.MySql;

/// <summary>
/// information_schema queries of the MySQL / MariaDB catalog reader (plan-batch3 WP-MY). <c>@p0</c> = the database
/// (schema), <c>@p1</c> = an object name. System databases (mysql, sys, performance_schema, information_schema) are never
/// listed as schemas.
/// </summary>
public static class MySqlCatalogQueries
{
    public const string SystemSchemas = "'mysql','sys','performance_schema','information_schema'";

    public const string Schemas =
        "SELECT s.SCHEMA_NAME, (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) " +
        "FROM information_schema.SCHEMATA s WHERE s.SCHEMA_NAME NOT IN (" + SystemSchemas + ") ORDER BY s.SCHEMA_NAME";

    public const string Tables =
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 ORDER BY TABLE_NAME";

    public const string Columns =
        "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION, COLUMN_DEFAULT, DATA_TYPE, " +
        "GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME " +
        "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @p0 ORDER BY TABLE_NAME, ORDINAL_POSITION";

    public const string TableColumns =
        "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION, COLUMN_DEFAULT, DATA_TYPE, " +
        "GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME " +
        "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1 ORDER BY ORDINAL_POSITION";

    /// <summary>PRIMARY KEY / UNIQUE / FOREIGN KEY columns of a schema's tables (FKs with their referenced columns).</summary>
    public const string KeyColumns =
        "SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, " +
        "k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME " +
        "FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.TABLE_CONSTRAINTS c " +
        "ON c.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME " +
        "WHERE k.TABLE_SCHEMA = @p0 ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

    public const string TableKeyColumns =
        "SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, " +
        "k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME " +
        "FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.TABLE_CONSTRAINTS c " +
        "ON c.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME " +
        "WHERE k.TABLE_SCHEMA = @p0 AND k.TABLE_NAME = @p1 ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

    /// <summary>Foreign keys of other tables (any schema) that reference a table: (schema, table, constraint, column, position).</summary>
    public const string ReferencingKeys =
        "SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_COLUMN_NAME " +
        "FROM information_schema.KEY_COLUMN_USAGE k WHERE k.REFERENCED_TABLE_SCHEMA = @p0 AND k.REFERENCED_TABLE_NAME = @p1 " +
        "ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION";

    public const string ReferencingSchemas =
        "SELECT DISTINCT TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = @p0 AND TABLE_SCHEMA <> @p0";

    /// <summary>ON DELETE / ON UPDATE of a table's foreign keys.</summary>
    public const string ReferentialActions =
        "SELECT CONSTRAINT_NAME, DELETE_RULE, UPDATE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS " +
        "WHERE CONSTRAINT_SCHEMA = @p0 AND TABLE_NAME = @p1";

    /// <summary>CHECK constraints (MySQL 8.0.16+, MariaDB 10.2+).</summary>
    public const string CheckConstraints =
        "SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc " +
        "JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME " +
        "WHERE tc.TABLE_SCHEMA = @p0 AND tc.TABLE_NAME = @p1 AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY tc.CONSTRAINT_NAME";

    /// <summary>MariaDB keeps CHECK_CONSTRAINTS.TABLE_NAME (and column-level checks) without a TABLE_CONSTRAINTS row on older versions.</summary>
    public const string CheckConstraintsMariaDb =
        "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS " +
        "WHERE CONSTRAINT_SCHEMA = @p0 AND TABLE_NAME = @p1 ORDER BY CONSTRAINT_NAME";

    public const string Indexes =
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE, SUB_PART, COLLATION, INDEX_COMMENT " +
        "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1 ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX";

    public const string TableInfo =
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, ENGINE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, CREATE_TIME, UPDATE_TIME, " +
        "TABLE_COLLATION, AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1";

    public const string Routines =
        "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_COMMENT FROM information_schema.ROUTINES " +
        "WHERE ROUTINE_SCHEMA = @p0 ORDER BY ROUTINE_NAME";

    public const string Parameters =
        "SELECT SPECIFIC_NAME, ROUTINE_TYPE, PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER, ORDINAL_POSITION FROM information_schema.PARAMETERS " +
        "WHERE SPECIFIC_SCHEMA = @p0 ORDER BY SPECIFIC_NAME, ORDINAL_POSITION";

    public const string RoutineParameters =
        "SELECT SPECIFIC_NAME, ROUTINE_TYPE, PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER, ORDINAL_POSITION FROM information_schema.PARAMETERS " +
        "WHERE SPECIFIC_SCHEMA = @p0 AND SPECIFIC_NAME = @p1 ORDER BY ORDINAL_POSITION";

    public const string FindRoutine =
        "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION, CREATED, LAST_ALTERED FROM information_schema.ROUTINES " +
        "WHERE ROUTINE_SCHEMA = @p0 AND ROUTINE_NAME = @p1";

    public const string Triggers =
        "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS " +
        "WHERE TRIGGER_SCHEMA = @p0 ORDER BY TRIGGER_NAME";

    public const string TableTriggers =
        "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION FROM information_schema.TRIGGERS " +
        "WHERE EVENT_OBJECT_SCHEMA = @p0 AND EVENT_OBJECT_TABLE = @p1 ORDER BY ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER";

    public const string FindTrigger =
        "SELECT TRIGGER_NAME, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT, CREATED " +
        "FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = @p0 AND TRIGGER_NAME = @p1";

    public const string Events =
        "SELECT EVENT_NAME, EVENT_COMMENT, STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0 ORDER BY EVENT_NAME";

    public const string FindEvent =
        "SELECT EVENT_NAME, EVENT_DEFINITION, STATUS, CREATED, LAST_ALTERED FROM information_schema.EVENTS WHERE EVENT_SCHEMA = @p0 AND EVENT_NAME = @p1";

    public const string CurrentDatabase = "SELECT DATABASE()";

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        [nameof(Schemas)] = Schemas, [nameof(Tables)] = Tables, [nameof(Columns)] = Columns, [nameof(TableColumns)] = TableColumns,
        [nameof(KeyColumns)] = KeyColumns, [nameof(TableKeyColumns)] = TableKeyColumns, [nameof(ReferencingKeys)] = ReferencingKeys,
        [nameof(ReferencingSchemas)] = ReferencingSchemas, [nameof(ReferentialActions)] = ReferentialActions,
        [nameof(CheckConstraints)] = CheckConstraints, [nameof(CheckConstraintsMariaDb)] = CheckConstraintsMariaDb, [nameof(Indexes)] = Indexes,
        [nameof(TableInfo)] = TableInfo, [nameof(Routines)] = Routines, [nameof(Parameters)] = Parameters,
        [nameof(RoutineParameters)] = RoutineParameters, [nameof(FindRoutine)] = FindRoutine, [nameof(Triggers)] = Triggers,
        [nameof(TableTriggers)] = TableTriggers, [nameof(FindTrigger)] = FindTrigger, [nameof(Events)] = Events, [nameof(FindEvent)] = FindEvent,
    };
}
