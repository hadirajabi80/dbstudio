using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.SqlServer.TSql;

/// <summary>Full table definition used for CREATE TABLE generation (richer than <see cref="ObjectDetails"/>).</summary>
public sealed record SqlServerTableDefinition(
    string Schema,
    string Name,
    IReadOnlyList<SqlServerColumnDefinition> Columns,
    IReadOnlyList<SqlServerIndexDefinition> Indexes,
    IReadOnlyList<SqlServerForeignKeyDefinition> ForeignKeys,
    IReadOnlyList<SqlServerCheckDefinition> Checks);

public sealed record SqlServerColumnDefinition(
    string Name,
    string TypeText,
    bool Nullable,
    string? DefaultDefinition = null,
    string? DefaultName = null,
    bool IsIdentity = false,
    long IdentitySeed = 1,
    long IdentityIncrement = 1,
    string? ComputedDefinition = null,
    bool IsPersisted = false,
    string? Collation = null);

public sealed record SqlServerIndexColumn(string Name, bool Descending = false);

/// <param name="TypeDesc">sys.indexes.type_desc: CLUSTERED, NONCLUSTERED, CLUSTERED COLUMNSTORE, ...</param>
public sealed record SqlServerIndexDefinition(
    string Name,
    bool IsUnique,
    bool IsPrimaryKey,
    bool IsUniqueConstraint,
    string TypeDesc,
    IReadOnlyList<SqlServerIndexColumn> KeyColumns,
    IReadOnlyList<string> IncludedColumns,
    string? Filter = null);

/// <param name="OnDelete">sys.foreign_keys.delete_referential_action_desc (NO_ACTION, CASCADE, SET_NULL, SET_DEFAULT).</param>
public sealed record SqlServerForeignKeyDefinition(
    string Name,
    IReadOnlyList<string> Columns,
    string RefSchema,
    string RefTable,
    IReadOnlyList<string> RefColumns,
    string OnDelete = "NO_ACTION",
    string OnUpdate = "NO_ACTION");

public sealed record SqlServerCheckDefinition(string Name, string Definition);

/// <summary>Generates SQL Server CREATE TABLE scripts (SQL Server tables have no stored definition).</summary>
public sealed class TSqlDdlGenerator : IDdlGenerator
{
    public string GenerateTableDdl(ObjectRef table, ObjectDetails details)
    {
        ArgumentNullException.ThrowIfNull(table);
        ArgumentNullException.ThrowIfNull(details);
        return Generate(FromDetails(table, details));
    }

    /// <summary>Maps the generic details model (identity seeds unknown → 1,1; unique keys rendered as indexes).</summary>
    public static SqlServerTableDefinition FromDetails(ObjectRef table, ObjectDetails details)
    {
        var cols = details.Columns.OrderBy(c => c.Ordinal).Select(c => new SqlServerColumnDefinition(
            c.Name, c.Type, c.Nullable,
            DefaultDefinition: c.IsComputed ? null : c.Default,
            IsIdentity: c.IsIdentity,
            ComputedDefinition: c.IsComputed ? c.Default : null)).ToList();
        var pkCols = details.Columns.Where(c => c.IsPk).OrderBy(c => c.Ordinal).Select(c => c.Name).ToList();
        var indexes = details.Indexes.Select(i => new SqlServerIndexDefinition(
            i.Name, i.Unique || i.IsPrimaryKey, i.IsPrimaryKey, false, string.IsNullOrEmpty(i.Type) ? "NONCLUSTERED" : i.Type!,
            i.Columns.Select(n => new SqlServerIndexColumn(n)).ToList(), [])).ToList();
        if (pkCols.Count > 0 && !indexes.Any(i => i.IsPrimaryKey))
            indexes.Insert(0, new SqlServerIndexDefinition("PK_" + table.Name, true, true, false, "CLUSTERED",
                pkCols.Select(n => new SqlServerIndexColumn(n)).ToList(), []));
        var fks = details.ForeignKeys.Select(f => new SqlServerForeignKeyDefinition(
            f.Name, f.Columns, f.RefSchema ?? table.Schema ?? "dbo", f.RefTable, f.RefColumns)).ToList();
        return new SqlServerTableDefinition(table.Schema ?? "dbo", table.Name, cols, indexes, fks, []);
    }

