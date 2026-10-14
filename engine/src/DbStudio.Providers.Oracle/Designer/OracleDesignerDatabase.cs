using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle.Designer;

/// <summary>
/// Oracle side of the designer: table models from ALL_TAB_COLS / ALL_TAB_IDENTITY_COLS / ALL_COL_COMMENTS /
/// ALL_CONSTRAINTS / ALL_CONS_COLUMNS / ALL_INDEXES / ALL_IND_COLUMNS, and apply statement by statement (Oracle DDL
/// commits implicitly, so the request's transactional flag cannot apply; the first error stops the script).
/// </summary>
public sealed partial class OracleDesignerDatabase : IDesignerDatabase
{
    public string ProviderId => "oracle";

    public const string TableQuery =
        "SELECT t.table_name, c.comments, t.tablespace_name FROM all_tables t " +
        "LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name " +
        "WHERE t.owner = :owner AND t.table_name = :name";

    public const string ColumnsQuery =
        "SELECT c.column_name, c.data_type, c.data_type_owner, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, " +
        "c.nullable, c.data_default, c.virtual_column, cm.comments, c.column_id FROM all_tab_cols c " +
        "LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name " +
        "WHERE c.owner = :owner AND c.table_name = :name AND c.hidden_column = 'NO' ORDER BY c.column_id";

    public const string IdentityQuery =
        "SELECT column_name, generation_type, identity_options FROM all_tab_identity_cols WHERE owner = :owner AND table_name = :name";

    public const string ConstraintsQuery =
        "SELECT constraint_name, constraint_type, search_condition, r_owner, r_constraint_name, delete_rule, index_name " +
        "FROM all_constraints WHERE owner = :owner AND table_name = :name AND constraint_type IN ('P', 'U', 'R', 'C')";

    public const string ConstraintColumnsQuery =
        "SELECT constraint_name, column_name, position FROM all_cons_columns WHERE owner = :owner AND table_name = :name ORDER BY constraint_name, position";

    public const string ReferencedColumnsQuery =
        "SELECT rc.owner, rc.table_name, rc.column_name, rc.position, c.constraint_name FROM all_constraints c " +
        "JOIN all_cons_columns rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name " +
        "WHERE c.owner = :owner AND c.table_name = :name AND c.constraint_type = 'R' ORDER BY c.constraint_name, rc.position";

    public const string IndexesQuery =
        "SELECT i.index_name, i.uniqueness, ic.column_name, ic.column_position, ic.descend FROM all_indexes i " +
        "JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name " +
        "WHERE i.table_owner = :owner AND i.table_name = :name AND i.index_type IN ('NORMAL', 'FUNCTION-BASED NORMAL') " +
        "ORDER BY i.index_name, ic.column_position";

    public const string IndexExpressionsQuery =
        "SELECT index_name, column_position, column_expression FROM all_ind_expressions WHERE table_owner = :owner AND table_name = :name";

    public const string ViewQuery = "SELECT view_name, text FROM all_views WHERE owner = :owner AND view_name = :name";

    public const string ViewConstraintsQuery =
        "SELECT constraint_type FROM all_constraints WHERE owner = :owner AND table_name = :name AND constraint_type IN ('V', 'O')";

