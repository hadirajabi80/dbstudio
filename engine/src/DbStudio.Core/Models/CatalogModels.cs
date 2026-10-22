namespace DbStudio.Core.Models;

// Rich catalog models produced by providers. The Host serializes SchemaCatalog to the compact
// wire format of docs/PLAN.md section 3.3 (CatalogObject with "t","n","c":[[...]], ...).

/// <summary>Object type tokens, identical to the wire "t" values.</summary>
public static class ObjectTypes
{
    public const string Table = "table", View = "view", MView = "mview", Proc = "proc", Func = "func",
        TableFunc = "tablefunc", Synonym = "synonym", Sequence = "sequence", Package = "package",
        Type = "type", Trigger = "trigger";
}

/// <param name="SearchPathIndex">M2 (PostgreSQL): position in <c>current_schemas(true)</c>; null when not on the search path.</param>
public sealed record SchemaInfo(string Name, int? ObjectCount = null, int? SearchPathIndex = null);

public sealed record SchemaCatalog(string? Database, string Name, IReadOnlyList<CatalogObject> Objects)
{
    /// <summary>Other schemas whose tables have foreign keys to a table of this schema (the ER diagram loads them, one hop).</summary>
    public IReadOnlyList<string> ReferencingSchemas { get; init; } = [];

    /// <summary>Foreign keys of this schema's tables left out because the referenced table or its columns are not visible to the login.</summary>
    public int HiddenForeignKeys { get; init; }
}

public sealed class CatalogObject
{
    public required string Type { get; init; }          // ObjectTypes.*
    public required string Name { get; init; }
    public string? Schema { get; init; }
    public string? Comment { get; init; }
    public List<CatalogColumn> Columns { get; init; } = [];
    public List<string> PrimaryKey { get; init; } = [];
    /// <summary>Outgoing FKs of this table.</summary>
    public List<ForeignKeyRef> ForeignKeys { get; init; } = [];
    /// <summary>Procedures/functions: parameters in order; scalar function return value has Direction "return".</summary>
    public List<ParamInfo> Parameters { get; init; } = [];
    /// <summary>Synonyms: the resolved target.</summary>
    public SynonymTarget? Target { get; init; }
    /// <summary>Oracle packages: member procedures/functions (each overload separately).</summary>
    public List<PackageMember> Members { get; init; } = [];
    /// <summary>Oracle: VALID | INVALID. Null elsewhere.</summary>
    public string? Status { get; init; }
}

/// <param name="Flags">1 = identity/autoincrement, 2 = computed/virtual/generated, 4 = hidden, 8 = never written by DML (Oracle GENERATED ALWAYS identity).</param>
public sealed record CatalogColumn(string Name, string TypeText, bool Nullable, bool IsPk, int Flags = 0, string? Comment = null);

/// <param name="RefSchema">Referenced schema (SQLite: database name, usually "main").</param>
/// <param name="IsDisabled">SQL Server: the key is disabled (<c>NOCHECK CONSTRAINT</c>) and not enforced.</param>
/// <param name="IsNotTrusted">SQL Server: existing rows were not checked (<c>WITH NOCHECK</c>, or a disabled key).</param>
public sealed record ForeignKeyRef(string Name, IReadOnlyList<string> Columns, string? RefSchema, string RefTable, IReadOnlyList<string> RefColumns,
    bool IsDisabled = false, bool IsNotTrusted = false);

/// <param name="Direction">in | out | inout | return.</param>
public sealed record ParamInfo(string Name, string TypeText, string Direction, bool HasDefault);

public sealed record SynonymTarget(string? Database, string? Schema, string Name, string? Type);

/// <param name="Kind">proc | func.</param>
public sealed record PackageMember(string Name, string Kind, int Overload, IReadOnlyList<ParamInfo> Parameters);

public sealed record ObjectRef(string? Database, string? Schema, string Name, string Type);

public sealed record ObjectDetails(
    ObjectRef Ref,
    IReadOnlyList<ColumnDetail> Columns,
    IReadOnlyList<IndexDetail> Indexes,
    IReadOnlyList<ForeignKeyRef> ForeignKeys,
    IReadOnlyList<ReferencedBy> ReferencedBy,
    IReadOnlyList<string> Triggers,
    IReadOnlyList<ParamInfo> Parameters,
    long? RowCountEstimate,
    DateTimeOffset? Created,
    DateTimeOffset? Modified);

public sealed record ColumnDetail(string Name, string Type, bool Nullable, string? Default, bool IsPk, bool IsIdentity, bool IsComputed, string? Comment, int Ordinal);

public sealed record IndexDetail(string Name, bool Unique, IReadOnlyList<string> Columns, string? Type, bool IsPrimaryKey = false);

public sealed record ReferencedBy(string? Schema, string Table, string Constraint, IReadOnlyList<string> Columns);

/// <param name="Source">"generated" | "stored".</param>
public sealed record DdlResult(string Ddl, string Source);

public sealed record ObjectError(int Line, int Col, string Message, string Severity);
