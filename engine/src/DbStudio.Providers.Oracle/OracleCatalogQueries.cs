namespace DbStudio.Providers.Oracle;

/// <summary>
/// Catalog SQL for Oracle (docs/PLAN.md 2.6). Every query over an ALL_ view is bound to an owner (:owner or a
/// correlated owner column) so the dictionary is never scanned across schemas; unit tests enforce this.
/// </summary>
public static class OracleCatalogQueries
{
    public const string ObjectTypeList = "'TABLE','VIEW','MATERIALIZED VIEW','PROCEDURE','FUNCTION','PACKAGE','SEQUENCE','SYNONYM','TYPE','TRIGGER'";

    /// <summary>Oracle-maintained accounts hidden on 11g, where ALL_USERS.ORACLE_MAINTAINED does not exist.</summary>
    public static readonly string[] MaintainedSchemas =
    [
        "SYS", "SYSTEM", "XDB", "OUTLN", "DBSNMP", "APPQOSSYS", "ANONYMOUS", "AUDSYS", "CTXSYS", "DBSFWUSER", "DIP", "DVF", "DVSYS",
        "EXFSYS", "FLOWS_FILES", "GGSYS", "GSMADMIN_INTERNAL", "GSMCATUSER", "GSMUSER", "LBACSYS", "MDDATA", "MDSYS", "MGMT_VIEW",
        "OJVMSYS", "OLAPSYS", "ORACLE_OCM", "ORDDATA", "ORDPLUGINS", "ORDSYS", "OWBSYS", "OWBSYS_AUDIT", "REMOTE_SCHEDULER_AGENT",
        "SI_INFORMTN_SCHEMA", "SPATIAL_CSW_ADMIN_USR", "SPATIAL_WFS_ADMIN_USR", "SYS$UMF", "SYSBACKUP", "SYSDG", "SYSKM", "SYSMAN",
        "SYSRAC", "WMSYS", "XS$NULL", "APEX_PUBLIC_USER", "DGPDB_INT", "GSMROOTUSER", "PDBADMIN", "OPS$ORACLE",
    ];

    public const string Schemas =
        "SELECT username FROM all_users WHERE oracle_maintained='N' ORDER BY username";

    /// <summary>11g fallback; the maintained list is appended as an IN list of literals.</summary>
    public static string SchemasFallback =>
        "SELECT username FROM all_users WHERE username NOT IN (" + string.Join(",", MaintainedSchemas.Select(OracleSqlText.Literal)) +
        ") AND username NOT LIKE 'APEX\\_%' ESCAPE '\\' ORDER BY username";

    public const string CurrentSchema = "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual";

    public const string SessionInfo =
        "SELECT SYS_CONTEXT('USERENV','SESSION_USER'), SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), " +
        "SYS_CONTEXT('USERENV','DB_NAME'), SYS_CONTEXT('USERENV','SERVER_HOST') FROM dual";

    public const string VersionBanner = "SELECT banner FROM v$version WHERE ROWNUM = 1";

    public const string VersionFallback =
        "SELECT product || ' ' || version FROM product_component_version WHERE ROWNUM = 1";

    public const string Objects =
        "SELECT object_name, object_type, object_id, status, last_ddl_time FROM all_objects " +
        "WHERE owner=:owner AND object_type IN (" + ObjectTypeList + ") AND object_name NOT LIKE 'BIN$%' AND generated='N' " +
        "AND (object_type<>'TABLE' OR object_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner=:owner))";

    public const string TableComments =
        "SELECT table_name, comments FROM all_tab_comments WHERE owner=:owner AND comments IS NOT NULL";

    public const string ColumnComments =
        "SELECT table_name, column_name, comments FROM all_col_comments WHERE owner=:owner AND comments IS NOT NULL";

    public const string Columns =
        "SELECT table_name, column_id, column_name, data_type, data_type_owner, data_length, char_length, char_used, data_precision, data_scale, " +
        "nullable, virtual_column, identity_column, hidden_column FROM all_tab_cols " +
        "WHERE owner=:owner AND hidden_column='NO' AND column_id IS NOT NULL ORDER BY table_name, column_id";

    /// <summary>Pre-12c fallback (no IDENTITY_COLUMN).</summary>
    public const string ColumnsNoIdentity =
        "SELECT table_name, column_id, column_name, data_type, data_type_owner, data_length, char_length, char_used, data_precision, data_scale, " +
        "nullable, virtual_column, 'NO' AS identity_column, hidden_column FROM all_tab_cols " +
        "WHERE owner=:owner AND hidden_column='NO' AND column_id IS NOT NULL ORDER BY table_name, column_id";

