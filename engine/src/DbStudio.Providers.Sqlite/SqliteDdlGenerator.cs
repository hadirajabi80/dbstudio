using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// Builds CREATE TABLE (+ CREATE INDEX) from catalog metadata. SQLite normally serves the stored
/// <c>sqlite_master.sql</c>; this generator is the fallback for objects without stored SQL.
/// </summary>
public sealed class SqliteDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
    {
        var sb = new StringBuilder();
        var qualified = (table.Schema is null or "main" ? "" : SqliteNames.Quote(table.Schema) + ".") + SqliteNames.Quote(table.Name);
        sb.Append("CREATE TABLE ").Append(qualified).Append(" (");

        var pkColumns = details.Columns.Where(c => c.IsPk).ToList();
        var inlinePk = pkColumns.Count == 1 && pkColumns[0].IsIdentity;
        var lines = new List<string>();
        foreach (var c in details.Columns.OrderBy(c => c.Ordinal))
        {
            var line = new StringBuilder("  ").Append(SqliteNames.Quote(c.Name));
            if (!string.IsNullOrWhiteSpace(c.Type)) line.Append(' ').Append(c.Type);
            if (inlinePk && c.IsPk) line.Append(" PRIMARY KEY");
            else if (!c.Nullable) line.Append(" NOT NULL");
            if (c.Default is not null && !c.IsComputed) line.Append(" DEFAULT ").Append(c.Default);
            lines.Add(line.ToString());
        }
        if (!inlinePk && pkColumns.Count > 0)
            lines.Add($"  PRIMARY KEY ({string.Join(", ", pkColumns.Select(c => SqliteNames.Quote(c.Name)))})");
        foreach (var fk in details.ForeignKeys)
        {
            lines.Add($"  CONSTRAINT {SqliteNames.Quote(fk.Name)} FOREIGN KEY ({string.Join(", ", fk.Columns.Select(SqliteNames.Quote))}) " +
                      $"REFERENCES {SqliteNames.Quote(fk.RefTable)}" +
                      (fk.RefColumns.Count > 0 ? $" ({string.Join(", ", fk.RefColumns.Select(SqliteNames.Quote))})" : ""));
        }
        sb.AppendLine().AppendJoin("," + Environment.NewLine, lines).AppendLine().Append(");");

        foreach (var ix in details.Indexes.Where(i => !i.IsPrimaryKey && i.Type == "index"))
        {
            sb.AppendLine().AppendLine()
              .Append(ix.Unique ? "CREATE UNIQUE INDEX " : "CREATE INDEX ")
              .Append(SqliteNames.Quote(ix.Name)).Append(" ON ").Append(qualified)
              .Append(" (").AppendJoin(", ", ix.Columns.Select(SqliteNames.Quote)).Append(");");
        }
        return sb.AppendLine().ToString();
    }
}