    public static string Generate(SqlServerTableDefinition t)
    {
        ArgumentNullException.ThrowIfNull(t);
        var full = SqlServerNames.Qualify(t.Schema, t.Name);
        var lines = new List<string>();
        foreach (var c in t.Columns) lines.Add(ColumnLine(c));

        foreach (var ix in t.Indexes.Where(i => i.IsPrimaryKey || i.IsUniqueConstraint))
        {
            var kind = ix.IsPrimaryKey ? "PRIMARY KEY" : "UNIQUE";
            lines.Add($"CONSTRAINT {SqlServerNames.Quote(ix.Name)} {kind} {Clustering(ix.TypeDesc)}({KeyList(ix.KeyColumns)})");
        }
        foreach (var fk in t.ForeignKeys)
        {
            var sb = new StringBuilder();
            sb.Append($"CONSTRAINT {SqlServerNames.Quote(fk.Name)} FOREIGN KEY ({string.Join(", ", fk.Columns.Select(SqlServerNames.Quote))}) ");
            sb.Append($"REFERENCES {SqlServerNames.Qualify(fk.RefSchema, fk.RefTable)} ({string.Join(", ", fk.RefColumns.Select(SqlServerNames.Quote))})");
            var del = Action(fk.OnDelete);
            var upd = Action(fk.OnUpdate);
            if (del is not null) sb.Append(" ON DELETE ").Append(del);
            if (upd is not null) sb.Append(" ON UPDATE ").Append(upd);
            lines.Add(sb.ToString());
        }
        foreach (var ck in t.Checks)
            lines.Add($"CONSTRAINT {SqlServerNames.Quote(ck.Name)} CHECK {ck.Definition}");

        var outSb = new StringBuilder();
        outSb.Append("CREATE TABLE ").Append(full).Append(" (\n");
        for (int i = 0; i < lines.Count; i++)
        {
            outSb.Append("    ").Append(lines[i]);
            outSb.Append(i < lines.Count - 1 ? ",\n" : "\n");
        }
        outSb.Append(");\n");

        foreach (var ix in t.Indexes.Where(i => !i.IsPrimaryKey && !i.IsUniqueConstraint))
        {
            outSb.Append("GO\n");
            outSb.Append(IndexStatement(full, ix)).Append('\n');
        }
        return outSb.ToString();
    }

    private static string ColumnLine(SqlServerColumnDefinition c)
    {
        var sb = new StringBuilder(SqlServerNames.Quote(c.Name));
        if (c.ComputedDefinition is not null)
        {
            sb.Append(" AS ").Append(c.ComputedDefinition);
            if (c.IsPersisted) sb.Append(" PERSISTED");
            if (c.IsPersisted && !c.Nullable) sb.Append(" NOT NULL");
            return sb.ToString();
        }
        sb.Append(' ').Append(c.TypeText);
        if (!string.IsNullOrEmpty(c.Collation)) sb.Append(" COLLATE ").Append(c.Collation);
        if (c.IsIdentity) sb.Append($" IDENTITY({c.IdentitySeed},{c.IdentityIncrement})");
        sb.Append(c.Nullable ? " NULL" : " NOT NULL");
        if (c.DefaultDefinition is not null)
        {
            if (!string.IsNullOrEmpty(c.DefaultName)) sb.Append(" CONSTRAINT ").Append(SqlServerNames.Quote(c.DefaultName));
            sb.Append(" DEFAULT ").Append(c.DefaultDefinition);
        }
        return sb.ToString();
    }

    private static string IndexStatement(string table, SqlServerIndexDefinition ix)
    {
        var type = ix.TypeDesc.ToUpperInvariant();
        var sb = new StringBuilder("CREATE ");
        if (ix.IsUnique) sb.Append("UNIQUE ");
        if (type.Contains("COLUMNSTORE"))
        {
            sb.Append(type.StartsWith("CLUSTERED") ? "CLUSTERED COLUMNSTORE INDEX " : "NONCLUSTERED COLUMNSTORE INDEX ");
            sb.Append(SqlServerNames.Quote(ix.Name)).Append(" ON ").Append(table);
            if (!type.StartsWith("CLUSTERED"))
                sb.Append(" (").Append(string.Join(", ", ix.KeyColumns.Concat(ix.IncludedColumns.Select(n => new SqlServerIndexColumn(n))).Select(k => SqlServerNames.Quote(k.Name)))).Append(')');
            return sb.Append(';').ToString();
        }
        if (type is "XML" or "SPATIAL")
        {
            sb.Append(type).Append(" INDEX ").Append(SqlServerNames.Quote(ix.Name)).Append(" ON ").Append(table)
              .Append(" (").Append(string.Join(", ", ix.KeyColumns.Select(k => SqlServerNames.Quote(k.Name)))).Append(')');
            return sb.Append(';').ToString();
        }
        sb.Append(Clustering(ix.TypeDesc)).Append("INDEX ").Append(SqlServerNames.Quote(ix.Name)).Append(" ON ").Append(table)
          .Append(" (").Append(KeyList(ix.KeyColumns)).Append(')');
        if (ix.IncludedColumns.Count > 0)
            sb.Append(" INCLUDE (").Append(string.Join(", ", ix.IncludedColumns.Select(SqlServerNames.Quote))).Append(')');
        if (!string.IsNullOrEmpty(ix.Filter)) sb.Append(" WHERE ").Append(ix.Filter);
        return sb.Append(';').ToString();
    }

    private static string Clustering(string typeDesc) => typeDesc.ToUpperInvariant() switch
    {
        "CLUSTERED" => "CLUSTERED ",
        "NONCLUSTERED" => "NONCLUSTERED ",
        _ => "",
    };

    private static string KeyList(IReadOnlyList<SqlServerIndexColumn> cols) =>
        string.Join(", ", cols.Select(k => SqlServerNames.Quote(k.Name) + (k.Descending ? " DESC" : " ASC")));

    private static string? Action(string desc) => desc.ToUpperInvariant() switch
    {
        "CASCADE" => "CASCADE",
        "SET_NULL" => "SET NULL",
        "SET_DEFAULT" => "SET DEFAULT",
        _ => null,
    };
}