    private static async Task<OracleConnection> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var conn = new OracleConnection(OracleConnectionStrings.Build(profile, password, pooling: false));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            conn.ModuleName = "DbStudio";
            conn.ClientInfo = "DbStudio designer";
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static async Task<string> CurrentSchemaAsync(OracleConnection conn, CancellationToken ct) =>
        Convert.ToString(await OracleDb.ScalarAsync(conn, OracleCatalogQueries.CurrentSchema, ct).ConfigureAwait(false), CultureInfo.InvariantCulture) ?? "";

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, ct).ConfigureAwait(false);
        return new DdlScriptContext(conn.ServerVersion, await CurrentSchemaAsync(conn, ct).ConfigureAwait(false));
    }

    /// <summary>Exact name first, then the folded (upper-case) name.</summary>
    private static async Task<(string Owner, string Name, string? Comment, string? Tablespace)> FindTableAsync(OracleConnection conn, string owner, string name, CancellationToken ct)
    {
        foreach (var (o, n) in new[] { (owner, name), (OracleDdlScripter.Fold(owner), OracleDdlScripter.Fold(name)), (owner.ToUpperInvariant(), name.ToUpperInvariant()) }.Distinct())
        {
            var rows = await OracleDb.QueryAsync(conn, TableQuery, r => (OracleDb.Str(r, 0)!, OracleDb.Str(r, 1), OracleDb.Str(r, 2)), ct, ("owner", o), ("name", n)).ConfigureAwait(false);
            if (rows.Count > 0) return (o, rows[0].Item1, rows[0].Item2, rows[0].Item3);
        }
        throw EngineException.NotFound($"Table {owner}.{name}");
    }

    [GeneratedRegex("""^\s*"[^"]+"\s+IS\s+NOT\s+NULL\s*$""", RegexOptions.IgnoreCase)]
    private static partial Regex NotNullCheck();

    [GeneratedRegex(@"START WITH:\s*(-?\d+).*?INCREMENT BY:\s*(-?\d+)", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex IdentityOptions();

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, ct).ConfigureAwait(false);
        var owner = string.IsNullOrWhiteSpace(schema) ? await CurrentSchemaAsync(conn, ct).ConfigureAwait(false) : schema;
        var (o, table, comment, _) = await FindTableAsync(conn, owner, name, ct).ConfigureAwait(false);
        (string, object?)[] args = [("owner", o), ("name", table)];

        var identities = new Dictionary<string, IdentityModel>(StringComparer.Ordinal);
        try
        {
            foreach (var (col, gen, options) in await OracleDb.QueryAsync(conn, IdentityQuery, r => (OracleDb.Str(r, 0)!, OracleDb.Str(r, 1), OracleDb.Str(r, 2)), ct, args).ConfigureAwait(false))
            {
                var m = IdentityOptions().Match(options ?? "");
                identities[col] = new IdentityModel(
                    m.Success ? long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : 1,
                    m.Success ? long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) : 1,
                    string.Equals(gen, "ALWAYS", StringComparison.OrdinalIgnoreCase));
            }
        }
        catch (OracleException ex) when (ex.Number == 942)
        {
            // 11g: no identity columns.
        }

        var columns = await OracleDb.QueryAsync(conn, ColumnsQuery, r =>
        {
            var colName = OracleDb.Str(r, 0)!;
            var isVirtual = OracleDb.Str(r, 10) == "YES";
            var dataDefault = OracleDb.Str(r, 9)?.Trim();
            identities.TryGetValue(colName, out var identity);
            return new TableColumnModel
            {
                Id = colName,
                Name = colName,
                Type = OracleTypeText.Column(OracleDb.Str(r, 1) ?? "", OracleDb.Str(r, 2), OracleDb.Int(r, 3), OracleDb.Int(r, 4), OracleDb.Str(r, 5),
                    OracleDb.Int(r, 6), OracleDb.Int(r, 7), o),
                Nullable = OracleDb.Str(r, 8) != "N",
                Default = isVirtual || identity is not null || string.IsNullOrEmpty(dataDefault) || dataDefault.Equals("NULL", StringComparison.OrdinalIgnoreCase) ? null : dataDefault,
                Identity = identity,
                Computed = isVirtual && dataDefault is not null ? new ComputedModel(dataDefault, false) : null,
                Comment = OracleDb.Str(r, 11),
            };
        }, ct, args).ConfigureAwait(false);

        var constraints = await OracleDb.QueryAsync(conn, ConstraintsQuery, r => (
            Name: OracleDb.Str(r, 0)!, Type: OracleDb.Str(r, 1)!, Condition: OracleDb.Str(r, 2), DeleteRule: OracleDb.Str(r, 5), Index: OracleDb.Str(r, 6)), ct, args).ConfigureAwait(false);
        var consColumns = (await OracleDb.QueryAsync(conn, ConstraintColumnsQuery, r => (Name: OracleDb.Str(r, 0)!, Column: OracleDb.Str(r, 1)!), ct, args).ConfigureAwait(false))
            .GroupBy(x => x.Name).ToDictionary(g => g.Key, g => g.Select(x => x.Column).ToList(), StringComparer.Ordinal);
        var refColumns = (await OracleDb.QueryAsync(conn, ReferencedColumnsQuery, r => (Owner: OracleDb.Str(r, 0)!, Table: OracleDb.Str(r, 1)!, Column: OracleDb.Str(r, 2)!, Constraint: OracleDb.Str(r, 4)!), ct, args).ConfigureAwait(false))
            .GroupBy(x => x.Constraint).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        PrimaryKeyModel? pk = null;
        var uniques = new List<UniqueModel>();
        var fks = new List<ForeignKeyModel>();
        var checks = new List<CheckModel>();
        var constraintIndexes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in constraints.OrderBy(c => c.Name, StringComparer.Ordinal))
        {
            var cols = consColumns.GetValueOrDefault(c.Name) ?? [];
            if (c.Index is not null) constraintIndexes.Add(c.Index);
            switch (c.Type)
            {
                case "P":
                    pk = new PrimaryKeyModel { Name = c.Name, Columns = cols, Clustered = true };
                    break;
                case "U":
                    uniques.Add(new UniqueModel { Name = c.Name, Columns = cols });
                    break;
                case "R":
                    var refs = refColumns.GetValueOrDefault(c.Name) ?? [];
                    fks.Add(new ForeignKeyModel
                    {
                        Name = c.Name,
                        Columns = cols,
                        RefSchema = refs.FirstOrDefault().Owner,
                        RefTable = refs.FirstOrDefault().Table ?? "",
                        RefColumns = refs.Select(x => x.Column).ToList(),
                        OnDelete = ReferentialActions.Normalize(c.DeleteRule),
                        OnUpdate = ReferentialActions.NoAction,
                    });
                    break;
                case "C":
                    if (c.Condition is null || NotNullCheck().IsMatch(c.Condition)) break;
                    checks.Add(new CheckModel { Name = c.Name, Expression = c.Condition.Trim() });
                    break;
            }
        }

        var expressions = new Dictionary<(string, int), string>();
        try
        {
            foreach (var (ix, pos, expr) in await OracleDb.QueryAsync(conn, IndexExpressionsQuery, r => (OracleDb.Str(r, 0)!, OracleDb.Int(r, 1) ?? 0, OracleDb.Str(r, 2)), ct, args).ConfigureAwait(false))
                if (expr is not null) expressions[(ix, pos)] = expr.Trim();
        }
        catch (OracleException)
        {
            // Expressions are cosmetic (DESC index columns); keep going.
        }
        var ixRows = await OracleDb.QueryAsync(conn, IndexesQuery, r => (Name: OracleDb.Str(r, 0)!, Unique: OracleDb.Str(r, 1) == "UNIQUE",
            Column: OracleDb.Str(r, 2)!, Position: OracleDb.Int(r, 3) ?? 0, Desc: OracleDb.Str(r, 4) == "DESC"), ct, args).ConfigureAwait(false);
        var indexes = ixRows.Where(x => !constraintIndexes.Contains(x.Name)).GroupBy(x => x.Name).Select(g => new IndexModel
        {
            Name = g.Key,
            Unique = g.First().Unique,
            Columns = g.OrderBy(x => x.Position).Select(x =>
            {
                var colName = x.Column;
                if (colName.StartsWith("SYS_NC", StringComparison.Ordinal) && expressions.TryGetValue((g.Key, x.Position), out var e))
                    colName = e.Length >= 2 && e[0] == '"' && e[^1] == '"' ? e[1..^1] : e;
                return new IndexColumnModel(colName, x.Desc);
            }).ToList(),
        }).ToList();

        return new TableModel
        {
            Schema = o,
            Name = table,
            Comment = comment,
            Columns = columns,
            PrimaryKey = pk,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = fks,
            Checks = checks,
        };
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, ct).ConfigureAwait(false);
        var owner = string.IsNullOrWhiteSpace(schema) ? await CurrentSchemaAsync(conn, ct).ConfigureAwait(false) : schema;
        foreach (var (o, n) in new[] { (owner, name), (OracleDdlScripter.Fold(owner), OracleDdlScripter.Fold(name)) }.Distinct())
        {
            var rows = await OracleDb.QueryAsync(conn, ViewQuery, r => (OracleDb.Str(r, 0)!, OracleDb.Str(r, 1) ?? ""), ct, ("owner", o), ("name", n)).ConfigureAwait(false);
            if (rows.Count == 0) continue;
            var (viewName, text) = rows[0];
            var kinds = await OracleDb.QueryAsync(conn, ViewConstraintsQuery, r => OracleDb.Str(r, 0), ct, ("owner", o), ("name", viewName)).ConfigureAwait(false);
            var body = text.Trim();
            var options = new ViewOptions(CheckOption: kinds.Contains("V"));
            var ddl = $"CREATE OR REPLACE VIEW {OracleDdlScripter.Table(o, viewName)} AS\n{body}" + (options.CheckOption ? "\nWITH CHECK OPTION" : kinds.Contains("O") ? "\nWITH READ ONLY" : "");
            return new ViewModel(o, viewName, body, options, ddl);
        }
        throw EngineException.NotFound($"View {owner}.{name}");
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, ct).ConfigureAwait(false);
        var runner = new DdlApplyRunner
        {
            MapError = (ex, _) => OracleProvider.ToProviderError(ex),
            PrepareSql = raw => OracleSqlText.Prepare(raw).Sql,
            Configure = cmd => ((OracleCommand)cmd).BindByName = true,
        };
        // Oracle DDL commits implicitly: a transaction would not roll anything back.
        return await runner.RunAsync(conn, request.Statements, transactional: false, ct).ConfigureAwait(false);
    }
}
