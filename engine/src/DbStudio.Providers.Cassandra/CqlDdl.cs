using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// CQL DDL generated from system_schema metadata (the DESCRIBE output of Cassandra 4.0+ when the server cannot DESCRIBE):
/// keyspaces, tables with <c>PRIMARY KEY ((pk…), ck…)</c>, clustering order and options, materialized views, UDTs, functions,
/// aggregates and indexes.
/// </summary>
public static class CqlDdl
{
    /// <summary><c>PRIMARY KEY ((a, b), c)</c> / <c>PRIMARY KEY (a, c)</c> / <c>PRIMARY KEY (a)</c> text.</summary>
    public static string PrimaryKeyText(IReadOnlyList<string> partition, IReadOnlyList<string> clustering)
    {
        var pk = partition.Count == 1 ? CqlText.Quote(partition[0]) : "(" + string.Join(", ", partition.Select(CqlText.Quote)) + ")";
        return "PRIMARY KEY (" + string.Join(", ", new[] { pk }.Concat(clustering.Select(CqlText.Quote))) + ")";
    }

    public static string PrimaryKeyText(CqlTableMeta t) => PrimaryKeyText(t.PartitionKey.Select(c => c.Name).ToList(), t.Clustering.Select(c => c.Name).ToList());

    public static string Keyspace(CqlKeyspaceMeta ks)
    {
        var replication = "{" + string.Join(", ", ks.Replication.OrderBy(kv => kv.Key == "class" ? "" : kv.Key, StringComparer.Ordinal)
            .Select(kv => CqlText.Literal(kv.Key) + ": " + CqlText.Literal(kv.Value))) + "}";
        return $"CREATE KEYSPACE {CqlText.Quote(ks.Name)} WITH replication = {replication} AND durable_writes = {(ks.DurableWrites ? "true" : "false")};";
    }

    public static string Table(CqlTableMeta t, bool ifNotExists = false)
    {
        if (t.IsView) return View(t);
        var sb = new StringBuilder();
        sb.Append("CREATE TABLE ").Append(ifNotExists ? "IF NOT EXISTS " : "").Append(CqlText.Qualify(t.Keyspace, t.Name)).Append(" (\n");
        var pk = t.PartitionKey;
        var ck = t.Clustering;
        var single = pk.Count == 1 && ck.Count == 0;
        var lines = new List<string>();
        foreach (var c in t.OrderedColumns)
        {
            var line = $"    {CqlText.Quote(c.Name)} {c.Type}";
            if (c.IsStatic) line += " STATIC";
            if (single && c.IsPartitionKey) line += " PRIMARY KEY";
            lines.Add(line);
        }
        if (!single) lines.Add("    " + PrimaryKeyText(t));
        sb.Append(string.Join(",\n", lines)).Append("\n)");
        AppendWith(sb, t, ck);
        sb.Append(';');
        return sb.ToString();
    }

    private static void AppendWith(StringBuilder sb, CqlTableMeta t, IReadOnlyList<CqlColumnMeta> ck)
    {
        var parts = new List<string>();
        if (t.IsCompactStorage && !t.IsView) parts.Add("COMPACT STORAGE");
        if (ck.Count > 0 && (t.IsView || ck.Any(c => c.Desc)))
            parts.Add("CLUSTERING ORDER BY (" + string.Join(", ", ck.Select(c => $"{CqlText.Quote(c.Name)} {(c.Desc ? "DESC" : "ASC")}")) + ")");
        parts.AddRange(t.Options.Select(o => $"{o.Key} = {o.Value}"));
        if (parts.Count == 0) return;
        sb.Append(" WITH ").Append(string.Join("\n    AND ", parts));
    }

    public static string View(CqlTableMeta v)
    {
        var sb = new StringBuilder();
        sb.Append("CREATE MATERIALIZED VIEW ").Append(CqlText.Qualify(v.Keyspace, v.Name)).Append(" AS\n    SELECT ");
        sb.Append(v.IncludeAllColumns ? "*" : string.Join(", ", v.OrderedColumns.Select(c => CqlText.Quote(c.Name))));
        sb.Append("\n    FROM ").Append(CqlText.Qualify(v.Keyspace, v.BaseTable ?? "")).Append("\n    WHERE ").Append(v.WhereClause ?? "");
        sb.Append("\n    ").Append(PrimaryKeyText(v));
        AppendWith(sb, v, v.Clustering);
        sb.Append(';');
        return sb.ToString();
    }

    public static string Type(CqlTypeMeta t) =>
        $"CREATE TYPE {CqlText.Qualify(t.Keyspace, t.Name)} (\n" + string.Join(",\n", t.Fields.Select(f => $"    {CqlText.Quote(f.Name)} {f.Type}")) + "\n);";

    public static string Function(CqlFunctionMeta f)
    {
        var args = string.Join(", ", f.ArgumentNames.Select((n, i) => $"{CqlText.Quote(n)} {(i < f.ArgumentTypes.Count ? f.ArgumentTypes[i] : "")}"));
        var sb = new StringBuilder();
        sb.Append("CREATE FUNCTION ").Append(CqlText.Qualify(f.Keyspace, f.Name)).Append('(').Append(args).Append(")\n");
        sb.Append(f.CalledOnNullInput ? "    CALLED ON NULL INPUT\n" : "    RETURNS NULL ON NULL INPUT\n");
        sb.Append("    RETURNS ").Append(f.ReturnType).Append('\n');
        if (f.Deterministic) sb.Append("    DETERMINISTIC\n");
        if (f.Monotonic) sb.Append("    MONOTONIC\n");
        sb.Append("    LANGUAGE ").Append(f.Language).Append('\n');
        sb.Append("    AS $$").Append(f.Body).Append("$$;");
        return sb.ToString();
    }

