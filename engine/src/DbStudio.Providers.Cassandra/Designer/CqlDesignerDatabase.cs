using System.Diagnostics;
using Cassandra;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Cassandra.Designer;

/// <summary>
/// Database side of the CQL designer: table models from system_schema (mapping in <see cref="CqlDdlScripter"/>), materialized
/// views as their SELECT … PRIMARY KEY body, and apply statement by statement (CQL DDL is not transactional: the first
/// failure stops, earlier statements stay applied, the driver waits for schema agreement after each).
/// </summary>
public sealed class CqlDesignerDatabase(CassandraProvider provider) : IDesignerDatabase
{
    public string ProviderId => CassandraProvider.ProviderId;

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var catalog = await provider.OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false);
        var rows = (await catalog.Session.ExecuteAsync(new SimpleStatement("SELECT release_version FROM system.local")).WaitAsync(ct).ConfigureAwait(false)).ToList();
        var version = rows.Count > 0 ? CqlSchemaReader.Str(rows[0], "release_version") : null;
        var ks = schema ?? await catalog.GetDefaultSchemaAsync(null, ct).ConfigureAwait(false);
        return new DdlScriptContext(version, ks);
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var catalog = await provider.OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false);
        var ks = await catalog.RequireKeyspaceAsync(schema, ct).ConfigureAwait(false);
        var t = ks.Tables.FirstOrDefault(x => x.Name == name) ?? ks.Tables.FirstOrDefault(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                ?? throw EngineException.NotFound($"Table '{ks.Name}.{name}'");
        return ToModel(ks, t);
    }

    /// <summary>The designer model of a table (see <see cref="CqlDdlScripter"/> for the mapping).</summary>
    public static TableModel ToModel(CqlKeyspaceMeta ks, CqlTableMeta t)
    {
        var pk = t.PartitionKey;
        var ck = t.Clustering;
        var options = t.Options.Where(o => o.Key != "comment" && (!CqlDdlScripter.DefaultOptions.TryGetValue(o.Key, out var def) || !SameOption(def, o.Value)))
            .Select(o => new CheckModel { Name = o.Key, Expression = o.Value }).ToList();
        var indexes = new List<IndexModel>();
        if (ck.Any(c => c.Desc))
            indexes.Add(new IndexModel { Name = CqlDdlScripter.ClusteringOrderIndex, Columns = ck.Select(c => new IndexColumnModel(c.Name, c.Desc)).ToList() });
        foreach (var i in ks.Indexes.Where(i => i.Table == t.Name))
        {
            var (fn, column) = SplitTarget(i.Target);
            if (column is null) continue;
            indexes.Add(new IndexModel
            {
                Name = i.Name,
                Columns = [new IndexColumnModel(column)],
                Filter = fn,

            });
        }
        return new TableModel
        {
            Schema = ks.Name,
            Name = t.Name,
            Comment = string.IsNullOrEmpty(t.Comment) ? null : t.Comment,
            Columns = t.OrderedColumns.Select(c => new TableColumnModel
            {
                Id = c.Name,
                Name = c.Name,
                Type = c.Type,
                Nullable = !c.IsKey,
                Comment = c.IsStatic ? "static" : null,
            }).ToList(),
            PrimaryKey = new PrimaryKeyModel { Columns = t.PrimaryKey.Select(c => c.Name).ToList(), Clustered = false },
            Uniques = pk.Count > 1 ? [new UniqueModel { Name = CqlDdlScripter.PartitionKeyConstraint, Columns = pk.Select(c => c.Name).ToList() }] : [],
            Indexes = indexes,
            Checks = options,
        };
    }

    private static bool SameOption(string a, string b) =>
        string.Equals(a.Replace(" ", "", StringComparison.Ordinal), b.Replace(" ", "", StringComparison.Ordinal), StringComparison.Ordinal)
        || (double.TryParse(a, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var x)
            && double.TryParse(b, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var y) && x == y);

    /// <summary>"keys(tags)" → ("keys", "tags"); "email" → (null, "email"); quoted names unquoted.</summary>
    public static (string? Function, string? Column) SplitTarget(string? target)
    {
        if (string.IsNullOrWhiteSpace(target)) return (null, null);
        var t = target.Trim();
        var open = t.IndexOf('(');
        if (open > 0 && t.EndsWith(')')) return (t[..open].Trim().ToLowerInvariant(), Unquote(t[(open + 1)..^1].Trim()));
        return (null, Unquote(t));
    }

    private static string Unquote(string s) => s.Length >= 2 && s[0] == '"' && s[^1] == '"' ? s[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal) : s;

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var catalog = await provider.OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false);
        var ks = await catalog.RequireKeyspaceAsync(schema, ct).ConfigureAwait(false);
        var v = ks.Views.FirstOrDefault(x => x.Name == name) ?? throw EngineException.NotFound($"Materialized view '{ks.Name}.{name}'");
        var ddl = CqlDdl.View(v);
        var asAt = ddl.IndexOf(" AS\n", StringComparison.Ordinal);
        var body = asAt >= 0 ? ddl[(asAt + 4)..].TrimEnd(';') : ddl;
        return new ViewModel(ks.Name, v.Name, string.Join('\n', body.Split('\n').Select(l => l.StartsWith("    ", StringComparison.Ordinal) ? l[4..] : l)), new ViewOptions(), ddl);
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var catalog = await provider.OpenCqlCatalogAsync(profile, password, ct).ConfigureAwait(false);
        // Unqualified names in hand-edited scripts resolve against the request's keyspace: use a session bound to it.
        ISession? scoped = null;
        try
        {
            var session = catalog.Session;
            if (!string.IsNullOrWhiteSpace(request.Schema))
            {
                scoped = await catalog.Cluster.ConnectAsync(request.Schema).WaitAsync(ct).ConfigureAwait(false);
                session = scoped;
            }
            var executed = 0;
            for (var i = 0; i < request.Statements.Count; i++)
            {
                var sql = request.Statements[i].Trim().TrimEnd(';').Trim();
                if (sql.Length == 0 || DdlText.IsTransactionControl(sql)) continue;
                try
                {
                    await session.ExecuteAsync(new SimpleStatement(sql).SetConsistencyLevel(ConsistencyLevel.LocalQuorum)).WaitAsync(ct).ConfigureAwait(false);
                    executed++;
                }
                catch (Exception ex) when (ex is DriverException)
                {
                    var error = CqlErrors.ToError(ex);
                    throw new DdlFailedException(
                        executed > 0
                            ? $"Statement {i + 1} failed: {error.Message} The {executed} statement(s) before it stay applied (CQL DDL is not transactional)."
                            : $"Statement {i + 1} failed: {error.Message}",
                        i, executed, false, error);
                }
            }
            return new DdlApplyResult(true, executed, sw.ElapsedMilliseconds);
        }
        finally
        {
            if (scoped is not null)
            {
                try { await scoped.ShutdownAsync().ConfigureAwait(false); } catch { /* best effort */ }
            }
        }
    }
}
