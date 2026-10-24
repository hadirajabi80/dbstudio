using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.MySql;

/// <summary>Token kinds of the MySQL lexer (<see cref="MySqlSqlText.Scan"/>); comments and whitespace are skipped.</summary>
public enum MyTokenKind { Word, QuotedIdentifier, String, Number, Parameter, UserVariable, SystemVariable, Punct, Operator }

/// <param name="Start">0-based offset of the first char.</param>
/// <param name="End">0-based exclusive end.</param>
public readonly record struct MyToken(MyTokenKind Kind, string Text, int Start, int End)
{
    public bool IsWord(string upper) => Kind == MyTokenKind.Word && Text.Equals(upper, StringComparison.OrdinalIgnoreCase);
    public bool IsPunct(char c) => Kind == MyTokenKind.Punct && Text.Length == 1 && Text[0] == c;
    public string Upper => Text.ToUpperInvariant();

    /// <summary>The identifier value (backticks removed, doubled backticks undone); the text for other tokens.</summary>
    public string Value => Kind == MyTokenKind.QuotedIdentifier && Text.Length >= 2 ? Text[1..^1].Replace("``", "`") : Text;
}

/// <summary>One statement of a script: [Start, End) in the script text, without its delimiter.</summary>
/// <param name="Delimiter">The delimiter that ended it (";", "$$", "\G" …), null for the last statement without one.</param>
public sealed record MyStatement(int Start, int End, IReadOnlyList<MyToken> Tokens, string? Delimiter)
{
    public string Text(string script) => script[Start..End];
}

/// <summary>A bind placeholder: <c>:name</c>, <c>@name</c> (only bound when a value exists: else a user variable) or <c>?</c>.</summary>
/// <param name="Name">Bare name; null for <c>?</c>.</param>
/// <param name="Prefix">':' | '@' | '?'.</param>
public readonly record struct MyPlaceholder(string? Name, char Prefix, int Start, int End);

/// <summary>
/// MySQL / MariaDB lexical helpers (plan-batch3 WP-MY): a lexer that knows backtick identifiers, <c>#</c> and
/// <c>-- </c> comments, backslash escapes in <c>'…'</c> and <c>"…"</c>, <c>@user</c> / <c>@@system</c> variables and
/// <c>:=</c>; a statement splitter that honours the mysql client's <c>DELIMITER xx</c> lines, keeps stored-program bodies
/// (<c>BEGIN … END</c>, <c>IF … END IF</c>, <c>LOOP</c>, <c>WHILE</c>, <c>REPEAT</c>, <c>CASE</c>, labels) whole and ends
/// statements at <c>\G</c>; placeholders, quoting and literals.
/// </summary>
public static class MySqlSqlText
{
    // ------------------------------------------------------------------ lexer

    /// <summary>Significant tokens of <paramref name="sql"/> (comments and whitespace skipped). Never throws.</summary>
    public static List<MyToken> Scan(string sql) => Scan(sql, 0, sql.Length);

    public static List<MyToken> Scan(string sql, int from, int to)
    {
        var tokens = new List<MyToken>(Math.Max(8, (to - from) / 5));
        var i = from;
        while (i < to)
        {
            var next = SkipTrivia(sql, i, to);
            if (next >= to) break;
            i = next;
            var t = ReadToken(sql, i, to);
            tokens.Add(t);
            i = t.End;
        }
        return tokens;
    }

