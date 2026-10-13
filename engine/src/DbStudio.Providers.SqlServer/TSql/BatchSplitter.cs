using System.Text.RegularExpressions;

namespace DbStudio.Providers.SqlServer.TSql;

/// <summary>A GO-delimited T-SQL batch with its 1-based start line in the document.</summary>
/// <param name="Offset">0-based character offset of the batch start in the document.</param>
/// <param name="RepeatCount">N of "GO N" (1 when absent).</param>
public sealed record TSqlBatchSegment(string Text, int StartLine, int Offset, int RepeatCount = 1);

/// <summary>
/// Splits a T-SQL document on GO separator lines, ignoring GO inside strings, quoted identifiers and comments
/// (block comments nest in T-SQL). Used by diagnostics; the UI owns splitting for execution (D-2).
/// </summary>
public static partial class BatchSplitter
{
    [GeneratedRegex(@"^\s*GO(?:\s+(?<n>\d+))?\s*(?:--.*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GoLine();

    public static IReadOnlyList<TSqlBatchSegment> Split(string sql)
    {
        ArgumentNullException.ThrowIfNull(sql);
        var result = new List<TSqlBatchSegment>();
        int batchStart = 0, batchLine = 1, line = 1;
        int i = 0, n = sql.Length;
        int commentDepth = 0;           // nested /* */ depth
        char quote = '\0';              // ' " or ]  when inside a delimited token

        while (i < n)
        {
            int lineStart = i;
            // Only whole lines outside any string/comment can be GO separators.
            bool lineStartsClean = commentDepth == 0 && quote == '\0';
            int lineEnd = sql.IndexOf('\n', i);
            if (lineEnd < 0) lineEnd = n;
            if (lineStartsClean)
            {
                var text = sql.AsSpan(lineStart, lineEnd - lineStart).TrimEnd('\r').ToString();
                var m = GoLine().Match(text);
                if (m.Success)
                {
                    int repeat = m.Groups["n"].Success && int.TryParse(m.Groups["n"].Value, out var r) && r > 0 ? r : 1;
                    result.Add(new TSqlBatchSegment(sql[batchStart..lineStart], batchLine, batchStart, repeat));
                    i = lineEnd < n ? lineEnd + 1 : n;
                    line++;
                    batchStart = i;
                    batchLine = line;
                    continue;
                }
            }

            // Scan the line, tracking lexical state.
            while (i < lineEnd)
            {
                char c = sql[i];
                char next = i + 1 < n ? sql[i + 1] : '\0';
                if (commentDepth > 0)
                {
                    if (c == '/' && next == '*') { commentDepth++; i += 2; continue; }
                    if (c == '*' && next == '/') { commentDepth--; i += 2; continue; }
                    i++;
                    continue;
                }
                if (quote != '\0')
                {
                    if (c == quote)
                    {
                        if (next == quote) { i += 2; continue; } // escaped '' "" ]]
                        quote = '\0';
                    }
                    i++;
                    continue;
                }
                switch (c)
                {
                    case '-' when next == '-':
                        i = lineEnd; // rest of line is a comment
                        continue;
                    case '/' when next == '*':
                        commentDepth = 1; i += 2;
                        continue;
                    case '\'':
                    case '"':
                        quote = c; i++;
                        continue;
                    case '[':
                        quote = ']'; i++;
                        continue;
                    default:
                        i++;
                        continue;
                }
            }
            if (i < n) { i++; line++; } // consume '\n'
        }
        result.Add(new TSqlBatchSegment(sql[batchStart..], batchLine, batchStart));
        return result;
    }
}
