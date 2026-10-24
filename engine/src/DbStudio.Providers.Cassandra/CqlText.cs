using System.Text;

namespace DbStudio.Providers.Cassandra;

public enum CqlTokenKind { Word, QuotedIdent, String, Number, Punct, Operator, Param }

/// <summary>One CQL token (comments and whitespace are dropped). Offsets are 0-based into the source text.</summary>
public sealed record CqlToken(CqlTokenKind Kind, string Value, int Start, int End)
{
    public string Upper { get; } = Kind == CqlTokenKind.Word ? Value.ToUpperInvariant() : Value;

    public bool IsWord(string upper) => Kind == CqlTokenKind.Word && Upper == upper;
    public bool IsPunct(char c) => Kind == CqlTokenKind.Punct && Value.Length == 1 && Value[0] == c;
    public bool IsOp(string op) => Kind == CqlTokenKind.Operator && Value == op;

    /// <summary>Identifier text: quoted identifiers unquoted, plain words lower-cased (CQL folds unquoted names).</summary>
    public string Name => Kind == CqlTokenKind.QuotedIdent
        ? Value[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal)
        : Value.ToLowerInvariant();

    public bool IsName => Kind is CqlTokenKind.Word or CqlTokenKind.QuotedIdent;
}

/// <summary>A statement of a batch: its tokens and its span in the batch text (without the terminating semicolon).</summary>
public sealed record CqlStatement(int Start, int End, string Text, IReadOnlyList<CqlToken> Tokens)
{
    public string Head => Tokens.Count > 0 && Tokens[0].Kind == CqlTokenKind.Word ? Tokens[0].Upper : "";
    public string? Word(int i) => i < Tokens.Count && Tokens[i].Kind == CqlTokenKind.Word ? Tokens[i].Upper : null;
}

/// <summary>A bind marker: <c>?</c> (Name null), <c>:name</c> or <c>@name</c> (UI-generated, rewritten to <c>?</c>).</summary>
public sealed record CqlPlaceholder(string? Name, int Start, int End);

