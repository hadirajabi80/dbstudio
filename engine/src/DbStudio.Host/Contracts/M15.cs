using DbStudio.Core.Designer;
using DbStudio.Core.Params;

namespace DbStudio.Host.Contracts;

// M1.5 request/response DTOs (docs/PLAN-M1.5.md 3.7–3.9; mirrors the "M1.5" block of ui/src/api/types.ts).
// Responses that are Core models (SavedFilter, DescribeResult, TableModel, TableScript, DdlScript, ViewModel,
// DesignerTypesInfo, SampleDbResult) are serialized directly.

/// <summary>POST /sessions/{sid}/describe.</summary>
public sealed record DescribeRequestDto(string? Sql, List<QueryParam>? Params);

/// <summary>POST /sessions/{sid}/explain. Mode "estimated" (default) | "actual".</summary>
public sealed record ExplainRequestDto(
    string? Sql,
    List<QueryParam>? Params,
    string? Mode,
    int? MaxRows,
    int? Line,
    int? Col,
    ExecuteSource? Source,
    bool? ConfirmedDestructive);

/// <summary>POST /sample-db.</summary>
public sealed record SampleDbRequestDto(bool? Reset);

/// <summary>POST /connections/{id}/designer/table/script.</summary>
public sealed record TableScriptRequestDto(string? Database, TableModel? Original, TableModel? Desired);

/// <summary>POST /connections/{id}/designer/view/script.</summary>
public sealed record ViewScriptRequestDto(string? Database, string? Schema, string? Name, string? OriginalName, string? Body, ViewOptions? Options);

/// <summary>POST /connections/{id}/designer/apply.</summary>
public sealed record DdlApplyRequestDto(string? Database, List<string>? Statements, bool? Transactional, string? Schema);

/// <summary>200 response of POST /connections/{id}/designer/apply (failures are 409 DDL_FAILED).</summary>
public sealed record DdlApplyResponse(bool Ok, int Executed, long ElapsedMs);
