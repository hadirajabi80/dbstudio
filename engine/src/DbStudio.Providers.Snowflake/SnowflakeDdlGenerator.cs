using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// CREATE TABLE from catalog details, the fallback when <c>GET_DDL</c> is not allowed: columns with type, identity,
/// default and NOT NULL, the (informational) primary/unique/foreign keys, CLUSTER BY and comments.
/// </summary>
public sealed class SnowflakeDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
    {
        ArgumentNullException.ThrowIfNull(details);
        var parts = new List<string>();
        foreach (var c in details.Columns.OrderBy(c => c.Ordinal))
        {
            var sb = new StringBuilder(SnowflakeSql.Quote(c.Name)).Append(' ').Append(c.Type);
            if (c.IsIdentity) sb.Append(" IDENTITY");
            else if (!string.IsNullOrEmpty(c.Default)) sb.Append(" DEFAULT ").Append(c.Default);
            if (!c.Nullable) sb.Append(" NOT NULL");
            if (!string.IsNullOrEmpty(c.Comment)) sb.Append(" COMMENT ").Append(SnowflakeSql.Literal(c.Comment));
            parts.Add(sb.ToString());
        }
        foreach (var ix in details.Indexes.Where(i => i.IsPrimaryKey))
            parts.Add($"{Named(ix.Name)}PRIMARY KEY ({string.Join(", ", ix.Columns.Select(SnowflakeSql.Quote))})");
        foreach (var ix in details.Indexes.Where(i => i.Unique && !i.IsPrimaryKey))
            parts.Add($"{Named(ix.Name)}UNIQUE ({string.Join(", ", ix.Columns.Select(SnowflakeSql.Quote))})");
        foreach (var fk in details.ForeignKeys)
            parts.Add($"{Named(fk.Name)}FOREIGN KEY ({string.Join(", ", fk.Columns.Select(SnowflakeSql.Quote))}) REFERENCES " +
                      $"{SnowflakeSql.Qualify(null, fk.RefSchema, fk.RefTable)} ({string.Join(", ", fk.RefColumns.Select(SnowflakeSql.Quote))})");
        var sql = new StringBuilder("CREATE TABLE ").Append(SnowflakeSql.Qualify(table.Database, table.Schema, table.Name))
            .Append(" (\n").Append(string.Join(",\n", parts.Select(p => "    " + p))).Append("\n)");
        var cluster = details.Indexes.FirstOrDefault(i => i.Type == "clustering key");
        if (cluster is not null) sql.Append("\nCLUSTER BY (").Append(string.Join(", ", cluster.Columns)).Append(')');
        return sql.Append(";\n").ToString();
    }

    private static string Named(string? name) =>
        string.IsNullOrWhiteSpace(name) || name.StartsWith("SYS_CONSTRAINT_", StringComparison.OrdinalIgnoreCase) || name == "PRIMARY KEY"
            ? "" : $"CONSTRAINT {SnowflakeSql.Quote(name)} ";
}
