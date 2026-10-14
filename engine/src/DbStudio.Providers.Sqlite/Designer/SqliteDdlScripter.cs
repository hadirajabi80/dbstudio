using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Sqlite.Designer;

/// <summary>
/// SQLite DDL scripter (docs/PLAN-M1.5.md 1.3.1). Uses native <c>ALTER TABLE</c> only for RENAME TO, RENAME COLUMN
/// (3.25+), ADD COLUMN (no PK/UNIQUE, constant default, appended at the end) and DROP COLUMN (3.35+, unreferenced
/// columns), plus CREATE/DROP INDEX. Everything else is the documented table rebuild: foreign keys off, new table,
/// copy, drop, rename, recreate indexes, triggers and dependent views, <c>PRAGMA foreign_key_check</c>, foreign keys on.
/// All statements run in one transaction (the PRAGMAs are handled outside it by the apply step).
/// </summary>
public sealed partial class SqliteDdlScripter : IDdlScripter
{
    public const string RebuildSuffix = "__new";
    public const string MainSchema = "main";

    public string ProviderId => "sqlite";

    public DesignerTypesInfo GetTypes(DdlScriptContext context)
    {
        var v = ParseVersion(context.ServerVersion);
        return new DesignerTypesInfo(
        [
            new("INTEGER", "none", "INTEGER", "number"),
            new("REAL", "none", "REAL", "number"),
            new("NUMERIC", "precisionScale", "NUMERIC(10,2)", "number"),
            new("TEXT", "none", "TEXT", "string"),
            new("BLOB", "none", "BLOB", "binary"),
            new("BOOLEAN", "none", "BOOLEAN", "number"),
            new("DATE", "none", "DATE", "date"),
            new("DATETIME", "none", "DATETIME", "date"),
            new("VARCHAR", "length", "VARCHAR(100)", "string"),
            new("DECIMAL", "precisionScale", "DECIMAL(12,2)", "number"),
            new("ANY", "none", "ANY", "other"),
        ],
        new DesignerFeatures(
            Identity: false, Computed: v >= new Version(3, 31), ClusteredIndexes: false, IncludedColumns: false,
            FilteredIndexes: true, OnUpdateAction: true, Comments: false, RenameColumn: v >= new Version(3, 25),
            DropColumn: v >= new Version(3, 35), WithoutRowid: true, Strict: v >= new Version(3, 37), TransactionalDdl: true,
            Autoincrement: true, Schemas: false));
    }

