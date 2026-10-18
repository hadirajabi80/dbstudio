namespace DbStudio.Core.Designer;

// Wire models of the table designer (docs/PLAN-M1.5.md 1.3.1 and 3.9; ui/src/api/types.ts TableModel ...).
// Immutable records with list defaults so a partially specified JSON body deserializes to a usable model.

public sealed record TableModel
{
    public string? Schema { get; init; }
    public string Name { get; init; } = "";
    public string? Comment { get; init; }
    public TableOptions Options { get; init; } = new();
    public List<TableColumnModel> Columns { get; init; } = [];
    public PrimaryKeyModel? PrimaryKey { get; init; }
    public List<UniqueModel> Uniques { get; init; } = [];
    public List<IndexModel> Indexes { get; init; } = [];
    public List<ForeignKeyModel> ForeignKeys { get; init; } = [];
    public List<CheckModel> Checks { get; init; } = [];

    public TableColumnModel? Column(string name) =>
        Columns.FirstOrDefault(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
}

public sealed record TableOptions
{
    public bool WithoutRowid { get; init; }
    public bool Strict { get; init; }
    public string? Tablespace { get; init; }
}

public sealed record TableColumnModel
{
    /// <summary>Stable id assigned by the UI (= the original column name for existing columns); a rename keeps it.</summary>
    public string? Id { get; init; }
    public string Name { get; init; } = "";
    /// <summary>Full type text incl. size: "nvarchar(100)", "NUMBER(10,2)", "TEXT".</summary>
    public string Type { get; init; } = "";
    public bool Nullable { get; init; } = true;
    /// <summary>Default as an SQL expression ("0", "'x'", "SYSUTCDATETIME()"); null = none.</summary>
    public string? Default { get; init; }
    /// <summary>SQL Server default constraint name.</summary>
    public string? DefaultName { get; init; }
    public IdentityModel? Identity { get; init; }
    public ComputedModel? Computed { get; init; }
    public string? Collation { get; init; }
    public string? Comment { get; init; }
    /// <summary>SQLite INTEGER PRIMARY KEY AUTOINCREMENT.</summary>
    public bool Autoincrement { get; init; }
}

/// <param name="Always">Oracle GENERATED ALWAYS (false = BY DEFAULT).</param>
public sealed record IdentityModel(long Seed = 1, long Increment = 1, bool Always = false);

public sealed record ComputedModel(string Expression, bool Persisted = false);

public sealed record PrimaryKeyModel
{
    public string? Name { get; init; }
    public List<string> Columns { get; init; } = [];
    public bool Clustered { get; init; } = true;
}

public sealed record UniqueModel
{
    public string? Name { get; init; }
    public List<string> Columns { get; init; } = [];
}

public sealed record IndexColumnModel(string Name, bool Desc = false);

public sealed record IndexModel
{
    public string Name { get; init; } = "";
    public List<IndexColumnModel> Columns { get; init; } = [];
    public bool Unique { get; init; }
    public bool Clustered { get; init; }
    public List<string> Include { get; init; } = [];
    public string? Filter { get; init; }
}

public sealed record ForeignKeyModel
{
    public string? Name { get; init; }
    public List<string> Columns { get; init; } = [];
    public string? RefSchema { get; init; }
    public string RefTable { get; init; } = "";
    public List<string> RefColumns { get; init; } = [];
    /// <summary>"NO ACTION" | "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT".</summary>
    public string OnDelete { get; init; } = ReferentialActions.NoAction;
    public string OnUpdate { get; init; } = ReferentialActions.NoAction;
}

public sealed record CheckModel
{
    public string? Name { get; init; }
    public string Expression { get; init; } = "";
}

public static class ReferentialActions
{
    public const string NoAction = "NO ACTION", Cascade = "CASCADE", SetNull = "SET NULL", SetDefault = "SET DEFAULT", Restrict = "RESTRICT";

    public static readonly IReadOnlyList<string> All = [NoAction, Cascade, SetNull, SetDefault, Restrict];

