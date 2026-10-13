using System.Text.Json.Serialization;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>Fan-out of server → client events (the Host implements it over the single WebSocket).</summary>
public interface IEventPublisher
{
    /// <summary>Queues the event for every authenticated client. Never blocks; ordering per publisher thread is preserved.</summary>
    void Publish(EngineEvent ev);
}

/// <summary>Base of every WebSocket event (docs/PLAN.md 3.6). Serialized with its runtime type, camelCase.</summary>
public abstract record EngineEvent
{
    protected EngineEvent(string type) => Type = type;

    [JsonPropertyOrder(-2)] public string Type { get; }
    [JsonPropertyOrder(-1)] public string Ts { get; init; } = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
}

public sealed record AuthOkEvent() : EngineEvent("auth.ok");
public sealed record PongEvent() : EngineEvent("pong");

public sealed record ExecStartedEvent(string ExecutionId, string SessionId, int BatchCount) : EngineEvent("exec.started");
public sealed record ExecBatchStartedEvent(string ExecutionId, int BatchIndex) : EngineEvent("exec.batch.started");
public sealed record ExecResultSetEvent(string ExecutionId, int ResultSetId, int BatchIndex, ColumnInfo[] Columns) : EngineEvent("exec.resultset");
public sealed record ExecRowsEvent(string ExecutionId, int ResultSetId, IReadOnlyList<object?[]> Rows) : EngineEvent("exec.rows");
public sealed record ExecResultSetEndEvent(string ExecutionId, int ResultSetId, long RowCount, bool Truncated, long ElapsedMs) : EngineEvent("exec.resultset.end");
public sealed record ExecAffectedEvent(string ExecutionId, int BatchIndex, long Count, string? StatementKind) : EngineEvent("exec.affected");

public sealed record ExecMessageEvent(string ExecutionId, int BatchIndex, MessageSeverity Severity, string Text, int? Line, int? Code, MessageSource Source)
    : EngineEvent("exec.message");

public sealed record ExecErrorEvent(string ExecutionId, int BatchIndex, string Code, string Message, int? Line, int? Col, string? Detail)
    : EngineEvent("exec.error");

public sealed record ExecBatchEndedEvent(string ExecutionId, int BatchIndex, long ElapsedMs, BatchStatus Status) : EngineEvent("exec.batch.ended");

public sealed record ExecDoneEvent(string ExecutionId, string SessionId, ExecutionStatus Status, long ElapsedMs, int ResultSets, long RowsAffected, bool TxOpen)
    : EngineEvent("exec.done");

public sealed record ExecDiagnosticsEvent(string ExecutionId, IReadOnlyList<SqlDiagnostic> Diagnostics) : EngineEvent("exec.diagnostics");

public sealed record SessionChangedEvent(string SessionId, SessionState State, bool TxOpen, string? Database, TransactionMode TxMode) : EngineEvent("session.changed");

public sealed record CatalogChangedEvent(string ConnectionId, string? Database, IReadOnlyList<string> Schemas, int Version) : EngineEvent("catalog.changed");

public sealed record ExportProgressEvent(string ExportId, long Rows) : EngineEvent("export.progress");

public sealed record ExportDoneEvent(string ExportId, string Path, long Rows, ExecutionStatus Status, string? Error) : EngineEvent("export.done");

/// <param name="Level">debug | info | warn | error.</param>
public sealed record EngineLogEvent(string Level, string Message) : EngineEvent("engine.log");

/// <summary>Publisher that drops everything (tests, tools).</summary>
public sealed class NullEventPublisher : IEventPublisher
{
    public static readonly NullEventPublisher Instance = new();
    public void Publish(EngineEvent ev) { }
}
