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
    : EngineEvent("exec.done")
{
    /// <summary>M1.5: values of out/inout parameters (omitted when none).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<Params.OutParamValue>? OutParams { get; init; }
}

/// <summary>M1.5 explain plan result (docs/PLAN-M1.5.md 3.8), published before exec.done.</summary>
/// <param name="Mode">"estimated" | "actual".</param>
/// <param name="RawFormat">"xml" | "text".</param>
public sealed record ExecPlanEvent(string ExecutionId, Dialect Dialect, string Mode, Plans.PlanNode Root, string Raw, string RawFormat, IReadOnlyList<string> Warnings)
    : EngineEvent("exec.plan");

public sealed record ExecDiagnosticsEvent(string ExecutionId, IReadOnlyList<SqlDiagnostic> Diagnostics) : EngineEvent("exec.diagnostics");

public sealed record SessionChangedEvent(string SessionId, SessionState State, bool TxOpen, string? Database, TransactionMode TxMode) : EngineEvent("session.changed");

public sealed record CatalogChangedEvent(string ConnectionId, string? Database, IReadOnlyList<string> Schemas, int Version) : EngineEvent("catalog.changed");

public sealed record ExportProgressEvent(string ExportId, long Rows) : EngineEvent("export.progress");

public sealed record ExportDoneEvent(string ExportId, string Path, long Rows, ExecutionStatus Status, string? Error) : EngineEvent("export.done");

/// <param name="Level">debug | info | warn | error.</param>
public sealed record EngineLogEvent(string Level, string Message) : EngineEvent("engine.log");

// ---- M2 (docs/PLAN-M2.md 1.1, 2.3, 2.4)

/// <summary>A batch of stream items (kind-specific JSON objects); <paramref name="Seq"/> is monotonic per stream, one per batch.</summary>
public sealed record StreamDataEvent(string StreamId, IReadOnlyList<System.Text.Json.JsonElement> Items, long Seq) : EngineEvent("stream.data");

/// <param name="State">open | paused | ended | error. "open" is re-sent about every second while items are dropped.</param>
/// <param name="Dropped">Items dropped so far (queue full or paused).</param>
public sealed record StreamStateEvent(string StreamId, string State, string? Reason, long Dropped) : EngineEvent("stream.state");

/// <param name="State">open | closed | broken.</param>
public sealed record SourceClientChangedEvent(string ConnectionId, string State) : EngineEvent("source.client");

public sealed record JobProgressEvent(string JobId, string Kind, long Done, long? Total, string? Message) : EngineEvent("job.progress");

public sealed record JobDoneEvent(string JobId, string Kind, ExecutionStatus Status, string? Error, System.Text.Json.JsonElement? Result) : EngineEvent("job.done");

/// <summary>Publisher that drops everything (tests, tools).</summary>
public sealed class NullEventPublisher : IEventPublisher
{
    public static readonly NullEventPublisher Instance = new();
    public void Publish(EngineEvent ev) { }
}
