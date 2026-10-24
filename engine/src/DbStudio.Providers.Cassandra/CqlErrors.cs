using System.Globalization;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Driver exceptions → <see cref="ErrorInfo"/>. Codes are the native protocol error names (cqlsh shows them the same way:
/// "SyntaxException", "InvalidRequest", "Unavailable", "ReadTimeout", …) with the protocol error number as the provider
/// code; consistency failures carry the level and the replica counts in the detail.
/// </summary>
public static partial class CqlErrors
{
    public const string SyntaxError = "SyntaxError", Invalid = "Invalid", Unavailable = "Unavailable", ReadTimeout = "ReadTimeout",
        WriteTimeout = "WriteTimeout", ReadFailure = "ReadFailure", WriteFailure = "WriteFailure", Overloaded = "Overloaded",
        Unauthorized = "Unauthorized", BadCredentials = "BadCredentials", AlreadyExists = "AlreadyExists", FunctionFailure = "FunctionFailure",
        Truncate = "TruncateError", ServerError = "ServerError", ProtocolError = "ProtocolError", Bootstrapping = "IsBootstrapping",
        ConfigError = "ConfigError", NoHostAvailable = "NoHostAvailable", ClientTimeout = "ClientTimeout";

    [GeneratedRegex(@"line (\d+):(\d+)")]
    private static partial Regex LinePattern();

    /// <summary>Maps an exception raised by a statement of <paramref name="batch"/> starting at <paramref name="statementOffset"/>.</summary>
    public static ErrorInfo ToError(Exception ex, SqlBatch? batch = null, int statementOffset = 0)
    {
        var (code, number) = Classify(ex);
        var message = ex.Message;
        string? detail = null;
        switch (ex)
        {
            case UnavailableException u:
                detail = $"Consistency {CqlConnectionSettings.ConsistencyName(u.Consistency)} needs {u.RequiredReplicas} replica(s), {u.AliveReplicas} alive.";
                message = $"Not enough replicas available: {detail}";
                break;
            case QueryTimeoutException t:
                detail = $"Consistency {CqlConnectionSettings.ConsistencyName(t.ConsistencyLevel)}: {t.ReceivedAcknowledgements} of {t.RequiredAcknowledgements} replica(s) answered"
                         + (t is WriteTimeoutException w ? $" (write type {w.WriteType})" : "")
                         + (t is ReadTimeoutException r ? (r.WasDataRetrieved ? ", data was retrieved" : ", no data retrieved") : "") + ".";
                message = $"{ex.Message} {detail}";
                break;
            case ReadFailureException rf:
                detail = $"Consistency {CqlConnectionSettings.ConsistencyName(rf.ConsistencyLevel)}: {rf.ReceivedAcknowledgements} of {rf.RequiredAcknowledgements} replica(s), {rf.Failures} failure(s).";
                break;
            case WriteFailureException wf:
                detail = $"Consistency {CqlConnectionSettings.ConsistencyName(wf.ConsistencyLevel)}: {wf.ReceivedAcknowledgements} of {wf.RequiredAcknowledgements} replica(s), {wf.Failures} failure(s), write type {wf.WriteType}.";
                break;
            case NoHostAvailableException nh:
                detail = nh.Errors.Count == 0 ? null
                    : string.Join("; ", nh.Errors.Select(e => $"{e.Key}: {e.Value.Message}"));
                message = detail is null ? "No Cassandra node could be reached." : $"No Cassandra node could be reached ({detail}).";
                break;
            case OperationTimedOutException:
                message = $"The request timed out on the client: {ex.Message} (raise the connection's request timeout for long statements).";
                break;
        }

        int? line = null, col = null;
        if (batch is not null)
        {
            var m = LinePattern().Match(ex.Message);
            if (m.Success && ex is global::Cassandra.SyntaxError or InvalidQueryException)
            {
                // "line 1:23 …" is relative to the statement as sent.
                var relLine = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                var relCol = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) + 1;
                var (sl, sc) = CqlText.LineColAt(batch.Sql, statementOffset);
                var batchLine = sl + relLine - 1;
                var batchCol = relLine == 1 ? sc + relCol - 1 : relCol;
                line = batch.Line + batchLine - 1;
                col = batchLine == 1 ? batch.Col + batchCol - 1 : batchCol;
            }
            else
            {
                var (sl, sc) = CqlText.LineColAt(batch.Sql, statementOffset);
                line = batch.Line + sl - 1;
                col = sl == 1 ? batch.Col + sc - 1 : sc;
            }
        }
        return new ErrorInfo(code, message, line, col, Detail: detail, ProviderCode: number);
    }

    public static (string Code, int? Number) Classify(Exception ex) => ex switch
    {
        global::Cassandra.SyntaxError => (SyntaxError, 0x2000),
        InvalidConfigurationInQueryException => (ConfigError, 0x2300),
        InvalidQueryException => (Invalid, 0x2200),
        UnavailableException => (Unavailable, 0x1000),
        ReadTimeoutException => (ReadTimeout, 0x1200),
        WriteTimeoutException => (WriteTimeout, 0x1100),
        ReadFailureException => (ReadFailure, 0x1300),
        WriteFailureException => (WriteFailure, 0x1500),
        OverloadedException => (Overloaded, 0x1001),
        IsBootstrappingException => (Bootstrapping, 0x1002),
        TruncateException => (Truncate, 0x1003),
        UnauthorizedException => (Unauthorized, 0x2100),
        global::Cassandra.AuthenticationException => (BadCredentials, 0x0100),
        AlreadyExistsException => (AlreadyExists, 0x2400),
        FunctionFailureException => (FunctionFailure, 0x1400),
        ProtocolErrorException => (ProtocolError, 0x000A),
        ServerErrorException => (ServerError, 0x0000),
        NoHostAvailableException => (NoHostAvailable, null),
        OperationTimedOutException => (ClientTimeout, null),
        EngineException ee => (ee.Code, null),
        _ => (ErrorCodes.ProviderError, null),
    };

    /// <summary>The cluster cannot be used any more (every node unreachable).</summary>
    public static bool IsConnectionLoss(Exception ex) => ex is NoHostAvailableException or SocketException;

    /// <summary>Exceptions a connection test / catalog call reports as a provider error instead of a 500.</summary>
    public static bool IsDriverFailure(Exception ex) =>
        ex is DriverException or SocketException or TimeoutException or ArgumentException or IOException or InvalidOperationException
            or System.Security.Authentication.AuthenticationException;
}
