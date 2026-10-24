using System.Text;

namespace DbStudio.Core.Designer;

/// <summary>One entry of the change list shown by the designer (ui/src/api/types.ts TableChangeKind).</summary>
public sealed record TableChange(string Kind, string Target, string? Detail = null);

public static class TableChangeKinds
{
    public const string TableRenamed = "tableRenamed", TableCommentChanged = "tableCommentChanged", OptionsChanged = "optionsChanged",
        ColumnAdded = "columnAdded", ColumnDropped = "columnDropped", ColumnRenamed = "columnRenamed",
        ColumnTypeChanged = "columnTypeChanged", ColumnNullabilityChanged = "columnNullabilityChanged",
        ColumnDefaultChanged = "columnDefaultChanged", ColumnIdentityChanged = "columnIdentityChanged",
        ColumnComputedChanged = "columnComputedChanged", ColumnCollationChanged = "columnCollationChanged",
        ColumnCommentChanged = "columnCommentChanged", ColumnsReordered = "columnsReordered",
        PrimaryKeyAdded = "primaryKeyAdded", PrimaryKeyDropped = "primaryKeyDropped", UniqueAdded = "uniqueAdded",
        UniqueDropped = "uniqueDropped", IndexAdded = "indexAdded", IndexDropped = "indexDropped",
        ForeignKeyAdded = "foreignKeyAdded", ForeignKeyDropped = "foreignKeyDropped", CheckAdded = "checkAdded", CheckDropped = "checkDropped";
}

/// <summary>A column present in both models (possibly renamed) and what changed about it.</summary>
public sealed record ColumnDelta(TableColumnModel Old, TableColumnModel New)
{
    public bool Renamed => !Old.Name.Equals(New.Name, StringComparison.Ordinal);
    public bool TypeChanged => !TableDiff.SameType(Old.Type, New.Type);
    public bool NullabilityChanged => Old.Nullable != New.Nullable;
    public bool DefaultChanged => !TableDiff.SameExpression(Old.Default, New.Default);
    public bool IdentityChanged => !Equals(Old.Identity, New.Identity);
    public bool ComputedChanged => !TableDiff.SameComputed(Old.Computed, New.Computed);
    public bool CollationChanged => !TableDiff.SameText(Old.Collation, New.Collation);
    public bool CommentChanged => !string.Equals(TableDiff.Blank(Old.Comment), TableDiff.Blank(New.Comment), StringComparison.Ordinal);
    public bool AutoincrementChanged => Old.Autoincrement != New.Autoincrement;

    /// <summary>Anything beyond name and comment changed.</summary>
    public bool DefinitionChanged => TypeChanged || NullabilityChanged || DefaultChanged || IdentityChanged || ComputedChanged
                                     || CollationChanged || AutoincrementChanged;

    public bool AnyChange => Renamed || DefinitionChanged || CommentChanged;
}

/// <summary>Result of <see cref="TableDiff.Compute"/>.</summary>
public sealed class TableDiffResult
{
    public TableModel? Original { get; init; }
    public required TableModel Desired { get; init; }
    public bool IsCreate => Original is null;

    public bool TableRenamed { get; init; }
    public bool CommentChanged { get; init; }
    public bool OptionsChanged { get; init; }
    public bool ColumnsReordered { get; init; }

    /// <summary>Matched columns in desired order.</summary>
    public IReadOnlyList<ColumnDelta> Matched { get; init; } = [];
    public IReadOnlyList<TableColumnModel> Added { get; init; } = [];
    public IReadOnlyList<TableColumnModel> Dropped { get; init; } = [];