    /// <summary>12c+: identity columns GENERATED ALWAYS (never written by INSERT/UPDATE); ORA-00942 on older servers.</summary>
    public const string IdentityAlways =
        "SELECT table_name, column_name FROM all_tab_identity_cols WHERE owner=:owner AND generation_type='ALWAYS'";

    public const string Constraints =
        "SELECT c.constraint_name, c.constraint_type, c.table_name, c.r_owner, c.r_constraint_name, c.status, cc.column_name, cc.position " +
        "FROM all_constraints c JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name AND cc.table_name=c.table_name " +
        "WHERE c.owner=:owner AND c.constraint_type IN ('P','U','R') ORDER BY c.table_name, c.constraint_name, cc.position";

    /// <summary>Referenced key columns of one owner; the IN list (:c0..:cN, at most 1000) is appended by <see cref="ReferencedColumns"/>.</summary>
    public const string ReferencedColumnsPrefix =
        "SELECT cc.owner, cc.constraint_name, cc.table_name, cc.column_name, cc.position FROM all_cons_columns cc WHERE cc.owner=:owner AND cc.constraint_name IN (";

    public static string ReferencedColumns(int count) =>
        ReferencedColumnsPrefix + string.Join(",", Enumerable.Range(0, count).Select(i => ":c" + i)) + ") ORDER BY cc.constraint_name, cc.position";

    public const string Procedures =
        "SELECT object_name, procedure_name, subprogram_id, overload, object_type FROM all_procedures " +
        "WHERE owner=:owner AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE') AND (object_type<>'PACKAGE' OR procedure_name IS NOT NULL)";

    public const string Arguments =
        "SELECT package_name, object_name, subprogram_id, overload, argument_name, position, sequence, data_type, type_owner, type_name, " +
        "in_out, defaulted, data_level, pls_type, type_subname FROM all_arguments WHERE owner=:owner AND data_level=0 " +
        "ORDER BY package_name, subprogram_id, overload, sequence";

    public const string Synonyms =
        "SELECT s.synonym_name, s.table_owner, s.table_name, s.db_link, " +
        "(SELECT MIN(o.object_type) FROM all_objects o WHERE o.owner=s.table_owner AND o.object_name=s.table_name " +
        "AND o.object_type NOT IN ('PACKAGE BODY','TYPE BODY','INDEX','LOB')) AS target_type " +
        "FROM all_synonyms s WHERE s.owner=:owner";

    public const string PublicSynonym =
        "SELECT s.synonym_name, s.table_owner, s.table_name, s.db_link, " +
        "(SELECT MIN(o.object_type) FROM all_objects o WHERE o.owner=s.table_owner AND o.object_name=s.table_name " +
        "AND o.object_type NOT IN ('PACKAGE BODY','TYPE BODY','INDEX','LOB')) AS target_type " +
        "FROM all_synonyms s WHERE s.owner='PUBLIC' AND s.synonym_name=:name";

    public const string Sequences =
        "SELECT sequence_name, min_value, max_value, increment_by, cycle_flag, order_flag, cache_size, last_number " +
        "FROM all_sequences WHERE sequence_owner=:owner AND sequence_name=:name";

    public const string ObjectByName =
        "SELECT object_type, created, last_ddl_time, status FROM all_objects " +
        "WHERE owner=:owner AND object_name=:name AND object_type NOT IN ('PACKAGE BODY','TYPE BODY','INDEX','LOB') ORDER BY object_type";

    public const string DetailColumns =
        "SELECT column_id, column_name, data_type, data_type_owner, data_length, char_length, char_used, data_precision, data_scale, nullable, data_default " +
        "FROM all_tab_columns WHERE owner=:owner AND table_name=:name ORDER BY column_id";

    public const string DetailColumnFlags =
        "SELECT column_name, virtual_column, identity_column FROM all_tab_cols WHERE owner=:owner AND table_name=:name";

    public const string DetailColumnFlagsNoIdentity =
        "SELECT column_name, virtual_column, 'NO' AS identity_column FROM all_tab_cols WHERE owner=:owner AND table_name=:name";

    public const string DetailColumnComments =
        "SELECT column_name, comments FROM all_col_comments WHERE owner=:owner AND table_name=:name AND comments IS NOT NULL";

    public const string DetailIndexes =
        "SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position, ic.descend " +
        "FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner=i.owner AND ic.index_name=i.index_name " +
        "WHERE i.table_owner=:owner AND i.table_name=:name AND ic.index_owner=i.owner ORDER BY i.index_name, ic.column_position";

    public const string DetailKeys =
        "SELECT c.constraint_name, c.constraint_type, c.r_owner, c.r_constraint_name, cc.column_name, cc.position, c.index_name, c.delete_rule " +
        "FROM all_constraints c JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name AND cc.table_name=c.table_name " +
        "WHERE c.owner=:owner AND c.table_name=:name AND c.constraint_type IN ('P','U','R') ORDER BY c.constraint_name, cc.position";

