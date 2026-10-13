using System.Text.RegularExpressions;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Oracle.Tests;

public sealed partial class OracleCatalogQueryTests
{
    public static TheoryData<string> QueryNames => new(OracleCatalogQueries.All.Keys);

    [GeneratedRegex(@"\ball_(?<view>\w+)\b", RegexOptions.IgnoreCase)]
    private static partial Regex AllView();

    /// <summary>
    /// Every query over an ALL_ dictionary view (ALL_USERS excepted: it has no owner) is owner-bound: an
    /// "owner = :bind" (or index_owner/table_owner/sequence_owner/r_owner), a fixed 'PUBLIC' owner plus a name bind, or an
    /// owner correlated to an outer owner-bound row.
    /// </summary>
    [Theory]
    [MemberData(nameof(QueryNames))]
    public void EveryAllViewQuery_HasOwnerBind(string name)
    {
        var sql = OracleCatalogQueries.All[name];
        var views = AllView().Matches(sql).Select(m => m.Groups["view"].Value.ToLowerInvariant()).Where(v => v != "users").ToList();
        if (views.Count == 0) return;
        Assert.Matches(new Regex(@"\b(?:\w+\.)?(?:owner|index_owner|table_owner|sequence_owner|r_owner)\s*=\s*(?::\w+|'PUBLIC'\s+AND\s+\w+\.\w+\s*=\s*:\w+)", RegexOptions.IgnoreCase), sql);
        // Each ALL_ view occurrence is followed (within its own query block) by an owner predicate.
        var occurrences = AllView().Matches(sql).Where(m => !m.Value.Equals("all_users", StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var m in occurrences)
        {
            var tail = sql[m.Index..];
            Assert.Matches(new Regex(@"\b(?:\w+\.)?(?:owner|index_owner|table_owner|sequence_owner|r_owner)\s*=\s*(?::\w+|'PUBLIC'|\w+\.\w+)", RegexOptions.IgnoreCase), tail);
        }
    }

    [Fact]
    public void ConstraintAndColumnViews_AreNeverQueriedWithoutOwner()
    {
        foreach (var (name, sql) in OracleCatalogQueries.All)
        {
            foreach (var view in new[] { "all_cons_columns", "all_tab_columns", "all_tab_cols", "all_arguments" })
            {
                if (!sql.Contains(view, StringComparison.OrdinalIgnoreCase)) continue;
                Assert.True(Regex.IsMatch(sql, @"\bowner\s*=\s*:owner\b", RegexOptions.IgnoreCase), $"{name} reads {view} without :owner");
            }
        }
    }

    [Fact]
    public void ArgumentsQuery_IsRestrictedToTopLevel() => Assert.Contains("data_level=0", OracleCatalogQueries.Arguments);

    [Fact]
    public void ReferencedColumns_BuildsNumberedInList()
    {
        var sql = OracleCatalogQueries.ReferencedColumns(3);
        Assert.Contains("IN (:c0,:c1,:c2)", sql);
        Assert.Contains("cc.owner=:owner", sql);
    }

    [Fact]
    public void SchemasFallback_ExcludesMaintainedAccounts()
    {
        var sql = OracleCatalogQueries.SchemasFallback;
        foreach (var s in new[] { "'SYS'", "'SYSTEM'", "'XDB'", "'OUTLN'", "'DBSNMP'", "'APPQOSSYS'" }) Assert.Contains(s, sql);
    }

    [Fact]
    public void ObjectsQuery_ExcludesRecycleBinAndMviewContainerTables()
    {
        Assert.Contains("NOT LIKE 'BIN$%'", OracleCatalogQueries.Objects);
        Assert.Contains("all_mviews WHERE owner=:owner", OracleCatalogQueries.Objects);
    }

    [Theory]
    [InlineData("TABLE", ObjectTypes.Table)]
    [InlineData("VIEW", ObjectTypes.View)]
    [InlineData("MATERIALIZED VIEW", ObjectTypes.MView)]
    [InlineData("PROCEDURE", ObjectTypes.Proc)]
    [InlineData("FUNCTION", ObjectTypes.Func)]
    [InlineData("PACKAGE", ObjectTypes.Package)]
    [InlineData("SEQUENCE", ObjectTypes.Sequence)]
    [InlineData("SYNONYM", ObjectTypes.Synonym)]
    [InlineData("TYPE", ObjectTypes.Type)]
    [InlineData("TRIGGER", ObjectTypes.Trigger)]
    [InlineData("PACKAGE BODY", null)]
    [InlineData(null, null)]
    public void ObjectType_Maps(string? oracle, string? expected) => Assert.Equal(expected, OracleTypeText.ObjectType(oracle));

    [Theory]
    [InlineData(ObjectTypes.Table, "TABLE")]
    [InlineData(ObjectTypes.MView, "MATERIALIZED_VIEW")]
    [InlineData(ObjectTypes.Package, "PACKAGE")]
    [InlineData(ObjectTypes.Func, "FUNCTION")]
    public void MetadataType_Maps(string type, string expected) => Assert.Equal(expected, OracleTypeText.MetadataType(type));

    [Fact]
    public void SourceTypes_IncludeBodies()
    {
        Assert.Equal(new[] { "PACKAGE", "PACKAGE BODY" }, OracleTypeText.SourceTypes(ObjectTypes.Package));
        Assert.Equal(new[] { "TYPE", "TYPE BODY" }, OracleTypeText.SourceTypes(ObjectTypes.Type));
        Assert.Empty(OracleTypeText.SourceTypes(ObjectTypes.Table));
    }

    [Theory]
    [InlineData("VARCHAR2", null, 100, 100, "B", null, null, "VARCHAR2(100)")]
    [InlineData("VARCHAR2", null, 400, 100, "C", null, null, "VARCHAR2(100 CHAR)")]
    [InlineData("NVARCHAR2", null, 200, 100, "C", null, null, "NVARCHAR2(100)")]
    [InlineData("CHAR", null, 1, 1, "B", null, null, "CHAR(1)")]
    [InlineData("NUMBER", null, 22, 0, null, null, null, "NUMBER")]
    [InlineData("NUMBER", null, 22, 0, null, null, 0, "INTEGER")]
    [InlineData("NUMBER", null, 22, 0, null, 10, 0, "NUMBER(10)")]
    [InlineData("NUMBER", null, 22, 0, null, 12, 2, "NUMBER(12,2)")]
    [InlineData("NUMBER", null, 22, 0, null, null, 2, "NUMBER(*,2)")]
    [InlineData("FLOAT", null, 22, 0, null, 126, null, "FLOAT")]
    [InlineData("FLOAT", null, 22, 0, null, 63, null, "FLOAT(63)")]
    [InlineData("RAW", null, 16, 0, null, null, null, "RAW(16)")]
    [InlineData("DATE", null, 7, 0, null, null, null, "DATE")]
    [InlineData("TIMESTAMP(6)", null, 11, 0, null, null, 6, "TIMESTAMP(6)")]
    [InlineData("ADDRESS_T", "SHOP", 1, 0, null, null, null, "ADDRESS_T")]
    [InlineData("ADDRESS_T", "HR", 1, 0, null, null, null, "HR.ADDRESS_T")]
    [InlineData("XMLTYPE", "SYS", 2000, 0, null, null, null, "XMLTYPE")]
    public void ColumnTypeText(string type, string? owner, int len, int charLen, string? charUsed, int? precision, int? scale, string expected) =>
        Assert.Equal(expected, OracleTypeText.Column(type, owner, len, charLen, charUsed, precision, scale, "SHOP"));

    [Theory]
    [InlineData("NUMBER", null, null, null, "NUMBER", "NUMBER")]
    [InlineData("VARCHAR2", null, null, null, "VARCHAR2", "VARCHAR2")]
    [InlineData("PL/SQL RECORD", "SHOP", "ORDER_API", "ORDER_REC", null, "SHOP.ORDER_API.ORDER_REC")]
    [InlineData("REF CURSOR", "SYS", "SYS_REFCURSOR", null, null, "SYS.SYS_REFCURSOR")]
    [InlineData("PL/SQL BOOLEAN", null, null, null, "BOOLEAN", "BOOLEAN")]
    [InlineData("TABLE", "PUBLIC", "ID_LIST", null, null, "ID_LIST")]
    public void ArgumentTypeText(string? dataType, string? owner, string? typeName, string? sub, string? pls, string expected) =>
        Assert.Equal(expected, OracleTypeText.Argument(dataType, owner, typeName, sub, pls));

    [Theory]
    [InlineData("IN", "in")]
    [InlineData("OUT", "out")]
    [InlineData("IN/OUT", "inout")]
    [InlineData(null, "in")]
    public void Direction(string? inOut, string expected) => Assert.Equal(expected, OracleTypeText.Direction(inOut));

    [Fact]
    public void SynonymTarget_WithDbLink()
    {
        Assert.Equal(new SynonymTarget("REMOTE.WORLD", "HR", "EMP", null), OracleCatalogReader.SynonymTargetOf("HR", "EMP", "REMOTE.WORLD", null));
        Assert.Equal(new SynonymTarget(null, "SHOP", "CUSTOMERS", ObjectTypes.Table), OracleCatalogReader.SynonymTargetOf("SHOP", "CUSTOMERS", null, "TABLE"));
    }
}
