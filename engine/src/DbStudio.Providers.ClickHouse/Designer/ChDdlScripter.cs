using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.ClickHouse.Designer;

/// <summary>
/// MergeTree engine clauses of a table (ENGINE, ORDER BY, PARTITION BY, PRIMARY KEY, SAMPLE BY, TTL, SETTINGS).
/// <para>The model carries them in <c>TableOptions.Extra</c> (<see cref="From"/>); a table without them gets
/// <see cref="Default"/> (MergeTree ordered by the primary key).
/// <see cref="ChDdlScripter.ScriptTable(TableModel?, TableModel, DdlScriptContext, ChEngineOptions?, ChEngineOptions?)"/> takes
/// them explicitly (unit-tested).</para>
/// </summary>
/// <param name="OrderBy">Sorting key expression; null = the primary key columns (or <c>tuple()</c>).</param>
/// <param name="PrimaryKey">Separate PRIMARY KEY expression (a prefix of ORDER BY); null = same as ORDER BY.</param>
public sealed record ChEngineOptions(
    string Engine = "MergeTree",
    string? OrderBy = null,
    string? PartitionBy = null,
    string? PrimaryKey = null,
    string? SampleBy = null,
    string? Ttl = null,
    string? Settings = null)
{
    public static readonly ChEngineOptions Default = new();

    /// <summary>MergeTree family engines take ORDER BY / PARTITION BY / … clauses.</summary>
    public bool IsMergeTree => ChTypes.BaseName(Engine).EndsWith("MergeTree", StringComparison.Ordinal);

    /// <summary>
    /// The options a model carries in <c>Options.Extra</c> ("engine", "orderBy", "partitionBy", "primaryKey", "sampleBy",
    /// "ttl", "settings"); null when it carries none (new tables then get <see cref="Default"/>).
    /// </summary>
    public static ChEngineOptions? From(TableModel model)
    {
        var x = model.Options.Extra;
        if (x is null || x.Count == 0) return null;
        string? Get(string key) => x.FirstOrDefault(kv => kv.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value is { } v && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;
        return new ChEngineOptions(Get("engine") ?? "MergeTree", Get("orderBy"), Get("partitionBy"), Get("primaryKey"), Get("sampleBy"), Get("ttl"), Get("settings"));
    }
}

/// <summary>
/// ClickHouse DDL scripter (plan-batch3 WP-CH). DDL is not transactional (each statement applies on its own).
/// CREATE TABLE with columns (Nullable(T) for nullable columns, DEFAULT / MATERIALIZED / ALIAS, COMMENT), skipping indices
/// (<c>INDEX n expr TYPE minmax GRANULARITY 1</c>, or the TYPE … kept in <see cref="IndexModel.Filter"/>), CHECK constraints and
/// the MergeTree engine clauses. ALTER: RENAME TABLE, ADD/DROP/RENAME/MODIFY COLUMN, COMMENT COLUMN, MODIFY COMMENT,
/// ADD/DROP INDEX (+ MATERIALIZE INDEX for existing data), ADD/DROP CONSTRAINT, MODIFY ORDER BY (new columns only),
/// MODIFY TTL, MODIFY SETTING. ClickHouse has no foreign keys, unique constraints or auto-increment (warnings).
/// </summary>
public sealed class ChDdlScripter : IDdlScripter
{
    public const string DefaultIndexType = "minmax GRANULARITY 1";

    public string ProviderId => "clickhouse";

    public DesignerTypesInfo GetTypes(DdlScriptContext context) => new(
    [
        new("UInt8", "none", "UInt8", "number"), new("UInt16", "none", "UInt16", "number"), new("UInt32", "none", "UInt32", "number"),
        new("UInt64", "none", "UInt64", "number"), new("UInt128", "none", "UInt128", "number"), new("UInt256", "none", "UInt256", "number"),
        new("Int8", "none", "Int8", "number"), new("Int16", "none", "Int16", "number"), new("Int32", "none", "Int32", "number"),
        new("Int64", "none", "Int64", "number"), new("Int128", "none", "Int128", "number"), new("Int256", "none", "Int256", "number"),
        new("Float32", "none", "Float32", "number"), new("Float64", "none", "Float64", "number"),
        new("Decimal", "precisionScale", "Decimal(12, 2)", "number"),
        new("Bool", "none", "Bool", "other"),
        new("String", "none", "String", "string"),
        new("FixedString", "length", "FixedString(16)", "string"),
        new("LowCardinality(String)", "none", "LowCardinality(String)", "string"),
        new("UUID", "none", "UUID", "other"),
        new("Date", "none", "Date", "date"), new("Date32", "none", "Date32", "date"),
        new("DateTime", "none", "DateTime", "date"),
        new("DateTime64", "precision", "DateTime64(3)", "date"),
        new("Enum8", "none", "Enum8('a' = 1, 'b' = 2)", "string"),
        new("IPv4", "none", "IPv4", "other"), new("IPv6", "none", "IPv6", "other"),
        new("Array(String)", "none", "Array(String)", "other"),
        new("Array(UInt64)", "none", "Array(UInt64)", "other"),
        new("Map(String, String)", "none", "Map(String, String)", "other"),
        new("Tuple(String, UInt64)", "none", "Tuple(String, UInt64)", "other"),
        new("JSON", "none", "JSON", "other"),
    ],
    new DesignerFeatures(Identity: false, Computed: true, ClusteredIndexes: false, IncludedColumns: false, FilteredIndexes: false,
        OnUpdateAction: false, Comments: true, RenameColumn: true, DropColumn: true, WithoutRowid: false, Strict: false,
        TransactionalDdl: false, Autoincrement: false, Schemas: true));

    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context) =>
        ScriptTable(original, desired, context, original is null ? null : ChEngineOptions.From(original), ChEngineOptions.From(desired));

    /// <summary>The script with explicit engine options (null = keep / default).</summary>
    public TableScript ScriptTable(TableModel? original, TableModel desired, DdlScriptContext context, ChEngineOptions? originalEngine, ChEngineOptions? desiredEngine)
    {
        ArgumentNullException.ThrowIfNull(desired);
        DesignerValidation.ValidateTable(desired, requireIndexNames: true);
        var schema = desired.Schema ?? original?.Schema ?? context.DefaultSchema;
        desired = desired with { Schema = schema };
        if (original is not null) original = original with { Schema = original.Schema ?? schema };
        var diff = TableDiff.Compute(original, desired);

        var warnings = new List<string>();
        if (diff.ForeignKeysAdded.Count > 0) warnings.Add("ClickHouse has no foreign keys; they are not scripted.");
        if (diff.UniquesAdded.Count > 0) warnings.Add("ClickHouse has no UNIQUE constraints (ReplacingMergeTree deduplicates by the sorting key); they are not scripted.");
        if (desired.Columns.Any(c => c.Identity is not null || c.Autoincrement)) warnings.Add("ClickHouse has no auto-increment columns; identity is ignored (use generateSerialID or UUIDs).");
        if (diff.IndexesAdded.Any(i => i.Unique)) warnings.Add("ClickHouse data skipping indexes are never unique.");
        if (desired.Columns.Any(c => !string.IsNullOrEmpty(c.Collation))) warnings.Add("ClickHouse columns have no collation; it is ignored.");
        var statements = new List<DdlStatement>();
        if (diff.IsCreate)
        {
            statements.Add(new DdlStatement(CreateTable(desired, desiredEngine ?? ChEngineOptions.Default), DdlKinds.Create));
            return new TableScript(statements, false, false, warnings, diff.Changes);
        }

        var orig = original!;
        var table = ChSqlText.Qualified(orig.Schema, orig.Name);
        var newTable = ChSqlText.Qualified(desired.Schema, desired.Name);
        void Alter(string body, string kind, string? warning = null) =>
            statements.Add(new DdlStatement($"ALTER TABLE {newTable} {body}", kind, warning));

        if (diff.TableRenamed) statements.Add(new DdlStatement($"RENAME TABLE {table} TO {newTable}", DdlKinds.Rename));

        // Indexes / constraints that mention a renamed column are dropped before the rename and re-added after it.
        var renamedOld = diff.Renamed.Select(r => r.Old.Name).ToHashSet(StringComparer.Ordinal);
        bool Mentions(string expr) => renamedOld.Any(n => ContainsIdentifier(expr, n));
        var reAddIndexes = orig.Indexes.Where(i => i.Columns.Any(c => renamedOld.Contains(c.Name)) || Mentions(IndexExpression(i)))
            .Select(i => desired.Indexes.FirstOrDefault(d => d.Name.Equals(i.Name, StringComparison.OrdinalIgnoreCase))).Where(i => i is not null).Select(i => i!).ToList();
        var reAddChecks = orig.Checks.Where(c => Mentions(c.Expression))
            .Select(c => desired.Checks.FirstOrDefault(d => string.Equals(d.Name, c.Name, StringComparison.OrdinalIgnoreCase))).Where(c => c is not null).Select(c => c!).ToList();

        var dropIndexes = diff.IndexesDropped.Concat(orig.Indexes.Where(i => reAddIndexes.Any(r => r.Name.Equals(i.Name, StringComparison.OrdinalIgnoreCase))))
            .DistinctBy(i => i.Name, StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var i in dropIndexes) Alter($"DROP INDEX {ChSqlText.Quote(i.Name)}", DdlKinds.Index);
        var dropChecks = diff.ChecksDropped.Concat(orig.Checks.Where(c => reAddChecks.Any(r => string.Equals(r.Name, c.Name, StringComparison.OrdinalIgnoreCase))))
            .Where(c => c.Name is not null).DistinctBy(c => c.Name, StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var c in dropChecks) Alter($"DROP CONSTRAINT {ChSqlText.Quote(c.Name!)}", DdlKinds.Alter);

        foreach (var r in diff.Renamed)
            Alter($"RENAME COLUMN {ChSqlText.Quote(r.Old.Name)} TO {ChSqlText.Quote(r.New.Name)}", DdlKinds.Rename,
                IsKeyColumn(orig, r.Old.Name) ? "ClickHouse cannot rename a column of the sorting key." : null);

        foreach (var d in diff.Dropped)
            Alter($"DROP COLUMN {ChSqlText.Quote(d.Name)}", DdlKinds.Drop,
                IsKeyColumn(orig, d.Name) ? "A column of the sorting key cannot be dropped." : "Dropping a column deletes its data.");

        foreach (var a in diff.Added)
        {
            var index = desired.Columns.IndexOf(a);
            var position = index == 0 ? " FIRST" : $" AFTER {ChSqlText.Quote(desired.Columns[index - 1].Name)}";
            Alter($"ADD COLUMN {ColumnDefinition(a)}{position}", DdlKinds.Alter);
        }

        foreach (var m in diff.Matched.Where(m => m.DefinitionChanged))
        {
            var n = m.New;
            if (m.DefaultChanged && n.Default is null && n.Computed is null && !m.TypeChanged && !m.NullabilityChanged && !m.ComputedChanged)
            {
                Alter($"MODIFY COLUMN {ChSqlText.Quote(n.Name)} REMOVE DEFAULT", DdlKinds.Alter);
                continue;
            }
            if (m.ComputedChanged && n.Computed is null && m.Old.Computed is not null && !m.TypeChanged && !m.NullabilityChanged && n.Default is null)
            {
                Alter($"MODIFY COLUMN {ChSqlText.Quote(n.Name)} REMOVE {(m.Old.Computed.Persisted ? "MATERIALIZED" : "ALIAS")}", DdlKinds.Alter);
                continue;
            }
            Alter($"MODIFY COLUMN {ColumnDefinition(n, includeComment: false)}", DdlKinds.Alter,
                m.TypeChanged || m.NullabilityChanged ? "Changing a column type rewrites the column in every part (a mutation)." : null);
        }

        foreach (var m in diff.Matched.Where(m => m.CommentChanged))
            Alter($"COMMENT COLUMN {ChSqlText.Quote(m.New.Name)} {ChSqlText.Literal(m.New.Comment ?? "")}", DdlKinds.Comment);

        if (diff.ColumnsReordered) warnings.Add("Column order is not changed on an existing table (use MODIFY COLUMN … AFTER manually).");

        if (diff.PrimaryKeyDropped is not null || diff.PrimaryKeyAdded is not null)
        {
            var oldKey = diff.PrimaryKeyDropped?.Columns.Select(c => diff.NewNameOf(c) ?? c).ToList() ?? [];
            var newKey = diff.PrimaryKeyAdded?.Columns ?? desired.PrimaryKey?.Columns ?? [];
            var addedNames = diff.Added.Select(a => a.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (newKey.Count > oldKey.Count && newKey.Take(oldKey.Count).SequenceEqual(oldKey, StringComparer.OrdinalIgnoreCase)
                && newKey.Skip(oldKey.Count).All(addedNames.Contains))
                Alter($"MODIFY ORDER BY {KeyExpression(newKey)}", DdlKinds.Alter);
            else
                warnings.Add("ClickHouse cannot change the sorting key of an existing table except by appending columns added in the same change; recreate the table (CREATE … AS SELECT) to change it.");
        }

        foreach (var c in diff.ChecksAdded.Concat(reAddChecks).DistinctBy(c => c.Name ?? c.Expression, StringComparer.OrdinalIgnoreCase))
            Alter($"ADD CONSTRAINT {ChSqlText.Quote(c.Name ?? ("ck_" + desired.Name))} CHECK {c.Expression}", DdlKinds.Alter,
                "A new CHECK constraint is enforced for inserted rows only; existing rows are not checked.");

        foreach (var i in diff.IndexesAdded.Concat(reAddIndexes).DistinctBy(i => i.Name, StringComparer.OrdinalIgnoreCase))
        {
            Alter($"ADD INDEX {IndexDefinition(i)}", DdlKinds.Index);
            Alter($"MATERIALIZE INDEX {ChSqlText.Quote(i.Name)}", DdlKinds.Index, "Builds the index for existing parts in the background (a mutation).");
        }

        if (diff.CommentChanged) Alter($"MODIFY COMMENT {ChSqlText.Literal(desired.Comment ?? "")}", DdlKinds.Comment);

        if (originalEngine is not null && desiredEngine is not null)
        {
            if (!string.Equals(originalEngine.Ttl ?? "", desiredEngine.Ttl ?? "", StringComparison.Ordinal))
                Alter(string.IsNullOrWhiteSpace(desiredEngine.Ttl) ? "REMOVE TTL" : $"MODIFY TTL {desiredEngine.Ttl}", DdlKinds.Alter);
            if (!string.Equals(originalEngine.Settings ?? "", desiredEngine.Settings ?? "", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(desiredEngine.Settings))
                Alter($"MODIFY SETTING {desiredEngine.Settings}", DdlKinds.Alter);
            if (!string.Equals(originalEngine.Engine, desiredEngine.Engine, StringComparison.Ordinal)
                || !string.Equals(originalEngine.PartitionBy ?? "", desiredEngine.PartitionBy ?? "", StringComparison.Ordinal)
                || !string.Equals(originalEngine.SampleBy ?? "", desiredEngine.SampleBy ?? "", StringComparison.Ordinal))
                warnings.Add("The engine, PARTITION BY and SAMPLE BY of an existing table cannot be altered; recreate the table to change them.");
        }

        return new TableScript(statements, false, false, warnings, diff.Changes);
    }

    private static bool IsKeyColumn(TableModel t, string column) =>
        t.PrimaryKey?.Columns.Contains(column, StringComparer.OrdinalIgnoreCase) == true;

    private static bool ContainsIdentifier(string expr, string name) =>
        DbStudio.Core.Providers.DependencyGraphs.ReferencedNames(expr, DbStudio.Core.Models.Dialect.ClickHouse)
            .Any(r => r.Name.Equals(name, StringComparison.Ordinal));

    public static string CreateTable(TableModel t, ChEngineOptions engine)
    {
        var sb = new StringBuilder();
        sb.Append("CREATE TABLE ").Append(ChSqlText.Qualified(t.Schema, t.Name)).Append("\n(\n");
        var lines = t.Columns.Select(c => "    " + ColumnDefinition(c)).ToList();
        lines.AddRange(t.Indexes.Select(i => "    INDEX " + IndexDefinition(i)));
        lines.AddRange(t.Checks.Select(c => $"    CONSTRAINT {ChSqlText.Quote(c.Name ?? ("ck_" + t.Name))} CHECK {c.Expression}"));
        sb.Append(string.Join(",\n", lines)).Append("\n)\n");
        sb.Append("ENGINE = ").Append(engine.Engine.Contains('(') ? engine.Engine : engine.Engine + (engine.IsMergeTree || engine.Engine is "Memory" or "Log" or "TinyLog" or "StripeLog" ? "" : "()"));
        if (engine.IsMergeTree)
        {
            var key = t.PrimaryKey?.Columns ?? [];
            if (!string.IsNullOrWhiteSpace(engine.PartitionBy)) sb.Append("\nPARTITION BY ").Append(engine.PartitionBy);
            sb.Append("\nORDER BY ").Append(!string.IsNullOrWhiteSpace(engine.OrderBy) ? engine.OrderBy : KeyExpression(key));
            if (!string.IsNullOrWhiteSpace(engine.PrimaryKey)) sb.Append("\nPRIMARY KEY ").Append(engine.PrimaryKey);
            if (!string.IsNullOrWhiteSpace(engine.SampleBy)) sb.Append("\nSAMPLE BY ").Append(engine.SampleBy);
            if (!string.IsNullOrWhiteSpace(engine.Ttl)) sb.Append("\nTTL ").Append(engine.Ttl);
            if (!string.IsNullOrWhiteSpace(engine.Settings)) sb.Append("\nSETTINGS ").Append(engine.Settings);
        }
        if (!string.IsNullOrWhiteSpace(t.Comment)) sb.Append("\nCOMMENT ").Append(ChSqlText.Literal(t.Comment));
        return sb.ToString();
    }

    public static string KeyExpression(IReadOnlyList<string> columns) => columns.Count switch
    {
        0 => "tuple()",
        1 => ChSqlText.Quote(columns[0]),
        _ => "(" + string.Join(", ", columns.Select(ChSqlText.Quote)) + ")",
    };

    /// <summary>Type with the nullability folded in: Nullable(T), LowCardinality(Nullable(T)).</summary>
    public static string ComposeType(string type, bool nullable)
    {
        var t = type.Trim();
        if (!nullable || ChTypes.IsNullable(t)) return t;
        if (ChTypes.Inner(t, "LowCardinality") is { } inner) return $"LowCardinality(Nullable({inner}))";
        var b = ChTypes.BaseName(t);
        // Composite types cannot be Nullable in ClickHouse: keep them as they are.
        if (b is "Array" or "Map" or "Tuple" or "Nested" or "JSON" or "Object") return t;
        return $"Nullable({t})";
    }

    /// <summary>(type without Nullable, nullable) — the inverse of <see cref="ComposeType"/>.</summary>
    public static (string Type, bool Nullable) DecomposeType(string type)
    {
        var t = type.Trim();
        if (ChTypes.Inner(t, "Nullable") is { } n) return (n, true);
        if (ChTypes.Inner(t, "LowCardinality") is { } lc && ChTypes.Inner(lc, "Nullable") is { } ln) return ($"LowCardinality({ln})", true);
        return (t, false);
    }

    public static string ColumnDefinition(TableColumnModel c, bool includeComment = true)
    {
        var sb = new StringBuilder(ChSqlText.Quote(c.Name)).Append(' ').Append(ComposeType(c.Type, c.Nullable));
        if (c.Computed is { } comp) sb.Append(comp.Persisted ? " MATERIALIZED " : " ALIAS ").Append(comp.Expression);
        else if (!string.IsNullOrWhiteSpace(c.Default)) sb.Append(" DEFAULT ").Append(c.Default);
        if (includeComment && !string.IsNullOrWhiteSpace(c.Comment)) sb.Append(" COMMENT ").Append(ChSqlText.Literal(c.Comment));
        return sb.ToString();
    }

    /// <summary>"name expr TYPE minmax GRANULARITY 1": the expression is the column (or a tuple of columns); the TYPE clause comes from <see cref="IndexModel.Filter"/>.</summary>
    public static string IndexDefinition(IndexModel i) =>
        $"{ChSqlText.Quote(i.Name)} {IndexExpression(i)} TYPE {(string.IsNullOrWhiteSpace(i.Filter) ? DefaultIndexType : StripType(i.Filter))}";

    public static string IndexExpression(IndexModel i) => i.Columns.Count == 1
        ? ChSqlText.Quote(i.Columns[0].Name)
        : "(" + string.Join(", ", i.Columns.Select(c => ChSqlText.Quote(c.Name))) + ")";

    private static string StripType(string clause)
    {
        var s = clause.Trim();
        return s.StartsWith("TYPE ", StringComparison.OrdinalIgnoreCase) ? s[5..].Trim() : s;
    }

    public DdlScript ScriptView(ViewDefinition view, DdlScriptContext context)
    {
        ArgumentNullException.ThrowIfNull(view);
        DesignerValidation.ValidateView(view);
        var schema = view.Schema ?? context.DefaultSchema;
        var name = ChSqlText.Qualified(schema, view.Name);
        var body = view.Body.Trim().TrimEnd(';').TrimEnd();
        var statements = new List<DdlStatement>();
        var renamed = view.OriginalName is not null && !view.OriginalName.Equals(view.Name, StringComparison.Ordinal);
        if (renamed) statements.Add(new DdlStatement($"DROP VIEW IF EXISTS {ChSqlText.Qualified(schema, view.OriginalName!)}", DdlKinds.Drop));
        statements.Add(new DdlStatement($"CREATE OR REPLACE VIEW {name} AS\n{body}", DdlKinds.Create));
        return new DdlScript(statements, false, false, []);
    }
}
