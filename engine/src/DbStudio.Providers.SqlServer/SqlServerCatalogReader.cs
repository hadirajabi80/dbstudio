using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>
/// Catalog reader over a short-lived pooled connection. Cross-database requests switch with USE [db] on this
/// connection (docs/PLAN.md 2.6); the pool resets the database when the connection is returned.
/// </summary>
public sealed class SqlServerCatalogReader : ICatalogReader
{
    private readonly SqlConnection _conn;
    private readonly bool _ownsConnection;

    public SqlServerCatalogReader(SqlConnection openConnection, bool ownsConnection = true)
    {
        _conn = openConnection ?? throw new ArgumentNullException(nameof(openConnection));
        _ownsConnection = ownsConnection;
    }

    public async ValueTask DisposeAsync()
    {
        if (_ownsConnection) await _conn.DisposeAsync().ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) =>
        await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Databases, r => r.GetString(0), ct).ConfigureAwait(false);

    public async Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) =>
        await SqlDb.ScalarAsync<string>(_conn, SqlServerCatalogQueries.CurrentDatabase, ct).ConfigureAwait(false);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        return await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Schemas,
            r => new SchemaInfo(r.GetString(1), r.GetInt32(2)), ct).ConfigureAwait(false);
    }

    public async Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct)
    {
        await UseAsync(database, ct).ConfigureAwait(false);
        return await SqlDb.ScalarAsync<string>(_conn, SqlServerCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) ?? "dbo";
    }

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(schema);
        await UseAsync(database, ct).ConfigureAwait(false);
        var sidObj = await SqlDb.ScalarAsync<object>(_conn, SqlServerCatalogQueries.SchemaId, ct, ("@schema", schema)).ConfigureAwait(false);
        if (sidObj is null or DBNull) throw EngineException.NotFound($"Schema '{schema}' in database '{_conn.Database}'");
        var sid = Convert.ToInt32(sidObj);
        var p = ("@sid", (object?)sid);

        var objects = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Objects, r => new RawObject(
            r.GetInt32(0), r.GetString(1), r.GetString(2).Trim(), SqlDb.Str(r, 4)), ct, p).ConfigureAwait(false);
        var byId = objects.ToDictionary(o => o.Id);

        var columns = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Columns, r => new RawColumn(
            r.GetInt32(0), r.GetInt32(1), r.GetString(2),
            SqlServerNames.TypeText(r.GetString(3), r.GetInt16(4), r.GetByte(5), r.GetByte(6), SqlDb.Bool(r, 12)),
            SqlDb.Bool(r, 7), SqlDb.Bool(r, 8), SqlDb.Bool(r, 9), SqlDb.Str(r, 11)), ct, p).ConfigureAwait(false);

        var keys = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.KeyConstraints, r => new RawKey(
            r.GetInt32(0), r.GetString(1), r.GetString(2).Trim(), r.GetInt32(3), r.GetByte(4)), ct, p).ConfigureAwait(false);

        ForeignKeyOrdinals? fkOrdinals = null;
        var fkRows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.ForeignKeys,
            r => ReadForeignKeyRow(r, fkOrdinals ??= new ForeignKeyOrdinals(r)), ct, p).ConfigureAwait(false);

        var paramRows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Parameters, r => (
            ObjectId: r.GetInt32(0), Id: r.GetInt32(1), Name: r.GetString(2),
            Type: SqlServerNames.TypeText(r.GetString(3), r.GetInt16(4), r.GetByte(5), r.GetByte(6)),
            IsOutput: SqlDb.Bool(r, 7), HasDefault: SqlDb.Bool(r, 8)), ct, p).ConfigureAwait(false);

        var synonyms = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.Synonyms, r => (
            Name: r.GetString(0), Base: r.GetString(1), TargetType: SqlDb.Str(r, 2)?.Trim()), ct, p).ConfigureAwait(false);

        // SQL Server 2005 has no table types (sys.table_types / sys.types.is_table_type are 2008+).
        var hasTableTypes = !IsSqlServer2005OrOlder(_conn.ServerVersion);
        var userTypes = await SqlDb.QueryAsync(_conn, hasTableTypes ? SqlServerCatalogQueries.UserTypes : SqlServerCatalogQueries.UserTypes2005, r => (
            Id: r.GetInt32(0), Name: r.GetString(1), IsTable: SqlDb.Bool(r, 7)), ct, p).ConfigureAwait(false);

        var ttColumns = !hasTableTypes ? [] : await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.TableTypeColumns, r => (
            TypeId: r.GetInt32(0), Col: new CatalogColumn(r.GetString(2),
                SqlServerNames.TypeText(r.GetString(3), r.GetInt16(4), r.GetByte(5), r.GetByte(6)), SqlDb.Bool(r, 7), false,
                (SqlDb.Bool(r, 8) ? 1 : 0) | (SqlDb.Bool(r, 9) ? 2 : 0))), ct, p).ConfigureAwait(false);

        // Primary keys per table.
        var pkByObject = keys.Where(k => k.Type == "PK")
            .GroupBy(k => k.ParentId)
            .ToDictionary(g => g.Key, g => g.OrderBy(k => k.Ordinal).Select(k => k.ColumnId).ToList());
        var colsByObject = columns.GroupBy(c => c.ObjectId).ToDictionary(g => g.Key, g => g.OrderBy(c => c.ColumnId).ToList());

        // Outgoing FKs of tables in this schema; the schemas of incoming FKs are reported (ReferencingSchemas) so the
        // ER diagram can load them, and FKs whose target the login cannot see are counted instead of becoming "" edges.
        var fkSet = GroupForeignKeys(fkRows, sid);
        var fksByParent = fkSet.ByParent;

        var paramsByObject = paramRows.GroupBy(x => x.ObjectId).ToDictionary(g => g.Key, g => g.OrderBy(x => x.Id)
            .Select(x => x.Id == 0
                ? new ParamInfo("", x.Type, "return", false)
                : new ParamInfo(x.Name, x.Type, x.IsOutput ? "out" : "in", x.HasDefault))
            .ToList());

        // Ordinal: a case-sensitive database may hold synonyms that differ only in case.
        var synonymMap = new Dictionary<string, (string Name, string Base, string? TargetType)>(StringComparer.Ordinal);
        foreach (var s in synonyms) synonymMap.TryAdd(s.Name, s);
        var result = new List<CatalogObject>(objects.Count + userTypes.Count);
        foreach (var o in objects.OrderBy(o => o.Name, StringComparer.OrdinalIgnoreCase))
        {
            var type = MapType(o.Type);
            if (type is null) continue;
            var pk = pkByObject.GetValueOrDefault(o.Id) ?? [];
            var cols = colsByObject.GetValueOrDefault(o.Id) ?? [];
            var pkNames = pk.Select(id => cols.FirstOrDefault(c => c.ColumnId == id)?.Name).Where(n => n is not null).Select(n => n!).ToList();
            SynonymTarget? target = null;
            if (type == ObjectTypes.Synonym && synonymMap.TryGetValue(o.Name, out var syn))
                target = ParseSynonymTarget(syn.Base, syn.TargetType);

            result.Add(new CatalogObject
            {
                Type = type,
                Name = o.Name,
                Schema = schema,
                Comment = o.Comment,
                Columns = cols.Select(c => new CatalogColumn(c.Name, c.TypeText, c.Nullable, pk.Contains(c.ColumnId),
                    (c.IsIdentity ? 1 : 0) | (c.IsComputed ? 2 : 0), c.Comment)).ToList(),
                PrimaryKey = pkNames,
                ForeignKeys = fksByParent.GetValueOrDefault(o.Id) ?? [],
                Parameters = paramsByObject.GetValueOrDefault(o.Id) ?? [],
                Target = target,
            });
        }

        var ttColsByType = ttColumns.GroupBy(x => x.TypeId).ToDictionary(g => g.Key, g => g.Select(x => x.Col).ToList());
        foreach (var t in userTypes.OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase))
        {
            result.Add(new CatalogObject
            {
                Type = ObjectTypes.Type,
                Name = t.Name,
                Schema = schema,
                Columns = t.IsTable ? ttColsByType.GetValueOrDefault(t.Id) ?? [] : [],
            });
        }

        return new SchemaCatalog(_conn.Database, schema, result)
        {
            ReferencingSchemas = fkSet.ReferencingSchemas,
            HiddenForeignKeys = fkSet.Hidden,
        };
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        await UseAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? await GetDefaultSchemaAsync(null, ct).ConfigureAwait(false);

        if (obj.Type == ObjectTypes.Type)
        {
            var ut = await FindUserTypeAsync(schema, obj.Name, ct).ConfigureAwait(false)
                ?? throw EngineException.NotFound($"Type {schema}.{obj.Name}");
            var typeCols = ut.TableObjectId is int ttId ? await ReadDetailColumnsAsync(ttId, ct).ConfigureAwait(false) : [];
            return new ObjectDetails(obj with { Schema = schema }, typeCols.Select(c => c.Detail).ToList(), [], [], [], [], [], null, null, null);
        }

        var found = await FindObjectAsync(schema, obj.Name, ct).ConfigureAwait(false)
            ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var id = found.Id;
        var detailCols = await ReadDetailColumnsAsync(id, ct).ConfigureAwait(false);
        var indexes = await ReadIndexesAsync(id, ct).ConfigureAwait(false);
        var fks = await ReadForeignKeysAsync(id, ct).ConfigureAwait(false);
        var pkCols = indexes.FirstOrDefault(i => i.IsPrimaryKey)?.KeyColumns.Select(k => k.Name).ToHashSet(StringComparer.OrdinalIgnoreCase)
                     ?? new HashSet<string>();

        var referencedBy = (await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailReferencedBy, r => (
                Fk: r.GetString(r.GetOrdinal("fk_name")), Schema: SqlDb.Str(r, r.GetOrdinal("parent_schema")),
                Table: SqlDb.Str(r, r.GetOrdinal("parent_table")) ?? "", Col: SqlDb.Str(r, r.GetOrdinal("parent_column")) ?? ""), ct, ("@id", id))
            .ConfigureAwait(false))
            .GroupBy(x => (x.Schema, x.Table, x.Fk))
            .Select(g => new ReferencedBy(g.Key.Schema, g.Key.Table, g.Key.Fk, g.Select(x => x.Col).ToList()))
            .ToList();

        var triggers = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailTriggers, r => r.GetString(0), ct, ("@id", id)).ConfigureAwait(false);

        var parameters = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailParameters, r => r.GetInt32(0) == 0
            ? new ParamInfo("", SqlServerNames.TypeText(r.GetString(2), r.GetInt16(3), r.GetByte(4), r.GetByte(5)), "return", false)
            : new ParamInfo(r.GetString(1), SqlServerNames.TypeText(r.GetString(2), r.GetInt16(3), r.GetByte(4), r.GetByte(5)),
                SqlDb.Bool(r, 6) ? "out" : "in", SqlDb.Bool(r, 7)), ct, ("@id", id)).ConfigureAwait(false);

        long? rowCount = null;
        if (found.Type is "U")
        {
            var rc = await SqlDb.ScalarAsync<object>(_conn, SqlServerCatalogQueries.DetailRowCount, ct, ("@id", id)).ConfigureAwait(false);
            if (rc is not null and not DBNull) rowCount = Convert.ToInt64(rc);
        }

        var columns = detailCols.Select(c => c.Detail with { IsPk = pkCols.Contains(c.Detail.Name) }).ToList();
        var indexDetails = indexes.Select(i => new IndexDetail(i.Name, i.IsUnique, i.KeyColumns.Select(k => k.Name).ToList(), i.TypeDesc, i.IsPrimaryKey)).ToList();
        var fkRefs = fks.Select(f => new ForeignKeyRef(f.Def.Name, f.Def.Columns, f.Def.RefSchema, f.Def.RefTable, f.Def.RefColumns, f.IsDisabled, f.IsNotTrusted)).ToList();

        return new ObjectDetails(obj with { Schema = schema }, columns, indexDetails, fkRefs, referencedBy, triggers, parameters, rowCount,
            new DateTimeOffset(DateTime.SpecifyKind(found.Created, DateTimeKind.Unspecified), TimeSpan.Zero),
            new DateTimeOffset(DateTime.SpecifyKind(found.Modified, DateTimeKind.Unspecified), TimeSpan.Zero));
    }

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        await UseAsync(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? await GetDefaultSchemaAsync(null, ct).ConfigureAwait(false);
        var full = SqlServerNames.Qualify(schema, obj.Name);

        if (obj.Type == ObjectTypes.Type)
        {
            var ut = await FindUserTypeAsync(schema, obj.Name, ct).ConfigureAwait(false)
                ?? throw EngineException.NotFound($"Type {schema}.{obj.Name}");
            if (ut.TableObjectId is int ttId)
            {
                var cols = await ReadDetailColumnsAsync(ttId, ct).ConfigureAwait(false);
                var body = string.Join(",\n", cols.Select(c => "    " + SqlServerNames.Quote(c.Def.Name) + " " + c.Def.TypeText + (c.Def.Nullable ? " NULL" : " NOT NULL")));
                return new DdlResult($"CREATE TYPE {full} AS TABLE (\n{body}\n);\n", "generated");
            }
            return new DdlResult($"CREATE TYPE {full} FROM {ut.BaseTypeText}{(ut.Nullable ? " NULL" : " NOT NULL")};\n", "generated");
        }

        var found = await FindObjectAsync(schema, obj.Name, ct).ConfigureAwait(false)
            ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        switch (found.Type)
        {
            case "U":
                return new DdlResult(TSqlDdlGenerator.Generate(await ReadTableDefinitionAsync(schema, obj.Name, found.Id, ct).ConfigureAwait(false)), "generated");
            case "SN":
            {
                var baseName = await SqlDb.ScalarAsync<string>(_conn, SqlServerCatalogQueries.SynonymDefinition, ct, ("@id", found.Id)).ConfigureAwait(false);
                return new DdlResult($"CREATE SYNONYM {full} FOR {baseName};\n", "generated");
            }
            case "SO":
                return new DdlResult(await SequenceDdlAsync(full, found.Id, ct).ConfigureAwait(false), "generated");
            default:
            {
                var def = await SqlDb.ScalarAsync<string>(_conn, SqlServerCatalogQueries.ModuleDefinition, ct, ("@id", found.Id)).ConfigureAwait(false);
                return def is null
                    ? new DdlResult($"-- The definition of {full} is encrypted or not visible to the current user.\n", "stored")
                    : new DdlResult(def.TrimEnd() + "\n", "stored");
            }
        }
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) =>
        Task.FromResult<CatalogObject?>(null);

    /// <summary>The full definition the DDL generator needs (identity seeds, computed columns, constraint kinds, checks).</summary>
    public async Task<SqlServerTableDefinition> ReadTableDefinitionAsync(string schema, string name, int objectId, CancellationToken ct)
    {
        var cols = await ReadDetailColumnsAsync(objectId, ct).ConfigureAwait(false);
        var indexes = await ReadIndexesAsync(objectId, ct).ConfigureAwait(false);
        var fks = await ReadForeignKeysAsync(objectId, ct).ConfigureAwait(false);
        var checks = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailCheckConstraints,
            r => new SqlServerCheckDefinition(r.GetString(0), r.GetString(1)), ct, ("@id", objectId)).ConfigureAwait(false);
        return new SqlServerTableDefinition(schema, name, cols.Select(c => c.Def).ToList(), indexes, fks.Select(f => f.Def).ToList(), checks);
    }

    // ---------------------------------------------------------------- helpers

    public static string? MapType(string code) => code switch
    {
        "U" => ObjectTypes.Table,
        "V" => ObjectTypes.View,
        "P" or "PC" => ObjectTypes.Proc,
        "FN" or "FS" => ObjectTypes.Func,
        "IF" or "TF" or "FT" => ObjectTypes.TableFunc,
        "SN" => ObjectTypes.Synonym,
        "SO" => ObjectTypes.Sequence,
        "TR" => ObjectTypes.Trigger,
        "TT" => ObjectTypes.Type,
        _ => null,
    };

    /// <summary>Parses sys.synonyms.base_object_name ([srv].[db].[schema].[name]) into a target.</summary>
    public static SynonymTarget ParseSynonymTarget(string baseObjectName, string? targetTypeCode)
    {
        var parts = SqlServerNames.SplitMultipart(baseObjectName);
        string name = parts[^1];
        string? schema = parts.Count >= 2 && parts[^2].Length > 0 ? parts[^2] : null;
        string? db = parts.Count >= 3 && parts[^3].Length > 0 ? parts[^3] : null;
        return new SynonymTarget(db, schema, name, targetTypeCode is null ? null : MapType(targetTypeCode));
    }

    private async Task UseAsync(string? database, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(database) || string.Equals(database, _conn.Database, StringComparison.Ordinal)) return;
        await SqlDb.ExecuteAsync(_conn, "USE " + SqlServerNames.Quote(database), ct).ConfigureAwait(false);
    }

    private sealed record FoundObject(int Id, string Type, DateTime Created, DateTime Modified);

    private async Task<FoundObject?> FindObjectAsync(string schema, string name, CancellationToken ct)
    {
        var rows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.ObjectIdByName,
            r => new FoundObject(r.GetInt32(0), r.GetString(1).Trim(), r.GetDateTime(2), r.GetDateTime(3)), ct,
            ("@schema", schema), ("@name", name)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    private sealed record FoundType(string BaseTypeText, bool Nullable, int? TableObjectId);

    private async Task<FoundType?> FindUserTypeAsync(string schema, string name, CancellationToken ct)
    {
        var rows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.UserTypeByName, r => new FoundType(
            r.IsDBNull(1) ? "sql_variant" : SqlServerNames.TypeText(r.GetString(1), r.GetInt16(2), r.GetByte(3), r.GetByte(4)),
            SqlDb.Bool(r, 5), r.IsDBNull(7) ? null : r.GetInt32(7)), ct, ("@schema", schema), ("@name", name)).ConfigureAwait(false);
        return rows.FirstOrDefault();
    }

    private sealed record DetailColumn(ColumnDetail Detail, SqlServerColumnDefinition Def);

    private async Task<List<DetailColumn>> ReadDetailColumnsAsync(int objectId, CancellationToken ct) =>
        await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailColumns, r =>
        {
            bool userDefined = SqlDb.Bool(r, 17);
            var typeName = r.GetString(2);
            if (userDefined && SqlDb.Str(r, 18) is { } typeSchema && typeSchema != "sys")
                typeName = SqlServerNames.Qualify(typeSchema, typeName);
            var typeText = SqlServerNames.TypeText(typeName, r.GetInt16(3), r.GetByte(4), r.GetByte(5), userDefined);
            bool isComputed = SqlDb.Bool(r, 8);
            var computedDef = SqlDb.Str(r, 12);
            var defaultDef = SqlDb.Str(r, 9);
            var def = new SqlServerColumnDefinition(
                r.GetString(1), typeText, SqlDb.Bool(r, 6),
                DefaultDefinition: defaultDef,
                DefaultName: SqlDb.Str(r, 10),
                IsIdentity: SqlDb.Bool(r, 7),
                IdentitySeed: r.IsDBNull(14) ? 1 : r.GetInt64(14),
                IdentityIncrement: r.IsDBNull(15) ? 1 : r.GetInt64(15),
                ComputedDefinition: isComputed ? computedDef : null,
                IsPersisted: !r.IsDBNull(13) && SqlDb.Bool(r, 13),
                Collation: null);
            var detail = new ColumnDetail(def.Name, typeText, def.Nullable, isComputed ? computedDef : defaultDef, false,
                def.IsIdentity, isComputed, SqlDb.Str(r, 11), r.GetInt32(0));
            return new DetailColumn(detail, def);
        }, ct, ("@id", objectId)).ConfigureAwait(false);

    private async Task<List<SqlServerIndexDefinition>> ReadIndexesAsync(int objectId, CancellationToken ct)
    {
        var rows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailIndexes, r => (
            Id: r.GetInt32(0), Name: SqlDb.Str(r, 1) ?? "", Unique: SqlDb.Bool(r, 2), Pk: SqlDb.Bool(r, 3), Uq: SqlDb.Bool(r, 4),
            Type: r.GetString(5), Filter: SqlDb.Str(r, 6), Desc: SqlDb.Bool(r, 8), Included: SqlDb.Bool(r, 9), Col: SqlDb.Str(r, 10) ?? ""),
            ct, ("@id", objectId)).ConfigureAwait(false);
        return rows.GroupBy(x => x.Id).Select(g =>
        {
            var f = g.First();
            return new SqlServerIndexDefinition(f.Name, f.Unique, f.Pk, f.Uq, f.Type,
                g.Where(x => !x.Included).Select(x => new SqlServerIndexColumn(x.Col, x.Desc)).ToList(),
                g.Where(x => x.Included).Select(x => x.Col).ToList(), f.Filter);
        }).ToList();
    }

    private sealed record DetailForeignKey(SqlServerForeignKeyDefinition Def, bool IsDisabled, bool IsNotTrusted);

    /// <summary>Outgoing FKs of one table; keys whose referenced table or columns are not visible to the login are left out.</summary>
    private async Task<List<DetailForeignKey>> ReadForeignKeysAsync(int objectId, CancellationToken ct)
    {
        var rows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.DetailForeignKeys, r => (
            Name: r.GetString(r.GetOrdinal("fk_name")), Del: r.GetString(r.GetOrdinal("on_delete")), Upd: r.GetString(r.GetOrdinal("on_update")),
            Col: SqlDb.Str(r, r.GetOrdinal("parent_column")), RefSchema: SqlDb.Str(r, r.GetOrdinal("ref_schema")),
            RefTable: SqlDb.Str(r, r.GetOrdinal("ref_table")), RefCol: SqlDb.Str(r, r.GetOrdinal("ref_column")),
            Disabled: SqlDb.Bool(r, r.GetOrdinal("is_disabled")), NotTrusted: SqlDb.Bool(r, r.GetOrdinal("is_not_trusted"))),
            ct, ("@id", objectId)).ConfigureAwait(false);
        return rows.GroupBy(x => x.Name, StringComparer.Ordinal)
            .Where(g => g.All(x => x.Col is not null && x.RefSchema is not null && x.RefTable is not null && x.RefCol is not null))
            .Select(g =>
            {
                var f = g.First();
                return new DetailForeignKey(new SqlServerForeignKeyDefinition(f.Name, g.Select(x => x.Col!).ToList(), f.RefSchema!, f.RefTable!,
                    g.Select(x => x.RefCol!).ToList(), f.Del, f.Upd), f.Disabled, f.NotTrusted);
            }).ToList();
    }

    private async Task<string> SequenceDdlAsync(string full, int id, CancellationToken ct)
    {
        var rows = await SqlDb.QueryAsync(_conn, SqlServerCatalogQueries.SequenceDefinition, r => (
            Type: SqlServerNames.TypeText(r.GetString(0), 0, r.GetByte(1), r.GetByte(2)),
            Start: SqlDb.Str(r, 3), Inc: SqlDb.Str(r, 4), Min: SqlDb.Str(r, 5), Max: SqlDb.Str(r, 6),
            Cycle: SqlDb.Bool(r, 7), Cached: !r.IsDBNull(8) && SqlDb.Bool(r, 8), Cache: r.IsDBNull(9) ? (int?)null : r.GetInt32(9)),
            ct, ("@id", id)).ConfigureAwait(false);
        var s = rows.FirstOrDefault();
        if (s == default) return $"-- Sequence {full} was not found.\n";
        var cache = s.Cached ? (s.Cache is int c ? $"CACHE {c}" : "CACHE") : "NO CACHE";
        return $"CREATE SEQUENCE {full}\n    AS {s.Type}\n    START WITH {s.Start}\n    INCREMENT BY {s.Inc}\n" +
               $"    MINVALUE {s.Min}\n    MAXVALUE {s.Max}\n    {(s.Cycle ? "CYCLE" : "NO CYCLE")}\n    {cache};\n";
    }

    private sealed record RawObject(int Id, string Name, string Type, string? Comment);
    private sealed record RawColumn(int ObjectId, int ColumnId, string Name, string TypeText, bool Nullable, bool IsIdentity, bool IsComputed, string? Comment);
    private sealed record RawKey(int ParentId, string Name, string Type, int ColumnId, int Ordinal);

    // ---------------------------------------------------------------- foreign keys (pure, unit tested)

    /// <summary>"9.00.5000" (SQL Server 2005) and older: no table types.</summary>
    public static bool IsSqlServer2005OrOlder(string? serverVersion) =>
        int.TryParse((serverVersion ?? "").Split('.')[0], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var major)
        && major is > 0 and < 10;

    /// <summary>One column pair of a foreign key (<see cref="SqlServerCatalogQueries.ForeignKeys"/>); names are null when not visible.</summary>
    public sealed record ForeignKeyRow(int FkId, string Name, int ParentId, int? ParentSchemaId, string? ParentSchema, string? ParentTable,
        string? ParentColumn, int? RefSchemaId, string? RefSchema, string? RefTable, string? RefColumn, int Ordinal, bool IsDisabled, bool IsNotTrusted);

    /// <summary>Column positions of the FK query, resolved once by name (the select list can change without breaking the mapping).</summary>
    public sealed class ForeignKeyOrdinals(System.Data.IDataRecord r)
    {
        public readonly int FkId = r.GetOrdinal("fk_id"), Name = r.GetOrdinal("fk_name"), ParentId = r.GetOrdinal("parent_id"),
            ParentSchemaId = r.GetOrdinal("parent_schema_id"), ParentSchema = r.GetOrdinal("parent_schema"), ParentTable = r.GetOrdinal("parent_table"),
            ParentColumn = r.GetOrdinal("parent_column"), RefSchemaId = r.GetOrdinal("ref_schema_id"), RefSchema = r.GetOrdinal("ref_schema"),
            RefTable = r.GetOrdinal("ref_table"), RefColumn = r.GetOrdinal("ref_column"), Ordinal = r.GetOrdinal("ordinal"),
            IsDisabled = r.GetOrdinal("is_disabled"), IsNotTrusted = r.GetOrdinal("is_not_trusted");
    }

    public static ForeignKeyRow ReadForeignKeyRow(System.Data.IDataRecord r, ForeignKeyOrdinals o)
    {
        static int? Int(System.Data.IDataRecord r, int i) => r.IsDBNull(i) ? null : Convert.ToInt32(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);
        return new ForeignKeyRow(Int(r, o.FkId) ?? 0, SqlDb.Str(r, o.Name) ?? "", Int(r, o.ParentId) ?? 0, Int(r, o.ParentSchemaId),
            SqlDb.Str(r, o.ParentSchema), SqlDb.Str(r, o.ParentTable), SqlDb.Str(r, o.ParentColumn), Int(r, o.RefSchemaId),
            SqlDb.Str(r, o.RefSchema), SqlDb.Str(r, o.RefTable), SqlDb.Str(r, o.RefColumn), Int(r, o.Ordinal) ?? 0,
            SqlDb.Bool(r, o.IsDisabled), SqlDb.Bool(r, o.IsNotTrusted));
    }

    /// <param name="ByParent">Outgoing FKs per parent object id (parent table in the loaded schema).</param>
    /// <param name="ReferencingSchemas">Other schemas whose tables reference a table of the loaded schema.</param>
    /// <param name="Hidden">Outgoing FKs left out: the referenced table or a column name is not visible to the login.</param>
    public sealed record ForeignKeySet(Dictionary<int, List<ForeignKeyRef>> ByParent, IReadOnlyList<string> ReferencingSchemas, int Hidden);

    /// <summary>Groups the FK rows of one schema load (both directions) into the outgoing keys per table.</summary>
    public static ForeignKeySet GroupForeignKeys(IEnumerable<ForeignKeyRow> rows, int schemaId)
    {
        var byParent = new Dictionary<int, List<ForeignKeyRef>>();
        var referencing = new SortedSet<string>(StringComparer.Ordinal);
        var hidden = 0;
        foreach (var g in rows.GroupBy(r => r.FkId))
        {
            var cols = g.OrderBy(r => r.Ordinal).ToList();
            var first = cols[0];
            if (first.ParentSchemaId != schemaId)
            {
                // incoming from another schema: that schema's load carries the key itself
                if (first.RefSchemaId == schemaId && !string.IsNullOrEmpty(first.ParentSchema)) referencing.Add(first.ParentSchema);
                continue;
            }
            if (cols.Any(c => string.IsNullOrEmpty(c.ParentColumn) || string.IsNullOrEmpty(c.RefSchema) || string.IsNullOrEmpty(c.RefTable) || string.IsNullOrEmpty(c.RefColumn)))
            {
                hidden++;
                continue;
            }
            if (!byParent.TryGetValue(first.ParentId, out var list)) byParent[first.ParentId] = list = [];
            list.Add(new ForeignKeyRef(first.Name, cols.Select(c => c.ParentColumn!).ToList(), first.RefSchema, first.RefTable!,
                cols.Select(c => c.RefColumn!).ToList(), first.IsDisabled, first.IsNotTrusted));
        }
        return new ForeignKeySet(byParent, referencing.ToList(), hidden);
    }
}
