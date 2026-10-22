using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Microsoft.Data.SqlClient;
using SqlBatch = DbStudio.Core.Models.SqlBatch;

namespace DbStudio.Providers.SqlServer.Designer;

/// <summary>
/// SQL Server side of the designer: table models from sys.columns / sys.identity_columns / sys.computed_columns /
/// sys.default_constraints / sys.indexes / sys.foreign_keys / sys.check_constraints / MS_Description, and apply in
/// one transaction on a dedicated connection (pooling off, server errors raised as exceptions).
/// </summary>
public sealed class SqlServerDesignerDatabase : IDesignerDatabase
{
    public string ProviderId => "sqlserver";

    public const string TableQuery =
        "SELECT o.object_id, SCHEMA_NAME(o.schema_id), o.name, CAST(ep.value AS nvarchar(4000)) " +
        "FROM sys.objects o LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.class = 1 AND ep.name = 'MS_Description' " +
        "WHERE o.type = 'U' AND o.schema_id = SCHEMA_ID(@schema) AND o.name = @name";

    public const string ColumnsQuery =
        "SELECT c.column_id, c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, " +
        "CAST(ic.seed_value AS bigint), CAST(ic.increment_value AS bigint), cc.definition, cc.is_persisted, dc.name, dc.definition, " +
        "c.collation_name, CAST(ep.value AS nvarchar(4000)), t.is_user_defined, CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) " +
        "FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id " +
        "LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id " +
        "LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id " +
        "LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id " +
        "LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.class = 1 AND ep.name = 'MS_Description' " +
        "WHERE c.object_id = @oid ORDER BY c.column_id";

    public const string IndexesQuery =
        "SELECT i.index_id, i.name, i.is_primary_key, i.is_unique_constraint, i.is_unique, i.type, i.filter_definition, " +
        "ic.key_ordinal, ic.is_descending_key, ic.is_included_column, c.name " +
        "FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id " +
        "JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id " +
        "WHERE i.object_id = @oid AND i.type IN (1, 2) AND i.is_hypothetical = 0 " +
        "ORDER BY i.index_id, ic.is_included_column, ic.key_ordinal, ic.index_column_id";

    public const string ForeignKeysQuery =
        "SELECT fk.object_id, fk.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id), OBJECT_NAME(fk.referenced_object_id), " +
        "fk.delete_referential_action_desc, fk.update_referential_action_desc, fkc.constraint_column_id, " +
        "COL_NAME(fk.parent_object_id, fkc.parent_column_id), COL_NAME(fk.referenced_object_id, fkc.referenced_column_id) " +
        "FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id " +
        "WHERE fk.parent_object_id = @oid ORDER BY fk.name, fkc.constraint_column_id";

    public const string ChecksQuery =
        "SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = @oid ORDER BY name";

    public const string ViewQuery =
        "SELECT v.name, SCHEMA_NAME(v.schema_id), m.definition, v.with_check_option, OBJECTPROPERTY(v.object_id, 'IsSchemaBound') " +
        "FROM sys.views v JOIN sys.sql_modules m ON m.object_id = v.object_id WHERE v.schema_id = SCHEMA_ID(@schema) AND v.name = @name";

    public const string ContextQuery = "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), SCHEMA_NAME()";

    // ---- what an identity rebuild (DROP TABLE + rename) must carry over (features-12); @oid = OBJECT_ID of the table

    /// <summary>Foreign keys of other tables referencing the table (self references are part of the table model).</summary>
    public const string InboundForeignKeysQuery =
        "SELECT fk.object_id, fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id), OBJECT_NAME(fk.parent_object_id), " +
        "fk.delete_referential_action_desc, fk.update_referential_action_desc, fk.is_disabled, fk.is_not_trusted, fkc.constraint_column_id, " +
        "COL_NAME(fk.parent_object_id, fkc.parent_column_id), COL_NAME(fk.referenced_object_id, fkc.referenced_column_id) " +
        "FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id " +
        "WHERE fk.referenced_object_id = @oid AND fk.parent_object_id <> @oid ORDER BY fk.name, fkc.constraint_column_id";

