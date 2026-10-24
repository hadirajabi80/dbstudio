using System.Globalization;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using ClickHouse.Driver;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// Maps ClickHouse errors to <see cref="ErrorInfo"/>: code = the server's error number ("60"), message without the
/// "Code: N. DB::Exception:" prefix and the "(version …)" suffix, the "Expected one of: …" list of syntax errors moved to
/// <see cref="ErrorInfo.Detail"/>, and "failed at position N" (bytes, 1-based, in the statement sent) mapped to the
/// document line/column.
/// </summary>
public static partial class ChErrors
{
    public const int UnknownTable = 60, SyntaxError = 62, UnknownDatabase = 81, AccessDenied = 497, NotEnoughPrivileges = 497,
        AuthenticationFailed = 516, SessionIsLocked = 373, SessionNotFound = 372, QueryWasCancelled = 394, Readonly = 164,
        UnknownQueryParameter = 456, TimeoutExceeded = 159;

    [GeneratedRegex(@"^Code:\s*(\d+)\.\s*(?:DB::Exception:\s*)?", RegexOptions.CultureInvariant)]
    private static partial Regex CodePrefix();

    [GeneratedRegex(@"\s*\(version [^\n]*$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionSuffix();

    [GeneratedRegex(@"failed at position (\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex Position();

    /// <summary>"(UNKNOWN_TABLE)" at the end of the message.</summary>
    [GeneratedRegex(@"\(([A-Z][A-Z0-9_]+)\)\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex CodeName();

    /// <summary>The server message without its prefix and version suffix.</summary>
    public static string CleanMessage(string message)
    {
        var m = (message ?? "").Trim();
        m = CodePrefix().Replace(m, "");
        m = VersionSuffix().Replace(m, "");
        return m.Trim();
    }

    /// <summary>(code, symbolic name) of a server error message.</summary>
    public static (int? Code, string? Name) CodeOf(string message)
    {
        var m = CodePrefix().Match(message ?? "");
        int? code = m.Success && int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var c) ? c : null;
        var name = CodeName().Match(VersionSuffix().Replace((message ?? "").Trim(), ""));
        return (code, name.Success ? name.Groups[1].Value : null);
    }

    public static ErrorInfo Map(Exception exception, SqlBatch batch, ChStatement? statement)
    {
        switch (exception)
        {
            case ClickHouseServerException ch:
            {
                var (code, name) = CodeOf(ch.Message);
                var errorCode = ch.ErrorCode != 0 ? ch.ErrorCode : code ?? 0;
                var text = CleanMessage(ch.Message);
                string? detail = name;
                var expected = text.IndexOf(" Expected one of:", StringComparison.Ordinal);
                if (expected > 0)
                {
                    detail = text[(expected + 1)..].Trim();
                    text = text[..expected].TrimEnd() + (name is null ? "" : $" ({name})");
                }
                var (line, col) = Locate(batch, statement, text);
                return new ErrorInfo(errorCode.ToString(CultureInfo.InvariantCulture), text, line, col, Detail: detail, ProviderCode: errorCode);
            }
            case HttpRequestException http:
                return new ErrorInfo(ErrorCodes.ProviderError, $"Cannot reach the ClickHouse server: {http.Message}",
                    StatementLine(batch, statement), Detail: http.InnerException?.Message);
            case SocketException sock:
                return new ErrorInfo(ErrorCodes.ProviderError, $"Cannot reach the ClickHouse server: {sock.Message}", StatementLine(batch, statement));
            case EngineException ee:
                return new ErrorInfo(ee.Code, ee.Message, StatementLine(batch, statement));
            default:
                return new ErrorInfo(ErrorCodes.EngineError, exception.Message, StatementLine(batch, statement), Detail: exception.GetType().Name);
        }
    }

    /// <summary>Document line/column of the error: the reported position, else the first line of the failing statement.</summary>
    public static (int Line, int? Col) Locate(SqlBatch batch, ChStatement? statement, string message)
    {
        var m = Position().Match(message);
        if (statement is not null && m.Success && int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var pos))
        {
            var offset = statement.Start + ChSqlText.CharOffsetOfBytePosition(statement.Text, pos);
            var (l, c) = SqlTokenizer.LineColAt(batch.Sql, Math.Clamp(offset, 0, batch.Sql.Length));
            return (batch.Line + l - 1, l <= 1 ? batch.Col + c - 1 : c);
        }
        return (StatementLine(batch, statement), null);
    }

    public static int StatementLine(SqlBatch batch, ChStatement? statement)
    {
        if (statement is not null)
        {
            var (l, _) = SqlTokenizer.LineColAt(batch.Sql, Math.Clamp(statement.Start, 0, batch.Sql.Length));
            return batch.Line + l - 1;
        }
        return batch.Line + ChSqlText.FirstTokenLine(batch.Sql) - 1;
    }

    /// <summary>A connection-test / catalog error as a provider error (message cleaned).</summary>
    public static ErrorInfo ToProviderError(Exception ex) => ex switch
    {
        ClickHouseServerException ch => new ErrorInfo(
            (ch.ErrorCode != 0 ? ch.ErrorCode : CodeOf(ch.Message).Code ?? 0).ToString(CultureInfo.InvariantCulture),
            CleanMessage(ch.Message), ProviderCode: ch.ErrorCode),
        HttpRequestException http => new ErrorInfo(ErrorCodes.ProviderError, $"Cannot reach the ClickHouse server: {http.Message}", Detail: http.InnerException?.Message),
        TaskCanceledException => new ErrorInfo(ErrorCodes.ProviderError, "The ClickHouse server did not answer in time (connect timeout)."),
        _ => new ErrorInfo(ErrorCodes.ProviderError, ex.Message),
    };

    public static bool IsPrivilegeError(int code) => code is 497 or 516 or 164;
}
