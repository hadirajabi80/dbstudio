using System.Diagnostics;
using System.Text.RegularExpressions;
using ClickHouse.Driver;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.ClickHouse.Designer;

/// <summary>
/// Database side of the ClickHouse designer (plan-batch3 WP-CH): reads table/view models from <c>system.tables</c>,
/// <c>system.columns</c>, <c>system.data_skipping_indices</c> and the CHECK constraints of <c>create_table_query</c>, and
/// applies scripts statement by statement (ClickHouse DDL is not transactional: the first failure stops, nothing is rolled
/// back) on a sessionless connection.
/// </summary>
public sealed partial class ChDesignerDatabase(ClickHouseProvider provider) : IDesignerDatabase
{
    public ChDesignerDatabase() : this(new ClickHouseProvider()) { }

    public string ProviderId => "clickhouse";

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var reader = await provider.OpenReaderAsync(profile, password, ct).ConfigureAwait(false);
        var version = await ChDb.ScalarAsync(reader.Channel.Connection, "SELECT version()", ct).ConfigureAwait(false) as string;
        return new DdlScriptContext(version, schema ?? reader.DefaultDatabase);
    }

    [GeneratedRegex(@"CONSTRAINT\s+(?<name>`(?:[^`\\]|\\.)+`|[A-Za-z_][A-Za-z0-9_]*)\s+CHECK\s+", RegexOptions.CultureInvariant)]
    private static partial Regex CheckHead();

    /// <summary>CHECK constraints of a CREATE TABLE statement (name, expression).</summary>
    public static List<CheckModel> ParseChecks(string createQuery)
    {
        var list = new List<CheckModel>();
        foreach (Match m in CheckHead().Matches(createQuery))
        {
            var start = m.Index + m.Length;
            var end = ExpressionEnd(createQuery, start);
            var name = m.Groups["name"].Value;
            if (name.StartsWith('`')) name = name[1..^1].Replace("\\`", "`");
            list.Add(new CheckModel { Name = name, Expression = createQuery[start..end].Trim() });
        }
        return list;
    }

    /// <summary>End of an expression inside the column list: the next depth-0 ',' or the ')' closing the list.</summary>
    private static int ExpressionEnd(string s, int start)
    {
        var depth = 0;
        var quote = '\0';
        for (var i = start; i < s.Length; i++)
        {
            var c = s[i];
            if (quote != '\0')
            {
                if (c == '\\') { i++; continue; }
                if (c == quote) quote = '\0';
                continue;
            }
            if (c is '\'' or '`' or '"') quote = c;
            else if (c == '(') depth++;
            else if (c == ')')
            {
                if (depth == 0) return i;
                depth--;
            }
            else if (c == ',' && depth == 0) return i;
        }
        return s.Length;
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var reader = await provider.OpenReaderAsync(profile, password, ct).ConfigureAwait(false);
        var db = schema ?? reader.DefaultDatabase;
        var conn = reader.Channel.Connection;
        var info = (await ChDb.QueryAsync(conn, ChCatalogQueries.TableInfo, r => (Engine: ChDb.S(r, 0), Comment: ChDb.Str(r, 1),
            PrimaryKey: ChDb.Str(r, 2), SortingKey: ChDb.Str(r, 3), Create: ChDb.S(r, 10)), ct, ("db", db), ("t", name)).ConfigureAwait(false)).FirstOrDefault();
        if (info == default || ChCatalogReader.ObjectType(info.Engine) != ObjectTypes.Table) throw EngineException.NotFound($"Table {db}.{name}");

        var cols = await reader.ReadColumnsAsync(db, name, ct).ConfigureAwait(false);
        var columns = cols.Select(c =>
        {
            var (type, nullable) = ChDdlScripter.DecomposeType(c.Type);
            return new TableColumnModel
            {
                Id = c.Name,
                Name = c.Name,
                Type = type,
                Nullable = nullable,
                Default = c.DefaultKind is "DEFAULT" or "EPHEMERAL" ? c.DefaultExpr : null,
                Computed = c.DefaultKind is "MATERIALIZED" or "ALIAS" && c.DefaultExpr is not null ? new ComputedModel(c.DefaultExpr, c.DefaultKind == "MATERIALIZED") : null,
                Comment = c.Comment,
            };
        }).ToList();
        var key = ChCatalogReader.KeyColumns(info.SortingKey is { Length: > 0 } ? info.SortingKey : info.PrimaryKey, cols.Select(c => c.Name).ToList());

        var indexes = new List<IndexModel>();
        try
        {
            indexes = await ChDb.QueryAsync(conn, ChCatalogQueries.SkippingIndices, r =>
            {
                var type = ChDb.S(r, 1);
                var granularity = ChDb.Long(r, 3) ?? 1;
                var clause = $"{type} GRANULARITY {granularity}";
                var expr = ChDb.S(r, 2).Trim();
                var parts = expr.StartsWith('(') && expr.EndsWith(')') ? ChTypes.SplitArgs(expr[1..^1]) : [expr];
                return new IndexModel
                {
                    Name = ChDb.S(r, 0),
                    Columns = parts.Select(p => new IndexColumnModel(p.Trim().Trim('`'))).ToList(),
                    Filter = string.Equals(clause, ChDdlScripter.DefaultIndexType, StringComparison.OrdinalIgnoreCase) ? null : "TYPE " + clause,
                };
            }, ct, ("db", db), ("t", name)).ConfigureAwait(false);
        }
        catch (ClickHouseServerException)
        {
            // system.data_skipping_indices missing (old server).
        }

        return new TableModel
        {
            Schema = db,
            Name = name,
            Comment = string.IsNullOrWhiteSpace(info.Comment) ? null : info.Comment,
            Columns = columns,
            PrimaryKey = key.Count > 0 ? new PrimaryKeyModel { Columns = key, Clustered = true } : null,
            Indexes = indexes,
            Checks = ParseChecks(info.Create),
        };
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var reader = await provider.OpenReaderAsync(profile, password, ct).ConfigureAwait(false);
        var db = schema ?? reader.DefaultDatabase;
        var info = (await ChDb.QueryAsync(reader.Channel.Connection, ChCatalogQueries.TableInfo, r => (Engine: ChDb.S(r, 0), Create: ChDb.S(r, 10), AsSelect: ChDb.S(r, 11)),
            ct, ("db", db), ("t", name)).ConfigureAwait(false)).FirstOrDefault();
        if (info == default || ChCatalogReader.ObjectType(info.Engine) is not (ObjectTypes.View or ObjectTypes.MView)) throw EngineException.NotFound($"View {db}.{name}");
        var ddl = await reader.GetDdlAsync(new ObjectRef(null, db, name, ObjectTypes.View), ct).ConfigureAwait(false);
        return new ViewModel(db, name, info.AsSelect, new ViewOptions(), ddl.Ddl);
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var sw = Stopwatch.StartNew();
        await using var ch = await ChConnections.OpenAsync(profile, password, request.Schema, null, ct, provider.Handler).ConfigureAwait(false);
        var executed = 0;
        for (var i = 0; i < request.Statements.Count; i++)
        {
            var sql = request.Statements[i];
            if (string.IsNullOrWhiteSpace(sql) || DdlText.IsTransactionControl(sql)) { executed++; continue; }
            try
            {
                await using var cmd = ch.Connection.CreateCommand();
                cmd.CommandText = WithDefaultEngine(sql.Trim().TrimEnd(';'));
                await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
                executed++;
            }
            catch (Exception ex) when (ex is ClickHouseServerException or HttpRequestException)
            {
                var error = ChErrors.Map(ex, new SqlBatch(sql, 1, 1), new ChStatement(sql, 0, "", false));
                throw new DdlFailedException($"Statement {i + 1} failed: {error.Message}", i, executed, false, error);
            }
        }
        return new DdlApplyResult(true, executed, sw.ElapsedMilliseconds);
    }

    /// <summary>
    /// A bare <c>CREATE TABLE t (…)</c> without ENGINE gets <c>ENGINE = MergeTree ORDER BY tuple()</c> (what servers with
    /// <c>create_table_empty_primary_key_by_default</c> do; older ones reject it).
    /// </summary>
    public static string WithDefaultEngine(string sql)
    {
        var tokens = Core.Sql.SqlTokenizer.Tokenize(sql, Dialect.ClickHouse);
        if (tokens.Count < 3 || !tokens[0].IsWord("CREATE")) return sql;
        var k = 1;
        while (k < tokens.Count && tokens[k].Kind == Core.Sql.SqlTokenKind.Word && tokens[k].Upper is "OR" or "REPLACE" or "TEMPORARY") k++;
        if (k >= tokens.Count || !tokens[k].IsWord("TABLE")) return sql;
        var depth = 0;
        foreach (var t in tokens)
        {
            if (t.IsPunct('(')) depth++;
            else if (t.IsPunct(')')) depth--;
            else if (depth == 0 && (t.IsWord("ENGINE") || t.IsWord("AS") || t.IsWord("CLONE") || t.IsWord("EMPTY"))) return sql;
        }
        return sql + " ENGINE = MergeTree ORDER BY tuple()";
    }
}
