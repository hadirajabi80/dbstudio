using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis;

/// <summary>Maps driver exceptions to the REST error envelope (docs/PLAN-M2.md 5.1: ACL errors → PRIVILEGE).</summary>
public static class RedisErrors
{
    /// <summary>The engine exception for a driver failure, or null when <paramref name="ex"/> is not a driver failure.</summary>
    public static EngineException? Map(Exception ex, string? command = null) => ex switch
    {
        EngineException e => e,
        RedisServerException s => FromServerError(s.Message, command),
        RedisTimeoutException t => EngineException.SourceUnavailable(Clean(t.Message)),
        RedisConnectionException c => EngineException.SourceUnavailable(Clean(c.InnerException?.Message is { Length: > 0 } inner && c.FailureType == ConnectionFailureType.AuthenticationFailure
            ? inner : c.Message)),
        RedisCommandException c => EngineException.Validation(c.Message),
        _ => null,
    };

    /// <summary>A server error reply (`-ERR ...`, `-NOPERM ...`) as an engine exception.</summary>
    public static EngineException FromServerError(string message, string? command = null)
    {
        if (IsPermissionError(message))
            return EngineException.Privilege(message, command is null ? "ACL permission" : $"+{command.ToLowerInvariant()}");
        return new EngineException(400, ErrorCodes.ProviderError, message);
    }

    public static bool IsPermissionError(string message) =>
        message.StartsWith("NOPERM", StringComparison.Ordinal) || message.StartsWith("NOAUTH", StringComparison.Ordinal) ||
        message.StartsWith("WRONGPASS", StringComparison.Ordinal);

    /// <summary>Runs a driver call and maps its failures.</summary>
    public static async Task<T> Guard<T>(Func<Task<T>> call, string? command = null)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (Exception ex) when (Map(ex, command) is { } mapped && !ReferenceEquals(mapped, ex))
        {
            throw mapped;
        }
    }

    public static async Task Guard(Func<Task> call, string? command = null)
    {
        try
        {
            await call().ConfigureAwait(false);
        }
        catch (Exception ex) when (Map(ex, command) is { } mapped && !ReferenceEquals(mapped, ex))
        {
            throw mapped;
        }
    }

    /// <summary>StackExchange.Redis messages carry configuration advice that means nothing to the user: keep the first part.</summary>
    public static string Clean(string message)
    {
        foreach (var cut in new[] { " To allow this multiplexer", "; to allow this multiplexer", ", mc:", " (Please take a look at this article", ", command=", ", inst:", ", serverEndpoint:" })
        {
            var i = message.IndexOf(cut, StringComparison.OrdinalIgnoreCase);
            if (i > 0) message = message[..i];
        }
        return message.Trim().TrimEnd(',', ';');
    }
}
