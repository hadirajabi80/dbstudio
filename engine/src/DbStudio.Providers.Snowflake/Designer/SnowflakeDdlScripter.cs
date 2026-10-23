using System.Globalization;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Snowflake.Designer;

/// <summary>
/// Snowflake DDL scripter (plan-batch3 WP-SF). Snowflake DDL is not transactional (every statement commits), so the apply
/// step runs statement by statement and stops at the first error. Mapping of the shared table model:
/// <list type="bullet">
/// <item>identity → <c>IDENTITY(start, increment)</c> (Snowflake's AUTOINCREMENT);</item>
/// <item>a <b>clustered index</b> → the table's clustering key (<c>CLUSTER BY (…)</c>; at most one); other indexes do not
/// exist on standard tables and are ignored with a warning;</item>
/// <item>primary, unique and foreign keys are scripted (Snowflake records them but enforces only NOT NULL);</item>
/// <item>check constraints and computed columns do not exist on standard tables (warnings).</item>
/// </list>
/// Alters: renames → drops → adds → <c>SET DATA TYPE</c> (only widening: longer VARCHAR, more NUMBER precision) →
/// <c>SET / DROP NOT NULL</c> → <c>DROP DEFAULT</c> / <c>SET DEFAULT seq.NEXTVAL</c> → keys → clustering → comments.
/// </summary>
public sealed class SnowflakeDdlScripter : IDdlScripter
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public string ProviderId => "snowflake";

    public const string ClusterIndexName = "CLUSTER BY";

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("NUMBER", "precisionScale", "NUMBER(38,0)", "number"),
        new("INT", "none", "INT", "number"),
        new("FLOAT", "none", "FLOAT", "number"),
        new("DECFLOAT", "none", "DECFLOAT", "number"),
        new("VARCHAR", "length", "VARCHAR(255)", "string"),
        new("CHAR", "length", "CHAR(10)", "string"),
        new("STRING", "none", "STRING", "string"),
        new("BINARY", "length", "BINARY(16)", "binary"),
        new("BOOLEAN", "none", "BOOLEAN", "other"),
        new("DATE", "none", "DATE", "date"),
        new("TIME", "precision", "TIME(9)", "date"),
        new("TIMESTAMP_NTZ", "precision", "TIMESTAMP_NTZ(9)", "date"),
        new("TIMESTAMP_LTZ", "precision", "TIMESTAMP_LTZ(9)", "date"),
        new("TIMESTAMP_TZ", "precision", "TIMESTAMP_TZ(9)", "date"),
        new("VARIANT", "none", "VARIANT", "other"),
        new("OBJECT", "none", "OBJECT", "other"),
        new("ARRAY", "none", "ARRAY", "other"),
        new("GEOGRAPHY", "none", "GEOGRAPHY", "other"),
        new("GEOMETRY", "none", "GEOMETRY", "other"),
        new("VECTOR", "none", "VECTOR(FLOAT, 768)", "other"),
    ],
    new DesignerFeatures(Identity: true, Computed: false, ClusteredIndexes: true, IncludedColumns: false, FilteredIndexes: false,
        OnUpdateAction: true, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: false, Autoincrement: false, Schemas: true));

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        // A primary key is never clustered in Snowflake (the shared model defaults to clustered).
        desired = desired with { PrimaryKey = desired.PrimaryKey is null ? null : desired.PrimaryKey with { Clustered = false } };
        DesignerValidation.ValidateTable(desired, requireIndexNames: false);
        if (desired.Indexes.Count(i => i.Clustered) > 1) throw new ArgumentException("A Snowflake table has at most one clustering key (one clustered index).");

        // Warnings about what Snowflake cannot hold, only for what this change adds.
        var warnings = new List<string>();
        bool Added<T>(IEnumerable<T> desiredItems, IEnumerable<T>? originalItems, Func<T, T, bool> same) =>
            desiredItems.Any(d => originalItems is null || !originalItems.Any(o => same(o, d)));
        if (desired.Options.WithoutRowid || desired.Options.Strict) warnings.Add("WITHOUT ROWID / STRICT are SQLite options; ignored.");
        if (!string.IsNullOrWhiteSpace(desired.Options.Tablespace)) warnings.Add("Snowflake has no tablespaces; ignored.");
        if (Added(desired.Checks, original?.Checks, (o, d) => o.Name == d.Name && TableDiff.SameExpression(o.Expression, d.Expression)))
            warnings.Add("Snowflake does not support CHECK constraints on standard tables; they are not scripted.");
        if (Added(desired.Columns.Where(c => c.Computed is not null), original?.Columns.Where(c => c.Computed is not null), (o, d) => o.Name == d.Name))
            warnings.Add("Snowflake standard tables have no computed columns; the expressions are ignored (use a view).");
        if (Added(desired.Indexes.Where(i => !i.Clustered), original?.Indexes.Where(i => !i.Clustered), (o, d) => o.Name == d.Name))
            warnings.Add("Snowflake standard tables have no indexes (micro-partitions are pruned automatically); only a clustered index becomes the clustering key.");

        var schema = SchemaOf(desired.Schema ?? original?.Schema, context);
        desired = Normalize(desired) with { Schema = schema };
        if (original is not null) original = Normalize(original) with { Schema = SchemaOf(original.Schema, context) };

        var diff = TableDiff.Compute(original, desired);
        var keysAdded = diff.IsCreate
            ? desired.PrimaryKey is { Columns.Count: > 0 } || desired.ForeignKeys.Count > 0 || desired.Uniques.Count > 0
            : diff.PrimaryKeyAdded is not null || diff.ForeignKeysAdded.Count > 0 || diff.UniquesAdded.Count > 0;
        if (keysAdded) warnings.Add("Snowflake records primary, unique and foreign keys but does not enforce them (only NOT NULL is enforced).");
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTableSql(desired), DdlKinds.Create));
            return new TableScript(statements, false, false, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, false, warnings, diff.Changes);
        ScriptAlter(diff, statements, warnings);
        if (diff.ColumnsReordered) warnings.Add("Snowflake keeps the existing column order (reordering needs a new table: CREATE TABLE … AS SELECT).");
        if (statements.Count > 1) warnings.Add("Snowflake DDL is not transactional: each statement commits; a failure leaves the earlier statements applied.");
        return new TableScript(statements, false, false, warnings, diff.Changes);
    }

    private static string SchemaOf(string? schema, DdlScriptContext context) =>
        string.IsNullOrWhiteSpace(schema) ? context.DefaultSchema ?? SnowflakeConnectionStrings.DefaultSchema : schema;

    /// <summary>What Snowflake cannot hold compares equal (non-clustered indexes, checks, computed, autoincrement flags).</summary>
    private static TableModel Normalize(TableModel t) => t with
    {
        Options = new TableOptions(),
        PrimaryKey = t.PrimaryKey is null ? null : t.PrimaryKey with { Clustered = false },
        Indexes = t.Indexes.Where(i => i.Clustered).Select(i => i with { Name = ClusterIndexName, Unique = false, Include = [], Filter = null }).ToList(),
        Checks = [],
        Columns = t.Columns.Select(c => c with { Autoincrement = false, DefaultName = null, Computed = null, Identity = c.Identity is null ? null : c.Identity with { Always = false } }).ToList(),
    };

    public static string CreateTableSql(TableModel t)
    {
        var parts = t.Columns.Select(ColumnSql).ToList();
        if (t.PrimaryKey is { Columns.Count: > 0 } pk) parts.Add(PrimaryKeySql(pk));
        foreach (var u in t.Uniques) parts.Add(UniqueSql(u));
        foreach (var fk in t.ForeignKeys) parts.Add(ForeignKeySql(t, fk));
        var sb = new StringBuilder($"CREATE TABLE {Table(t.Schema!, t.Name)} (\n{string.Join(",\n", parts.Select(p => "    " + p))}\n)");
        if (t.Indexes.FirstOrDefault(i => i.Clustered) is { } cluster) sb.Append("\nCLUSTER BY (").Append(ClusterKeys(cluster)).Append(')');
        if (!string.IsNullOrWhiteSpace(t.Comment)) sb.Append("\nCOMMENT = ").Append(SnowflakeSql.Literal(t.Comment));
        return sb.ToString();
    }

    private static void ScriptAlter(TableDiffResult d, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var table = Table(original.Schema!, original.Name);

        // 1. schema move / rename (ALTER TABLE … RENAME TO schema.name moves it)
        if (!original.Schema!.Equals(desired.Schema, StringComparison.Ordinal) || !original.Name.Equals(desired.Name, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME TO {Table(desired.Schema!, desired.Name)}", DdlKinds.Rename,
                "Views referencing the table by name stop working until they are recreated."));
            table = Table(desired.Schema!, desired.Name);
        }
        foreach (var m in d.Renamed)
            statements.Add(new DdlStatement($"ALTER TABLE {table} RENAME COLUMN {Q(m.Old.Name)} TO {Q(m.New.Name)}", DdlKinds.Rename));

        // 2. drops: keys first (they reference columns), then columns
        foreach (var fk in d.ForeignKeysDropped) statements.Add(new DdlStatement($"ALTER TABLE {table} DROP {ConstraintTarget(fk.Name, "FOREIGN KEY", fk.Columns)}", DdlKinds.Drop));
        foreach (var u in d.UniquesDropped) statements.Add(new DdlStatement($"ALTER TABLE {table} DROP {ConstraintTarget(u.Name, "UNIQUE", u.Columns)}", DdlKinds.Drop));
        if (d.PrimaryKeyDropped is not null) statements.Add(new DdlStatement($"ALTER TABLE {table} DROP PRIMARY KEY", DdlKinds.Drop));
        if (d.IndexesDropped.Count > 0 && d.IndexesAdded.Count == 0)
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP CLUSTERING KEY", DdlKinds.Drop));
        if (d.Dropped.Count > 0)
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP COLUMN {string.Join(", ", d.Dropped.Select(c => Q(c.Name)))}", DdlKinds.Drop,
                $"Dropping {string.Join(", ", d.Dropped.Select(c => c.Name))} deletes the data (Time Travel keeps the table's history, not a dropped column)."));

        // 3. new columns
        foreach (var c in d.Added)
        {
            string? warning = null;
            if (!c.Nullable && c.Default is null && c.Identity is null)
                warning = $"Adding NOT NULL column {c.Name} without a default fails when the table has rows.";
            if (c.Identity is not null) warning = $"Adding identity column {c.Name} fails when the table has rows (Snowflake numbers new rows only).";
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD COLUMN {ColumnSql(c)}", DdlKinds.Alter, warning));
        }

        // 4. changed columns
        foreach (var m in d.Matched)
        {
            var col = Q(m.New.Name);
            if (m.TypeChanged)
            {
                var widening = IsWidening(m.Old.Type, m.New.Type);
                statements.Add(new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} SET DATA TYPE {m.New.Type.Trim()}", DdlKinds.Alter,
                    widening ? null : $"Snowflake only widens a column (longer VARCHAR, more NUMBER precision); {m.Old.Type} → {m.New.Type} is likely refused: add a new column, copy the data and drop the old one instead."));
            }
            if (m.CollationChanged) warnings.Add($"Column {m.New.Name}: Snowflake cannot change the collation of an existing column.");
            if (m.NullabilityChanged)
                statements.Add(m.New.Nullable
                    ? new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} DROP NOT NULL", DdlKinds.Alter)
                    : new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} SET NOT NULL", DdlKinds.Alter, $"Fails if {m.New.Name} contains NULLs."));
            if (m.DefaultChanged)
            {
                if (m.New.Default is null)
                    statements.Add(new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} DROP DEFAULT", DdlKinds.Alter));
                else
                    statements.Add(new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} SET DEFAULT {TableDiff.StripOuterParens(m.New.Default)}", DdlKinds.Alter,
                        IsSequenceDefault(m.New.Default) ? null : "Snowflake only lets an existing column's default become a sequence (seq.NEXTVAL); other defaults need a new column."));
            }
            if (m.IdentityChanged)
                warnings.Add($"Column {m.New.Name}: Snowflake cannot add, drop or change an identity on an existing column (recreate the column or the table).");
            if (m.CommentChanged)
                statements.Add(string.IsNullOrWhiteSpace(m.New.Comment)
                    ? new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} UNSET COMMENT", DdlKinds.Comment)
                    : new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {col} COMMENT {SnowflakeSql.Literal(m.New.Comment)}", DdlKinds.Comment));
        }

        // 5. keys, clustering, comments
        if (d.PrimaryKeyAdded is { } pk) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {PrimaryKeySql(pk)}", DdlKinds.Alter));
        foreach (var u in d.UniquesAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {UniqueSql(u)}", DdlKinds.Alter));
        foreach (var fk in d.ForeignKeysAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {ForeignKeySql(desired, fk)}", DdlKinds.Alter));
        if (d.IndexesAdded.FirstOrDefault() is { } cluster)
            statements.Add(new DdlStatement($"ALTER TABLE {table} CLUSTER BY ({ClusterKeys(cluster)})", DdlKinds.Index,
                "Automatic Clustering reclusters the table in the background and consumes credits."));
        if (d.CommentChanged)
            statements.Add(string.IsNullOrWhiteSpace(desired.Comment)
                ? new DdlStatement($"ALTER TABLE {table} UNSET COMMENT", DdlKinds.Comment)
                : new DdlStatement($"ALTER TABLE {table} SET COMMENT = {SnowflakeSql.Literal(desired.Comment)}", DdlKinds.Comment));
    }

    /// <summary>VARCHAR(n) → VARCHAR(m ≥ n) and NUMBER(p,s) → NUMBER(q ≥ p, s): the type changes Snowflake allows.</summary>
    public static bool IsWidening(string oldType, string newType)
    {
        var (ob, oa) = DdlText.ParseType(oldType);
        var (nb, na) = DdlText.ParseType(newType);
        var o = SnowflakeTypes.Normalize(ob);
        var n = SnowflakeTypes.Normalize(nb);
        if (o != n) return false;
        if (o == "VARCHAR")
        {
            var ol = DdlText.ArgInt(oa, 0) ?? (int)SnowflakeTypes.MaxVarcharLength;
            var nl = DdlText.ArgInt(na, 0) ?? (int)SnowflakeTypes.MaxVarcharLength;
            return nl >= ol;
        }
        if (o == "NUMBER")
        {
            var op = DdlText.ArgInt(oa, 0) ?? 38;
            var np = DdlText.ArgInt(na, 0) ?? 38;
            var os = DdlText.ArgInt(oa, 1) ?? 0;
            var ns = DdlText.ArgInt(na, 1) ?? 0;
            return np >= op && ns == os;
        }
        return false;
    }

    private static bool IsSequenceDefault(string expr) => expr.Contains(".NEXTVAL", StringComparison.OrdinalIgnoreCase);

    // ------------------------------------------------------------------ builders

    /// <summary><c>name TYPE [COLLATE 'x'] [IDENTITY(s, i) | DEFAULT e] [NOT NULL] [COMMENT 'c']</c>.</summary>
    public static string ColumnSql(TableColumnModel c)
    {
        var sb = new StringBuilder(Q(c.Name)).Append(' ').Append(c.Type.Trim());
        if (!string.IsNullOrWhiteSpace(c.Collation)) sb.Append(" COLLATE ").Append(SnowflakeSql.Literal(c.Collation.Trim().Trim('\'')));
        if (c.Identity is { } id) sb.Append($" IDENTITY({id.Seed.ToString(Inv)}, {id.Increment.ToString(Inv)})");
        else if (c.Default is not null) sb.Append(" DEFAULT ").Append(TableDiff.StripOuterParens(c.Default));
        if (!c.Nullable) sb.Append(" NOT NULL");
        if (!string.IsNullOrWhiteSpace(c.Comment)) sb.Append(" COMMENT ").Append(SnowflakeSql.Literal(c.Comment));
        return sb.ToString();
    }

    private static string Named(string? name) => string.IsNullOrWhiteSpace(name) ? "" : $"CONSTRAINT {Q(name.Trim())} ";

    private static string PrimaryKeySql(PrimaryKeyModel pk) => $"{Named(pk.Name)}PRIMARY KEY ({string.Join(", ", pk.Columns.Select(Q))})";

    private static string UniqueSql(UniqueModel u) => $"{Named(u.Name)}UNIQUE ({string.Join(", ", u.Columns.Select(Q))})";

    private static string ForeignKeySql(TableModel t, ForeignKeyModel fk)
    {
        var refSchema = string.IsNullOrWhiteSpace(fk.RefSchema) ? t.Schema ?? SnowflakeConnectionStrings.DefaultSchema : fk.RefSchema;
        var sb = new StringBuilder($"{Named(fk.Name)}FOREIGN KEY ({string.Join(", ", fk.Columns.Select(Q))}) REFERENCES {Table(refSchema, fk.RefTable)}");
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(string.Join(", ", fk.RefColumns.Select(Q))).Append(')');
        var onDelete = ReferentialActions.Normalize(fk.OnDelete);
        var onUpdate = ReferentialActions.Normalize(fk.OnUpdate);
        if (onUpdate != ReferentialActions.NoAction) sb.Append(" ON UPDATE ").Append(onUpdate);
        if (onDelete != ReferentialActions.NoAction) sb.Append(" ON DELETE ").Append(onDelete);
        return sb.ToString();
    }

    /// <summary><c>CONSTRAINT "n"</c> when named (Snowflake names unnamed keys SYS_CONSTRAINT_…), else <c>UNIQUE (cols)</c>.</summary>
    private static string ConstraintTarget(string? name, string kind, IReadOnlyList<string> columns) =>
        string.IsNullOrWhiteSpace(name) ? $"{kind} ({string.Join(", ", columns.Select(Q))})" : $"CONSTRAINT {Q(name)}";

    private static string ClusterKeys(IndexModel ix) =>
        string.Join(", ", ix.Columns.Select(c => SnowflakeSql.IsPlain(c.Name) || !c.Name.Contains('(') ? Q(c.Name) : c.Name));

    // ------------------------------------------------------------------ views

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var schema = SchemaOf(view.Schema, context);
        var statements = new List<DdlStatement>();
        var warnings = new List<string>();
        if (view.Options.Force) warnings.Add("FORCE is an Oracle option; ignored.");
        if (view.Options.SchemaBinding) warnings.Add("SCHEMABINDING is a SQL Server option; ignored.");
        if (view.Options.CheckOption) warnings.Add("Snowflake views have no CHECK OPTION; ignored.");
        var original = view.OriginalName;
        var editing = original is not null;
        if (editing && !original!.Equals(view.Name, StringComparison.Ordinal))
            statements.Add(new DdlStatement($"ALTER VIEW {Table(schema, original)} RENAME TO {Table(schema, view.Name)}", DdlKinds.Rename));
        var sql = (editing ? "CREATE OR REPLACE VIEW " : "CREATE VIEW ") + Table(schema, view.Name) + (editing ? " COPY GRANTS" : "") + " AS\n" + TrimBody(view.Body);
        statements.Add(new DdlStatement(sql, editing ? DdlKinds.Alter : DdlKinds.Create));
        return new DdlScript(statements, false, false, warnings);
    }

    public static string TrimBody(string body) => body.Trim().TrimEnd(';').TrimEnd();

    private static string Q(string name) => SnowflakeSql.Quote(name);

    public static string Table(string schema, string name) => Q(schema) + "." + Q(name);
}
