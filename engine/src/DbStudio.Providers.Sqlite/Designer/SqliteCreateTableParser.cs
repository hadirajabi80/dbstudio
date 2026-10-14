using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.Sqlite.Designer;

/// <summary>
/// Extracts what the pragmas do not report from a stored <c>CREATE TABLE</c> statement: constraint names, CHECK
/// expressions, AUTOINCREMENT, COLLATE, generated-column expressions, WITHOUT ROWID and STRICT.
/// </summary>
public static class SqliteCreateTableParser
{
    public sealed record ParsedColumn(string Name, string? Collation, bool Autoincrement, string? GeneratedExpression, bool GeneratedStored);
    public sealed record ParsedConstraint(string? Name, IReadOnlyList<string> Columns);
    public sealed record ParsedCheck(string? Name, string Expression);
    public sealed record ParsedForeignKey(string? Name, IReadOnlyList<string> Columns, string RefTable, IReadOnlyList<string> RefColumns);

    public sealed class ParsedTable
    {
        public Dictionary<string, ParsedColumn> Columns { get; } = new(StringComparer.OrdinalIgnoreCase);
        public string? PrimaryKeyName { get; set; }
        public List<ParsedConstraint> Uniques { get; } = [];
        public List<ParsedCheck> Checks { get; } = [];
        public List<ParsedForeignKey> ForeignKeys { get; } = [];
        public bool WithoutRowid { get; set; }
        public bool Strict { get; set; }
    }

    private static readonly HashSet<string> TableConstraintStarts = new(StringComparer.OrdinalIgnoreCase) { "CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN" };

    public static ParsedTable Parse(string? sql)
    {
        var result = new ParsedTable();
        if (string.IsNullOrWhiteSpace(sql)) return result;
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.Sqlite);
        var open = tokens.FindIndex(t => t.IsPunct('('));
        if (open < 0) return result;
        var close = Matching(tokens, open);
        if (close < 0) return result;

