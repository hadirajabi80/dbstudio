using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// Optional extension of <see cref="Providers.IExecutionSink"/>: sinks that also implement this interface receive
/// server-side diagnostics produced during execution (Oracle ALL_ERRORS after CREATE, mapped to document lines),
/// forwarded to the UI as the <c>exec.diagnostics</c> WebSocket event. Providers call
/// <see cref="AdoSessionBase.EmitDiagnosticsAsync"/> instead of testing for this interface themselves.
/// </summary>
public interface IExecutionDiagnosticsSink
{
    ValueTask Diagnostics(int batchIndex, IReadOnlyList<SqlDiagnostic> diagnostics);
}

/// <summary>Thrown by <see cref="AdoSessionBase.ExecuteAsync"/> when the connection was lost; the session manager reopens it.</summary>
public sealed class SessionBrokenException(string? message = null)
    : InvalidOperationException(message ?? "The session's connection is broken.");

/// <summary>Raised by services for REST-visible failures; the Host maps it to the error envelope.</summary>
public class EngineException(int status, string code, string message, object? detail = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public object? Detail { get; } = detail;

    public static EngineException NotFound(string what) => new(404, ErrorCodes.NotFound, $"{what} was not found.");
    public static EngineException Validation(string message, object? detail = null) => new(400, ErrorCodes.Validation, message, detail);

    // ---- M2 (docs/PLAN-M2.md 1.1)

    /// <summary>503 SOURCE_UNAVAILABLE: the Redis/Mongo/Kafka client cannot connect (message = driver message).</summary>
    public static EngineException SourceUnavailable(string message, object? detail = null) => new(503, ErrorCodes.SourceUnavailable, message, detail);

    /// <summary>429 STREAM_LIMIT: more than the allowed open streams per UI client (or engine-wide).</summary>
    public static EngineException StreamLimit(string message, object? detail = null) => new(429, ErrorCodes.StreamLimit, message, detail);

    /// <summary>403 PRIVILEGE: the server denied a system view or command; <paramref name="needs"/> names the grant (detail.needs).</summary>
    public static EngineException Privilege(string message, string? needs) => new(403, ErrorCodes.Privilege, message, new { needs });

    /// <summary>403 READ_ONLY for a non-SQL action on a read-only connection; the message names the action.</summary>
    public static EngineException ReadOnly(string connectionName, string action) =>
        new(403, ErrorCodes.ReadOnly, $"The connection '{connectionName}' is read-only: {action} is not allowed.", new { action });
}

/// <summary>Error codes of the REST error envelope (docs/PLAN.md section 3) and engine-generated execution errors.</summary>
public static class ErrorCodes
{
    public const string Unauthorized = "UNAUTHORIZED", NotFound = "NOT_FOUND", Validation = "VALIDATION",
        SessionBusy = "SESSION_BUSY", SessionBroken = "SESSION_BROKEN", TxOpen = "TX_OPEN", ProviderError = "PROVIDER_ERROR",
        BindVarsUnsupported = "BIND_VARS_UNSUPPORTED", NotSupported = "NOT_SUPPORTED", ReadOnly = "READ_ONLY",
        EngineError = "ENGINE_ERROR", Cancelled = "CANCELLED",
        // M2 (docs/PLAN-M2.md 1.1, 7.5)
        SourceUnavailable = "SOURCE_UNAVAILABLE", StreamLimit = "STREAM_LIMIT", Privilege = "PRIVILEGE", GroupActive = "GROUP_ACTIVE";
}
