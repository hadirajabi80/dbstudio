using System.Text.RegularExpressions;
using DbStudio.Core.Services;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// Driver exception → engine error (docs/PLAN-M2.md 6, "Wire contract"): Unauthorized (13) → 403 PRIVILEGE with
/// <c>detail.needs</c>; other server errors (MaxTimeMSExpired 50 included) → 422 PROVIDER_ERROR with
/// <c>{ providerCode, codeName }</c>; connection-level failures → 503 SOURCE_UNAVAILABLE (the caller marks the client
/// broken); ShellJson parse errors → 400 VALIDATION with <c>{ field, offset, line, col }</c>.
/// </summary>
public static partial class MongoErrors
{
    public const int Unauthorized = 13, MaxTimeMSExpired = 50, NamespaceNotFound = 26, CommandNotSupportedOnView = 166,
        ChangeStreamNeedsReplicaSet = 40573, DuplicateKey = 11000;

    /// <summary>True when the failure means the client lost its servers (mark it broken, answer 503).</summary>
    public static bool IsConnectionFailure(Exception ex) => ex is MongoConnectionException or TimeoutException or MongoConnectionPoolPausedException;

    /// <summary>Server error code of a driver exception, or null.</summary>
    public static int? CodeOf(Exception ex) => ex switch
    {
        MongoCommandException c => c.Code,
        MongoExecutionTimeoutException t => t.Code,
        MongoWriteException w => w.WriteError?.Code,
        MongoBulkWriteException b when b.WriteErrors.Count > 0 => b.WriteErrors[0].Code,
        _ => null,
    };

    public static string? CodeNameOf(Exception ex) => ex switch
    {
        MongoCommandException c => c.CodeName,
        MongoExecutionTimeoutException t => t.CodeName ?? "MaxTimeMSExpired",
        _ => null,
    };

    public static bool IsUnauthorized(Exception ex) => CodeOf(ex) == Unauthorized || CodeNameOf(ex) == "Unauthorized";

    public static bool IsTimeout(Exception ex) => ex is MongoExecutionTimeoutException || CodeOf(ex) == MaxTimeMSExpired;

    /// <summary>The engine error for <paramref name="ex"/>, or null when it is not a Mongo/ShellJson failure.</summary>
    public static EngineException? Map(Exception ex)
    {
        switch (ex)
        {
            case EngineException e:
                return e;
            case ShellJsonException s:
                return EngineException.Validation(s.Field + ": " + s.Message, new { field = s.Field, offset = s.Offset, line = s.Line, col = s.Col });
            case MongoAuthenticationException or MongoConnectionException or TimeoutException or MongoConnectionPoolPausedException:
                return EngineException.SourceUnavailable(MongoSettingsBuilder.Redact(ex.Message, null));
        }
        if (IsUnauthorized(ex)) return EngineException.Privilege(ex.Message, NeedsOf(ex.Message));
        if (ex is MongoServerException or MongoWriteException or MongoBulkWriteException)
            return new EngineException(422, ErrorCodes.ProviderError, ex.Message, new { providerCode = CodeOf(ex), codeName = CodeNameOf(ex) });
        return null;
    }

    /// <summary>"not authorized on shop to execute command { find: "orders", … }" → "find on shop.orders".</summary>
    public static string? NeedsOf(string message)
    {
        var m = NotAuthorized().Match(message);
        if (!m.Success) return null;
        var db = m.Groups["db"].Value;
        var cmd = m.Groups["cmd"].Value;
        var target = m.Groups["coll"].Success ? m.Groups["coll"].Value : null;
        return target is null || target == "1" || cmd is "listDatabases" or "replSetGetStatus" or "currentOp"
            ? $"{cmd} on {db}"
            : $"{cmd} on {db}.{target}";
    }

    [GeneratedRegex("""not authorized on (?<db>[^\s]+) to execute command \{ ?"?(?<cmd>\w+)"?\s*:\s*(?:"(?<coll>[^"]+)"|(?<coll>[\w.]+))?""")]
    private static partial Regex NotAuthorized();
}