    /// <summary>DML triggers of the table; the definition is NULL when encrypted or not visible (VIEW DEFINITION).</summary>
    public const string TriggersQuery =
        "SELECT tr.name, OBJECT_DEFINITION(tr.object_id), tr.is_disabled, " +
        "CAST(CASE WHEN EXISTS (SELECT 1 FROM sys.trigger_events te WHERE te.object_id = tr.object_id AND (te.is_first = 1 OR te.is_last = 1)) THEN 1 ELSE 0 END AS bit) " +
        "FROM sys.triggers tr WHERE tr.parent_id = @oid ORDER BY tr.name";

    /// <summary>Object and column permissions granted or denied on the table.</summary>
    public const string PermissionsQuery =
        "SELECT pr.name, dp.permission_name, dp.state_desc, COL_NAME(dp.major_id, dp.minor_id) " +
        "FROM sys.database_permissions dp JOIN sys.database_principals pr ON pr.principal_id = dp.grantee_principal_id " +
        "WHERE dp.class = 1 AND dp.major_id = @oid ORDER BY pr.name, dp.permission_name, dp.minor_id";

    /// <summary>Extended properties of the table, its columns, indexes and constraints (MS_Description of the table and
    /// its columns is part of the model and excluded).</summary>
    public const string ExtendedPropertiesQuery =
        "SELECT ep.name, CASE WHEN ep.minor_id = 0 THEN N'table' ELSE N'column ' + COL_NAME(ep.major_id, ep.minor_id) END " +
        "FROM sys.extended_properties ep WHERE ep.class = 1 AND ep.major_id = @oid AND ep.name <> N'MS_Description' " +
        "UNION ALL SELECT ep.name, N'index ' + i.name FROM sys.extended_properties ep " +
        "JOIN sys.indexes i ON i.object_id = ep.major_id AND i.index_id = ep.minor_id WHERE ep.class = 7 AND ep.major_id = @oid " +
        "UNION ALL SELECT ep.name, LOWER(REPLACE(o.type_desc, N'_', N' ')) + N' ' + o.name FROM sys.extended_properties ep " +
        "JOIN sys.objects o ON o.object_id = ep.major_id WHERE ep.class = 1 AND o.parent_object_id = @oid";

    /// <summary>Objects bound to the table with SCHEMABINDING (views, functions): they make DROP TABLE fail.</summary>
    public const string SchemaBoundQuery =
        "SELECT DISTINCT OBJECT_SCHEMA_NAME(d.referencing_id), OBJECT_NAME(d.referencing_id), o.type_desc " +
        "FROM sys.sql_expression_dependencies d JOIN sys.objects o ON o.object_id = d.referencing_id " +
        "WHERE d.referenced_id = @oid AND d.is_schema_bound_reference = 1 AND d.referencing_id <> @oid";

