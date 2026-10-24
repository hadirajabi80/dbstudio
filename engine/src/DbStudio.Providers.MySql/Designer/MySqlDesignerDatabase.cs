using System.Text.RegularExpressions;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using MySqlConnector;

namespace DbStudio.Providers.MySql.Designer;

/// <summary>
/// MySQL / MariaDB side of the designer (plan-batch3 WP-MY): table models from information_schema (COLUMNS, STATISTICS,
/// KEY_COLUMN_USAGE, REFERENTIAL_CONSTRAINTS, CHECK_CONSTRAINTS), view bodies from VIEWS, and apply on a dedicated
/// unpooled connection, statement by statement (DDL commits implicitly in MySQL, so a script is never transactional).
/// </summary>
public sealed partial class MySqlDesignerDatabase(string providerId = "mysql") : IDesignerDatabase
{
    public string ProviderId => providerId;

    private static async Task<MySqlConnection> OpenAsync(ConnectionProfile profile, string? password, bool pooling, CancellationToken ct)
    {
        var b = MySqlConnectionStrings.Builder(profile, password, pooling);
        b.ApplicationName = MySqlConnectionStrings.ApplicationName + " designer";
        var conn = new MySqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            await MySqlDb.InitializeAsync(conn, profile, session: false, ct).ConfigureAwait(false);
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
        await using var conn = await OpenAsync(profile, password, pooling: true, ct).ConfigureAwait(false);
        var (flavor, _, db, _) = await MySqlDb.ServerFactsAsync(conn, ct).ConfigureAwait(false);
        var version = flavor.IsMariaDb ? flavor.ProductVersion + "-MariaDB" : flavor.ProductVersion;
        return new DdlScriptContext(version, string.IsNullOrWhiteSpace(schema) ? db : schema);
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, pooling: true, ct).ConfigureAwait(false);
        return await ReadTableAsync(conn, schema, name, ct).ConfigureAwait(false);
    }

    [GeneratedRegex(@"^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex IntDisplayWidth();

    [GeneratedRegex(@"`([A-Za-z_][A-Za-z0-9_$]*)`", RegexOptions.CultureInvariant)]
    private static partial Regex PlainBackticks();

    /// <summary>"int(11)" → "int" (display widths are deprecated; MariaDB still reports them), keeping tinyint(1) and ZEROFILL types.</summary>
    internal static string CanonicalType(string columnType)
    {
        var t = columnType.Trim();
        if (t.StartsWith("tinyint(1)", StringComparison.OrdinalIgnoreCase) || t.Contains("zerofill", StringComparison.OrdinalIgnoreCase)) return t;
        return IntDisplayWidth().Replace(t, "$1");
    }

    /// <summary>"(`amount` >= 0)" → "amount >= 0".</summary>
    internal static string CheckExpression(string clause) => TableDiff.StripOuterParens(PlainBackticks().Replace(clause.Trim(), "$1"));

    internal static async Task<TableModel> ReadTableAsync(MySqlConnection conn, string? schema, string name, CancellationToken ct)
    {
        var (flavor, _, db, _) = await MySqlDb.ServerFactsAsync(conn, ct).ConfigureAwait(false);
        schema = string.IsNullOrWhiteSpace(schema) ? db : schema;
        if (string.IsNullOrWhiteSpace(schema)) throw EngineException.Validation("No database selected for the table.", new { field = "schema" });
        var info = await MySqlTableReader.TableInfoAsync(conn, schema, name, ct).ConfigureAwait(false);
        if (info is null || MySqlTableReader.ObjectType(info.Value.Type) != ObjectTypes.Table) throw EngineException.NotFound($"Table {schema}.{name}");
        var table = info.Value.Name;
        var tableCollation = info.Value.Collation;

        var columns = (await MySqlTableReader.ColumnsAsync(conn, schema, table, ct).ConfigureAwait(false)).Select(c =>
        {
            var def = MySqlTableReader.DefaultExpression(c, flavor.IsMariaDb);
            if (c.OnUpdate is { } upd) def = (def ?? "NULL") + " ON UPDATE " + upd;
            return new TableColumnModel
            {
                Id = c.Name,
                Name = c.Name,
                Type = CanonicalType(c.ColumnType),
                Nullable = c.Nullable,
                Default = c.IsGenerated ? null : def,
                Computed = c.IsGenerated && c.Generation is not null ? new ComputedModel(TableDiff.StripOuterParens(c.Generation), c.IsStored) : null,
                Collation = c.Collation is not null && tableCollation is not null && !c.Collation.Equals(tableCollation, StringComparison.OrdinalIgnoreCase) ? c.Collation : null,
                Comment = c.Comment,
                Autoincrement = c.IsAutoIncrement,
            };
        }).ToList();

        var keys = await MySqlTableReader.KeysAsync(conn, schema, table, ct).ConfigureAwait(false);
        var actions = await MySqlTableReader.ActionsAsync(conn, schema, table, ct).ConfigureAwait(false);
        var pkCols = keys.Where(k => k.Type == "PRIMARY KEY").OrderBy(k => k.Position).Select(k => k.Column).ToList();
        var fks = keys.Where(k => k.Type == "FOREIGN KEY").GroupBy(k => k.Constraint, StringComparer.Ordinal).Select(g =>
        {
            var cols = g.OrderBy(x => x.Position).ToList();
            var (del, upd) = actions.GetValueOrDefault(g.Key, ("NO ACTION", "NO ACTION"));
            return new ForeignKeyModel
            {
                Name = g.Key,
                Columns = cols.Select(x => x.Column).ToList(),
                RefSchema = cols[0].RefSchema,
                RefTable = cols[0].RefTable ?? "",
                RefColumns = cols.Select(x => x.RefColumn ?? "").ToList(),
                OnDelete = del,
                OnUpdate = upd,
            };
        }).ToList();

        var uniques = new List<UniqueModel>();
        var indexes = new List<IndexModel>();
        foreach (var g in (await MySqlTableReader.IndexesAsync(conn, schema, table, ct).ConfigureAwait(false)).GroupBy(i => i.Index, StringComparer.Ordinal))
        {
            if (g.Key == "PRIMARY") continue;
            var cols = g.OrderBy(x => x.Seq).ToList();
            // FULLTEXT / SPATIAL / functional indexes are not part of the model (left alone by alters).
            if (cols.Any(c => c.Column is null) || cols[0].IndexType is "FULLTEXT" or "SPATIAL" or "VECTOR") continue;
            var names = cols.Select(c => c.Column!).ToList();
            // The index InnoDB created for a foreign key (same name and columns) belongs to the key.
            if (fks.Any(f => f.Name == g.Key && f.Columns.SequenceEqual(names, StringComparer.OrdinalIgnoreCase))) continue;
            var simple = cols.All(c => c.SubPart is null && !c.Desc);
            if (cols[0].Unique && simple)
            {
                uniques.Add(new UniqueModel { Name = g.Key, Columns = names });
                continue;
            }
            indexes.Add(new IndexModel
            {
                Name = g.Key,
                Unique = cols[0].Unique,
                Columns = cols.Select(c => new IndexColumnModel(c.SubPart is { } sp ? $"{c.Column}({sp})" : c.Column!, c.Desc)).ToList(),
            });
        }

        var checks = (await MySqlTableReader.ChecksAsync(conn, flavor, schema, table, ct).ConfigureAwait(false))
            // MariaDB lists a column-level CHECK under the column's name; MySQL names unnamed ones <table>_chk_<n>.
            .Select(c => new CheckModel { Name = c.Name, Expression = CheckExpression(c.Clause) }).ToList();

        return new TableModel
        {
            Schema = schema,
            Name = table,
            Comment = info.Value.Comment,
            Columns = columns,
            PrimaryKey = pkCols.Count > 0 ? new PrimaryKeyModel { Name = "PRIMARY", Columns = pkCols, Clustered = false } : null,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = fks,
            Checks = checks,
        };
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, pooling: true, ct).ConfigureAwait(false);
        var (_, _, db, _) = await MySqlDb.ServerFactsAsync(conn, ct).ConfigureAwait(false);
        schema = string.IsNullOrWhiteSpace(schema) ? db : schema;
        var rows = await MySqlDb.QueryAsync(conn,
            "SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION, CHECK_OPTION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1",
            r => (Schema: MySqlDb.S(r, 0), Name: MySqlDb.S(r, 1), Def: MySqlDb.Str(r, 2), Check: MySqlDb.S(r, 3)), ct, schema, name).ConfigureAwait(false);
        if (rows.Count == 0) throw EngineException.NotFound($"View {schema}.{name}");
        var v = rows[0];
        if (string.IsNullOrWhiteSpace(v.Def))
            throw new EngineException(422, ErrorCodes.ProviderError, $"The definition of {v.Schema}.{v.Name} is not visible (it needs the SHOW VIEW privilege).");
        var body = v.Def.Trim().TrimEnd(';').TrimEnd();
        var check = v.Check is "CASCADED" or "LOCAL";
        var ddl = $"CREATE OR REPLACE VIEW {MySqlSqlText.Qualify(v.Schema, v.Name)} AS\n{body}{(check ? $"\nWITH {v.Check} CHECK OPTION" : "")};\n";
        return new ViewModel(v.Schema, v.Name, body, new ViewOptions(CheckOption: check), ddl);
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var b = MySqlConnectionStrings.Builder(profile, password, pooling: false, request.Schema);
        b.ApplicationName = MySqlConnectionStrings.ApplicationName + " designer";
        await using var conn = new MySqlConnection(b.ConnectionString);
        await conn.OpenAsync(ct).ConfigureAwait(false);
        await MySqlDb.InitializeAsync(conn, profile, session: false, ct).ConfigureAwait(false);
        var runner = new DdlApplyRunner
        {
            MapError = (ex, sql) => ex is MySqlException my
                ? MySqlErrors.FromException(my, new SqlBatch(sql, 1, 1), 0, sql)
                : MySqlErrors.ToProviderError(ex),
            // DELIMITER-wrapped hand edits: run the statement without the client delimiter.
            PrepareSql = sql =>
            {
                var parts = MySqlSqlText.Split(sql);
                return parts.Count == 1 ? parts[0].Text(sql) : sql.Trim();
            },
        };
        // MySQL DDL commits implicitly: never one transaction (a rollback could not undo the executed statements).
        return await runner.RunAsync(conn, request.Statements, transactional: false, ct).ConfigureAwait(false);
    }
}
