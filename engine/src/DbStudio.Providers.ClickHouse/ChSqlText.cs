using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.ClickHouse;

/// <summary>One statement of a batch: its text (as sent), offset in the batch text and leading keywords.</summary>
/// <param name="Start">0-based offset of the first character in the batch text.</param>
/// <param name="Kind">Upper-case head: SELECT, INSERT, ALTER, USE, …</param>
/// <param name="UseDatabase">For <c>USE db</c>: the database name.</param>
/// <param name="Mutation">For <c>ALTER TABLE t UPDATE/DELETE</c> and lightweight <c>DELETE FROM t</c>: (database, table).</param>
public sealed record ChStatement(string Text, int Start, string Kind, bool IsQuery, string? UseDatabase = null,
    (string? Database, string Table)? Mutation = null)
{
    public bool IsInsert => Kind == "INSERT";
}

/// <summary>
/// ClickHouse statement handling on top of the shared tokenizer (<c>Dialect.ClickHouse</c>: backticks, <c>#</c> comments,
/// backslash escapes). The HTTP interface takes exactly one statement per request ("Multi-statements are not allowed"), so a
/// batch is split at depth-0 semicolons. <c>INSERT … FORMAT x</c> keeps the rest of the batch as its inline data.
/// </summary>
public static class ChSqlText
{
    private static readonly HashSet<string> QueryHeads = new(StringComparer.OrdinalIgnoreCase)
    {
        "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN", "WATCH", "VALUES", "CHECK",
    };