    /// <summary>
    /// Storage features the table model does not hold, so DROP TABLE + CREATE would lose them (features-r1-02): kind
    /// (<see cref="DependentTypes.UnsupportedStorage"/>), index name (NULL = the table itself), detail. Indexes that are
    /// not rowstore clustered/nonclustered (XML, spatial, columnstore, hash), full-text indexes, a partition scheme or
    /// non-default filegroup for the table, its indexes, LOB or FILESTREAM data, row/page compression, change tracking, CDC.
    /// </summary>
    public const string UnsupportedStorageQuery =
        "SELECT CASE i.type WHEN 3 THEN N'xmlIndex' WHEN 4 THEN N'spatialIndex' WHEN 5 THEN N'columnstoreIndex' WHEN 6 THEN N'columnstoreIndex' ELSE N'otherIndex' END, " +
        "CAST(i.name AS nvarchar(128)), CAST(i.type_desc AS nvarchar(256)) " +
        "FROM sys.indexes i WHERE i.object_id = @oid AND i.type NOT IN (0, 1, 2) AND i.is_hypothetical = 0 " +
        "UNION SELECT N'fulltextIndex', NULL, CAST(c.name AS nvarchar(256)) FROM sys.fulltext_indexes fi " +
        "LEFT JOIN sys.fulltext_catalogs c ON c.fulltext_catalog_id = fi.fulltext_catalog_id WHERE fi.object_id = @oid " +
        "UNION SELECT CASE WHEN ds.type = 'PS' THEN N'partitioning' ELSE N'filegroup' END, CAST(i.name AS nvarchar(128)), CAST(ds.name AS nvarchar(256)) " +
        "FROM sys.indexes i JOIN sys.data_spaces ds ON ds.data_space_id = i.data_space_id " +
        "WHERE i.object_id = @oid AND i.type IN (0, 1, 2) AND i.is_hypothetical = 0 AND (ds.type = 'PS' OR ds.is_default = 0) " +
        "UNION SELECT CASE WHEN ds.type = 'PS' THEN N'partitioning' ELSE N'filegroup' END, NULL, CAST(ds.name + N' (TEXTIMAGE_ON)' AS nvarchar(256)) " +
        "FROM sys.tables t JOIN sys.data_spaces ds ON ds.data_space_id = t.lob_data_space_id " +
        "WHERE t.object_id = @oid AND (ds.type = 'PS' OR ds.is_default = 0) " +
        "UNION SELECT N'filegroup', NULL, CAST(ds.name + N' (FILESTREAM_ON)' AS nvarchar(256)) " +
        "FROM sys.tables t JOIN sys.data_spaces ds ON ds.data_space_id = t.filestream_data_space_id WHERE t.object_id = @oid " +
        "UNION SELECT N'compression', CASE WHEN i.index_id = 0 THEN NULL ELSE CAST(i.name AS nvarchar(128)) END, CAST(p.data_compression_desc AS nvarchar(256)) " +
        "FROM sys.partitions p JOIN sys.indexes i ON i.object_id = p.object_id AND i.index_id = p.index_id " +
        "WHERE p.object_id = @oid AND p.data_compression <> 0 AND i.type IN (0, 1, 2) " +
        "UNION SELECT N'changeTracking', NULL, NULL FROM sys.change_tracking_tables ct WHERE ct.object_id = @oid " +
        "UNION SELECT N'cdc', NULL, NULL FROM sys.tables t WHERE t.object_id = @oid AND t.is_tracked_by_cdc = 1 " +
        "ORDER BY 1, 2, 3";

    /// <summary>All queries, for the ScriptDom parse test.</summary>
    public static IReadOnlyDictionary<string, string> AllQueries { get; } = new Dictionary<string, string>
    {
        [nameof(TableQuery)] = TableQuery, [nameof(ColumnsQuery)] = ColumnsQuery, [nameof(IndexesQuery)] = IndexesQuery,
        [nameof(ForeignKeysQuery)] = ForeignKeysQuery, [nameof(ChecksQuery)] = ChecksQuery, [nameof(ViewQuery)] = ViewQuery,
        [nameof(ContextQuery)] = ContextQuery, [nameof(InboundForeignKeysQuery)] = InboundForeignKeysQuery,
        [nameof(TriggersQuery)] = TriggersQuery, [nameof(PermissionsQuery)] = PermissionsQuery,
        [nameof(ExtendedPropertiesQuery)] = ExtendedPropertiesQuery, [nameof(SchemaBoundQuery)] = SchemaBoundQuery,
        [nameof(UnsupportedStorageQuery)] = UnsupportedStorageQuery,
    };