        foreach (var (from, to) in Split(tokens, open + 1, close))
        {
            if (from >= to) continue;
            if (tokens[from].Kind == SqlTokenKind.Word && TableConstraintStarts.Contains(tokens[from].Value)) ParseTableConstraint(sql, tokens, from, to, result);
            else ParseColumn(sql, tokens, from, to, result);
        }
        for (var i = close + 1; i < tokens.Count; i++)
        {
            if (tokens[i].IsWord("WITHOUT") && i + 1 < tokens.Count && tokens[i + 1].IsWord("ROWID")) result.WithoutRowid = true;
            if (tokens[i].IsWord("STRICT")) result.Strict = true;
        }
        return result;
    }

    private static void ParseColumn(string sql, List<SqlToken> tokens, int from, int to, ParsedTable result)
    {
        var name = tokens[from].Value;
        string? constraintName = null, collation = null, genExpr = null;
        var auto = false;
        var stored = false;
        for (var i = from + 1; i < to; i++)
        {
            var t = tokens[i];
            if (t.IsWord("CONSTRAINT") && i + 1 < to) { constraintName = tokens[++i].Value; continue; }
            if (t.IsWord("PRIMARY"))
            {
                result.PrimaryKeyName = constraintName;
                constraintName = null;
                continue;
            }
            if (t.IsWord("AUTOINCREMENT")) { auto = true; continue; }
            if (t.IsWord("NOT") || t.IsWord("NULL") || t.IsWord("DEFAULT") || t.IsWord("GENERATED")) constraintName = null;
            if (t.IsWord("UNIQUE")) { result.Uniques.Add(new ParsedConstraint(constraintName, [name])); constraintName = null; continue; }
            if (t.IsWord("COLLATE") && i + 1 < to) { collation = tokens[++i].Value; continue; }
            if (t.IsWord("CHECK") && i + 1 < to && tokens[i + 1].IsPunct('('))
            {
                var end = Matching(tokens, i + 1);
                if (end < 0 || end >= to) break;
                result.Checks.Add(new ParsedCheck(constraintName, Text(sql, tokens, i + 2, end)));
                constraintName = null;
                i = end;
                continue;
            }
            if (t.IsWord("AS") && i + 1 < to && tokens[i + 1].IsPunct('('))
            {
                var end = Matching(tokens, i + 1);
                if (end < 0 || end >= to) break;
                genExpr = Text(sql, tokens, i + 2, end);
                if (end + 1 < to && tokens[end + 1].IsWord("STORED")) stored = true;
                i = end;
                continue;
            }
            if (t.IsWord("DEFAULT") && i + 1 < to && tokens[i + 1].IsPunct('('))
            {
                var end = Matching(tokens, i + 1);
                if (end > 0) i = end;
                continue;
            }
            if (t.IsWord("REFERENCES") && i + 1 < to)
            {
                var refTable = tokens[i + 1].Value;
                var j = i + 2;
                List<string> refCols = [];
                if (j < to && tokens[j].IsPunct('('))
                {
                    var end = Matching(tokens, j);
                    refCols = Names(tokens, j + 1, end);
                    j = end;
                }
                result.ForeignKeys.Add(new ParsedForeignKey(constraintName, [name], refTable, refCols));
                constraintName = null;
                i = j;
            }
        }
        result.Columns[name] = new ParsedColumn(name, collation, auto, genExpr, stored);
    }

    private static void ParseTableConstraint(string sql, List<SqlToken> tokens, int from, int to, ParsedTable result)
    {
        string? name = null;
        var i = from;
        if (tokens[i].IsWord("CONSTRAINT") && i + 1 < to) { name = tokens[i + 1].Value; i += 2; }
        if (i >= to) return;
        var t = tokens[i];
        if (t.IsWord("PRIMARY"))
        {
            result.PrimaryKeyName = name;
            return;
        }
        if (t.IsWord("UNIQUE"))
        {
            var open = tokens.FindIndex(i, to - i, x => x.IsPunct('('));
            if (open < 0) return;
            result.Uniques.Add(new ParsedConstraint(name, IndexedNames(tokens, open + 1, Matching(tokens, open))));
            return;
        }
        if (t.IsWord("CHECK") && i + 1 < to && tokens[i + 1].IsPunct('('))
        {
            var end = Matching(tokens, i + 1);
            if (end > 0) result.Checks.Add(new ParsedCheck(name, Text(sql, tokens, i + 2, end)));
            return;
        }
        if (t.IsWord("FOREIGN"))
        {
            var open = tokens.FindIndex(i, to - i, x => x.IsPunct('('));
            if (open < 0) return;
            var close = Matching(tokens, open);
            var cols = Names(tokens, open + 1, close);
            var r = tokens.FindIndex(close, to - close, x => x.IsWord("REFERENCES"));
            if (r < 0 || r + 1 >= to) return;
            var refTable = tokens[r + 1].Value;
            List<string> refCols = [];
            if (r + 2 < to && tokens[r + 2].IsPunct('(')) refCols = Names(tokens, r + 3, Matching(tokens, r + 2));
            result.ForeignKeys.Add(new ParsedForeignKey(name, cols, refTable, refCols));
        }
    }

    private static List<string> Names(List<SqlToken> tokens, int from, int to)
    {
        var list = new List<string>();
        if (to < 0) return list;
        for (var i = from; i < to; i++)
            if (tokens[i].IsIdentifier) list.Add(tokens[i].Value);
        return list;
    }

    /// <summary>Column names of an indexed-column list (skipping COLLATE x, ASC/DESC).</summary>
    private static List<string> IndexedNames(List<SqlToken> tokens, int from, int to)
    {
        var list = new List<string>();
        if (to < 0) return list;
        foreach (var (a, b) in Split(tokens, from, to))
            if (a < b && tokens[a].IsIdentifier) list.Add(tokens[a].Value);
        return list;
    }

    private static string Text(string sql, List<SqlToken> tokens, int from, int toExclusive) =>
        from >= toExclusive ? "" : sql[tokens[from].Start..tokens[toExclusive - 1].End].Trim();

    /// <summary>Index of the ')' matching the '(' at <paramref name="open"/>, or -1.</summary>
    public static int Matching(List<SqlToken> tokens, int open)
    {
        var depth = 0;
        for (var i = open; i < tokens.Count; i++)
        {
            if (tokens[i].IsPunct('(')) depth++;
            else if (tokens[i].IsPunct(')') && --depth == 0) return i;
        }
        return -1;
    }

    /// <summary>Comma-separated top-level ranges [from, to) between two token indexes.</summary>
    public static IEnumerable<(int From, int To)> Split(List<SqlToken> tokens, int from, int to)
    {
        var depth = 0;
        var start = from;
        for (var i = from; i < to; i++)
        {
            var t = tokens[i];
            if (t.IsPunct('(')) depth++;
            else if (t.IsPunct(')')) depth--;
            else if (depth == 0 && t.IsPunct(','))
            {
                yield return (start, i);
                start = i + 1;
            }
        }
        yield return (start, to);
    }

    /// <summary>Text after the top-level WHERE of a CREATE INDEX statement (partial index filter), or null.</summary>
    public static string? IndexFilter(string? sql)
    {
        if (string.IsNullOrWhiteSpace(sql)) return null;
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.Sqlite);
        var depth = 0;
        for (var i = 0; i < tokens.Count; i++)
        {
            if (tokens[i].IsPunct('(')) depth++;
            else if (tokens[i].IsPunct(')')) depth--;
            else if (depth == 0 && tokens[i].IsWord("WHERE"))
                return i + 1 < tokens.Count ? sql[tokens[i + 1].Start..].Trim().TrimEnd(';').Trim() : null;
        }
        return null;
    }

    /// <summary>The SELECT of a stored CREATE VIEW (text after the top-level AS following the view name).</summary>
    public static string ViewBody(string sql)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.Sqlite);
        var view = tokens.FindIndex(t => t.IsWord("VIEW"));
        var depth = 0;
        for (var i = Math.Max(0, view + 1); i < tokens.Count; i++)
        {
            if (tokens[i].IsPunct('(')) depth++;
            else if (tokens[i].IsPunct(')')) depth--;
            else if (depth == 0 && tokens[i].IsWord("AS") && i + 1 < tokens.Count)
                return sql[tokens[i + 1].Start..].Trim().TrimEnd(';').Trim();
        }
        return sql.Trim();
    }
}
