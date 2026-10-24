using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Fallback CREATE TABLE from catalog metadata (the catalog reader prefers <c>SHOW CREATE TABLE</c>): columns with their
/// DEFAULT/MATERIALIZED/ALIAS expressions and comments, skipping indices, and a MergeTree engine ordered by the primary key.
/// </summary>
public sealed class ChDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
    {
        ArgumentNullException.ThrowIfNull(table);
        ArgumentNullException.ThrowIfNull(details);
        var sb = new StringBuilder();
        sb.Append("CREATE TABLE ").Append(ChSqlText.Qualified(table.Schema, table.Name)).Append("\n(\n");
        var lines = new List<string>();
        foreach (var c in details.Columns.OrderBy(c => c.Ordinal))
        {
            var line = new StringBuilder("    ").Append(ChSqlText.Quote(c.Name)).Append(' ').Append(c.Type);
            if (!string.IsNullOrEmpty(c.Default)) line.Append(c.IsComputed ? " MATERIALIZED " : " DEFAULT ").Append(c.Default);
            if (!string.IsNullOrEmpty(c.Comment)) line.Append(" COMMENT ").Append(ChSqlText.Literal(c.Comment));
            lines.Add(line.ToString());
        }
        foreach (var i in details.Indexes.Where(i => !i.IsPrimaryKey))
            lines.Add($"    INDEX {ChSqlText.Quote(i.Name)} {string.Join(", ", i.Columns)} TYPE {i.Type ?? "minmax GRANULARITY 1"}");
        sb.Append(string.Join(",\n", lines)).Append("\n)\n");
        var pk = details.Indexes.FirstOrDefault(i => i.IsPrimaryKey)?.Columns ?? details.Columns.Where(c => c.IsPk).Select(c => c.Name).ToList();
        sb.Append("ENGINE = MergeTree\n");
        sb.Append("ORDER BY ").Append(pk.Count switch
        {
            0 => "tuple()",
            1 => ChSqlText.Quote(pk[0]),
            _ => "(" + string.Join(", ", pk.Select(ChSqlText.Quote)) + ")",
        }).Append(';');
        return sb.ToString();
    }
}
