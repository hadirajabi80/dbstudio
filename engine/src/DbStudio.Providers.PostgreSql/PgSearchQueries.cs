using DbStudio.Core.Models;
using DbStudio.Core.Search;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// Catalog queries of "Find in database" (pg_class, pg_proc, pg_trigger, pg_type, pg_attribute; view bodies through
/// pg_get_viewdef, routine bodies from prosrc). PostgreSQL 12+, like the catalog reader. <c>$1</c> = schema name, <c>$2</c>
/// = the LIKE pattern when prefiltering (ILIKE unless the search is case-sensitive).
/// </summary>
public static class PgSearchQueries
{
    private static string Filter(string expr, bool prefilter, bool matchCase) =>
        prefilter ? " AND " + SearchSql.LikePredicate(Dialect.PgSql, expr, "$2", matchCase) : "";

    private const string RelationType =
        "CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'mview' WHEN 'S' THEN 'sequence' ELSE 'table' END";

    private const string RoutineType =
        "CASE WHEN p.prokind = 'p' THEN 'proc' WHEN p.proretset THEN 'tablefunc' ELSE 'func' END";

    public static string Names(bool prefilter, bool matchCase) =>
        "SELECT n.nspname::text, c.relname::text, " + RelationType + " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition" + Filter("c.relname::text", prefilter, matchCase) +
        " UNION ALL " +
        "SELECT n.nspname::text, p.proname::text, " + RoutineType + " FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "WHERE n.nspname = $1 AND p.prokind IN ('f','p','a','w')" + Filter("p.proname::text", prefilter, matchCase) +
        " UNION ALL " +
        "SELECT n.nspname::text, t.tgname::text, 'trigger' FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal" + Filter("t.tgname::text", prefilter, matchCase) +
        " UNION ALL " +
        "SELECT n.nspname::text, t.typname::text, 'type' FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace " +
        "LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE n.nspname = $1 AND t.typtype IN ('e','d','c','r') AND t.typcategory <> 'A' " +
        "AND (t.typtype <> 'c' OR c.relkind = 'c')" + Filter("t.typname::text", prefilter, matchCase);

    public static string Columns(bool prefilter, bool matchCase) =>
        "SELECT n.nspname::text, c.relname::text, " + RelationType + ", a.attname::text, format_type(a.atttypid, a.atttypmod) " +
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped" +
        Filter("a.attname::text", prefilter, matchCase);

    /// <summary>Routine bodies (not C/internal ones: their prosrc is a symbol name) and view / materialized view definitions.</summary>
    public static string Code(bool prefilter, bool matchCase) =>
        "SELECT n.nspname::text, p.proname::text, " + RoutineType + ", p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace " +
        "JOIN pg_language l ON l.oid = p.prolang WHERE n.nspname = $1 AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal') " +
        "AND p.prosrc IS NOT NULL" + Filter("p.prosrc", prefilter, matchCase) +
        " UNION ALL " +
        "SELECT n.nspname::text, c.relname::text, " + RelationType + ", pg_get_viewdef(c.oid, true) FROM pg_class c " +
        "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('v','m')" +
        Filter("pg_get_viewdef(c.oid, true)", prefilter, matchCase);

    public static IReadOnlyDictionary<string, string> All { get; } = new Dictionary<string, string>
    {
        ["Names"] = Names(false, false), ["NamesLike"] = Names(true, false), ["NamesLikeCase"] = Names(true, true),
        ["Columns"] = Columns(false, false), ["ColumnsLike"] = Columns(true, false), ["ColumnsLikeCase"] = Columns(true, true),
        ["Code"] = Code(false, false), ["CodeLike"] = Code(true, false), ["CodeLikeCase"] = Code(true, true),
    };
}