/// <summary>
/// CQL lexical rules (Cassandra 3–5, ScyllaDB): <c>--</c> and <c>//</c> line comments, <c>/* */</c> block comments,
/// <c>'…'</c> strings with doubled quotes, <c>$$…$$</c> string bodies (UDFs), <c>"…"</c> identifiers, bind markers
/// <c>?</c> / <c>:name</c>, blob literals <c>0x…</c>, uuids and durations. Statements end at depth-0 semicolons except inside
/// <c>BEGIN [UNLOGGED|COUNTER] BATCH … APPLY BATCH</c>.
/// </summary>
public static class CqlText
{
    public static List<CqlToken> Tokenize(string text)
    {
        var tokens = new List<CqlToken>();
        var i = 0;
        var n = text.Length;
        while (i < n)
        {
            var c = text[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if ((c == '-' && At(text, i + 1) == '-') || (c == '/' && At(text, i + 1) == '/'))
            {
                while (i < n && text[i] != '\n') i++;
                continue;
            }
            if (c == '/' && At(text, i + 1) == '*')
            {
                var close = text.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = close < 0 ? n : close + 2;
                continue;
            }
            var start = i;
            if (c == '\'')
            {
                i++;
                while (i < n)
                {
                    if (text[i] == '\'')
                    {
                        if (At(text, i + 1) == '\'') { i += 2; continue; }
                        i++;
                        break;
                    }
                    i++;
                }
                tokens.Add(new CqlToken(CqlTokenKind.String, text[start..i], start, i));
                continue;
            }
            if (c == '$' && At(text, i + 1) == '$')
            {
                var close = text.IndexOf("$$", i + 2, StringComparison.Ordinal);
                i = close < 0 ? n : close + 2;
                tokens.Add(new CqlToken(CqlTokenKind.String, text[start..i], start, i));
                continue;
            }
            if (c == '"')
            {
                i++;
                while (i < n)
                {
                    if (text[i] == '"')
                    {
                        if (At(text, i + 1) == '"') { i += 2; continue; }
                        i++;
                        break;
                    }
                    i++;
                }
                tokens.Add(new CqlToken(CqlTokenKind.QuotedIdent, text[start..i], start, i));
                continue;
            }
            if (c == '?')
            {
                i++;
                tokens.Add(new CqlToken(CqlTokenKind.Param, "?", start, i));
                continue;
            }
            if ((c == ':' || c == '@') && i + 1 < n && (char.IsLetter(text[i + 1]) || text[i + 1] == '_'))
            {
                i++;
                while (i < n && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                tokens.Add(new CqlToken(CqlTokenKind.Param, text[start..i], start, i));
                continue;
            }
            if (IsUuidAt(text, i))
            {
                i += 36;
                tokens.Add(new CqlToken(CqlTokenKind.Number, text[start..i], start, i));
                continue;
            }
            if (char.IsDigit(c) || (c == '.' && i + 1 < n && char.IsDigit(text[i + 1])))
            {
                if (c == '0' && At(text, i + 1) is 'x' or 'X')
                {
                    i += 2;
                    while (i < n && Uri.IsHexDigit(text[i])) i++;
                }
                else
                {
                    while (i < n && (char.IsLetterOrDigit(text[i]) || text[i] == '.' || text[i] == '_'
                                     || ((text[i] is '+' or '-') && text[i - 1] is 'e' or 'E' && char.IsDigit(text[start])))) i++;
                }
                tokens.Add(new CqlToken(CqlTokenKind.Number, text[start..i], start, i));
                continue;
            }
            if (char.IsLetter(c) || c == '_')
            {
                while (i < n && (char.IsLetterOrDigit(text[i]) || text[i] == '_')) i++;
                tokens.Add(new CqlToken(CqlTokenKind.Word, text[start..i], start, i));
                continue;
            }
            if (c is '(' or ')' or ',' or ';' or '.' or '[' or ']' or '{' or '}' or ':')
            {
                i++;
                tokens.Add(new CqlToken(CqlTokenKind.Punct, c.ToString(), start, i));
                continue;
            }
            // Operators: = != < <= > >= + - * / % (and anything else, one char).
            if (i + 1 < n && (text.AsSpan(i, 2) is "!=" or "<=" or ">=" or "<>"))
            {
                i += 2;
                tokens.Add(new CqlToken(CqlTokenKind.Operator, text[start..i], start, i));
                continue;
            }
            i++;
            tokens.Add(new CqlToken(CqlTokenKind.Operator, c.ToString(), start, i));
        }
        return tokens;
    }

    private static char At(string s, int i) => i < s.Length ? s[i] : '\0';

    private static bool IsUuidAt(string s, int i)
    {
        if (i + 36 > s.Length) return false;
        if (i > 0 && (char.IsLetterOrDigit(s[i - 1]) || s[i - 1] == '_')) return false;
        for (var k = 0; k < 36; k++)
        {
            var ch = s[i + k];
            if (k is 8 or 13 or 18 or 23) { if (ch != '-') return false; }
            else if (!Uri.IsHexDigit(ch)) return false;
        }
        return i + 36 == s.Length || !(char.IsLetterOrDigit(s[i + 36]) || s[i + 36] == '_');
    }

    /// <summary>Statements of a batch text (empty statements dropped).</summary>
    public static List<CqlStatement> Split(string text)
    {
        var tokens = Tokenize(text);
        var result = new List<CqlStatement>();
        var current = new List<CqlToken>();
        var batchDepth = 0;
        var paren = 0;
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.IsPunct('(') || t.IsPunct('{') || t.IsPunct('[')) paren++;
            else if (t.IsPunct(')') || t.IsPunct('}') || t.IsPunct(']')) paren = Math.Max(0, paren - 1);
            else if (t.IsWord("BEGIN") && k + 1 < tokens.Count && tokens[k + 1].Kind == CqlTokenKind.Word
                     && tokens[k + 1].Upper is "BATCH" or "UNLOGGED" or "COUNTER" or "LOGGED") batchDepth++;
            else if (batchDepth > 0 && t.IsWord("APPLY") && k + 1 < tokens.Count && tokens[k + 1].IsWord("BATCH")) batchDepth--;

            if (t.IsPunct(';') && paren == 0 && batchDepth == 0)
            {
                Flush();
                continue;
            }
            current.Add(t);
        }
        Flush();
        return result;

        void Flush()
        {
            if (current.Count == 0) return;
            var s = current[0].Start;
            var e = current[^1].End;
            result.Add(new CqlStatement(s, e, text[s..e], current));
            current = [];
        }
    }

    /// <summary>1-based line/column of an offset.</summary>
    public static (int Line, int Col) LineColAt(string text, int offset)
    {
        var line = 1;
        var col = 1;
        for (var i = 0; i < offset && i < text.Length; i++)
        {
            if (text[i] == '\n') { line++; col = 1; }
            else col++;
        }
        return (line, col);
    }

