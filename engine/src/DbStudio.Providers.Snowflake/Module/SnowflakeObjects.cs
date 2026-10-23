using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake.Module;

/// <summary>A warehouse (SHOW WAREHOUSES).</summary>
public sealed record SnowflakeWarehouse(string Name, string State, string? Type, string? Size, int? MinClusters, int? MaxClusters,
    int? Running, int? Queued, int? AutoSuspendSeconds, bool AutoResume, bool IsCurrent, bool IsDefault, string? Owner, string? Comment,
    string? ScalingPolicy, string? CreatedOn);

/// <summary>A role the user may use (CURRENT_AVAILABLE_ROLES, details from SHOW ROLES).</summary>
public sealed record SnowflakeRole(string Name, bool IsCurrent, bool IsDefault, string? Owner, string? Comment);

/// <summary>A schema-level object outside the relational catalog: stage, stream, task, pipe, file format, dynamic table, alert.</summary>
public sealed record SnowflakeObject(string Kind, string Name, string? Database, string? Schema, string? Owner, string? Comment, string? CreatedOn,
    string? State, IReadOnlyDictionary<string, string> Details);

public sealed record SnowflakeObjectsResponse(string Database, string Schema, string Kind, IReadOnlyList<SnowflakeObject> Items, string? Note);

public sealed record SnowflakeDdlResponse(string Kind, string Name, string Ddl, string Source);

public sealed record SnowflakeActionResult(bool Ok, string? Message);

/// <summary>Body of <c>POST /snowflake/sessions/{sid}/use</c>.</summary>
public sealed record SnowflakeUseRequest(string? Kind, string? Name);

/// <summary>
/// Module reads and actions over the gateway (fixtures-tested): warehouses (+ resume / suspend), roles, the schema objects
/// the relational catalog has no type for (stages, streams, tasks, pipes, file formats, dynamic tables, alerts) with their
/// DDL, and task resume / suspend / execute. Every SHOW runs in the cloud services layer (no warehouse, no credits).
/// </summary>
public static class SnowflakeObjects
{
    /// <summary>kind token → (SHOW command, GET_DDL type or null when GET_DDL does not support it).</summary>
    public static readonly IReadOnlyDictionary<string, (string Show, string? DdlType)> Kinds = new Dictionary<string, (string, string?)>(StringComparer.OrdinalIgnoreCase)
    {
        ["stages"] = ("STAGES", null),
        ["streams"] = ("STREAMS", "STREAM"),
        ["tasks"] = ("TASKS", "TASK"),
        ["pipes"] = ("PIPES", "PIPE"),
        ["fileformats"] = ("FILE FORMATS", "FILE_FORMAT"),
        ["dynamictables"] = ("DYNAMIC TABLES", "DYNAMIC_TABLE"),
        ["alerts"] = ("ALERTS", "ALERT"),
    };

    public static string KindOf(string? kind)
    {
        var k = (kind ?? "").Trim().ToLowerInvariant().Replace("_", "", StringComparison.Ordinal).Replace(" ", "", StringComparison.Ordinal);
        if (!Kinds.ContainsKey(k)) throw EngineException.Validation($"kind must be one of {string.Join(", ", Kinds.Keys)}.", new { field = "kind" });
        return k;
    }

    // ------------------------------------------------------------------ warehouses

    public const string ShowWarehouses = "SHOW WAREHOUSES";

    public static async Task<IReadOnlyList<SnowflakeWarehouse>> WarehousesAsync(ISnowflakeGateway g, CancellationToken ct) =>
        ParseWarehouses(await g.QueryAsync(ShowWarehouses, ct).ConfigureAwait(false));

