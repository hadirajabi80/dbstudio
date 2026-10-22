using DbStudio.Core.Models;
using DbStudio.Core.Search;

namespace DbStudio.Providers.Oracle;

/// <summary>
/// Dictionary queries of "Find in database" (ALL_OBJECTS, ALL_TAB_COLUMNS, ALL_SOURCE line by line, ALL_VIEWS / ALL_MVIEWS
/// whose LONG text cannot be compared in SQL and is matched in the engine). OWNER-bound like the catalog reader; works
/// on 11g. <c>:owner</c> = schema, <c>:p</c> = the LIKE pattern when prefiltering (compared upper case unless the search
/// is case-sensitive).
/// </summary>
public static class OracleSearchQueries
{
    private static string Filter(string expr, bool prefilter, bool matchCase) =>
        prefilter ? " AND " + SearchSql.LikePredicate(Dialect.PlSql, expr, ":p", matchCase) : "";

    public static string Names(bool prefilter, bool matchCase) =>
        "SELECT owner, object_name, object_type FROM all_objects WHERE owner = :owner AND object_type IN (" + OracleCatalogQueries.ObjectTypeList + ") " +
        "AND object_name NOT LIKE 'BIN$%' AND generated = 'N' " +
        "AND (object_type <> 'TABLE' OR object_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner = :owner))" +
        Filter("object_name", prefilter, matchCase);

    public static string Columns(bool prefilter, bool matchCase) =>
        "SELECT c.owner, c.table_name, o.object_type, c.column_name, c.data_type, c.char_length, c.data_precision, c.data_scale " +
        "FROM all_tab_columns c JOIN all_objects o ON o.owner = c.owner AND o.object_name = c.table_name " +
        "AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') " +
        "WHERE c.owner = :owner AND c.table_name NOT LIKE 'BIN$%' " +
        "AND (o.object_type <> 'TABLE' OR c.table_name NOT IN (SELECT mview_name FROM all_mviews WHERE owner = :owner))" +
        Filter("c.column_name", prefilter, matchCase);

    /// <summary>Matching source lines of procedures, functions, packages (spec and body), triggers and types.</summary>
    public static string Source(bool prefilter, bool matchCase) =>
        "SELECT owner, name, type, line, text FROM all_source WHERE owner = :owner " +
        "AND type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY')" + Filter("text", prefilter, matchCase) +
        " ORDER BY name, type, line";

    public const string Views = "SELECT owner, view_name, text FROM all_views WHERE owner = :owner";

    public const string MViews = "SELECT owner, mview_name, query FROM all_mviews WHERE owner = :owner";

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        ["Names"] = Names(false, false), ["NamesLike"] = Names(true, false), ["NamesLikeCase"] = Names(true, true),
        ["Columns"] = Columns(false, false), ["ColumnsLike"] = Columns(true, false), ["ColumnsLikeCase"] = Columns(true, true),
        ["Source"] = Source(false, false), ["SourceLike"] = Source(true, false), ["SourceLikeCase"] = Source(true, true),
        ["Views"] = Views, ["MViews"] = MViews,
    };
}