    public PrimaryKeyModel? PrimaryKeyDropped { get; init; }
    public PrimaryKeyModel? PrimaryKeyAdded { get; init; }
    public IReadOnlyList<UniqueModel> UniquesDropped { get; init; } = [];
    public IReadOnlyList<UniqueModel> UniquesAdded { get; init; } = [];
    public IReadOnlyList<IndexModel> IndexesDropped { get; init; } = [];
    public IReadOnlyList<IndexModel> IndexesAdded { get; init; } = [];
    public IReadOnlyList<ForeignKeyModel> ForeignKeysDropped { get; init; } = [];
    public IReadOnlyList<ForeignKeyModel> ForeignKeysAdded { get; init; } = [];
    public IReadOnlyList<CheckModel> ChecksDropped { get; init; } = [];
    public IReadOnlyList<CheckModel> ChecksAdded { get; init; } = [];

    public IReadOnlyList<TableChange> Changes { get; init; } = [];

    /// <summary>Old → new column names of renamed columns (case-insensitive keys).</summary>
    public IReadOnlyDictionary<string, string> Renames { get; init; } = new Dictionary<string, string>();

    public bool IsEmpty => !IsCreate && Changes.Count == 0;

    public IEnumerable<ColumnDelta> Renamed => Matched.Where(m => m.Renamed);
    public IEnumerable<ColumnDelta> Redefined => Matched.Where(m => m.DefinitionChanged);

    /// <summary>The desired name of an original column (after renames), or null when it was dropped.</summary>
    public string? NewNameOf(string originalColumn) =>
        Matched.FirstOrDefault(m => m.Old.Name.Equals(originalColumn, StringComparison.OrdinalIgnoreCase))?.New.Name;
}