    public static string Aggregate(CqlAggregateMeta a)
    {
        var sb = new StringBuilder();
        sb.Append("CREATE AGGREGATE ").Append(CqlText.Qualify(a.Keyspace, a.Name)).Append('(').Append(string.Join(", ", a.ArgumentTypes)).Append(")\n");
        sb.Append("    SFUNC ").Append(CqlText.Quote(a.StateFunction)).Append('\n');
        sb.Append("    STYPE ").Append(a.StateType);
        if (!string.IsNullOrEmpty(a.FinalFunction)) sb.Append("\n    FINALFUNC ").Append(CqlText.Quote(a.FinalFunction));
        if (!string.IsNullOrEmpty(a.InitCond)) sb.Append("\n    INITCOND ").Append(a.InitCond);
        if (a.Deterministic) sb.Append("\n    DETERMINISTIC");
        sb.Append(';');
        return sb.ToString();
    }

    public static string Index(CqlIndexMeta i)
    {
        var target = i.Target ?? "";
        // Targets are stored as written ("email", "keys(tags)", "values(m)", "entries(m)", "full(f)"); quote plain names.
        var targetText = target.Contains('(', StringComparison.Ordinal) ? target : CqlText.Quote(target.Trim('"'));
        var head = i.Kind == "CUSTOM" && !i.IsSai ? "CREATE CUSTOM INDEX" : "CREATE INDEX";
        var sb = new StringBuilder($"{head} {CqlText.Quote(i.Name)} ON {CqlText.Qualify(i.Keyspace, i.Table)} ({targetText})");
        if (i.IsSai) sb.Append(" USING 'sai'");
        else if (i.ClassName is { } cls) sb.Append(" USING ").Append(CqlText.Literal(cls));
        var extra = i.Options.Where(kv => kv.Key is not ("target" or "class_name")).ToList();
        if (extra.Count > 0)
            sb.Append(" WITH OPTIONS = {").Append(string.Join(", ", extra.Select(kv => CqlText.Literal(kv.Key) + ": " + CqlText.Literal(kv.Value)))).Append('}');
        sb.Append(';');
        return sb.ToString();
    }

    public static string Trigger(CqlTriggerMeta t) =>
        $"CREATE TRIGGER {CqlText.Quote(t.Name)} ON {CqlText.Qualify(t.Keyspace, t.Table)} USING {CqlText.Literal(t.Options.GetValueOrDefault("class") ?? "")};";

    /// <summary>A table with its indexes, triggers and views (what DESCRIBE TABLE prints).</summary>
    public static string TableWithDependents(CqlKeyspaceMeta ks, CqlTableMeta t)
    {
        var parts = new List<string> { Table(t) };
        if (!t.IsView)
        {
            parts.AddRange(ks.Indexes.Where(i => i.Table == t.Name).OrderBy(i => i.Name, StringComparer.Ordinal).Select(Index));
            parts.AddRange(ks.Triggers.Where(x => x.Table == t.Name).Select(Trigger));
            parts.AddRange(ks.Views.Where(v => v.BaseTable == t.Name).Select(View));
        }
        return string.Join("\n\n", parts);
    }

    /// <summary>The whole keyspace (DESCRIBE KEYSPACE): keyspace, types, functions, aggregates, tables (+ indexes), views.</summary>
    public static string WholeKeyspace(CqlKeyspaceMeta ks)
    {
        var parts = new List<string> { Keyspace(ks) };
        parts.AddRange(ks.Types.Select(Type));
        parts.AddRange(ks.Functions.Select(Function));
        parts.AddRange(ks.Aggregates.Select(Aggregate));
        foreach (var t in ks.Tables)
        {
            parts.Add(Table(t));
            parts.AddRange(ks.Indexes.Where(i => i.Table == t.Name).Select(Index));
        }
        parts.AddRange(ks.Views.Select(View));
        return string.Join("\n\n", parts);
    }

    /// <summary>
    /// Best-effort CREATE TABLE from generic <see cref="ObjectDetails"/> (the IDdlGenerator contract): key roles are read from
    /// the column comments the catalog reader writes ("partition key", "clustering key DESC", "static").
    /// </summary>
    public sealed class Generator : IDdlGenerator
    {
        public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
        {
            var cols = details.Columns.OrderBy(c => c.Ordinal).ToList();
            var meta = new CqlTableMeta
            {
                Keyspace = table.Schema ?? "",
                Name = table.Name,
                Columns = cols.Select(c =>
                {
                    var comment = c.Comment ?? "";
                    if (comment.StartsWith("partition key", StringComparison.Ordinal))
                        return new CqlColumnMeta(c.Name, c.Type, "partition_key", cols.Where(x => (x.Comment ?? "").StartsWith("partition key", StringComparison.Ordinal)).ToList().IndexOf(c), "none");
                    if (comment.StartsWith("clustering key", StringComparison.Ordinal))
                        return new CqlColumnMeta(c.Name, c.Type, "clustering", cols.Where(x => (x.Comment ?? "").StartsWith("clustering key", StringComparison.Ordinal)).ToList().IndexOf(c),
                            comment.EndsWith("DESC", StringComparison.Ordinal) ? "desc" : "asc");
                    return new CqlColumnMeta(c.Name, c.Type, comment == "static" ? "static" : c.IsPk ? "partition_key" : "regular", c.IsPk ? 0 : -1, "none");
                }).ToList(),
            };
            return Table(meta);
        }
    }
}
