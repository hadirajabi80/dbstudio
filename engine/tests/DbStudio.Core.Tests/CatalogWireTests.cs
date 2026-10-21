using System.Text;
using System.Text.Json;
using DbStudio.Core.Catalog;
using DbStudio.Core.Models;

namespace DbStudio.Core.Tests;

public class CatalogWireTests
{
    private static SchemaCatalog Sample() => new("Shop", "dbo",
    [
        new CatalogObject
        {
            Type = ObjectTypes.Table, Name = "Customers", Schema = "dbo", Comment = "People who buy",
            Columns = [new("Id", "int", false, true, 1), new("Name", "nvarchar(100)", true, false, 0, "Display name")],
            PrimaryKey = ["Id"],
        },
        new CatalogObject
        {
            Type = ObjectTypes.Table, Name = "Orders", Schema = "dbo",
            Columns = [new("Id", "int", false, true), new("CustomerId", "int", false, false)],
            PrimaryKey = ["Id"],
            ForeignKeys = [new("FK_Orders_Customers", ["CustomerId"], "dbo", "Customers", ["Id"])],
        },
        new CatalogObject
        {
            Type = ObjectTypes.Proc, Name = "GetCustomer", Schema = "dbo",
            Parameters = [new("@Id", "int", "in", false), new("", "int", "return", true)],
        },
        new CatalogObject
        {
            Type = ObjectTypes.Synonym, Name = "Cust", Schema = "dbo",
            Target = new SynonymTarget(null, "dbo", "Customers", ObjectTypes.Table),
        },
        new CatalogObject
        {
            Type = ObjectTypes.Package, Name = "ORDER_API", Status = "VALID",
            Members = [new("GET_TOTAL", "func", 1, [new("P_ID", "NUMBER", "in", false), new("", "NUMBER", "return", false)])],
        },
    ]);

    [Fact]
    public void Schema_UsesCompactFormat()
    {
        var json = Encoding.UTF8.GetString(CatalogWire.SerializeSchema(Sample(), 7));
        Assert.Equal(
            """{"name":"dbo","version":7,"objects":[""" +
            """{"t":"table","n":"Customers","cm":"People who buy","c":[["Id","int",0,1,1,null],["Name","nvarchar(100)",1,0,0,"Display name"]],"pk":["Id"]},""" +
            """{"t":"table","n":"Orders","c":[["Id","int",0,1,0,null],["CustomerId","int",0,0,0,null]],"pk":["Id"],"fk":[{"n":"FK_Orders_Customers","cols":["CustomerId"],"rs":"dbo","rt":"Customers","rcols":["Id"]}]},""" +
            """{"t":"proc","n":"GetCustomer","p":[["@Id","int","in",0],["","int","return",1]]},""" +
            """{"t":"synonym","n":"Cust","target":{"s":"dbo","n":"Customers","t":"table"}},""" +
            """{"t":"package","n":"ORDER_API","members":[{"n":"GET_TOTAL","k":"func","ov":1,"p":[["P_ID","NUMBER","in",0],["","NUMBER","return",0]]}],"st":"VALID"}""" +
            "]}",
            json);
    }

    [Fact]
    public void Snapshot_ComposesPreSerializedSchemas()
    {
        var schema = CatalogWire.SerializeSchema(Sample(), 3);
        var empty = CatalogWire.SerializeSchema(new SchemaCatalog("Shop", "Sales", []), 3);
        var bytes = CatalogWire.ComposeSnapshot("c_1", Dialect.TSql, "Shop", "dbo", 3, ["master", "Shop"], [schema, empty]);
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;
        Assert.Equal("c_1", root.GetProperty("connectionId").GetString());
        Assert.Equal("tsql", root.GetProperty("dialect").GetString());
        Assert.Equal("Shop", root.GetProperty("database").GetString());
        Assert.Equal("dbo", root.GetProperty("defaultSchema").GetString());
        Assert.Equal(3, root.GetProperty("version").GetInt32());
        Assert.Equal(["master", "Shop"], root.GetProperty("databases").EnumerateArray().Select(e => e.GetString()!));
        var schemas = root.GetProperty("schemas").EnumerateArray().ToList();
        Assert.Equal(2, schemas.Count);
        Assert.Equal(5, schemas[0].GetProperty("objects").GetArrayLength());
        Assert.Equal("Sales", schemas[1].GetProperty("name").GetString());
        Assert.Equal(0, schemas[1].GetProperty("objects").GetArrayLength());
    }

    [Fact]
    public void Snapshot_NullDatabase_AndDialectTokens()
    {
        var bytes = CatalogWire.ComposeSnapshot("c_2", Dialect.PlSql, null, "SHOP", 1, [], []);
        using var doc = JsonDocument.Parse(bytes);
        Assert.Equal(JsonValueKind.Null, doc.RootElement.GetProperty("database").ValueKind);
        Assert.Equal("plsql", doc.RootElement.GetProperty("dialect").GetString());
    }

    [Fact]
    public void ForeignKeyFlags_AndSchemaDiagnostics_AreWrittenOnlyWhenSet()
    {
        var schema = new SchemaCatalog("Shop", "dbo",
        [
            new CatalogObject
            {
                Type = ObjectTypes.Table, Name = "Orders",
                ForeignKeys =
                [
                    new("FK_A", ["CustomerId"], "dbo", "Customers", ["Id"], IsDisabled: true, IsNotTrusted: true),
                    new("FK_B", ["ProductId"], "dbo", "Products", ["Id"], IsNotTrusted: true),
                    new("FK_C", ["ShopId"], "dbo", "Shops", ["Id"]),
                ],
            },
        ]) { ReferencingSchemas = ["Sales", "hr"], HiddenForeignKeys = 2 };
        var json = Encoding.UTF8.GetString(CatalogWire.SerializeSchema(schema, 1));
        Assert.Contains("""{"n":"FK_A","cols":["CustomerId"],"rs":"dbo","rt":"Customers","rcols":["Id"],"dis":true,"nt":true}""", json);
        Assert.Contains("""{"n":"FK_B","cols":["ProductId"],"rs":"dbo","rt":"Products","rcols":["Id"],"nt":true}""", json);
        Assert.Contains("""{"n":"FK_C","cols":["ShopId"],"rs":"dbo","rt":"Shops","rcols":["Id"]}""", json);
        Assert.EndsWith("""],"refBy":["Sales","hr"],"fkHidden":2}""", json);

        var plain = Encoding.UTF8.GetString(CatalogWire.SerializeSchema(new SchemaCatalog(null, "main", []), 1));
        Assert.Equal("""{"name":"main","version":1,"objects":[]}""", plain);
    }

    [Fact]
    public void NonAsciiNames_AreNotEscaped()
    {
        var schema = new SchemaCatalog(null, "main", [new CatalogObject { Type = ObjectTypes.Table, Name = "Bestellungen_ÄÖÜ" }]);
        Assert.Contains("Bestellungen_ÄÖÜ", Encoding.UTF8.GetString(CatalogWire.SerializeSchema(schema, 1)));
    }
}
