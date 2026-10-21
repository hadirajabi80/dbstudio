using System.Globalization;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.PostgreSql.Designer;

/// <summary>
/// PostgreSQL DDL scripter (docs/PLAN-PG.md 2.7). DDL is transactional and no change needs a table rebuild:
/// CREATE TABLE with inline constraints (unnamed ones are named by the server), CREATE INDEX … USING btree … INCLUDE …
/// WHERE …, COMMENT ON. Alters run in the order renames → drops → adds → types → nullability → defaults → identity →
/// constraints → indexes → comments; column and constraint subcommands are combined into one
/// <c>ALTER TABLE … a, b, c</c> (one table rewrite at most). Identifiers are quoted only when needed
/// (<see cref="PgSqlText.Quote"/>), so mixed-case names keep their case.
/// </summary>
public sealed class PgDdlScripter : IDdlScripter
{
    public const string DefaultSchema = "public";

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => "postgresql";

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("smallint", "none", "smallint", "number"),
        new("integer", "none", "integer", "number"),
        new("bigint", "none", "bigint", "number"),
        new("numeric", "precisionScale", "numeric(12,2)", "number"),
        new("real", "none", "real", "number"),
        new("double precision", "none", "double precision", "number"),
        new("money", "none", "money", "number"),
        new("boolean", "none", "boolean", "other"),
        new("text", "none", "text", "string"),
        new("varchar", "length", "varchar(100)", "string"),
        new("char", "length", "char(10)", "string"),
        new("uuid", "none", "uuid", "other"),
        new("date", "none", "date", "date"),
        new("timestamp", "precision", "timestamp(3)", "date"),
        new("timestamptz", "precision", "timestamptz(3)", "date"),
        new("time", "precision", "time", "date"),
        new("timetz", "none", "timetz", "date"),
        new("interval", "none", "interval", "date"),
        new("bytea", "none", "bytea", "binary"),
        new("json", "none", "json", "other"),
        new("jsonb", "none", "jsonb", "other"),
        new("xml", "none", "xml", "other"),
        new("inet", "none", "inet", "other"),
        new("cidr", "none", "cidr", "other"),
        new("macaddr", "none", "macaddr", "other"),
        new("bit", "length", "bit(8)", "binary"),
        new("serial", "none", "serial", "other"),
        new("bigserial", "none", "bigserial", "other"),
    ],
    new DesignerFeatures(Identity: true, Computed: true, ClusteredIndexes: false, IncludedColumns: true, FilteredIndexes: true,
        OnUpdateAction: true, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: true, Autoincrement: false, Schemas: true));

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        DesignerValidation.ValidateTable(desired, requireIndexNames: true);
        foreach (var c in desired.Columns.Where(c => c.Computed is not null && string.IsNullOrWhiteSpace(c.Type)))
            throw new ArgumentException($"Generated column '{c.Name}' needs a type in PostgreSQL.");

        var warnings = new List<string>();
        if (desired.Options.WithoutRowid || desired.Options.Strict) warnings.Add("WITHOUT ROWID / STRICT are SQLite options; ignored.");
        if (desired.Columns.Any(c => c.Autoincrement && c.Identity is null)) warnings.Add("Use an identity column instead of autoincrement on PostgreSQL; autoincrement is ignored.");
        if (desired.Indexes.Any(i => i.Clustered)) warnings.Add("PostgreSQL has no clustered indexes (CLUSTER reorders a table once); the index is created as a regular index.");
        if (desired.Columns.Any(c => c.Computed is { Persisted: false })) warnings.Add("PostgreSQL only supports STORED generated columns; they are scripted as STORED.");

        var schema = SchemaOf(desired.Schema ?? original?.Schema, context);
        desired = Normalize(desired) with { Schema = schema };
        if (original is not null) original = Normalize(original) with { Schema = SchemaOf(original.Schema, context) };

        var diff = TableDiff.Compute(original, desired);
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            ScriptCreate(desired, statements);
            return new TableScript(statements, false, true, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, true, warnings, diff.Changes);
        ScriptAlter(diff, statements, warnings);
        if (diff.ColumnsReordered) warnings.Add("PostgreSQL keeps the existing column order (reordering needs a new table).");
        return new TableScript(statements, false, true, warnings, diff.Changes);
    }

    private static string SchemaOf(string? schema, DdlScriptContext context) =>
        string.IsNullOrWhiteSpace(schema) ? context.DefaultSchema ?? DefaultSchema : schema;

    /// <summary>Settings PostgreSQL has no notion of compare equal (clustered keys, SQLite options, autoincrement, VIRTUAL generated).</summary>
    private static TableModel Normalize(TableModel t) => t with
    {
        Options = t.Options with { WithoutRowid = false, Strict = false },
        PrimaryKey = t.PrimaryKey is null ? null : t.PrimaryKey with { Clustered = false },
        Indexes = t.Indexes.Select(i => i with { Clustered = false }).ToList(),
        Columns = t.Columns.Select(c => c with
        {
            Autoincrement = false,
            DefaultName = null,
            Computed = c.Computed is null ? null : c.Computed with { Persisted = true },
            Nullable = c.Identity is not null ? false : c.Nullable,
        }).ToList(),
    };

    private static void ScriptCreate(TableModel t, List<DdlStatement> statements)
    {
        var table = Table(t.Schema!, t.Name);
        var parts = t.Columns.Select(ColumnSql).ToList();
        if (t.PrimaryKey is { Columns.Count: > 0 } pk) parts.Add(PrimaryKeySql(pk));
        foreach (var u in t.Uniques) parts.Add(UniqueSql(u));
        foreach (var ck in t.Checks) parts.Add(CheckSql(ck));
        foreach (var fk in t.ForeignKeys) parts.Add(ForeignKeySql(t, fk));
        var sql = new StringBuilder($"CREATE TABLE {table} (\n{string.Join(",\n", parts.Select(p => "    " + p))}\n)");
        if (!string.IsNullOrWhiteSpace(t.Options.Tablespace)) sql.Append("\nTABLESPACE ").Append(Q(t.Options.Tablespace.Trim()));
        statements.Add(new DdlStatement(sql.ToString(), DdlKinds.Create));
        foreach (var ix in t.Indexes) statements.Add(new DdlStatement(CreateIndexSql(t, ix), DdlKinds.Index));
        if (!string.IsNullOrWhiteSpace(t.Comment)) statements.Add(CommentSql(table, null, t.Comment));
        foreach (var c in t.Columns.Where(c => !string.IsNullOrWhiteSpace(c.Comment)))
            statements.Add(CommentSql(table, c.Name, c.Comment));
    }

    private static void ScriptAlter(TableDiffResult d, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var schema = desired.Schema!;
        var table = Table(original.Schema!, original.Name);

        // 1. renames: schema, table, columns (each its own statement: RENAME cannot be combined with other subcommands)
        if (!original.Schema!.Equals(schema, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"ALTER TABLE {table} SET SCHEMA {Q(schema)}", DdlKinds.Rename));
            table = Table(schema, original.Name);
        }
        if (!original.Name.Equals(desired.Name, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME TO {Q(desired.Name)}", DdlKinds.Rename,
                "Views and functions referencing the table follow the rename (views by OID); SQL in function bodies does not."));
        }
        table = Table(schema, desired.Name);
        var recomputed = d.Matched.Where(m => m.ComputedChanged || (m.Old.Computed is null) != (m.New.Computed is null)).ToList();
        foreach (var m in d.Renamed.Where(m => !recomputed.Contains(m)))
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME COLUMN {Q(m.Old.Name)} TO {Q(m.New.Name)}", DdlKinds.Rename));

        if (d.OptionsChanged && !string.IsNullOrWhiteSpace(desired.Options.Tablespace))
            statements.Add(new DdlStatement($"ALTER TABLE {table} SET TABLESPACE {Q(desired.Options.Tablespace.Trim())}", DdlKinds.Alter,
                "Moving the table to another tablespace rewrites it and locks it meanwhile."));

        // 2. indexes that changed or went away
        foreach (var ix in d.IndexesDropped) statements.Add(new DdlStatement($"DROP INDEX {Table(schema, ix.Name)}", DdlKinds.Drop));

        // 3. one ALTER TABLE with the column and constraint subcommands
        var sub = new List<(string Sql, string? Warning)>();
        foreach (var fk in d.ForeignKeysDropped) sub.Add((DropConstraint(fk.Name, "foreign key"), null));
        foreach (var ck in d.ChecksDropped) sub.Add((DropConstraint(ck.Name, "check constraint"), null));
        foreach (var u in d.UniquesDropped) sub.Add((DropConstraint(u.Name, "unique constraint"), null));
        if (d.PrimaryKeyDropped is { } oldPk) sub.Add((DropConstraint(oldPk.Name, "primary key"), null));

        foreach (var c in d.Dropped) sub.Add(($"DROP COLUMN {Q(c.Name)}", $"Dropping column {c.Name} deletes its data."));
        foreach (var m in recomputed)
            sub.Add(($"DROP COLUMN {Q(m.Old.Name)}", m.Old.Computed is null ? $"Column {m.Old.Name} becomes generated: its stored data is replaced." : null));

        foreach (var c in d.Added.Concat(recomputed.Select(m => m.New)))
        {
            string? warning = null;
            if (!c.Nullable && c.Default is null && c.Computed is null && c.Identity is null)
                warning = $"Adding NOT NULL column {c.Name} without a default fails when the table has rows.";
            if (c.Identity is not null || c.Computed is not null || (c.Default is not null && IsVolatileDefault(c.Default)))
                warning = Join(warning, $"Adding {c.Name} rewrites the table.");
            sub.Add(($"ADD COLUMN {ColumnSql(c)}", warning));
        }

        var live = d.Matched.Where(m => !recomputed.Contains(m) && m.New.Computed is null).ToList();
        foreach (var m in live.Where(m => m.TypeChanged || m.CollationChanged))
        {
            if (IsSerial(m.New.Type))
            {
                warnings.Add($"Column {m.New.Name}: serial is not a type that can be altered to; use an identity column instead.");
                continue;
            }
            if (m.Old.Default is not null && m.TypeChanged) sub.Add(($"ALTER COLUMN {Q(m.New.Name)} DROP DEFAULT", null));
            var (oldBase, _) = DdlText.ParseType(m.Old.Type);
            var (newBase, _) = DdlText.ParseType(m.New.Type);
            var sameBase = TableDiff.NormalizeType(oldBase) == TableDiff.NormalizeType(newBase);
            var sql = $"ALTER COLUMN {Q(m.New.Name)} TYPE {m.New.Type.Trim()}{Collate(m.New)}";
            if (!sameBase) sql += $" USING {Q(m.New.Name)}::{m.New.Type.Trim()}";
            sub.Add((sql, NarrowingWarning(m.Old, m.New)));
        }
        // identity drops first (DROP NOT NULL is refused on an identity column), identity adds last (after DROP DEFAULT / SET NOT NULL)
        foreach (var m in live.Where(m => m.IdentityChanged && m.Old.Identity is not null && m.New.Identity is null))
            sub.Add(($"ALTER COLUMN {Q(m.New.Name)} DROP IDENTITY IF EXISTS", "The column keeps its values; new rows need explicit values."));
        foreach (var m in live.Where(m => m.NullabilityChanged))
        {
            sub.Add(m.New.Nullable
                ? ($"ALTER COLUMN {Q(m.New.Name)} DROP NOT NULL", null)
                : ($"ALTER COLUMN {Q(m.New.Name)} SET NOT NULL", $"Fails if {m.New.Name} contains NULLs."));
        }
        foreach (var m in live.Where(m => m.DefaultChanged || (m.TypeChanged && m.Old.Default is not null)))
        {
            if (m.New.Default is not null) sub.Add(($"ALTER COLUMN {Q(m.New.Name)} SET DEFAULT {TableDiff.StripOuterParens(m.New.Default)}", null));
            else if (!m.TypeChanged) sub.Add(($"ALTER COLUMN {Q(m.New.Name)} DROP DEFAULT", null));
        }
        foreach (var m in live.Where(m => m.IdentityChanged && m.New.Identity is not null))
        {
            var col = Q(m.New.Name);
            if (m.Old.Identity is null && m.New.Identity is { } added)
                sub.Add(($"ALTER COLUMN {col} ADD {IdentitySql(added)}", null));
            else if (m.Old.Identity is { } o && m.New.Identity is { } n)
            {
                if (o.Always != n.Always) sub.Add(($"ALTER COLUMN {col} SET GENERATED {(n.Always ? "ALWAYS" : "BY DEFAULT")}", null));
                if (o.Increment != n.Increment) sub.Add(($"ALTER COLUMN {col} SET INCREMENT BY {n.Increment.ToString(Inv)}", null));
                if (o.Seed != n.Seed)
                    sub.Add(($"ALTER COLUMN {col} SET START WITH {n.Seed.ToString(Inv)}", "A new start value applies after ALTER … RESTART; existing values are kept."));
            }
        }

        if (d.PrimaryKeyAdded is { } pk) sub.Add(($"ADD {PrimaryKeySql(pk)}", null));
        foreach (var u in d.UniquesAdded) sub.Add(($"ADD {UniqueSql(u)}", null));
        foreach (var ck in d.ChecksAdded) sub.Add(($"ADD {CheckSql(ck)}", null));
        foreach (var fk in d.ForeignKeysAdded) sub.Add(($"ADD {ForeignKeySql(desired, fk)}", null));

        if (sub.Count > 0)
        {
            var warning = string.Join(" ", sub.Where(s => s.Warning is not null).Select(s => s.Warning).Distinct());
            statements.Add(new DdlStatement($"ALTER TABLE {table}\n{string.Join(",\n", sub.Select(s => "    " + s.Sql))}", DdlKinds.Alter,
                warning.Length == 0 ? null : warning));
        }

        // 4. new indexes, 5. comments
        foreach (var ix in d.IndexesAdded) statements.Add(new DdlStatement(CreateIndexSql(desired, ix), DdlKinds.Index));
        if (d.CommentChanged) statements.Add(CommentSql(table, null, desired.Comment));
        foreach (var m in d.Matched.Where(m => m.CommentChanged || (recomputed.Contains(m) && !string.IsNullOrWhiteSpace(m.New.Comment))))
            statements.Add(CommentSql(table, m.New.Name, m.New.Comment));
        foreach (var c in d.Added.Where(c => !string.IsNullOrWhiteSpace(c.Comment)))
            statements.Add(CommentSql(table, c.Name, c.Comment));
    }

    // ------------------------------------------------------------------ builders

    /// <summary><c>name type [COLLATE "x"] [GENERATED ALWAYS AS (e) STORED] [GENERATED … AS IDENTITY [(…)]] [DEFAULT e] [NOT NULL]</c>.</summary>
    public static string ColumnSql(TableColumnModel c)
    {
        var sb = new StringBuilder(Q(c.Name)).Append(' ').Append(c.Type.Trim()).Append(Collate(c));
        if (c.Computed is not null)
            sb.Append(" GENERATED ALWAYS AS (").Append(TableDiff.StripOuterParens(c.Computed.Expression)).Append(") STORED");
        if (c.Identity is { } id) sb.Append(' ').Append(IdentitySql(id));
        if (c.Default is not null && c.Computed is null && c.Identity is null)
            sb.Append(" DEFAULT ").Append(TableDiff.StripOuterParens(c.Default));
        if (!c.Nullable || c.Identity is not null) sb.Append(" NOT NULL");
        return sb.ToString();
    }

    public static string IdentitySql(IdentityModel id)
    {
        var sql = id.Always ? "GENERATED ALWAYS AS IDENTITY" : "GENERATED BY DEFAULT AS IDENTITY";
        if (id.Seed != 1 || id.Increment != 1)
            sql += $" (START WITH {id.Seed.ToString(Inv)} INCREMENT BY {id.Increment.ToString(Inv)})";
        return sql;
    }

    private static string Collate(TableColumnModel c) =>
        string.IsNullOrWhiteSpace(c.Collation) ? "" : " COLLATE " + QuoteCollation(c.Collation.Trim());

    /// <summary>Collation names are case-sensitive identifiers ("C", "en_US", "und-x-icu"): always double-quoted.</summary>
    public static string QuoteCollation(string collation) =>
        collation.StartsWith('"') ? collation : "\"" + collation.Replace("\"", "\"\"") + "\"";

    private static string Named(string? name) => string.IsNullOrWhiteSpace(name) ? "" : $"CONSTRAINT {Q(name.Trim())} ";

    private static string PrimaryKeySql(PrimaryKeyModel pk) => $"{Named(pk.Name)}PRIMARY KEY ({string.Join(", ", pk.Columns.Select(Q))})";

    private static string UniqueSql(UniqueModel u) => $"{Named(u.Name)}UNIQUE ({string.Join(", ", u.Columns.Select(Q))})";

    private static string CheckSql(CheckModel ck) => $"{Named(ck.Name)}CHECK ({TableDiff.StripOuterParens(ck.Expression)})";

    private static string ForeignKeySql(TableModel t, ForeignKeyModel fk)
    {
        var refSchema = string.IsNullOrWhiteSpace(fk.RefSchema) ? t.Schema ?? DefaultSchema : fk.RefSchema;
        var sb = new StringBuilder($"{Named(fk.Name)}FOREIGN KEY ({string.Join(", ", fk.Columns.Select(Q))}) REFERENCES {Table(refSchema, fk.RefTable)}");
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(string.Join(", ", fk.RefColumns.Select(Q))).Append(')');
        var onDelete = ReferentialActions.Normalize(fk.OnDelete);
        var onUpdate = ReferentialActions.Normalize(fk.OnUpdate);
        if (onDelete != ReferentialActions.NoAction) sb.Append(" ON DELETE ").Append(onDelete);
        if (onUpdate != ReferentialActions.NoAction) sb.Append(" ON UPDATE ").Append(onUpdate);
        return sb.ToString();
    }

    /// <summary><c>CREATE [UNIQUE] INDEX name ON s.t USING btree (col [DESC], …) [INCLUDE (…)] [WHERE …]</c>; expression keys stay raw.</summary>
    public static string CreateIndexSql(TableModel t, IndexModel ix)
    {
        var columns = new HashSet<string>(t.Columns.Select(c => c.Name), StringComparer.Ordinal);
        string Key(IndexColumnModel c)
        {
            var key = columns.Contains(c.Name) || PgSqlText.IsPlain(c.Name) ? Q(c.Name) : "(" + TableDiff.StripOuterParens(c.Name) + ")";
            return key + (c.Desc ? " DESC" : "");
        }
        var sb = new StringBuilder("CREATE ");
        if (ix.Unique) sb.Append("UNIQUE ");
        sb.Append("INDEX ").Append(Q(ix.Name)).Append(" ON ").Append(Table(t.Schema ?? DefaultSchema, t.Name)).Append(" USING btree (")
            .Append(string.Join(", ", ix.Columns.Select(Key))).Append(')');
        if (ix.Include.Count > 0) sb.Append(" INCLUDE (").Append(string.Join(", ", ix.Include.Select(Q))).Append(')');
        if (!string.IsNullOrWhiteSpace(ix.Filter)) sb.Append(" WHERE ").Append(TableDiff.StripOuterParens(ix.Filter));
        return sb.ToString();
    }

    private static string DropConstraint(string? name, string what)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException($"The {what} to drop has no name; reload the table from the server.");
        return $"DROP CONSTRAINT {Q(name)}";
    }

    private static DdlStatement CommentSql(string table, string? column, string? comment)
    {
        var target = column is null ? $"TABLE {table}" : $"COLUMN {table}.{Q(column)}";
        var value = string.IsNullOrWhiteSpace(comment) ? "NULL" : PgSqlText.Literal(comment);
        return new DdlStatement($"COMMENT ON {target} IS {value}", DdlKinds.Comment);
    }

    private static bool IsSerial(string type) => TableDiff.NormalizeType(type) is "serial" or "bigserial" or "smallserial" or "serial4" or "serial8" or "serial2";

    /// <summary>Defaults that force a table rewrite when a column is added (volatile functions).</summary>
    private static bool IsVolatileDefault(string expr)
    {
        var e = expr.ToLowerInvariant();
        return e.Contains("random(", StringComparison.Ordinal) || e.Contains("gen_random_uuid(", StringComparison.Ordinal)
               || e.Contains("clock_timestamp(", StringComparison.Ordinal) || e.Contains("nextval(", StringComparison.Ordinal)
               || e.Contains("uuid_generate", StringComparison.Ordinal);
    }

    /// <summary>Warning when ALTER COLUMN … TYPE may fail or change data.</summary>
    public static string? NarrowingWarning(TableColumnModel oldCol, TableColumnModel newCol)
    {
        if (TableDiff.SameType(oldCol.Type, newCol.Type)) return null;
        var (ob, oa) = DdlText.ParseType(oldCol.Type);
        var (nb, na) = DdlText.ParseType(newCol.Type);
        ob = TableDiff.NormalizeType(ob);
        nb = TableDiff.NormalizeType(nb);
        if (ob == nb)
        {
            var o0 = DdlText.ArgInt(oa, 0);
            var n0 = DdlText.ArgInt(na, 0);
            if ((oa.Count == 0 && na.Count > 0) || (o0 is not null && n0 is not null && n0 < o0) || DdlText.ArgInt(na, 1) < DdlText.ArgInt(oa, 1))
                return $"Narrowing {oldCol.Type} to {newCol.Type} fails if a value does not fit.";
            return null;
        }
        return $"Changing {oldCol.Type} to {newCol.Type} converts existing data (USING {newCol.Name}::{newCol.Type.Trim()}); the change fails if a value cannot be converted.";
    }

    private static string? Join(string? a, string b) => a is null ? b : a + " " + b;

    // ------------------------------------------------------------------ views

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var schema = SchemaOf(view.Schema, context);
        var statements = new List<DdlStatement>();
        var warnings = new List<string>();
        if (view.Options.Force) warnings.Add("FORCE is an Oracle option; ignored.");
        if (view.Options.SchemaBinding) warnings.Add("SCHEMABINDING is a SQL Server option; ignored (PostgreSQL views always depend on their tables).");
        var original = view.OriginalName;
        var editing = original is not null;
        if (editing && !original!.Equals(view.Name, StringComparison.Ordinal))
            statements.Add(new DdlStatement($"ALTER VIEW {Table(schema, original)} RENAME TO {Q(view.Name)}", DdlKinds.Rename));
        var sb = new StringBuilder(editing ? "CREATE OR REPLACE VIEW " : "CREATE VIEW ").Append(Table(schema, view.Name))
            .Append(" AS\n").Append(TrimBody(view.Body));
        if (view.Options.CheckOption) sb.Append("\nWITH CASCADED CHECK OPTION");
        statements.Add(new DdlStatement(sb.ToString(), editing ? DdlKinds.Alter : DdlKinds.Create));
        if (editing) warnings.Add("CREATE OR REPLACE can only append columns; drop the view first to remove or retype columns.");
        return new DdlScript(statements, false, true, warnings);
    }

    public static string TrimBody(string body) => body.Trim().TrimEnd(';').TrimEnd();

    // ------------------------------------------------------------------ names

    private static string Q(string name) => PgSqlText.Quote(name);

    public static string Table(string schema, string name) => Q(schema) + "." + Q(name);
}
