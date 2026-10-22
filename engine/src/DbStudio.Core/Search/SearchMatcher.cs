using System.Text.RegularExpressions;
using DbStudio.Core.Services;

namespace DbStudio.Core.Search;

/// <summary>
/// The exact match of a search term (case, whole word, regex), applied in the engine to every candidate the providers
/// return (their SQL prefilter only narrows the rows down). One compiled .NET regex for every mode, with a timeout so a
/// pathological pattern cannot hang the search.
/// </summary>
public sealed class SearchMatcher
{
    public const int MaxTermLength = 500;
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(250);
    private readonly Regex _regex;

    public SearchMatcher(string term, bool matchCase = false, bool wholeWord = false, bool regex = false)
    {
        if (string.IsNullOrEmpty(term)) throw EngineException.Validation("Enter something to search for.", new { field = "params.term" });
        if (term.Length > MaxTermLength) throw EngineException.Validation($"The search term is longer than {MaxTermLength} characters.", new { field = "params.term" });
        Term = term;
        MatchCase = matchCase;
        WholeWord = wholeWord;
        IsRegex = regex;
        var body = regex ? term : Regex.Escape(term);
        // A word boundary that also works when the term starts or ends with a non-word character ("@id", "x.").
        var pattern = wholeWord ? $"(?<!\\w)(?:{body})(?!\\w)" : body;
        var options = RegexOptions.CultureInvariant | (matchCase ? RegexOptions.None : RegexOptions.IgnoreCase);
        try
        {
            _regex = new Regex(pattern, options, Timeout);
        }
        catch (ArgumentException ex)
        {
            throw EngineException.Validation($"Invalid regular expression: {ex.Message}", new { field = "params.term" });
        }
    }

    public string Term { get; }
    public bool MatchCase { get; }
    public bool WholeWord { get; }
    public bool IsRegex { get; }

    /// <summary>The literal every match contains (for the SQL LIKE prefilter); null for a regex.</summary>
    public string? Literal => IsRegex ? null : Term;

    /// <summary>The .NET pattern (also handed to engines with a compatible regex operator as a prefilter).</summary>
    public string Pattern => _regex.ToString();

    public bool IsMatch(string? text)
    {
        if (string.IsNullOrEmpty(text)) return false;
        try
        {
            return _regex.IsMatch(text);
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    /// <summary>[start, length] of the first <paramref name="max"/> non-empty matches.</summary>
    public List<int[]> Matches(string? text, int max = 32)
    {
        var list = new List<int[]>();
        if (string.IsNullOrEmpty(text)) return list;
        try
        {
            for (var m = _regex.Match(text); m.Success && list.Count < max; m = m.NextMatch())
                if (m.Length > 0) list.Add([m.Index, m.Length]);
        }
        catch (RegexMatchTimeoutException)
        {
            // Treated as no (further) match.
        }
        return list;
    }

    /// <summary>The text of the first match (a data hit without a key is opened with a "contains" filter on it).</summary>
    public string? FirstMatch(string? text)
    {
        var m = Matches(text, 1);
        return m.Count == 0 ? null : text!.Substring(m[0][0], m[0][1]);
    }

    /// <summary>
    /// A window of at most <paramref name="maxLength"/> characters around the first match (an ellipsis marks a cut), with the
    /// match ranges shifted into it. Line breaks and tabs become spaces so a snippet is always one line.
    /// </summary>
    public static (string Text, List<int[]> Ranges) Snippet(string text, List<int[]> ranges, int maxLength = 240)
    {
        var flat = Flatten(text);
        if (flat.Length <= maxLength || ranges.Count == 0) return (Clip(flat, maxLength), Clamp(ranges, Math.Min(flat.Length, maxLength)));
        var first = ranges[0];
        var start = Math.Max(0, first[0] - maxLength / 3);
        if (start + maxLength > flat.Length) start = Math.Max(0, flat.Length - maxLength);
        var end = Math.Min(flat.Length, start + maxLength);
        var prefix = start > 0 ? "…" : "";
        var suffix = end < flat.Length ? "…" : "";
        var body = flat[start..end];
        var shifted = new List<int[]>();
        foreach (var r in ranges)
        {
            var s = r[0] - start;
            var e = Math.Min(r[0] + r[1], end) - start;
            if (s < 0 || s >= body.Length || e <= s) continue;
            shifted.Add([s + prefix.Length, e - s]);
        }
        return (prefix + body + suffix, shifted);
    }

    private static string Flatten(string s)
    {
        if (s.IndexOfAny(['\r', '\n', '\t']) < 0) return s;
        var chars = s.ToCharArray();
        for (var i = 0; i < chars.Length; i++) if (chars[i] is '\r' or '\n' or '\t') chars[i] = ' ';
        return new string(chars);
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max] + "…";

    private static List<int[]> Clamp(List<int[]> ranges, int length) =>
        ranges.Where(r => r[0] < length).Select(r => new[] { r[0], Math.Min(r[1], length - r[0]) }).ToList();
}