    public static List<ChStatement> Split(string sql)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.ClickHouse);
        var result = new List<ChStatement>();
        if (tokens.Count == 0) return result;
        var groups = SqlTokenizer.SplitStatements(tokens, Dialect.ClickHouse);
        for (var g = 0; g < groups.Count; g++)
        {
            var st = groups[g];
            if (st.Count == 0) continue;
            var start = st[0].Start;
            var end = st[^1].End;
            var head = HeadIndex(st);
            var kind = head < st.Count && st[head].Kind == SqlTokenKind.Word ? st[head].Upper : "";
            if (kind == "INSERT" && InlineFormatIndex(st) is int fmt)
            {
                // INSERT INTO t FORMAT CSV <data>: the data runs to the end of the batch (semicolons included).
                _ = fmt;
                var text = sql[start..].TrimEnd();
                result.Add(new ChStatement(text, start, kind, false));
                break;
            }
            var stmtText = sql[start..end];
            result.Add(new ChStatement(stmtText, start, kind, IsQueryKind(kind, st, head), UseTarget(st, head), MutationTarget(st, head)));
        }
        return result;
    }

    private static int HeadIndex(List<SqlToken> st)
    {
        var i = 0;
        while (i < st.Count && st[i].IsPunct('(')) i++;
        return i;
    }

    private static bool IsQueryKind(string kind, List<SqlToken> st, int head)
    {
        if (!QueryHeads.Contains(kind)) return false;
        if (kind == "WITH")
        {
            // WITH … INSERT is not valid ClickHouse; WITH … SELECT is a query.
            for (var k = head + 1; k < st.Count; k++) if (st[k].IsWord("INSERT")) return false;
        }
        if (kind == "CHECK") return st.Count > head + 1 && st[head + 1].IsWord("TABLE");
        return true;
    }

    /// <summary>Index of the FORMAT keyword of <c>INSERT INTO t [(cols)] FORMAT x</c> when data follows inline (not VALUES/SELECT).</summary>
    private static int? InlineFormatIndex(List<SqlToken> st)
    {
        var depth = 0;
        for (var k = 0; k < st.Count; k++)
        {
            var t = st[k];
            if (t.IsPunct('(')) depth++;
            else if (t.IsPunct(')')) depth--;
            else if (depth == 0 && (t.IsWord("VALUES") || t.IsWord("SELECT") || t.IsWord("WITH") || t.IsWord("INFILE"))) return null;
            else if (depth == 0 && t.IsWord("FORMAT") && k + 1 < st.Count && st[k + 1].Kind == SqlTokenKind.Word)
                return k + 2 < st.Count ? k : null;
        }
        return null;
    }

    private static string? UseTarget(List<SqlToken> st, int head)
    {
        if (head >= st.Count || !st[head].IsWord("USE") || head + 1 >= st.Count) return null;
        var t = st[head + 1];
        return t.IsIdentifier ? t.Value : null;
    }

    /// <summary>(db, table) of <c>ALTER TABLE [db.]t [ON CLUSTER c] UPDATE|DELETE …</c> or <c>DELETE FROM [db.]t …</c>.</summary>
    private static (string? Database, string Table)? MutationTarget(List<SqlToken> st, int head)
    {
        if (head >= st.Count) return null;
        int nameAt;
        if (st[head].IsWord("ALTER") && head + 2 < st.Count && st[head + 1].IsWord("TABLE")) nameAt = head + 2;
        else if (st[head].IsWord("DELETE") && head + 2 < st.Count && st[head + 1].IsWord("FROM")) nameAt = head + 2;
        else return null;
        var (db, table, next) = QualifiedName(st, nameAt);
        if (table is null) return null;
        if (st[head].IsWord("DELETE")) return (db, table);
        if (next < st.Count && st[next].IsWord("ON") && next + 2 < st.Count && st[next + 1].IsWord("CLUSTER")) next += 3;
        // Several commands may follow (ALTER TABLE t UPDATE … , DELETE …): any UPDATE/DELETE at depth 0 is a mutation.
        var depth = 0;
        for (var k = next; k < st.Count; k++)
        {
            if (st[k].IsPunct('(')) depth++;
            else if (st[k].IsPunct(')')) depth--;
            else if (depth == 0 && (st[k].IsWord("UPDATE") || st[k].IsWord("DELETE"))
                     && (k == next || st[k - 1].IsPunct(','))) return (db, table);
        }
        return null;
    }

    /// <summary>[db.]name starting at token <paramref name="at"/>; returns the index after the name.</summary>
    public static (string? Database, string? Name, int Next) QualifiedName(IReadOnlyList<SqlToken> st, int at)
    {
        if (at >= st.Count || !st[at].IsIdentifier) return (null, null, at);
        if (at + 2 < st.Count && st[at + 1].IsPunct('.') && st[at + 2].IsIdentifier) return (st[at].Value, st[at + 2].Value, at + 3);
        return (null, st[at].Value, at + 1);
    }

    /// <summary>
    /// The 0-based character offset in <paramref name="text"/> of a ClickHouse error position ("failed at position 14"):
    /// the server counts bytes of the UTF-8 query text, 1-based.
    /// </summary>
    public static int CharOffsetOfBytePosition(string text, int position)
    {
        if (position <= 1) return 0;
        var bytes = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (bytes >= position - 1) return i;
            var c = text[i];
            if (char.IsHighSurrogate(c) && i + 1 < text.Length) { bytes += 4; i++; continue; }
            bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        }
        return text.Length;
    }

    /// <summary>Line/column (1-based) of the first token of <paramref name="text"/>.</summary>
    public static int FirstTokenLine(string text)
    {
        var tokens = SqlTokenizer.Tokenize(text, Dialect.ClickHouse);
        return tokens.Count == 0 ? 1 : tokens[0].Line;
    }

    /// <summary>Quotes an identifier with backticks (backslash and backtick escaped) when it is not a plain word.</summary>
    public static string Quote(string name)
    {
        if (name.Length > 0 && (char.IsAsciiLetter(name[0]) || name[0] == '_') && name.All(c => char.IsAsciiLetterOrDigit(c) || c == '_')
            && !ChReservedWords.All.Contains(name))
            return name;
        return QuoteAlways(name);
    }

    public static string QuoteAlways(string name) => "`" + name.Replace("\\", "\\\\").Replace("`", "\\`") + "`";

    public static string Qualified(string? database, string name) =>
        string.IsNullOrEmpty(database) ? Quote(name) : Quote(database) + "." + Quote(name);

    /// <summary>A ClickHouse string literal: backslash and quote escaped.</summary>
    public static string Literal(string? value)
    {
        if (value is null) return "NULL";
        var sb = new StringBuilder(value.Length + 2).Append('\'');
        foreach (var c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '\'': sb.Append("\\'"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\0': sb.Append("\\0"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.Append('\'').ToString();
    }
}

/// <summary>Keywords that must be quoted when used as identifiers in generated SQL (conservative list).</summary>
public static class ChReservedWords
{
    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ALL", "ALTER", "AND", "ANY", "ARRAY", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "CHECK", "CLUSTER", "COLUMN",
        "CONSTRAINT", "CREATE", "CROSS", "DATABASE", "DEFAULT", "DELETE", "DESC", "DESCRIBE", "DISTINCT", "DROP", "ELSE",
        "END", "ENGINE", "EXCEPT", "EXISTS", "EXPLAIN", "FALSE", "FINAL", "FORMAT", "FROM", "FULL", "GLOBAL", "GRANT",
        "GROUP", "HAVING", "IF", "ILIKE", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTERVAL", "INTO", "IS", "JOIN",
        "KEY", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "PARTITION", "PREWHERE",
        "PRIMARY", "RENAME", "RIGHT", "SAMPLE", "SELECT", "SET", "SETTINGS", "SHOW", "TABLE", "THEN", "TO", "TOP", "TRUE",
        "TRUNCATE", "TTL", "UNION", "UPDATE", "USING", "VALUES", "VIEW", "WHEN", "WHERE", "WITH",
    };
}
