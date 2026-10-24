using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// MySQL / MariaDB catalog reader (plan-batch3 WP-MY) over one pooled connection. Single-level (D2): databases are the
/// schemas, <c>database</c> arguments are ignored and the "current database" is the profile's database (or the first user
/// database). Objects: tables, views, MariaDB sequences, procedures and functions (with parameters), triggers and events
/// (as <c>proc</c> with the comment "event"). DDL comes from <c>SHOW CREATE …</c>.
/// </summary>
public sealed class MySqlCatalogReader : ICatalogReader
{
    private readonly MySqlConnection _conn;
    private readonly ConnectionProfile _profile;
    private MySqlFlavor? _flavor;
    private string? _current;
    private bool _currentRead;

    private MySqlCatalogReader(MySqlConnection conn, ConnectionProfile profile)
    {
        _conn = conn;
        _profile = profile;
    }

    internal MySqlConnection Connection => _conn;

    public static async Task<MySqlCatalogReader> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var b = MySqlConnectionStrings.Builder(profile, password, pooling: true);
        b.ApplicationName = MySqlConnectionStrings.ApplicationName + " catalog";
        var conn = new MySqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            await MySqlDb.InitializeAsync(conn, profile, session: false, ct).ConfigureAwait(false);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        return new MySqlCatalogReader(conn, profile);
    }

    public ValueTask DisposeAsync() => _conn.DisposeAsync();

    internal async Task<MySqlFlavor> FlavorAsync(CancellationToken ct)
    {
        if (_flavor is not null) return _flavor;
        var facts = await MySqlDb.ServerFactsAsync(_conn, ct).ConfigureAwait(false);
        _flavor = facts.Flavor;
        if (!_currentRead) { _current = facts.Database; _currentRead = true; }
        return _flavor;
    }

    public Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);

    public async Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => await GetDefaultSchemaAsync(null, ct).ConfigureAwait(false);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct) =>
        await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Schemas, r => new SchemaInfo(MySqlDb.S(r, 0), MySqlDb.Int(r, 1)), ct).ConfigureAwait(false);

    /// <summary>The profile's database (DATABASE() of the catalog connection), else the first user database.</summary>
    public async Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct)
    {
        await FlavorAsync(ct).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(_current)) return _current;
        var schemas = await ListSchemasAsync(null, ct).ConfigureAwait(false);
        return schemas.FirstOrDefault()?.Name ?? "";
    }

    internal async Task<string> SchemaOf(ObjectRef obj, CancellationToken ct) =>
        string.IsNullOrEmpty(obj.Schema) ? await GetDefaultSchemaAsync(null, ct).ConfigureAwait(false) : obj.Schema;

    // ------------------------------------------------------------------ schema snapshot

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(schema);
        var flavor = await FlavorAsync(ct).ConfigureAwait(false);
        var exists = await MySqlDb.ScalarAsync(_conn, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = @p0", ct, schema).ConfigureAwait(false) as string;
        if (exists is null) throw EngineException.NotFound($"Database '{schema}'");
        schema = exists;

        var tables = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Tables,
            r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Comment: MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 2)), Engine: MySqlDb.Str(r, 3)), ct, schema).ConfigureAwait(false);
        var columns = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Columns, MySqlTableReader.ReadColumn, ct, schema).ConfigureAwait(false);
        var keys = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.KeyColumns, MySqlTableReader.ReadKey, ct, schema).ConfigureAwait(false);
        var routines = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Routines,
            r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Returns: MySqlDb.Str(r, 2), Comment: MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 3))), ct, schema).ConfigureAwait(false);
        var parameters = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Parameters, ReadParam, ct, schema).ConfigureAwait(false);
        var triggers = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Triggers,
            r => (Name: MySqlDb.S(r, 0), Table: MySqlDb.S(r, 1), Timing: MySqlDb.S(r, 2), Event: MySqlDb.S(r, 3)), ct, schema).ConfigureAwait(false);
        List<(string Name, string? Comment, string Status)> events;
        try
        {
            events = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.Events,
                r => (MySqlDb.S(r, 0), MySqlTableReader.NullIfEmpty(MySqlDb.Str(r, 1)), MySqlDb.S(r, 2)), ct, schema).ConfigureAwait(false);
        }
        catch (MySqlException) { events = []; }
        var referencing = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.ReferencingSchemas, r => MySqlDb.S(r, 0), ct, schema).ConfigureAwait(false);

        var colsByTable = columns.GroupBy(c => c.Table, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.OrderBy(c => c.Ordinal).ToList(), StringComparer.Ordinal);
        var keysByTable = keys.GroupBy(k => k.Table, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        var objects = new List<CatalogObject>(tables.Count + routines.Count + triggers.Count + events.Count);
        foreach (var t in tables)
        {
            var type = MySqlTableReader.ObjectType(t.Type);
            var tk = keysByTable.GetValueOrDefault(t.Name) ?? [];
            var pk = tk.Where(k => k.Type == "PRIMARY KEY").OrderBy(k => k.Position).Select(k => k.Column).ToList();
            var pkSet = new HashSet<string>(pk, StringComparer.OrdinalIgnoreCase);
            var fks = tk.Where(k => k.Type == "FOREIGN KEY").GroupBy(k => k.Constraint, StringComparer.Ordinal)
                .Select(g => new ForeignKeyRef(g.Key, g.OrderBy(x => x.Position).Select(x => x.Column).ToList(), g.First().RefSchema, g.First().RefTable ?? "",
                    g.OrderBy(x => x.Position).Select(x => x.RefColumn ?? "").ToList())).ToList();
            objects.Add(new CatalogObject
            {
                Type = type,
                Name = t.Name,
                Schema = schema,
                Comment = type == ObjectTypes.View && t.Comment == "VIEW" ? null : t.Comment,
                Columns = type == ObjectTypes.Sequence ? [] : (colsByTable.GetValueOrDefault(t.Name) ?? []).Select(c => new CatalogColumn(c.Name, c.ColumnType, c.Nullable,
                    pkSet.Contains(c.Name), (c.IsAutoIncrement ? 1 : 0) | (c.IsGenerated ? 2 | 8 : 0) | (c.IsInvisible ? 4 : 0), c.Comment)).ToList(),
                PrimaryKey = pk,
                ForeignKeys = fks,
            });
        }

        var paramsByRoutine = parameters.GroupBy(p => (p.Routine, p.Type)).ToDictionary(g => g.Key, g => g.OrderBy(p => p.Ordinal).ToList());
        foreach (var r in routines)
        {
            var isFunc = r.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase);
            var ps = paramsByRoutine.GetValueOrDefault((r.Name, r.Type.ToUpperInvariant())) ?? paramsByRoutine.GetValueOrDefault((r.Name, r.Type)) ?? [];
            objects.Add(new CatalogObject
            {
                Type = isFunc ? ObjectTypes.Func : ObjectTypes.Proc,
                Name = r.Name,
                Schema = schema,
                Comment = r.Comment,
                Parameters = MapParameters(ps, isFunc, r.Returns),
            });
        }

        foreach (var tr in triggers)
            objects.Add(new CatalogObject { Type = ObjectTypes.Trigger, Name = tr.Name, Schema = schema, Comment = $"{tr.Timing} {tr.Event} on {tr.Table}" });

        foreach (var ev in events)
        {
            if (routines.Any(r => r.Name.Equals(ev.Name, StringComparison.OrdinalIgnoreCase) && !r.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase))) continue;
            var comment = "event" + (ev.Status.Equals("ENABLED", StringComparison.OrdinalIgnoreCase) ? "" : $" ({ev.Status.ToLowerInvariant()})")
                          + (ev.Comment is null ? "" : ": " + ev.Comment);
            objects.Add(new CatalogObject { Type = ObjectTypes.Proc, Name = ev.Name, Schema = schema, Comment = comment });
        }

        _ = flavor;
        return new SchemaCatalog(null, schema, objects) { ReferencingSchemas = referencing };
    }

    internal sealed record RawParam(string Routine, string Type, string? Name, string? Mode, string? DataType, int Ordinal);

    internal static RawParam ReadParam(MySqlDataReader r) =>
        new(MySqlDb.S(r, 0), MySqlDb.S(r, 1).ToUpperInvariant(), MySqlDb.Str(r, 2), MySqlDb.Str(r, 3), MySqlDb.Str(r, 4), MySqlDb.Int(r, 5));

    /// <summary>IN / OUT / INOUT parameters in order and, for functions, the "return" entry (ordinal 0).</summary>
    internal static List<ParamInfo> MapParameters(IReadOnlyList<RawParam> ps, bool isFunction, string? returns)
    {
        var list = new List<ParamInfo>();
        foreach (var p in ps.Where(p => p.Ordinal > 0 && p.Name is not null))
        {
            var dir = (p.Mode ?? "IN").ToUpperInvariant() switch { "OUT" => "out", "INOUT" => "inout", _ => "in" };
            list.Add(new ParamInfo(p.Name!, p.DataType ?? "", dir, false));
        }
        if (isFunction)
        {
            var ret = ps.FirstOrDefault(p => p.Ordinal == 0)?.DataType ?? returns ?? "";
            list.Add(new ParamInfo("", ret, "return", false));
        }
        return list;
    }

    // ------------------------------------------------------------------ details

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var schema = await SchemaOf(obj, ct).ConfigureAwait(false);
        var flavor = await FlavorAsync(ct).ConfigureAwait(false);

        if (obj.Type is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc)
        {
            var routine = (await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.FindRoutine,
                r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1), Created: MySqlDb.Time(r, 3), Altered: MySqlDb.Time(r, 4)), ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
            if (routine.Name is null)
            {
                var ev = (await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.FindEvent, r => (Name: MySqlDb.S(r, 0), Created: MySqlDb.Time(r, 3), Altered: MySqlDb.Time(r, 4)),
                    ct, schema, obj.Name).ConfigureAwait(false)).FirstOrDefault();
                if (ev.Name is null) throw EngineException.NotFound($"Routine {schema}.{obj.Name}");
                return new ObjectDetails(obj with { Schema = schema, Name = ev.Name }, [], [], [], [], [], [], null, ev.Created, ev.Altered);
            }
            var ps = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.RoutineParameters, ReadParam, ct, schema, routine.Name).ConfigureAwait(false);
            var isFunc = routine.Type.Equals("FUNCTION", StringComparison.OrdinalIgnoreCase);
            var mine = ps.Where(p => p.Type == routine.Type.ToUpperInvariant()).ToList();
            return new ObjectDetails(obj with { Schema = schema, Name = routine.Name }, [], [], [], [], [], MapParameters(mine, isFunc, null), null, routine.Created, routine.Altered);
        }

        if (obj.Type == ObjectTypes.Trigger)
        {
            var tr = (await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.FindTrigger, r => (Name: MySqlDb.S(r, 0), Created: MySqlDb.Time(r, 6)), ct, schema, obj.Name)
                .ConfigureAwait(false)).FirstOrDefault();
            if (tr.Name is null) throw EngineException.NotFound($"Trigger {schema}.{obj.Name}");
            return new ObjectDetails(obj with { Schema = schema, Name = tr.Name }, [], [], [], [], [], [], null, tr.Created, null);
        }

        var info = await MySqlTableReader.TableInfoAsync(_conn, schema, obj.Name, ct).ConfigureAwait(false)
                   ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var name = info.Name;
        var type = MySqlTableReader.ObjectType(info.Type);
        if (type == ObjectTypes.Sequence)
            return new ObjectDetails(obj with { Schema = schema, Name = name, Type = type }, [], [], [], [], [], [], null, info.Created, null);

        var columns = await MySqlTableReader.ColumnsAsync(_conn, schema, name, ct).ConfigureAwait(false);
        var keys = await MySqlTableReader.KeysAsync(_conn, schema, name, ct).ConfigureAwait(false);
        var pk = keys.Where(k => k.Type == "PRIMARY KEY").Select(k => k.Column).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var details = columns.Select(c => new ColumnDetail(c.Name, c.ColumnType, c.Nullable,
            c.IsGenerated ? c.Generation : MySqlTableReader.DefaultExpression(c, flavor.IsMariaDb), pk.Contains(c.Name), c.IsAutoIncrement, c.IsGenerated, c.Comment, c.Ordinal)).ToList();

        var indexes = type == ObjectTypes.View ? [] : (await MySqlTableReader.IndexesAsync(_conn, schema, name, ct).ConfigureAwait(false))
            .GroupBy(i => i.Index, StringComparer.Ordinal)
            .Select(g => new IndexDetail(g.Key, g.First().Unique, g.OrderBy(x => x.Seq).Select(x => x.Column is null ? "(expression)" : x.SubPart is { } sp ? $"{x.Column}({sp})" : x.Column).ToList(),
                g.First().IndexType, g.Key == "PRIMARY")).ToList();
        var outgoing = keys.Where(k => k.Type == "FOREIGN KEY").GroupBy(k => k.Constraint, StringComparer.Ordinal)
            .Select(g => new ForeignKeyRef(g.Key, g.OrderBy(x => x.Position).Select(x => x.Column).ToList(), g.First().RefSchema, g.First().RefTable ?? "",
                g.OrderBy(x => x.Position).Select(x => x.RefColumn ?? "").ToList())).ToList();
        var incoming = (await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.ReferencingKeys,
                r => (Schema: MySqlDb.S(r, 0), Table: MySqlDb.S(r, 1), Constraint: MySqlDb.S(r, 2), Column: MySqlDb.S(r, 3), Position: MySqlDb.Int(r, 4)), ct, schema, name).ConfigureAwait(false))
            .GroupBy(x => (x.Schema, x.Table, x.Constraint))
            .Select(g => new ReferencedBy(g.Key.Schema, g.Key.Table, g.Key.Constraint, g.OrderBy(x => x.Position).Select(x => x.Column).ToList())).ToList();
        var triggers = await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.TableTriggers, r => MySqlDb.S(r, 0), ct, schema, name).ConfigureAwait(false);
        return new ObjectDetails(obj with { Schema = schema, Name = name, Type = type }, details, indexes, outgoing, incoming, triggers, [],
            type == ObjectTypes.Table ? info.Rows : null, info.Created, info.Updated);
    }

    // ------------------------------------------------------------------ DDL

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var schema = await SchemaOf(obj, ct).ConfigureAwait(false);
        var q = MySqlSqlText.Qualify(schema, obj.Name);
        switch (obj.Type)
        {
            case ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc:
            {
                var routine = (await MySqlDb.QueryAsync(_conn, MySqlCatalogQueries.FindRoutine, r => (Name: MySqlDb.S(r, 0), Type: MySqlDb.S(r, 1)), ct, schema, obj.Name)
                    .ConfigureAwait(false)).FirstOrDefault();
                if (routine.Name is not null)
                    return new DdlResult(await ShowCreateAsync($"SHOW CREATE {routine.Type.ToUpperInvariant()} {MySqlSqlText.Qualify(schema, routine.Name)}", 2, ct).ConfigureAwait(false)
                        ?? $"-- The definition of {schema}.{routine.Name} is not visible (it needs the SHOW_ROUTINE privilege or ownership).\n", "stored");
                var ev = await ShowCreateAsync($"SHOW CREATE EVENT {q}", 3, ct).ConfigureAwait(false);
                if (ev is not null) return new DdlResult(ev, "stored");
                throw EngineException.NotFound($"Routine {schema}.{obj.Name}");
            }
            case ObjectTypes.Trigger:
                return new DdlResult(await ShowCreateAsync($"SHOW CREATE TRIGGER {q}", 2, ct).ConfigureAwait(false)
                    ?? throw EngineException.NotFound($"Trigger {schema}.{obj.Name}"), "stored");
        }

        var info = await MySqlTableReader.TableInfoAsync(_conn, schema, obj.Name, ct).ConfigureAwait(false)
                   ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var name = MySqlSqlText.Qualify(schema, info.Name);
        var type = MySqlTableReader.ObjectType(info.Type);
        var ddl = type switch
        {
            ObjectTypes.View => await ShowCreateAsync($"SHOW CREATE VIEW {name}", 1, ct).ConfigureAwait(false),
            ObjectTypes.Sequence => await ShowCreateAsync($"SHOW CREATE SEQUENCE {name}", 1, ct).ConfigureAwait(false),
            _ => await ShowCreateAsync($"SHOW CREATE TABLE {name}", 1, ct).ConfigureAwait(false),
        };
        return new DdlResult(ddl ?? $"-- SHOW CREATE returned nothing for {schema}.{info.Name}.\n", "stored");
    }

    /// <summary>Column <paramref name="column"/> of the first row of a SHOW CREATE statement, terminated with ";\n".</summary>
    internal async Task<string?> ShowCreateAsync(string sql, int column, CancellationToken ct)
    {
        try
        {
            await using var cmd = MySqlDb.Command(_conn, sql);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            if (!await r.ReadAsync(ct).ConfigureAwait(false) || r.FieldCount <= column) return null;
            var text = MySqlDb.Str(r, column);
            if (string.IsNullOrWhiteSpace(text)) return null;
            text = text.TrimEnd();
            return text.EndsWith(';') ? text + "\n" : text + ";\n";
        }
        catch (MySqlException ex) when (ex.Number is 1305 or 1360 or 1539 or 1146 or 1347 or 4089)
        {
            // does not exist / not a view / not a sequence
            return null;
        }
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) => Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);

    internal ConnectionProfile Profile => _profile;
}
