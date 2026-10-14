using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Designer;

/// <summary>Splits a stored CREATE VIEW statement into its header options and SELECT body.</summary>
public static class ViewText
{
    /// <summary>
    /// The SELECT after the top-level AS that follows <c>VIEW name [(cols)] [WITH ...]</c>, without a trailing
    /// <c>WITH CHECK OPTION</c> and semicolon; plus the options found. Returns the trimmed text when no header is found.
    /// </summary>
    public static (string Body, ViewOptions Options) Split(string ddl, Dialect dialect)
    {
        var tokens = SqlTokenizer.Tokenize(ddl, dialect);
        var view = tokens.FindIndex(t => t.IsWord("VIEW"));
        if (view < 0) return (StripCheckOption(ddl.Trim(), dialect, out var co0), new ViewOptions(CheckOption: co0));
        var depth = 0;
        var schemaBinding = false;
        var force = tokens.Take(view).Any(t => t.IsWord("FORCE")) && !tokens.Take(view).Any(t => t.IsWord("NOFORCE"));
        for (var i = view + 1; i < tokens.Count; i++)
        {
            var t = tokens[i];
            if (t.IsPunct('(')) depth++;
            else if (t.IsPunct(')')) depth--;
            else if (depth == 0 && t.IsWord("SCHEMABINDING")) schemaBinding = true;
            else if (depth == 0 && t.IsWord("AS") && i + 1 < tokens.Count)
            {
                var body = StripCheckOption(ddl[tokens[i + 1].Start..].Trim(), dialect, out var checkOption);
                return (body, new ViewOptions(schemaBinding, checkOption, force));
            }
        }
        return (ddl.Trim(), new ViewOptions(schemaBinding, false, force));
    }

    private static string StripCheckOption(string body, Dialect dialect, out bool checkOption)
    {
        checkOption = false;
        var text = body.TrimEnd().TrimEnd(';').TrimEnd();
        if (dialect == Dialect.PlSql && text.EndsWith('/')) text = text[..^1].TrimEnd();
        var tokens = SqlTokenizer.Tokenize(text, dialect);
        // ... WITH CHECK OPTION [CONSTRAINT name]  |  ... WITH READ ONLY (Oracle, kept)
        for (var i = tokens.Count - 1; i >= 2; i--)
        {
            if (tokens[i].IsWord("OPTION") && tokens[i - 1].IsWord("CHECK") && tokens[i - 2].IsWord("WITH"))
            {
                var tail = tokens.Skip(i + 1).ToList();
                if (tail.Count == 0 || (tail.Count == 2 && tail[0].IsWord("CONSTRAINT")))
                {
                    checkOption = true;
                    return text[..tokens[i - 2].Start].TrimEnd();
                }
            }
        }
        return text;
    }
}
