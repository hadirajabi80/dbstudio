using DbStudio.Core.Params;

namespace DbStudio.Core.Models;

/// <param name="MaxRows">Row cap per result set; 0 = unlimited.</param>
/// <param name="Label">"statement" | "selection" | "script" (M1.5 also "filter" | "data" | "multi" | "explain").</param>
/// <param name="Params">M1.5 bind values (docs/PLAN-M1.5.md 3.8); null/empty = no binding (M1 behaviour).</param>
/// <param name="WritesConfirmed">B1: the user explicitly allowed this execution to write to a read-only connection
/// (ExecuteCommand.ConfirmedDestructive); SQLite lifts its <c>PRAGMA query_only</c> guard for it.</param>
public sealed record ExecuteRequest(
    IReadOnlyList<SqlBatch> Batches,
    int MaxRows,
    bool StopOnError,
    bool CaptureServerOutput,
    string Label,
    IReadOnlyList<QueryParam>? Params = null,
    bool WritesConfirmed = false);

/// <summary>One unit sent to the server. T-SQL: a GO-delimited batch. Oracle/SQLite: a single statement. Line/Col are 1-based document positions of its first char.</summary>
public sealed record SqlBatch(string Sql, int Line, int Col);

/// <summary>kind: int | float | decimal | string | bool | date | time | datetime | datetimeoffset | guid | binary | json | xml | cursor | other.</summary>
public sealed record ColumnInfo(
    string Name,
    int Ordinal,
    string DbType,
    string Kind,
    bool Nullable,
    int? Size = null,
    int? Precision = null,
    int? Scale = null,
    string? Table = null,
    string? Schema = null,
    bool IsKey = false);

/// <param name="Code">Provider error number as string ("207", "ORA-00942", "SQLITE_ERROR") or an engine code.</param>
/// <param name="Line">1-based, absolute to the editor document (provider adds batch.Line - 1).</param>
public sealed record ErrorInfo(string Code, string Message, int? Line = null, int? Col = null, int? State = null, string? Detail = null, int? ProviderCode = null);

/// <param name="OutParams">M1.5: values of out/inout params (refcursor outs are delivered as result sets instead).</param>
public sealed record ExecutionSummary(ExecutionStatus Status, long ElapsedMs, int ResultSets, long RowsAffected,
    IReadOnlyList<OutParamValue>? OutParams = null);
