using DbStudio.Core.Models;

namespace DbStudio.Core.Providers;

/// <summary>Kinds of <see cref="ObjectDependency"/> (wire tokens).</summary>
public static class DependencyKinds
{
    /// <summary>A foreign key (Uses: this table references the object; Used by: the object references this table).</summary>
    public const string Fk = "fk";
    /// <summary>Referenced by name in a view, routine or trigger body (Uses side).</summary>
    public const string Uses = "uses";
    /// <summary>A view, routine or trigger whose body references this object (Used by side).</summary>
    public const string UsedBy = "usedBy";
    /// <summary>A trigger on this table (Used by), or the table a trigger fires on (Uses).</summary>
    public const string Trigger = "trigger";
    /// <summary>Reserved: an index of a table.</summary>
    public const string Index = "index";
}

/// <param name="Kind">One of <see cref="DependencyKinds"/>.</param>
/// <param name="Detail">Display detail, e.g. the FK "FK_Orders_Customers: CustomerId → Id" or the trigger events.</param>
/// <param name="IsSchemaBound">SQL Server: the reference is schema-bound; null when the provider cannot tell.</param>
public sealed record ObjectDependency(string Kind, ObjectRef Object, string? Detail, bool? IsSchemaBound);

/// <summary>What an object uses (outgoing) and what uses it (incoming), one level deep.</summary>
public sealed record DependencyGraph(ObjectRef Root, IReadOnlyList<ObjectDependency> Uses, IReadOnlyList<ObjectDependency> UsedBy);

/// <summary>Relations and usages of one object (the object tab's Dependencies section).</summary>
public interface IDependencyReader : IAsyncDisposable
{
    Task<DependencyGraph> GetDependenciesAsync(ObjectRef obj, CancellationToken ct);
}

/// <summary>One row of the Objects tab (Navicat-like object list) with cheap statistics where the server has them.</summary>
public sealed record ObjectListItem(
    string Type, string? Schema, string Name, long? RowCount, long? SizeBytes, DateTimeOffset? Modified, DateTimeOffset? Created, string? Comment);

public interface IObjectListReader : IAsyncDisposable
{
    /// <summary>Objects of <paramref name="schema"/> (null = every user schema of the database), optionally of one type.</summary>
    Task<IReadOnlyList<ObjectListItem>> ListAsync(string? database, string? schema, string? type, CancellationToken ct);
}

/// <summary>
/// Implemented by the relational <see cref="IDbProvider"/>s that support the object browser (resolved through
/// <c>ProviderFeatures.ObjectBrowser</c>, so <see cref="IDbProvider"/> stays frozen). Readers are short-lived: dispose them.
/// </summary>
public interface IObjectBrowserProvider
{
    Task<IDependencyReader> OpenDependencyReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct);
    Task<IObjectListReader> OpenObjectListReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct);
}

/// <summary>Helpers shared by the provider implementations.</summary>
public static class DependencyGraphs
{
    /// <summary>Drops the root itself and exact duplicates (same kind and object), keeping the first detail.</summary>
    public static DependencyGraph Build(ObjectRef root, IEnumerable<ObjectDependency> uses, IEnumerable<ObjectDependency> usedBy)
    {
        return new DependencyGraph(root, Clean(root, uses), Clean(root, usedBy));
    }

    private static List<ObjectDependency> Clean(ObjectRef root, IEnumerable<ObjectDependency> items)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<ObjectDependency>();
        foreach (var d in items)
        {
            var o = d.Object;
            if (d.Kind != DependencyKinds.Fk && string.Equals(o.Name, root.Name, StringComparison.OrdinalIgnoreCase)
                && string.Equals(o.Schema ?? "", root.Schema ?? "", StringComparison.OrdinalIgnoreCase) && SameFamily(o.Type, root.Type))
                continue;
            var key = $"{d.Kind}|{o.Schema}|{o.Name}|{o.Type}|{(d.Kind == DependencyKinds.Fk ? d.Detail : "")}";
            if (seen.Add(key)) list.Add(d);
        }
        list.Sort((a, b) =>
        {
            var c = Rank(a.Kind).CompareTo(Rank(b.Kind));
            if (c != 0) return c;
            c = string.Compare(a.Object.Schema, b.Object.Schema, StringComparison.OrdinalIgnoreCase);
            return c != 0 ? c : string.Compare(a.Object.Name, b.Object.Name, StringComparison.OrdinalIgnoreCase);
        });
        return list;
    }

    private static int Rank(string kind) => kind switch
    {
        DependencyKinds.Fk => 0,
        DependencyKinds.Trigger => 2,
        _ => 1,
    };

    private static bool SameFamily(string a, string b)
    {
        static string F(string t) => t is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.TableFunc ? "routine" : t;
        return F(a) == F(b);
    }

    /// <summary>
    /// Names referenced in a SQL body (for engines that do not track dependencies of routine bodies): every identifier
    /// chain as (qualifier, name) — <c>a.b.c</c> gives (b, c), a lone <c>x</c> gives (null, x). Keywords come back too;
    /// callers match the names against real objects. Strings and comments are skipped by the tokenizer.
    /// </summary>
    public static List<(string? Qualifier, string Name)> ReferencedNames(string? sql, Dialect dialect)
    {
        var list = new List<(string?, string)>();
        if (string.IsNullOrEmpty(sql)) return list;
        var tokens = DbStudio.Core.Sql.SqlTokenizer.Tokenize(sql, dialect);
        for (var i = 0; i < tokens.Count; i++)
        {
            if (!tokens[i].IsIdentifier || (i > 0 && tokens[i - 1].IsPunct('.'))) continue;
            var parts = new List<string> { tokens[i].Value };
            var j = i;
            while (j + 2 < tokens.Count && tokens[j + 1].IsPunct('.') && tokens[j + 2].IsIdentifier)
            {
                parts.Add(tokens[j + 2].Value);
                j += 2;
            }
            list.Add(parts.Count > 1 ? (parts[^2], parts[^1]) : (null, parts[0]));
        }
        return list;
    }

    /// <summary>"name: a, b → x, y".</summary>
    public static string FkDetail(string constraint, IEnumerable<string> columns, IEnumerable<string> refColumns) =>
        $"{constraint}: {string.Join(", ", columns)} → {string.Join(", ", refColumns)}";
}
