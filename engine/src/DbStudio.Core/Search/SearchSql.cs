using System.Globalization;
using System.Text;
using DbStudio.Core.Models;

namespace DbStudio.Core.Search;

/// <summary>
/// Dialect-specific SQL of the search: LIKE patterns and predicates, identifier quoting, the searchable text expression of
/// a column and the per-table data query. The term is always a bound parameter; only identifiers (quoted, quote characters
/// doubled) and the row limit (an integer) are written into the SQL text.
/// </summary>
public static class SearchSql
{
    /// <summary>LIKE escape character. Not a backslash: it needs no special handling with standard_conforming_strings off (PostgreSQL).</summary>
    public const char Escape = '!';

    /// <summary>Name of the term parameter in generated data queries.</summary>
    public const string TermParameter = "p";

    /// <summary>Most rows a data query returns per table.</summary>
    public const int MaxRowLimit = 1000;

    /// <summary>
    /// <c>%literal%</c> with the LIKE wildcards and the escape character escaped (plus <c>[</c> on SQL Server, where it starts
    /// a character class). Use with <see cref="LikePredicate"/>, which adds the <c>ESCAPE</c> clause.
    /// </summary>
    public static string LikePattern(Dialect dialect, string literal)
    {
        var sb = new StringBuilder(literal.Length + 8).Append('%');
        foreach (var ch in literal)
        {
            if (ch is '%' or '_' or Escape || (ch == '[' && dialect == Dialect.TSql)) sb.Append(Escape);
            sb.Append(ch);
        }
        return sb.Append('%').ToString();
    }

    /// <summary>
    /// Bound parameter reference: <c>:name</c> on Oracle, positional <c>$1</c> on PostgreSQL (generated queries bind one
    /// value, the term), <c>@name</c> on SQL Server and SQLite.
    /// </summary>
    public static string Param(Dialect dialect, string name) => dialect switch
    {
        Dialect.PlSql => ":" + name,
        Dialect.PgSql => "$1",
        _ => "@" + name,
    };

    /// <summary>
    /// <paramref name="expr"/> LIKE the pattern parameter. Case-insensitive searches compare upper case (ILIKE on PostgreSQL),
    /// so a case-sensitive collation cannot hide a match; SQLite's LIKE is case-insensitive already. A case-sensitive search
    /// uses a plain LIKE: exact under a case-sensitive collation, a superset under a case-insensitive one (the engine filters).
    /// </summary>
    public static string LikePredicate(Dialect dialect, string expr, string param, bool matchCase)
    {
        var esc = $" ESCAPE '{Escape}'";
        return dialect switch
        {
            Dialect.PgSql => $"{expr} {(matchCase ? "LIKE" : "ILIKE")} {param}{esc}",
            Dialect.Sqlite => $"{expr} LIKE {param}{esc}",
            _ => matchCase ? $"{expr} LIKE {param}{esc}" : $"UPPER({expr}) LIKE UPPER({param}){esc}",
        };
    }

    /// <summary>
    /// Regular-expression prefilter where the engine has one (PostgreSQL <c>~</c>, Oracle <c>REGEXP_LIKE</c>, SQLite
    /// <c>REGEXP</c> through the function the searcher registers); null on SQL Server, which has none before 2025.
    /// </summary>
    public static string? RegexPredicate(Dialect dialect, string expr, string param, bool matchCase) => dialect switch
    {
        Dialect.PgSql => $"{expr} {(matchCase ? "~" : "~*")} {param}",
        Dialect.PlSql => $"REGEXP_LIKE({expr}, {param}, '{(matchCase ? "c" : "i")}')",
        Dialect.Sqlite => $"{expr} REGEXP {param}",
        _ => null,
    };

    /// <summary>The regex parameter value: SQLite's REGEXP function is .NET's, so case-insensitivity goes into the pattern.</summary>
    public static string RegexParameter(Dialect dialect, string pattern, bool matchCase) =>
        dialect == Dialect.Sqlite && !matchCase ? "(?i)" + pattern : pattern;

    public static string Quote(Dialect dialect, string identifier) => dialect switch
    {
        Dialect.TSql => "[" + identifier.Replace("]", "]]") + "]",
        _ => "\"" + identifier.Replace("\"", "\"\"") + "\"",
    };

    public static string Qualify(Dialect dialect, string? schema, string name) =>
        string.IsNullOrEmpty(schema) ? Quote(dialect, name) : Quote(dialect, schema) + "." + Quote(dialect, name);

    /// <summary>Lower-case base type name: "nvarchar(50)" → "nvarchar", "character varying(20)" → "character varying", "text[]" → "text[]".</summary>
    private static string BaseType(string typeText)
    {
        var t = typeText.Trim().ToLowerInvariant();
        var arr = t.EndsWith("[]", StringComparison.Ordinal);
        var paren = t.IndexOf('(');
        if (paren >= 0) t = t[..paren].Trim();
        if (arr && !t.EndsWith("[]", StringComparison.Ordinal)) t += "[]";
        return t;
    }

