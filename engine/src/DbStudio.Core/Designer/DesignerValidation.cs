namespace DbStudio.Core.Designer;

/// <summary>Model checks shared by the scripters; violations throw <see cref="ArgumentException"/> (→ 400 VALIDATION).</summary>
public static class DesignerValidation
{
    public static void ValidateTable(TableModel t, bool requireIndexNames = true)
    {
        if (string.IsNullOrWhiteSpace(t.Name)) throw new ArgumentException("The table needs a name.");
        if (t.Columns.Count == 0) throw new ArgumentException("The table needs at least one column.");
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var c in t.Columns)
        {
            if (string.IsNullOrWhiteSpace(c.Name)) throw new ArgumentException("Every column needs a name.");
            if (!names.Add(c.Name)) throw new ArgumentException($"Column '{c.Name}' is defined twice.");
            if (c.Computed is null && string.IsNullOrWhiteSpace(c.Type)) throw new ArgumentException($"Column '{c.Name}' needs a type.");
            if (c.Computed is not null && string.IsNullOrWhiteSpace(c.Computed.Expression)) throw new ArgumentException($"Computed column '{c.Name}' needs an expression.");
            if (c.Identity is { Increment: 0 }) throw new ArgumentException($"Identity column '{c.Name}' needs a non-zero increment.");
        }
        if (t.Columns.Count(c => c.Identity is not null) > 1) throw new ArgumentException("A table can have only one identity column.");

        void CheckCols(IEnumerable<string> cols, string what)
        {
            foreach (var c in cols)
                if (!names.Contains(c)) throw new ArgumentException($"{what} references unknown column '{c}'.");
        }
        if (t.PrimaryKey is { } pk) CheckCols(pk.Columns, "The primary key");
        foreach (var u in t.Uniques)
        {
            if (u.Columns.Count == 0) throw new ArgumentException($"Unique constraint {u.Name} has no columns.");
            CheckCols(u.Columns, $"Unique constraint {u.Name}");
        }
        var indexNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var i in t.Indexes)
        {
            if (requireIndexNames && string.IsNullOrWhiteSpace(i.Name)) throw new ArgumentException("Every index needs a name.");
            if (!indexNames.Add(i.Name)) throw new ArgumentException($"Index '{i.Name}' is defined twice.");
            if (i.Columns.Count == 0) throw new ArgumentException($"Index {i.Name} has no columns.");
            CheckCols(i.Columns.Select(c => c.Name), $"Index {i.Name}");
            CheckCols(i.Include, $"Index {i.Name} (INCLUDE)");
        }
        if (t.Indexes.Count(i => i.Clustered) + (t.PrimaryKey is { Clustered: true, Columns.Count: > 0 } ? 1 : 0) > 1 && t.Indexes.Any(i => i.Clustered))
            throw new ArgumentException("A table can have only one clustered index (the primary key is clustered).");
        foreach (var f in t.ForeignKeys)
        {
            if (f.Columns.Count == 0) throw new ArgumentException($"Foreign key {f.Name} has no columns.");
            CheckCols(f.Columns, $"Foreign key {f.Name}");
            if (string.IsNullOrWhiteSpace(f.RefTable)) throw new ArgumentException($"Foreign key {f.Name} needs a referenced table.");
            if (f.RefColumns.Count > 0 && f.RefColumns.Count != f.Columns.Count)
                throw new ArgumentException($"Foreign key {f.Name}: {f.Columns.Count} column(s) reference {f.RefColumns.Count}.");
            foreach (var a in new[] { f.OnDelete, f.OnUpdate })
                if (!ReferentialActions.All.Contains(ReferentialActions.Normalize(a)))
                    throw new ArgumentException($"Foreign key {f.Name}: unknown action '{a}'.");
        }
        foreach (var ck in t.Checks)
            if (string.IsNullOrWhiteSpace(ck.Expression)) throw new ArgumentException("Every check constraint needs an expression.");
    }

    public static void ValidateView(ViewDefinition v)
    {
        if (string.IsNullOrWhiteSpace(v.Name)) throw new ArgumentException("The view needs a name.");
        if (string.IsNullOrWhiteSpace(v.Body)) throw new ArgumentException("The view needs a SELECT statement.");
    }
}