    // ------------------------------------------------------------------ tables

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(desired);
        var warnings = new List<string>();
        CollectModelWarnings(desired, warnings);
        desired = Normalize(desired);
        DesignerValidation.ValidateTable(desired);
        var diff = TableDiff.Compute(original is null ? null : Normalize(original), desired);
        var statements = new List<DdlStatement>();

        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTableSql(desired, Qualified(desired.Schema, desired.Name)), DdlKinds.Create));
            foreach (var ix in desired.Indexes) statements.Add(new DdlStatement(CreateIndexSql(desired.Schema, desired.Name, ix), DdlKinds.Index));
            return new TableScript(statements, false, true, warnings, diff.Changes);
        }
        if (diff.IsEmpty) return new TableScript([], false, true, warnings, diff.Changes);

        var version = ParseVersion(context.ServerVersion);
        var rebuildReasons = RebuildReasons(diff, version, context);
        if (rebuildReasons.Count == 0)
        {
            ScriptNative(diff, statements, warnings);
            return new TableScript(statements, false, true, warnings, diff.Changes);
        }

        ScriptRebuild(diff, context, statements, warnings);
        warnings.Insert(0, "SQLite cannot alter this in place (" + string.Join("; ", rebuildReasons) + "): the table is rebuilt and its data copied.");
        return new TableScript(statements, true, true, warnings, diff.Changes);
    }

    /// <summary>Drops what SQLite cannot represent so it never shows up as a change (comments, clustering, identity).</summary>
    public static TableModel Normalize(TableModel t) => t with
    {
        Comment = null,
        Options = t.Options with { Tablespace = null },
        Columns = t.Columns.Select(c => c with
        {
            Comment = null,
            DefaultName = null,
            Identity = null,
            Autoincrement = c.Autoincrement || (c.Identity is not null && IsAutoincrementCandidate(t, c)),
        }).ToList(),
        PrimaryKey = t.PrimaryKey is { Columns.Count: > 0 } pk ? pk with { Clustered = true } : null,
        Indexes = t.Indexes.Select(i => i with { Clustered = false, Include = [] }).ToList(),
    };

    private static void CollectModelWarnings(TableModel t, List<string> warnings)
    {
        if (!string.IsNullOrWhiteSpace(t.Comment) || t.Columns.Any(c => !string.IsNullOrWhiteSpace(c.Comment)))
            warnings.Add("SQLite does not store table or column comments; they are ignored.");
        if (t.Columns.Any(c => c.Identity is not null && !IsAutoincrementCandidate(t, c)))
            warnings.Add("SQLite has no identity columns; use a single INTEGER PRIMARY KEY (optionally AUTOINCREMENT).");
        if (t.Indexes.Any(i => i.Clustered || i.Include.Count > 0) || t.PrimaryKey is { Clustered: false })
            warnings.Add("SQLite ignores clustered/included-column index options.");
        if (!string.IsNullOrWhiteSpace(t.Options.Tablespace)) warnings.Add("SQLite has no tablespaces; the option is ignored.");
    }

    private static List<string> RebuildReasons(TableDiffResult d, Version version, DdlScriptContext context)
    {
        var reasons = new List<string>();
        var original = d.Original!;
        if (d.OptionsChanged) reasons.Add("table options changed");
        if (d.ColumnsReordered) reasons.Add("column order changed");
        foreach (var m in d.Redefined) reasons.Add($"column {m.New.Name} changed");
        if (d.PrimaryKeyAdded is not null || d.PrimaryKeyDropped is not null) reasons.Add("primary key changed");
        if (d.UniquesAdded.Count + d.UniquesDropped.Count > 0) reasons.Add("unique constraints changed");
        if (d.ForeignKeysAdded.Count + d.ForeignKeysDropped.Count > 0) reasons.Add("foreign keys changed");
        if (d.ChecksAdded.Count + d.ChecksDropped.Count > 0) reasons.Add("check constraints changed");
        if (d.Renamed.Any() && version < new Version(3, 25)) reasons.Add("RENAME COLUMN needs SQLite 3.25");

        // Added columns must be appendable at the end with ALTER TABLE ADD COLUMN.
        if (d.Added.Count > 0)
        {
            var tail = d.Desired.Columns.Skip(d.Desired.Columns.Count - d.Added.Count).ToList();
            if (!tail.SequenceEqual(d.Added)) reasons.Add("new columns are not at the end");
            foreach (var a in d.Added)
                if (!CanAddNatively(d.Desired, a)) reasons.Add($"column {a.Name} cannot be added with ALTER TABLE");
        }
        foreach (var dropped in d.Dropped)
        {
            if (version < new Version(3, 35)) { reasons.Add("DROP COLUMN needs SQLite 3.35"); break; }
            if (IsReferenced(original, dropped.Name, context)) reasons.Add($"column {dropped.Name} is used by a key, index, constraint, trigger or view");
        }
        return reasons.Distinct().ToList();
    }

    private static bool CanAddNatively(TableModel desired, TableColumnModel c)
    {
        if (desired.PrimaryKey?.Columns.Contains(c.Name, StringComparer.OrdinalIgnoreCase) == true) return false;
        if (desired.Uniques.Any(u => u.Columns.Contains(c.Name, StringComparer.OrdinalIgnoreCase))) return false;
        if (c.Autoincrement || c.Computed is { Persisted: true }) return false;
        var def = c.Default?.Trim();
        if (!string.IsNullOrEmpty(def))
        {
            if (def.StartsWith('(')) return false;
            if (def.ToUpperInvariant() is "CURRENT_TIME" or "CURRENT_DATE" or "CURRENT_TIMESTAMP") return false;
        }
        if (!c.Nullable && string.IsNullOrEmpty(def) && c.Computed is null) return false;
        return true;
    }

    /// <summary>True when DROP COLUMN would fail: the column is part of a key/index/FK/check or used by a trigger/view.</summary>
    private static bool IsReferenced(TableModel original, string column, DdlScriptContext context)
    {
        bool In(IEnumerable<string> cols) => cols.Contains(column, StringComparer.OrdinalIgnoreCase);
        if (original.PrimaryKey is { } pk && In(pk.Columns)) return true;
        if (original.Uniques.Any(u => In(u.Columns))) return true;
        if (original.Indexes.Any(i => In(i.Columns.Select(c => c.Name)) || MentionsWord(i.Filter, column))) return true;
        if (original.ForeignKeys.Any(f => In(f.Columns))) return true;
        if (original.Checks.Any(c => MentionsWord(c.Expression, column))) return true;
        if (original.Columns.Any(c => c.Computed is not null && MentionsWord(c.Computed.Expression, column))) return true;
        return (context.Dependents ?? []).Any(dep => dep.Type is "trigger" or "view" && MentionsWord(dep.Sql, column));
    }

    private static bool MentionsWord(string? text, string word) =>
        !string.IsNullOrEmpty(text) && Regex.IsMatch(text, @"(?<![\w$])" + Regex.Escape(word) + @"(?![\w$])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static void ScriptNative(TableDiffResult d, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var schema = d.Desired.Schema ?? original.Schema;
        var table = original.Name;
        if (d.TableRenamed && !original.Name.Equals(d.Desired.Name, StringComparison.Ordinal))
        {
            statements.Add(new DdlStatement($"ALTER TABLE {Qualified(schema, table)} RENAME TO {Quote(d.Desired.Name)}", DdlKinds.Rename));
            table = d.Desired.Name;
        }
        var target = Qualified(schema, table);
        foreach (var m in d.Renamed)
            statements.Add(new DdlStatement($"ALTER TABLE {target} RENAME COLUMN {Quote(m.Old.Name)} TO {Quote(m.New.Name)}", DdlKinds.Rename));
        foreach (var ix in d.IndexesDropped)
            statements.Add(new DdlStatement($"DROP INDEX {Qualified(schema, ix.Name)}", DdlKinds.Drop));
        foreach (var c in d.Dropped)
            statements.Add(new DdlStatement($"ALTER TABLE {target} DROP COLUMN {Quote(c.Name)}", DdlKinds.Drop, $"Dropping column {c.Name} deletes its data."));
        foreach (var c in d.Added)
            statements.Add(new DdlStatement($"ALTER TABLE {target} ADD COLUMN {ColumnSql(d.Desired, c, inlinePk: false)}", DdlKinds.Alter));
        foreach (var ix in d.IndexesAdded)
            statements.Add(new DdlStatement(CreateIndexSql(schema, table, ix), DdlKinds.Index));
        if (d.Matched.Any(m => m.CommentChanged) || d.CommentChanged)
            warnings.Add("SQLite does not store comments; comment changes are ignored.");
    }

    private void ScriptRebuild(TableDiffResult d, DdlScriptContext context, List<DdlStatement> statements, List<string> warnings)
    {
        var original = d.Original!;
        var desired = d.Desired;
        var schema = desired.Schema ?? original.Schema;
        var temp = desired.Name + RebuildSuffix;
        var dependents = context.Dependents ?? [];

        // Objects SQLite drops with the table (its triggers) or that would break the RENAME (views/triggers referencing it).
        var triggersOnTable = dependents.Where(x => x.Type == "trigger" && x.OnTable).ToList();
        var referencing = dependents.Where(x => !x.OnTable && x.Type is "view" or "trigger").ToList();

        statements.Add(new DdlStatement("PRAGMA foreign_keys = OFF", DdlKinds.Pragma));
        foreach (var dep in referencing)
            statements.Add(new DdlStatement($"DROP {(dep.Type == "view" ? "VIEW" : "TRIGGER")} IF EXISTS {Qualified(schema, dep.Name)}", DdlKinds.Drop));
        statements.Add(new DdlStatement(CreateTableSql(desired, Qualified(schema, temp)), DdlKinds.Rebuild));

        var copy = d.Matched.Where(m => m.New.Computed is null && m.Old.Computed is null).ToList();
        if (copy.Count > 0)
        {
            var targetCols = string.Join(", ", copy.Select(m => Quote(m.New.Name)));
            var sourceCols = string.Join(", ", copy.Select(m => Quote(m.Old.Name)));
            string? warning = null;
            var tightened = copy.Where(m => m.NullabilityChanged && !m.New.Nullable).Select(m => m.New.Name).ToList();
            if (tightened.Count > 0) warning = $"Rows with NULL in {string.Join(", ", tightened)} make the copy fail.";
            statements.Add(new DdlStatement($"INSERT INTO {Qualified(schema, temp)} ({targetCols})\nSELECT {sourceCols}\nFROM {Qualified(schema, original.Name)}", DdlKinds.Rebuild, warning));
        }
        foreach (var c in d.Dropped)
            warnings.Add($"Column {c.Name} is dropped with its data.");
        statements.Add(new DdlStatement($"DROP TABLE {Qualified(schema, original.Name)}", DdlKinds.Rebuild));
        statements.Add(new DdlStatement($"ALTER TABLE {Qualified(schema, temp)} RENAME TO {Quote(desired.Name)}", DdlKinds.Rebuild));
        foreach (var ix in desired.Indexes)
            statements.Add(new DdlStatement(CreateIndexSql(schema, desired.Name, ix), DdlKinds.Index));

        var renames = d.Renames;
        var tableRenamed = !original.Name.Equals(desired.Name, StringComparison.OrdinalIgnoreCase);
        foreach (var trg in triggersOnTable)
        {
            var sql = RewriteReferences(trg.Sql, original.Name, desired.Name, renames);
            var warn = UsesDroppedColumn(trg.Sql, d) ? $"Trigger {trg.Name} uses a dropped column and will fail when it fires." : null;
            statements.Add(new DdlStatement(sql, DdlKinds.Create, warn));
        }
        foreach (var dep in referencing)
        {
            var sql = RewriteReferences(dep.Sql, original.Name, desired.Name, renames);
            var warn = UsesDroppedColumn(dep.Sql, d) ? $"{(dep.Type == "view" ? "View" : "Trigger")} {dep.Name} uses a dropped column." : null;
            statements.Add(new DdlStatement(sql, DdlKinds.Create, warn));
        }
        if (tableRenamed && (triggersOnTable.Count > 0 || referencing.Count > 0))
            warnings.Add("Triggers and views were recreated with the new table name; review their text in the preview.");

        statements.Add(new DdlStatement("PRAGMA foreign_key_check", DdlKinds.Pragma));
        statements.Add(new DdlStatement("PRAGMA foreign_keys = ON", DdlKinds.Pragma));
    }

    private static bool UsesDroppedColumn(string sql, TableDiffResult d) => d.Dropped.Any(c => MentionsWord(sql, c.Name));

    /// <summary>Applies the table rename and column renames to a dependent object's SQL (identifier tokens only).</summary>
    internal static string RewriteReferences(string sql, string oldTable, string newTable, IReadOnlyDictionary<string, string> columnRenames)
    {
        var map = new Dictionary<string, string>(columnRenames, StringComparer.OrdinalIgnoreCase);
        if (!oldTable.Equals(newTable, StringComparison.OrdinalIgnoreCase)) map[oldTable] = newTable;
        return map.Count == 0 ? sql : TableDiff.RenameInExpression(sql, map);
    }

    // ------------------------------------------------------------------ SQL builders

    public static string CreateTableSql(TableModel t, string qualifiedName)
    {
        var sb = new StringBuilder();
        sb.Append("CREATE TABLE ").Append(qualifiedName).Append(" (");
        var parts = new List<string>();
        var pk = t.PrimaryKey is { Columns.Count: > 0 } ? t.PrimaryKey : null;
        // AUTOINCREMENT is only valid on a column constraint: INTEGER [CONSTRAINT n] PRIMARY KEY AUTOINCREMENT.
        var inlinePkColumn = pk is { Columns.Count: 1 }
                             && t.Column(pk.Columns[0]) is { } pkc && (pkc.Autoincrement || pkc.Identity is not null) && IsIntegerType(pkc.Type)
            ? pk.Columns[0] : null;
        foreach (var c in t.Columns)
            parts.Add(ColumnSql(t, c, inlinePk: inlinePkColumn is not null && c.Name.Equals(inlinePkColumn, StringComparison.OrdinalIgnoreCase)));
        if (pk is not null && inlinePkColumn is null)
            parts.Add($"{Constraint(pk.Name)}PRIMARY KEY ({string.Join(", ", pk.Columns.Select(Quote))})");
        foreach (var u in t.Uniques)
            parts.Add($"{Constraint(u.Name)}UNIQUE ({string.Join(", ", u.Columns.Select(Quote))})");
        foreach (var ck in t.Checks)
            parts.Add($"{Constraint(ck.Name)}CHECK ({TableDiff.StripOuterParens(ck.Expression)})");
        foreach (var fk in t.ForeignKeys)
            parts.Add(ForeignKeySql(fk));
        sb.Append('\n').Append(string.Join(",\n", parts.Select(p => "    " + p))).Append('\n').Append(')');
        var options = new List<string>();
        if (t.Options.WithoutRowid) options.Add("WITHOUT ROWID");
        if (t.Options.Strict) options.Add("STRICT");
        if (options.Count > 0) sb.Append(' ').Append(string.Join(", ", options));
        return sb.ToString();
    }

    private static string ForeignKeySql(ForeignKeyModel fk)
    {
        var sb = new StringBuilder();
        sb.Append(Constraint(fk.Name)).Append("FOREIGN KEY (").Append(string.Join(", ", fk.Columns.Select(Quote))).Append(") REFERENCES ")
            .Append(Quote(fk.RefTable));
        if (fk.RefColumns.Count > 0) sb.Append(" (").Append(string.Join(", ", fk.RefColumns.Select(Quote))).Append(')');
        var onDelete = ReferentialActions.Normalize(fk.OnDelete);
        var onUpdate = ReferentialActions.Normalize(fk.OnUpdate);
        if (onDelete != ReferentialActions.NoAction) sb.Append(" ON DELETE ").Append(onDelete);
        if (onUpdate != ReferentialActions.NoAction) sb.Append(" ON UPDATE ").Append(onUpdate);
        return sb.ToString();
    }

    private static string Constraint(string? name) => string.IsNullOrWhiteSpace(name) ? "" : $"CONSTRAINT {Quote(name)} ";

    public static string ColumnSql(TableModel t, TableColumnModel c, bool inlinePk)
    {
        var sb = new StringBuilder(Quote(c.Name));
        if (!string.IsNullOrWhiteSpace(c.Type)) sb.Append(' ').Append(c.Type.Trim());
        if (inlinePk)
        {
            sb.Append(' ').Append(Constraint(t.PrimaryKey?.Name)).Append("PRIMARY KEY");
            if (c.Autoincrement || c.Identity is not null) sb.Append(" AUTOINCREMENT");
        }
        if (!c.Nullable && c.Computed is null) sb.Append(" NOT NULL");
        if (!string.IsNullOrWhiteSpace(c.Collation)) sb.Append(" COLLATE ").Append(c.Collation.Trim());
        if (c.Computed is not null)
        {
            sb.Append(" GENERATED ALWAYS AS (").Append(TableDiff.StripOuterParens(c.Computed.Expression)).Append(')')
                .Append(c.Computed.Persisted ? " STORED" : " VIRTUAL");
        }
        else if (!string.IsNullOrWhiteSpace(c.Default))
        {
            sb.Append(" DEFAULT ").Append(DefaultSql(c.Default));
        }
        return sb.ToString();
    }

    /// <summary>Literals and CURRENT_* go verbatim; any other expression is parenthesized as SQLite requires.</summary>
    public static string DefaultSql(string expression)
    {
        var e = expression.Trim();
        if (e.StartsWith('(')) return e;
        if (LiteralDefault().IsMatch(e)) return e;
        return "(" + e + ")";
    }

    [GeneratedRegex(@"^(?:[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|'(?:[^']|'')*'|[xX]'[0-9a-fA-F]*'|NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$", RegexOptions.IgnoreCase)]
    private static partial Regex LiteralDefault();

    public static string CreateIndexSql(string? schema, string table, IndexModel ix)
    {
        var cols = string.Join(", ", ix.Columns.Select(c => Quote(c.Name) + (c.Desc ? " DESC" : "")));
        var sql = $"CREATE {(ix.Unique ? "UNIQUE " : "")}INDEX {Qualified(schema, ix.Name)} ON {Quote(table)} ({cols})";
        if (!string.IsNullOrWhiteSpace(ix.Filter)) sql += " WHERE " + TableDiff.StripOuterParens(ix.Filter);
        return sql;
    }

    private static bool IsAutoincrementCandidate(TableModel t, TableColumnModel c) =>
        IsIntegerType(c.Type) && t.PrimaryKey is { Columns.Count: 1 } pk && pk.Columns[0].Equals(c.Name, StringComparison.OrdinalIgnoreCase);

    public static bool IsIntegerType(string? type) => string.Equals(type?.Trim(), "INTEGER", StringComparison.OrdinalIgnoreCase);

    // ------------------------------------------------------------------ views

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var warnings = new List<string>();
        if (view.Options.SchemaBinding) warnings.Add("SQLite has no schema-bound views; the option is ignored.");
        if (view.Options.CheckOption) warnings.Add("SQLite has no WITH CHECK OPTION; the option is ignored.");
        var statements = new List<DdlStatement>();
        var schema = view.Schema;
        if (!string.IsNullOrWhiteSpace(view.OriginalName))
            statements.Add(new DdlStatement($"DROP VIEW IF EXISTS {Qualified(schema, view.OriginalName)}", DdlKinds.Drop));
        if (!string.Equals(view.OriginalName, view.Name, StringComparison.OrdinalIgnoreCase))
            statements.Add(new DdlStatement($"DROP VIEW IF EXISTS {Qualified(schema, view.Name)}", DdlKinds.Drop));
        statements.Add(new DdlStatement($"CREATE VIEW {Qualified(schema, view.Name)} AS\n{TrimBody(view.Body)}", DdlKinds.Create));
        return new DdlScript(statements, false, true, warnings);
    }

    public static string TrimBody(string body) => body.Trim().TrimEnd(';').TrimEnd();

    // ------------------------------------------------------------------ names

    public static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    public static string Qualified(string? schema, string name) =>
        string.IsNullOrWhiteSpace(schema) || schema.Equals(MainSchema, StringComparison.OrdinalIgnoreCase)
            ? Quote(name)
            : Quote(schema) + "." + Quote(name);

    public static Version ParseVersion(string? text)
    {
        if (!string.IsNullOrWhiteSpace(text))
        {
            var m = Regex.Match(text, @"(\d+)\.(\d+)(?:\.(\d+))?");
            if (m.Success)
                return new Version(int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture),
                    m.Groups[3].Success ? int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture) : 0);
        }
        return new Version(3, 45, 0); // the bundled e_sqlite3 is newer than every feature threshold
    }
}
