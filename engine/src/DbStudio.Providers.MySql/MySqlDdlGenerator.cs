using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.MySql;

/// <summary>Generic CREATE TABLE from catalog details (the catalog reader serves the server's own SHOW CREATE TABLE).</summary>
public sealed class MySqlDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
    {
        ArgumentNullException.ThrowIfNull(table);
        ArgumentNullException.ThrowIfNull(details);
        var parts = details.Columns.OrderBy(c => c.Ordinal).Select(c =>
        {
            var sb = new StringBuilder(MySqlSqlText.Quote(c.Name)).Append(' ').Append(c.Type);
            if (c.IsComputed && c.Default is not null) sb.Append(" GENERATED ALWAYS AS (").Append(c.Default).Append(')');
            if (!c.Nullable) sb.Append(" NOT NULL");
            if (!c.IsComputed && c.Default is not null) sb.Append(" DEFAULT ").Append(c.Default);
            if (c.IsIdentity) sb.Append(" AUTO_INCREMENT");
            if (!string.IsNullOrWhiteSpace(c.Comment)) sb.Append(" COMMENT ").Append(MySqlSqlText.Literal(c.Comment));
            return sb.ToString();
        }).ToList();
        var pk = details.Columns.Where(c => c.IsPk).OrderBy(c => c.Ordinal).Select(c => MySqlSqlText.Quote(c.Name)).ToList();
        if (pk.Count > 0) parts.Add($"PRIMARY KEY ({string.Join(", ", pk)})");
        foreach (var ix in details.Indexes.Where(i => !i.IsPrimaryKey))
        {
            var kind = ix.Type is "FULLTEXT" ? "FULLTEXT KEY" : ix.Type is "SPATIAL" ? "SPATIAL KEY" : ix.Unique ? "UNIQUE KEY" : "KEY";
            parts.Add($"{kind} {MySqlSqlText.Quote(ix.Name)} ({string.Join(", ", ix.Columns.Select(QuoteIndexColumn))})");
        }
        foreach (var fk in details.ForeignKeys)
            parts.Add($"CONSTRAINT {MySqlSqlText.Quote(fk.Name)} FOREIGN KEY ({string.Join(", ", fk.Columns.Select(MySqlSqlText.Quote))}) " +
                      $"REFERENCES {MySqlSqlText.Qualify(fk.RefSchema, fk.RefTable)} ({string.Join(", ", fk.RefColumns.Select(MySqlSqlText.Quote))})");
        return $"CREATE TABLE {MySqlSqlText.Qualify(table.Schema, table.Name)} (\n{string.Join(",\n", parts.Select(p => "  " + p))}\n);\n";
    }

    /// <summary>"name(10)" (prefix length) → `name`(10).</summary>
    internal static string QuoteIndexColumn(string column)
    {
        var open = column.LastIndexOf('(');
        if (open > 0 && column.EndsWith(')') && int.TryParse(column[(open + 1)..^1], out _))
            return MySqlSqlText.Quote(column[..open]) + column[open..];
        return MySqlSqlText.Quote(column);
    }
}