/// <summary>
/// Structural diff of two table models (docs/PLAN-M1.5.md 1.3.1): columns are matched by <c>id</c> (= original name)
/// first, then by name; constraints and indexes by structure (after applying column renames) and name — a changed
/// constraint is a drop plus an add. Provider scripters turn the result into DDL.
/// </summary>
public static partial class TableDiff
{
    public static TableDiffResult Compute(TableModel? original, TableModel desired)
    {
        ArgumentNullException.ThrowIfNull(desired);
        if (original is null)
        {
            return new TableDiffResult
            {
                Desired = desired,
                Added = desired.Columns,
                PrimaryKeyAdded = desired.PrimaryKey is { Columns.Count: > 0 } ? desired.PrimaryKey : null,
                UniquesAdded = desired.Uniques,
                IndexesAdded = desired.Indexes,
                ForeignKeysAdded = desired.ForeignKeys,
                ChecksAdded = desired.Checks,
            };
        }

        var changes = new List<TableChange>();
        var tableRenamed = !original.Name.Equals(desired.Name, StringComparison.Ordinal)
                           || !SameText(original.Schema, desired.Schema) && desired.Schema is not null && original.Schema is not null;
        if (tableRenamed) changes.Add(new(TableChangeKinds.TableRenamed, desired.Name, $"{original.Name} → {desired.Name}"));
        var commentChanged = !string.Equals(Blank(original.Comment), Blank(desired.Comment), StringComparison.Ordinal);
        if (commentChanged) changes.Add(new(TableChangeKinds.TableCommentChanged, desired.Name));
        var optionsChanged = original.Options.WithoutRowid != desired.Options.WithoutRowid || original.Options.Strict != desired.Options.Strict
                             || !SameText(original.Options.Tablespace, desired.Options.Tablespace) && desired.Options.Tablespace is not null
                             || !SameExtra(original.Options.Extra, desired.Options.Extra);
        if (optionsChanged) changes.Add(new(TableChangeKinds.OptionsChanged, desired.Name));

        // ---- columns
        var remaining = original.Columns.ToList();
        var matched = new List<ColumnDelta>();
        var added = new List<TableColumnModel>();
        var pending = new List<TableColumnModel>();
        foreach (var col in desired.Columns)
        {
            if (!string.IsNullOrWhiteSpace(col.Id))
            {
                var byId = remaining.FirstOrDefault(o => o.Name.Equals(col.Id, StringComparison.OrdinalIgnoreCase));
                if (byId is not null)
                {
                    remaining.Remove(byId);
                    matched.Add(new ColumnDelta(byId, col));
                    continue;
                }
            }
            pending.Add(col);
        }
        foreach (var col in pending)
        {
            // An id that matched nothing marks a new column (the UI gives new columns fresh ids); else match by name.
            var byName = remaining.FirstOrDefault(o => o.Name.Equals(col.Name, StringComparison.OrdinalIgnoreCase));
            if (byName is not null && (string.IsNullOrWhiteSpace(col.Id) || col.Id.Equals(col.Name, StringComparison.OrdinalIgnoreCase)
                                       || !original.Columns.Any(o => o.Name.Equals(col.Id, StringComparison.OrdinalIgnoreCase))))
            {
                remaining.Remove(byName);
                matched.Add(new ColumnDelta(byName, col));
            }
            else
            {
                added.Add(col);
            }
        }
        // Keep matched in desired order.
        matched = desired.Columns.Select(c => matched.FirstOrDefault(m => ReferenceEquals(m.New, c))).Where(m => m is not null).Select(m => m!).ToList();
        var dropped = remaining;

        var renames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var m in matched)
        {
            if (m.Renamed) { renames[m.Old.Name] = m.New.Name; changes.Add(new(TableChangeKinds.ColumnRenamed, m.New.Name, $"{m.Old.Name} → {m.New.Name}")); }
            if (m.TypeChanged) changes.Add(new(TableChangeKinds.ColumnTypeChanged, m.New.Name, $"{m.Old.Type} → {m.New.Type}"));
            if (m.NullabilityChanged) changes.Add(new(TableChangeKinds.ColumnNullabilityChanged, m.New.Name, m.New.Nullable ? "NULL" : "NOT NULL"));
            if (m.DefaultChanged) changes.Add(new(TableChangeKinds.ColumnDefaultChanged, m.New.Name, m.New.Default ?? "(none)"));
            if (m.IdentityChanged || m.AutoincrementChanged) changes.Add(new(TableChangeKinds.ColumnIdentityChanged, m.New.Name));
            if (m.ComputedChanged) changes.Add(new(TableChangeKinds.ColumnComputedChanged, m.New.Name));
            if (m.CollationChanged) changes.Add(new(TableChangeKinds.ColumnCollationChanged, m.New.Name, m.New.Collation));
            if (m.CommentChanged) changes.Add(new(TableChangeKinds.ColumnCommentChanged, m.New.Name));
        }
        foreach (var a in added) changes.Add(new(TableChangeKinds.ColumnAdded, a.Name, a.Type));
        foreach (var d in dropped) changes.Add(new(TableChangeKinds.ColumnDropped, d.Name));

        var originalOrder = original.Columns.Where(o => matched.Any(m => ReferenceEquals(m.Old, o))).ToList();
        var reordered = !matched.Select(m => m.Old).SequenceEqual(originalOrder);
        if (reordered) changes.Add(new(TableChangeKinds.ColumnsReordered, desired.Name));

        string Map(string c) => renames.TryGetValue(c, out var n) ? n : c;
        List<string> MapAll(IEnumerable<string> cols) => cols.Select(Map).ToList();

        // ---- primary key
        PrimaryKeyModel? pkDropped = null, pkAdded = null;
        var oPk = original.PrimaryKey is { Columns.Count: > 0 } ? original.PrimaryKey : null;
        var dPk = desired.PrimaryKey is { Columns.Count: > 0 } ? desired.PrimaryKey : null;
        if (oPk is not null || dPk is not null)
        {
            var same = oPk is not null && dPk is not null && SameColumns(MapAll(oPk.Columns), dPk.Columns)
                       && oPk.Clustered == dPk.Clustered && NamesCompatible(oPk.Name, dPk.Name);
            if (!same)
            {
                if (oPk is not null) { pkDropped = oPk; changes.Add(new(TableChangeKinds.PrimaryKeyDropped, oPk.Name ?? "PRIMARY KEY")); }
                if (dPk is not null) { pkAdded = dPk; changes.Add(new(TableChangeKinds.PrimaryKeyAdded, dPk.Name ?? "PRIMARY KEY", string.Join(", ", dPk.Columns))); }
            }
        }

