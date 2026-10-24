using System.Text.RegularExpressions;
using ClickHouse.Driver;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Dependencies and the Objects tab for ClickHouse (plan-batch3 WP-CH). ClickHouse has no foreign keys; the relations are:
/// materialized views reading a table (<c>system.tables.dependencies_*</c> and the MV's SELECT), an MV's target table
/// (<c>TO db.t</c>), views referencing objects in their SELECT, dictionaries and their ClickHouse source table, and
/// <c>dictGet('db.dict', …)</c> calls in view bodies. The object list comes from <c>system.tables</c> totals.
/// </summary>
public sealed partial class ChDependencyReader(ChCatalogReader catalog) : IDependencyReader, IObjectListReader
{
    public ValueTask DisposeAsync() => catalog.DisposeAsync();

    public const string AllTables = """
        SELECT database, name, engine, create_table_query, as_select, dependencies_database, dependencies_table
        FROM system.tables
        WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary
        """;

    public const string ObjectList = """
        SELECT database, name, engine, total_rows, total_bytes, toTimeZone(metadata_modification_time, 'UTC'), comment
        FROM system.tables
        WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary
            AND NOT startsWith(name, '.inner') AND ({db:Nullable(String)} IS NULL OR database = {db:Nullable(String)})
        ORDER BY database, name
        """;

    internal sealed record TableRow(string Database, string Name, string Engine, string Create, string AsSelect, string[] DepDatabases, string[] DepTables)
    {
        public string Type => ChCatalogReader.ObjectType(Engine);
        public ObjectRef Ref => new(null, Database, Name, Type);
    }

    [GeneratedRegex(@"\bTO\s+((?:`(?:[^`\\]|\\.)+`|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:`(?:[^`\\]|\\.)+`|[A-Za-z_][A-Za-z0-9_]*))?)", RegexOptions.CultureInvariant)]
    private static partial Regex MvTarget();

