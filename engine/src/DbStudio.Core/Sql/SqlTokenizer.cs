using DbStudio.Core.Models;

namespace DbStudio.Core.Sql;

public enum SqlTokenKind
{
    /// <summary>Unquoted identifier or keyword (also T-SQL @var / #temp, Oracle bind :x is <see cref="Parameter"/>).</summary>
    Word,
    /// <summary>"x", [x] or `x`; <see cref="SqlToken.Value"/> holds the unquoted name.</summary>
    QuotedIdentifier,
    String,
    Number,
    Parameter,
    /// <summary>Single punctuation char: ( ) , . ;</summary>
    Punct,
    Operator,
}

/// <param name="Start">0-based offset of the first char.</param>
/// <param name="End">0-based exclusive end offset.</param>
/// <param name="Line">1-based line of the first char (relative to the tokenized text).</param>
/// <param name="Col">1-based column of the first char.</param>
public readonly record struct SqlToken(SqlTokenKind Kind, string Value, int Start, int End, int Line, int Col)
{
    public bool IsWord(string upper) => Kind == SqlTokenKind.Word && Value.Equals(upper, StringComparison.OrdinalIgnoreCase);
    public bool IsPunct(char c) => Kind == SqlTokenKind.Punct && Value.Length == 1 && Value[0] == c;
    public bool IsIdentifier => Kind is SqlTokenKind.Word or SqlTokenKind.QuotedIdentifier;
    public string Upper => Value.ToUpperInvariant();
}

