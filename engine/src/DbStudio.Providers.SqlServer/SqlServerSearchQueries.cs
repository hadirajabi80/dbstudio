using DbStudio.Core.Models;
using DbStudio.Core.Search;

namespace DbStudio.Providers.SqlServer;

/// <summary>
/// Catalog queries of "Find in database" (sys.objects, sys.columns, sys.sql_modules): plain joins that run on SQL Server
/// 2005 and later (no STRING_AGG, no CONCAT). <c>@schema</c> is the schema name; with a prefilter <c>@p</c> is the LIKE
/// pattern (<see cref="SearchSql.LikePattern"/>), compared upper case unless the search is case-sensitive.
/// </summary>
public static class SqlServerSearchQueries
{
    private const string Base =
        "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.is_ms_shipped = 0 ";

    private static string Filter(string expr, bool prefilter, bool matchCase) =>
        prefilter ? " AND " + SearchSql.LikePredicate(Dialect.TSql, expr, "@p", matchCase) : "";

    public static string Names(bool prefilter, bool matchCase) =>
        "SELECT s.name, o.name, o.type " + Base + "AND o.type IN (" + SqlServerCatalogQueries.ObjectTypeList + ")" + Filter("o.name", prefilter, matchCase);

    public static string Columns(bool prefilter, bool matchCase) =>
        "SELECT s.name, o.name, o.type, c.name, TYPE_NAME(c.user_type_id), c.max_length, c.precision, c.scale, " +
        "CASE WHEN t.is_user_defined = 1 THEN 1 ELSE 0 END " +
        "FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id " +
        "JOIN sys.types t ON t.user_type_id = c.user_type_id " +
        "WHERE s.name = @schema AND o.is_ms_shipped = 0 AND o.type IN ('U','V')" + Filter("c.name", prefilter, matchCase);

    /// <summary>Views, procedures, functions and triggers (encrypted modules have no definition).</summary>
    public static string Code(bool prefilter, bool matchCase) =>
        "SELECT s.name, o.name, o.type, m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id " +
        "JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @schema AND o.is_ms_shipped = 0 AND m.definition IS NOT NULL " +
        "AND o.type IN ('V','P','FN','IF','TF','TR')" + Filter("m.definition", prefilter, matchCase);

    /// <summary>Every variant (with/without prefilter, case-sensitive or not), for the grammar tests.</summary>
    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        ["Names"] = Names(false, false), ["NamesLike"] = Names(true, false), ["NamesLikeCase"] = Names(true, true),
        ["Columns"] = Columns(false, false), ["ColumnsLike"] = Columns(true, false), ["ColumnsLikeCase"] = Columns(true, true),
        ["Code"] = Code(false, false), ["CodeLike"] = Code(true, false), ["CodeLikeCase"] = Code(true, true),
    };
}