    public const string DetailReferencedBy =
        "SELECT c.owner, c.table_name, c.constraint_name, cc.column_name, cc.position " +
        "FROM all_constraints c JOIN all_cons_columns cc ON cc.owner=c.owner AND cc.constraint_name=c.constraint_name AND cc.table_name=c.table_name " +
        "WHERE c.r_owner=:owner AND c.constraint_type='R' AND c.r_constraint_name IN " +
        "(SELECT k.constraint_name FROM all_constraints k WHERE k.owner=:owner AND k.table_name=:name AND k.constraint_type IN ('P','U')) " +
        "ORDER BY c.owner, c.table_name, c.constraint_name, cc.position";

    public const string DetailTriggers =
        "SELECT trigger_name FROM all_triggers WHERE table_owner=:owner AND table_name=:name ORDER BY trigger_name";

    public const string DetailRowCount =
        "SELECT num_rows FROM all_tables WHERE owner=:owner AND table_name=:name";

    public const string DetailArguments =
        "SELECT argument_name, position, data_type, type_owner, type_name, in_out, defaulted, pls_type, type_subname, overload " +
        "FROM all_arguments WHERE owner=:owner AND object_name=:name AND package_name IS NULL AND data_level=0 ORDER BY overload, sequence";

    public const string Source =
        "SELECT text FROM all_source WHERE owner=:owner AND name=:name AND type=:type ORDER BY line";

    public const string ViewText =
        "SELECT text FROM all_views WHERE owner=:owner AND view_name=:name";

    public const string SynonymByName =
        "SELECT table_owner, table_name, db_link FROM all_synonyms WHERE owner=:owner AND synonym_name=:name";

    public const string Errors =
        "SELECT line, position, text, attribute, type FROM all_errors WHERE owner=:owner AND name=:name AND type=:type ORDER BY sequence";

    /// <summary>All error rows for both spec and body (packages, types).</summary>
    public const string ErrorsAnyType =
        "SELECT line, position, text, attribute, type FROM all_errors WHERE owner=:owner AND name=:name ORDER BY type, sequence";

    public const string DdlTransforms =
        "BEGIN " +
        "DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SQLTERMINATOR',TRUE); " +
        "DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'PRETTY',TRUE); " +
        "DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'SEGMENT_ATTRIBUTES',FALSE); " +
        "DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM,'STORAGE',FALSE); " +
        "END;";

    public const string GetDdl = "SELECT DBMS_METADATA.GET_DDL(:type,:name,:owner) FROM dual";

    /// <summary>Every catalog query, for the owner-bind unit test.</summary>
    public static IReadOnlyDictionary<string, string> All => new Dictionary<string, string>
    {
        [nameof(Schemas)] = Schemas, [nameof(SchemasFallback)] = SchemasFallback, [nameof(CurrentSchema)] = CurrentSchema,
        [nameof(SessionInfo)] = SessionInfo, [nameof(VersionBanner)] = VersionBanner, [nameof(VersionFallback)] = VersionFallback,
        [nameof(Objects)] = Objects, [nameof(TableComments)] = TableComments, [nameof(ColumnComments)] = ColumnComments,
        [nameof(Columns)] = Columns, [nameof(ColumnsNoIdentity)] = ColumnsNoIdentity, [nameof(IdentityAlways)] = IdentityAlways, [nameof(Constraints)] = Constraints,
        [nameof(ReferencedColumns)] = ReferencedColumns(3), [nameof(Procedures)] = Procedures, [nameof(Arguments)] = Arguments,
        [nameof(Synonyms)] = Synonyms, [nameof(PublicSynonym)] = PublicSynonym, [nameof(Sequences)] = Sequences,
        [nameof(ObjectByName)] = ObjectByName, [nameof(DetailColumns)] = DetailColumns, [nameof(DetailColumnFlags)] = DetailColumnFlags,
        [nameof(DetailColumnFlagsNoIdentity)] = DetailColumnFlagsNoIdentity, [nameof(DetailColumnComments)] = DetailColumnComments,
        [nameof(DetailIndexes)] = DetailIndexes, [nameof(DetailKeys)] = DetailKeys, [nameof(DetailReferencedBy)] = DetailReferencedBy,
        [nameof(DetailTriggers)] = DetailTriggers, [nameof(DetailRowCount)] = DetailRowCount, [nameof(DetailArguments)] = DetailArguments,
        [nameof(Source)] = Source, [nameof(ViewText)] = ViewText, [nameof(SynonymByName)] = SynonymByName, [nameof(Errors)] = Errors,
        [nameof(ErrorsAnyType)] = ErrorsAnyType, [nameof(DdlTransforms)] = DdlTransforms, [nameof(GetDdl)] = GetDdl,
    };
}