    [GeneratedRegex(@"SOURCE\s*\(\s*CLICKHOUSE\s*\((?<args>[^)]*)\)", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex ClickHouseSource();

    [GeneratedRegex(@"\b(?<key>TABLE|DB)\s+'(?<value>(?:[^'\\]|\\.)*)'", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex SourceArg();

    [GeneratedRegex(@"\bdictGet\w*\s*\(\s*'(?<name>[^']+)'", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex DictGet();

    private async Task<List<TableRow>> LoadAsync(CancellationToken ct) =>
        await ChDb.QueryAsync(catalog.Channel.Connection, AllTables, r => new TableRow(ChDb.S(r, 0), ChDb.S(r, 1), ChDb.S(r, 2), ChDb.S(r, 3), ChDb.S(r, 4),
            r.GetValue(5) as string[] ?? [], r.GetValue(6) as string[] ?? []), ct).ConfigureAwait(false);

    /// <summary>The MV's target ("TO db.t" in its CREATE statement), unquoted.</summary>
    public static (string? Database, string Name)? TargetOf(string createQuery)
    {
        var head = createQuery;
        var asAt = Regex.Match(head, @"\bAS\s+(SELECT|WITH)\b", RegexOptions.IgnoreCase);
        if (asAt.Success) head = head[..asAt.Index];
        var m = MvTarget().Match(head);
        if (!m.Success) return null;
        var parts = m.Groups[1].Value.Split('.', 2).Select(p => Unquote(p.Trim())).ToArray();
        return parts.Length == 2 ? (parts[0], parts[1]) : (null, parts[0]);
    }

    /// <summary>(db, table) of a dictionary's local ClickHouse source.</summary>
    public static (string? Database, string Table)? SourceOf(string createQuery)
    {
        var m = ClickHouseSource().Match(createQuery);
        if (!m.Success) return null;
        string? db = null, table = null;
        foreach (Match a in SourceArg().Matches(m.Groups["args"].Value))
        {
            if (a.Groups["key"].Value.Equals("TABLE", StringComparison.OrdinalIgnoreCase)) table = a.Groups["value"].Value;
            else db = a.Groups["value"].Value;
        }
        return table is null ? null : (db, table);
    }

    private static string Unquote(string s) => s.Length >= 2 && s[0] == '`' && s[^1] == '`' ? s[1..^1].Replace("\\`", "`").Replace("\\\\", "\\") : s;

    /// <summary>What <paramref name="t"/> uses: (object, kind, detail).</summary>
    internal static IEnumerable<(TableRow Target, string Kind, string Detail)> UsesOf(TableRow t, IReadOnlyList<TableRow> all)
    {
        TableRow? Find(string? db, string name) =>
            all.FirstOrDefault(x => x.Name == name && x.Database == (db ?? t.Database));

        if (t.Type is ObjectTypes.View or ObjectTypes.MView && t.AsSelect.Length > 0)
        {
            foreach (var (q, n) in DependencyGraphs.ReferencedNames(t.AsSelect, Dialect.ClickHouse))
                if (Find(q, n) is { } hit && !ReferenceEquals(hit, t)) yield return (hit, DependencyKinds.Uses, "SELECT");
            foreach (Match m in DictGet().Matches(t.AsSelect))
            {
                var parts = m.Groups["name"].Value.Split('.', 2);
                if ((parts.Length == 2 ? Find(parts[0], parts[1]) : Find(null, parts[0])) is { } d) yield return (d, DependencyKinds.Uses, "dictGet");
            }
        }
        if (t.Type == ObjectTypes.MView)
        {
            if (TargetOf(t.Create) is { } target && Find(target.Database, target.Name) is { } to) yield return (to, DependencyKinds.Uses, "target (TO)");
            else if (all.FirstOrDefault(x => x.Database == t.Database && x.Name.StartsWith(".inner", StringComparison.Ordinal) && x.Name.EndsWith(t.Name, StringComparison.Ordinal)) is { } inner)
                yield return (inner, DependencyKinds.Uses, "target (inner table)");
        }
        if (t.Type == ObjectTypes.Type && SourceOf(t.Create) is { } src && Find(src.Database, src.Table) is { } source)
            yield return (source, DependencyKinds.Uses, "dictionary source");
        for (var i = 0; i < Math.Min(t.DepDatabases.Length, t.DepTables.Length); i++)
            if (Find(t.DepDatabases[i], t.DepTables[i]) is { } mv) yield return (mv, DependencyKinds.UsedBy, "materialized view reads it");
    }

    public async Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(obj);
        var db = obj.Schema ?? catalog.DefaultDatabase;
        var root = obj with { Schema = db, Database = null };
        var all = await LoadAsync(ct).ConfigureAwait(false);
        var self = all.FirstOrDefault(x => x.Database == db && x.Name == obj.Name);
        var uses = new List<ObjectDependency>();
        var usedBy = new List<ObjectDependency>();
        if (self is not null)
        {
            foreach (var (target, kind, detail) in UsesOf(self, all))
            {
                if (kind == DependencyKinds.UsedBy) usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, target.Ref, detail, null));
                else uses.Add(new ObjectDependency(DependencyKinds.Uses, target.Ref, detail, null));
            }
            foreach (var other in all)
            {
                if (ReferenceEquals(other, self)) continue;
                foreach (var (target, kind, detail) in UsesOf(other, all))
                    if (kind == DependencyKinds.Uses && ReferenceEquals(target, self))
                        usedBy.Add(new ObjectDependency(DependencyKinds.UsedBy, other.Ref, detail, null));
            }
        }
        return DependencyGraphs.Build(root, uses, usedBy);
    }

    public async Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct)
    {
        var conn = catalog.Channel.Connection;
        var items = await ChDb.QueryAsync(conn, ObjectList, r =>
        {
            var engine = ChDb.S(r, 2);
            var comment = ChDb.Str(r, 6);
            return new ObjectListItem(ChCatalogReader.ObjectType(engine), ChDb.S(r, 0), ChDb.S(r, 1), ChDb.Long(r, 3), ChDb.Long(r, 4), ChDb.Time(r, 5), null,
                string.IsNullOrWhiteSpace(comment) ? engine : $"{engine} · {comment}");
        }, ct, ("db", schema)).ConfigureAwait(false);
        if (schema is null || string.Equals(schema, catalog.DefaultDatabase, StringComparison.Ordinal))
        {
            try
            {
                foreach (var name in await ChDb.QueryAsync(conn, ChCatalogQueries.Functions, r => ChDb.S(r, 0), ct).ConfigureAwait(false))
                    items.Add(new ObjectListItem(ObjectTypes.Func, catalog.DefaultDatabase, name, null, null, null, null, "SQL user-defined function"));
            }
            catch (ClickHouseServerException) { }
        }
        return type is null ? items : items.Where(i => i.Type == type).ToList();
    }
}
