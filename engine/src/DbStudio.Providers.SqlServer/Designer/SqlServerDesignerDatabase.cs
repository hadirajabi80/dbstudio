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

    /// <summary>All queries, for the ScriptDom parse test.</summary>
    public static IReadOnlyDictionary<string, string> AllQueries { get; } = new Dictionary<string, string>
    {
        [nameof(TableQuery)] = TableQuery, [nameof(ColumnsQuery)] = ColumnsQuery, [nameof(IndexesQuery)] = IndexesQuery,
        [nameof(ForeignKeysQuery)] = ForeignKeysQuery, [nameof(ChecksQuery)] = ChecksQuery, [nameof(ViewQuery)] = ViewQuery,
        [nameof(ContextQuery)] = ContextQuery,
    };

    private static async Task<SqlConnection> OpenAsync(ConnectionProfile profile, string? password, string? database, CancellationToken ct)
    {
        var b = new SqlConnectionStringBuilder(SqlServerConnectionStrings.Build(profile, password, pooling: false));
        if (!string.IsNullOrWhiteSpace(database)) b.InitialCatalog = database;
        b.ApplicationName = "DbStudio designer";
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
        return rows.Count == 0 ? new DdlScriptContext(null, SqlServerDdlScripter.DefaultSchema) : new DdlScriptContext(rows[0].Item1, rows[0].Item2 ?? SqlServerDdlScripter.DefaultSchema);
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
