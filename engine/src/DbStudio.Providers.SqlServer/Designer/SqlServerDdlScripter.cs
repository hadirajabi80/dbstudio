using System.Globalization;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.SqlServer.Designer;

/// <summary>
/// SQL Server DDL scripter (docs/PLAN-M1.5.md 1.3.1). All statements run in one transaction. CREATE TABLE uses named
/// constraints (PK_/DF_/UQ_/FK_/CK_ defaults); alters use ADD / ALTER COLUMN / sp_rename, drop default constraints
/// before ALTER/DROP COLUMN (by name, or looked up in sys.default_constraints when unknown), and rebuild the table
/// when an identity changes (new table + SET IDENTITY_INSERT + copy + rename). Comments are MS_Description extended
/// properties.
/// </summary>
public sealed class SqlServerDdlScripter : IDdlScripter
{
    public const string DefaultSchema = "dbo";
    public const string RebuildSuffix = "__new";

    public string ProviderId => "sqlserver";

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("int", "none", "int", "number"),
        new("bigint", "none", "bigint", "number"),
        new("smallint", "none", "smallint", "number"),
        new("tinyint", "none", "tinyint", "number"),
        new("bit", "none", "bit", "number"),
        new("decimal", "precisionScale", "decimal(18,2)", "number"),
        new("numeric", "precisionScale", "numeric(18,2)", "number"),
        new("money", "none", "money", "number"),
        new("float", "none", "float", "number"),
        new("real", "none", "real", "number"),
        new("nvarchar", "length", "nvarchar(100)", "string"),
        new("varchar", "length", "varchar(100)", "string"),
        new("nchar", "length", "nchar(10)", "string"),
        new("char", "length", "char(10)", "string"),
        new("date", "none", "date", "date"),
        new("datetime2", "precision", "datetime2(3)", "date"),
        new("datetime", "none", "datetime", "date"),
        new("datetimeoffset", "precision", "datetimeoffset(7)", "date"),
        new("time", "precision", "time(7)", "date"),
        new("smalldatetime", "none", "smalldatetime", "date"),
        new("uniqueidentifier", "none", "uniqueidentifier", "other"),
        new("varbinary", "length", "varbinary(max)", "binary"),
        new("binary", "length", "binary(16)", "binary"),
        new("xml", "none", "xml", "other"),
        new("sql_variant", "none", "sql_variant", "other"),
        new("rowversion", "none", "rowversion", "binary"),
    ],
    new DesignerFeatures(Identity: true, Computed: true, ClusteredIndexes: true, IncludedColumns: true, FilteredIndexes: true,
        OnUpdateAction: true, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: true, Autoincrement: false, Schemas: true));

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        DesignerValidation.ValidateTable(desired, requireIndexNames: true);
        var warnings = new List<string>();
        if (desired.Options.WithoutRowid || desired.Options.Strict) warnings.Add("WITHOUT ROWID / STRICT are SQLite options; ignored.");
        if (desired.Columns.Any(c => c.Autoincrement && c.Identity is null)) warnings.Add("Use identity instead of autoincrement on SQL Server; autoincrement is ignored.");
        var schema = SchemaOf(desired.Schema ?? original?.Schema, context);
        desired = desired with { Schema = schema, Options = desired.Options with { WithoutRowid = false, Strict = false } };
        if (original is not null) original = original with { Schema = SchemaOf(original.Schema, context), Options = original.Options with { WithoutRowid = false, Strict = false } };

        var diff = TableDiff.Compute(original, desired);
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            ScriptCreate(desired, Table(schema, desired.Name), statements, includeConstraints: true);
            return new TableScript(statements, false, true, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, true, warnings, diff.Changes);

        if (diff.Matched.Any(m => m.IdentityChanged) || diff.Added.Any(a => a.Identity is not null))
        {
            ScriptRebuild(diff, context, statements, warnings);
            warnings.Insert(0, "Identity columns cannot be altered in place: the table is rebuilt (new table, copy with IDENTITY_INSERT, drop, rename).");
            return new TableScript(statements, true, true, warnings, diff.Changes);
        }

        ScriptAlter(diff, statements, warnings);
        if (diff.ColumnsReordered) warnings.Add("SQL Server keeps the existing column order (reordering needs a table rebuild).");
        return new TableScript(statements, false, true, warnings, diff.Changes);
    }

    private static string SchemaOf(string? schema, DdlScriptContext context) =>
        string.IsNullOrWhiteSpace(schema) ? context.DefaultSchema ?? DefaultSchema : schema;

    private static void ScriptCreate(TableModel t, string table, List<DdlStatement> statements, bool includeConstraints)
    {
        var parts = t.Columns.Select(c => ColumnSql(t, c, withDefault: includeConstraints)).ToList();
        if (includeConstraints)
        {
            if (t.PrimaryKey is { Columns.Count: > 0 } pk) parts.Add(PrimaryKeySql(t, pk));
            foreach (var u in t.Uniques) parts.Add(UniqueSql(t, u));
            foreach (var ck in t.Checks.Select((c, i) => (c, i))) parts.Add(CheckSql(t, ck.c, ck.i + 1));
            foreach (var fk in t.ForeignKeys) parts.Add(ForeignKeySql(t, fk));
        }
        statements.Add(new DdlStatement($"CREATE TABLE {table} (\n{string.Join(",\n", parts.Select(p => "    " + p))}\n)", DdlKinds.Create));
        if (!includeConstraints) return;
        foreach (var ix in t.Indexes) statements.Add(new DdlStatement(CreateIndexSql(table, ix), DdlKinds.Index));
        AddComments(t, statements);
    }

    private static void ScriptAlter(TableDiffResult d, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var schema = desired.Schema!;
        var table = Table(original.Schema!, original.Name);

        // 0. schema transfer / rename
        if (!original.Schema!.Equals(schema, StringComparison.OrdinalIgnoreCase))
        {
            statements.Add(new DdlStatement($"ALTER SCHEMA {Q(schema)} TRANSFER {table}", DdlKinds.Rename));
            table = Table(schema, original.Name);
        }
        if (!original.Name.Equals(desired.Name, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"EXEC sys.sp_rename {L(Unquoted(schema, original.Name))}, {L(desired.Name)}", DdlKinds.Rename,
                "Renaming does not update views, procedures or triggers that reference the table."));
        }
        table = Table(schema, desired.Name);

        // 1–2. drop constraints and indexes that changed or went away
        foreach (var fk in d.ForeignKeysDropped) statements.Add(DropConstraint(table, fk.Name, "foreign key", warnings));
        foreach (var ck in d.ChecksDropped) statements.Add(DropConstraint(table, ck.Name, "check constraint", warnings));
        foreach (var u in d.UniquesDropped) statements.Add(DropConstraint(table, u.Name, "unique constraint", warnings));
        foreach (var ix in d.IndexesDropped) statements.Add(new DdlStatement($"DROP INDEX {Q(ix.Name)} ON {table}", DdlKinds.Drop));
        if (d.PrimaryKeyDropped is { } oldPk) statements.Add(DropConstraint(table, oldPk.Name, "primary key", warnings));

        // 3. default constraints that block ALTER/DROP COLUMN or change
        var recomputed = d.Matched.Where(m => m.ComputedChanged || (m.Old.Computed is null) != (m.New.Computed is null)).ToList();
        foreach (var c in d.Dropped.Where(c => c.Default is not null))
            statements.Add(DropDefault(table, schema, desired.Name, c));
        foreach (var m in d.Matched.Where(m => m.Old.Default is not null && (m.DefaultChanged || m.TypeChanged || recomputed.Contains(m))))
            statements.Add(DropDefault(table, schema, desired.Name, m.Old));

        // 4. dropped (and re-created computed) columns
        foreach (var c in d.Dropped)
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP COLUMN {Q(c.Name)}", DdlKinds.Drop, $"Dropping column {c.Name} deletes its data."));
        foreach (var m in recomputed)
            statements.Add(new DdlStatement($"ALTER TABLE {table} DROP COLUMN {Q(m.Old.Name)}", DdlKinds.Drop,
                m.Old.Computed is null ? $"Column {m.Old.Name} becomes computed: its stored data is replaced." : null));

        // 5. renames
        foreach (var m in d.Renamed.Where(m => !recomputed.Contains(m)))
            statements.Add(new DdlStatement($"EXEC sys.sp_rename {L(Unquoted(schema, desired.Name) + "." + Q(m.Old.Name))}, {L(m.New.Name)}, N'COLUMN'", DdlKinds.Rename));

        // 6. type / nullability / collation
        foreach (var m in d.Matched.Where(m => !recomputed.Contains(m) && m.New.Computed is null && (m.TypeChanged || m.NullabilityChanged || m.CollationChanged)))
        {
            var warning = NarrowingWarning(m.Old, m.New);
            if (m.NullabilityChanged && !m.New.Nullable) warning = Join(warning, $"Fails if {m.New.Name} contains NULLs.");
            statements.Add(new DdlStatement($"ALTER TABLE {table} ALTER COLUMN {Q(m.New.Name)} {m.New.Type.Trim()}{Collate(m.New)} {(m.New.Nullable ? "NULL" : "NOT NULL")}",
                DdlKinds.Alter, warning));
        }

        // 7. added (and re-created computed) columns
        foreach (var c in d.Added.Concat(recomputed.Select(m => m.New)))
        {
            var warning = !c.Nullable && c.Default is null && c.Computed is null ? $"Adding NOT NULL column {c.Name} without a default fails when the table has rows." : null;
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {ColumnSql(desired, c, withDefault: true)}", DdlKinds.Alter, warning));
        }

        // 8. defaults of existing columns
        foreach (var m in d.Matched.Where(m => !recomputed.Contains(m) && m.New.Default is not null && (m.DefaultChanged || (m.TypeChanged && m.Old.Default is not null))))
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD CONSTRAINT {Q(DefaultName(desired, m.New))} DEFAULT ({TableDiff.StripOuterParens(m.New.Default!)}) FOR {Q(m.New.Name)}", DdlKinds.Alter));

        // 9. new constraints and indexes
        if (d.PrimaryKeyAdded is { } pk) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {PrimaryKeySql(desired, pk)}", DdlKinds.Alter));
        foreach (var u in d.UniquesAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {UniqueSql(desired, u)}", DdlKinds.Alter));
        var checkNo = original.Checks.Count;
        foreach (var ck in d.ChecksAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {CheckSql(desired, ck, ++checkNo)}", DdlKinds.Alter));
        foreach (var fk in d.ForeignKeysAdded) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {ForeignKeySql(desired, fk)}", DdlKinds.Alter));
        foreach (var ix in d.IndexesAdded) statements.Add(new DdlStatement(CreateIndexSql(table, ix), DdlKinds.Index));

        // 10. comments
        if (d.CommentChanged) statements.Add(CommentSql(schema, desired.Name, null, original.Comment, desired.Comment));
        foreach (var m in d.Matched.Where(m => m.CommentChanged || (recomputed.Contains(m) && m.New.Comment is not null)))
            statements.Add(CommentSql(schema, desired.Name, m.New.Name, recomputed.Contains(m) ? null : m.Old.Comment, m.New.Comment));
        foreach (var c in d.Added.Where(c => !string.IsNullOrWhiteSpace(c.Comment)))
            statements.Add(CommentSql(schema, desired.Name, c.Name, null, c.Comment));
    }

    /// <summary>
    /// Identity rebuild, like SSMS: new table, copy with IDENTITY_INSERT, drop the foreign keys of other tables that
    /// reference it, drop the old table, rename, then recreate defaults, keys, checks, indexes, MS_Description comments,
    /// the inbound foreign keys, the triggers (from their stored definitions) and the permissions. Needs the dependents
    /// read by the designer database (<see cref="DdlScriptContext.Dependents"/>); refuses the rebuild with a validation
    /// error when they are unknown or something could not be scripted, instead of dropping objects it cannot restore:
    /// schema-bound objects, and storage the model does not hold (columnstore/XML/spatial/full-text indexes, partitioning,
    /// a non-default filegroup, compression, change tracking, CDC; features-r1-02), each named in the message.
    /// What cannot be carried over (other extended properties, trigger order) is listed in the warnings.
    /// </summary>
    private static void ScriptRebuild(TableDiffResult d, DdlScriptContext context, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var schema = desired.Schema!;
        var temp = Table(schema, desired.Name + RebuildSuffix);
        var oldTable = Table(original.Schema!, original.Name);

        const string refused = "The table cannot be rebuilt safely: ";
        if (context.Dependents is not { } dependents)
            throw new ArgumentException(refused + "the foreign keys, triggers and permissions that depend on it are unknown. Reload the table designer and try again.");
        if (dependents.FirstOrDefault(x => x.Type == DependentTypes.Blocker) is { } blocker)
            throw new ArgumentException(refused + (blocker.Detail ?? $"{blocker.Name} depends on it."));
        // Storage features the model does not hold (features-r1-02): CREATE TABLE [x__new] would come back without them.
        var storage = dependents.Where(x => DependentTypes.UnsupportedStorage.Contains(x.Type)).Select(x => DescribeStorage(original.Name, x)).Distinct().ToList();
        if (storage.Count == 1)
            throw new ArgumentException($"{refused}{storage[0]}; Rowlit cannot recreate it in a rebuild. Change the identity in a script instead.");
        if (storage.Count > 1)
            throw new ArgumentException($"{refused}Rowlit cannot recreate these in a rebuild: {string.Join("; ", storage)}. Change the identity in a script instead.");

        // Old column name -> new column name of the columns that survive (inbound FKs and column permissions follow renames).
        var renamed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in d.Matched) renamed.TryAdd(m.Old.Name, m.New.Name);
        var inbound = dependents.Where(x => x.Type == DependentTypes.ForeignKey && x.ForeignKey is not null).ToList();
        foreach (var fk in inbound)
        {
            var lost = fk.ForeignKey!.RefColumns.FirstOrDefault(c => !renamed.ContainsKey(c));
            if (lost is not null)
                throw new ArgumentException(refused + $"column {lost} is referenced by foreign key {fk.Name} of {Table(fk.OwnerSchema ?? schema, fk.OwnerTable ?? "")}; drop that foreign key first.");
        }
        var triggers = dependents.Where(x => x.Type == DependentTypes.Trigger).ToList();
        if (triggers.FirstOrDefault(t => string.IsNullOrWhiteSpace(t.Sql)) is { } hidden)
            throw new ArgumentException(refused + $"the definition of trigger {hidden.Name} is encrypted or not visible (VIEW DEFINITION), so it could not be recreated.");
        if (triggers.Count > 0 && (!original.Name.Equals(desired.Name, StringComparison.OrdinalIgnoreCase) || !original.Schema!.Equals(schema, StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException(refused + "its triggers name the table in their definition. Rename or move the table in a separate step.");

        ScriptCreate(desired, temp, statements, includeConstraints: false);
        statements[^1] = statements[^1] with { Kind = DdlKinds.Rebuild };
        var copy = d.Matched.Where(m => m.New.Computed is null && m.Old.Computed is null).ToList();
        var identity = desired.Columns.FirstOrDefault(c => c.Identity is not null);
        var insertIdentity = identity is not null && copy.Any(m => ReferenceEquals(m.New, identity));
        if (copy.Count > 0)
        {
            if (insertIdentity) statements.Add(new DdlStatement($"SET IDENTITY_INSERT {temp} ON", DdlKinds.Rebuild));
            statements.Add(new DdlStatement(
                $"INSERT INTO {temp} ({string.Join(", ", copy.Select(m => Q(m.New.Name)))})\nSELECT {string.Join(", ", copy.Select(m => Q(m.Old.Name)))}\nFROM {oldTable}",
                DdlKinds.Rebuild));
            if (insertIdentity) statements.Add(new DdlStatement($"SET IDENTITY_INSERT {temp} OFF", DdlKinds.Rebuild));
        }
        foreach (var fk in inbound)
        {
            var child = Table(fk.OwnerSchema ?? schema, fk.OwnerTable!);
            statements.Add(new DdlStatement($"ALTER TABLE {child} DROP CONSTRAINT {Q(fk.Name)}", DdlKinds.Drop,
                $"Foreign key {fk.Name} of {child} references the table: it is dropped here and recreated after the rebuild."));
        }
        var triggerNote = triggers.Count == 0 ? "" : $" Its triggers ({string.Join(", ", triggers.Select(t => t.Name))}) are recreated after the rename.";
        statements.Add(new DdlStatement($"DROP TABLE {oldTable}", DdlKinds.Rebuild, ("The old table is dropped; its rows were copied above." + triggerNote).Trim()));
        statements.Add(new DdlStatement($"EXEC sys.sp_rename {L(Unquoted(schema, desired.Name + RebuildSuffix))}, {L(desired.Name)}", DdlKinds.Rebuild));
        var table = Table(schema, desired.Name);
        foreach (var c in desired.Columns.Where(c => c.Default is not null && c.Computed is null))
            statements.Add(new DdlStatement($"ALTER TABLE {table} ADD CONSTRAINT {Q(DefaultName(desired, c))} DEFAULT ({TableDiff.StripOuterParens(c.Default!)}) FOR {Q(c.Name)}", DdlKinds.Alter));
        if (desired.PrimaryKey is { Columns.Count: > 0 } pk) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {PrimaryKeySql(desired, pk)}", DdlKinds.Alter));
        foreach (var u in desired.Uniques) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {UniqueSql(desired, u)}", DdlKinds.Alter));
        foreach (var ck in desired.Checks.Select((c, i) => (c, i))) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {CheckSql(desired, ck.c, ck.i + 1)}", DdlKinds.Alter));
        foreach (var fk in desired.ForeignKeys) statements.Add(new DdlStatement($"ALTER TABLE {table} ADD {ForeignKeySql(desired, fk)}", DdlKinds.Alter));
        foreach (var ix in desired.Indexes) statements.Add(new DdlStatement(CreateIndexSql(table, ix), DdlKinds.Index));
        AddComments(desired, statements); // MS_Description of the table and its columns, from the model

        // Inbound foreign keys, after the keys and unique indexes they reference; same trust and enabled state as before.
        foreach (var dep in inbound)
        {
            var child = Table(dep.OwnerSchema ?? schema, dep.OwnerTable!);
            var fk = dep.ForeignKey! with { RefSchema = schema, RefTable = desired.Name, RefColumns = dep.ForeignKey!.RefColumns.Select(c => renamed[c]).ToList() };
            var check = dep.Disabled || dep.Detail == "untrusted" ? "WITH NOCHECK" : "WITH CHECK";
            statements.Add(new DdlStatement($"ALTER TABLE {child} {check} ADD {ForeignKeySql(desired, fk)}", DdlKinds.Alter));
            if (dep.Disabled) statements.Add(new DdlStatement($"ALTER TABLE {child} NOCHECK CONSTRAINT {Q(dep.Name)}", DdlKinds.Alter));
        }

        // Triggers: their stored definitions, each a batch of its own.
        foreach (var trigger in triggers)
        {
            statements.Add(new DdlStatement(trigger.Sql.Trim(), DdlKinds.Create, $"Recreates trigger {trigger.Name} from its stored definition."));
            if (trigger.Disabled) statements.Add(new DdlStatement($"DISABLE TRIGGER {Table(schema, trigger.Name)} ON {table}", DdlKinds.Alter));
            if (trigger.Detail == "ordered") warnings.Add($"The firing order of trigger {trigger.Name} (sp_settriggerorder) is not carried over.");
        }

        // Permissions on the table and its columns.
        foreach (var p in dependents.Where(x => x.Type == DependentTypes.Permission))
        {
            string? column = null;
            if (p.Column is not null && !renamed.TryGetValue(p.Column, out column))
            {
                warnings.Add($"{p.Sql} on dropped column {p.Column} for {p.Name} is not carried over.");
                continue;
            }
            var verb = p.Detail == "DENY" ? "DENY" : "GRANT";
            var columns = column is null ? "" : $" ({Q(column)})";
            var withGrant = p.Detail == "GRANT_WITH_GRANT_OPTION" ? " WITH GRANT OPTION" : "";
            statements.Add(new DdlStatement($"{verb} {p.Sql}{columns} ON {table} TO {Q(p.Name)}{withGrant}", DdlKinds.Alter));
        }

        foreach (var n in dependents.Where(x => x.Type == DependentTypes.NotCarried)) warnings.Add(n.Detail ?? $"{n.Name} is not carried over.");
        foreach (var c in d.Dropped) warnings.Add($"Column {c.Name} is dropped with its data.");
    }

    /// <summary>
    /// "Orders has a columnstore index IX_cs", "index PK_Orders of Orders uses PAGE compression", ... for a storage
    /// dependent (<see cref="DependentObject.Name"/> empty = the table itself).
    /// </summary>
    internal static string DescribeStorage(string table, DependentObject x)
    {
        var name = x.Name;
        var detail = string.IsNullOrWhiteSpace(x.Detail) ? null : x.Detail.Trim();
        var subject = name.Length == 0 ? table : $"index {name} of {table}";
        return x.Type switch
        {
            DependentTypes.ColumnstoreIndex => $"{table} has a columnstore index {name}".TrimEnd(),
            DependentTypes.XmlIndex => $"{table} has an XML index {name}".TrimEnd(),
            DependentTypes.SpatialIndex => $"{table} has a spatial index {name}".TrimEnd(),
            DependentTypes.OtherIndex => $"{table} has a {(detail ?? "special").Replace('_', ' ').ToLowerInvariant()} index {name}".TrimEnd(),
            DependentTypes.FulltextIndex => detail is null ? $"{table} has a full-text index" : $"{table} has a full-text index (catalog {detail})",
            DependentTypes.Partitioning => $"{subject} is partitioned on {detail ?? "a partition scheme"}",
            DependentTypes.Filegroup => $"{subject} is stored on filegroup {detail ?? "other than the default"}",
            DependentTypes.Compression => $"{subject} uses {detail ?? "data"} compression",
            DependentTypes.ChangeTracking => $"{table} has change tracking enabled",
            DependentTypes.Cdc => $"{table} is tracked by change data capture (CDC)",
            _ => $"{subject} uses a storage option ({x.Type})",
        };
    }

    // ------------------------------------------------------------------ builders

    public static string ColumnSql(TableModel t, TableColumnModel c, bool withDefault)
    {
        var sb = new StringBuilder(Q(c.Name));
        if (c.Computed is not null)
        {
            sb.Append(" AS (").Append(TableDiff.StripOuterParens(c.Computed.Expression)).Append(')');
            if (c.Computed.Persisted) sb.Append(" PERSISTED").Append(c.Nullable ? "" : " NOT NULL");
            return sb.ToString();
        }
        sb.Append(' ').Append(c.Type.Trim()).Append(Collate(c));
        if (c.Identity is { } id) sb.Append(" IDENTITY(").Append(id.Seed.ToString(CultureInfo.InvariantCulture)).Append(',').Append(id.Increment.ToString(CultureInfo.InvariantCulture)).Append(')');
        sb.Append(c.Nullable ? " NULL" : " NOT NULL");
        if (withDefault && c.Default is not null)
            sb.Append(" CONSTRAINT ").Append(Q(DefaultName(t, c))).Append(" DEFAULT (").Append(TableDiff.StripOuterParens(c.Default)).Append(')');
        return sb.ToString();
    }

    private static string Collate(TableColumnModel c) => string.IsNullOrWhiteSpace(c.Collation) ? "" : " COLLATE " + c.Collation.Trim();

    public static string DefaultName(TableModel t, TableColumnModel c) =>
        string.IsNullOrWhiteSpace(c.DefaultName) ? $"DF_{t.Name}_{c.Name}" : c.DefaultName;

    private static string PrimaryKeySql(TableModel t, PrimaryKeyModel pk) =>
        $"CONSTRAINT {Q(string.IsNullOrWhiteSpace(pk.Name) ? "PK_" + t.Name : pk.Name)} PRIMARY KEY {(pk.Clustered ? "CLUSTERED" : "NONCLUSTERED")} ({string.Join(", ", pk.Columns.Select(Q))})";

    private static string UniqueSql(TableModel t, UniqueModel u) =>
        $"CONSTRAINT {Q(string.IsNullOrWhiteSpace(u.Name) ? $"UQ_{t.Name}_{string.Join("_", u.Columns)}" : u.Name)} UNIQUE ({string.Join(", ", u.Columns.Select(Q))})";

    private static string CheckSql(TableModel t, CheckModel ck, int n) =>
        $"CONSTRAINT {Q(string.IsNullOrWhiteSpace(ck.Name) ? $"CK_{t.Name}_{n}" : ck.Name)} CHECK ({TableDiff.StripOuterParens(ck.Expression)})";

    private static string ForeignKeySql(TableModel t, ForeignKeyModel fk)
    {
        var name = string.IsNullOrWhiteSpace(fk.Name) ? $"FK_{t.Name}_{fk.RefTable}" : fk.Name;
        var refSchema = string.IsNullOrWhiteSpace(fk.RefSchema) ? t.Schema ?? DefaultSchema : fk.RefSchema;
        var sb = new StringBuilder($"CONSTRAINT {Q(name)} FOREIGN KEY ({string.Join(", ", fk.Columns.Select(Q))}) REFERENCES {Table(refSchema, fk.RefTable)}");
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(string.Join(", ", fk.RefColumns.Select(Q))).Append(')');
        var onDelete = Action(fk.OnDelete);
        var onUpdate = Action(fk.OnUpdate);
        if (onDelete != ReferentialActions.NoAction) sb.Append(" ON DELETE ").Append(onDelete);
        if (onUpdate != ReferentialActions.NoAction) sb.Append(" ON UPDATE ").Append(onUpdate);
        return sb.ToString();
    }

    /// <summary>RESTRICT does not exist in T-SQL (NO ACTION is the same behaviour).</summary>
    private static string Action(string? a)
    {
        var n = ReferentialActions.Normalize(a);
        return n == ReferentialActions.Restrict ? ReferentialActions.NoAction : n;
    }

    public static string CreateIndexSql(string table, IndexModel ix)
    {
        var sb = new StringBuilder("CREATE ");
        if (ix.Unique) sb.Append("UNIQUE ");
        sb.Append(ix.Clustered ? "CLUSTERED " : "NONCLUSTERED ");
        sb.Append("INDEX ").Append(Q(ix.Name)).Append(" ON ").Append(table).Append(" (")
            .Append(string.Join(", ", ix.Columns.Select(c => Q(c.Name) + (c.Desc ? " DESC" : " ASC")))).Append(')');
        if (ix.Include.Count > 0) sb.Append(" INCLUDE (").Append(string.Join(", ", ix.Include.Select(Q))).Append(')');
        if (!string.IsNullOrWhiteSpace(ix.Filter)) sb.Append(" WHERE ").Append(TableDiff.StripOuterParens(ix.Filter));
        return sb.ToString();
    }

    private static DdlStatement DropConstraint(string table, string? name, string what, List<string> warnings)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException($"The {what} to drop has no name; reload the table from the server.");
        return new DdlStatement($"ALTER TABLE {table} DROP CONSTRAINT {Q(name)}", DdlKinds.Drop);
    }

    /// <summary>Drops the column's default constraint by name, or by a sys.default_constraints lookup when the name is unknown.</summary>
    private static DdlStatement DropDefault(string table, string schema, string tableName, TableColumnModel c)
    {
        if (!string.IsNullOrWhiteSpace(c.DefaultName))
            return new DdlStatement($"ALTER TABLE {table} DROP CONSTRAINT {Q(c.DefaultName)}", DdlKinds.Drop);
        // Variables are suffixed per column so the whole preview can also run as one batch.
        var v = "@df_" + new string(c.Name.Where(char.IsAsciiLetterOrDigit).ToArray());
        var sql = $"""
            DECLARE {v} sysname = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID({L(Table(schema, tableName))}) AND c.name = {L(c.Name)});
            DECLARE {v}_sql nvarchar(max) = N'ALTER TABLE {Table(schema, tableName).Replace("'", "''")} DROP CONSTRAINT ' + QUOTENAME({v});
            IF {v} IS NOT NULL EXEC sys.sp_executesql {v}_sql;
            """;
        return new DdlStatement(sql, DdlKinds.Drop);
    }

    private static void AddComments(TableModel t, List<DdlStatement> statements)
    {
        var schema = t.Schema ?? DefaultSchema;
        if (!string.IsNullOrWhiteSpace(t.Comment)) statements.Add(CommentSql(schema, t.Name, null, null, t.Comment));
        foreach (var c in t.Columns.Where(c => !string.IsNullOrWhiteSpace(c.Comment)))
            statements.Add(CommentSql(schema, t.Name, c.Name, null, c.Comment));
    }

    private static DdlStatement CommentSql(string schema, string table, string? column, string? oldComment, string? newComment)
    {
        var hadOld = !string.IsNullOrWhiteSpace(oldComment);
        var hasNew = !string.IsNullOrWhiteSpace(newComment);
        var proc = !hasNew ? "sp_dropextendedproperty" : hadOld ? "sp_updateextendedproperty" : "sp_addextendedproperty";
        var sb = new StringBuilder($"EXEC sys.{proc} @name = N'MS_Description'");
        if (hasNew) sb.Append(", @value = ").Append(L(newComment!));
        sb.Append(", @level0type = N'SCHEMA', @level0name = ").Append(L(schema))
            .Append(", @level1type = N'TABLE', @level1name = ").Append(L(table));
        if (column is not null) sb.Append(", @level2type = N'COLUMN', @level2name = ").Append(L(column));
        return new DdlStatement(sb.ToString(), DdlKinds.Comment);
    }

    /// <summary>Warning when an ALTER COLUMN may truncate or convert data.</summary>
    public static string? NarrowingWarning(TableColumnModel oldCol, TableColumnModel newCol)
    {
        if (TableDiff.SameType(oldCol.Type, newCol.Type)) return null;
        var (ob, oa) = DdlText.ParseType(oldCol.Type);
        var (nb, na) = DdlText.ParseType(newCol.Type);
        ob = ob.ToLowerInvariant();
        nb = nb.ToLowerInvariant();
        if (ob == nb)
        {
            if (oa.Count > 0 && na.Count > 0)
            {
                var oMax = oa[0].Equals("max", StringComparison.OrdinalIgnoreCase);
                var nMax = na[0].Equals("max", StringComparison.OrdinalIgnoreCase);
                var o0 = DdlText.ArgInt(oa, 0);
                var n0 = DdlText.ArgInt(na, 0);
                if ((oMax && !nMax) || (o0 is not null && n0 is not null && n0 < o0) || (DdlText.ArgInt(na, 1) < DdlText.ArgInt(oa, 1)))
                    return $"Narrowing {oldCol.Type} to {newCol.Type} may truncate data.";
            }
            return null;
        }
        if (ob is "nvarchar" or "nchar" or "ntext" && nb is "varchar" or "char" or "text")
            return $"Changing {oldCol.Type} to {newCol.Type} may lose characters outside the column's code page.";
        return $"Changing {oldCol.Type} to {newCol.Type} converts existing data; the change fails if a value cannot be converted.";
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
        // Editing the same view (names compare case-insensitively, like the default collation) alters it in place. A new
        // name is a plain CREATE VIEW, so an existing view of that name fails on the server instead of being replaced;
        // a renamed view is created under the new name first and the old one dropped afterwards (same transaction).
        var original = view.OriginalName;
        var editing = original is not null && original.Equals(view.Name, StringComparison.OrdinalIgnoreCase);
        if (editing && !original!.Equals(view.Name, StringComparison.Ordinal))
            statements.Add(new DdlStatement($"EXEC sys.sp_rename {L(Unquoted(schema, original))}, {L(view.Name)}", DdlKinds.Rename)); // case-only rename
        var head = !editing ? "CREATE VIEW" : SupportsCreateOrAlter(context.ServerVersion) ? "CREATE OR ALTER VIEW" : "ALTER VIEW";
        var sb = new StringBuilder().Append(head).Append(' ').Append(Table(schema, view.Name));
        if (view.Options.SchemaBinding) sb.Append("\nWITH SCHEMABINDING");
        sb.Append("\nAS\n").Append(TrimBody(view.Body));
        if (view.Options.CheckOption) sb.Append("\nWITH CHECK OPTION");
        statements.Add(new DdlStatement(sb.ToString(), editing ? DdlKinds.Alter : DdlKinds.Create));
        if (original is not null && !editing)
        {
            statements.Add(new DdlStatement($"DROP VIEW {Table(schema, original)}", DdlKinds.Drop));
            warnings.Add($"{Table(schema, original)} is replaced by a new view {Table(schema, view.Name)}: permissions granted on the old view are not carried over.");
        }
        return new DdlScript(statements, false, true, warnings);
    }

    /// <summary>CREATE OR ALTER exists from SQL Server 2016 SP1 (13.0.4001).</summary>
    public static bool SupportsCreateOrAlter(string? productVersion)
    {
        if (string.IsNullOrWhiteSpace(productVersion) || !Version.TryParse(productVersion.Trim(), out var v)) return true;
        return v.Major > 13 || (v.Major == 13 && v.Build >= 4001);
    }

    public static string TrimBody(string body) => body.Trim().TrimEnd(';').TrimEnd();

    // ------------------------------------------------------------------ names

    private static string Q(string name) => SqlServerNames.Quote(name);
    private static string L(string value) => SqlServerNames.Literal(value);
    public static string Table(string schema, string name) => Q(schema) + "." + Q(name);

    /// <summary>"[dbo].[Customers]" as used by sp_rename's first argument.</summary>
    private static string Unquoted(string schema, string name) => Table(schema, name);
}
