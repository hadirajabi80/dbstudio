using System.Text;

namespace DbStudio.Providers.Oracle;

public enum OracleTokenKind { Word, QuotedIdentifier, String, Bind, Symbol }

/// <summary>A significant token (comments and whitespace are skipped). Offset is 0-based into the statement text.</summary>
public readonly record struct OracleToken(OracleTokenKind Kind, string Text, int Offset)
{
    public bool Is(string word) => Kind == OracleTokenKind.Word && string.Equals(Text, word, StringComparison.OrdinalIgnoreCase);
}

/// <summary>A PL/SQL unit created by a CREATE statement (for ALL_ERRORS lookup and line mapping).</summary>
/// <param name="ObjectType">ALL_ERRORS.TYPE: PROCEDURE, FUNCTION, PACKAGE, PACKAGE BODY, TRIGGER, TYPE, TYPE BODY, VIEW, ...</param>
/// <param name="Owner">Explicit owner (already case-folded) or null for the current schema.</param>
/// <param name="Name">Object name, case-folded (unquoted → upper).</param>
/// <param name="SourceOffset">Offset of the object-type keyword; ALL_ERRORS line 1 starts at this keyword's line.</param>
public sealed record OracleCreatedUnit(string ObjectType, string? Owner, string Name, int SourceOffset);

