using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// Catalog reader over pooled connections, one per database (a PostgreSQL connection is bound to its database), opened
/// lazily and disposed with the reader (docs/PLAN-PG.md 2.5). pg_catalog / information_schema are never listed;
/// partitions are hidden (their partitioned parent is the table), foreign and partitioned tables are tables.
/// </summary>
public sealed class PgCatalogReader : ICatalogReader
{
    private readonly ConnectionProfile _profile;
    private readonly string? _password;
    private readonly string _defaultDatabase;
    private readonly Dictionary<string, NpgsqlConnection> _connections = new(StringComparer.Ordinal);

    public PgCatalogReader(ConnectionProfile profile, string? password, NpgsqlConnection? openDefault = null)
    {
        _profile = profile;
        _password = password;
        _defaultDatabase = PgConnectionStrings.Builder(profile, password, pooling: true).Database ?? PgConnectionStrings.DefaultDatabase;
        if (openDefault is not null) _connections[_defaultDatabase] = openDefault;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var c in _connections.Values)
        {
            try { await c.DisposeAsync().ConfigureAwait(false); } catch (NpgsqlException) { /* returning to the pool */ }
        }
        _connections.Clear();
    }

    /// <summary>The pooled connection of <paramref name="database"/> (null/empty = the profile's database).</summary>
    internal async Task<NpgsqlConnection> ConnectionFor(string? database, CancellationToken ct)
    {
        var db = string.IsNullOrWhiteSpace(database) ? _defaultDatabase : database.Trim();
        if (_connections.TryGetValue(db, out var existing) && existing.State == System.Data.ConnectionState.Open) return existing;
        var b = PgConnectionStrings.Builder(_profile, _password, pooling: true, db);
        b.ApplicationName = (b.ApplicationName ?? PgConnectionStrings.DefaultApplicationName) + " catalog";
        var conn = new NpgsqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        if (existing is not null) await existing.DisposeAsync().ConfigureAwait(false);
        _connections[db] = conn;
        return conn;
    }

    public async Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct)
    {
        var conn = await ConnectionFor(null, ct).ConfigureAwait(false);
        return await PgDb.QueryAsync(conn, PgCatalogQueries.Databases, r => r.GetString(0), ct).ConfigureAwait(false);
    }

    /// <summary>The profile's database (the one sessions open by default).</summary>
    public async Task<string?> GetCurrentDatabaseAsync(CancellationToken ct)
    {
        var conn = await ConnectionFor(null, ct).ConfigureAwait(false);
        return await PgDb.ScalarAsync(conn, PgCatalogQueries.CurrentDatabase, ct).ConfigureAwait(false) as string ?? _defaultDatabase;
    }

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        var conn = await ConnectionFor(database, ct).ConfigureAwait(false);
        return await PgDb.QueryAsync(conn, PgCatalogQueries.Schemas,
            r => new SchemaInfo(r.GetString(1), PgDb.Int(r, 3), r.IsDBNull(2) ? null : PgDb.Int(r, 2)), ct).ConfigureAwait(false);
    }

    public async Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct)
    {
        var conn = await ConnectionFor(database, ct).ConfigureAwait(false);
        return await PgDb.ScalarAsync(conn, PgCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) as string ?? "public";
    }

    /// <summary>The effective search path (without pg_catalog), in order.</summary>
    public async Task<IReadOnlyList<string>> GetSearchPathAsync(string? database, CancellationToken ct)
    {
        var conn = await ConnectionFor(database, ct).ConfigureAwait(false);
        return await PgDb.ScalarAsync(conn, PgCatalogQueries.SearchPath, ct).ConfigureAwait(false) as string[] ?? [];
    }

    private async Task<(NpgsqlConnection Conn, uint Oid, string Name)> SchemaAsync(string? database, string schema, CancellationToken ct)
    {
        var conn = await ConnectionFor(database, ct).ConfigureAwait(false);
        var rows = await PgDb.QueryAsync(conn, PgCatalogQueries.SchemaOid, r => (Oid: PgDb.Oid(r, 0), Name: r.GetString(1)), ct, schema).ConfigureAwait(false);
        if (rows.Count == 0) throw EngineException.NotFound($"Schema '{schema}' in database '{conn.Database}'");
        return (conn, rows[0].Oid, rows[0].Name);
    }

    // ------------------------------------------------------------------ schema snapshot

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(schema);
        var (conn, nsp, schemaName) = await SchemaAsync(database, schema, ct).ConfigureAwait(false);

        var relations = await PgDb.QueryAsync(conn, PgCatalogQueries.Relations,
            r => (Oid: PgDb.Oid(r, 0), Name: r.GetString(1), Kind: r.GetString(2), Comment: PgDb.Str(r, 3)), ct, nsp).ConfigureAwait(false);
        var columns = await PgDb.QueryAsync(conn, PgCatalogQueries.Columns, r => (
            Rel: PgDb.Oid(r, 0), Num: PgDb.Int(r, 1), Name: r.GetString(2), Type: PgTypes.ShortTypeName(r.GetString(3)), Nullable: r.GetBoolean(4),
            Identity: PgDb.Bool(r, 5), Generated: PgDb.Bool(r, 6), Comment: PgDb.Str(r, 8), Serial: PgDb.Bool(r, 9)), ct, nsp).ConfigureAwait(false);
        var keys = await PgDb.QueryAsync(conn, PgCatalogQueries.KeyConstraints,
            r => (Rel: PgDb.Oid(r, 0), Name: r.GetString(1), Type: r.GetString(2), Cols: PgDb.Strings(r, 3)), ct, nsp).ConfigureAwait(false);
        var fks = await PgDb.QueryAsync(conn, PgCatalogQueries.ForeignKeys, ReadFk, ct, nsp).ConfigureAwait(false);
        var routines = await PgDb.QueryAsync(conn, PgCatalogQueries.Routines, ReadRoutine, ct, nsp).ConfigureAwait(false);
        var rowColumns = await PgDb.QueryAsync(conn, PgCatalogQueries.RoutineRowColumns,
            r => (Proc: PgDb.Oid(r, 0), Col: new CatalogColumn(r.GetString(1), PgTypes.ShortTypeName(r.GetString(2)), true, false)), ct, nsp).ConfigureAwait(false);
        var sequences = await PgDb.QueryAsync(conn, PgCatalogQueries.Sequences,
            r => (Name: r.GetString(1), Comment: PgDb.Str(r, 2), Type: PgDb.Str(r, 3), OwnedBy: PgDb.Str(r, 10)), ct, nsp).ConfigureAwait(false);
        var types = await PgDb.QueryAsync(conn, PgCatalogQueries.Types, r => (
            Oid: PgDb.Oid(r, 0), Name: r.GetString(1), Kind: r.GetString(2), Comment: PgDb.Str(r, 3), Labels: PgDb.Strings(r, 4),
            Base: PgDb.Str(r, 5), Subtype: PgDb.Str(r, 7)), ct, nsp).ConfigureAwait(false);
        var typeColumns = await PgDb.QueryAsync(conn, PgCatalogQueries.CompositeTypeColumns,
            r => (Type: PgDb.Oid(r, 0), Col: new CatalogColumn(r.GetString(1), PgTypes.ShortTypeName(r.GetString(2)), r.GetBoolean(3), false)), ct, nsp).ConfigureAwait(false);
        var triggers = await PgDb.QueryAsync(conn, PgCatalogQueries.Triggers,
            r => (Name: r.GetString(1), Table: r.GetString(2), Comment: PgDb.Str(r, 4)), ct, nsp).ConfigureAwait(false);

        var colsByRel = columns.GroupBy(c => c.Rel).ToDictionary(g => g.Key, g => g.OrderBy(c => c.Num).ToList());
        var pkByRel = keys.Where(k => k.Type == "p").GroupBy(k => k.Rel).ToDictionary(g => g.Key, g => g.First().Cols);
        var fkByRel = fks.Where(f => f.Schema == schemaName && f.ParentOid != 0).GroupBy(f => f.ParentOid)
            .ToDictionary(g => g.Key, g => g.Select(f => new ForeignKeyRef(f.Name, f.Columns, f.RefSchema, f.RefTable, f.RefColumns)).ToList());

        var objects = new List<CatalogObject>(relations.Count + routines.Count + sequences.Count + types.Count + triggers.Count);
        foreach (var rel in relations)
        {
            var pk = pkByRel.GetValueOrDefault(rel.Oid) ?? [];
            var pkSet = new HashSet<string>(pk, StringComparer.Ordinal);
            objects.Add(new CatalogObject
            {
                Type = rel.Kind switch { "v" => ObjectTypes.View, "m" => ObjectTypes.MView, _ => ObjectTypes.Table },
                Name = rel.Name,
                Schema = schemaName,
                Comment = rel.Comment,
                Columns = (colsByRel.GetValueOrDefault(rel.Oid) ?? []).Select(c => new CatalogColumn(c.Name, c.Type, c.Nullable, pkSet.Contains(c.Name),
                    (c.Identity || c.Serial ? 1 : 0) | (c.Generated ? 2 : 0), c.Comment)).ToList(),
                PrimaryKey = pk.ToList(),
                ForeignKeys = fkByRel.GetValueOrDefault(rel.Oid) ?? [],
            });
        }

        var rowColsByProc = rowColumns.GroupBy(x => x.Proc).ToDictionary(g => g.Key, g => g.Select(x => x.Col).ToList());
        foreach (var p in routines)
        {
            var (type, parameters, cols) = MapRoutine(p, rowColsByProc.GetValueOrDefault(p.Oid));
            objects.Add(new CatalogObject
            {
                Type = type,
                Name = p.Name,
                Schema = schemaName,
                Comment = p.Comment,
                Parameters = parameters,
                Columns = cols,
            });
        }

        foreach (var s in sequences)
        {
            var comment = s.OwnedBy is null ? s.Comment : string.IsNullOrWhiteSpace(s.Comment) ? $"owned by {s.OwnedBy}" : $"{s.Comment} (owned by {s.OwnedBy})";
            objects.Add(new CatalogObject { Type = ObjectTypes.Sequence, Name = s.Name, Schema = schemaName, Comment = comment });
        }

        var typeColsByType = typeColumns.GroupBy(x => x.Type).ToDictionary(g => g.Key, g => g.Select(x => x.Col).ToList());
        foreach (var t in types)
        {
            var (prefix, cols) = t.Kind switch
            {
                "e" => ((string?)null, t.Labels.Select(l => new CatalogColumn(l, "enum label", false, false)).ToList()),
                "d" => ($"domain over {t.Base}", new List<CatalogColumn>()),
                "r" => ($"range over {t.Subtype}", new List<CatalogColumn>()),
                _ => (null, typeColsByType.GetValueOrDefault(t.Oid) ?? []),
            };
            var comment = prefix is null ? t.Comment : string.IsNullOrWhiteSpace(t.Comment) ? prefix : $"{prefix}: {t.Comment}";
            objects.Add(new CatalogObject { Type = ObjectTypes.Type, Name = t.Name, Schema = schemaName, Comment = comment, Columns = cols });
        }

        foreach (var tr in triggers)
        {
            objects.Add(new CatalogObject
            {
                Type = ObjectTypes.Trigger,
                Name = tr.Name,
                Schema = schemaName,
                Comment = string.IsNullOrWhiteSpace(tr.Comment) ? $"on {tr.Table}" : $"on {tr.Table}: {tr.Comment}",
            });
        }

        return new SchemaCatalog(conn.Database, schemaName, objects);
    }

    // ------------------------------------------------------------------ routines

    internal sealed record RawRoutine(uint Oid, string Name, string Kind, bool ReturnsSet, string? Result, string? Comment, string? Language,
        int DefaultCount, string[] ArgNames, string[] Modes, string[] ArgTypes, uint ReturnRelation, string? ReturnTypeType, string? ReturnType);

    private static RawRoutine ReadRoutine(NpgsqlDataReader r) => new(
        PgDb.Oid(r, 0), r.GetString(1), r.GetString(2), PgDb.Bool(r, 3), PgDb.Str(r, 4), PgDb.Str(r, 5), PgDb.Str(r, 6),
        PgDb.Int(r, 7), PgDb.Strings(r, 8), PgDb.Strings(r, 9), PgDb.Strings(r, 10), PgDb.Oid(r, 11), PgDb.Str(r, 12), PgDb.Str(r, 13));

    /// <summary>
    /// prokind p → proc; set-returning, RETURNS TABLE / SETOF record or a row type → tablefunc; else func. Parameters:
    /// modes i/o/b/v (VARIADIC prefix) in order, unnamed ones as $n, defaults on the last input parameters, a "return"
    /// entry for functions; TABLE columns (mode t) and OUT columns of set-returning functions become the columns.
    /// </summary>
    internal static (string Type, List<ParamInfo> Parameters, List<CatalogColumn> Columns) MapRoutine(RawRoutine p, List<CatalogColumn>? rowColumns)
    {
        var result = p.Result ?? p.ReturnType ?? "";
        var type = p.Kind == "p" ? ObjectTypes.Proc
            : p.ReturnsSet || result.StartsWith("TABLE(", StringComparison.OrdinalIgnoreCase) || result.StartsWith("SETOF record", StringComparison.OrdinalIgnoreCase)
              || (p.ReturnRelation != 0 && p.ReturnTypeType == "c") ? ObjectTypes.TableFunc : ObjectTypes.Func;

        var count = Math.Max(p.Modes.Length, p.ArgTypes.Length);
        var inputIndexes = new List<int>();
        for (var i = 0; i < count; i++)
        {
            var mode = i < p.Modes.Length ? p.Modes[i] : "i";
            if (mode is "i" or "b" or "v") inputIndexes.Add(i);
        }
        var withDefault = new HashSet<int>(inputIndexes.Skip(Math.Max(0, inputIndexes.Count - p.DefaultCount)));

        var parameters = new List<ParamInfo>();
        var columns = new List<CatalogColumn>();
        for (var i = 0; i < count; i++)
        {
            var mode = i < p.Modes.Length ? p.Modes[i] : "i";
            var argName = i < p.ArgNames.Length && !string.IsNullOrEmpty(p.ArgNames[i]) ? p.ArgNames[i] : "$" + (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var argType = i < p.ArgTypes.Length ? PgTypes.ShortTypeName(p.ArgTypes[i]) : "unknown";
            switch (mode)
            {
                case "t":
                    columns.Add(new CatalogColumn(argName, argType, true, false));
                    break;
                case "o" when type == ObjectTypes.TableFunc:
                    columns.Add(new CatalogColumn(argName, argType, true, false));
                    break;
                case "o":
                    parameters.Add(new ParamInfo(argName, argType, "out", false));
                    break;
                case "b":
                    parameters.Add(new ParamInfo(argName, argType, "inout", withDefault.Contains(i)));
                    break;
                case "v":
                    parameters.Add(new ParamInfo("VARIADIC " + argName, argType, "in", withDefault.Contains(i)));
                    break;
                default:
                    parameters.Add(new ParamInfo(argName, argType, "in", withDefault.Contains(i)));
                    break;
            }
        }
        if (type == ObjectTypes.TableFunc && columns.Count == 0)
        {
            if (rowColumns is { Count: > 0 }) columns.AddRange(rowColumns);
            else if (!result.StartsWith("SETOF record", StringComparison.OrdinalIgnoreCase))
                columns.Add(new CatalogColumn(p.Name, PgTypes.ShortTypeName(result.StartsWith("SETOF ", StringComparison.OrdinalIgnoreCase) ? result[6..] : result), true, false));
        }
        if (type != ObjectTypes.Proc) parameters.Add(new ParamInfo("", result, "return", false));
        return (type, parameters, columns);
    }

    // ------------------------------------------------------------------ foreign keys

    internal sealed record RawFk(uint Oid, string Name, string Schema, string Table, string RefSchema, string RefTable, string OnDelete, string OnUpdate,
        IReadOnlyList<string> Columns, IReadOnlyList<string> RefColumns, uint ParentOid, uint RefOid);

    private static RawFk ReadFk(NpgsqlDataReader r) => new(
        PgDb.Oid(r, 0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5),
        Action(PgDb.Str(r, 6)), Action(PgDb.Str(r, 7)), PgDb.Strings(r, 8), PgDb.Strings(r, 9), PgDb.Oid(r, 10), PgDb.Oid(r, 11));

    /// <summary>confdeltype/confupdtype: a NO ACTION, r RESTRICT, c CASCADE, n SET NULL, d SET DEFAULT.</summary>
    public static string Action(string? code) => code switch
    {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    };

    // ------------------------------------------------------------------ object lookup

    internal sealed record FoundRelation(uint Oid, string Kind, string Name, string Schema);

    internal static async Task<FoundRelation?> FindRelationAsync(NpgsqlConnection conn, string schema, string name, CancellationToken ct) =>
        (await PgDb.QueryAsync(conn, PgCatalogQueries.FindRelation, r => new FoundRelation(PgDb.Oid(r, 0), r.GetString(1), r.GetString(2), r.GetString(3)),
            ct, schema, name).ConfigureAwait(false)).FirstOrDefault();

    private async Task<(NpgsqlConnection Conn, string Schema)> ResolveAsync(ObjectRef obj, CancellationToken ct)
    {
        var conn = await ConnectionFor(obj.Database, ct).ConfigureAwait(false);
        var schema = obj.Schema ?? await PgDb.ScalarAsync(conn, PgCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) as string ?? "public";
        return (conn, schema);
    }

    // ------------------------------------------------------------------ details

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var (conn, schema) = await ResolveAsync(obj, ct).ConfigureAwait(false);

        if (obj.Type is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc)
        {
            var routines = await PgDb.QueryAsync(conn, PgCatalogQueries.FindRoutines, r => PgDb.Oid(r, 0), ct, schema, obj.Name).ConfigureAwait(false);
            if (routines.Count == 0) throw EngineException.NotFound($"Routine {schema}.{obj.Name}");
            var parameters = new List<ParamInfo>();
            foreach (var oid in routines.Take(1))
            {
                var rows = await PgDb.QueryAsync(conn, PgCatalogQueries.RoutineDetail, r => new RawRoutine(oid, r.GetString(0), r.GetString(1), false,
                    PgDb.Str(r, 6), PgDb.Str(r, 8), null, PgDb.Int(r, 2), PgDb.Strings(r, 3), PgDb.Strings(r, 4), PgDb.Strings(r, 5), 0, null, null), ct, oid).ConfigureAwait(false);
                if (rows.Count > 0) parameters.AddRange(MapRoutine(rows[0], null).Parameters);
            }
            return new ObjectDetails(obj with { Schema = schema }, [], [], [], [], [], parameters, null, null, null);
        }

        if (obj.Type == ObjectTypes.Type)
        {
            var t = (await PgDb.QueryAsync(conn, PgCatalogQueries.FindType, r => (Oid: PgDb.Oid(r, 0), Kind: r.GetString(1)), ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
            if (t.Oid == 0) throw EngineException.NotFound($"Type {schema}.{obj.Name}");
            var detail = (await PgDb.QueryAsync(conn, PgCatalogQueries.TypeDetail, r => (Labels: PgDb.Strings(r, 3), Rel: PgDb.Oid(r, 7)), ct, t.Oid).ConfigureAwait(false)).FirstOrDefault();
            var cols = new List<ColumnDetail>();
            if (t.Kind == "e")
                cols.AddRange(detail.Labels.Select((l, i) => new ColumnDetail(l, "enum label", false, null, false, false, false, null, i + 1)));
            else if (detail.Rel != 0)
                cols.AddRange((await PgDb.QueryAsync(conn, PgCatalogQueries.CompositeAttributes, r => (Name: r.GetString(0), Type: PgTypes.ShortTypeName(r.GetString(1))), ct, detail.Rel).ConfigureAwait(false))
                    .Select((c, i) => new ColumnDetail(c.Name, c.Type, true, null, false, false, false, null, i + 1)));
            return new ObjectDetails(obj with { Schema = schema }, cols, [], [], [], [], [], null, null, null);
        }

        if (obj.Type == ObjectTypes.Trigger)
        {
            var tr = (await PgDb.QueryAsync(conn, PgCatalogQueries.FindTrigger, r => PgDb.Oid(r, 0), ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
            if (tr == 0) throw EngineException.NotFound($"Trigger {schema}.{obj.Name}");
            return new ObjectDetails(obj with { Schema = schema }, [], [], [], [], [], [], null, null, null);
        }

        var rel = await FindRelationAsync(conn, schema, obj.Name, ct).ConfigureAwait(false)
                  ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        if (rel.Kind == "S")
            return new ObjectDetails(obj with { Schema = rel.Schema, Name = rel.Name }, [], [], [], [], [], [], null, null, null);

        var table = await ReadTableDefinitionAsync(conn, rel.Oid, ct).ConfigureAwait(false);
        var pk = table.Constraints.FirstOrDefault(c => c.Type == "p")?.Columns ?? [];
        var pkSet = new HashSet<string>(pk, StringComparer.Ordinal);
        var columns = table.Columns.Select((c, i) => new ColumnDetail(c.Name, c.Type, c.Nullable, c.Generated ?? c.Default, pkSet.Contains(c.Name),
            c.Identity is not null || (c.Default?.StartsWith("nextval(", StringComparison.Ordinal) ?? false), c.Generated is not null, c.Comment, i + 1)).ToList();
        var indexes = table.Indexes.Select(ix => new IndexDetail(ix.Name, ix.Unique, ix.KeyColumns.Concat(ix.IncludeColumns).ToList(), ix.Method, ix.Primary)).ToList();
        var fkRows = await PgDb.QueryAsync(conn, PgCatalogQueries.RelationForeignKeys, ReadFk, ct, rel.Oid).ConfigureAwait(false);
        var outgoing = fkRows.Where(f => f.ParentOid == rel.Oid).Select(f => new ForeignKeyRef(f.Name, f.Columns, f.RefSchema, f.RefTable, f.RefColumns)).ToList();
        var incoming = fkRows.Where(f => f.RefOid == rel.Oid).Select(f => new ReferencedBy(f.Schema, f.Table, f.Name, f.Columns)).ToList();
        return new ObjectDetails(obj with { Schema = table.Schema, Name = table.Name }, columns, indexes, outgoing, incoming,
            table.Triggers.Select(t => t.Name).ToList(), [], table.RowEstimate, null, null);
    }

    /// <summary>Everything the DDL generator and the designer need about one relation.</summary>
    internal static async Task<PgTableDefinition> ReadTableDefinitionAsync(NpgsqlConnection conn, uint oid, CancellationToken ct)
    {
        var info = (await PgDb.QueryAsync(conn, PgCatalogQueries.RelationInfo, r => (
            Name: r.GetString(0), Schema: r.GetString(1), Kind: r.GetString(2), Persistence: PgDb.Str(r, 3), Comment: PgDb.Str(r, 4),
            PartitionKey: PgDb.Str(r, 5), Options: PgDb.Strings(r, 6), Rows: PgDb.Long(r, 7), ViewDef: PgDb.Str(r, 8)), ct, oid).ConfigureAwait(false)).FirstOrDefault();
        if (info.Name is null) throw EngineException.NotFound($"Relation {oid}");
        var columns = await PgDb.QueryAsync(conn, PgCatalogQueries.RelationColumns, r =>
        {
            var identity = PgDb.Str(r, 4);
            var generated = PgDb.Str(r, 5) == "s";
            var expr = PgDb.Str(r, 6);
            return new PgColumnDefinition(
                Name: r.GetString(1),
                Type: PgTypes.ShortTypeName(r.GetString(2)),
                Nullable: r.GetBoolean(3),
                Default: generated || identity is "a" or "d" ? null : expr,
                Identity: identity is "a" or "d" ? new PgIdentity(identity == "a", PgDb.Long(r, 9) ?? 1, PgDb.Long(r, 10) ?? 1) : null,
                Generated: generated ? expr : null,
                Collation: PgDb.Str(r, 8),
                Comment: PgDb.Str(r, 7));
        }, ct, oid).ConfigureAwait(false);
        var constraints = await PgDb.QueryAsync(conn, PgCatalogQueries.RelationConstraints,
            r => new PgConstraintDefinition(r.GetString(0), r.GetString(1), r.GetString(2), PgDb.Strings(r, 3)), ct, oid).ConfigureAwait(false);
        var indexes = await PgDb.QueryAsync(conn, PgCatalogQueries.RelationIndexes, r =>
        {
            var keyCount = PgDb.Int(r, 4);
            var cols = PgDb.Strings(r, 7);
            var descs = r.IsDBNull(8) ? [] : r.GetFieldValue<bool[]>(8);
            return new PgIndexDefinition(r.GetString(0), r.GetBoolean(1), r.GetBoolean(2), r.GetString(3), r.GetString(5), PgDb.Str(r, 6),
                cols.Take(keyCount).ToList(), cols.Skip(keyCount).ToList(), cols.Take(keyCount).Select((_, i) => i < descs.Length && descs[i]).ToList(), r.GetBoolean(9));
        }, ct, oid).ConfigureAwait(false);
        var triggers = await PgDb.QueryAsync(conn, PgCatalogQueries.RelationTriggers, r => (Name: r.GetString(0), Def: r.GetString(1)), ct, oid).ConfigureAwait(false);
        string? server = null;
        string[] serverOptions = [];
        if (info.Kind == "f")
        {
            var ft = (await PgDb.QueryAsync(conn, PgCatalogQueries.ForeignTableInfo, r => (Server: r.GetString(0), Options: PgDb.Strings(r, 1)), ct, oid).ConfigureAwait(false)).FirstOrDefault();
            server = ft.Server;
            serverOptions = ft.Options ?? [];
        }
        return new PgTableDefinition(info.Schema, info.Name, info.Kind, info.Persistence == "u", info.Comment, columns, constraints, indexes,
            triggers, info.PartitionKey, info.Options, server, serverOptions, info.Rows, info.ViewDef);
    }

    // ------------------------------------------------------------------ DDL

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var (conn, schema) = await ResolveAsync(obj, ct).ConfigureAwait(false);
        switch (obj.Type)
        {
            case ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc:
                return await RoutineDdlAsync(conn, schema, obj.Name, ct).ConfigureAwait(false);
            case ObjectTypes.Type:
                return await TypeDdlAsync(conn, schema, obj.Name, ct).ConfigureAwait(false);
            case ObjectTypes.Trigger:
                return await TriggerDdlAsync(conn, schema, obj.Name, ct).ConfigureAwait(false);
        }

        var rel = await FindRelationAsync(conn, schema, obj.Name, ct).ConfigureAwait(false);
        if (rel is null)
        {
            // The explorer may ask for a routine/type by name with a generic type token: try those before giving up.
            var routines = await PgDb.QueryAsync(conn, PgCatalogQueries.FindRoutines, r => PgDb.Oid(r, 0), ct, schema, obj.Name).ConfigureAwait(false);
            if (routines.Count > 0) return await RoutineDdlAsync(conn, schema, obj.Name, ct).ConfigureAwait(false);
            throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        }
        if (rel.Kind == "S") return new DdlResult(await SequenceDdlAsync(conn, rel, ct).ConfigureAwait(false), "generated");
        var table = await ReadTableDefinitionAsync(conn, rel.Oid, ct).ConfigureAwait(false);
        return rel.Kind switch
        {
            "v" => new DdlResult(PgDdlGenerator.ViewDdl(table), "stored"),
            "m" => new DdlResult(PgDdlGenerator.ViewDdl(table), "stored"),
            _ => new DdlResult(PgDdlGenerator.Generate(table), "generated"),
        };
    }

    private static async Task<DdlResult> RoutineDdlAsync(NpgsqlConnection conn, string schema, string name, CancellationToken ct)
    {
        var routines = await PgDb.QueryAsync(conn, PgCatalogQueries.FindRoutines, r => (Oid: PgDb.Oid(r, 0), Kind: r.GetString(1), Name: r.GetString(2), Schema: r.GetString(3)),
            ct, schema, name).ConfigureAwait(false);
        if (routines.Count == 0) throw EngineException.NotFound($"Routine {schema}.{name}");
        var sb = new StringBuilder();
        foreach (var p in routines)
        {
            if (sb.Length > 0) sb.Append('\n');
            if (p.Kind == "a")
            {
                sb.Append(await AggregateDdlAsync(conn, p.Oid, PgSqlText.Qualify(p.Schema, p.Name), ct).ConfigureAwait(false));
                continue;
            }
            var def = await PgDb.ScalarAsync(conn, PgCatalogQueries.FunctionDefinition, ct, p.Oid).ConfigureAwait(false) as string;
            sb.Append((def ?? $"-- The definition of {p.Schema}.{p.Name} is not available.").TrimEnd());
            if (!(def ?? "").TrimEnd().EndsWith(';')) sb.Append(';');
            sb.Append('\n');
        }
        return new DdlResult(sb.ToString(), "stored");
    }

    private static async Task<string> AggregateDdlAsync(NpgsqlConnection conn, uint oid, string qualified, CancellationToken ct)
    {
        var rows = await PgDb.QueryAsync(conn, PgCatalogQueries.AggregateDefinition, r => (Args: PgDb.Str(r, 0), Sfunc: PgDb.Str(r, 1), Stype: PgDb.Str(r, 2),
            Final: PgDb.Str(r, 3), Init: PgDb.Str(r, 4), Combine: PgDb.Str(r, 5)), ct, oid).ConfigureAwait(false);
        if (rows.Count == 0) return $"-- Aggregate {qualified}: definition not available.\n";
        var a = rows[0];
        var sb = new StringBuilder($"CREATE AGGREGATE {qualified}({a.Args}) (\n    SFUNC = {a.Sfunc},\n    STYPE = {a.Stype}");
        if (a.Final is not null) sb.Append(",\n    FINALFUNC = ").Append(a.Final);
        if (a.Combine is not null) sb.Append(",\n    COMBINEFUNC = ").Append(a.Combine);
        if (a.Init is not null) sb.Append(",\n    INITCOND = ").Append(PgSqlText.Literal(a.Init));
        sb.Append("\n);\n");
        return sb.ToString();
    }

    private static async Task<string> SequenceDdlAsync(NpgsqlConnection conn, FoundRelation rel, CancellationToken ct)
    {
        var rows = await PgDb.QueryAsync(conn, PgCatalogQueries.SequenceDefinition, r => new PgSequenceDefinition(
            r.GetString(0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4), r.GetBoolean(5), r.GetInt64(6), PgDb.Str(r, 7), PgDb.Str(r, 8)), ct, rel.Oid).ConfigureAwait(false);
        return rows.Count == 0
            ? $"-- Sequence {rel.Schema}.{rel.Name} was not found.\n"
            : PgDdlGenerator.SequenceDdl(PgSqlText.Qualify(rel.Schema, rel.Name), rows[0]);
    }

    private static async Task<DdlResult> TypeDdlAsync(NpgsqlConnection conn, string schema, string name, CancellationToken ct)
    {
        var found = (await PgDb.QueryAsync(conn, PgCatalogQueries.FindType, r => (Oid: PgDb.Oid(r, 0), Name: r.GetString(2), Schema: r.GetString(3)), ct, schema, name).ConfigureAwait(false)).FirstOrDefault();
        if (found.Oid == 0) throw EngineException.NotFound($"Type {schema}.{name}");
        var t = (await PgDb.QueryAsync(conn, PgCatalogQueries.TypeDetail, r => new PgTypeDefinition(
            r.GetString(0), r.GetString(1), PgDb.Str(r, 2), PgDb.Strings(r, 3), PgDb.Str(r, 4), PgDb.Bool(r, 5), PgDb.Str(r, 6), PgDb.Oid(r, 7), PgDb.Str(r, 8), [], []),
            ct, found.Oid).ConfigureAwait(false)).First();
        if (t.Kind == "d")
            t = t with { Constraints = await PgDb.QueryAsync(conn, PgCatalogQueries.DomainConstraints, r => (r.GetString(0), r.GetString(1)), ct, found.Oid).ConfigureAwait(false) };
        if (t.Kind == "c" && t.Relation != 0)
            t = t with { Attributes = await PgDb.QueryAsync(conn, PgCatalogQueries.CompositeAttributes, r => (r.GetString(0), PgTypes.ShortTypeName(r.GetString(1))), ct, t.Relation).ConfigureAwait(false) };
        return new DdlResult(PgDdlGenerator.TypeDdl(PgSqlText.Qualify(found.Schema, found.Name), t), "generated");
    }

    private static async Task<DdlResult> TriggerDdlAsync(NpgsqlConnection conn, string schema, string name, CancellationToken ct)
    {
        var tr = (await PgDb.QueryAsync(conn, PgCatalogQueries.FindTrigger, r => PgDb.Oid(r, 0), ct, schema, name).ConfigureAwait(false)).FirstOrDefault();
        if (tr == 0) throw EngineException.NotFound($"Trigger {schema}.{name}");
        var rows = await PgDb.QueryAsync(conn, PgCatalogQueries.TriggerDefinition, r => (Trigger: r.GetString(0), Function: PgDb.Str(r, 1), Comment: PgDb.Str(r, 2)), ct, tr).ConfigureAwait(false);
        var d = rows[0];
        var sb = new StringBuilder();
        if (d.Function is not null) sb.Append(d.Function.TrimEnd()).Append(d.Function.TrimEnd().EndsWith(';') ? "" : ";").Append("\n\n");
        sb.Append(d.Trigger.TrimEnd()).Append(";\n");
        if (!string.IsNullOrWhiteSpace(d.Comment))
        {
            var onIndex = d.Trigger.IndexOf(" ON ", StringComparison.Ordinal);
            var table = onIndex < 0 ? "" : d.Trigger[(onIndex + 4)..].Split(' ', 2)[0];
            sb.Append("COMMENT ON TRIGGER ").Append(PgSqlText.Quote(name)).Append(" ON ").Append(table).Append(" IS ").Append(PgSqlText.Literal(d.Comment)).Append(";\n");
        }
        return new DdlResult(sb.ToString(), "stored");
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);
}
