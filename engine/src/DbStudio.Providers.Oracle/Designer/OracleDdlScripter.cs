using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Oracle.Designer;

/// <summary>
/// Oracle DDL scripter (docs/PLAN-M1.5.md 1.3.1). Not transactional: every DDL statement commits, so apply runs the
/// statements in order and stops at the first error. CREATE TABLE with GENERATED ... AS IDENTITY, ALTER TABLE
/// ADD/MODIFY/DROP COLUMN, RENAME COLUMN, RENAME TO, named constraints (ON DELETE CASCADE / SET NULL; ON UPDATE is not
/// supported and ignored with a warning), CREATE [UNIQUE] INDEX and COMMENT ON. Identifiers are folded to upper case
/// unless they are mixed case (then quoted as written).
/// </summary>
public sealed partial class OracleDdlScripter : IDdlScripter
{
    public string ProviderId => "oracle";

    public DesignerTypesInfo GetTypes(DdlScriptContext context)
    {
        var major = MajorVersion(context.ServerVersion);
        var types = new List<DesignerType>
        {
            new("NUMBER", "precisionScale", "NUMBER(10)", "number"),
            new("INTEGER", "none", "INTEGER", "number"),
            new("FLOAT", "precision", "FLOAT", "number"),
            new("BINARY_DOUBLE", "none", "BINARY_DOUBLE", "number"),
            new("BINARY_FLOAT", "none", "BINARY_FLOAT", "number"),
            new("VARCHAR2", "length", "VARCHAR2(100 CHAR)", "string"),
            new("NVARCHAR2", "length", "NVARCHAR2(100)", "string"),
            new("CHAR", "length", "CHAR(1)", "string"),
            new("NCHAR", "length", "NCHAR(1)", "string"),
            new("CLOB", "none", "CLOB", "string"),
            new("NCLOB", "none", "NCLOB", "string"),
            new("DATE", "none", "DATE", "date"),
            new("TIMESTAMP", "precision", "TIMESTAMP(6)", "date"),
            new("TIMESTAMP WITH TIME ZONE", "precision", "TIMESTAMP(6) WITH TIME ZONE", "date"),
            new("TIMESTAMP WITH LOCAL TIME ZONE", "precision", "TIMESTAMP(6) WITH LOCAL TIME ZONE", "date"),
            new("INTERVAL DAY TO SECOND", "none", "INTERVAL DAY(2) TO SECOND(6)", "date"),
            new("INTERVAL YEAR TO MONTH", "none", "INTERVAL YEAR(2) TO MONTH", "date"),
            new("BLOB", "none", "BLOB", "binary"),
            new("RAW", "length", "RAW(16)", "binary"),
            new("XMLTYPE", "none", "XMLTYPE", "other"),
        };
        if (major is null or >= 21) types.Add(new("JSON", "none", "JSON", "other"));
        if (major is null or >= 23) types.Add(new("BOOLEAN", "none", "BOOLEAN", "number"));
        return new DesignerTypesInfo(types, new DesignerFeatures(
            Identity: major is null or >= 12, Computed: true, ClusteredIndexes: false, IncludedColumns: false, FilteredIndexes: false,
            OnUpdateAction: false, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
            TransactionalDdl: false, Autoincrement: false, Schemas: true));
    }

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        var warnings = new List<string>();
        CollectWarnings(desired, warnings);
        desired = Normalize(desired, context);
        DesignerValidation.ValidateTable(desired);
        if (original is not null) original = Normalize(original, context);
        var diff = TableDiff.Compute(original, desired);
        var statements = new List<DdlStatement>();
        var table = Table(desired.Schema, desired.Name);

        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTableSql(desired), DdlKinds.Create));
            foreach (var ix in desired.Indexes) statements.Add(new DdlStatement(CreateIndexSql(desired, ix), DdlKinds.Index));
            AddComments(desired, table, statements);
            return new TableScript(statements, false, false, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, false, warnings, diff.Changes);
        ScriptAlter(diff, statements, warnings);
        if (diff.ColumnsReordered) warnings.Add("Oracle keeps the existing column order (reordering needs a table rebuild).");
        warnings.Add("Oracle commits every DDL statement: if one fails, the statements before it stay applied.");
        return new TableScript(statements, false, false, warnings, diff.Changes);
    }

    private static void CollectWarnings(TableModel t, List<string> warnings)
    {
        if (t.ForeignKeys.Any(f => ReferentialActions.Normalize(f.OnUpdate) is not (ReferentialActions.NoAction or ReferentialActions.Restrict)))
            warnings.Add("Oracle ignores ON UPDATE actions.");
        if (t.ForeignKeys.Any(f => ReferentialActions.Normalize(f.OnDelete) == ReferentialActions.SetDefault))
            warnings.Add("Oracle has no ON DELETE SET DEFAULT; NO ACTION is used.");
        if (t.Indexes.Any(i => i.Clustered || i.Include.Count > 0 || i.Filter is not null))
            warnings.Add("Oracle has no clustered, included-column or filtered indexes; those options are ignored.");
        if (t.Options.WithoutRowid || t.Options.Strict) warnings.Add("WITHOUT ROWID / STRICT are SQLite options; ignored.");
        if (t.Columns.Any(c => !string.IsNullOrWhiteSpace(c.Collation))) warnings.Add("Column collations are not scripted for Oracle.");
        if (t.Columns.Any(c => c.Computed is { Persisted: true })) warnings.Add("Oracle virtual columns are never stored; PERSISTED is ignored.");
    }

    /// <summary>Folds identifiers and drops options Oracle cannot represent, so they never count as changes.</summary>
    public static TableModel Normalize(TableModel t, DdlScriptContext context)
    {
        var schema = string.IsNullOrWhiteSpace(t.Schema) ? context.DefaultSchema : Fold(t.Schema);
        return t with
        {
            Schema = schema,
            Name = Fold(t.Name),
            Options = new TableOptions { Tablespace = string.IsNullOrWhiteSpace(t.Options.Tablespace) ? null : Fold(t.Options.Tablespace) },
            Columns = t.Columns.Select(c => c with
            {
                Id = c.Id is null ? null : Fold(c.Id),
                Name = Fold(c.Name),
                DefaultName = null,
                Collation = null,
                Autoincrement = false,
                Default = c.Default is null ? null : c.Default.Trim(),
                Computed = c.Computed is null ? null : c.Computed with { Persisted = false },
            }).ToList(),
            PrimaryKey = t.PrimaryKey is { Columns.Count: > 0 } pk ? pk with { Name = FoldOrNull(pk.Name), Columns = pk.Columns.Select(Fold).ToList(), Clustered = true } : null,
            Uniques = t.Uniques.Select(u => u with { Name = FoldOrNull(u.Name), Columns = u.Columns.Select(Fold).ToList() }).ToList(),
            Indexes = t.Indexes.Select(i => i with
            {
                Name = Fold(i.Name),
                Columns = i.Columns.Select(c => c with { Name = Fold(c.Name) }).ToList(),
                Clustered = false,
                Include = [],
                Filter = null,
            }).ToList(),
            ForeignKeys = t.ForeignKeys.Select(f => f with
            {
                Name = FoldOrNull(f.Name),
                Columns = f.Columns.Select(Fold).ToList(),
                RefSchema = FoldOrNull(f.RefSchema),
                RefTable = Fold(f.RefTable),
                RefColumns = f.RefColumns.Select(Fold).ToList(),
                OnDelete = ReferentialActions.Normalize(f.OnDelete) is ReferentialActions.Cascade or ReferentialActions.SetNull ? ReferentialActions.Normalize(f.OnDelete) : ReferentialActions.NoAction,
                OnUpdate = ReferentialActions.NoAction,
            }).ToList(),
            Checks = t.Checks.Select(c => c with { Name = FoldOrNull(c.Name) }).ToList(),
        };
    }

    private static void ScriptAlter(TableDiffResult d, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var schema = desired.Schema ?? original.Schema;
        var table = Table(original.Schema ?? schema, original.Name);
        if (!original.Name.Equals(desired.Name, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME TO {Ident(desired.Name)}", DdlKinds.Rename));
            table = Table(original.Schema ?? schema, desired.Name);
        }
        if (!string.Equals(original.Schema, desired.Schema, StringComparison.Ordinal) && original.Schema is not null && desired.Schema is not null)
            warnings.Add("Oracle cannot move a table to another schema with ALTER TABLE; the schema change is ignored.");

        foreach (var fk in d.ForeignKeysDropped) statements.Add(DropConstraint(table, fk.Name, "foreign key"));
        foreach (var ck in d.ChecksDropped) statements.Add(DropConstraint(table, ck.Name, "check constraint"));
        foreach (var u in d.UniquesDropped) statements.Add(DropConstraint(table, u.Name, "unique constraint"));
        foreach (var ix in d.IndexesDropped) statements.Add(new DdlStatement($"DROP INDEX {Table(original.Schema ?? schema, ix.Name)}", DdlKinds.Drop));
        if (d.PrimaryKeyDropped is { } pk) statements.Add(DropConstraint(table, pk.Name, "primary key"));

        foreach (var c in d.Dropped)
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP COLUMN {Ident(c.Name)}", DdlKinds.Drop, $"Dropping column {c.Name} deletes its data."));
        foreach (var m in d.Renamed)
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME COLUMN {Ident(m.Old.Name)} TO {Ident(m.New.Name)}", DdlKinds.Rename));

        foreach (var m in d.Matched)
        {
            if (m.ComputedChanged)
            {
                if (m.New.Computed is not null && m.Old.Computed is not null)
                    statements.Add(new DdlStatement($"ALTER TABLE {table} MODIFY ({Ident(m.New.Name)} AS ({TableDiff.StripOuterParens(m.New.Computed.Expression)}))", DdlKinds.Alter));
                else
                    warnings.Add($"Column {m.New.Name}: Oracle cannot turn a stored column into a virtual one (or back); drop and re-add it.");
                continue;
            }
            if (m.IdentityChanged)
            {
                if (m.New.Identity is null)
                    statements.Add(new DdlStatement($"ALTER TABLE {table} MODIFY {Ident(m.New.Name)} DROP IDENTITY", DdlKinds.Alter));
                else if (m.Old.Identity is null)
                    // ORA-30673: MODIFY ... AS IDENTITY only alters a column that already is an identity. Refuse the design
                    // up front instead of scripting DDL that always fails (after earlier statements were committed).
                    throw new ArgumentException(
                        $"Oracle cannot add an identity to an existing column ({m.New.Name}); add a new identity column instead.");
                else
                    statements.Add(new DdlStatement($"ALTER TABLE {table} MODIFY {Ident(m.New.Name)} {IdentityClause(m.New.Identity)}", DdlKinds.Alter));
            }
            var parts = new List<string>();
            if (m.TypeChanged && m.New.Computed is null) parts.Add(m.New.Type.Trim());
            if (m.DefaultChanged && m.New.Identity is null) parts.Add("DEFAULT " + (m.New.Default is null ? "NULL" : TableDiff.StripOuterParens(m.New.Default)));
            if (m.NullabilityChanged) parts.Add(m.New.Nullable ? "NULL" : "NOT NULL");
            if (parts.Count == 0) continue;
            string? warning = null;
            if (m.TypeChanged && m.New.Computed is null) warning = TypeChangeWarning(m.Old, m.New);
            if (m.NullabilityChanged && !m.New.Nullable) warning = (warning is null ? "" : warning + " ") + $"Fails if {m.New.Name} contains NULLs.";
            statements.Add(new DdlStatement($"ALTER TABLE {table} MODIFY ({Ident(m.New.Name)} {string.Join(" ", parts)})", DdlKinds.Alter, warning));
        }

        foreach (var c in d.Added)
        {
            var warning = !c.Nullable && c.Default is null && c.Identity is null && c.Computed is null ? $"Adding NOT NULL column {c.Name} without a default fails when the table has rows." : null;
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD ({ColumnSql(c)})", DdlKinds.Alter, warning));
        }

        if (d.PrimaryKeyAdded is { } npk) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {PrimaryKeySql(desired, npk)}", DdlKinds.Alter));
        foreach (var u in d.UniquesAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {UniqueSql(desired, u)}", DdlKinds.Alter));
        var n = original.Checks.Count;
        foreach (var ck in d.ChecksAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {CheckSql(desired, ck, ++n)}", DdlKinds.Alter));
        foreach (var fk in d.ForeignKeysAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {ForeignKeySql(desired, fk)}", DdlKinds.Alter));
        foreach (var ix in d.IndexesAdded) statements.Add(new DdlStatement(CreateIndexSql(desired, ix), DdlKinds.Index));

        if (d.CommentChanged) statements.Add(CommentSql($"TABLE {table}", desired.Comment));
        foreach (var m in d.Matched.Where(m => m.CommentChanged)) statements.Add(CommentSql($"COLUMN {table}.{Ident(m.New.Name)}", m.New.Comment));
        foreach (var c in d.Added.Where(c => !string.IsNullOrWhiteSpace(c.Comment))) statements.Add(CommentSql($"COLUMN {table}.{Ident(c.Name)}", c.Comment));
    }

    /// <summary>
    /// Warning for a column type change, or null when nothing can go wrong. Widening a length or precision (VARCHAR2(200)
    /// to VARCHAR2(400), NUMBER(10) to NUMBER(12)) always succeeds; only a smaller length, precision, scale or count of
    /// integer digits can fail on existing data, and a change of base type converts it (most need an empty column).
    /// </summary>
    public static string? TypeChangeWarning(TableColumnModel oldCol, TableColumnModel newCol)
    {
        if (TableDiff.SameType(oldCol.Type, newCol.Type)) return null;
        var (ob, oa) = DdlText.ParseType(oldCol.Type);
        var (nb, na) = DdlText.ParseType(newCol.Type);
        ob = Synonym(ob.Trim().ToUpperInvariant());
        nb = Synonym(nb.Trim().ToUpperInvariant());
        var conversion = $"Changing {oldCol.Type} to {newCol.Type} converts existing data: Oracle requires an empty column for most type changes, and fails when a value cannot be converted.";

        if (ob == "NUMBER" && nb == "NUMBER")
        {
            // NUMBER without precision is unbounded; NUMBER(p) is NUMBER(p,0); NUMBER(*,s) has precision 38.
            if (na.Count == 0) return null;
            if (oa.Count == 0) return $"Narrowing {oldCol.Type} to {newCol.Type} fails unless the column is empty (ORA-01440).";
            static (int P, int S) Precision(IReadOnlyList<string> a) => (a[0] == "*" ? 38 : DdlText.ArgInt(a, 0) ?? 38, DdlText.ArgInt(a, 1) ?? 0);
            var (op, os) = Precision(oa);
            var (np, ns) = Precision(na);
            return np < op || ns < os || np - ns < op - os
                ? $"Narrowing {oldCol.Type} to {newCol.Type} fails unless the column is empty (ORA-01440)."
                : null;
        }

        var sameFamily = ob == nb || (IsCharacterType(ob) && IsCharacterType(nb) && IsNational(ob) == IsNational(nb));
        if (!sameFamily) return conversion;
        var (oLen, oChar) = Length(oa);
        var (nLen, nChar) = Length(na);
        // CHAR <-> VARCHAR2 is allowed on data only while the length stays the same.
        if (ob != nb) return oLen == nLen && oChar == nChar ? null : conversion;
        var smaller = (oLen is not null && nLen is not null && nLen < oLen) || (oLen is null && nLen is not null) || (oChar && !nChar && nLen <= oLen);
        return smaller ? $"Narrowing {oldCol.Type} to {newCol.Type} fails when existing values do not fit (ORA-01441)." : null;

        static string Synonym(string t) => t switch { "VARCHAR" => "VARCHAR2", "DECIMAL" or "NUMERIC" => "NUMBER", _ => t };

        // "200", "200 CHAR", "200 BYTE": the length, and whether it counts characters.
        static (int? Length, bool Chars) Length(IReadOnlyList<string> a)
        {
            if (a.Count == 0) return (null, false);
            var bits = a[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var n = DdlText.ArgInt(bits, 0);
            return (n, bits.Length > 1 && bits[1].Equals("CHAR", StringComparison.OrdinalIgnoreCase));
        }
    }

    private static bool IsCharacterType(string baseType) => baseType is "VARCHAR2" or "CHAR" or "NVARCHAR2" or "NCHAR";

    private static bool IsNational(string baseType) => baseType is "NVARCHAR2" or "NCHAR";

    // ------------------------------------------------------------------ builders

    public static string CreateTableSql(TableModel t)
    {
        var parts = t.Columns.Select(ColumnSql).ToList();
        if (t.PrimaryKey is { Columns.Count: > 0 } pk) parts.Add(PrimaryKeySql(t, pk));
        foreach (var u in t.Uniques) parts.Add(UniqueSql(t, u));
        var n = 0;
        foreach (var ck in t.Checks) parts.Add(CheckSql(t, ck, ++n));
        foreach (var fk in t.ForeignKeys) parts.Add(ForeignKeySql(t, fk));
        var sql = $"CREATE TABLE {Table(t.Schema, t.Name)} (\n{string.Join(",\n", parts.Select(p => "    " + p))}\n)";
        if (!string.IsNullOrWhiteSpace(t.Options.Tablespace)) sql += " TABLESPACE " + Ident(t.Options.Tablespace);
        return sql;
    }

    public static string ColumnSql(TableColumnModel c)
    {
        var sb = new StringBuilder(Ident(c.Name));
        if (c.Computed is not null)
        {
            if (!string.IsNullOrWhiteSpace(c.Type)) sb.Append(' ').Append(c.Type.Trim());
            sb.Append(" GENERATED ALWAYS AS (").Append(TableDiff.StripOuterParens(c.Computed.Expression)).Append(") VIRTUAL");
            return sb.ToString();
        }
        sb.Append(' ').Append(c.Type.Trim());
        if (c.Identity is { } id) sb.Append(' ').Append(IdentityClause(id));
        else if (c.Default is not null) sb.Append(" DEFAULT ").Append(TableDiff.StripOuterParens(c.Default));
        if (!c.Nullable) sb.Append(" NOT NULL");
        return sb.ToString();
    }

    private static string IdentityClause(IdentityModel id) =>
        $"GENERATED {(id.Always ? "ALWAYS" : "BY DEFAULT")} AS IDENTITY (START WITH {id.Seed.ToString(CultureInfo.InvariantCulture)} INCREMENT BY {id.Increment.ToString(CultureInfo.InvariantCulture)})";

    private static string ConstraintName(string? name, string fallback) => Ident(string.IsNullOrWhiteSpace(name) ? Fold(Truncate(fallback)) : name);

    private static string PrimaryKeySql(TableModel t, PrimaryKeyModel pk) =>
        $"CONSTRAINT {ConstraintName(pk.Name, "PK_" + t.Name)} PRIMARY KEY ({string.Join(", ", pk.Columns.Select(Ident))})";

    private static string UniqueSql(TableModel t, UniqueModel u) =>
        $"CONSTRAINT {ConstraintName(u.Name, $"UQ_{t.Name}_{string.Join("_", u.Columns)}")} UNIQUE ({string.Join(", ", u.Columns.Select(Ident))})";

    private static string CheckSql(TableModel t, CheckModel ck, int n) =>
        $"CONSTRAINT {ConstraintName(ck.Name, $"CK_{t.Name}_{n}")} CHECK ({TableDiff.StripOuterParens(ck.Expression)})";

    private static string ForeignKeySql(TableModel t, ForeignKeyModel fk)
    {
        var sb = new StringBuilder($"CONSTRAINT {ConstraintName(fk.Name, $"FK_{t.Name}_{fk.RefTable}")} FOREIGN KEY ({string.Join(", ", fk.Columns.Select(Ident))}) REFERENCES {Table(fk.RefSchema ?? t.Schema, fk.RefTable)}");
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(string.Join(", ", fk.RefColumns.Select(Ident))).Append(')');
        var onDelete = ReferentialActions.Normalize(fk.OnDelete);
        if (onDelete is ReferentialActions.Cascade or ReferentialActions.SetNull) sb.Append(" ON DELETE ").Append(onDelete);
        return sb.ToString();
    }

    public static string CreateIndexSql(TableModel t, IndexModel ix) =>
        $"CREATE {(ix.Unique ? "UNIQUE " : "")}INDEX {Table(t.Schema, ix.Name)} ON {Table(t.Schema, t.Name)} ({string.Join(", ", ix.Columns.Select(c => Ident(c.Name) + (c.Desc ? " DESC" : "")))})";

    private static DdlStatement DropConstraint(string table, string? name, string what)
    {
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException($"The {what} to drop has no name; reload the table from the server.");
        return new DdlStatement($"ALTER TABLE {table} DROP CONSTRAINT {Ident(name)}", DdlKinds.Drop);
    }

    private static void AddComments(TableModel t, string table, List<DdlStatement> statements)
    {
        if (!string.IsNullOrWhiteSpace(t.Comment)) statements.Add(CommentSql($"TABLE {table}", t.Comment));
        foreach (var c in t.Columns.Where(c => !string.IsNullOrWhiteSpace(c.Comment)))
            statements.Add(CommentSql($"COLUMN {table}.{Ident(c.Name)}", c.Comment));
    }

    private static DdlStatement CommentSql(string target, string? comment) =>
        new($"COMMENT ON {target} IS {OracleSqlText.Literal(comment ?? "")}", DdlKinds.Comment);

    // ------------------------------------------------------------------ views

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var warnings = new List<string>();
        if (view.Options.SchemaBinding) warnings.Add("Schema binding is a SQL Server option; ignored.");
        var schema = string.IsNullOrWhiteSpace(view.Schema) ? context.DefaultSchema : Fold(view.Schema);
        var name = Fold(view.Name);
        var statements = new List<DdlStatement>();
        // OR REPLACE only when editing the same view: a new name is a plain CREATE, so an existing object of that name
        // fails with ORA-00955 instead of being replaced. A renamed view is created first, then the old one dropped
        // (DDL commits each statement: if the CREATE fails nothing has changed).
        var original = view.OriginalName is null ? null : Fold(view.OriginalName);
        var editing = original is not null && original.Equals(name, StringComparison.Ordinal);
        var sb = new StringBuilder(editing ? "CREATE OR REPLACE " : "CREATE ");
        if (view.Options.Force) sb.Append("FORCE ");
        sb.Append("VIEW ").Append(Table(schema, name)).Append(" AS\n").Append(TrimBody(view.Body));
        if (view.Options.CheckOption) sb.Append("\nWITH CHECK OPTION");
        statements.Add(new DdlStatement(sb.ToString(), editing ? DdlKinds.Alter : DdlKinds.Create));
        if (original is not null && !editing)
        {
            statements.Add(new DdlStatement($"DROP VIEW {Table(schema, original)}", DdlKinds.Drop));
            warnings.Add($"{Table(schema, original)} is replaced by a new view {Table(schema, name)}: grants on the old view are not carried over.");
        }
        return new DdlScript(statements, false, false, warnings);
    }

    public static string TrimBody(string body)
    {
        var b = body.Trim();
        if (b.EndsWith('/')) b = b[..^1].TrimEnd();
        return b.TrimEnd(';').TrimEnd();
    }

    // ------------------------------------------------------------------ identifiers

    [GeneratedRegex("^[A-Za-z][A-Za-z0-9_$#]*$")]
    private static partial Regex SimpleIdentifier();

    /// <summary>Oracle name folding: "x" (quoted) keeps its case; lower/upper simple names → upper; mixed case stays as written.</summary>
    public static string Fold(string name)
    {
        var n = name.Trim();
        if (n.Length >= 2 && n[0] == '"' && n[^1] == '"') return n[1..^1];
        if (SimpleIdentifier().IsMatch(n) && (n == n.ToUpperInvariant() || n == n.ToLowerInvariant())) return n.ToUpperInvariant();
        return n;
    }

    private static string? FoldOrNull(string? name) => string.IsNullOrWhiteSpace(name) ? null : Fold(name);

    /// <summary>Unquoted when the folded name is a plain upper-case identifier that is not reserved, else "quoted".</summary>
    public static string Ident(string name)
    {
        var n = Fold(name);
        return SimpleIdentifier().IsMatch(n) && n == n.ToUpperInvariant() && !OracleReservedWords.All.Contains(n) ? n : OracleSqlText.Quote(n);
    }

    public static string Table(string? schema, string name) =>
        string.IsNullOrWhiteSpace(schema) ? Ident(name) : Ident(schema) + "." + Ident(name);

    /// <summary>Generated names stay within 128 bytes (12.2+); older servers allow 30.</summary>
    private static string Truncate(string name) => name.Length <= 128 ? name : name[..128];

    private static int? MajorVersion(string? version) =>
        !string.IsNullOrWhiteSpace(version) && int.TryParse(version.Split('.')[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var m) ? m : null;
}
