using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Oracle.ManagedDataAccess.Client;
using Oracle.ManagedDataAccess.Types;

namespace DbStudio.Providers.Oracle;

/// <summary>
/// Oracle catalog reader over a short-lived pooled connection. Every dictionary query is OWNER-bound (docs/PLAN.md 2.6, R4).
/// Oracle has no databases: <c>database</c> arguments are ignored and the "current database" is the current schema.
/// </summary>
public sealed class OracleCatalogReader : ICatalogReader
{
    private const int InListLimit = 1000;
    private readonly OracleConnection _conn;
    private readonly bool _ownsConnection;
    private string? _currentSchema;

    public OracleCatalogReader(OracleConnection openConnection, bool ownsConnection = true)
    {
        _conn = openConnection ?? throw new ArgumentNullException(nameof(openConnection));
        _ownsConnection = ownsConnection;
    }

    public async ValueTask DisposeAsync()
    {
        if (_ownsConnection) await _conn.DisposeAsync().ConfigureAwait(false);
    }

    public Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    public async Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => await CurrentSchemaAsync(ct).ConfigureAwait(false);

    public async Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct) => await CurrentSchemaAsync(ct).ConfigureAwait(false);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        List<string> names;
        try
        {
            names = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Schemas, r => r.GetString(0), ct).ConfigureAwait(false);
        }
        catch (OracleException ex) when (ex.Number == 904) // ORACLE_MAINTAINED missing (11g)
        {
            names = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.SchemasFallback, r => r.GetString(0), ct).ConfigureAwait(false);
        }
        var current = await CurrentSchemaAsync(ct).ConfigureAwait(false);
        if (!names.Contains(current, StringComparer.Ordinal))
        {
            names.Add(current);
            names.Sort(StringComparer.Ordinal);
        }
        return names.Select(n => new SchemaInfo(n)).ToList();
    }

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(schema);
        var owner = ("owner", (object?)schema);

        var objects = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Objects,
            r => (Name: r.GetString(0), Type: r.GetString(1), Status: OracleDb.Str(r, 3)), ct, owner).ConfigureAwait(false);

        var tableComments = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.TableComments,
                r => (Table: r.GetString(0), Comment: r.GetString(1)), ct, owner).ConfigureAwait(false))
            .GroupBy(x => x.Table).ToDictionary(g => g.Key, g => g.First().Comment, StringComparer.Ordinal);
        var columnComments = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.ColumnComments,
                r => (Table: r.GetString(0), Column: r.GetString(1), Comment: r.GetString(2)), ct, owner).ConfigureAwait(false))
            .GroupBy(x => (x.Table, x.Column)).ToDictionary(g => g.Key, g => g.First().Comment);

        List<RawColumn> columns;
        try
        {
            columns = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Columns, r => ReadColumn(r, schema), ct, owner).ConfigureAwait(false);
        }
        catch (OracleException ex) when (ex.Number == 904) // IDENTITY_COLUMN missing (pre-12c)
        {
            columns = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.ColumnsNoIdentity, r => ReadColumn(r, schema), ct, owner).ConfigureAwait(false);
        }

        var constraintRows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Constraints, r => new RawConstraintColumn(
            r.GetString(0), r.GetString(1), r.GetString(2), OracleDb.Str(r, 3), OracleDb.Str(r, 4), r.GetString(6), OracleDb.Int(r, 7) ?? 0),
            ct, owner).ConfigureAwait(false);
        var constraints = constraintRows.GroupBy(c => c.Name).Select(g => new RawConstraint(
            g.Key, g.First().Type, g.First().Table, g.First().ROwner, g.First().RConstraint,
            g.OrderBy(x => x.Position).Select(x => x.Column).ToList())).ToList();
        var referenced = await ResolveReferencedKeysAsync(schema, constraints, ct).ConfigureAwait(false);

        var procedures = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Procedures, r => new RawProcedure(
            r.GetString(0), OracleDb.Str(r, 1), OracleDb.Int(r, 2) ?? 0, OracleDb.Str(r, 3), r.GetString(4)), ct, owner).ConfigureAwait(false);

        var arguments = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Arguments, r => new RawArgument(
            OracleDb.Str(r, 0), r.GetString(1), OracleDb.Int(r, 2) ?? 0, OracleDb.Str(r, 3), OracleDb.Str(r, 4), OracleDb.Int(r, 5) ?? 0,
            OracleTypeText.Argument(OracleDb.Str(r, 7), OracleDb.Str(r, 8), OracleDb.Str(r, 9), OracleDb.Str(r, 14), OracleDb.Str(r, 13)),
            OracleDb.Str(r, 7), OracleDb.Str(r, 10), OracleDb.Str(r, 11) == "Y"), ct, owner).ConfigureAwait(false);

        var synonyms = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Synonyms, r => (
                Name: r.GetString(0), Target: SynonymTargetOf(OracleDb.Str(r, 1), r.GetString(2), OracleDb.Str(r, 3), OracleDb.Str(r, 4))),
            ct, owner).ConfigureAwait(false))
            .GroupBy(s => s.Name).ToDictionary(g => g.Key, g => g.First().Target, StringComparer.Ordinal);

        // ---- assemble
        var colsByTable = columns.GroupBy(c => c.Table).ToDictionary(g => g.Key, g => g.OrderBy(c => c.ColumnId).ToList(), StringComparer.Ordinal);
        var pkByTable = constraints.Where(c => c.Type == "P").GroupBy(c => c.Table).ToDictionary(g => g.Key, g => g.First().Columns, StringComparer.Ordinal);
        var fksByTable = constraints.Where(c => c.Type == "R").GroupBy(c => c.Table).ToDictionary(g => g.Key, g => g.Select(fk =>
        {
            var hasTarget = referenced.TryGetValue((fk.ROwner ?? schema, fk.RConstraint ?? ""), out var target);
            return new ForeignKeyRef(fk.Name, fk.Columns, fk.ROwner ?? schema, hasTarget ? target.Table : "", hasTarget ? target.Columns : []);
        }).ToList(), StringComparer.Ordinal);

        var argsByUnit = arguments.GroupBy(a => (a.Package ?? "", a.Package is null ? a.Object : "", a.Package is null ? 0 : a.SubprogramId))
            .ToDictionary(g => g.Key, g => g.ToList());

        var result = new List<CatalogObject>(objects.Count);
        foreach (var o in objects.OrderBy(o => o.Name, StringComparer.Ordinal).ThenBy(o => o.Type, StringComparer.Ordinal))
        {
            var type = OracleTypeText.ObjectType(o.Type);
            if (type is null) continue;
            var obj = new CatalogObject
            {
                Type = type,
                Name = o.Name,
                Schema = schema,
                Status = o.Status,
                Comment = type is ObjectTypes.Table or ObjectTypes.View or ObjectTypes.MView ? tableComments.GetValueOrDefault(o.Name) : null,
            };
            switch (type)
            {
                case ObjectTypes.Table:
                case ObjectTypes.View:
                case ObjectTypes.MView:
                {
                    var pk = pkByTable.GetValueOrDefault(o.Name) ?? [];
                    obj.PrimaryKey.AddRange(pk);
                    obj.Columns.AddRange((colsByTable.GetValueOrDefault(o.Name) ?? []).Select(c => new CatalogColumn(
                        c.Name, c.TypeText, c.Nullable, pk.Contains(c.Name), c.Flags, columnComments.GetValueOrDefault((o.Name, c.Name)))));
                    obj.ForeignKeys.AddRange(fksByTable.GetValueOrDefault(o.Name) ?? []);
                    break;
                }
                case ObjectTypes.Proc:
                case ObjectTypes.Func:
                    obj.Parameters.AddRange(ToParams(argsByUnit.GetValueOrDefault(("", o.Name, 0)) ?? []));
                    break;
                case ObjectTypes.Package:
                    foreach (var p in procedures.Where(p => p.ObjectType == "PACKAGE" && p.Object == o.Name && p.Procedure is not null)
                                 .OrderBy(p => p.SubprogramId))
                    {
                        var args = argsByUnit.GetValueOrDefault((o.Name, "", p.SubprogramId)) ?? [];
                        bool isFunc = args.Any(a => a.Position == 0 && a.DataType is not null);
                        obj.Members.Add(new PackageMember(p.Procedure!, isFunc ? ObjectTypes.Func : ObjectTypes.Proc,
                            int.TryParse(p.Overload, out var ov) ? ov : 0, ToParams(args)));
                    }
                    break;
                case ObjectTypes.Synonym:
                    obj = new CatalogObject
                    {
                        Type = type, Name = o.Name, Schema = schema, Status = o.Status, Target = synonyms.GetValueOrDefault(o.Name),
                    };
                    break;
            }
            result.Add(obj);
        }
        return new SchemaCatalog(null, schema, result);
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var owner = obj.Schema ?? await CurrentSchemaAsync(ct).ConfigureAwait(false);
        var o = ("owner", (object?)owner);
        var n = ("name", (object?)obj.Name);
        var info = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.ObjectByName, r => (
            Type: r.GetString(0), Created: r.IsDBNull(1) ? (DateTime?)null : r.GetDateTime(1), Modified: r.IsDBNull(2) ? (DateTime?)null : r.GetDateTime(2)),
            ct, o, n).ConfigureAwait(false)).FirstOrDefault(x => OracleTypeText.ObjectType(x.Type) == obj.Type || obj.Type == ObjectTypes.TableFunc);
        if (info == default)
            throw EngineException.NotFound($"{obj.Type} {owner}.{obj.Name}");
        var refOut = obj with { Schema = owner };
        DateTimeOffset? created = info.Created is DateTime c ? new DateTimeOffset(DateTime.SpecifyKind(c, DateTimeKind.Unspecified), TimeSpan.Zero) : null;
        DateTimeOffset? modified = info.Modified is DateTime m ? new DateTimeOffset(DateTime.SpecifyKind(m, DateTimeKind.Unspecified), TimeSpan.Zero) : null;

        if (obj.Type is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc)
        {
            var args = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailArguments, r => new RawArgument(
                null, obj.Name, 0, OracleDb.Str(r, 9), OracleDb.Str(r, 0), OracleDb.Int(r, 1) ?? 0,
                OracleTypeText.Argument(OracleDb.Str(r, 2), OracleDb.Str(r, 3), OracleDb.Str(r, 4), OracleDb.Str(r, 8), OracleDb.Str(r, 7)),
                OracleDb.Str(r, 2), OracleDb.Str(r, 5), OracleDb.Str(r, 6) == "Y"), ct, o, n).ConfigureAwait(false);
            return new ObjectDetails(refOut, [], [], [], [], [], ToParams(args), null, created, modified);
        }
        if (obj.Type is not (ObjectTypes.Table or ObjectTypes.View or ObjectTypes.MView))
            return new ObjectDetails(refOut, [], [], [], [], [], [], null, created, modified);

        var flags = new Dictionary<string, (bool Virtual, bool Identity)>(StringComparer.Ordinal);
        try
        {
            foreach (var f in await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailColumnFlags,
                         r => (r.GetString(0), OracleDb.Str(r, 1) == "YES", OracleDb.Str(r, 2) == "YES"), ct, o, n).ConfigureAwait(false))
                flags[f.Item1] = (f.Item2, f.Item3);
        }
        catch (OracleException ex) when (ex.Number == 904)
        {
            foreach (var f in await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailColumnFlagsNoIdentity,
                         r => (r.GetString(0), OracleDb.Str(r, 1) == "YES", false), ct, o, n).ConfigureAwait(false))
                flags[f.Item1] = (f.Item2, f.Item3);
        }
        var comments = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailColumnComments,
            r => (r.GetString(0), r.GetString(1)), ct, o, n).ConfigureAwait(false)).ToDictionary(x => x.Item1, x => x.Item2, StringComparer.Ordinal);

        var keyRows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailKeys, r => (
            Name: r.GetString(0), Type: r.GetString(1), ROwner: OracleDb.Str(r, 2), RConstraint: OracleDb.Str(r, 3),
            Column: r.GetString(4), Position: OracleDb.Int(r, 5) ?? 0, Index: OracleDb.Str(r, 6)), ct, o, n).ConfigureAwait(false);
        var keys = keyRows.GroupBy(k => k.Name).Select(g => new RawConstraint(g.Key, g.First().Type, obj.Name, g.First().ROwner,
            g.First().RConstraint, g.OrderBy(x => x.Position).Select(x => x.Column).ToList())).ToList();
        var pk = keys.FirstOrDefault(k => k.Type == "P");
        var pkIndex = keyRows.FirstOrDefault(k => k.Type == "P").Index;
        var referenced = await ResolveReferencedKeysAsync(owner, keys, ct).ConfigureAwait(false);

        var columns = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailColumns, r =>
        {
            var name = r.GetString(1);
            var f = flags.GetValueOrDefault(name);
            return new ColumnDetail(name,
                OracleTypeText.Column(r.GetString(2), OracleDb.Str(r, 3), OracleDb.Int(r, 4), OracleDb.Int(r, 5), OracleDb.Str(r, 6),
                    OracleDb.Int(r, 7), OracleDb.Int(r, 8), owner),
                OracleDb.Str(r, 9) == "Y", OracleDb.Str(r, 10)?.Trim(), pk?.Columns.Contains(name) == true, f.Identity, f.Virtual,
                comments.GetValueOrDefault(name), OracleDb.Int(r, 0) ?? 0);
        }, ct, o, n).ConfigureAwait(false);

        var indexes = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailIndexes, r => (
                Name: r.GetString(0), Unique: OracleDb.Str(r, 1) == "UNIQUE", Type: OracleDb.Str(r, 2), Column: r.GetString(3)),
            ct, o, n).ConfigureAwait(false))
            .GroupBy(x => x.Name)
            .Select(g => new IndexDetail(g.Key, g.First().Unique, g.Select(x => x.Column).ToList(), g.First().Type, g.Key == pkIndex))
            .ToList();

        var fks = keys.Where(k => k.Type == "R").Select(fk =>
        {
            var hasTarget = referenced.TryGetValue((fk.ROwner ?? owner, fk.RConstraint ?? ""), out var target);
            return new ForeignKeyRef(fk.Name, fk.Columns, fk.ROwner ?? owner, hasTarget ? target.Table : "", hasTarget ? target.Columns : []);
        }).ToList();

        var referencedBy = (await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailReferencedBy, r => (
                Owner: r.GetString(0), Table: r.GetString(1), Constraint: r.GetString(2), Column: r.GetString(3)), ct, o, n).ConfigureAwait(false))
            .GroupBy(x => (x.Owner, x.Table, x.Constraint))
            .Select(g => new ReferencedBy(g.Key.Owner, g.Key.Table, g.Key.Constraint, g.Select(x => x.Column).ToList()))
            .ToList();

        var triggers = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.DetailTriggers, r => r.GetString(0), ct, o, n).ConfigureAwait(false);

        long? rows = null;
        if (obj.Type == ObjectTypes.Table)
        {
            var v = await OracleDb.ScalarAsync(_conn, OracleCatalogQueries.DetailRowCount, ct, o, n).ConfigureAwait(false);
            if (v is not null) rows = Convert.ToInt64(v);
        }
        return new ObjectDetails(refOut, columns, indexes, fks, referencedBy, triggers, [], rows, created, modified);
    }

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var owner = obj.Schema ?? await CurrentSchemaAsync(ct).ConfigureAwait(false);
        try
        {
            await OracleDb.ExecuteAsync(_conn, OracleCatalogQueries.DdlTransforms, ct).ConfigureAwait(false);
            var ddl = await OracleDb.ScalarAsync(_conn, OracleCatalogQueries.GetDdl, ct,
                ("type", OracleTypeText.MetadataType(obj.Type)), ("name", obj.Name), ("owner", owner)).ConfigureAwait(false);
            var text = ddl switch { OracleClob clob => clob.Value, null => null, _ => Convert.ToString(ddl) };
            if (!string.IsNullOrWhiteSpace(text)) return new DdlResult(NormalizeDdl(text), "stored");
        }
        catch (OracleException)
        {
            // ORA-31603 (not found / no privilege) and friends: fall back to the dictionary views below.
        }
        return await FallbackDdlAsync(obj with { Schema = owner }, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var owner = obj.Schema ?? await CurrentSchemaAsync(ct).ConfigureAwait(false);
        var types = OracleTypeText.SourceTypes(obj.Type);
        var rows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.ErrorsAnyType, r => (
            Line: OracleDb.Int(r, 0) ?? 0, Col: OracleDb.Int(r, 1) ?? 0, Text: (OracleDb.Str(r, 2) ?? "").TrimEnd(),
            Attribute: OracleDb.Str(r, 3), Type: OracleDb.Str(r, 4)), ct, ("owner", owner), ("name", obj.Name)).ConfigureAwait(false);
        return rows.Where(r => types.Length == 0 || types.Contains(r.Type))
            .Select(r => new ObjectError(r.Line, r.Col, r.Text, string.Equals(r.Attribute, "WARNING", StringComparison.OrdinalIgnoreCase) ? "warning" : "error"))
            .ToList();
    }

    public async Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(name);
        foreach (var candidate in new[] { name, name.ToUpperInvariant() }.Distinct(StringComparer.Ordinal))
        {
            var rows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.PublicSynonym, r => (
                Name: r.GetString(0), Target: SynonymTargetOf(OracleDb.Str(r, 1), r.GetString(2), OracleDb.Str(r, 3), OracleDb.Str(r, 4))),
                ct, ("name", candidate)).ConfigureAwait(false);
            if (rows.Count > 0)
                return new CatalogObject { Type = ObjectTypes.Synonym, Name = rows[0].Name, Schema = "PUBLIC", Target = rows[0].Target };
        }
        return null;
    }

    // ---------------------------------------------------------------- helpers

    private async Task<string> CurrentSchemaAsync(CancellationToken ct)
    {
        if (_currentSchema is not null) return _currentSchema;
        var v = await OracleDb.ScalarAsync(_conn, OracleCatalogQueries.CurrentSchema, ct).ConfigureAwait(false);
        return _currentSchema = Convert.ToString(v) ?? throw new InvalidOperationException("Could not determine the current schema.");
    }

    private static RawColumn ReadColumn(OracleDataReader r, string schema)
    {
        int flags = (OracleDb.Str(r, 12) == "YES" ? 1 : 0) | (OracleDb.Str(r, 11) == "YES" ? 2 : 0) | (OracleDb.Str(r, 13) == "YES" ? 4 : 0);
        return new RawColumn(r.GetString(0), OracleDb.Int(r, 1) ?? 0, r.GetString(2),
            OracleTypeText.Column(OracleDb.Str(r, 3) ?? "", OracleDb.Str(r, 4), OracleDb.Int(r, 5), OracleDb.Int(r, 6), OracleDb.Str(r, 7),
                OracleDb.Int(r, 8), OracleDb.Int(r, 9), schema),
            OracleDb.Str(r, 10) == "Y", flags);
    }

    public static SynonymTarget SynonymTargetOf(string? tableOwner, string tableName, string? dbLink, string? targetType) =>
        new(string.IsNullOrEmpty(dbLink) ? null : dbLink, tableOwner, tableName, OracleTypeText.ObjectType(targetType));

    private static List<ParamInfo> ToParams(IEnumerable<RawArgument> args)
    {
        var list = new List<ParamInfo>();
        foreach (var a in args.OrderBy(a => a.Position == 0 ? int.MaxValue : a.Position))
        {
            if (a.Position == 0)
            {
                if (a.DataType is not null) list.Add(new ParamInfo("", a.TypeText, "return", false));
                continue;
            }
            if (a.Name is null && a.DataType is null) continue; // placeholder row of a procedure without arguments
            list.Add(new ParamInfo(a.Name ?? "", a.TypeText, OracleTypeText.Direction(a.InOut), a.Defaulted));
        }
        return list;
    }

    /// <summary>Resolves (r_owner, r_constraint_name) → (table, columns) for FKs, batching IN lists of at most 1000 per owner.</summary>
    private async Task<Dictionary<(string Owner, string Constraint), (string Table, List<string> Columns)>> ResolveReferencedKeysAsync(
        string schema, IReadOnlyList<RawConstraint> constraints, CancellationToken ct)
    {
        var map = new Dictionary<(string, string), (string, List<string>)>();
        foreach (var k in constraints.Where(c => c.Type is "P" or "U"))
            map[(schema, k.Name)] = (k.Table, k.Columns);

        var needed = constraints.Where(c => c.Type == "R" && c.RConstraint is not null && !map.ContainsKey((c.ROwner ?? schema, c.RConstraint!)))
            .GroupBy(c => c.ROwner ?? schema);
        foreach (var group in needed)
        {
            var names = group.Select(c => c.RConstraint!).Distinct(StringComparer.Ordinal).ToList();
            for (int i = 0; i < names.Count; i += InListLimit)
            {
                var chunk = names.Skip(i).Take(InListLimit).ToList();
                var ps = new List<(string, object?)> { ("owner", group.Key) };
                ps.AddRange(chunk.Select((nm, j) => ("c" + j, (object?)nm)));
                var rows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.ReferencedColumns(chunk.Count), r => (
                    Owner: r.GetString(0), Constraint: r.GetString(1), Table: r.GetString(2), Column: r.GetString(3), Pos: OracleDb.Int(r, 4) ?? 0),
                    ct, ps.ToArray()).ConfigureAwait(false);
                foreach (var g in rows.GroupBy(x => (x.Owner, x.Constraint)))
                    map[g.Key] = (g.First().Table, g.OrderBy(x => x.Pos).Select(x => x.Column).ToList());
            }
        }
        return map;
    }

    private async Task<DdlResult> FallbackDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        var owner = obj.Schema!;
        var full = OracleSqlText.Quote(owner) + "." + OracleSqlText.Quote(obj.Name);
        switch (obj.Type)
        {
            case ObjectTypes.Table:
            {
                var details = await GetObjectDetailsAsync(obj, ct).ConfigureAwait(false);
                return new DdlResult(new OracleDdlGenerator().GenerateTableDdl(obj, details), "generated");
            }
            case ObjectTypes.View:
            {
                var text = await OracleDb.ScalarAsync(_conn, OracleCatalogQueries.ViewText, ct, ("owner", owner), ("name", obj.Name)).ConfigureAwait(false);
                if (text is null) break;
                return new DdlResult($"CREATE OR REPLACE VIEW {full} AS\n{Convert.ToString(text)!.TrimEnd()};\n", "stored");
            }
            case ObjectTypes.Sequence:
            {
                var rows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Sequences, r => (
                    Min: r.GetOracleDecimal(1).ToString(), Max: r.GetOracleDecimal(2).ToString(), Inc: r.GetOracleDecimal(3).ToString(),
                    Cycle: OracleDb.Str(r, 4) == "Y", Order: OracleDb.Str(r, 5) == "Y", Cache: r.GetOracleDecimal(6).ToString(),
                    Last: r.GetOracleDecimal(7).ToString()), ct, ("owner", owner), ("name", obj.Name)).ConfigureAwait(false);
                if (rows.Count == 0) break;
                var s = rows[0];
                return new DdlResult($"CREATE SEQUENCE {full}\n  MINVALUE {s.Min}\n  MAXVALUE {s.Max}\n  INCREMENT BY {s.Inc}\n  START WITH {s.Last}\n" +
                                     $"  {(s.Cache == "0" ? "NOCACHE" : "CACHE " + s.Cache)}\n  {(s.Order ? "ORDER" : "NOORDER")}\n  {(s.Cycle ? "CYCLE" : "NOCYCLE")};\n", "generated");
            }
            case ObjectTypes.Synonym:
            {
                var rows = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.SynonymByName, r => (
                    Owner: OracleDb.Str(r, 0), Table: r.GetString(1), Link: OracleDb.Str(r, 2)), ct, ("owner", owner), ("name", obj.Name)).ConfigureAwait(false);
                if (rows.Count == 0) break;
                var s = rows[0];
                var target = (s.Owner is null ? "" : OracleSqlText.Quote(s.Owner) + ".") + OracleSqlText.Quote(s.Table) + (s.Link is null ? "" : "@" + s.Link);
                return new DdlResult($"CREATE OR REPLACE SYNONYM {full} FOR {target};\n", "generated");
            }
            default:
            {
                var parts = new List<string>();
                foreach (var t in OracleTypeText.SourceTypes(obj.Type))
                {
                    var lines = await OracleDb.QueryAsync(_conn, OracleCatalogQueries.Source, r => OracleDb.Str(r, 0) ?? "", ct,
                        ("owner", owner), ("name", obj.Name), ("type", t)).ConfigureAwait(false);
                    if (lines.Count > 0) parts.Add("CREATE OR REPLACE " + string.Concat(lines).TrimEnd() + "\n/\n");
                }
                if (parts.Count > 0) return new DdlResult(string.Join("\n", parts), "stored");
                break;
            }
        }
        throw new EngineException(404, ErrorCodes.NotFound, $"No DDL is available for {obj.Type} {owner}.{obj.Name} (not found or insufficient privileges).");
    }

    /// <summary>GET_DDL output starts with blank lines and indents every statement by two spaces.</summary>
    private static string NormalizeDdl(string ddl)
    {
        var lines = ddl.Replace("\r\n", "\n").Split('\n');
        var trimmed = lines.Select(l => l.StartsWith("  CREATE ", StringComparison.Ordinal) || l.StartsWith("  ALTER ", StringComparison.Ordinal)
            || l.StartsWith("  COMMENT ", StringComparison.Ordinal) || l.StartsWith("  GRANT ", StringComparison.Ordinal) ? l[2..] : l);
        return string.Join("\n", trimmed).Trim() + "\n";
    }

    private sealed record RawColumn(string Table, int ColumnId, string Name, string TypeText, bool Nullable, int Flags);
    private sealed record RawConstraintColumn(string Name, string Type, string Table, string? ROwner, string? RConstraint, string Column, int Position);
    private sealed record RawConstraint(string Name, string Type, string Table, string? ROwner, string? RConstraint, List<string> Columns);
    private sealed record RawProcedure(string Object, string? Procedure, int SubprogramId, string? Overload, string ObjectType);
    private sealed record RawArgument(string? Package, string Object, int SubprogramId, string? Overload, string? Name, int Position,
        string TypeText, string? DataType, string? InOut, bool Defaulted);
}