        // ---- uniques, indexes, foreign keys, checks
        var (uqDrop, uqAdd) = Match(original.Uniques, desired.Uniques, u => u.Name,
            (o, d) => SameColumns(MapAll(o.Columns), d.Columns));
        var (ixDrop, ixAdd) = Match(original.Indexes, desired.Indexes, i => i.Name,
            (o, d) => o.Unique == d.Unique && o.Clustered == d.Clustered
                      && o.Columns.Count == d.Columns.Count
                      && o.Columns.Zip(d.Columns).All(p => Map(p.First.Name).Equals(p.Second.Name, StringComparison.OrdinalIgnoreCase) && p.First.Desc == p.Second.Desc)
                      && SameColumnSet(MapAll(o.Include), d.Include)
                      && SameExpression(o.Filter, d.Filter));
        var (fkDrop, fkAdd) = Match(original.ForeignKeys, desired.ForeignKeys, f => f.Name,
            (o, d) => SameColumns(MapAll(o.Columns), d.Columns)
                      && (o.RefSchema is null || d.RefSchema is null || SameText(o.RefSchema, d.RefSchema))
                      && o.RefTable.Equals(d.RefTable, StringComparison.OrdinalIgnoreCase)
                      && SameColumns(o.RefTable.Equals(original.Name, StringComparison.OrdinalIgnoreCase) ? MapAll(o.RefColumns) : o.RefColumns, d.RefColumns)
                      && ReferentialActions.Normalize(o.OnDelete) == ReferentialActions.Normalize(d.OnDelete)
                      && ReferentialActions.Normalize(o.OnUpdate) == ReferentialActions.Normalize(d.OnUpdate));
        var (ckDrop, ckAdd) = Match(original.Checks, desired.Checks, c => c.Name,
            (o, d) => SameExpression(RenameInExpression(o.Expression, renames), d.Expression));

        foreach (var u in uqDrop) changes.Add(new(TableChangeKinds.UniqueDropped, u.Name ?? "UNIQUE"));
        foreach (var u in uqAdd) changes.Add(new(TableChangeKinds.UniqueAdded, u.Name ?? "UNIQUE", string.Join(", ", u.Columns)));
        foreach (var i in ixDrop) changes.Add(new(TableChangeKinds.IndexDropped, i.Name));
        foreach (var i in ixAdd) changes.Add(new(TableChangeKinds.IndexAdded, i.Name, string.Join(", ", i.Columns.Select(c => c.Name))));
        foreach (var f in fkDrop) changes.Add(new(TableChangeKinds.ForeignKeyDropped, f.Name ?? "FOREIGN KEY"));
        foreach (var f in fkAdd) changes.Add(new(TableChangeKinds.ForeignKeyAdded, f.Name ?? "FOREIGN KEY", $"→ {f.RefTable}"));
        foreach (var c in ckDrop) changes.Add(new(TableChangeKinds.CheckDropped, c.Name ?? "CHECK"));
        foreach (var c in ckAdd) changes.Add(new(TableChangeKinds.CheckAdded, c.Name ?? "CHECK", c.Expression));