    /// <summary>Upper-cases and normalizes spacing ("set  null" → "SET NULL"); null/empty → NO ACTION.</summary>
    public static string Normalize(string? action)
    {
        if (string.IsNullOrWhiteSpace(action)) return NoAction;
        var a = string.Join(' ', action.Trim().ToUpperInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return a;
    }
}

// ------------------------------------------------------------------ views

public sealed record ViewOptions(bool SchemaBinding = false, bool CheckOption = false, bool Force = false);

/// <summary>An existing view: the SELECT body extracted from the stored DDL.</summary>
public sealed record ViewModel(string? Schema, string Name, string Body, ViewOptions Options, string Ddl);

public sealed record ViewDefinition(string? Schema, string Name, string? OriginalName, string Body, ViewOptions Options);

// ------------------------------------------------------------------ types and features

/// <param name="Params">"length" | "precisionScale" | "precision" | "none".</param>
/// <param name="Category">"string" | "number" | "date" | "binary" | "other".</param>
public sealed record DesignerType(string Name, string Params, string Default, string Category);

public sealed record DesignerFeatures(
    bool Identity,
    bool Computed,
    bool ClusteredIndexes,
    bool IncludedColumns,
    bool FilteredIndexes,
    bool OnUpdateAction,
    bool Comments,
    bool RenameColumn,
    bool DropColumn,
    bool WithoutRowid,
    bool Strict,
    bool TransactionalDdl,
    bool Autoincrement,
    bool Schemas);

public sealed record DesignerTypesInfo(IReadOnlyList<DesignerType> Types, DesignerFeatures Features);

// ------------------------------------------------------------------ scripts

public static class DdlKinds
{
    public const string Create = "create", Alter = "alter", Drop = "drop", Rename = "rename", Rebuild = "rebuild",
        Comment = "comment", Index = "index", Pragma = "pragma";
}

public sealed record DdlStatement(string Sql, string Kind, string? Warning = null);

/// <summary>An ordered DDL script. Never contains BEGIN/COMMIT: the apply step manages the transaction.</summary>
public sealed record DdlScript(IReadOnlyList<DdlStatement> Statements, bool RebuildRequired, bool Transactional, IReadOnlyList<string> Warnings);

public sealed record TableScript(IReadOnlyList<DdlStatement> Statements, bool RebuildRequired, bool Transactional,
    IReadOnlyList<string> Warnings, IReadOnlyList<TableChange> Changes);

/// <summary>
/// Context of a scripting call: server version (feature detection), the connection's default schema and, for
/// SQLite table rebuilds, the dependent objects that must be dropped and recreated around the rebuild.
/// </summary>
public sealed record DdlScriptContext(string? ServerVersion = null, string? DefaultSchema = null, IReadOnlyList<DependentObject>? Dependents = null)
{
    public static readonly DdlScriptContext Default = new();
}

/// <param name="Type">SQLite: "trigger" | "view" | "index". SQL Server identity rebuilds (see <see cref="DependentTypes"/>):
/// "trigger" (<paramref name="Sql"/> = stored definition, empty when unreadable), "foreignKey" (an inbound FK of another
/// table), "permission", "notCarried" (something the rebuild cannot recreate: listed in the warnings) and "blocker"
/// (refuses the rebuild, <paramref name="Detail"/> says why), plus the storage features of
/// <see cref="DependentTypes.UnsupportedStorage"/> (columnstore/XML/spatial/full-text indexes, partitioning, filegroup,
/// compression, change tracking, CDC), which also refuse it.</param>
/// <param name="OnTable">True for a trigger/index defined on the table itself (dropped with it); false for an object of
/// another table/view whose SQL references the table.</param>
/// <param name="OwnerSchema">Inbound foreign key: schema of the referencing table.</param>
/// <param name="OwnerTable">Inbound foreign key: the referencing table.</param>
/// <param name="ForeignKey">Inbound foreign key: its columns (of the referencing table), the referenced columns of this table and actions.</param>
/// <param name="Disabled">Trigger or foreign key is disabled (recreated disabled).</param>
/// <param name="Detail">Permission: state ("GRANT" | "GRANT_WITH_GRANT_OPTION" | "DENY"); foreign key: "untrusted"; trigger:
/// "ordered" (sp_settriggerorder); notCarried/blocker: the message.</param>
/// <param name="Column">Column-level permission: the column (current name).</param>
public sealed record DependentObject(string Type, string Name, string Sql, bool OnTable,
    string? OwnerSchema = null, string? OwnerTable = null, ForeignKeyModel? ForeignKey = null, bool Disabled = false,
    string? Detail = null, string? Column = null);

/// <summary>Values of <see cref="DependentObject.Type"/>.</summary>
public static class DependentTypes
{
    public const string Trigger = "trigger", View = "view", Index = "index", ForeignKey = "foreignKey", Permission = "permission",
        NotCarried = "notCarried", Blocker = "blocker";

    /// <summary>
    /// SQL Server storage features of the table that the table model does not hold, so an identity rebuild (DROP TABLE +
    /// CREATE) would silently lose them (features-r1-02); each one refuses the rebuild. <see cref="DependentObject.Name"/> is
    /// the index (or the table for table-level features), <see cref="DependentObject.Detail"/> the index type, data space
    /// or compression. "otherIndex" covers any other index type the designer does not model (e.g. nonclustered hash).
    /// </summary>
    public const string ColumnstoreIndex = "columnstoreIndex", XmlIndex = "xmlIndex", SpatialIndex = "spatialIndex", OtherIndex = "otherIndex",
        FulltextIndex = "fulltextIndex", Partitioning = "partitioning", Filegroup = "filegroup", Compression = "compression",
        ChangeTracking = "changeTracking", Cdc = "cdc";

    /// <summary>The kinds above.</summary>
    public static readonly IReadOnlySet<string> UnsupportedStorage = new HashSet<string>(StringComparer.Ordinal)
    {
        ColumnstoreIndex, XmlIndex, SpatialIndex, OtherIndex, FulltextIndex, Partitioning, Filegroup, Compression, ChangeTracking, Cdc,
    };
}

// ------------------------------------------------------------------ apply

public sealed record DdlApplyRequest(string? Database, IReadOnlyList<string> Statements, bool Transactional, string? Schema = null);

public sealed record DdlApplyResult(bool Ok, int Executed, long ElapsedMs);
