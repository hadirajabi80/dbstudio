using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Designer;

/// <summary>
/// SQLite side of the designer: table models from <c>pragma_table_xinfo</c>, <c>pragma_index_list/xinfo</c>,
/// <c>pragma_foreign_key_list</c> and the parsed <c>sqlite_master.sql</c>; apply in one transaction with
/// <c>PRAGMA foreign_keys</c> switched outside it and <c>PRAGMA foreign_key_check</c> verified before commit.
/// Every call opens its own short-lived connection.
/// </summary>
public sealed partial class SqliteDesignerDatabase : IDesignerDatabase
{
    public string ProviderId => "sqlite";

    private static Task<SqliteConnection> OpenAsync(ConnectionProfile profile, CancellationToken ct) =>
        SqliteConnections.OpenAsync(profile, forceReadOnly: false, ct);

    private static string Schema(string? schema) => string.IsNullOrWhiteSpace(schema) ? SqliteDdlScripter.MainSchema : schema;

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var c = await OpenAsync(profile, ct).ConfigureAwait(false);
        var version = Convert.ToString(await ScalarAsync(c, "SELECT sqlite_version()", ct).ConfigureAwait(false));
        IReadOnlyList<DependentObject> dependents = [];
        if (!string.IsNullOrWhiteSpace(table)) dependents = await ReadDependentsAsync(c, Schema(schema), table, ct).ConfigureAwait(false);
        return new DdlScriptContext(version, SqliteDdlScripter.MainSchema, dependents);
    }

    /// <summary>Triggers on the table, plus views and triggers of other tables whose SQL mentions it.</summary>
    internal static async Task<IReadOnlyList<DependentObject>> ReadDependentsAsync(SqliteConnection c, string schema, string table, CancellationToken ct)
    {
        var list = new List<DependentObject>();
        var word = new Regex(@"(?<![\w$])[""\[`]?" + Regex.Escape(table) + @"[""\]`]?(?![\w$])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        await using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT type, name, tbl_name, sql FROM {SqliteNames.Quote(schema)}.sqlite_master WHERE type IN ('trigger','view') AND sql IS NOT NULL ORDER BY type DESC, name";
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        while (await r.ReadAsync(ct).ConfigureAwait(false))
        {
            var type = r.GetString(0);
            var name = r.GetString(1);
            var tblName = r.GetString(2);
            var sql = r.GetString(3);
            var onTable = type == "trigger" && tblName.Equals(table, StringComparison.OrdinalIgnoreCase);
            if (onTable || word.IsMatch(sql)) list.Add(new DependentObject(type, name, sql, onTable));
        }
        return list;
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var c = await OpenAsync(profile, ct).ConfigureAwait(false);
        return await ReadTableAsync(c, Schema(schema), name, ct).ConfigureAwait(false);
    }

    internal static async Task<TableModel> ReadTableAsync(SqliteConnection c, string schema, string name, CancellationToken ct)
    {
        var s = SqliteNames.Quote(schema);
        string? createSql = null;
        string? actualName = null;
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = $"SELECT name, sql FROM {s}.sqlite_master WHERE type = 'table' AND name = $n COLLATE NOCASE";
            cmd.Parameters.AddWithValue("$n", name);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            if (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                actualName = r.GetString(0);
                createSql = r.IsDBNull(1) ? null : r.GetString(1);
            }
        }
        if (actualName is null) throw EngineException.NotFound($"Table {schema}.{name}");
        var parsed = SqliteCreateTableParser.Parse(createSql);
        var q = SqliteNames.Quote(actualName);

        // Columns
        var columns = new List<TableColumnModel>();
        var pkCols = new List<(int Ordinal, string Name)>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = $"SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo($t, $s) ORDER BY cid";
            cmd.Parameters.AddWithValue("$t", actualName);
            cmd.Parameters.AddWithValue("$s", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var hidden = r.GetInt32(6);
                if (hidden == 1) continue; // virtual-table hidden column
                var colName = r.GetString(1);
                parsed.Columns.TryGetValue(colName, out var pc);
                var computed = hidden is 2 or 3 && pc?.GeneratedExpression is { } expr ? new ComputedModel(expr, hidden == 3) : null;
                var pk = r.GetInt32(5);
                if (pk > 0) pkCols.Add((pk, colName));
                columns.Add(new TableColumnModel
                {
                    Id = colName,
                    Name = colName,
                    Type = r.IsDBNull(2) ? "" : r.GetString(2),
                    Nullable = r.GetInt32(3) == 0,
                    Default = computed is null && !r.IsDBNull(4) ? r.GetString(4) : null,
                    Computed = computed,
                    Collation = pc?.Collation,
                    Autoincrement = pc?.Autoincrement ?? false,
                });
            }
        }

        // Indexes and unique constraints
        var indexes = new List<IndexModel>();
        var uniques = new List<UniqueModel>();
        var indexList = new List<(string Name, bool Unique, string Origin)>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT name, \"unique\", origin FROM pragma_index_list($t, $s) ORDER BY seq DESC";
            cmd.Parameters.AddWithValue("$t", actualName);
            cmd.Parameters.AddWithValue("$s", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false)) indexList.Add((r.GetString(0), r.GetInt32(1) != 0, r.GetString(2)));
        }
        foreach (var (ixName, unique, origin) in indexList)
        {
            if (origin == "pk") continue;
            var cols = new List<IndexColumnModel>();
            await using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT name, \"desc\" FROM pragma_index_xinfo($i, $s) WHERE key = 1 ORDER BY seqno";
                cmd.Parameters.AddWithValue("$i", ixName);
                cmd.Parameters.AddWithValue("$s", schema);
                await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
                while (await r.ReadAsync(ct).ConfigureAwait(false))
                    cols.Add(new IndexColumnModel(r.IsDBNull(0) ? "(expression)" : r.GetString(0), r.GetInt32(1) != 0));
            }
            if (origin == "u")
            {
                var names = cols.Select(x => x.Name).ToList();
                var match = parsed.Uniques.FirstOrDefault(u => u.Columns.Count == names.Count && u.Columns.Zip(names).All(p => p.First.Equals(p.Second, StringComparison.OrdinalIgnoreCase)));
                uniques.Add(new UniqueModel { Name = match?.Name, Columns = names });
                continue;
            }
            string? ixSql = null;
            await using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = $"SELECT sql FROM {s}.sqlite_master WHERE type = 'index' AND name = $i";
                cmd.Parameters.AddWithValue("$i", ixName);
                ixSql = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false) as string;
            }
            indexes.Add(new IndexModel
            {
                Name = ixName,
                Columns = cols,
                Unique = unique,
                Filter = SqliteCreateTableParser.IndexFilter(ixSql),
            });
        }
        indexes.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

        // Foreign keys
        var fkRows = new List<(int Id, int Seq, string Table, string From, string? To, string OnUpdate, string OnDelete)>();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list($t, $s) ORDER BY id, seq";
            cmd.Parameters.AddWithValue("$t", actualName);
            cmd.Parameters.AddWithValue("$s", schema);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
                fkRows.Add((r.GetInt32(0), r.GetInt32(1), r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4), r.GetString(5), r.GetString(6)));
        }
        var foreignKeys = new List<ForeignKeyModel>();
        foreach (var g in fkRows.GroupBy(x => x.Id).OrderByDescending(g => g.Key))
        {
            var rows = g.OrderBy(x => x.Seq).ToList();
            var cols = rows.Select(x => x.From).ToList();
            var refTable = rows[0].Table;
            var parsedFk = parsed.ForeignKeys.FirstOrDefault(f => f.RefTable.Equals(refTable, StringComparison.OrdinalIgnoreCase)
                                                                  && f.Columns.Count == cols.Count
                                                                  && f.Columns.Zip(cols).All(p => p.First.Equals(p.Second, StringComparison.OrdinalIgnoreCase)));
            foreignKeys.Add(new ForeignKeyModel
            {
                Name = parsedFk?.Name,
                Columns = cols,
                RefTable = refTable,
                RefColumns = rows.All(x => x.To is not null) ? rows.Select(x => x.To!).ToList() : parsedFk?.RefColumns.ToList() ?? [],
                OnDelete = ReferentialActions.Normalize(rows[0].OnDelete),
                OnUpdate = ReferentialActions.Normalize(rows[0].OnUpdate),
            });
        }

        var pkColumns = pkCols.OrderBy(p => p.Ordinal).Select(p => p.Name).ToList();
        return new TableModel
        {
            Schema = schema,
            Name = actualName,
            Options = new TableOptions { WithoutRowid = parsed.WithoutRowid, Strict = parsed.Strict },
            Columns = columns,
            PrimaryKey = pkColumns.Count > 0 ? new PrimaryKeyModel { Name = parsed.PrimaryKeyName, Columns = pkColumns, Clustered = true } : null,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = foreignKeys,
            Checks = parsed.Checks.Select(ck => new CheckModel { Name = ck.Name, Expression = ck.Expression }).ToList(),
        };
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var c = await OpenAsync(profile, ct).ConfigureAwait(false);
        var sch = Schema(schema);
        await using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT name, sql FROM {SqliteNames.Quote(sch)}.sqlite_master WHERE type = 'view' AND name = $n COLLATE NOCASE";
        cmd.Parameters.AddWithValue("$n", name);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false)) throw EngineException.NotFound($"View {sch}.{name}");
        var sql = r.IsDBNull(1) ? "" : r.GetString(1);
        return new ViewModel(sch, r.GetString(0), SqliteCreateTableParser.ViewBody(sql), new ViewOptions(), sql);
    }

    [GeneratedRegex(@"^\s*PRAGMA\s+(?:\w+\.)?foreign_keys\s*=\s*(ON|OFF|1|0|TRUE|FALSE|YES|NO)\s*;?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex ForeignKeysPragma();

    [GeneratedRegex(@"^\s*PRAGMA\s+(?:\w+\.)?foreign_key_check\b", RegexOptions.IgnoreCase)]
    private static partial Regex ForeignKeyCheckPragma();

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        await using var c = await OpenAsync(profile, ct).ConfigureAwait(false);

        // PRAGMA foreign_keys is a no-op inside a transaction: switch it around the transaction instead.
        var body = new List<string>(request.Statements.Count);
        bool? fkOff = null;
        foreach (var sql in request.Statements)
        {
            var m = ForeignKeysPragma().Match(sql ?? "");
            if (m.Success)
            {
                var on = m.Groups[1].Value.ToUpperInvariant() is "ON" or "1" or "TRUE" or "YES";
                if (!on) fkOff = true;
                body.Add(""); // keep statement indexes stable
                continue;
            }
            body.Add(sql ?? "");
        }

        var before = Convert.ToInt64(await ScalarAsync(c, "PRAGMA foreign_keys", ct).ConfigureAwait(false));
        if (fkOff == true) await ExecAsync(c, "PRAGMA foreign_keys = OFF", ct).ConfigureAwait(false);
        try
        {
            var runner = new DdlApplyRunner
            {
                MapError = (ex, _) => SqliteProvider.ToError(ex),
                // A console holding a lock must not make the apply hang: wait up to the busy timeout, and let a cancel
                // (request aborted) end the driver's busy-retry loop, which sqlite3_interrupt alone does not.
                CommandTimeoutSeconds = SqliteConnections.BusyTimeoutSeconds(profile),
                Execute = async (cmd, token) =>
                {
                    await using var stopWaiting = token.Register(static c => SqliteConnections.StopBusyWait((DbCommand)c!), cmd);
                    if (!ForeignKeyCheckPragma().IsMatch(cmd.CommandText))
                    {
                        await cmd.ExecuteNonQueryAsync(token).ConfigureAwait(false);
                        return;
                    }
                    var problems = new List<string>();
                    await using var r = await cmd.ExecuteReaderAsync(token).ConfigureAwait(false);
                    while (await r.ReadAsync(token).ConfigureAwait(false) && problems.Count < 5)
                        problems.Add($"{r.GetValue(0)} row {r.GetValue(1)} → {r.GetValue(2)}");
                    if (problems.Count > 0)
                        throw new ForeignKeyCheckException("Foreign key check failed: " + string.Join("; ", problems) + ".");
                },
            };
            return await runner.RunAsync(c, body, request.Transactional, ct).ConfigureAwait(false);
        }
        finally
        {
            if (fkOff == true)
            {
                try { await ExecAsync(c, before != 0 ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF", CancellationToken.None).ConfigureAwait(false); }
                catch (SqliteException) { /* the connection closes right after */ }
            }
        }
    }

    private sealed class ForeignKeyCheckException(string message) : Exception(message);

    private static async Task<object?> ScalarAsync(SqliteConnection c, string sql, CancellationToken ct)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
    }

    private static async Task ExecAsync(DbConnection c, string sql, CancellationToken ct)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }
}
