using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>A placeholder in PostgreSQL text: <c>$n</c> (<see cref="Positional"/>, <see cref="Name"/> = "n"), <c>:name</c> or <c>@name</c>.</summary>
/// <param name="Start">0-based offset of the first char.</param>
/// <param name="End">0-based exclusive end.</param>
public readonly record struct PgPlaceholder(string Name, int Start, int End, bool Positional);

/// <summary>One parameter slot of a rewritten text: <c>$Index</c> binds the parameter named <see cref="Name"/> (bare; digits = positional).</summary>
public readonly record struct PgSlot(int Index, string Name);

/// <summary>Result of <see cref="PgSqlText.Rewrite"/>: the text with every placeholder replaced by <c>$k</c>, and the slots in index order.</summary>
public sealed record PgRewrite(string Text, IReadOnlyList<PgSlot> Slots)
{
    /// <summary>Highest <c>$k</c> used (0 when there are no placeholders).</summary>
    public int MaxIndex => Slots.Count == 0 ? 0 : Slots.Max(s => s.Index);
}

/// <summary>One statement of a batch: offsets into the batch text and its tokens.</summary>
public sealed record PgStatement(int Start, int End, IReadOnlyList<SqlToken> Tokens)
{
    public string Text(string sql) => sql[Start..End];
}

/// <summary>
/// PostgreSQL lexical rules the shared Core tokenizer does not know (docs/PLAN-PG.md 1.1/2.4), implemented inside the
/// provider: dollar-quoted strings (<c>$$…$$</c>, <c>$tag$…$tag$</c>), <c>E'…'</c> strings with backslash escapes,
/// <c>U&amp;'…'</c>, <c>B'…'</c>, <c>X'…'</c>, nested block comments, <c>[</c>/<c>]</c> as array subscripts (never quoted
/// identifiers), <c>?</c>/<c>?|</c>/<c>?&amp;</c> as jsonb operators (never placeholders), <c>::</c> casts and PostgreSQL
/// operator grouping. Produces Core <see cref="SqlToken"/>s so the result plugs into Core helpers. Never throws:
/// unterminated strings, comments and identifiers extend to the end of the text.
/// </summary>
public static class PgSqlText
{
    private const string OperatorChars = "+-*/<>=~!@#%^&|`?";

