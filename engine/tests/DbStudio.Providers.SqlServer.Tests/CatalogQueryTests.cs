using DbStudio.Core.Models;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Providers.SqlServer.Tests;

public sealed class CatalogQueryTests
{
    public static TheoryData<string> QueryNames => new(SqlServerCatalogQueries.All.Keys);

    [Theory]
    [MemberData(nameof(QueryNames))]
    public void CatalogQuery_ParsesCleanly_WithScriptDom(string name)
    {
        var sql = SqlServerCatalogQueries.All[name];
        var parser = ScriptDomDiagnostics.CreateParser();
        var fragment = parser.Parse(new StringReader(sql), out var errors);
        Assert.True(errors.Count == 0, $"{name}: {string.Join("; ", errors.Select(e => $"{e.Line}:{e.Column} {e.Message}"))}");
        var script = Assert.IsType<TSqlScript>(fragment);
        Assert.Single(script.Batches);
        Assert.Single(script.Batches[0].Statements);
    }

    [Fact]
    public void SchemaScopedQueries_BindSchemaId()
    {
        foreach (var name in new[] { "Objects", "Columns", "KeyConstraints", "ForeignKeys", "Parameters", "Synonyms", "UserTypes", "TableTypeColumns" })
            Assert.Contains("@sid", SqlServerCatalogQueries.All[name]);
    }

    [Fact]
    public void ForeignKeyQuery_CoversBothDirections()
    {
        var sql = SqlServerCatalogQueries.ForeignKeys;
        Assert.Contains("fk.schema_id=@sid OR fk.referenced_object_id IN", sql);
    }

    [Fact]
    public void SchemaFilter_HidesSystemAndRoleSchemas()
    {
        Assert.Contains("'sys','INFORMATION_SCHEMA','guest'", SqlServerCatalogQueries.SchemaFilter);
        Assert.Contains("type='R'", SqlServerCatalogQueries.SchemaFilter);
    }

    [Fact]
    public void UseStatement_ForAwkwardDatabaseName_Parses()
    {
        var sql = "USE " + SqlServerNames.Quote("odd]name db");
        Assert.Equal("USE [odd]]name db]", sql);
        Assert.Empty(ScriptDomDiagnostics.Analyze(sql));
    }

    [Theory]
    [InlineData("U", ObjectTypes.Table)]
    [InlineData("V", ObjectTypes.View)]
    [InlineData("P", ObjectTypes.Proc)]
    [InlineData("PC", ObjectTypes.Proc)]
    [InlineData("FN", ObjectTypes.Func)]
    [InlineData("FS", ObjectTypes.Func)]
    [InlineData("IF", ObjectTypes.TableFunc)]
    [InlineData("TF", ObjectTypes.TableFunc)]
    [InlineData("FT", ObjectTypes.TableFunc)]
    [InlineData("SN", ObjectTypes.Synonym)]
    [InlineData("SO", ObjectTypes.Sequence)]
    [InlineData("TR", ObjectTypes.Trigger)]
    [InlineData("TT", ObjectTypes.Type)]
    [InlineData("D", null)]
    public void MapType_CoversCatalogTypes(string code, string? expected) =>
        Assert.Equal(expected, SqlServerCatalogReader.MapType(code));

    [Theory]
    [InlineData("[dbo].[Customers]", null, "dbo", "Customers")]
    [InlineData("Customers", null, null, "Customers")]
    [InlineData("[OtherDb].[Sales].[Invoices]", "OtherDb", "Sales", "Invoices")]
    [InlineData("[srv].[db].[dbo].[T]", "db", "dbo", "T")]
    [InlineData("db..T", "db", null, "T")]
    [InlineData("[we]]ird].[x.y]", null, "we]ird", "x.y")]
    public void SynonymTarget_IsParsed(string baseName, string? db, string? schema, string name)
    {
        var t = SqlServerCatalogReader.ParseSynonymTarget(baseName, "U");
        Assert.Equal(new SynonymTarget(db, schema, name, ObjectTypes.Table), t);
    }

    [Theory]
    [InlineData("nvarchar", 100, 0, 0, "nvarchar(50)")]
    [InlineData("nvarchar", -1, 0, 0, "nvarchar(max)")]
    [InlineData("varchar", -1, 0, 0, "varchar(max)")]
    [InlineData("varbinary", 16, 0, 0, "varbinary(16)")]
    [InlineData("nchar", 20, 0, 0, "nchar(10)")]
    [InlineData("decimal", 9, 18, 2, "decimal(18,2)")]
    [InlineData("numeric", 9, 10, 0, "numeric(10,0)")]
    [InlineData("datetime2", 8, 27, 7, "datetime2(7)")]
    [InlineData("time", 5, 16, 3, "time(3)")]
    [InlineData("float", 8, 53, 0, "float")]
    [InlineData("float", 4, 24, 0, "float(24)")]
    [InlineData("int", 4, 10, 0, "int")]
    [InlineData("uniqueidentifier", 16, 0, 0, "uniqueidentifier")]
    public void TypeText_IsRendered(string type, int maxLength, int precision, int scale, string expected) =>
        Assert.Equal(expected, SqlServerNames.TypeText(type, maxLength, precision, scale));

    [Fact]
    public void TypeText_UserDefinedType_IsKeptAsIs() =>
        Assert.Equal("[dbo].[Phone]", SqlServerNames.TypeText("[dbo].[Phone]", 20, 0, 0, isUserDefined: true));
}