    /// <summary>
    /// The expression a text search compares for a column of type <paramref name="typeText"/> (the quoted column, or a cast
    /// to text), or null when the type holds no searchable text (numbers, dates, binaries, LONG…).
    /// </summary>
    public static string? TextExpression(Dialect dialect, string quotedColumn, string? typeText)
    {
        var t = BaseType(typeText ?? "");
        switch (dialect)
        {
            case Dialect.TSql:
                return t switch
                {
                    "char" or "varchar" or "nchar" or "nvarchar" or "sysname" => quotedColumn,
                    "text" or "ntext" or "xml" => $"CAST({quotedColumn} AS nvarchar(max))",
                    "uniqueidentifier" => $"CAST({quotedColumn} AS nvarchar(36))",
                    _ => null,
                };
            case Dialect.PlSql:
                return t switch
                {
                    "varchar2" or "nvarchar2" or "char" or "nchar" or "varchar" or "clob" or "nclob" => quotedColumn,
                    _ => null,
                };
            case Dialect.PgSql:
                if (t.EndsWith("[]", StringComparison.Ordinal))
                {
                    var el = t[..^2];
                    return el is "text" or "varchar" or "character varying" or "character" or "char" or "bpchar" or "citext" or "name"
                        ? $"CAST({quotedColumn} AS text)" : null;
                }
                return t switch
                {
                    "text" or "varchar" or "character varying" or "character" or "char" or "bpchar" or "citext" or "name" => quotedColumn,
                    "uuid" or "json" or "jsonb" or "xml" => $"CAST({quotedColumn} AS text)",
                    _ => null,
                };
            case Dialect.Sqlite:
                // Type affinity (sqlite.org/datatype3.html): CHAR, CLOB or TEXT in the declared type, or no type at all.
                if (t.Length == 0 || t.Contains("char", StringComparison.Ordinal) || t.Contains("clob", StringComparison.Ordinal)
                    || t.Contains("text", StringComparison.Ordinal))
                    return quotedColumn;
                return t is "json" or "jsonb" or "uuid" or "guid" or "xml" or "string" ? quotedColumn : null;
            default:
                return null;
        }
    }

    /// <summary>
    /// SELECT key columns and searchable text columns of one table with at most <paramref name="rowLimit"/> rows that contain
    /// the term (LIKE '%term%', or the dialect's regex operator in regex mode). Null when the table has no text column or the
    /// dialect cannot prefilter a regex (SQL Server).
    /// </summary>
    public static DataSearchQuery? BuildDataQuery(Dialect dialect, string? schema, string table, IReadOnlyList<string> keyColumns,
        IReadOnlyList<(string Name, string? Type)> columns, SearchMatcher matcher, int rowLimit)
    {
        rowLimit = Math.Clamp(rowLimit, 1, MaxRowLimit);
        var text = new List<(string Name, string Expr)>();
        foreach (var (name, type) in columns)
        {
            var expr = TextExpression(dialect, Quote(dialect, name), type);
            if (expr is not null) text.Add((name, expr));
        }
        if (text.Count == 0) return null;

        var p = Param(dialect, TermParameter);
        string value;
        var predicates = new List<string>(text.Count);
        if (matcher.Literal is { } literal)
        {
            value = LikePattern(dialect, literal);
            foreach (var (_, expr) in text) predicates.Add(LikePredicate(dialect, expr, p, matcher.MatchCase));
        }
        else
        {
            if (RegexPredicate(dialect, "x", p, matcher.MatchCase) is null) return null;
            value = RegexParameter(dialect, matcher.Term, matcher.MatchCase);
            foreach (var (_, expr) in text) predicates.Add(RegexPredicate(dialect, expr, p, matcher.MatchCase)!);
        }

        var keys = keyColumns.Where(k => !string.IsNullOrEmpty(k)).ToList();
        var select = string.Join(", ", keys.Select(k => Quote(dialect, k)).Concat(text.Select(t => t.Expr)));
        var from = Qualify(dialect, schema, table);
        var where = "(" + string.Join(" OR ", predicates) + ")";
        var n = rowLimit.ToString(CultureInfo.InvariantCulture);
        var sql = dialect switch
        {
            Dialect.TSql => $"SELECT TOP ({n}) {select} FROM {from} WHERE {where}",
            // ROWNUM works on every version (FETCH FIRST needs 12c).
            Dialect.PlSql => $"SELECT {select} FROM {from} WHERE {where} AND ROWNUM <= {n}",
            _ => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n}",
        };
        return new DataSearchQuery(sql, [(TermParameter, value)], keys, text.Select(t => t.Name).ToList());
    }
}
