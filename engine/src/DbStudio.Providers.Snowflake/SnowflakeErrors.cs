using System.Globalization;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Snowflake.Data.Client;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Maps Snowflake.Data errors to engine models: the vendor code zero-padded the way Snowflake prints it ("001003"), the
/// message without the driver's "Error: … SqlState: …, VendorCode: …, QueryId: …" wrapper, the document line/column of
/// "line N at position P" (P is 0-based), and the query id in the detail.
/// </summary>
public static partial class SnowflakeErrors
{
    /// <summary>"001003" for 1003; "SNOWFLAKE" when the driver gave none.</summary>
    public static string Code(int vendorCode) => vendorCode > 0 ? vendorCode.ToString("000000", CultureInfo.InvariantCulture) : "SNOWFLAKE";

    [GeneratedRegex(@"line\s+(\d+)\s+at\s+position\s+(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LinePosition();

    [GeneratedRegex(@"\s*SqlState:\s*[^,]*,\s*VendorCode:\s*-?\d+(,\s*QueryId:\s*\S*)?\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex DriverSuffix();

    /// <summary>The server's message without the driver's prefix/suffix.</summary>
    public static string CleanMessage(string message)
    {
        var m = message.Trim();
        if (m.StartsWith("Error: ", StringComparison.Ordinal)) m = m[7..];
        m = DriverSuffix().Replace(m, "");
        return m.Trim();
    }

    /// <summary>(line, col) from "… line 3 at position 14 …": 1-based line, 1-based column; null when absent.</summary>
    public static (int Line, int Col)? Position(string message)
    {
        var m = LinePosition().Match(message);
        if (!m.Success) return null;
        var line = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        var pos = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        return (Math.Max(1, line), pos + 1);
    }

    /// <summary>
    /// An error raised by a batch. <paramref name="lineOffset"/> is the 0-based line where the statement that failed
    /// starts within the batch text (multi-statement batches); positions refer to that statement.
    /// </summary>
    public static ErrorInfo FromException(SnowflakeDbException ex, SqlBatch batch, int lineOffset = 0, int colOffsetOnFirstLine = 0)
    {
        var message = CleanMessage(ex.Message);
        int? line = null, col = null;
        if (Position(message) is { } p)
        {
            var batchLine = p.Line + lineOffset;
            line = batch.Line + batchLine - 1;
            var c = p.Line == 1 ? p.Col + colOffsetOnFirstLine : p.Col;
            col = batchLine == 1 ? batch.Col + c - 1 : c;
        }
        return new ErrorInfo(
            Code: Code(ex.ErrorCode),
            Message: message,
            Line: line,
            Col: col,
            Detail: Detail(ex),
            ProviderCode: ex.ErrorCode);
    }

    private static string? Detail(SnowflakeDbException ex)
    {
        var parts = new List<string>();
        if (!string.IsNullOrEmpty(ex.SqlState)) parts.Add("SQLSTATE " + ex.SqlState);
        if (!string.IsNullOrEmpty(ex.QueryId)) parts.Add("query id " + ex.QueryId);
        return parts.Count == 0 ? null : string.Join(", ", parts);
    }

    /// <summary>Errors of login / test / catalog calls as a provider error (never throws).</summary>
    public static ErrorInfo ToProviderError(Exception ex)
    {
        var inner = Unwrap(ex);
        return inner switch
        {
            SnowflakeDbException sf => new ErrorInfo(Code(sf.ErrorCode), Friendly(sf), Detail: Detail(sf), ProviderCode: sf.ErrorCode),
            Gateway.SnowflakeQueryException q => q.ToError(),
            HttpRequestException or SocketException or TimeoutException or TaskCanceledException =>
                new ErrorInfo(ErrorCodes.ProviderError, "Could not reach Snowflake: " + inner.Message, Detail: inner.GetType().Name),
            ArgumentException or FileNotFoundException => new ErrorInfo(ErrorCodes.Validation, inner.Message),
            _ => new ErrorInfo(ErrorCodes.ProviderError, inner.Message, Detail: inner.GetType().Name),
        };
    }

    /// <summary>The innermost meaningful exception (the driver wraps login failures in AggregateException / Exception).</summary>
    public static Exception Unwrap(Exception ex)
    {
        var e = ex;
        while (true)
        {
            if (e is AggregateException agg && agg.InnerExceptions.Count == 1) { e = agg.InnerExceptions[0]; continue; }
            if (e is SnowflakeDbException) return e;
            if (e.InnerException is SnowflakeDbException inner) { e = inner; continue; }
            return e;
        }
    }

    /// <summary>Login failures with a hint (390100 wrong user/password, 390144 JWT invalid, 390318 OAuth expired, 250001 cannot reach).</summary>
    public static string Friendly(SnowflakeDbException sf)
    {
        var msg = CleanMessage(sf.Message);
        var hint = sf.ErrorCode switch
        {
            390100 => "Check user and password (or the authenticator).",
            390144 or 394304 => "The key-pair JWT was rejected: check that the user's RSA_PUBLIC_KEY matches the private key and that the account identifier is right.",
            390318 or 390303 => "The OAuth token expired or is invalid: paste a fresh token.",
            390189 or 390190 => "The role or warehouse in the profile is not granted to the user.",
            250001 or 270001 => "Check the account identifier (orgname-accountname or locator.region; the host is <account>.snowflakecomputing.com) and the network/proxy.",
            _ => null,
        };
        if (hint is null) return msg;
        return (msg.Length > 0 && !".!?".Contains(msg[^1]) ? msg + "." : msg) + " " + hint;
    }

    public static bool IsCancellation(Exception ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
        {
            if (e is OperationCanceledException) return true;
            // 000604 "SQL execution canceled", 270003/270007 driver cancel / timeout.
            if (e is SnowflakeDbException sf && (sf.ErrorCode is 604 or 270003 || sf.Message.Contains("execution canceled", StringComparison.OrdinalIgnoreCase)))
                return true;
        }
        return false;
    }

    /// <summary>390112 / 390114: the session expired or the token is gone (reopen the session).</summary>
    public static bool IsSessionGone(Exception? ex) =>
        ex is SnowflakeDbException sf && sf.ErrorCode is 390112 or 390114 or 390111 or 390113;
}