    private static readonly HashSet<string> WriteKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "CALL", "VACUUM",
        "REINDEX", "COPY",
    };

    // ------------------------------------------------------------------ tokenizer

    public static List<SqlToken> Tokenize(string sql)
    {
        var tokens = new List<SqlToken>(Math.Max(8, sql.Length / 5));
        int i = 0, line = 1, lineStart = 0, bracket = 0;
        var n = sql.Length;
        char At(int k) => k < n ? sql[k] : '\0';

        while (i < n)
        {
            var c = sql[i];
            if (c == '\n') { i++; line++; lineStart = i; continue; }
            if (char.IsWhiteSpace(c)) { i++; continue; }

            if (c == '-' && At(i + 1) == '-')
            {
                while (i < n && sql[i] != '\n') i++;
                continue;
            }
            if (c == '/' && At(i + 1) == '*')
            {
                var depth = 1;
                i += 2;
                while (i < n && depth > 0)
                {
                    if (sql[i] == '\n') { line++; lineStart = i + 1; i++; continue; }
                    if (sql[i] == '/' && At(i + 1) == '*') { depth++; i += 2; continue; }
                    if (sql[i] == '*' && At(i + 1) == '/') { depth--; i += 2; continue; }
                    i++;
                }
                continue;
            }

            var start = i;
            var tokLine = line;
            var tokCol = i - lineStart + 1;
            void Add(SqlTokenKind kind, string value) => tokens.Add(new SqlToken(kind, value, start, i, tokLine, tokCol));

            // E'...' (backslash escapes)
            if (c is 'E' or 'e' && At(i + 1) == '\'')
            {
                i++;
                ReadEString(sql, ref i, ref line, ref lineStart);
                Add(SqlTokenKind.String, sql[start..i]);
                continue;
            }
            // U&'...' / U&"..."
            if (c is 'U' or 'u' && At(i + 1) == '&' && At(i + 2) is '\'' or '"')
            {
                var q = At(i + 2);
                i += 2;
                ReadQuoted(sql, ref i, q, ref line, ref lineStart);
                if (q == '\'') Add(SqlTokenKind.String, sql[start..i]);
                else Add(SqlTokenKind.QuotedIdentifier, Unquote(sql, start + 3, i, '"'));
                continue;
            }
            // B'0101', X'1F', N'national'
            if (c is 'B' or 'b' or 'X' or 'x' or 'N' or 'n' && At(i + 1) == '\'')
            {
                i++;
                ReadQuoted(sql, ref i, '\'', ref line, ref lineStart);
                Add(SqlTokenKind.String, sql[start..i]);
                continue;
            }
            if (c == '\'')
            {
                ReadQuoted(sql, ref i, '\'', ref line, ref lineStart);
                Add(SqlTokenKind.String, sql[start..i]);
                continue;
            }
            if (c == '"')
            {
                ReadQuoted(sql, ref i, '"', ref line, ref lineStart);
                Add(SqlTokenKind.QuotedIdentifier, Unquote(sql, start + 1, i, '"'));
                continue;
            }

            if (c == '$')
            {
                if (char.IsAsciiDigit(At(i + 1)))
                {
                    i++;
                    while (i < n && char.IsAsciiDigit(sql[i])) i++;
                    Add(SqlTokenKind.Parameter, sql[start..i]);
                    continue;
                }
                if (TryDollarTag(sql, i, out var tagEnd))
                {
                    var tag = sql[i..(tagEnd + 1)]; // "$tag$" or "$$"
                    var close = sql.IndexOf(tag, tagEnd + 1, StringComparison.Ordinal);
                    var end = close < 0 ? n : close + tag.Length;
                    for (var k = i; k < end; k++)
                        if (sql[k] == '\n') { line++; lineStart = k + 1; }
                    i = end;
                    Add(SqlTokenKind.String, sql[start..i]);
                    continue;
                }
                i++;
                Add(SqlTokenKind.Operator, "$");
                continue;
            }

            if (char.IsAsciiDigit(c) || (c == '.' && char.IsAsciiDigit(At(i + 1))))
            {
                i++;
                while (i < n)
                {
                    var ch = sql[i];
                    if (char.IsAsciiLetterOrDigit(ch) || ch == '_') { i++; continue; }
                    if (ch == '.' && At(i + 1) != '.') { i++; continue; }
                    if (ch is '+' or '-' && sql[i - 1] is 'e' or 'E' && !sql[start..i].StartsWith("0x", StringComparison.OrdinalIgnoreCase)) { i++; continue; }
                    break;
                }
                Add(SqlTokenKind.Number, sql[start..i]);
                continue;
            }

            if (IsIdentStart(c))
            {
                i++;
                while (i < n && IsIdentPart(sql[i])) i++;
                Add(SqlTokenKind.Word, sql[start..i]);
                continue;
            }

            if (c == ':')
            {
                if (At(i + 1) == ':') { i += 2; Add(SqlTokenKind.Operator, "::"); continue; }
                if (At(i + 1) == '=') { i += 2; Add(SqlTokenKind.Operator, ":="); continue; }
                if (bracket == 0 && IsIdentStart(At(i + 1)))
                {
                    i++;
                    while (i < n && IsIdentPart(sql[i])) i++;
                    Add(SqlTokenKind.Parameter, sql[start..i]);
                    continue;
                }
                i++;
                Add(SqlTokenKind.Operator, ":");
                continue;
            }

            if (c == '@' && IsIdentStart(At(i + 1)))
            {
                i++;
                while (i < n && IsIdentPart(sql[i])) i++;
                Add(SqlTokenKind.Parameter, sql[start..i]);
                continue;
            }

            if (c is '(' or ')' or ',' or '.' or ';' or '[' or ']')
            {
                if (c == '[') bracket++;
                else if (c == ']') bracket = Math.Max(0, bracket - 1);
                i++;
                Add(SqlTokenKind.Punct, c.ToString());
                continue;
            }

            if (OperatorChars.Contains(c))
            {
                var j = i;
                while (j < n && OperatorChars.Contains(sql[j]))
                {
                    if (j > i && ((sql[j] == '-' && At(j + 1) == '-') || (sql[j] == '/' && At(j + 1) == '*'))) break;
                    j++;
                }
                // A multi-char operator cannot end in + or - unless it contains ~ ! @ # % ^ & | ` ? (PostgreSQL lexer rule).
                while (j - i > 1 && sql[j - 1] is '+' or '-' && sql.AsSpan(i, j - i).IndexOfAny("~!@#%^&|`?") < 0) j--;
                i = j;
                Add(SqlTokenKind.Operator, sql[start..i]);
                continue;
            }

            i++;
            Add(SqlTokenKind.Operator, c.ToString());
        }
        return tokens;
    }

    public static bool IsIdentStart(char c) => char.IsAsciiLetter(c) || c == '_' || (c > 127 && char.IsLetter(c));

    public static bool IsIdentPart(char c) => char.IsAsciiLetterOrDigit(c) || c is '_' or '$' || (c > 127 && char.IsLetterOrDigit(c));

    /// <summary>At <paramref name="i"/> (a '$'): "$$" or "$tag$" with tag = [A-Za-z_][A-Za-z0-9_]*; <paramref name="tagEnd"/> = index of the closing '$'.</summary>
    private static bool TryDollarTag(string sql, int i, out int tagEnd)
    {
        tagEnd = -1;
        var j = i + 1;
        if (j < sql.Length && sql[j] == '$') { tagEnd = j; return true; }
        if (j >= sql.Length || !(char.IsAsciiLetter(sql[j]) || sql[j] == '_' || sql[j] > 127 && char.IsLetter(sql[j]))) return false;
        j++;
        while (j < sql.Length && (char.IsAsciiLetterOrDigit(sql[j]) || sql[j] == '_' || sql[j] > 127 && char.IsLetterOrDigit(sql[j]))) j++;
        if (j < sql.Length && sql[j] == '$') { tagEnd = j; return true; }
        return false;
    }

    private static void ReadQuoted(string sql, ref int i, char close, ref int line, ref int lineStart)
    {
        i++; // opening quote
        while (i < sql.Length)
        {
            var ch = sql[i];
            if (ch == '\n') { line++; lineStart = i + 1; }
            if (ch == close)
            {
                if (i + 1 < sql.Length && sql[i + 1] == close) { i += 2; continue; }
                i++;
                return;
            }
            i++;
        }
    }

    private static void ReadEString(string sql, ref int i, ref int line, ref int lineStart)
    {
        i++; // opening quote
        while (i < sql.Length)
        {
            var ch = sql[i];
            if (ch == '\n') { line++; lineStart = i + 1; }
            if (ch == '\\')
            {
                if (i + 1 < sql.Length && sql[i + 1] == '\n') { line++; lineStart = i + 2; }
                i += 2;
                continue;
            }
            if (ch == '\'')
            {
                if (i + 1 < sql.Length && sql[i + 1] == '\'') { i += 2; continue; }
                i++;
                return;
            }
            i++;
        }
        i = Math.Min(i, sql.Length);
    }

    private static string Unquote(string sql, int innerStart, int end, char quote)
    {
        var innerEnd = end > innerStart && end <= sql.Length && sql[end - 1] == quote ? end - 1 : end;
        if (innerEnd < innerStart) return "";
        return sql[innerStart..innerEnd].Replace(new string(quote, 2), quote.ToString());
    }

    /// <summary>1-based (line, col) of a 0-based offset.</summary>
    public static (int Line, int Col) LineColAt(string text, int offset) => SqlTokenizer.LineColAt(text, offset);

    // ------------------------------------------------------------------ statements

    /// <summary>
    /// Splits at semicolons outside parentheses/brackets. Dollar-quoted bodies are single tokens, so function bodies stay
    /// whole; SQL-standard bodies (<c>BEGIN ATOMIC … END</c>, PG14+) are tracked explicitly. Empty statements are dropped.
    /// </summary>
    public static List<PgStatement> Split(string sql) => Split(Tokenize(sql));

    public static List<PgStatement> Split(IReadOnlyList<SqlToken> tokens)
    {
        var result = new List<PgStatement>();
        var current = new List<SqlToken>();
        var depth = 0;
        var block = 0;
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.Kind == SqlTokenKind.Punct)
            {
                if (t.Value is "(" or "[") depth++;
                else if (t.Value is ")" or "]") depth = Math.Max(0, depth - 1);
                else if (t.Value == ";" && depth == 0 && block == 0)
                {
                    if (current.Count > 0) result.Add(new PgStatement(current[0].Start, current[^1].End, current));
                    current = [];
                    continue;
                }
            }
            else if (t.Kind == SqlTokenKind.Word)
            {
                if (t.IsWord("BEGIN") && k + 1 < tokens.Count && tokens[k + 1].IsWord("ATOMIC")) block++;
                else if (block > 0 && t.IsWord("CASE")) block++;
                else if (block > 0 && t.IsWord("END")) block--;
            }
            current.Add(t);
        }
        if (current.Count > 0) result.Add(new PgStatement(current[0].Start, current[^1].End, current));
        return result;
    }

    /// <summary>Document line of the first token of <paramref name="sql"/> (1-based, relative to the text); 1 when empty.</summary>
    public static int FirstTokenLine(string sql)
    {
        var tokens = Tokenize(sql);
        return tokens.Count == 0 ? 1 : tokens[0].Line;
    }

    // ------------------------------------------------------------------ placeholders

    /// <summary>
    /// Placeholders in text order (duplicates kept): <c>$n</c>, <c>:name</c>, <c>@name</c>. <c>?</c> never is one. Skipped:
    /// statements that define parameters of their own (<c>PREPARE x AS … $1</c>) and SQL-standard function bodies
    /// (<c>BEGIN ATOMIC … END</c>) where <c>$1</c> is the routine's argument.
    /// </summary>
    public static List<PgPlaceholder> Placeholders(string sql) => Placeholders(Tokenize(sql));

    public static List<PgPlaceholder> Placeholders(IReadOnlyList<SqlToken> tokens)
    {
        var result = new List<PgPlaceholder>();
        foreach (var st in Split(tokens))
        {
            var t = st.Tokens;
            if (t.Count > 0 && t[0].IsWord("PREPARE")) continue;
            // EXPLAIN (GENERIC_PLAN) plans the statement with its $n left unbound (PostgreSQL 16+).
            if (t.Count > 0 && t[0].IsWord("EXPLAIN") && t.Any(x => x.IsWord("GENERIC_PLAN"))) continue;
            var block = 0;
            for (var k = 0; k < t.Count; k++)
            {
                var tok = t[k];
                if (tok.Kind == SqlTokenKind.Word)
                {
                    if (tok.IsWord("BEGIN") && k + 1 < t.Count && t[k + 1].IsWord("ATOMIC")) block++;
                    else if (block > 0 && tok.IsWord("CASE")) block++;
                    else if (block > 0 && tok.IsWord("END")) block--;
                    continue;
                }
                if (tok.Kind != SqlTokenKind.Parameter || block > 0) continue;
                var positional = tok.Value[0] == '$';
                result.Add(new PgPlaceholder(tok.Value[1..], tok.Start, tok.End, positional));
            }
        }
        return result;
    }

    /// <summary>
    /// Rewrites every placeholder to positional <c>$k</c> (docs/PLAN-PG.md 2.4): an explicit <c>$n</c> keeps <c>n</c>;
    /// named placeholders get the next index not used by an explicit <c>$n</c>, in order of first appearance (the same
    /// name, case-insensitive, gets the same index). A pure function of the text, so error positions can be mapped back.
    /// </summary>
    public static PgRewrite Rewrite(string sql)
    {
        var placeholders = Placeholders(sql);
        if (placeholders.Count == 0) return new PgRewrite(sql, []);
        var used = new HashSet<int>();
        foreach (var p in placeholders.Where(p => p.Positional))
            if (int.TryParse(p.Name, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0) used.Add(n);
        var named = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var next = 1;
        var slots = new Dictionary<int, string>();
        foreach (var n in used) slots[n] = n.ToString(CultureInfo.InvariantCulture);
        var sb = new StringBuilder(sql.Length + 8);
        var last = 0;
        foreach (var p in placeholders)
        {
            int index;
            if (p.Positional)
            {
                if (!int.TryParse(p.Name, NumberStyles.None, CultureInfo.InvariantCulture, out index) || index <= 0) continue; // "$0": leave for the server
            }
            else if (!named.TryGetValue(p.Name, out index))
            {
                while (used.Contains(next)) next++;
                index = next;
                used.Add(index);
                named[p.Name] = index;
                slots[index] = p.Name;
            }
            sb.Append(sql, last, p.Start - last).Append('$').Append(index.ToString(CultureInfo.InvariantCulture));
            last = p.End;
        }
        sb.Append(sql, last, sql.Length - last);
        return new PgRewrite(sb.ToString(), slots.OrderBy(kv => kv.Key).Select(kv => new PgSlot(kv.Key, kv.Value)).ToList());
    }

    /// <summary>
    /// Maps a 1-based server position (<c>PostgresException.Position</c>) in <paramref name="sent"/> back to a 0-based
    /// offset in <paramref name="original"/> by walking both token streams in lockstep (they differ only in placeholder
    /// spelling). Positions inside a token keep their offset within the token (clamped to the original token); positions
    /// between tokens keep their distance from the previous token. Out-of-range positions are clamped.
    /// </summary>
    public static int MapPosition(string sent, string original, int position1)
    {
        var off = Math.Clamp(position1 - 1, 0, Math.Max(0, sent.Length));
        if (ReferenceEquals(sent, original) || sent == original) return Math.Clamp(off, 0, original.Length);
        var s = Tokenize(sent);
        var o = Tokenize(original);
        if (s.Count == 0 || o.Count == 0 || s.Count != o.Count) return Math.Clamp(off, 0, original.Length);
        if (off < s[0].Start) return Math.Clamp(o[0].Start - (s[0].Start - off), 0, original.Length);
        var k = 0;
        while (k + 1 < s.Count && s[k + 1].Start <= off) k++;
        var st = s[k];
        var ot = o[k];
        if (off < st.End)
            return Math.Clamp(ot.Start + Math.Min(off - st.Start, Math.Max(0, ot.End - ot.Start - 1)), 0, original.Length);
        var limit = k + 1 < o.Count ? o[k + 1].Start : original.Length;
        return Math.Clamp(ot.End + (off - st.End), 0, Math.Max(0, Math.Min(limit, original.Length)));
    }

    // ------------------------------------------------------------------ classification

    /// <summary>
    /// Statement classification with PostgreSQL rules: the text is masked (dollar/E/U&amp;/B/X strings become plain
    /// literals of the same length, comments blanks, <c>?</c> operators and brackets neutral) so the Core classifier sees
    /// the right statements, then PostgreSQL heads are refined: BEGIN/START/END/ABORT are transaction control, DO is a
    /// block, COPY is DML, SHOW/RESET/DISCARD are session statements, SELECT … INTO creates a table.
    /// </summary>
    public static BatchClassification Classify(string sql)
    {
        var tokens = Tokenize(sql);
        var masked = Mask(sql, tokens);
        var core = StatementClassifier.Classify(masked, Dialect.Sqlite);
        var statements = Split(tokens);
        var list = new List<StatementClassification>(core.Statements.Count);
        foreach (var s in core.Statements)
        {
            var st = statements.FirstOrDefault(x => x.Start <= s.StartOffset && s.StartOffset < x.End) ?? statements.FirstOrDefault(x => x.Start == s.StartOffset);
            list.Add(st is null ? s : Refine(s, st));
        }
        // A write keyword anywhere (SELECT … FOR UPDATE, EXPLAIN ANALYZE DELETE) or a statement that is not a query,
        // session or transaction statement (COPY, DO, CALL, REFRESH, LOCK …) makes the batch a non-query.
        var write = tokens.Any(t => t.Kind == SqlTokenKind.Word && WriteKeywords.Contains(t.Value))
                    || list.Any(s => s.Category is not (StatementCategory.Query or StatementCategory.Session or StatementCategory.Transaction));
        return new BatchClassification(list, write);
    }

    private static StatementClassification Refine(StatementClassification s, PgStatement st)
    {
        var t = st.Tokens;
        var i = 0;
        while (i < t.Count && t[i].IsPunct('(')) i++;
        if (i >= t.Count || t[i].Kind != SqlTokenKind.Word) return s;
        var u = t[i].Upper;
        switch (u)
        {
            case "BEGIN":
            case "START":
                return s with { Category = StatementCategory.Transaction, Kind = "BEGIN", Ddl = null };
            case "END":
                return s with { Category = StatementCategory.Transaction, Kind = "COMMIT", Ddl = null };
            case "ABORT":
                return s with { Category = StatementCategory.Transaction, Kind = "ROLLBACK", Ddl = null };
            case "COMMIT" when i + 1 < t.Count && t[i + 1].IsWord("PREPARED"):
            case "ROLLBACK" when i + 1 < t.Count && t[i + 1].IsWord("PREPARED"):
                return s with { Category = StatementCategory.Other, Kind = u + " PREPARED" };
            case "PREPARE" when i + 1 < t.Count && t[i + 1].IsWord("TRANSACTION"):
                return s with { Category = StatementCategory.Transaction, Kind = "PREPARE TRANSACTION" };
            case "DO":
                return s with { Category = StatementCategory.Block, Kind = "DO" };
            case "COPY":
                return s with { Category = StatementCategory.Dml, Kind = "COPY" };
            case "SHOW":
            case "RESET":
            case "DISCARD":
            case "SET":
                return s with { Category = StatementCategory.Session, Kind = u, Ddl = null };
            case "TABLE":
                return s with { Category = StatementCategory.Query, Kind = "TABLE" };
            case "SELECT" when HasSelectInto(t, i):
                return s with { Category = StatementCategory.Ddl, Kind = "SELECT INTO" };
            case "REFRESH":
            case "CLUSTER":
            case "LISTEN":
            case "UNLISTEN":
            case "NOTIFY":
            case "LOCK":
            case "VACUUM":
            case "ANALYZE":
            case "ANALYSE":
            case "CHECKPOINT":
            case "REINDEX":
            case "CALL":
            case "FETCH":
            case "MOVE":
            case "CLOSE":
            case "DEALLOCATE":
            case "LOAD":
                return s with { Category = StatementCategory.Other, Kind = u };
            case "PREPARE":
            case "EXECUTE":
                return s with { Category = StatementCategory.Other, Kind = u };
            default:
                return s;
        }
    }

    /// <summary><c>SELECT … INTO [TEMP|UNLOGGED] [TABLE] name FROM …</c> at depth 0 (creates a table in PostgreSQL).</summary>
    private static bool HasSelectInto(IReadOnlyList<SqlToken> t, int selectIndex)
    {
        var depth = 0;
        for (var k = selectIndex + 1; k < t.Count; k++)
        {
            var tok = t[k];
            if (tok.IsPunct('(') || tok.IsPunct('[')) depth++;
            else if (tok.IsPunct(')') || tok.IsPunct(']')) depth--;
            else if (depth == 0 && tok.Kind == SqlTokenKind.Word)
            {
                if (tok.Upper is "FROM" or "WHERE" or "UNION" or "EXCEPT" or "INTERSECT") return false;
                if (tok.Upper == "INTO") return true;
            }
        }
        return false;
    }

    /// <summary>The text with PostgreSQL-only lexemes neutralised for the Core tokenizer; every offset is preserved.</summary>
    public static string Mask(string sql, IReadOnlyList<SqlToken>? tokens = null)
    {
        tokens ??= Tokenize(sql);
        var chars = sql.ToCharArray();
        var pos = 0;
        foreach (var t in tokens)
        {
            Blank(chars, pos, t.Start); // whitespace and comments between tokens
            pos = t.End;
            switch (t.Kind)
            {
                case SqlTokenKind.String when chars[t.Start] != '\'' || t.End - t.Start < 2 || sql[t.End - 1] != '\'':
                case SqlTokenKind.String when t.Value.Contains('\\'):
                    chars[t.Start] = '\'';
                    Blank(chars, t.Start + 1, t.End - 1);
                    if (t.End - t.Start >= 2) chars[t.End - 1] = '\'';
                    else chars[t.Start] = ' ';
                    break;
                case SqlTokenKind.QuotedIdentifier when chars[t.Start] != '"':
                    // U&"x" → spaces + "x"
                    chars[t.Start] = ' ';
                    chars[t.Start + 1] = ' ';
                    break;
                case SqlTokenKind.Operator:
                    for (var k = t.Start; k < t.End; k++)
                        if (chars[k] is '?' or '`') chars[k] = '~';
                    break;
                case SqlTokenKind.Punct when t.Value == "[":
                    chars[t.Start] = '(';
                    break;
                case SqlTokenKind.Punct when t.Value == "]":
                    chars[t.Start] = ')';
                    break;
            }
        }
        Blank(chars, pos, chars.Length);
        return new string(chars);
    }

    private static void Blank(char[] chars, int from, int to)
    {
        for (var k = Math.Max(0, from); k < Math.Min(to, chars.Length); k++)
            if (chars[k] is not ('\n' or '\r')) chars[k] = ' ';
    }

    // ------------------------------------------------------------------ identifiers and literals

    /// <summary>Quotes unless the name is a plain lower-case identifier (<c>^[a-z_][a-z0-9_$]*$</c>) and not reserved.</summary>
    public static string Quote(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        if (IsPlain(name)) return name;
        return "\"" + name.Replace("\"", "\"\"") + "\"";
    }

    public static bool IsPlain(string name)
    {
        if (name.Length == 0 || !(name[0] is >= 'a' and <= 'z' or '_')) return false;
        foreach (var ch in name)
            if (!(ch is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '$')) return false;
        return !PgReservedWords.All.Contains(name);
    }

    public static string Qualify(string? schema, string name) =>
        string.IsNullOrEmpty(schema) ? Quote(name) : Quote(schema) + "." + Quote(name);

    /// <summary>A standard string literal ('' doubled; standard_conforming_strings keeps backslashes literal).</summary>
    public static string Literal(string value) => "'" + value.Replace("'", "''") + "'";
}