    public static List<SnowflakeWarehouse> ParseWarehouses(SqlRowSet rs) => rs.Rows.Select(r => new SnowflakeWarehouse(
        rs.Str(r, "name") ?? "",
        rs.Str(r, "state") ?? "UNKNOWN",
        rs.Str(r, "type"),
        rs.Str(r, "size"),
        (int?)rs.Long(r, "min_cluster_count"),
        (int?)rs.Long(r, "max_cluster_count"),
        (int?)rs.Long(r, "running"),
        (int?)rs.Long(r, "queued"),
        (int?)rs.Long(r, "auto_suspend"),
        SnowflakeCatalogReader.Flag(rs, r, "auto_resume"),
        SnowflakeCatalogReader.Flag(rs, r, "is_current"),
        SnowflakeCatalogReader.Flag(rs, r, "is_default"),
        SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "owner")),
        SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "comment")),
        SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "scaling_policy")),
        rs.Str(r, "created_on"))).Where(w => w.Name.Length > 0).ToList();

    /// <summary><c>ALTER WAREHOUSE "X" RESUME IF SUSPENDED</c> / <c>SUSPEND</c>.</summary>
    public static string WarehouseActionSql(string name, string action) => action.Trim().ToLowerInvariant() switch
    {
        "resume" => $"ALTER WAREHOUSE {SnowflakeSql.AlwaysQuote(name)} RESUME IF SUSPENDED",
        "suspend" => $"ALTER WAREHOUSE {SnowflakeSql.AlwaysQuote(name)} SUSPEND",
        _ => throw EngineException.Validation("action must be resume or suspend.", new { field = "action" }),
    };

    // ------------------------------------------------------------------ roles

    public const string AvailableRoles = "SELECT CURRENT_AVAILABLE_ROLES() AS ROLES, CURRENT_ROLE() AS ROLE_NAME";
    public const string ShowRoles = "SHOW ROLES";

    public static async Task<IReadOnlyList<SnowflakeRole>> RolesAsync(ISnowflakeGateway g, CancellationToken ct)
    {
        var available = await g.QueryAsync(AvailableRoles, ct).ConfigureAwait(false);
        SqlRowSet show;
        try { show = await g.QueryAsync(ShowRoles, ct).ConfigureAwait(false); }
        catch (SnowflakeQueryException) { show = new SqlRowSet([], []); }
        return ParseRoles(available, show);
    }

    public static List<SnowflakeRole> ParseRoles(SqlRowSet available, SqlRowSet show)
    {
        var row = available.Rows.FirstOrDefault();
        var current = row is null ? null : available.Str(row, "ROLE_NAME");
        var names = new List<string>();
        if (row is not null && available.Str(row, "ROLES") is { } json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                    names.AddRange(doc.RootElement.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0));
            }
            catch (JsonException) { /* not JSON */ }
        }
        var details = show.Rows.ToDictionary(r => show.Str(r, "name") ?? "", r => r, StringComparer.Ordinal);
        if (names.Count == 0) names.AddRange(details.Keys.Where(k => k.Length > 0));
        return names.Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal).Select(n =>
        {
            details.TryGetValue(n, out var d);
            return new SnowflakeRole(n, n == current, d is not null && SnowflakeCatalogReader.Flag(show, d, "is_default"),
                d is null ? null : SnowflakeCatalogReader.NullIfEmpty(show.Str(d, "owner")), d is null ? null : SnowflakeCatalogReader.NullIfEmpty(show.Str(d, "comment")));
        }).ToList();
    }

    // ------------------------------------------------------------------ schema objects

    public static string ShowObjectsSql(string kind, string database, string schema) =>
        $"SHOW {Kinds[kind].Show} IN SCHEMA {SnowflakeSql.SchemaPath(database, schema)}";

    public static async Task<SnowflakeObjectsResponse> ObjectsAsync(ISnowflakeGateway g, string database, string schema, string kind, CancellationToken ct)
    {
        var k = KindOf(kind);
        try
        {
            var rs = await g.QueryAsync(ShowObjectsSql(k, database, schema), ct).ConfigureAwait(false);
            return new SnowflakeObjectsResponse(database, schema, k, ParseObjects(k, rs), null);
        }
        catch (SnowflakeQueryException ex) when (ex.IsPrivilege || ex.IsNotFoundOrDenied || ex.ErrorCode is 1003)
        {
            return new SnowflakeObjectsResponse(database, schema, k, [], ex.Message);
        }
    }

    /// <summary>Columns shown as details per kind (the rest of the SHOW row stays out of the list).</summary>
    private static readonly IReadOnlyDictionary<string, string[]> DetailColumns = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["stages"] = ["url", "type", "cloud", "region", "storage_integration", "has_credentials", "has_encryption_key", "directory_enabled"],
        ["streams"] = ["table_name", "source_type", "base_tables", "type", "mode", "stale", "stale_after"],
        ["tasks"] = ["warehouse", "schedule", "predecessors", "condition", "definition", "allow_overlapping_execution", "last_suspended_on", "error_integration"],
        ["pipes"] = ["definition", "notification_channel", "integration", "pattern", "invalid_reason", "kind"],
        ["fileformats"] = ["type", "format_options"],
        ["dynamictables"] = ["target_lag", "warehouse", "refresh_mode", "scheduling_state", "rows", "bytes", "data_timestamp", "text"],
        ["alerts"] = ["warehouse", "schedule", "condition", "action"],
    };

    public static List<SnowflakeObject> ParseObjects(string kind, SqlRowSet rs)
    {
        var detailColumns = DetailColumns.GetValueOrDefault(kind, []);
        return rs.Rows.Select(r =>
        {
            var details = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var c in detailColumns)
                if (SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, c)) is { } v) details[c] = v;
            var state = rs.Str(r, "state") ?? rs.Str(r, "scheduling_state") ?? (kind == "streams" && SnowflakeCatalogReader.Flag(rs, r, "stale") ? "stale" : null);
            return new SnowflakeObject(kind, rs.Str(r, "name") ?? "", rs.Str(r, "database_name"), rs.Str(r, "schema_name"),
                SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "owner")), SnowflakeCatalogReader.NullIfEmpty(rs.Str(r, "comment")), rs.Str(r, "created_on"),
                SnowflakeCatalogReader.NullIfEmpty(state), details);
        }).Where(o => o.Name.Length > 0).ToList();
    }

    /// <summary>GET_DDL for streams, tasks, pipes, file formats, dynamic tables and alerts; DESCRIBE STAGE as text for stages.</summary>
    public static async Task<SnowflakeDdlResponse> DdlAsync(ISnowflakeGateway g, string database, string schema, string kind, string name, CancellationToken ct)
    {
        var k = KindOf(kind);
        if (Kinds[k].DdlType is { } type)
        {
            var rs = await g.QueryAsync(SnowflakeSql.GetDdl(type, database, schema, name), ct).ConfigureAwait(false);
            var ddl = rs.Rows.Count == 0 ? "" : SqlCells.Str(rs.Rows[0][0]) ?? "";
            return new SnowflakeDdlResponse(k, name, ddl.TrimEnd() + "\n", "stored");
        }
        var d = await g.QueryAsync($"DESCRIBE STAGE {SnowflakeSql.ObjectPath(database, schema, name)}", ct).ConfigureAwait(false);
        return new SnowflakeDdlResponse(k, name, DescribeStageText(database, schema, name, d), "generated");
    }

    /// <summary>DESCRIBE STAGE rows (parent_property, property, property_type, property_value, property_default) as commented SQL.</summary>
    public static string DescribeStageText(string database, string schema, string name, SqlRowSet d)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("-- DESCRIBE STAGE ").Append(SnowflakeSql.Qualify(database, schema, name)).Append('\n');
        foreach (var g in d.Rows.GroupBy(r => d.Str(r, "parent_property") ?? ""))
        {
            sb.Append("-- ").Append(g.Key).Append('\n');
            foreach (var r in g)
            {
                var value = d.Str(r, "property_value") ?? "";
                var def = d.Str(r, "property_default") ?? "";
                if (value == def && value.Length > 0) continue;
                sb.Append("--   ").Append(d.Str(r, "property")).Append(" = ").Append(value).Append('\n');
            }
        }
        return sb.ToString();
    }

    /// <summary><c>ALTER TASK … RESUME | SUSPEND</c>, <c>EXECUTE TASK …</c>; refresh / suspend / resume of a dynamic table; pipe refresh.</summary>
    public static string ObjectActionSql(string kind, string database, string schema, string name, string action)
    {
        var k = KindOf(kind);
        var path = SnowflakeSql.ObjectPath(database, schema, name);
        var a = action.Trim().ToLowerInvariant();
        return (k, a) switch
        {
            ("tasks", "resume") => $"ALTER TASK {path} RESUME",
            ("tasks", "suspend") => $"ALTER TASK {path} SUSPEND",
            ("tasks", "execute") => $"EXECUTE TASK {path}",
            ("dynamictables", "refresh") => $"ALTER DYNAMIC TABLE {path} REFRESH",
            ("dynamictables", "suspend") => $"ALTER DYNAMIC TABLE {path} SUSPEND",
            ("dynamictables", "resume") => $"ALTER DYNAMIC TABLE {path} RESUME",
            ("pipes", "refresh") => $"ALTER PIPE {path} REFRESH",
            ("alerts", "resume") => $"ALTER ALERT {path} RESUME",
            ("alerts", "suspend") => $"ALTER ALERT {path} SUSPEND",
            _ => throw EngineException.Validation($"'{action}' is not an action of {k}.", new { field = "action" }),
        };
    }

    public static async Task<SnowflakeActionResult> RunAsync(ISnowflakeGateway g, string sql, CancellationToken ct)
    {
        try
        {
            var rs = await g.QueryAsync(sql, ct).ConfigureAwait(false);
            var text = rs.Rows.Count > 0 && rs.Rows[0].Length > 0 ? SqlCells.Str(rs.Rows[0][0]) : null;
            return new SnowflakeActionResult(true, text);
        }
        catch (SnowflakeQueryException ex)
        {
            throw new EngineException(ex.IsPrivilege ? 403 : 400, ex.IsPrivilege ? ErrorCodes.Privilege : SnowflakeErrors.Code(ex.ErrorCode), ex.Message);
        }
    }
}
