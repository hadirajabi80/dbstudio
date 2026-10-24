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
        var escape = EscapeOf(dialect);
        var sb = new StringBuilder(literal.Length + 8).Append('%');
        foreach (var ch in literal)
        {
            if (ch is '%' or '_' || ch == escape || (ch == '[' && dialect == Dialect.TSql)) sb.Append(escape);
            sb.Append(ch);
        }
        return sb.Append('%').ToString();
    }

    /// <summary>
    /// LIKE escape character of a dialect: <see cref="Escape"/>, except ClickHouse, whose LIKE has no ESCAPE clause and
    /// always escapes with a backslash (the pattern is a bound value, so the backslash is not a string-literal escape).
    /// </summary>
    public static char EscapeOf(Dialect dialect) => dialect switch
    {
        // WP-CH begin
        Dialect.ClickHouse => '\\',
        // WP-CH end
        _ => Escape,
    };

    /// <summary>
    /// Bound parameter reference: <c>:name</c> on Oracle, positional <c>$1</c> on PostgreSQL (generated queries bind one
    /// value, the term), <c>@name</c> on SQL Server and SQLite.
    /// </summary>
    public static string Param(Dialect dialect, string name) => dialect switch
    {
        Dialect.PlSql => ":" + name,
        Dialect.PgSql => "$1",
        // WP-MY begin
        Dialect.MySql => "@" + name,
        // WP-MY end
        // WP-CH begin
        Dialect.ClickHouse => "{" + name + ":String}",
        // WP-CH end
        // WP-SF begin
        // numeric bind: the one value (the term) is referenced once per searched column, and :1 may repeat
        Dialect.Snowflake => ":1",
        // WP-SF end
        // WP-CS begin (CQL: data search is names/columns only, see TextExpression)
        Dialect.Cql => ":" + name,
        // WP-CS end
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
            // WP-MY begin
            Dialect.MySql => matchCase ? $"{expr} LIKE {param}{esc}" : $"UPPER({expr}) LIKE UPPER({param}){esc}",
            // WP-MY end
            // WP-CH begin (no ESCAPE clause: backslash, see EscapeOf)
            Dialect.ClickHouse => $"{expr} {(matchCase ? "like" : "ilike")} {param}",
            // WP-CH end
            // WP-SF begin
            Dialect.Snowflake => $"{expr} {(matchCase ? "LIKE" : "ILIKE")} {param}{esc}",
            // WP-SF end
            // WP-CS begin
            Dialect.Cql => $"{expr} LIKE {param}",
            // WP-CS end
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
        // WP-MY begin (REGEXP_LIKE is MySQL 8.0+; MariaDB has only REGEXP / RLIKE)
        Dialect.MySql => $"REGEXP_LIKE({expr}, {param}, '{(matchCase ? "c" : "i")}')",
        // WP-MY end
        // WP-CH begin (re2; case-insensitivity goes into the pattern, see RegexParameter)
        Dialect.ClickHouse => $"match({expr}, {param})",
        // WP-CH end
        // WP-SF begin
        Dialect.Snowflake => $"REGEXP_LIKE({expr}, {param}, '{(matchCase ? "c" : "i")}')",
        // WP-SF end
        // WP-CS begin
        Dialect.Cql => null,
        // WP-CS end
        _ => null,
    };

    /// <summary>The regex parameter value: SQLite's REGEXP function is .NET's (and ClickHouse's match is re2), so case-insensitivity goes into the pattern.</summary>
    public static string RegexParameter(Dialect dialect, string pattern, bool matchCase) => dialect switch
    {
        Dialect.Sqlite when !matchCase => "(?i)" + pattern,
        // WP-CH begin
        Dialect.ClickHouse when !matchCase => "(?i)" + pattern,
        // WP-CH end
        _ => pattern,
    };

    public static string Quote(Dialect dialect, string identifier) => dialect switch
    {
        Dialect.TSql => "[" + identifier.Replace("]", "]]") + "]",
        // WP-MY begin
        Dialect.MySql => DialectInfo.QuoteIdentifier(dialect, identifier),
        // WP-MY end
        // WP-CH begin
        Dialect.ClickHouse => DialectInfo.QuoteIdentifier(dialect, identifier),
        // WP-CH end
        // WP-SF begin
        Dialect.Snowflake => "\"" + identifier.Replace("\"", "\"\"") + "\"",
        // WP-SF end
        // WP-CS begin
        Dialect.Cql => "\"" + identifier.Replace("\"", "\"\"") + "\"",
        // WP-CS end
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
            // WP-MY begin
            case Dialect.MySql:
                return t switch
                {
                    "char" or "varchar" or "tinytext" or "text" or "mediumtext" or "longtext" or "enum" or "set" => quotedColumn,
                    "json" => $"CAST({quotedColumn} AS CHAR)",
                    _ => null,
                };
            // WP-MY end
            // WP-CH begin
            case Dialect.ClickHouse:
            {
                // Nullable(…) / LowCardinality(…) wrappers: decide on the inner type.
                var inner = (typeText ?? "").Trim();
                while (true)
                {
                    var open = inner.IndexOf('(');
                    var head = open < 0 ? inner : inner[..open].Trim();
                    if (open > 0 && inner.EndsWith(')') && head is "Nullable" or "LowCardinality") { inner = inner[(open + 1)..^1].Trim(); continue; }
                    break;
                }
                var b = BaseType(inner);
                return b switch
                {
                    "string" or "fixedstring" => quotedColumn,
                    "uuid" or "enum8" or "enum16" or "enum" or "json" or "object" or "ipv4" or "ipv6" => $"toString({quotedColumn})",
                    "array" or "map" or "tuple" when inner.Contains("String", StringComparison.Ordinal) => $"toString({quotedColumn})",
                    _ => null,
                };
            }
            // WP-CH end
            // WP-SF begin
            case Dialect.Snowflake:
                return t switch
                {
                    "varchar" or "string" or "text" or "char" or "character" or "nvarchar" or "nchar" => quotedColumn,
                    "variant" or "object" or "array" => $"TO_VARCHAR({quotedColumn})",
                    _ => null,
                };
            // WP-SF end
            // WP-CS begin (CQL cannot filter a non-key column without an index: find in database covers names/columns only)
            case Dialect.Cql:
                return null;
            // WP-CS end
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
            // WP-MY begin
            Dialect.MySql => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n}",
            // WP-MY end
            // WP-CH begin
            Dialect.ClickHouse => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n}",
            // WP-CH end
            // WP-SF begin
            Dialect.Snowflake => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n}",
            // WP-SF end
            // WP-CS begin
            Dialect.Cql => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n} ALLOW FILTERING",
            // WP-CS end
            _ => $"SELECT {select} FROM {from} WHERE {where} LIMIT {n}",
        };
        return new DataSearchQuery(sql, [(TermParameter, value)], keys, text.Select(t => t.Name).ToList());
    }
}
