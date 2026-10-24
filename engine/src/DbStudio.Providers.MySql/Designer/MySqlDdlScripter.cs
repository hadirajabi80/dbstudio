using System.Globalization;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.MySql.Designer;

/// <summary>
/// MySQL / MariaDB DDL scripter (plan-batch3 WP-MY). DDL is not transactional (each statement commits): the script is
/// marked non-transactional and says so. CREATE TABLE with inline keys, indexes (DESC and prefix lengths
/// <c>col(10)</c>), CHECK and FOREIGN KEY constraints, AUTO_INCREMENT, generated columns (VIRTUAL / STORED) and COMMENTs.
/// ALTER: RENAME TABLE first, then <c>DROP FOREIGN KEY</c>s (their own statement: an FK may need the index being
/// changed), one <c>ALTER TABLE</c> with drops, <c>CHANGE COLUMN</c> (rename + redefinition), <c>MODIFY COLUMN</c>
/// (redefinition, comments, order with FIRST / AFTER), <c>ADD COLUMN … AFTER</c>, keys, indexes, checks and the table
/// comment, and finally <c>ADD FOREIGN KEY</c>s. FULLTEXT / SPATIAL / functional indexes are not part of the model and
/// are left alone.
/// </summary>
public sealed class MySqlDdlScripter(string providerId = "mysql") : IDdlScripter
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public const string NotTransactionalWarning =
        "MySQL DDL is not transactional: each statement commits on its own, so statements that ran before a failure stay applied.";

    public string ProviderId => providerId;

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("tinyint", "none", "tinyint", "number"),
        new("smallint", "none", "smallint", "number"),
        new("mediumint", "none", "mediumint", "number"),
        new("int", "none", "int", "number"),
        new("bigint", "none", "bigint", "number"),
        new("int unsigned", "none", "int unsigned", "number"),
        new("bigint unsigned", "none", "bigint unsigned", "number"),
        new("decimal", "precisionScale", "decimal(12,2)", "number"),
        new("float", "none", "float", "number"),
        new("double", "none", "double", "number"),
        new("bit", "length", "bit(1)", "number"),
        new("boolean", "none", "boolean", "other"),
        new("char", "length", "char(10)", "string"),
        new("varchar", "length", "varchar(255)", "string"),
        new("tinytext", "none", "tinytext", "string"),
        new("text", "none", "text", "string"),
        new("mediumtext", "none", "mediumtext", "string"),
        new("longtext", "none", "longtext", "string"),
        new("enum", "none", "enum('a','b')", "string"),
        new("set", "none", "set('a','b')", "string"),
        new("json", "none", "json", "other"),
        new("date", "none", "date", "date"),
        new("time", "precision", "time", "date"),
        new("datetime", "precision", "datetime", "date"),
        new("timestamp", "precision", "timestamp", "date"),
        new("year", "none", "year", "date"),
        new("binary", "length", "binary(16)", "binary"),
        new("varbinary", "length", "varbinary(255)", "binary"),
        new("blob", "none", "blob", "binary"),
        new("longblob", "none", "longblob", "binary"),
        new("geometry", "none", "geometry", "other"),
        new("point", "none", "point", "other"),
    ],
    new DesignerFeatures(Identity: false, Computed: true, ClusteredIndexes: false, IncludedColumns: false, FilteredIndexes: false,
        OnUpdateAction: true, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: false, Autoincrement: true, Schemas: true));

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        DesignerValidation.ValidateTable(WithoutPrefixes(desired), requireIndexNames: true);
        foreach (var c in desired.Columns.Where(c => c.Computed is not null && string.IsNullOrWhiteSpace(c.Type)))
            throw new ArgumentException($"Generated column '{c.Name}' needs a type in MySQL.");
        if (desired.Columns.Count(IsAutoIncrement) > 1) throw new ArgumentException("A MySQL table can have only one AUTO_INCREMENT column.");

        var warnings = new List<string> { NotTransactionalWarning };
        if (desired.Options.WithoutRowid || desired.Options.Strict) warnings.Add("WITHOUT ROWID / STRICT are SQLite options; ignored.");
        if (desired.Indexes.Any(i => i.Include.Count > 0)) warnings.Add("MySQL has no INCLUDE columns; they are ignored.");
        if (desired.Indexes.Any(i => !string.IsNullOrWhiteSpace(i.Filter))) warnings.Add("MySQL has no filtered (partial) indexes; the filter is ignored.");
        if (desired.ForeignKeys.Any(f => ReferentialActions.Normalize(f.OnDelete) == ReferentialActions.SetDefault || ReferentialActions.Normalize(f.OnUpdate) == ReferentialActions.SetDefault))
            warnings.Add("InnoDB rejects SET DEFAULT foreign-key actions.");

        var schema = string.IsNullOrWhiteSpace(desired.Schema) ? original?.Schema ?? context.DefaultSchema : desired.Schema;
        desired = Normalize(desired) with { Schema = schema };
        if (original is not null) original = Normalize(original) with { Schema = string.IsNullOrWhiteSpace(original.Schema) ? context.DefaultSchema : original.Schema };

        var flavor = MySqlFlavor.From(context.ServerVersion, null);
        var diff = TableDiff.Compute(original, desired);
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTableSql(desired), DdlKinds.Create));
            return new TableScript(statements, false, false, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, false, [], diff.Changes);
        ScriptAlter(diff, statements, warnings, flavor);
        return new TableScript(statements, false, false, warnings, diff.Changes);
    }

    private static bool IsAutoIncrement(TableColumnModel c) => c.Autoincrement || c.Identity is not null;

    /// <summary>Index columns "name(10)" → "name" (for validation only).</summary>
    private static TableModel WithoutPrefixes(TableModel t) => t with
    {
        Indexes = t.Indexes.Select(i => i with { Columns = i.Columns.Select(c => c with { Name = SplitPrefix(c.Name).Name }).ToList() }).ToList(),
    };

    internal static (string Name, int? Prefix) SplitPrefix(string column)
    {
        var open = column.LastIndexOf('(');
        if (open > 0 && column.EndsWith(')') && int.TryParse(column[(open + 1)..^1], NumberStyles.None, Inv, out var n)) return (column[..open].TrimEnd(), n);
        return (column, null);
    }

    /// <summary>
    /// Settings MySQL has no notion of compare equal: identity → AUTO_INCREMENT, clustered flags, INCLUDE, filters, SQLite
    /// options; RESTRICT = NO ACTION (InnoDB treats both as RESTRICT, and the servers report either).
    /// </summary>
    internal static TableModel Normalize(TableModel t) => t with
    {
        Options = t.Options with { WithoutRowid = false, Strict = false, Tablespace = null },
        PrimaryKey = t.PrimaryKey is null ? null : t.PrimaryKey with { Clustered = false, Name = null },
        Indexes = t.Indexes.Select(i => i with { Clustered = false, Include = [], Filter = null }).ToList(),
        ForeignKeys = t.ForeignKeys.Select(f => f with { OnDelete = Action(f.OnDelete), OnUpdate = Action(f.OnUpdate) }).ToList(),
        Columns = t.Columns.Select(c => c with
        {
            Autoincrement = c.Autoincrement || c.Identity is not null,
            Identity = null,
            DefaultName = null,
            Nullable = c.Autoincrement || c.Identity is not null ? false : c.Nullable,
        }).ToList(),
    };

    private static string Action(string? a)
    {
        var n = ReferentialActions.Normalize(a);
        return n == ReferentialActions.Restrict ? ReferentialActions.NoAction : n;
    }

    public static string CreateTableSql(TableModel t)
    {
        var parts = t.Columns.Select(ColumnSql).ToList();
        if (t.PrimaryKey is { Columns.Count: > 0 } pk) parts.Add(PrimaryKeySql(pk));
        foreach (var u in t.Uniques) parts.Add(UniqueSql(u));
        foreach (var ix in t.Indexes) parts.Add(IndexSql(ix));
        foreach (var ck in t.Checks) parts.Add(CheckSql(ck));
        foreach (var fk in t.ForeignKeys) parts.Add(ForeignKeySql(t, fk));
        var sb = new StringBuilder($"CREATE TABLE {Table(t.Schema, t.Name)} (\n{string.Join(",\n", parts.Select(p => "    " + p))}\n)");
        if (!string.IsNullOrWhiteSpace(t.Comment)) sb.Append(" COMMENT = ").Append(MySqlSqlText.Literal(t.Comment));
        return sb.ToString();
    }

    private static void ScriptAlter(TableDiffResult d, List<DdlStatement> statements, List<string> warnings, MySqlFlavor flavor)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var table = Table(original.Schema, original.Name);

        // 1. rename (schema move = RENAME TABLE into the other database)
        if (!original.Name.Equals(desired.Name, StringComparison.Ordinal) || !string.Equals(original.Schema, desired.Schema, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"RENAME TABLE {table} TO {Table(desired.Schema, desired.Name)}", DdlKinds.Rename,
                "Views, routines and triggers that name the table by its old name are not updated."));
            table = Table(desired.Schema, desired.Name);
        }

        // 2. foreign keys that go away (own statement: the index they rely on may change below)
        if (d.ForeignKeysDropped.Count > 0)
            statements.Add(new DdlStatement($"ALTER TABLE {table}\n{string.Join(",\n", d.ForeignKeysDropped.Select(f => "    DROP FOREIGN KEY " + Q(NameOf(f.Name, "foreign key"))))}",
                DdlKinds.Drop));

        // 3. the main ALTER TABLE
        var sub = new List<(string Sql, string? Warning)>();
        foreach (var ck in d.ChecksDropped)
            sub.Add(((flavor.IsMariaDb || flavor.AtLeast(8, 0, 19) || flavor.Major == 0 ? "DROP CONSTRAINT " : "DROP CHECK ") + Q(NameOf(ck.Name, "check constraint")), null));
        foreach (var ix in d.IndexesDropped) sub.Add(("DROP INDEX " + Q(ix.Name), null));
        foreach (var u in d.UniquesDropped) sub.Add(("DROP INDEX " + Q(NameOf(u.Name, "unique key")), null));
        if (d.PrimaryKeyDropped is not null) sub.Add(("DROP PRIMARY KEY", null));
        foreach (var c in d.Dropped) sub.Add(($"DROP COLUMN {Q(c.Name)}", $"Dropping column {c.Name} deletes its data."));

        string? Position(TableColumnModel c)
        {
            var i = desired.Columns.FindIndex(x => ReferenceEquals(x, c));
            return i <= 0 ? " FIRST" : " AFTER " + Q(desired.Columns[i - 1].Name);
        }

        foreach (var m in d.Matched)
        {
            var redefine = m.DefinitionChanged || m.CommentChanged || d.ColumnsReordered;
            if (!m.Renamed && !redefine) continue;
            var position = d.ColumnsReordered ? Position(m.New) : "";
            var warning = m.TypeChanged ? Narrowing(m.Old, m.New) : null;
            if (m.NullabilityChanged && !m.New.Nullable) warning = Join(warning, $"Fails (strict mode) or converts NULLs if {m.New.Name} contains NULLs.");
            sub.Add(m.Renamed
                ? ($"CHANGE COLUMN {Q(m.Old.Name)} {ColumnSql(m.New)}{position}", warning)
                : ($"MODIFY COLUMN {ColumnSql(m.New)}{position}", warning));
        }
        foreach (var c in d.Added)
        {
            string? warning = null;
            if (!c.Nullable && c.Default is null && c.Computed is null && !IsAutoIncrement(c))
                warning = $"NOT NULL column {c.Name} without a default gets the type's implicit default (0, '') in existing rows.";
            sub.Add(($"ADD COLUMN {ColumnSql(c)}{Position(c)}", warning));
        }
        if (d.PrimaryKeyAdded is { } pk) sub.Add(("ADD " + PrimaryKeySql(pk), null));
        foreach (var u in d.UniquesAdded) sub.Add(("ADD " + UniqueSql(u), null));
        foreach (var ix in d.IndexesAdded) sub.Add(("ADD " + IndexSql(ix), null));
        foreach (var ck in d.ChecksAdded) sub.Add(("ADD " + CheckSql(ck), null));
        if (d.CommentChanged) sub.Add(("COMMENT = " + MySqlSqlText.Literal(desired.Comment ?? ""), null));
        if (sub.Count > 0)
        {
            var warning = string.Join(" ", sub.Where(s => s.Warning is not null).Select(s => s.Warning).Distinct());
            statements.Add(new DdlStatement($"ALTER TABLE {table}\n{string.Join(",\n", sub.Select(s => "    " + s.Sql))}", DdlKinds.Alter,
                warning.Length == 0 ? null : warning));
        }

        // 4. new foreign keys last (their columns, keys and indexes exist now)
        if (d.ForeignKeysAdded.Count > 0)
            statements.Add(new DdlStatement($"ALTER TABLE {table}\n{string.Join(",\n", d.ForeignKeysAdded.Select(f => "    ADD " + ForeignKeySql(desired, f)))}",
                DdlKinds.Alter));
    }

    // ------------------------------------------------------------------ builders

    /// <summary><c>`name` type [COLLATE x] [GENERATED ALWAYS AS (e) VIRTUAL|STORED] [NOT NULL] [DEFAULT e] [AUTO_INCREMENT] [COMMENT '…']</c>.</summary>
    public static string ColumnSql(TableColumnModel c)
    {
        var sb = new StringBuilder(Q(c.Name)).Append(' ').Append(c.Type.Trim());
        if (!string.IsNullOrWhiteSpace(c.Collation)) sb.Append(" COLLATE ").Append(c.Collation.Trim());
        if (c.Computed is not null)
        {
            sb.Append(" GENERATED ALWAYS AS (").Append(TableDiff.StripOuterParens(c.Computed.Expression)).Append(c.Computed.Persisted ? ") STORED" : ") VIRTUAL");
            if (!c.Nullable) sb.Append(" NOT NULL");
        }
        else
        {
            sb.Append(c.Nullable && !IsAutoIncrement(c) ? " NULL" : " NOT NULL");
            if (c.Default is not null && !IsAutoIncrement(c)) sb.Append(" DEFAULT ").Append(DefaultSql(c.Default, c.Type));
            if (IsAutoIncrement(c)) sb.Append(" AUTO_INCREMENT");
        }
        if (!string.IsNullOrWhiteSpace(c.Comment)) sb.Append(" COMMENT ").Append(MySqlSqlText.Literal(c.Comment));
        return sb.ToString();
    }

    private static readonly HashSet<string> ExpressionOnlyDefaults = new(StringComparer.OrdinalIgnoreCase)
    {
        "json", "tinytext", "text", "mediumtext", "longtext", "tinyblob", "blob", "mediumblob", "longblob", "geometry", "point",
        "linestring", "polygon", "multipoint", "multilinestring", "multipolygon", "geometrycollection",
    };

    /// <summary>
    /// The DEFAULT clause of a column: JSON / TEXT / BLOB / spatial columns only take expression defaults (MySQL 8.0.13+),
    /// so their literals are parenthesized; other types keep literals as typed.
    /// </summary>
    internal static string DefaultSql(string def, string? type)
    {
        var sql = DefaultSql(def);
        var baseType = MySqlTypes.BaseName(type);
        if (ExpressionOnlyDefaults.Contains(baseType) && !sql.StartsWith('(') && !sql.Equals("NULL", StringComparison.OrdinalIgnoreCase)) return "(" + sql + ")";
        return sql;
    }

    /// <summary>Literals and CURRENT_TIMESTAMP [ON UPDATE …] as typed; other expressions need parentheses (MySQL 8.0.13+).</summary>
    internal static string DefaultSql(string def)
    {
        var d = def.Trim();
        if (d.Length == 0) return "''";
        var onUpdate = d.IndexOf(" ON UPDATE ", StringComparison.OrdinalIgnoreCase);
        if (onUpdate > 0) return DefaultSql(d[..onUpdate]) + d[onUpdate..];
        if (d.StartsWith('(') || d.StartsWith('\'') || d.StartsWith('"') || d.StartsWith("b'", StringComparison.OrdinalIgnoreCase) || d.StartsWith("x'", StringComparison.OrdinalIgnoreCase)
            || d.StartsWith("_", StringComparison.Ordinal) || d.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return d;
        if (double.TryParse(d, NumberStyles.Float, Inv, out _)) return d;
        var upper = d.ToUpperInvariant();
        if (upper is "NULL" or "TRUE" or "FALSE" || upper.StartsWith("CURRENT_TIMESTAMP", StringComparison.Ordinal) || upper.StartsWith("NOW(", StringComparison.Ordinal)
            || upper.StartsWith("LOCALTIMESTAMP", StringComparison.Ordinal) || upper.StartsWith("CURRENT_DATE", StringComparison.Ordinal)) return d;
        return "(" + d + ")";
    }

    private static string KeyColumns(IEnumerable<string> cols) => string.Join(", ", cols.Select(Q));

    private static string PrimaryKeySql(PrimaryKeyModel pk) => $"PRIMARY KEY ({KeyColumns(pk.Columns)})";

    private static string UniqueSql(UniqueModel u) =>
        string.IsNullOrWhiteSpace(u.Name) ? $"UNIQUE KEY ({KeyColumns(u.Columns)})" : $"UNIQUE KEY {Q(u.Name.Trim())} ({KeyColumns(u.Columns)})";

    private static string IndexColumn(IndexColumnModel c)
    {
        var (name, prefix) = SplitPrefix(c.Name);
        return Q(name) + (prefix is { } p ? "(" + p.ToString(Inv) + ")" : "") + (c.Desc ? " DESC" : "");
    }

    private static string IndexSql(IndexModel ix) =>
        $"{(ix.Unique ? "UNIQUE INDEX" : "INDEX")} {Q(ix.Name)} ({string.Join(", ", ix.Columns.Select(IndexColumn))})";

    private static string CheckSql(CheckModel ck) =>
        (string.IsNullOrWhiteSpace(ck.Name) ? "" : $"CONSTRAINT {Q(ck.Name.Trim())} ") + $"CHECK ({TableDiff.StripOuterParens(ck.Expression)})";

    private static string ForeignKeySql(TableModel t, ForeignKeyModel fk)
    {
        var refSchema = string.IsNullOrWhiteSpace(fk.RefSchema) ? t.Schema : fk.RefSchema;
        var sb = new StringBuilder(string.IsNullOrWhiteSpace(fk.Name) ? "" : $"CONSTRAINT {Q(fk.Name.Trim())} ");
        sb.Append($"FOREIGN KEY ({KeyColumns(fk.Columns)}) REFERENCES {Table(refSchema, fk.RefTable)}");
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(KeyColumns(fk.RefColumns)).Append(')');
        var onDelete = ReferentialActions.Normalize(fk.OnDelete);
        var onUpdate = ReferentialActions.Normalize(fk.OnUpdate);
        if (onDelete != ReferentialActions.NoAction) sb.Append(" ON DELETE ").Append(onDelete);
        if (onUpdate != ReferentialActions.NoAction) sb.Append(" ON UPDATE ").Append(onUpdate);
        return sb.ToString();
    }

    private static string NameOf(string? name, string what) =>
        string.IsNullOrWhiteSpace(name) ? throw new ArgumentException($"The {what} to drop has no name; reload the table from the server.") : name;

    private static string? Narrowing(TableColumnModel oldCol, TableColumnModel newCol)
    {
        var (ob, oa) = DdlText.ParseType(oldCol.Type);
        var (nb, na) = DdlText.ParseType(newCol.Type);
        if (TableDiff.NormalizeType(ob) == TableDiff.NormalizeType(nb))
        {
            var o0 = DdlText.ArgInt(oa, 0);
            var n0 = DdlText.ArgInt(na, 0);
            if ((o0 is not null && n0 is not null && n0 < o0) || DdlText.ArgInt(na, 1) < DdlText.ArgInt(oa, 1))
                return $"Narrowing {oldCol.Type} to {newCol.Type} fails (strict mode) or truncates values that do not fit.";
            return null;
        }
        return $"Changing {oldCol.Type} to {newCol.Type} rebuilds the table and converts existing data; values that cannot be converted fail the change (strict mode).";
    }

    private static string? Join(string? a, string b) => a is null ? b : a + " " + b;

    // ------------------------------------------------------------------ views

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var schema = string.IsNullOrWhiteSpace(view.Schema) ? context.DefaultSchema : view.Schema;
        var statements = new List<DdlStatement>();
        var warnings = new List<string> { NotTransactionalWarning };
        if (view.Options.Force) warnings.Add("FORCE is an Oracle option; ignored.");
        if (view.Options.SchemaBinding) warnings.Add("SCHEMABINDING is a SQL Server option; ignored.");
        var original = view.OriginalName;
        var editing = original is not null;
        if (editing && !original!.Equals(view.Name, StringComparison.Ordinal))
            statements.Add(new DdlStatement($"RENAME TABLE {Table(schema, original)} TO {Table(schema, view.Name)}", DdlKinds.Rename));
        var sb = new StringBuilder(editing ? "CREATE OR REPLACE VIEW " : "CREATE VIEW ").Append(Table(schema, view.Name))
            .Append(" AS\n").Append(view.Body.Trim().TrimEnd(';').TrimEnd());
        if (view.Options.CheckOption) sb.Append("\nWITH CASCADED CHECK OPTION");
        statements.Add(new DdlStatement(sb.ToString(), editing ? DdlKinds.Alter : DdlKinds.Create));
        return new DdlScript(statements, false, false, warnings);
    }

    // ------------------------------------------------------------------ names

    private static string Q(string name) => MySqlSqlText.Quote(name);

    public static string Table(string? schema, string name) => MySqlSqlText.Qualify(schema, name);
}