    /// <summary>Bind markers of a statement in order.</summary>
    public static List<CqlPlaceholder> Placeholders(IReadOnlyList<CqlToken> tokens)
    {
        var list = new List<CqlPlaceholder>();
        foreach (var t in tokens)
        {
            if (t.Kind != CqlTokenKind.Param) continue;
            list.Add(new CqlPlaceholder(t.Value == "?" ? null : t.Value[1..], t.Start, t.End));
        }
        return list;
    }

    /// <summary>
    /// Rewrites every bind marker to <c>?</c> (positional) so a statement with <c>@p1</c> (UI-generated) or <c>:name</c>
    /// markers can be prepared; returns the marker names in order (null for <c>?</c>).
    /// </summary>
    public static (string Text, List<string?> Names) PositionalMarkers(string text)
    {
        var tokens = Tokenize(text);
        var markers = Placeholders(tokens);
        if (markers.Count == 0) return (text, []);
        var sb = new StringBuilder(text.Length);
        var last = 0;
        var names = new List<string?>();
        foreach (var m in markers)
        {
            sb.Append(text, last, m.Start - last).Append('?');
            last = m.End;
            names.Add(m.Name);
        }
        sb.Append(text, last, text.Length - last);
        return (sb.ToString(), names);
    }

    /// <summary>Quotes an identifier when CQL would fold or reject it unquoted.</summary>
    public static string Quote(string name)
    {
        if (name.Length > 0 && (char.IsAsciiLetterLower(name[0])) && name.All(ch => char.IsAsciiLetterLower(ch) || char.IsAsciiDigit(ch) || ch == '_')
            && !CqlReservedWords.All.Contains(name))
            return name;
        return "\"" + name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }

    public static string Qualify(string? keyspace, string name) =>
        string.IsNullOrEmpty(keyspace) ? Quote(name) : Quote(keyspace) + "." + Quote(name);

    /// <summary>A CQL string literal.</summary>
    public static string Literal(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>Index of the first depth-0 word (parentheses/braces/brackets skipped) at or after <paramref name="from"/>, or -1.</summary>
    public static int FindTopLevel(IReadOnlyList<CqlToken> t, int from, Func<IReadOnlyList<CqlToken>, int, bool> match)
    {
        var depth = 0;
        for (var k = from; k < t.Count; k++)
        {
            var x = t[k];
            if (x.IsPunct('(') || x.IsPunct('{') || x.IsPunct('[')) { depth++; continue; }
            if (x.IsPunct(')') || x.IsPunct('}') || x.IsPunct(']')) { depth = Math.Max(0, depth - 1); continue; }
            if (depth == 0 && match(t, k)) return k;
        }
        return -1;
    }

    public static int FindWord(IReadOnlyList<CqlToken> t, int from, string upper) =>
        FindTopLevel(t, from, (x, k) => x[k].IsWord(upper));

    public static int FindWords(IReadOnlyList<CqlToken> t, int from, string first, string second) =>
        FindTopLevel(t, from, (x, k) => x[k].IsWord(first) && k + 1 < x.Count && x[k + 1].IsWord(second));

    /// <summary>Reads <c>[ks.]name</c> starting at token <paramref name="k"/>; returns the index after it.</summary>
    public static (string? Keyspace, string? Name, int Next) QualifiedName(IReadOnlyList<CqlToken> t, int k)
    {
        if (k >= t.Count || !t[k].IsName) return (null, null, k);
        if (k + 2 < t.Count && t[k + 1].IsPunct('.') && t[k + 2].IsName) return (t[k].Name, t[k + 2].Name, k + 3);
        return (null, t[k].Name, k + 1);
    }
}

/// <summary>CQL reserved words (quoted when used as identifiers).</summary>
public static class CqlReservedWords
{
    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "add", "allow", "alter", "and", "apply", "asc", "authorize", "batch", "begin", "by", "columnfamily", "create", "default", "delete",
        "desc", "describe", "drop", "entries", "execute", "from", "full", "grant", "if", "in", "index", "infinity", "insert", "into",
        "is", "keyspace", "limit", "materialized", "mbean", "mbeans", "modify", "nan", "norecursive", "not", "null", "of", "on", "or",
        "order", "primary", "rename", "replace", "revoke", "schema", "select", "set", "table", "to", "token", "truncate", "unlogged",
        "unset", "update", "use", "using", "view", "where", "with",
    };
}