    private static async Task<SqlConnection> OpenAsync(ConnectionProfile profile, string? password, string? database, CancellationToken ct)
    {
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(profile, password, pooling: false));
        if (!string.IsNullOrWhiteSpace(database)) b.InitialCatalog = database;
        b.ApplicationName = "Rowlit designer";
        var conn = new SqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, ct).ConfigureAwait(false);
        var rows = await SqlDb.QueryAsync(conn, ContextQuery, r => (SqlDb.Str(r, 0), SqlDb.Str(r, 1)), ct).ConfigureAwait(false);
        var context = rows.Count == 0 ? new DdlScriptContext(null, SqlServerDdlScripter.DefaultSchema) : new DdlScriptContext(rows[0].Item1, rows[0].Item2 ?? SqlServerDdlScripter.DefaultSchema);
        if (string.IsNullOrWhiteSpace(table)) return context;
        var tableSchema = string.IsNullOrWhiteSpace(schema) ? context.DefaultSchema ?? SqlServerDdlScripter.DefaultSchema : schema;
        return context with { Dependents = await ReadRebuildDependentsAsync(conn, tableSchema, table, ct).ConfigureAwait(false) };
    }

    /// <summary>
    /// What an identity rebuild of the table must drop and recreate, or cannot carry over (features-12). A failure to read
    /// any of it becomes a "blocker": the scripter then refuses the rebuild instead of dropping objects it cannot restore
    /// (other alters do not use the dependents).
    /// </summary>
    internal static async Task<IReadOnlyList<DependentObject>> ReadRebuildDependentsAsync(SqlConnection conn, string schema, string table, CancellationToken ct)
    {
        var list = new List<DependentObject>();
        try
        {
            var oid = await SqlDb.ScalarAsync<int?>(conn, "SELECT OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name), N'U')", ct,
                ("@schema", schema), ("@name", table)).ConfigureAwait(false);
            if (oid is null) return list;

            var fkRows = await SqlDb.QueryAsync(conn, InboundForeignKeysQuery, r => (
                Id: r.GetInt32(0), Name: r.GetString(1), Schema: SqlDb.Str(r, 2) ?? schema, Table: SqlDb.Str(r, 3) ?? "", OnDelete: r.GetString(4), OnUpdate: r.GetString(5),
                Disabled: r.GetBoolean(6), Untrusted: r.GetBoolean(7), Column: SqlDb.Str(r, 9) ?? "", RefColumn: SqlDb.Str(r, 10) ?? ""), ct, ("@oid", oid.Value)).ConfigureAwait(false);
            foreach (var g in fkRows.GroupBy(x => x.Id))
            {
                var f = g.First();
                var model = new ForeignKeyModel
                {
                    Name = f.Name,
                    Columns = g.Select(x => x.Column).ToList(),
                    RefSchema = schema,
                    RefTable = table,
                    RefColumns = g.Select(x => x.RefColumn).ToList(),
                    OnDelete = ReferentialActions.Normalize(f.OnDelete.Replace('_', ' ')),
                    OnUpdate = ReferentialActions.Normalize(f.OnUpdate.Replace('_', ' ')),
                };
                list.Add(new DependentObject(DependentTypes.ForeignKey, f.Name, "", false, f.Schema, f.Table, model, f.Disabled,
                    f.Untrusted && !f.Disabled ? "untrusted" : null));
            }

            var triggers = await SqlDb.QueryAsync(conn, TriggersQuery, r => new DependentObject(DependentTypes.Trigger, r.GetString(0), SqlDb.Str(r, 1) ?? "", true,
                Disabled: r.GetBoolean(2), Detail: r.GetBoolean(3) ? "ordered" : null), ct, ("@oid", oid.Value)).ConfigureAwait(false);
            list.AddRange(triggers);

            var permissions = await SqlDb.QueryAsync(conn, PermissionsQuery, r => new DependentObject(DependentTypes.Permission, r.GetString(0), r.GetString(1), true,
                Detail: r.GetString(2), Column: SqlDb.Str(r, 3)), ct, ("@oid", oid.Value)).ConfigureAwait(false);
            list.AddRange(permissions);

            var properties = await SqlDb.QueryAsync(conn, ExtendedPropertiesQuery, r => new DependentObject(DependentTypes.NotCarried, r.GetString(0), "", true,
                Detail: $"Extended property {r.GetString(0)} on {SqlDb.Str(r, 1) ?? "the table"} is not carried over."), ct, ("@oid", oid.Value)).ConfigureAwait(false);
            list.AddRange(properties);

            var bound = await SqlDb.QueryAsync(conn, SchemaBoundQuery, r => (Schema: SqlDb.Str(r, 0), Name: SqlDb.Str(r, 1) ?? "", Type: SqlDb.Str(r, 2) ?? "OBJECT"),
                ct, ("@oid", oid.Value)).ConfigureAwait(false);
            foreach (var b in bound)
            {
                var what = b.Type.Replace('_', ' ').ToLowerInvariant();
                list.Add(new DependentObject(DependentTypes.Blocker, b.Name, "", false, b.Schema,
                    Detail: $"The {what} {SqlServerDdlScripter.Table(b.Schema ?? schema, b.Name)} is bound to the table WITH SCHEMABINDING; drop or alter it first."));
            }

            // Storage the model does not hold (features-r1-02): the scripter refuses the rebuild instead of losing it.
            var storage = await SqlDb.QueryAsync(conn, UnsupportedStorageQuery, r => new DependentObject(r.GetString(0), SqlDb.Str(r, 1) ?? "", "", true,
                Detail: SqlDb.Str(r, 2)), ct, ("@oid", oid.Value)).ConfigureAwait(false);
            list.AddRange(storage);
        }
        catch (SqlException ex)
        {
            list.Add(new DependentObject(DependentTypes.Blocker, table, "", false,
                Detail: $"The foreign keys, triggers, permissions and storage options of the table could not be read ({ex.Message.TrimEnd('.')})."));
        }
        return list;
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, ct).ConfigureAwait(false);
        schema ??= await SqlDb.ScalarAsync<string>(conn, "SELECT SCHEMA_NAME()", ct).ConfigureAwait(false) ?? SqlServerDdlScripter.DefaultSchema;
        var tables = await SqlDb.QueryAsync(conn, TableQuery, r => (Id: r.GetInt32(0), Schema: r.GetString(1), Name: r.GetString(2), Comment: SqlDb.Str(r, 3)), ct,
            ("@schema", schema), ("@name", name)).ConfigureAwait(false);
        if (tables.Count == 0) throw EngineException.NotFound($"Table {schema}.{name}");
        var t = tables[0];

        var columns = await SqlDb.QueryAsync(conn, ColumnsQuery, r =>
        {
            var isComputed = !r.IsDBNull(10);
            var collation = SqlDb.Str(r, 14);
            var dbCollation = SqlDb.Str(r, 17);
            return new TableColumnModel
            {
                Id = r.GetString(1),
                Name = r.GetString(1),
                Type = isComputed ? "" : SqlServerNames.TypeText(r.GetString(2), r.GetInt16(3), r.GetByte(4), r.GetByte(5), r.GetBoolean(16)),
                Nullable = r.GetBoolean(6),
                Identity = r.GetBoolean(7) ? new IdentityModel(r.IsDBNull(8) ? 1 : r.GetInt64(8), r.IsDBNull(9) ? 1 : r.GetInt64(9)) : null,
                Computed = isComputed ? new ComputedModel(TableDiff.StripOuterParens(r.GetString(10)), !r.IsDBNull(11) && r.GetBoolean(11)) : null,
                DefaultName = SqlDb.Str(r, 12),
                Default = r.IsDBNull(13) ? null : TableDiff.StripOuterParens(r.GetString(13)),
                Collation = collation is not null && !string.Equals(collation, dbCollation, StringComparison.OrdinalIgnoreCase) ? collation : null,
                Comment = SqlDb.Str(r, 15),
            };
        }, ct, ("@oid", t.Id)).ConfigureAwait(false);

        var ixRows = await SqlDb.QueryAsync(conn, IndexesQuery, r => (
            IndexId: r.GetInt32(0), Name: SqlDb.Str(r, 1) ?? "", IsPk: r.GetBoolean(2), IsUq: r.GetBoolean(3), Unique: r.GetBoolean(4),
            Clustered: r.GetByte(5) == 1, Filter: SqlDb.Str(r, 6), Desc: r.GetBoolean(8), Included: r.GetBoolean(9), Column: r.GetString(10)),
            ct, ("@oid", t.Id)).ConfigureAwait(false);
        PrimaryKeyModel? pk = null;
        var uniques = new List<UniqueModel>();
        var indexes = new List<IndexModel>();
        foreach (var g in ixRows.GroupBy(x => x.IndexId))
        {
            var first = g.First();
            var keys = g.Where(x => !x.Included).Select(x => x.Column).ToList();
            if (first.IsPk) pk = new PrimaryKeyModel { Name = first.Name, Columns = keys, Clustered = first.Clustered };
            else if (first.IsUq) uniques.Add(new UniqueModel { Name = first.Name, Columns = keys });
            else
                indexes.Add(new IndexModel
                {
                    Name = first.Name,
                    Columns = g.Where(x => !x.Included).Select(x => new IndexColumnModel(x.Column, x.Desc)).ToList(),
                    Unique = first.Unique,
                    Clustered = first.Clustered,
                    Include = g.Where(x => x.Included).Select(x => x.Column).ToList(),
                    Filter = first.Filter is null ? null : TableDiff.StripOuterParens(first.Filter),
                });
        }

        var fkRows = await SqlDb.QueryAsync(conn, ForeignKeysQuery, r => (
            Id: r.GetInt32(0), Name: r.GetString(1), RefSchema: SqlDb.Str(r, 2), RefTable: SqlDb.Str(r, 3) ?? "", OnDelete: r.GetString(4), OnUpdate: r.GetString(5),
            Column: SqlDb.Str(r, 7) ?? "", RefColumn: SqlDb.Str(r, 8) ?? ""), ct, ("@oid", t.Id)).ConfigureAwait(false);
        var foreignKeys = fkRows.GroupBy(x => x.Id).Select(g =>
        {
            var f = g.First();
            return new ForeignKeyModel
            {
                Name = f.Name,
                Columns = g.Select(x => x.Column).ToList(),
                RefSchema = f.RefSchema,
                RefTable = f.RefTable,
                RefColumns = g.Select(x => x.RefColumn).ToList(),
                OnDelete = ReferentialActions.Normalize(f.OnDelete.Replace('_', ' ')),
                OnUpdate = ReferentialActions.Normalize(f.OnUpdate.Replace('_', ' ')),
            };
        }).ToList();

        var checks = await SqlDb.QueryAsync(conn, ChecksQuery, r => new CheckModel { Name = r.GetString(0), Expression = TableDiff.StripOuterParens(r.GetString(1)) },
            ct, ("@oid", t.Id)).ConfigureAwait(false);

        return new TableModel
        {
            Schema = t.Schema,
            Name = t.Name,
            Comment = t.Comment,
            Columns = columns,
            PrimaryKey = pk,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = foreignKeys,
            Checks = checks,
        };
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, ct).ConfigureAwait(false);
        schema ??= await SqlDb.ScalarAsync<string>(conn, "SELECT SCHEMA_NAME()", ct).ConfigureAwait(false) ?? SqlServerDdlScripter.DefaultSchema;
        var rows = await SqlDb.QueryAsync(conn, ViewQuery, r => (Name: r.GetString(0), Schema: r.GetString(1), Ddl: SqlDb.Str(r, 2), Check: r.GetBoolean(3),
            Bound: !r.IsDBNull(4) && Convert.ToInt32(r.GetValue(4), System.Globalization.CultureInfo.InvariantCulture) == 1), ct,
            ("@schema", schema), ("@name", name)).ConfigureAwait(false);
        if (rows.Count == 0) throw EngineException.NotFound($"View {schema}.{name}");
        var v = rows[0];
        if (v.Ddl is null) throw new EngineException(422, ErrorCodes.ProviderError, $"The definition of {v.Schema}.{v.Name} is encrypted or not visible.");
        var (body, options) = ViewText.Split(v.Ddl, Dialect.TSql);
        return new ViewModel(v.Schema, v.Name, body, options with { SchemaBinding = v.Bound, CheckOption = v.Check }, v.Ddl);
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, request.Database, ct).ConfigureAwait(false);
        var runner = new DdlApplyRunner
        {
            MapError = (ex, sql) => ex is SqlException se ? SqlServerErrors.FromException(se, new SqlBatch(sql, 1, 1)) : SqlServerProvider.ToProviderError(ex),
        };
        return await runner.RunAsync(conn, request.Statements, request.Transactional, ct).ConfigureAwait(false);
    }
}