    /// <summary>Skips whitespace and comments from <paramref name="i"/>; returns the next significant offset.</summary>
    public static int SkipTrivia(string sql, int i, int to)
    {
        while (i < to)
        {
            var c = sql[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '#' || (c == '-' && i + 1 < to && sql[i + 1] == '-' && (i + 2 >= to || char.IsWhiteSpace(sql[i + 2]) || char.IsControl(sql[i + 2]))))
            {
                while (i < to && sql[i] != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < to && sql[i + 1] == '*')
            {
                var end = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = end < 0 || end + 2 > to ? to : end + 2;
                continue;
            }
            break;
        }
        return i;
    }

    private static MyToken ReadToken(string sql, int i, int to)
    {
        var c = sql[i];
        var start = i;
        if (c is '\'' or '"')
        {
            i = ReadString(sql, i, to, c);
            return new MyToken(MyTokenKind.String, sql[start..i], start, i);
        }
        if (c == '`')
        {
            i++;
            while (i < to)
            {
                if (sql[i] == '`')
                {
                    if (i + 1 < to && sql[i + 1] == '`') { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            return new MyToken(MyTokenKind.QuotedIdentifier, sql[start..i], start, i);
        }
        // N'…', X'…', B'…', _utf8mb4'…' (charset introducer)
        if (c is 'N' or 'n' or 'X' or 'x' or 'B' or 'b' && i + 1 < to && sql[i + 1] == '\'')
        {
            i = ReadString(sql, i + 1, to, '\'');
            return new MyToken(MyTokenKind.String, sql[start..i], start, i);
        }
        if (c == '_' && i + 1 < to && char.IsLetter(sql[i + 1]))
        {
            var j = i + 1;
            while (j < to && (char.IsLetterOrDigit(sql[j]) || sql[j] == '_')) j++;
            if (j < to && sql[j] == '\'')
            {
                i = ReadString(sql, j, to, '\'');
                return new MyToken(MyTokenKind.String, sql[start..i], start, i);
            }
        }
        if (char.IsDigit(c) || (c == '.' && i + 1 < to && char.IsDigit(sql[i + 1])))
        {
            i++;
            while (i < to && (char.IsLetterOrDigit(sql[i]) || sql[i] == '.' || ((sql[i] is '+' or '-') && sql[i - 1] is 'e' or 'E' && !sql[start..i].StartsWith("0x", StringComparison.OrdinalIgnoreCase))))
                i++;
            // 1e5 / 0x1F / 12.5; an identifier may start with digits (1abc): keep it a word then.
            var text = sql[start..i];
            var kind = text.All(ch => char.IsDigit(ch) || ch is '.' or 'e' or 'E' or '+' or '-') || text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                       || text.StartsWith("0b", StringComparison.OrdinalIgnoreCase)
                ? MyTokenKind.Number : MyTokenKind.Word;
            return new MyToken(kind, text, start, i);
        }
        if (IsWordStart(c))
        {
            i++;
            while (i < to && IsWordPart(sql[i])) i++;
            return new MyToken(MyTokenKind.Word, sql[start..i], start, i);
        }
        if (c == '@')
        {
            if (i + 1 < to && sql[i + 1] == '@')
            {
                i += 2;
                // @@session.x / @@global.x / @@x
                while (i < to && (IsWordPart(sql[i]) || sql[i] == '.')) i++;
                return new MyToken(MyTokenKind.SystemVariable, sql[start..i], start, i);
            }
            if (i + 1 < to && sql[i + 1] is '\'' or '"' or '`')
            {
                var q = sql[i + 1];
                i = q == '`' ? ReadToken(sql, i + 1, to).End : ReadString(sql, i + 1, to, q);
                return new MyToken(MyTokenKind.UserVariable, sql[start..i], start, i);
            }
            if (i + 1 < to && (IsWordPart(sql[i + 1]) || sql[i + 1] == '.'))
            {
                i++;
                while (i < to && (IsWordPart(sql[i]) || sql[i] == '.')) i++;
                return new MyToken(MyTokenKind.UserVariable, sql[start..i], start, i);
            }
        }
        if (c == ':' && i + 1 < to && sql[i + 1] != '=' && (char.IsLetter(sql[i + 1]) || sql[i + 1] == '_')
            && !(i > 0 && (sql[i - 1] == ':' || IsWordPart(sql[i - 1]) || sql[i - 1] == '`')))
        {
            i++;
            while (i < to && IsWordPart(sql[i])) i++;
            return new MyToken(MyTokenKind.Parameter, sql[start..i], start, i);
        }
        if (c == '?')
        {
            return new MyToken(MyTokenKind.Parameter, "?", start, i + 1);
        }
        if (c is '(' or ')' or ',' or '.' or ';')
            return new MyToken(MyTokenKind.Punct, c.ToString(), start, i + 1);
        // operators: <=> ->> := -> << >> <= >= <> != && ||
        if (i + 2 < to && (sql.AsSpan(i, 3) is "<=>" or "->>")) return new MyToken(MyTokenKind.Operator, sql.Substring(i, 3), start, i + 3);
        if (i + 1 < to && sql.AsSpan(i, 2) is ":=" or "->" or "<<" or ">>" or "<=" or ">=" or "<>" or "!=" or "&&" or "||")
            return new MyToken(MyTokenKind.Operator, sql.Substring(i, 2), start, i + 2);
        return new MyToken(MyTokenKind.Operator, c.ToString(), start, i + 1);
    }

    /// <summary>Reads a '…' / "…" string from the opening quote: backslash escapes, doubled quotes. Returns the end offset.</summary>
    private static int ReadString(string sql, int i, int to, char quote)
    {
        i++;
        while (i < to)
        {
            var ch = sql[i];
            if (ch == '\\') { i += 2; continue; }
            if (ch == quote)
            {
                if (i + 1 < to && sql[i + 1] == quote) { i += 2; continue; }
                return i + 1;
            }
            i++;
        }
        return to;
    }

    private static bool IsWordStart(char c) => char.IsLetter(c) || c == '_' || c == '$' || (c > 127 && char.IsLetterOrDigit(c));

    private static bool IsWordPart(char c) => char.IsLetterOrDigit(c) || c is '_' or '$';

    // ------------------------------------------------------------------ splitter

    private static readonly HashSet<string> RoutineObjects = new(StringComparer.OrdinalIgnoreCase) { "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT" };

    /// <summary>Words after which a word is at the start of a statement inside a stored-program body.</summary>
    private static readonly HashSet<string> StatementPositionWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "BEGIN", "THEN", "ELSE", "DO", "LOOP", "REPEAT", "ROW",
    };

    private static readonly HashSet<string> ControlOpeners = new(StringComparer.OrdinalIgnoreCase) { "IF", "LOOP", "WHILE", "REPEAT" };

    /// <summary>
    /// Splits a script into statements. <c>DELIMITER xx</c> lines (the mysql client command) switch the delimiter and are
    /// not statements; with the default <c>;</c>, stored-program bodies and MariaDB compound statements stay whole.
    /// <c>\G</c> / <c>\g</c> end a statement too. Statement text excludes the delimiter.
    /// </summary>
    public static List<MyStatement> Split(string sql)
    {
        var result = new List<MyStatement>();
        var delimiter = ";";
        var n = sql.Length;
        var i = 0;
        while (i < n)
        {
            i = SkipTrivia(sql, i, n);
            if (i >= n) break;
            // DELIMITER at a statement boundary (only at the start of a line).
            if (TryDelimiterLine(sql, i, out var newDelimiter, out var lineEnd))
            {
                delimiter = newDelimiter;
                i = lineEnd;
                continue;
            }
            var (end, next, used, tokens) = ReadStatement(sql, i, delimiter);
            if (tokens.Count > 0) result.Add(new MyStatement(i, TrimEnd(sql, i, end), tokens, used));
            i = next;
        }
        return result;
    }

    private static int TrimEnd(string sql, int start, int end)
    {
        while (end > start && char.IsWhiteSpace(sql[end - 1])) end--;
        return end;
    }

    /// <summary>"DELIMITER $$" at a line start (case-insensitive): the delimiter is the rest of the line up to whitespace.</summary>
    internal static bool TryDelimiterLine(string sql, int i, out string delimiter, out int lineEnd)
    {
        delimiter = "";
        lineEnd = i;
        const string word = "DELIMITER";
        if (i + word.Length >= sql.Length || string.Compare(sql, i, word, 0, word.Length, StringComparison.OrdinalIgnoreCase) != 0) return false;
        if (!char.IsWhiteSpace(sql[i + word.Length]) || sql[i + word.Length] == '\n') return false;
        // must start its line
        var k = i - 1;
        while (k >= 0 && sql[k] is ' ' or '\t' or '\r') k--;
        if (k >= 0 && sql[k] != '\n') return false;
        var j = i + word.Length;
        while (j < sql.Length && sql[j] is ' ' or '\t') j++;
        var s = j;
        while (j < sql.Length && !char.IsWhiteSpace(sql[j])) j++;
        if (j == s) return false;
        delimiter = sql[s..j];
        var eol = sql.IndexOf('\n', j);
        lineEnd = eol < 0 ? sql.Length : eol + 1;
        return true;
    }

    /// <summary>Reads one statement from <paramref name="start"/>; returns its end (before the delimiter), the offset after the delimiter, the delimiter and its tokens.</summary>
    private static (int End, int Next, string? Delimiter, List<MyToken> Tokens) ReadStatement(string sql, int start, string delimiter)
    {
        var tokens = new List<MyToken>();
        var n = sql.Length;
        var custom = delimiter != ";";
        var depth = 0;
        var block = false;
        var i = start;
        while (i < n)
        {
            var t0 = SkipTrivia(sql, i, n);
            // \G / \g terminators
            if (t0 + 1 < n && sql[t0] == '\\' && sql[t0 + 1] is 'G' or 'g' && depth == 0)
                return (t0, t0 + 2, "\\" + sql[t0 + 1], tokens);
            if (custom && t0 < n && string.CompareOrdinal(sql, t0, delimiter, 0, delimiter.Length) == 0)
                return (t0, t0 + delimiter.Length, delimiter, tokens);
            if (t0 >= n) return (n, n, null, tokens);
            // a DELIMITER line inside an unterminated statement still switches (the mysql client does the same)
            if (tokens.Count > 0 && depth == 0 && TryDelimiterLine(sql, t0, out _, out _))
                return (t0, t0, null, tokens);
            var t = ReadToken(sql, t0, n);
            // A custom delimiter can be glued to a word or operator ("END$$", "1//"): cut the token there.
            if (custom && t.Kind is MyTokenKind.Word or MyTokenKind.Number or MyTokenKind.Operator or MyTokenKind.UserVariable)
            {
                var cut = sql.IndexOf(delimiter, t.Start + 1, t.End - t.Start - 1, StringComparison.Ordinal);
                if (cut > t.Start) t = t with { Text = sql[t.Start..cut], End = cut };
            }
            i = t.End;
            if (!custom && t.IsPunct(';') && depth == 0) return (t.Start, t.End, ";", tokens);
            if (tokens.Count == 0) block = StartsBlock(sql, t, t0);
            if (block && t.Kind == MyTokenKind.Word)
            {
                var u = t.Upper;
                var prev = tokens.Count > 0 ? tokens[^1] : default;
                var statementPosition = tokens.Count == 0 || prev.IsPunct(';') || (prev.Kind == MyTokenKind.Word && StatementPositionWords.Contains(prev.Text))
                                        || (prev.Kind == MyTokenKind.Operator && prev.Text == ":" );
                if (u == "BEGIN" && !(tokens.Count == 0 && !NextIsNotAtomic(sql, t.End)))
                    depth++;
                else if (u == "CASE")
                    depth++;
                else if (ControlOpeners.Contains(u) && statementPosition && !NextIsParen(sql, t.End))
                    depth++;
                else if (u == "END" && depth > 0)
                {
                    depth--;
                    tokens.Add(t);
                    // END IF / END LOOP / END WHILE / END REPEAT / END CASE close what they name, not an extra level.
                    var after = SkipTrivia(sql, i, n);
                    if (after < n && !(custom && string.CompareOrdinal(sql, after, delimiter, 0, delimiter.Length) == 0))
                    {
                        var nt = ReadToken(sql, after, n);
                        if (nt.Kind == MyTokenKind.Word && nt.Upper is "IF" or "LOOP" or "WHILE" or "REPEAT" or "CASE")
                        {
                            tokens.Add(nt);
                            i = nt.End;
                        }
                    }
                    continue;
                }
            }
            tokens.Add(t);
        }
        return (n, n, null, tokens);
    }

    private static bool NextIsParen(string sql, int i)
    {
        var j = SkipTrivia(sql, i, sql.Length);
        return j < sql.Length && sql[j] == '(';
    }

    private static bool NextIsNotAtomic(string sql, int i)
    {
        var j = SkipTrivia(sql, i, sql.Length);
        return j + 3 <= sql.Length && string.Compare(sql, j, "NOT", 0, 3, StringComparison.OrdinalIgnoreCase) == 0
               && (j + 3 == sql.Length || !IsWordPart(sql[j + 3]));
    }

    /// <summary>
    /// Whether the statement starting with <paramref name="first"/> may contain a compound body: CREATE [OR REPLACE]
    /// [DEFINER = …] [AGGREGATE] PROCEDURE | FUNCTION | TRIGGER | EVENT, ALTER EVENT, BEGIN NOT ATOMIC, a labelled block
    /// and the MariaDB top-level IF / CASE / LOOP / WHILE / REPEAT.
    /// </summary>
    private static bool StartsBlock(string sql, MyToken first, int at)
    {
        if (first.Kind != MyTokenKind.Word && first.Kind != MyTokenKind.QuotedIdentifier) return false;
        var u = first.Upper;
        if (u is "BEGIN") return NextIsNotAtomic(sql, first.End);
        if (u is "IF" or "CASE" or "LOOP" or "WHILE" or "REPEAT") return !NextIsParen(sql, first.End) || u is "IF" or "WHILE";
        if (u is "CREATE" or "ALTER")
        {
            var head = Scan(sql, at, Math.Min(sql.Length, at + 400));
            foreach (var t in SkipDefiner(head, 1))
            {
                if (t.Kind != MyTokenKind.Word) return false;
                if (RoutineObjects.Contains(t.Text)) return true;
                if (t.Upper is not ("OR" or "REPLACE" or "AGGREGATE" or "SQL" or "SECURITY" or "DEFINER" or "INVOKER" or "IF" or "NOT" or "EXISTS")) return false;
            }
            return false;
        }
        // lbl: BEGIN / lbl: LOOP …
        var j = SkipTrivia(sql, first.End, sql.Length);
        return j < sql.Length && sql[j] == ':' && (j + 1 >= sql.Length || sql[j + 1] != '=');
    }

    /// <summary>Tokens from <paramref name="from"/> with a <c>DEFINER = user@host</c> / <c>DEFINER = CURRENT_USER[()]</c> clause removed.</summary>
    public static IEnumerable<MyToken> SkipDefiner(IReadOnlyList<MyToken> tokens, int from)
    {
        for (var i = from; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.IsWord("DEFINER") && i + 1 < tokens.Count && tokens[i + 1].Kind == MyTokenKind.Operator && tokens[i + 1].Text == "=")
            {
                i += 2; // the user
                if (i < tokens.Count && tokens[i].IsWord("CURRENT_USER"))
                {
                    if (i + 2 < tokens.Count && tokens[i + 1].IsPunct('(') && tokens[i + 2].IsPunct(')')) i += 2;
                    continue;
                }
                // 'user'@'host' | `user`@`host` | user@host (lexed as word + user variable)
                if (i + 1 < tokens.Count && tokens[i + 1].Kind == MyTokenKind.UserVariable) i++;
                continue;
            }
            yield return t;
        }
    }

    // ------------------------------------------------------------------ classification

    /// <summary>
    /// Classifies a batch statement by statement with this splitter (stored-program bodies stay whole, DELIMITER is
    /// honoured), then the shared classifier per statement.
    /// </summary>
    public static BatchClassification Classify(string sql)
    {
        var statements = Split(sql);
        var list = new List<StatementClassification>(statements.Count);
        var write = false;
        foreach (var st in statements)
        {
            var text = st.Text(sql);
            var c = StatementClassifier.Classify(StripDefiner(text), Dialect.MySql);
            var head = c.Statements.FirstOrDefault();
            if (head is null) continue;
            list.Add(head with { StartOffset = st.Start + head.StartOffset });
            if (!c.IsQueryOnly) write = true;
        }
        return new BatchClassification(list, write);
    }

    /// <summary>The statement text with its DEFINER clause blanked out (same length, so offsets stay valid).</summary>
    public static string StripDefiner(string statement)
    {
        var tokens = Scan(statement);
        if (tokens.Count < 4 || !(tokens[0].IsWord("CREATE") || tokens[0].IsWord("ALTER"))) return statement;
        var idx = tokens.FindIndex(t => t.IsWord("DEFINER"));
        if (idx < 1 || idx > 4) return statement;
        var kept = SkipDefiner(tokens, idx).FirstOrDefault();
        if (kept == default) return statement;
        var sb = new StringBuilder(statement);
        for (var k = tokens[idx].Start; k < kept.Start; k++) if (!char.IsWhiteSpace(sb[k])) sb[k] = ' ';
        return sb.ToString();
    }

    // ------------------------------------------------------------------ placeholders

    /// <summary>
    /// Placeholders in order of appearance: <c>:name</c> (never <c>:=</c>), <c>@name</c> (a user variable unless a value is
    /// bound for it) and <c>?</c>; none inside strings, comments or backticks; <c>@@sysvar</c> never.
    /// </summary>
    public static List<MyPlaceholder> Placeholders(string sql)
    {
        var list = new List<MyPlaceholder>();
        foreach (var t in Scan(sql))
        {
            switch (t.Kind)
            {
                case MyTokenKind.Parameter when t.Text == "?":
                    list.Add(new MyPlaceholder(null, '?', t.Start, t.End));
                    break;
                case MyTokenKind.Parameter:
                    list.Add(new MyPlaceholder(t.Text[1..], ':', t.Start, t.End));
                    break;
                case MyTokenKind.UserVariable when t.Text.Length > 1 && t.Text[1] is not ('\'' or '"' or '`') && !t.Text.Contains('.'):
                    list.Add(new MyPlaceholder(t.Text[1..], '@', t.Start, t.End));
                    break;
            }
        }
        return list;
    }

    // ------------------------------------------------------------------ quoting

    private static readonly System.Text.RegularExpressions.Regex Plain = new("^[A-Za-z_][A-Za-z0-9_$]*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>`name` with backticks doubled (always quoted: MySQL has many reserved words and case rules).</summary>
    public static string Quote(string name) => "`" + name.Replace("`", "``") + "`";

    /// <summary>Unquoted when it is a plain identifier that is not reserved.</summary>
    public static string QuoteIfNeeded(string name) =>
        Plain.IsMatch(name) && !MySqlReservedWords.All.Contains(name) ? name : Quote(name);

    public static string Qualify(string? schema, string name) =>
        string.IsNullOrEmpty(schema) ? Quote(name) : Quote(schema) + "." + Quote(name);

    /// <summary>'it''s' with backslashes doubled (backslash escapes are on unless NO_BACKSLASH_ESCAPES).</summary>
    public static string Literal(string? s) => s is null ? "NULL" : "'" + s.Replace("\\", "\\\\").Replace("'", "''") + "'";

    /// <summary>1-based (line, col) of a 0-based offset.</summary>
    public static (int Line, int Col) LineColAt(string text, int offset) => SqlTokenizer.LineColAt(text, offset);

    /// <summary>1-based line of the first significant token (1 when none).</summary>
    public static int FirstTokenLine(string sql)
    {
        var i = SkipTrivia(sql, 0, sql.Length);
        return i >= sql.Length ? 1 : LineColAt(sql, i).Line;
    }

    /// <summary>"5.7.44-log" → (5, 7); "11.4.2-MariaDB-ubu2404" → (11, 4).</summary>
    public static (int Major, int Minor, int Patch) ParseVersion(string? version)
    {
        if (string.IsNullOrWhiteSpace(version)) return (0, 0, 0);
        var v = version.Trim();
        // MariaDB 10.x before 11 reported "5.5.5-10.6.12-MariaDB" through the protocol
        if (v.StartsWith("5.5.5-", StringComparison.Ordinal)) v = v[6..];
        var parts = v.Split('-', 2)[0].Split('.');
        static int P(string[] p, int i) => i < p.Length && int.TryParse(new string(p[i].TakeWhile(char.IsDigit).ToArray()), NumberStyles.Integer, CultureInfo.InvariantCulture, out var x) ? x : 0;
        return (P(parts, 0), P(parts, 1), P(parts, 2));
    }
}
