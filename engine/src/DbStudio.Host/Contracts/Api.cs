using System.Text.Json.Nodes;
using DbStudio.Core.Export;
using DbStudio.Core.Models;

namespace DbStudio.Host.Contracts;

// Request/response DTOs of docs/PLAN.md section 3 (mirrors ui/src/api/types.ts). Responses that are plain Core models
// (ConnectionProfile, SessionInfo, ObjectDetails, HistoryEntry, ...) are serialized directly.

public sealed record HealthResponse(string Status, string Version, int Pid, bool Dev);

public sealed record ProviderInfoResponse(string Id, string DisplayName, Dialect Dialect, ConnectionFormSpec FormSpec);

/// <summary>POST/PUT /connections body: a profile without id/hasPassword plus the password (null = keep, "" = clear).</summary>
public sealed class ConnectionInput
{
    public string Name { get; set; } = "";
    public string ProviderId { get; set; } = "";
    public string? Color { get; set; }
    public string? Folder { get; set; }
    public bool ReadOnly { get; set; }
    public Dictionary<string, JsonNode?> Props { get; set; } = new();
    public bool SavePassword { get; set; } = true;
    public string? Password { get; set; }

    public ConnectionProfile ToProfile() => new()
    {
        Name = Name,
        ProviderId = ProviderId,
        Color = Color,
        Folder = Folder,
        ReadOnly = ReadOnly,
        Props = Props ?? new(),
        SavePassword = SavePassword,
    };
}

public sealed record TestConnectionRequest(ConnectionProfile? Profile, string? Password, bool UseStoredPassword = true);

public sealed record DatabasesResponse(IReadOnlyList<string> Databases, string? Current);

public sealed record RefreshRequest(string? Database, List<string>? Schemas);

public sealed record RefreshResponse(int Version);

public sealed record DdlResponse(string Ddl, string Source);

public sealed record CreateSessionRequest(string ConnectionId, string? Database, TransactionMode TxMode = TransactionMode.Auto, bool CaptureServerOutput = true);

public sealed record DatabaseRequest(string Database);

public sealed record TxModeRequest(TransactionMode TxMode);

public sealed record ExecuteSource(string? TabId, string? Title);

public sealed record ExecuteRequestDto(
    List<SqlBatch>? Batches,
    int? MaxRows,
    bool? StopOnError,
    string? Label,
    ExecuteSource? Source,
    bool? ConfirmedDestructive);

public sealed record ExecuteResponse(string ExecutionId, string StartedAt);

public sealed record CancelResponse(bool Cancelled);

public sealed record RowsPage(ColumnInfo[] Columns, IReadOnlyList<object?[]> Rows, long Total, bool Truncated);

public sealed record CellResponse(string Kind, string? Value, long Len);

public sealed record ResultSetExportRequest(string? Format, string? Path, ExportOptions? Options);

public sealed record ExportFileResponse(string Path, long Rows);

public sealed record QueryExportRequest(string? SessionId, string? Sql, string? Format, string? Path, ExportOptions? Options);

public sealed record QueryExportResponse(string ExportId);

public sealed record HistoryUpdateRequest(bool Pinned);

public sealed record DiagnosticsRequest(Dialect Dialect, string? Sql, string? ConnectionId);

public sealed record DiagnosticsResponse(IReadOnlyList<SqlDiagnostic> Diagnostics, string Engine);
