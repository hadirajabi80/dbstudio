using System.Globalization;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// Maps MySqlConnector errors to engine models: the server error number as the code (SQLSTATE in the detail), the
/// document line/column from "… near '…' at line N" (syntax errors) or from the offending name (unknown table/column).
/// </summary>
public static partial class MySqlErrors
{
    /// <summary>Server error numbers after which the connection is gone (server shutdown, killed connection, lost connection).</summary>
    public static bool IsConnectionLoss(int number) => number is 1053 or 1152 or 1153 or 1927 or 2006 or 2013 or 4031;

    public static bool IsConnectionFailure(Exception? ex) => ex switch
    {
        MySqlException m when IsConnectionLoss(m.Number) => true,
        MySqlException { InnerException: IOException or SocketException } => true,
        IOException or SocketException => true,
        _ => false,
    };

    /// <summary>1317 "Query execution was interrupted" (KILL QUERY / Cancel), 3024 max_execution_time, 1969 MariaDB statement timeout.</summary>
    public static bool IsInterrupted(Exception? ex) =>
        ex is MySqlException m && (m.Number is 1317 or 3024 or 1969 || m.ErrorCode == MySqlErrorCode.QueryInterrupted)
        || ex?.InnerException is MySqlException { Number: 1317 or 3024 or 1969 };

    [GeneratedRegex(@"near '(?<near>(?:[^']|'')*)' at line (?<line>\d+)", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex NearAtLine();

    [GeneratedRegex(@"\bat line (?<line>\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex AtLine();

    [GeneratedRegex(@"^(?:Unknown column|Table|Unknown table|FUNCTION|PROCEDURE) '(?<name>[^']+)'", RegexOptions.CultureInvariant)]
    private static partial Regex NamedObject();

    /// <summary>
    /// Error of a statement that starts at offset <paramref name="statementStart"/> of <paramref name="batch"/>.Sql (the text
    /// sent was <paramref name="statementText"/>). Line/col are document positions.
    /// </summary>
    public static ErrorInfo FromException(MySqlException ex, SqlBatch batch, int statementStart, string statementText)
    {
        var offset = Locate(ex.Message, statementText);
        int line, col;
        if (offset is int o)
        {
            (line, col) = MySqlSqlText.LineColAt(batch.Sql, Math.Clamp(statementStart + o, 0, batch.Sql.Length));
        }
        else
        {
            var first = MySqlSqlText.SkipTrivia(batch.Sql, Math.Clamp(statementStart, 0, batch.Sql.Length), batch.Sql.Length);
            (line, col) = MySqlSqlText.LineColAt(batch.Sql, Math.Min(first, batch.Sql.Length));
            col = -1;
        }
        var docLine = batch.Line + Math.Max(1, line) - 1;
        int? docCol = col < 0 ? null : line <= 1 ? batch.Col + col - 1 : col;
        return new ErrorInfo(ex.Number.ToString(CultureInfo.InvariantCulture), ex.Message, docLine, docCol,
            Detail: string.IsNullOrEmpty(ex.SqlState) ? null : "SQLSTATE " + ex.SqlState, ProviderCode: ex.Number);
    }

    /// <summary>0-based offset in <paramref name="statement"/> the server message points at, or null.</summary>
    public static int? Locate(string message, string statement)
    {
        var m = NearAtLine().Match(message);
        if (m.Success)
        {
            var near = m.Groups["near"].Value.Replace("''", "'");
            var lineNo = int.Parse(m.Groups["line"].Value, CultureInfo.InvariantCulture);
            var lineStart = LineStart(statement, lineNo);
            if (near.Length == 0) return lineStart is int ls ? Math.Min(statement.Length, LineEndOrText(statement, ls)) : statement.Length;
            // The server quotes at most 80 chars of the rest of the statement from the error position.
            var probe = near.Length > 40 ? near[..40] : near;
            if (lineStart is int start)
            {
                var idx = statement.IndexOf(probe, start, StringComparison.Ordinal);
                if (idx >= 0) return idx;
            }
            var any = statement.IndexOf(probe, StringComparison.Ordinal);
            if (any >= 0) return any;
            return lineStart;
        }
        var at = AtLine().Match(message);
        if (at.Success && LineStart(statement, int.Parse(at.Groups["line"].Value, CultureInfo.InvariantCulture)) is int l2)
            return MySqlSqlText.SkipTrivia(statement, l2, statement.Length);
        var named = NamedObject().Match(message);
        if (named.Success)
        {
            // 'shop.no_such' / 'o.nmae': the last part as a token of the statement
            var name = named.Groups["name"].Value;
            var last = name.Contains('.') ? name[(name.LastIndexOf('.') + 1)..] : name;
            foreach (var t in MySqlSqlText.Scan(statement))
                if ((t.Kind is MyTokenKind.Word or MyTokenKind.QuotedIdentifier) && t.Value.Equals(last, StringComparison.OrdinalIgnoreCase))
                    return t.Start;
        }
        return null;
    }

    private static int? LineStart(string text, int line)
    {
        if (line <= 1) return 0;
        var current = 1;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '\n') continue;
            if (++current == line) return i + 1;
        }
        return null;
    }

    private static int LineEndOrText(string text, int start)
    {
        var i = text.IndexOf('\n', start);
        return i < 0 ? text.Length : i;
    }

    /// <summary>The error of <c>POST /connections/test</c>: PROVIDER_ERROR with the error number / SQLSTATE in the detail.</summary>
    public static ErrorInfo ToProviderError(Exception ex) => ex switch
    {
        MySqlException m => new ErrorInfo(Core.Services.ErrorCodes.ProviderError, m.Message,
            Detail: string.Join(" ", new[] { m.Number > 0 ? "Error " + m.Number.ToString(CultureInfo.InvariantCulture) : null, string.IsNullOrEmpty(m.SqlState) ? null : "SQLSTATE " + m.SqlState }
                .Where(s => s is not null)), ProviderCode: m.Number),
        _ => new ErrorInfo(Core.Services.ErrorCodes.ProviderError, ex.Message, Detail: ex.GetType().Name),
    };
}