        return new TableDiffResult
        {
            Original = original,
            Desired = desired,
            TableRenamed = tableRenamed,
            CommentChanged = commentChanged,
            OptionsChanged = optionsChanged,
            ColumnsReordered = reordered,
            Matched = matched,
            Added = added,
            Dropped = dropped,
            PrimaryKeyDropped = pkDropped,
            PrimaryKeyAdded = pkAdded,
            UniquesDropped = uqDrop,
            UniquesAdded = uqAdd,
            IndexesDropped = ixDrop,
            IndexesAdded = ixAdd,
            ForeignKeysDropped = fkDrop,
            ForeignKeysAdded = fkAdd,
            ChecksDropped = ckDrop,
            ChecksAdded = ckAdd,
            Changes = changes,
            Renames = renames,
        };
    }

    /// <summary>
    /// Pairs equal items (same structure and compatible names); returns the unmatched originals (dropped) and
    /// unmatched desired items (added).
    /// </summary>
    private static (List<T> Dropped, List<T> Added) Match<T>(IReadOnlyList<T> original, IReadOnlyList<T> desired, Func<T, string?> name, Func<T, T, bool> sameStructure)
    {
        var remaining = original.ToList();
        var added = new List<T>();
        foreach (var d in desired)
        {
            var hit = remaining.FirstOrDefault(o => NamesCompatible(name(o), name(d)) && sameStructure(o, d));
            if (hit is null) added.Add(d);
            else remaining.Remove(hit);
        }
        return (remaining, added);
    }

    /// <summary>Equal names (case-insensitive), or the desired item has no name (the server named it).</summary>
    private static bool NamesCompatible(string? original, string? desired) =>
        string.IsNullOrWhiteSpace(desired) || string.IsNullOrWhiteSpace(original) || original.Equals(desired, StringComparison.OrdinalIgnoreCase);

    private static bool SameColumns(IReadOnlyList<string> a, IReadOnlyList<string> b) =>
        a.Count == b.Count && a.Zip(b).All(p => p.First.Equals(p.Second, StringComparison.OrdinalIgnoreCase));

    private static bool SameColumnSet(IReadOnlyList<string> a, IReadOnlyList<string> b) =>
        a.Count == b.Count && a.All(x => b.Contains(x, StringComparer.OrdinalIgnoreCase));

    internal static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    public static bool SameText(string? a, string? b) =>
        string.Equals(Blank(a), Blank(b), StringComparison.OrdinalIgnoreCase);

    /// <summary>Provider table options (<see cref="TableOptions.Extra"/>) are equal when their non-blank entries are.</summary>
    public static bool SameExtra(Dictionary<string, string>? a, Dictionary<string, string>? b)
    {
        static Dictionary<string, string> Norm(Dictionary<string, string>? d) =>
            (d ?? []).Where(kv => !string.IsNullOrWhiteSpace(kv.Value)).ToDictionary(kv => kv.Key, kv => kv.Value.Trim(), StringComparer.OrdinalIgnoreCase);
        var x = Norm(a);
        var y = Norm(b);
        return x.Count == y.Count && x.All(kv => y.TryGetValue(kv.Key, out var v) && string.Equals(v, kv.Value, StringComparison.Ordinal));
    }

    /// <summary>Type texts compare case-insensitively ignoring whitespace: "NVARCHAR (100)" == "nvarchar(100)".</summary>
    public static bool SameType(string? a, string? b) => NormalizeType(a) == NormalizeType(b);

    public static string NormalizeType(string? type)
    {
        if (string.IsNullOrWhiteSpace(type)) return "";
        var sb = new StringBuilder(type.Length);
        var lastSpace = false;
        foreach (var ch in type.Trim())
        {
            if (char.IsWhiteSpace(ch)) { lastSpace = true; continue; }
            if (lastSpace && sb.Length > 0 && char.IsLetterOrDigit(ch) && char.IsLetterOrDigit(sb[^1])) sb.Append(' ');
            lastSpace = false;
            sb.Append(char.ToLowerInvariant(ch));
        }
        return sb.ToString();
    }

    /// <summary>
    /// Expressions compare after removing redundant outer parentheses (SQL Server stores "((0))") and collapsing
    /// whitespace outside string literals; keyword case is ignored outside literals.
    /// </summary>
    public static bool SameExpression(string? a, string? b) => NormalizeExpression(a) == NormalizeExpression(b);

    public static string? NormalizeExpression(string? expr)
    {
        if (string.IsNullOrWhiteSpace(expr)) return null;
        var e = StripOuterParens(expr.Trim());
        var sb = new StringBuilder(e.Length);
        var inString = false;
        var lastSpace = false;
        foreach (var ch in e)
        {
            if (ch == '\'') { inString = !inString; sb.Append(ch); lastSpace = false; continue; }
            if (inString) { sb.Append(ch); continue; }
            // Identifier quotes are dropped: servers store [Amount] / "AMOUNT" for what was typed as Amount.
            if (ch is '[' or ']' or '"' or '`') continue;
            if (char.IsWhiteSpace(ch)) { lastSpace = true; continue; }
            if (lastSpace && sb.Length > 0 && (char.IsLetterOrDigit(ch) || ch == '_') && (char.IsLetterOrDigit(sb[^1]) || sb[^1] == '_')) sb.Append(' ');
            lastSpace = false;
            sb.Append(char.ToUpperInvariant(ch));
        }
        // SQL Server wraps numeric literals: ([Qty]>(0)) for Qty > 0.
        var text = sb.ToString();
        string previous;
        do
        {
            previous = text;
            text = ParenthesizedNumber().Replace(text, "${n}");
        } while (text != previous);
        return text;
    }

    [System.Text.RegularExpressions.GeneratedRegex(@"(?<![\w$#])\((?<n>-?\d+(?:\.\d+)?)\)")]
    private static partial System.Text.RegularExpressions.Regex ParenthesizedNumber();

    /// <summary>"((0))" → "0"; "(a) + (b)" is left alone.</summary>
    public static string StripOuterParens(string e)
    {
        var s = e.Trim();
        while (s.Length >= 2 && s[0] == '(' && s[^1] == ')' && MatchingParen(s, 0) == s.Length - 1) s = s[1..^1].Trim();
        return s;
    }

    private static int MatchingParen(string s, int open)
    {
        var depth = 0;
        var inString = false;
        for (var i = open; i < s.Length; i++)
        {
            var c = s[i];
            if (c == '\'') inString = !inString;
            if (inString) continue;
            if (c == '(') depth++;
            else if (c == ')' && --depth == 0) return i;
        }
        return -1;
    }

    internal static bool SameComputed(ComputedModel? a, ComputedModel? b) =>
        a is null ? b is null : b is not null && a.Persisted == b.Persisted && SameExpression(a.Expression, b.Expression);

    /// <summary>Replaces whole-word column references in a check expression after renames (outside literals).</summary>
    public static string RenameInExpression(string expression, IReadOnlyDictionary<string, string> renames)
    {
        if (renames.Count == 0 || string.IsNullOrEmpty(expression)) return expression;
        var sb = new StringBuilder(expression.Length);
        var i = 0;
        while (i < expression.Length)
        {
            var c = expression[i];
            if (c == '\'')
            {
                var end = expression.IndexOf('\'', i + 1);
                end = end < 0 ? expression.Length : end + 1;
                sb.Append(expression, i, end - i);
                i = end;
                continue;
            }
            if (c is '"' or '[' or '`')
            {
                var close = c == '[' ? ']' : c;
                var end = expression.IndexOf(close, i + 1);
                if (end < 0) { sb.Append(expression, i, expression.Length - i); break; }
                var inner = expression[(i + 1)..end];
                sb.Append(c).Append(renames.TryGetValue(inner, out var rq) ? rq : inner).Append(close);
                i = end + 1;
                continue;
            }
            if (char.IsLetter(c) || c == '_')
            {
                var start = i;
                while (i < expression.Length && (char.IsLetterOrDigit(expression[i]) || expression[i] is '_' or '$' or '#')) i++;
                var word = expression[start..i];
                sb.Append(renames.TryGetValue(word, out var r) ? r : word);
                continue;
            }
            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }
}
