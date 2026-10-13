using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// SQLite catalog (docs/PLAN.md 2.6). Schemas are the attached databases (main + ATTACHed, temp excluded);
/// there is no database level (database arguments are ignored).
/// </summary>
internal sealed partial class SqliteCatalogReader(SqliteConnection connection, IDdlGenerator ddlGenerator) : ICatalogReader
{
    public const string MainSchema = "main";

    public ValueTask DisposeAsync() => connection.DisposeAsync();

    public async Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) =>
        (await DatabaseListAsync(ct).ConfigureAwait(false)).Select(d => d.Name).ToList();

    public Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => Task.FromResult<string?>(MainSchema);

    public async Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct)
    {
        var result = new List<SchemaInfo>();
        foreach (var (name, _) in await DatabaseListAsync(ct).ConfigureAwait(false))
        {
            var count = Convert.ToInt32(await ScalarAsync(
                $"SELECT count(*) FROM {SqliteNames.Quote(name)}.sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
                ct).ConfigureAwait(false));
            result.Add(new SchemaInfo(name, count));
        }
        return result;
    }

    public Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct) => Task.FromResult(MainSchema);

    public async Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct)
    {
        schema = await ResolveSchemaAsync(schema, ct).ConfigureAwait(false);
        var masters = await ReadMasterAsync(schema, ct).ConfigureAwait(false);
        var columns = await ReadColumnsAsync(schema, masters, ct).ConfigureAwait(false);
        var fks = await ReadForeignKeysAsync(schema, masters, columns, ct).ConfigureAwait(false);

        var objects = new List<CatalogObject>(masters.Count);
        foreach (var m in masters)
        {
            if (m.Type == "index" || IsShadowTable(m, masters)) continue;
            var cols = columns.TryGetValue(m.Name, out var c) ? c : [];
            objects.Add(new CatalogObject
            {
                Type = m.Type switch { "view" => ObjectTypes.View, "trigger" => ObjectTypes.Trigger, _ => ObjectTypes.Table },
                Name = m.Name,
                Schema = schema,
                Columns = cols.Select(x => new CatalogColumn(x.Name, x.Type, x.Nullable, x.PkOrdinal > 0, x.Flags)).ToList(),
                PrimaryKey = cols.Where(x => x.PkOrdinal > 0).OrderBy(x => x.PkOrdinal).Select(x => x.Name).ToList(),
                ForeignKeys = fks.TryGetValue(m.Name, out var f) ? f : [],
            });
        }
        return new SchemaCatalog(null, schema, objects);
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct)
    {
        var schema = await ResolveSchemaAsync(obj.Schema ?? MainSchema, ct).ConfigureAwait(false);
        var masters = await ReadMasterAsync(schema, ct).ConfigureAwait(false);
        var master = masters.FirstOrDefault(m => m.Type != "index" && m.Name.Equals(obj.Name, StringComparison.OrdinalIgnoreCase))
                     ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        var columnsByTable = await ReadColumnsAsync(schema, masters, ct).ConfigureAwait(false);
        var fks = await ReadForeignKeysAsync(schema, masters, columnsByTable, ct).ConfigureAwait(false);
        var cols = columnsByTable.TryGetValue(master.Name, out var c) ? c : [];
        var objectType = master.Type switch { "view" => ObjectTypes.View, "trigger" => ObjectTypes.Trigger, _ => ObjectTypes.Table };

        var columns = cols.Select(x => new ColumnDetail(
            x.Name, x.Type, x.Nullable, x.Default, x.PkOrdinal > 0, (x.Flags & 1) != 0, (x.Flags & 2) != 0, null, x.Cid + 1)).ToList();

        var indexes = master.Type == "table" ? await ReadIndexesAsync(schema, master.Name, ct).ConfigureAwait(false) : [];
        var referencedBy = fks
            .SelectMany(kv => kv.Value.Where(fk => fk.RefTable.Equals(master.Name, StringComparison.OrdinalIgnoreCase))
                .Select(fk => new ReferencedBy(schema, kv.Key, fk.Name, fk.Columns)))
            .OrderBy(r => r.Table, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var triggers = masters
            .Where(m => m.Type == "trigger" && m.TableName.Equals(master.Name, StringComparison.OrdinalIgnoreCase))
            .Select(m => m.Name).ToList();
        var rowEstimate = master.Type == "table" ? await EstimateRowsAsync(schema, master, ct).ConfigureAwait(false) : null;

        return new ObjectDetails(
            new ObjectRef(null, schema, master.Name, objectType),
            columns,
            indexes,
            fks.TryGetValue(master.Name, out var own) ? own : [],
            referencedBy,
            triggers,
            [],
            rowEstimate,
            null,
            null);
    }

    public async Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct)
    {
        var schema = await ResolveSchemaAsync(obj.Schema ?? MainSchema, ct).ConfigureAwait(false);
        var masters = await ReadMasterAsync(schema, ct).ConfigureAwait(false);
        var master = masters.FirstOrDefault(m => m.Name.Equals(obj.Name, StringComparison.OrdinalIgnoreCase))
                     ?? throw EngineException.NotFound($"Object {schema}.{obj.Name}");
        if (string.IsNullOrWhiteSpace(master.Sql))
        {
            var details = await GetObjectDetailsAsync(obj with { Schema = schema }, ct).ConfigureAwait(false);
            return new DdlResult(ddlGenerator.GenerateTableDdl(details.Ref, details), "generated");
        }

        var parts = new List<string> { Terminate(master.Sql) };
        if (master.Type == "table")
        {
            parts.AddRange(masters
                .Where(m => m.Type is "index" or "trigger" && m.TableName.Equals(master.Name, StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrWhiteSpace(m.Sql))
                .OrderBy(m => m.Type == "index" ? 0 : 1)
                .Select(m => Terminate(m.Sql!)));
        }
        return new DdlResult(string.Join(Environment.NewLine + Environment.NewLine, parts) + Environment.NewLine, "stored");
    }

    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<ObjectError>>([]);

    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => Task.FromResult<CatalogObject?>(null);

    // ------------------------------------------------------------------ queries

    internal sealed record MasterRow(string Type, string Name, string TableName, string? Sql)
    {
        public bool WithoutRowId => Sql is not null && WithoutRowIdRegex().IsMatch(Sql);
        public bool IsVirtual => Sql is not null && Sql.TrimStart().StartsWith("CREATE VIRTUAL", StringComparison.OrdinalIgnoreCase);
    }

    internal sealed record ColumnRow(int Cid, string Name, string Type, bool Nullable, string? Default, int PkOrdinal, int Flags);

    [GeneratedRegex(@"\)\s*(?:STRICT\s*,\s*)?WITHOUT\s+ROWID\s*(?:,\s*STRICT\s*)?;?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex WithoutRowIdRegex();

    private static string Terminate(string sql) => sql.TrimEnd().EndsWith(';') ? sql.TrimEnd() : sql.TrimEnd() + ";";

    private async Task<List<(string Name, string File)>> DatabaseListAsync(CancellationToken ct)
    {
        var list = new List<(string, string)>();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "PRAGMA database_list";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var name = r.GetString(1);
            if (name.Equals("temp", StringComparison.OrdinalIgnoreCase)) continue;
            list.Add((name, r.IsDBNull(2) ? "" : r.GetString(2)));
        }
        return list;
    }

    private async Task<string> ResolveSchemaAsync(string schema, CancellationToken ct)
    {
        var dbs = await DatabaseListAsync(ct).ConfigureAwait(false);
        var match = dbs.FirstOrDefault(d => d.Name.Equals(schema, StringComparison.OrdinalIgnoreCase));
        return match.Name ?? throw EngineException.NotFound($"Schema (attached database) '{schema}'");
    }

    private async Task<object?> ScalarAsync(string sql, CancellationToken ct, params (string, object?)[] args)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (n, v) in args) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        return await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
    }

    private async Task<List<MasterRow>> ReadMasterAsync(string schema, CancellationToken ct)
    {
        var rows = new List<MasterRow>();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = $"SELECT type, name, tbl_name, sql FROM {SqliteNames.Quote(schema)}.sqlite_master " +
                          "WHERE type IN ('table','view','trigger','index') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
            rows.Add(new MasterRow(r.GetString(0), r.GetString(1), r.GetString(2), r.IsDBNull(3) ? null : r.GetString(3)));
        return rows;
    }

    private const string ColumnsSelect =
        "SELECT m.name, p.cid, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk, p.hidden FROM {0}.sqlite_master m " +
        "JOIN pragma_table_xinfo(m.name, $schema) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";

    private async Task<Dictionary<string, List<ColumnRow>>> ReadColumnsAsync(string schema, List<MasterRow> masters, CancellationToken ct)
    {
        var raw = new List<(string Table, int Cid, string Name, string Type, bool NotNull, string? Default, int Pk, int Hidden)>();
        try
        {
            await ReadColumnRowsAsync(string.Format(ColumnsSelect, SqliteNames.Quote(schema)) + " ORDER BY m.name, p.cid", schema, null, raw, ct).ConfigureAwait(false);
        }
        catch (SqliteException)
        {
            // A broken view (referencing a dropped table) fails the bulk query: fall back to one query per object.
            raw.Clear();
            foreach (var m in masters.Where(m => m.Type is "table" or "view"))
            {
                try
                {
                    await ReadColumnRowsAsync(string.Format(ColumnsSelect, SqliteNames.Quote(schema)) + " AND m.name = $name ORDER BY p.cid", schema, m.Name, raw, ct).ConfigureAwait(false);
                }
                catch (SqliteException)
                {
                    // Unreadable object: list it without columns.
                }
            }
        }

        var byName = masters.Where(m => m.Type is "table" or "view").ToDictionary(m => m.Name, StringComparer.OrdinalIgnoreCase);
        var result = new Dictionary<string, List<ColumnRow>>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in raw.GroupBy(x => x.Table, StringComparer.OrdinalIgnoreCase))
        {
            byName.TryGetValue(group.Key, out var master);
            var pkCount = group.Count(x => x.Pk > 0);
            var list = new List<ColumnRow>();
            foreach (var x in group)
            {
                var isRowIdAlias = master is { Type: "table", WithoutRowId: false } && pkCount == 1 && x.Pk == 1
                                   && x.Type.Equals("INTEGER", StringComparison.OrdinalIgnoreCase);
                var flags = (isRowIdAlias ? 1 : 0) | (x.Hidden is 2 or 3 ? 2 : 0) | (x.Hidden == 1 ? 4 : 0);
                // Primary-key columns are presented as NOT NULL (SQLite's legacy NULL-in-PK quirk is ignored).
                list.Add(new ColumnRow(x.Cid, x.Name, x.Type, !x.NotNull && x.Pk == 0, x.Default, x.Pk, flags));
            }
            result[group.Key] = list;
        }
        return result;
    }

    private async Task ReadColumnRowsAsync(string sql, string schema, string? name,
        List<(string, int, string, string, bool, string?, int, int)> into, CancellationToken ct)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("$schema", schema);
        if (name is not null) cmd.Parameters.AddWithValue("$name", name);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            into.Add((r.GetString(0), r.GetInt32(1), r.GetString(2), r.IsDBNull(3) ? "" : r.GetString(3),
                r.GetInt64(4) != 0, r.IsDBNull(5) ? null : r.GetString(5), r.GetInt32(6), r.GetInt32(7)));
        }
    }

    private async Task<Dictionary<string, List<ForeignKeyRef>>> ReadForeignKeysAsync(
        string schema, List<MasterRow> masters, Dictionary<string, List<ColumnRow>> columns, CancellationToken ct)
    {
        var raw = new List<(string Table, int Id, int Seq, string RefTable, string From, string? To)>();
        await using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText =
                $"SELECT m.name, f.id, f.seq, f.\"table\", f.\"from\", f.\"to\" FROM {SqliteNames.Quote(schema)}.sqlite_master m " +
                "JOIN pragma_foreign_key_list(m.name, $schema) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq";
            cmd.Parameters.AddWithValue("$schema", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
                raw.Add((r.GetString(0), r.GetInt32(1), r.GetInt32(2), r.GetString(3), r.GetString(4), r.IsDBNull(5) ? null : r.GetString(5)));
        }

        var sqlByTable = masters.Where(m => m.Type == "table").ToDictionary(m => m.Name, m => m.Sql, StringComparer.OrdinalIgnoreCase);
        var result = new Dictionary<string, List<ForeignKeyRef>>(StringComparer.OrdinalIgnoreCase);
        foreach (var table in raw.GroupBy(x => x.Table, StringComparer.OrdinalIgnoreCase))
        {
            var names = sqlByTable.TryGetValue(table.Key, out var sql) && sql is not null ? ForeignKeyNames(sql) : new();
            var list = new List<ForeignKeyRef>();
            // pragma ids are numbered in reverse declaration order; present FKs in declaration order.
            foreach (var fk in table.GroupBy(x => x.Id).OrderByDescending(g => g.Key))
            {
                var parts = fk.OrderBy(x => x.Seq).ToList();
                var refTable = parts[0].RefTable;
                var from = parts.Select(x => x.From).ToList();
                var to = parts.Select(x => x.To).ToList();
                List<string> refColumns;
                if (to.All(t => t is not null)) refColumns = to.Select(t => t!).ToList();
                else
                {
                    // REFERENCES t without a column list targets t's primary key.
                    refColumns = columns.TryGetValue(refTable, out var rc)
                        ? rc.Where(c => c.PkOrdinal > 0).OrderBy(c => c.PkOrdinal).Select(c => c.Name).ToList()
                        : [];
                }
                var refName = masters.FirstOrDefault(m => m.Type == "table" && m.Name.Equals(refTable, StringComparison.OrdinalIgnoreCase))?.Name ?? refTable;
                var key = string.Join(",", from.Select(f => f.ToLowerInvariant()));
                var name = names.TryGetValue(key, out var n) ? n : $"fk_{table.Key}_{fk.Key}";
                list.Add(new ForeignKeyRef(name, from, schema, refName, refColumns));
            }
            result[table.Key] = list;
        }
        return result;
    }

    /// <summary>
    /// Constraint names of FKs declared in a CREATE TABLE statement, keyed by lower-cased comma-joined column list.
    /// Handles table constraints (CONSTRAINT n FOREIGN KEY (a, b) REFERENCES ...) and column constraints
    /// (col TYPE CONSTRAINT n REFERENCES ...).
    /// </summary>
    internal static Dictionary<string, string> ForeignKeyNames(string createTableSql)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var tokens = SqlTokenizer.Tokenize(createTableSql, Dialect.Sqlite);
        var open = tokens.FindIndex(t => t.IsPunct('('));
        if (open < 0) return result;

        var defs = new List<List<SqlToken>>();
        var current = new List<SqlToken>();
        var depth = 0;
        for (var i = open + 1; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.IsPunct('(')) depth++;
            else if (t.IsPunct(')'))
            {
                if (depth == 0) { defs.Add(current); break; }
                depth--;
            }
            else if (t.IsPunct(',') && depth == 0) { defs.Add(current); current = []; continue; }
            current.Add(t);
        }

        foreach (var def in defs)
        {
            if (def.Count < 2) continue;
            if (def[0].IsWord("CONSTRAINT") && def.Count > 3 && def[2].IsWord("FOREIGN"))
            {
                var cols = ParenIdentifiers(def, 3);
                if (cols.Count > 0) result.TryAdd(string.Join(",", cols.Select(c => c.ToLowerInvariant())), def[1].Value);
                continue;
            }
            if (def[0].IsWord("FOREIGN") || def[0].IsWord("PRIMARY") || def[0].IsWord("UNIQUE") || def[0].IsWord("CHECK") || def[0].IsWord("CONSTRAINT"))
                continue;
            // Column definition: name ... CONSTRAINT n REFERENCES
            for (var k = 1; k + 2 < def.Count; k++)
            {
                if (def[k].IsWord("CONSTRAINT") && def[k + 2].IsWord("REFERENCES"))
                {
                    result.TryAdd(def[0].Value.ToLowerInvariant(), def[k + 1].Value);
                    break;
                }
            }
        }
        return result;
    }

    private static List<string> ParenIdentifiers(List<SqlToken> def, int from)
    {
        var list = new List<string>();
        var start = def.FindIndex(from, t => t.IsPunct('('));
        if (start < 0) return list;
        for (var i = start + 1; i < def.Count && !def[i].IsPunct(')'); i++)
            if (def[i].IsIdentifier) list.Add(def[i].Value);
        return list;
    }

    private async Task<List<IndexDetail>> ReadIndexesAsync(string schema, string table, CancellationToken ct)
    {
        var indexes = new List<(string Name, bool Unique, string Origin)>();
        await using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = "SELECT name, \"unique\", origin FROM pragma_index_list($table, $schema) ORDER BY seq";
            cmd.Parameters.AddWithValue("$table", table);
            cmd.Parameters.AddWithValue("$schema", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
                indexes.Add((r.GetString(0), r.GetInt64(1) != 0, r.GetString(2)));
        }

        var result = new List<IndexDetail>();
        foreach (var (name, unique, origin) in indexes)
        {
            var cols = new List<string>();
            await using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT name FROM pragma_index_info($index, $schema) ORDER BY seqno";
            cmd.Parameters.AddWithValue("$index", name);
            cmd.Parameters.AddWithValue("$schema", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false)) cols.Add(r.IsDBNull(0) ? "<expression>" : r.GetString(0));
            var type = origin switch { "pk" => "primary key", "u" => "unique constraint", _ => "index" };
            result.Add(new IndexDetail(name, unique, cols, type, origin == "pk"));
        }
        return result;
    }

    private async Task<long?> EstimateRowsAsync(string schema, MasterRow table, CancellationToken ct)
    {
        try
        {
            var hasStat = Convert.ToInt64(await ScalarAsync(
                $"SELECT count(*) FROM {SqliteNames.Quote(schema)}.sqlite_master WHERE name = 'sqlite_stat1'", ct).ConfigureAwait(false)) > 0;
            if (hasStat)
            {
                var stat = await ScalarAsync($"SELECT stat FROM {SqliteNames.Quote(schema)}.sqlite_stat1 WHERE tbl = $t ORDER BY idx IS NOT NULL LIMIT 1",
                    ct, ("$t", table.Name)).ConfigureAwait(false) as string;
                var first = stat?.Split(' ', 2)[0];
                if (long.TryParse(first, out var n)) return n;
            }
            if (!table.WithoutRowId && !table.IsVirtual)
            {
                var max = await ScalarAsync($"SELECT max(_rowid_) FROM {SqliteNames.Quote(schema)}.{SqliteNames.Quote(table.Name)}", ct).ConfigureAwait(false);
                return max is null or DBNull ? 0 : Convert.ToInt64(max);
            }
        }
        catch (DbException)
        {
            // Estimates are best effort.
        }
        return null;
    }

    private static readonly string[] FtsShadowSuffixes = ["_data", "_idx", "_content", "_docsize", "_config", "_segments", "_segdir", "_stat", "_node", "_parent", "_rowid"];

    private static bool IsShadowTable(MasterRow m, List<MasterRow> all)
    {
        if (m.Type != "table") return false;
        foreach (var suffix in FtsShadowSuffixes)
        {
            if (!m.Name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
            var owner = m.Name[..^suffix.Length];
            if (all.Any(v => v.IsVirtual && v.Name.Equals(owner, StringComparison.OrdinalIgnoreCase))) return true;
        }
        return false;
    }
}
