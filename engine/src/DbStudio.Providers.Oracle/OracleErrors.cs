using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Oracle;

/// <summary>Maps Oracle errors to <see cref="ErrorInfo"/> with best-effort document positions (ODP.NET reports no offsets).</summary>
public static partial class OracleErrors
{
    public const int SuccessWithCompilationError = 24344;

    public static string Code(int number) => "ORA-" + number.ToString("D5", CultureInfo.InvariantCulture);

    [GeneratedRegex(@"line (?<line>\d+), column (?<col>\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LineColumn();

    [GeneratedRegex(@"""(?<id>[^""]+)""")]
    private static partial Regex QuotedName();

    [GeneratedRegex(@"identifier '(?<id>[^']+)' must be declared", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UndeclaredIdentifier();

    [GeneratedRegex(@"^(?<code>(?:ORA|PLS|PLW|SP2)-\d{4,5})", RegexOptions.CultureInvariant)]
    private static partial Regex LeadingCode();

    /// <summary>Splits ODP.NET's message into the text and the "https://docs.oracle.com/error-help/..." help link (23ai).</summary>
    public static (string Message, string? HelpUrl) CleanMessage(string message)
    {
        var lines = message.Replace("\r\n", "\n").Split('\n');
        var help = lines.FirstOrDefault(l => l.TrimStart().StartsWith("https://docs.oracle.com/error-help", StringComparison.OrdinalIgnoreCase))?.Trim();
        var text = string.Join("\n", lines.Where(l => !l.TrimStart().StartsWith("https://docs.oracle.com/error-help", StringComparison.OrdinalIgnoreCase))).Trim();
        return (text, help);
    }

    /// <summary>The leading error code of an ALL_ERRORS text ("PLS-00103: ..."), or null.</summary>
    public static string? LeadingCodeOf(string text)
    {
        var m = LeadingCode().Match(text.TrimStart());
        return m.Success ? m.Groups["code"].Value : null;
    }

    /// <summary>
    /// Maps an error raised by one statement.
    /// </summary>
    /// <param name="number">OracleException.Number.</param>
    /// <param name="message">OracleException.Message.</param>
    /// <param name="batch">The batch as sent by the UI.</param>
    /// <param name="executedSql">The normalized text actually executed (see <see cref="OracleSqlText.Prepare"/>).</param>
    /// <param name="executedOffset">Offset of <paramref name="executedSql"/> within the batch text.</param>
    /// <param name="rewritten">True when the text was rewritten (EXEC → BEGIN ... END;), so PL/SQL line numbers do not map.</param>
    public static ErrorInfo Map(int number, string message, SqlBatch batch, string executedSql, int executedOffset, bool rewritten)
    {
        var (text, help) = CleanMessage(message);
        (int Line, int Col)? pos = null;

        var lc = LineColumn().Match(text);
        if (number == 6550 && lc.Success && !rewritten)
        {
            int l = int.Parse(lc.Groups["line"].Value, CultureInfo.InvariantCulture);
            int c = int.Parse(lc.Groups["col"].Value, CultureInfo.InvariantCulture);
            pos = FromExecutedLineCol(batch, executedOffset, l, c);
        }
        else
        {
            string? ident = null;
            var undeclared = UndeclaredIdentifier().Match(text);
            if (undeclared.Success) ident = undeclared.Groups["id"].Value;
            else
            {
                var quoted = QuotedName().Matches(text);
                if (quoted.Count > 0) ident = quoted[^1].Groups["id"].Value;
            }
            if (ident is not null)
            {
                int off = OracleSqlText.FindIdentifier(executedSql, ident);
                if (off >= 0 && !rewritten) pos = FromBatchOffset(batch, executedOffset + off);
            }
        }

        // Unknown position: the statement's first token (skipping leading comments).
        pos ??= FromBatchOffset(batch, executedOffset + (OracleSqlText.Tokenize(executedSql).Select(t => (int?)t.Offset).FirstOrDefault() ?? 0));
        return new ErrorInfo(Code(number), text, pos.Value.Line, pos.Value.Col, null, help, number);
    }

    /// <summary>Document (line, col) of a 0-based offset in the batch text.</summary>
    public static (int Line, int Col) FromBatchOffset(SqlBatch batch, int offset)
    {
        var (l, c) = OracleSqlText.LineCol(batch.Sql, offset);
        return (batch.Line + l - 1, l == 1 ? batch.Col + c - 1 : c);
    }

    /// <summary>Document (line, col) of a 1-based (line, col) inside the executed text.</summary>
    public static (int Line, int Col) FromExecutedLineCol(SqlBatch batch, int executedOffset, int line, int col)
    {
        var (sl, sc) = OracleSqlText.LineCol(batch.Sql, executedOffset);
        int batchLine = sl + Math.Max(1, line) - 1;
        int batchCol = line <= 1 ? sc + Math.Max(1, col) - 1 : Math.Max(1, col);
        return (batch.Line + batchLine - 1, batchLine == 1 ? batch.Col + batchCol - 1 : batchCol);
    }

    /// <summary>
    /// Maps an ALL_ERRORS row of a unit created by the batch. ALL_SOURCE line 1 starts at the object-type keyword
    /// (CREATE [OR REPLACE] is not stored), so line 1 columns are relative to that keyword. Line 0 (views) maps to the keyword.
    /// </summary>
    public static (int Line, int Col) MapCompileError(SqlBatch batch, int keywordOffsetInBatch, int errorLine, int errorCol)
    {
        var (kl, kc) = OracleSqlText.LineCol(batch.Sql, keywordOffsetInBatch);
        if (errorLine <= 0) return (batch.Line + kl - 1, kl == 1 ? batch.Col + kc - 1 : kc);
        int batchLine = kl + errorLine - 1;
        int batchCol = errorLine == 1 ? kc + Math.Max(1, errorCol) - 1 : Math.Max(1, errorCol);
        return (batch.Line + batchLine - 1, batchLine == 1 ? batch.Col + batchCol - 1 : batchCol);
    }
}