/// <summary>Lexical helpers for Oracle SQL and PL/SQL text: comments, '...' strings, q'[...]' strings, "identifiers", binds.</summary>
public static class OracleSqlText
{
    public static IEnumerable<OracleToken> Tokenize(string sql)
    {
        ArgumentNullException.ThrowIfNull(sql);
        int i = 0, n = sql.Length;
        while (i < n)
        {
            char c = sql[i];
            char next = i + 1 < n ? sql[i + 1] : '\0';
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '-' && next == '-')
            {
                int eol = sql.IndexOf('\n', i);
                i = eol < 0 ? n : eol + 1;
                continue;
            }
            if (c == '/' && next == '*')
            {
                int end = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = end < 0 ? n : end + 2;
                continue;
            }
            // Alternative quoting: q'<delim>...<close>' with optional N prefix (nq'[..]').
            int qi = (c is 'n' or 'N') && (next is 'q' or 'Q') ? i + 1 : i;
            if (sql[qi] is 'q' or 'Q' && qi + 2 < n && sql[qi + 1] == '\'')
            {
                char open = sql[qi + 2];
                char close = open switch { '[' => ']', '{' => '}', '(' => ')', '<' => '>', _ => open };
                int j = qi + 3;
                while (j < n && !(sql[j] == close && j + 1 < n && sql[j + 1] == '\'')) j++;
                int endQ = j < n ? j + 2 : n;
                yield return new OracleToken(OracleTokenKind.String, sql[i..endQ], i);
                i = endQ;
                continue;
            }
            if (c == '\'' || ((c is 'n' or 'N') && next == '\''))
            {
                int start = i;
                int j = c == '\'' ? i + 1 : i + 2;
                while (j < n)
                {
                    if (sql[j] == '\'')
                    {
                        if (j + 1 < n && sql[j + 1] == '\'') { j += 2; continue; }
                        j++;
                        break;
                    }
                    j++;
                }
                yield return new OracleToken(OracleTokenKind.String, sql[start..Math.Min(j, n)], start);
                i = Math.Min(j, n);
                continue;
            }
            if (c == '"')
            {
                int end = sql.IndexOf('"', i + 1);
                int stop = end < 0 ? n : end + 1;
                yield return new OracleToken(OracleTokenKind.QuotedIdentifier, sql[i..stop], i);
                i = stop;
                continue;
            }
            if (c == ':' && next != '=' && i + 1 < n && (IsIdentStart(next) || char.IsAsciiDigit(next) || next == '"'))
            {
                int start = i;
                int j = i + 1;
                if (sql[j] == '"')
                {
                    int end = sql.IndexOf('"', j + 1);
                    j = end < 0 ? n : end + 1;
                }
                else
                {
                    while (j < n && IsIdentPart(sql[j])) j++;
                }
                yield return new OracleToken(OracleTokenKind.Bind, sql[start..j], start);
                i = j;
                continue;
            }
            if (IsIdentStart(c))
            {
                int start = i;
                while (i < n && IsIdentPart(sql[i])) i++;
                yield return new OracleToken(OracleTokenKind.Word, sql[start..i], start);
                continue;
            }
            if (char.IsAsciiDigit(c))
            {
                int start = i;
                while (i < n && (char.IsAsciiLetterOrDigit(sql[i]) || sql[i] == '.')) i++;
                yield return new OracleToken(OracleTokenKind.Word, sql[start..i], start);
                continue;
            }
            yield return new OracleToken(OracleTokenKind.Symbol, c.ToString(), i);
            i++;
        }
    }

    private static bool IsIdentStart(char c) => char.IsLetter(c);
    private static bool IsIdentPart(char c) => char.IsLetterOrDigit(c) || c is '_' or '$' or '#';

    /// <summary>
    /// Host bind variables (<c>:name</c>, <c>:1</c>) outside strings, comments and quoted identifiers.
    /// Trigger bodies are exempt (<c>:NEW</c>/<c>:OLD</c>/<c>:PARENT</c> are correlation names, not binds).
    /// Returns distinct names in order of appearance, without the colon.
    /// </summary>
    public static IReadOnlyList<string> FindBindVariables(string sql)
    {
        var tokens = Tokenize(sql).ToList();
        if (FindCreatedUnit(tokens) is { ObjectType: "TRIGGER" }) return [];
        var names = new List<string>();
        foreach (var t in tokens)
        {
            if (t.Kind != OracleTokenKind.Bind) continue;
            var name = t.Text[1..];
            if (!names.Contains(name, StringComparer.OrdinalIgnoreCase)) names.Add(name);
        }
        return names;
    }

    /// <summary>True for statements that must keep their trailing semicolon (anonymous blocks and stored PL/SQL units).</summary>
    public static bool IsPlSql(string sql) => IsPlSql(Tokenize(sql).Take(8).ToList());

    private static bool IsPlSql(IReadOnlyList<OracleToken> t)
    {
        if (t.Count == 0) return false;
        if (t[0].Is("BEGIN") || t[0].Is("DECLARE")) return true;
        if (t[0].Kind == OracleTokenKind.Symbol && t[0].Text == "<") return true; // <<label>> BEGIN ...
        if (FindCreatedUnit(t) is { } unit) return unit.ObjectType != "VIEW";
        if (t[0].Is("WITH"))
            return t.Count > 1 && (t[1].Is("FUNCTION") || t[1].Is("PROCEDURE"));
        return false;
    }

    /// <summary>
    /// Normalizes a statement for ODP.NET: trims whitespace, drops a trailing SQL*Plus "/" line, removes the trailing
    /// semicolon from plain SQL (ORA-00911 otherwise) and rewrites <c>EXEC proc(...)</c> to an anonymous block.
    /// Returns the text to execute and the offset of its first character in the original statement.
    /// </summary>
    public static (string Sql, int Offset) Prepare(string sql)
    {
        ArgumentNullException.ThrowIfNull(sql);
        int start = 0;
        while (start < sql.Length && char.IsWhiteSpace(sql[start])) start++;
        var text = sql[start..].TrimEnd();

        // A trailing "/" on its own line (SQL*Plus block terminator).
        if (text.EndsWith('/'))
        {
            int nl = text.LastIndexOf('\n');
            var lastLine = (nl < 0 ? text : text[(nl + 1)..]).Trim();
            if (lastLine == "/" && nl >= 0) text = text[..nl].TrimEnd();
        }

        var rewritten = RewriteExec(text);
        if (rewritten is not null) return (rewritten, start);

        if (!IsPlSql(text))
        {
            // Strip trailing semicolons that are not inside a string/comment.
            while (text.EndsWith(';') && LastSignificantIsSemicolon(text)) text = text[..^1].TrimEnd();
        }
        return (text, start);
    }

    private static bool LastSignificantIsSemicolon(string text)
    {
        OracleToken? last = null;
        foreach (var t in Tokenize(text)) last = t;
        return last is { Kind: OracleTokenKind.Symbol, Text: ";" } && last.Value.Offset == text.Length - 1;
    }

    /// <summary>SQL*Plus <c>EXEC[UTE] x</c> → <c>BEGIN x; END;</c>. Returns null when the text is not an EXEC command.</summary>
    public static string? RewriteExec(string text)
    {
        var tokens = Tokenize(text).Take(2).ToList();
        if (tokens.Count < 2 || !(tokens[0].Is("EXEC") || tokens[0].Is("EXECUTE"))) return null;
        string body = tokens[1].Is("IMMEDIATE") ? text : text[tokens[1].Offset..];
        body = body.TrimEnd();
        while (body.EndsWith(';')) body = body[..^1].TrimEnd();
        return "BEGIN " + body + "; END;";
    }

    /// <summary>Recognizes CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] [FORCE|NO FORCE] PROCEDURE/FUNCTION/PACKAGE [BODY]/TRIGGER/TYPE [BODY]/VIEW/... name.</summary>
    public static OracleCreatedUnit? FindCreatedUnit(string sql) => FindCreatedUnit(Tokenize(sql).Take(16).ToList());

    private static OracleCreatedUnit? FindCreatedUnit(IReadOnlyList<OracleToken> t)
    {
        int i = 0;
        if (t.Count < 3 || !t[i].Is("CREATE")) return null;
        i++;
        if (i + 1 < t.Count && t[i].Is("OR") && t[i + 1].Is("REPLACE")) i += 2;
        while (i < t.Count && (t[i].Is("EDITIONABLE") || t[i].Is("NONEDITIONABLE") || t[i].Is("EDITIONING") || t[i].Is("FORCE")
                               || t[i].Is("NOFORCE") || (t[i].Is("NO") && i + 1 < t.Count && t[i + 1].Is("FORCE"))))
            i += t[i].Is("NO") ? 2 : 1;
        if (i >= t.Count) return null;

        int keywordOffset = t[i].Offset;
        string type;
        if (t[i].Is("PROCEDURE")) type = "PROCEDURE";
        else if (t[i].Is("FUNCTION")) type = "FUNCTION";
        else if (t[i].Is("TRIGGER")) type = "TRIGGER";
        else if (t[i].Is("VIEW")) type = "VIEW";
        else if (t[i].Is("LIBRARY")) type = "LIBRARY";
        else if (t[i].Is("PACKAGE") || t[i].Is("TYPE"))
        {
            type = t[i].Text.ToUpperInvariant();
            if (i + 1 < t.Count && t[i + 1].Is("BODY")) { type += " BODY"; i++; }
        }
        else if (t[i].Is("JAVA"))
        {
            // CREATE [AND COMPILE] JAVA SOURCE NAMED "x"
            return null;
        }
        else return null;
        i++;
        if (i >= t.Count) return null;

        // Name: [owner.]name, identifiers quoted or not. CREATE ... IF NOT EXISTS (23ai) is skipped.
        if (t[i].Is("IF") && i + 2 < t.Count && t[i + 1].Is("NOT") && t[i + 2].Is("EXISTS")) i += 3;
        if (i >= t.Count || t[i].Kind is not (OracleTokenKind.Word or OracleTokenKind.QuotedIdentifier)) return null;
        string first = FoldIdentifier(t[i].Text);
        if (i + 2 < t.Count && t[i + 1] is { Kind: OracleTokenKind.Symbol, Text: "." } &&
            t[i + 2].Kind is OracleTokenKind.Word or OracleTokenKind.QuotedIdentifier)
            return new OracleCreatedUnit(type, first, FoldIdentifier(t[i + 2].Text), keywordOffset);
        return new OracleCreatedUnit(type, null, first, keywordOffset);
    }

    /// <summary>"Name" → Name (quotes removed, case kept); Name → NAME.</summary>
    public static string FoldIdentifier(string ident) =>
        ident.Length >= 2 && ident[0] == '"' && ident[^1] == '"' ? ident[1..^1] : ident.ToUpperInvariant();

    /// <summary>Quotes an identifier for Oracle: "NAME" with embedded quotes rejected.</summary>
    public static string Quote(string name)
    {
        if (name.Contains('"')) throw new ArgumentException($"Invalid Oracle identifier '{name}'.", nameof(name));
        return "\"" + name + "\"";
    }

    public static string Literal(string value) => "'" + value.Replace("'", "''") + "'";

    /// <summary>True when the statement is ALTER SESSION SET CURRENT_SCHEMA (so the session's schema must be re-read).</summary>
    public static bool IsSetCurrentSchema(string sql)
    {
        var t = Tokenize(sql).Take(4).ToList();
        return t.Count == 4 && t[0].Is("ALTER") && t[1].Is("SESSION") && t[2].Is("SET") && t[3].Is("CURRENT_SCHEMA");
    }

    /// <summary>True for a plain query (SELECT / WITH ... SELECT): no commit needed after it.</summary>
    public static bool IsQuery(string sql)
    {
        var first = Tokenize(sql).FirstOrDefault();
        return first.Is("SELECT") || (first.Is("WITH") && !IsPlSql(sql));
    }

    /// <summary>1-based (line, col) of a 0-based offset in <paramref name="text"/>.</summary>
    public static (int Line, int Col) LineCol(string text, int offset)
    {
        int line = 1, col = 1;
        for (int i = 0; i < offset && i < text.Length; i++)
        {
            if (text[i] == '\n') { line++; col = 1; }
            else col++;
        }
        return (line, col);
    }

    /// <summary>
    /// Offset of the first whole-word occurrence of <paramref name="identifier"/> outside strings/comments
    /// (case-insensitive unless quoted), or -1.
    /// </summary>
    public static int FindIdentifier(string sql, string identifier)
    {
        foreach (var t in Tokenize(sql))
        {
            if (t.Kind == OracleTokenKind.Word && string.Equals(t.Text, identifier, StringComparison.OrdinalIgnoreCase)) return t.Offset;
            if (t.Kind == OracleTokenKind.QuotedIdentifier && t.Text.Length >= 2 && t.Text[1..^1] == identifier) return t.Offset;
        }
        return -1;
    }

    internal static string JoinNames(IEnumerable<string> names)
    {
        var sb = new StringBuilder();
        foreach (var n in names)
        {
            if (sb.Length > 0) sb.Append(", ");
            sb.Append(':').Append(n);
        }
        return sb.ToString();
    }
}
