using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Params;

public sealed record DescribeTable(string? Schema, string Name);

/// <summary>Response of POST /sessions/{sid}/describe (docs/PLAN-M1.5.md 3.8).</summary>
public sealed record DescribeResult(
    IReadOnlyList<ColumnInfo> Columns,
    bool Editable,
    DescribeTable? Table,
    IReadOnlyList<string> KeyColumns,
    IReadOnlyList<string> Warnings);

/// <summary>
/// Describes the result columns of a query on the tab session without executing it (<c>CommandBehavior.SchemaOnly</c>):
/// view designer column preview, codegen, editability of result sets. Only single SELECT statements are accepted.
/// </summary>
public sealed class DescribeService(SessionManager sessions, CatalogService catalog)
{
    public async Task<DescribeResult> DescribeAsync(string sessionId, string? sql, IReadOnlyList<QueryParam>? parameters, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sql)) throw EngineException.Validation("sql is required.", new { field = "sql" });
        var h = sessions.Get(sessionId);
        var classification = StatementClassifier.Classify(sql, h.Dialect);
        if (classification.Statements.Count != 1 || !classification.IsQueryOnly || classification.Statements[0].Category != StatementCategory.Query)
            throw EngineException.Validation("describe accepts a single SELECT statement.", new { field = "sql" });
        ParamValues.Validate(parameters);
        if (h.Session is not AdoSessionBase session)
            throw new EngineException(400, ErrorCodes.NotSupported, "Describe is not supported for this session.");

        await sessions.EnsureUsableAsync(h, ct).ConfigureAwait(false);
        session = (AdoSessionBase)h.Session;
        if (!h.TryReserve(Ids.New("d")))
            throw new EngineException(409, ErrorCodes.SessionBusy, "The session is already executing a statement.");
        ColumnInfo[] columns;
        try
        {
            columns = await session.DescribeAsync(sql, parameters, ct).ConfigureAwait(false);
        }
        finally
        {
            h.Release();
        }

        var warnings = new List<string>();
        if (columns.Length == 0) warnings.Add("The statement returns no result set.");
        var tables = columns.Where(c => c.Table is not null).Select(c => (Schema: c.Schema, Table: c.Table!)).Distinct().ToList();
        var computedColumns = columns.Count(c => c.Table is null);
        DescribeTable? table = tables.Count == 1 ? new DescribeTable(tables[0].Schema, tables[0].Table) : null;
        var keys = table is null ? [] : columns.Where(c => c.IsKey && c.Table == table.Name).Select(c => c.Name).ToList();

        var editable = table is not null && keys.Count > 0 && !h.Profile.ReadOnly;
        if (table is not null && editable)
        {
            // All primary key columns of the base table must be present.
            try
            {
                var details = await catalog.GetObjectDetailsAsync(h.Profile.Id,
                    new ObjectRef(h.Dialect == Dialect.TSql ? h.Session.CurrentDatabase : null, table.Schema, table.Name, ObjectTypes.Table), ct).ConfigureAwait(false);
                var pk = details.Columns.Where(c => c.IsPk).Select(c => c.Name).ToList();
                if (pk.Count > 0)
                {
                    keys = pk.Where(p => columns.Any(c => c.Name.Equals(p, StringComparison.OrdinalIgnoreCase))).ToList();
                    if (keys.Count != pk.Count)
                    {
                        editable = false;
                        warnings.Add($"Not editable: the primary key column(s) {string.Join(", ", pk.Except(keys, StringComparer.OrdinalIgnoreCase))} are missing.");
                    }
                }
            }
            catch (Exception ex) when (ex is EngineException or System.Data.Common.DbException or InvalidOperationException)
            {
                warnings.Add("The primary key could not be verified from the catalog.");
            }
        }
        else if (tables.Count > 1)
        {
            warnings.Add("Not editable: the result combines several tables.");
        }
        else if (table is not null && keys.Count == 0)
        {
            warnings.Add("Not editable: no key column of the table is in the result.");
        }
        if (h.Profile.ReadOnly) warnings.Add("Not editable: the connection is read-only.");
        if (editable && computedColumns > 0) warnings.Add("Computed columns are read-only.");
        return new DescribeResult(columns, editable, table, keys, warnings);
    }
}