/// <summary>
/// Small, dialect-aware SQL tokenizer used by the engine (statement classification, read-only guard,
/// SQLite diagnostics). Comments and whitespace are skipped. Never throws: unterminated strings,
/// comments and quoted identifiers simply extend to the end of the text.
/// </summary>
public static class SqlTokenizer
{
    public static List<SqlToken> Tokenize(string sql, Dialect dialect)
    {
        var tokens = new List<SqlToken>(Math.Max(8, sql.Length / 5));
        var i = 0;
        var line = 1;
        var lineStart = 0;
        var n = sql.Length;

        while (i < n)
        {
            var c = sql[i];

            if (c == '\n') { i++; line++; lineStart = i; continue; }
            if (char.IsWhiteSpace(c)) { i++; continue; }

            // -- line comment
            if (c == '-' && i + 1 < n && sql[i + 1] == '-')
            {
                while (i < n && sql[i] != '\n') i++;
                continue;
            }

            // # line comment (MySQL, ClickHouse)
            if (c == '#' && DialectInfo.HashLineComments(dialect))
            {
                while (i < n && sql[i] != '\n') i++;
                continue;
            }

            // /* block comment */ (T-SQL allows nesting)
            if (c == '/' && i + 1 < n && sql[i + 1] == '*')
            {
                var depth = 1;
                i += 2;
                while (i < n && depth > 0)
                {
                    if (sql[i] == '\n') { line++; lineStart = i + 1; i++; continue; }
                    if (DialectInfo.NestedBlockComments(dialect) && sql[i] == '/' && i + 1 < n && sql[i + 1] == '*') { depth++; i += 2; continue; }
                    if (sql[i] == '*' && i + 1 < n && sql[i + 1] == '/') { depth--; i += 2; continue; }
                    i++;
                }
                continue;
            }

            var start = i;
            var tokLine = line;
            var tokCol = i - lineStart + 1;

            // Oracle q-quoted strings: q'[...]', Q'{...}', nq'<...>'
            if (dialect == Dialect.PlSql && (c is 'q' or 'Q' || ((c is 'n' or 'N') && i + 1 < n && sql[i + 1] is 'q' or 'Q'))
                && TryOracleQString(sql, ref i, ref line, ref lineStart))
            {
                tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            if (dialect == Dialect.PgSql)
            {
                // PostgreSQL: E'..' (backslash escapes), U&'..'.
                if (c is 'E' or 'e' && i + 1 < n && sql[i + 1] == '\'')
                {
                    i++;
                    ReadEscapeString(sql, ref i, ref line, ref lineStart);
                    tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                    continue;
                }
                if (c is 'U' or 'u' && i + 2 < n && sql[i + 1] == '&' && sql[i + 2] == '\'')
                {
                    i += 2;
                    ReadQuoted(sql, ref i, '\'', ref line, ref lineStart);
                    tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                    continue;
                }
            }

            // $$..$$ / $tag$..$tag$ dollar quoting (PostgreSQL and Snowflake function bodies).
            if (c == '$' && DialectInfo.DollarQuotedStrings(dialect) && TryDollarQuote(sql, ref i, ref line, ref lineStart))
            {
                tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            // N'..' (T-SQL/Oracle national), X'..' (SQLite blob / PostgreSQL hex bit string), B'..' (PostgreSQL bit string) prefixes
            if (((c is 'N' or 'n' or 'X' or 'x') || (dialect == Dialect.PgSql && c is 'B' or 'b')) && i + 1 < n && sql[i + 1] == '\'')
            {
                i++;
                ReadQuoted(sql, ref i, '\'', ref line, ref lineStart);
                tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            if (c == '\'')
            {
                // MySQL, ClickHouse, Snowflake: a backslash escapes the next char ('' still doubles).
                if (DialectInfo.BackslashStringEscapes(dialect)) ReadEscapeString(sql, ref i, ref line, ref lineStart);
                else ReadQuoted(sql, ref i, '\'', ref line, ref lineStart);
                tokens.Add(new SqlToken(SqlTokenKind.String, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            // [ is a quoted identifier in T-SQL/SQLite, an array subscript in PostgreSQL.
            if (c == '"' || (c == '[' && dialect is Dialect.TSql or Dialect.Sqlite) || (c == '`' && DialectInfo.BacktickIdentifiers(dialect)))
            {
                var close = c == '[' ? ']' : c;
                ReadQuoted(sql, ref i, close, ref line, ref lineStart);
                var inner = sql.Substring(start + 1, Math.Max(0, i - start - 2));
                var doubled = new string(close, 2);
                tokens.Add(new SqlToken(SqlTokenKind.QuotedIdentifier, inner.Replace(doubled, close.ToString()), start, i, tokLine, tokCol));
                continue;
            }

            if (char.IsDigit(c) || (c == '.' && i + 1 < n && char.IsDigit(sql[i + 1])))
            {
                i++;
                while (i < n && (char.IsLetterOrDigit(sql[i]) || sql[i] == '.' ||
                                 ((sql[i] == '+' || sql[i] == '-') && (sql[i - 1] == 'e' || sql[i - 1] == 'E'))))
                    i++;
                tokens.Add(new SqlToken(SqlTokenKind.Number, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            if (IsWordStart(c, dialect))
            {
                i++;
                while (i < n && IsWordPart(sql[i])) i++;
                // T-SQL @@ROWCOUNT, ##global temp
                tokens.Add(new SqlToken(SqlTokenKind.Word, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            // PostgreSQL: ? ?| ?& are jsonb operators, never placeholders.
            if ((c == ':' || (c == '?' && dialect != Dialect.PgSql) || c == '$' || (c == '@' && dialect != Dialect.TSql)) && i + 1 < n
                && (IsWordPart(sql[i + 1]) || char.IsDigit(sql[i + 1])) && !(c == ':' && i > 0 && sql[i - 1] == ':')
                // PostgreSQL: $1 (digits), :name / @name (letter or _): arr[1:3] and @> stay operators.
                && (dialect != Dialect.PgSql || (c == '$' ? char.IsAsciiDigit(sql[i + 1]) : char.IsLetter(sql[i + 1]) || sql[i + 1] == '_')))
            {
                i++;
                while (i < n && IsWordPart(sql[i])) i++;
                tokens.Add(new SqlToken(SqlTokenKind.Parameter, sql[start..i], start, i, tokLine, tokCol));
                continue;
            }

            if (c == '?' && dialect != Dialect.PgSql)
            {
                i++;
                tokens.Add(new SqlToken(SqlTokenKind.Parameter, "?", start, i, tokLine, tokCol));
                continue;
            }

            if (c is '(' or ')' or ',' or '.' or ';' || (dialect == Dialect.PgSql && c is '[' or ']'))
            {
                i++;
                tokens.Add(new SqlToken(SqlTokenKind.Punct, c.ToString(), start, i, tokLine, tokCol));
                continue;
            }

            i++;
            // Group common two-char operators.
            if (i < n && IsOperatorPair(c, sql[i])) i++;
            tokens.Add(new SqlToken(SqlTokenKind.Operator, sql[start..i], start, i, tokLine, tokCol));
        }

        return tokens;
    }

    private static bool IsWordStart(char c, Dialect d) =>
        char.IsLetter(c) || c == '_' || (d == Dialect.TSql && (c == '@' || c == '#')) || (d == Dialect.PlSql && c == '#') || c > 127 && char.IsLetterOrDigit(c);

    private static bool IsWordPart(char c) => char.IsLetterOrDigit(c) || c is '_' or '$' or '#' or '@';

    private static bool IsOperatorPair(char a, char b) =>
        (a, b) is ('<', '=') or ('>', '=') or ('<', '>') or ('!', '=') or ('|', '|') or (':', '=') or ('=', '>') or ('-', '>') or ('<', '<') or ('>', '>') or (':', ':');

    private static void ReadQuoted(string sql, ref int i, char close, ref int line, ref int lineStart)
    {
        // i points at the opening quote.
        i++;
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

    /// <summary>PostgreSQL E'…': a backslash escapes the next char; '' still doubles. i points at the opening quote.</summary>
    private static void ReadEscapeString(string sql, ref int i, ref int line, ref int lineStart)
    {
        i++;
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

    /// <summary>PostgreSQL $$…$$ / $tag$…$tag$ (tag = [A-Za-z_][A-Za-z0-9_]*); false when '$' does not open one ($1 is a parameter).</summary>
    private static bool TryDollarQuote(string sql, ref int i, ref int line, ref int lineStart)
    {
        var j = i + 1;
        if (j < sql.Length && sql[j] != '$')
        {
            if (!(char.IsLetter(sql[j]) || sql[j] == '_')) return false;
            j++;
            while (j < sql.Length && (char.IsLetterOrDigit(sql[j]) || sql[j] == '_')) j++;
            if (j >= sql.Length || sql[j] != '$') return false;
        }
        if (j >= sql.Length) return false;
        var tag = sql[i..(j + 1)];
        var close = sql.IndexOf(tag, j + 1, StringComparison.Ordinal);
        var end = close < 0 ? sql.Length : close + tag.Length;
        for (var k = i; k < end; k++)
            if (sql[k] == '\n') { line++; lineStart = k + 1; }
        i = end;
        return true;
    }

    private static bool TryOracleQString(string sql, ref int i, ref int line, ref int lineStart)
    {
        var p = i;
        if (sql[p] is 'n' or 'N') p++;
        if (p + 2 >= sql.Length || sql[p] is not ('q' or 'Q') || sql[p + 1] != '\'') return false;
        var open = sql[p + 2];
        if (char.IsWhiteSpace(open)) return false;
        var close = open switch { '[' => ']', '{' => '}', '<' => '>', '(' => ')', _ => open };
        var j = p + 3;
        while (j < sql.Length)
        {
            if (sql[j] == '\n') { line++; lineStart = j + 1; }
            if (sql[j] == close && j + 1 < sql.Length && sql[j + 1] == '\'') { i = j + 2; return true; }
            j++;
        }
        i = sql.Length;
        return true;
    }

    /// <summary>
    /// Splits tokens into statements at depth-0 semicolons. SQLite <c>CREATE TRIGGER ... BEGIN ... END</c> bodies and
    /// PL/SQL blocks (<c>BEGIN/DECLARE/CREATE PROCEDURE...</c>) are kept together.
    /// </summary>
    public static List<List<SqlToken>> SplitStatements(IReadOnlyList<SqlToken> tokens, Dialect dialect)
    {
        var result = new List<List<SqlToken>>();
        var current = new List<SqlToken>();
        var parenDepth = 0;
        var blockDepth = 0;
        var isBlockStatement = false;
        var declares = 0; // Snowflake Scripting: DECLARE sections whose BEGIN has not been seen yet

        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (current.Count == 0)
            {
                isBlockStatement = StartsBlock(tokens, k, dialect);
                declares = 0;
            }

            if (t.IsPunct('(')) parenDepth++;
            else if (t.IsPunct(')')) parenDepth = Math.Max(0, parenDepth - 1);
            else if (dialect == Dialect.PgSql)
            {
                // Dollar-quoted bodies are single tokens; only SQL-standard bodies (BEGIN ATOMIC … END, PG14+) nest.
                if (t.IsWord("BEGIN") && k + 1 < tokens.Count && tokens[k + 1].IsWord("ATOMIC")) blockDepth++;
                else if (blockDepth > 0 && t.IsWord("CASE")) blockDepth++;
                else if (blockDepth > 0 && t.IsWord("END")) blockDepth--;
            }
            else if (dialect == Dialect.Cql)
            {
                // WP-CS begin (CQL: BEGIN [UNLOGGED|COUNTER] BATCH … APPLY BATCH is one statement)
                if (t.IsWord("BEGIN") && k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "BATCH" or "UNLOGGED" or "COUNTER") blockDepth++;
                else if (blockDepth > 0 && t.IsWord("APPLY") && k + 1 < tokens.Count && tokens[k + 1].IsWord("BATCH")) blockDepth--;
                // WP-CS end
            }
            else if (isBlockStatement && dialect is Dialect.MySql or Dialect.Snowflake)
            {
                ScriptBlockStep(tokens, ref k, dialect, ref blockDepth, ref declares);
            }
            else if (isBlockStatement && t.Kind == SqlTokenKind.Word)
            {
                var u = t.Upper;
                if (u is "BEGIN" || (u is "CASE" && !PrevIsEnd(tokens, k)) || (u is "IF" or "LOOP" && dialect == Dialect.PlSql && !PrevIsEnd(tokens, k)))
                    blockDepth++;
                else if (u == "END" && blockDepth > 0)
                {
                    blockDepth--;
                    // END IF / END LOOP / END CASE close what IF/LOOP/CASE opened, not an extra level.
                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE")
                        k++;
                }
            }

            if (t.IsPunct(';') && parenDepth == 0 && blockDepth == 0)
            {
                if (current.Count > 0) result.Add(current);
                current = [];
                continue;
            }

            current.Add(t);
        }

        if (current.Count > 0) result.Add(current);
        return result;
    }

    private static bool PrevIsEnd(IReadOnlyList<SqlToken> tokens, int k) => k > 0 && tokens[k - 1].IsWord("END");

    /// <summary>
    /// Block nesting of MySQL / MariaDB compound statements and Snowflake Scripting. BEGIN, CASE and (in statement
    /// position, so <c>IF(a, b, c)</c> and <c>IF NOT EXISTS</c> do not count) IF / LOOP / WHILE / REPEAT open a level; MySQL
    /// also reads <c>label:LOOP</c>, which the tokenizer cuts into a word and a <c>:LOOP</c> parameter. Snowflake adds FOR and
    /// DECLARE (the BEGIN after a DECLARE section is the same level). END closes a level, and <c>END IF / LOOP / WHILE /
    /// REPEAT / FOR / CASE</c> is one close, not two.
    /// </summary>
    private static void ScriptBlockStep(IReadOnlyList<SqlToken> tokens, ref int k, Dialect dialect, ref int depth, ref int declares)
    {
        var t = tokens[k];
        string u;
        var labelled = false;
        if (t.Kind == SqlTokenKind.Word) u = t.Upper;
        else if (dialect == Dialect.MySql && t.Kind == SqlTokenKind.Parameter && t.Value.Length > 1 && t.Value[0] == ':' && k > 0
                 && tokens[k - 1].Kind == SqlTokenKind.Word && tokens[k - 1].End == t.Start)
        {
            u = t.Value[1..].ToUpperInvariant(); // lbl:LOOP
            labelled = true;
        }
        else return;

        if (u == "END")
        {
            if (depth <= 0) return;
            depth--;
            if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word
                && tokens[k + 1].Upper is "IF" or "LOOP" or "CASE" or "WHILE" or "REPEAT" or "FOR")
                k++;
            return;
        }
        if (PrevIsEnd(tokens, k)) return;

        if (dialect == Dialect.Snowflake)
        {
            if (u == "DECLARE") { depth++; declares++; }
            else if (u == "BEGIN" && declares > 0) declares--;
            else if (u is "BEGIN" or "CASE" or "WHILE" or "REPEAT" or "LOOP"
                     || (u == "FOR" && !(k > 0 && tokens[k - 1].IsWord("CURSOR")))
                     || (u == "IF" && !(k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "EXISTS" or "NOT")))
                depth++;
            return;
        }

        if (u is "BEGIN" or "CASE") depth++;
        else if (u is "IF" or "LOOP" or "WHILE" or "REPEAT" && (labelled || MySqlStatementPosition(tokens, k))) depth++;
    }

    /// <summary>MySQL compound statements start after ';', BEGIN [NOT ATOMIC], THEN, ELSE, DO, LOOP, REPEAT or a label colon.</summary>
    private static bool MySqlStatementPosition(IReadOnlyList<SqlToken> tokens, int k)
    {
        var p = k == 0 ? default : tokens[k - 1];
        var inPosition = k == 0 || p.IsPunct(';') || (p.Kind == SqlTokenKind.Operator && p.Value == ":")
            || (p.Kind == SqlTokenKind.Word && p.Upper is "BEGIN" or "ATOMIC" or "THEN" or "ELSE" or "DO" or "LOOP" or "REPEAT");
        if (!inPosition) return false;
        // IF(a, b, c) / REPEAT(s, n) after THEN or ELSE of a CASE expression are functions: the statement forms are
        // `IF (cond) THEN` and `WHILE (cond) DO`, i.e. the closing parenthesis is followed by THEN / DO.
        if (k + 1 < tokens.Count && tokens[k + 1].IsPunct('('))
        {
            var u = tokens[k].Value.ToUpperInvariant();
            if (u is "LOOP" or "REPEAT") return false;
            var depth = 0;
            for (var j = k + 1; j < tokens.Count; j++)
            {
                if (tokens[j].IsPunct('(')) depth++;
                else if (tokens[j].IsPunct(')') && --depth == 0)
                    return j + 1 < tokens.Count && tokens[j + 1].IsWord(u == "IF" ? "THEN" : "DO");
            }
            return false;
        }
        return true;
    }

    private static bool StartsBlock(IReadOnlyList<SqlToken> tokens, int k, Dialect dialect)
    {
        var t = tokens[k];
        if (t.Kind != SqlTokenKind.Word || dialect == Dialect.PgSql) return false;
        var u = t.Upper;
        if (dialect == Dialect.PlSql && u is "BEGIN" or "DECLARE") return true;
        // WP-MY begin (MySQL/MariaDB: BEGIN … END compound statements; CREATE PROCEDURE/FUNCTION/EVENT bodies, DEFINER=…)
        if (dialect == Dialect.MySql)
        {
            // A top-level BEGIN is START TRANSACTION; MariaDB's BEGIN NOT ATOMIC … END is a compound statement.
            if (u == "BEGIN") return k + 1 < tokens.Count && tokens[k + 1].IsWord("NOT");
            if (u is not ("CREATE" or "ALTER")) return false;
            for (var j = k + 1; j < Math.Min(tokens.Count, k + 16); j++)
            {
                var tj = tokens[j];
                if (tj.Kind == SqlTokenKind.Word && tj.Upper is "PROCEDURE" or "FUNCTION" or "TRIGGER" or "EVENT") return true;
                if (tj.Kind == SqlTokenKind.Word && tj.Upper is "TABLE" or "VIEW" or "INDEX" or "DATABASE" or "SCHEMA" or "USER" or "SEQUENCE" or "SERVER") return false;
                // OR REPLACE, DEFINER = 'u'@'h' / CURRENT_USER(), SQL SECURITY x, AGGREGATE: keep scanning
            }
            return false;
        }
        // WP-MY end
        // WP-SF begin (Snowflake Scripting: anonymous BEGIN … END / DECLARE blocks outside $$ bodies)
        if (dialect == Dialect.Snowflake && (u == "DECLARE" || (u == "BEGIN" && k + 1 < tokens.Count
            && !(tokens[k + 1].IsPunct(';') || (tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "TRANSACTION" or "WORK" or "NAME")))))
            return true;
        // WP-SF end
        if (u != "CREATE") return false;
        for (var j = k + 1; j < Math.Min(tokens.Count, k + 8); j++)
        {
            if (tokens[j].Kind != SqlTokenKind.Word) return false;
            var w = tokens[j].Upper;
            if (w is "TRIGGER") return true;
            if (dialect == Dialect.PlSql && w is "PROCEDURE" or "FUNCTION" or "PACKAGE" or "TYPE" or "LIBRARY") return true;
            if (w is not ("OR" or "REPLACE" or "EDITIONABLE" or "NONEDITIONABLE" or "TEMP" or "TEMPORARY")) return false;
        }
        return false;
    }

    /// <summary>1-based (line, col) of a 0-based offset in <paramref name="text"/>.</summary>
    public static (int Line, int Col) LineColAt(string text, int offset)
    {
        var line = 1;
        var lineStart = 0;
        offset = Math.Clamp(offset, 0, text.Length);
        for (var i = 0; i < offset; i++)
        {
            if (text[i] == '\n') { line++; lineStart = i + 1; }
        }
        return (line, offset - lineStart + 1);
    }
}
