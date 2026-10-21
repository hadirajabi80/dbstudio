using System.Data;
using DbStudio.Core.Models;
using static DbStudio.Providers.SqlServer.SqlServerCatalogReader;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>Name-based mapping and grouping of <see cref="SqlServerCatalogQueries.ForeignKeys"/> rows (no server needed).</summary>
public sealed class ForeignKeyMappingTests
{
    private const int Dbo = 1, Sales = 5;

    /// <summary>A result shaped like the FK query, with its columns deliberately in a different order.</summary>
    private static DataTable Table(params object?[][] rows)
    {
        var t = new DataTable();
        foreach (var (name, type) in new (string, Type)[]
                 {
                     ("ref_column", typeof(string)), ("is_not_trusted", typeof(bool)), ("fk_name", typeof(string)), ("ordinal", typeof(int)),
                     ("fk_id", typeof(int)), ("parent_id", typeof(int)), ("parent_schema_id", typeof(int)), ("parent_schema", typeof(string)),
                     ("parent_table", typeof(string)), ("parent_column", typeof(string)), ("ref_schema_id", typeof(int)), ("ref_schema", typeof(string)),
                     ("ref_table", typeof(string)), ("is_disabled", typeof(bool)),
                 })
            t.Columns.Add(name, type);
        foreach (var r in rows) t.Rows.Add(r.Select(v => v ?? DBNull.Value).ToArray());
        return t;
    }

    // ref_column, nt, fk_name, ordinal, fk_id, parent_id, parent_schema_id, parent_schema, parent_table, parent_column, ref_schema_id, ref_schema, ref_table, dis
    private static object?[] Row(int fkId, string name, int ordinal, int parentId, int? parentSchemaId, string? parentSchema, string? parentTable, string? parentColumn,
        int? refSchemaId, string? refSchema, string? refTable, string? refColumn, bool disabled = false, bool notTrusted = false) =>
        [refColumn, notTrusted, name, ordinal, fkId, parentId, parentSchemaId, parentSchema, parentTable, parentColumn, refSchemaId, refSchema, refTable, disabled];

    private static List<ForeignKeyRow> Read(DataTable t)
    {
        using var r = t.CreateDataReader();
        ForeignKeyOrdinals? o = null;
        var list = new List<ForeignKeyRow>();
        while (r.Read()) list.Add(ReadForeignKeyRow(r, o ??= new ForeignKeyOrdinals(r)));
        return list;
    }

    [Fact]
    public void Rows_AreMappedByColumnName()
    {
        var rows = Read(Table(Row(10, "FK_Orders_Customers", 1, 100, Dbo, "dbo", "Orders", "CustomerId", Dbo, "dbo", "Customers", "Id", disabled: true, notTrusted: true)));
        var r = Assert.Single(rows);
        Assert.Equal(new ForeignKeyRow(10, "FK_Orders_Customers", 100, Dbo, "dbo", "Orders", "CustomerId", Dbo, "dbo", "Customers", "Id", 1, true, true), r);
    }

    [Fact]
    public void CompositeKey_KeepsColumnOrder_AndFlags()
    {
        var rows = Read(Table(
            Row(20, "FK_Invoices_Orders", 2, 200, Sales, "Sales", "Invoices", "OrderRev", Dbo, "dbo", "Orders", "Rev"),
            Row(20, "FK_Invoices_Orders", 1, 200, Sales, "Sales", "Invoices", "OrderId", Dbo, "dbo", "Orders", "Id")));
        var set = GroupForeignKeys(rows, Sales);
        var fk = Assert.Single(Assert.Single(set.ByParent).Value);
        Assert.Equal(new[] { "OrderId", "OrderRev" }, fk.Columns);
        Assert.Equal(new[] { "Id", "Rev" }, fk.RefColumns);
        Assert.Equal(("dbo", "Orders"), (fk.RefSchema, fk.RefTable));
        Assert.False(fk.IsDisabled);
        Assert.Empty(set.ReferencingSchemas);
        Assert.Equal(0, set.Hidden);
    }

    [Fact]
    public void IncomingKeys_ReportTheirSchema_OutgoingAreKept()
    {
        var rows = Read(Table(
            Row(1, "FK_Customers_Countries", 1, 101, Dbo, "dbo", "Customers", "CountryCode", Dbo, "dbo", "Countries", "Code", disabled: true, notTrusted: true),
            Row(2, "FK_Invoices_Orders", 1, 200, Sales, "Sales", "Invoices", "OrderId", Dbo, "dbo", "Orders", "Id"),
            Row(3, "FK_Staff_Countries", 1, 300, 6, "hr", "Staff", "CountryId", Dbo, "dbo", "Countries", "Id"),
            Row(4, "FK_Invoices_Customers", 1, 200, Sales, "Sales", "Invoices", "CustName", Dbo, "dbo", "Customers", "Name")));
        var set = GroupForeignKeys(rows, Dbo);
        var fk = Assert.Single(set.ByParent[101]);
        Assert.Equal("FK_Customers_Countries", fk.Name);
        Assert.True(fk.IsDisabled);
        Assert.True(fk.IsNotTrusted);
        Assert.Single(set.ByParent);
        Assert.Equal(new[] { "Sales", "hr" }, set.ReferencingSchemas);
    }

    [Fact]
    public void KeysToInvisibleTables_AreCounted_NotTurnedIntoEmptyEdges()
    {
        // Without VIEW DEFINITION / SELECT on the referenced table, sys.objects hides it: the joined names are NULL.
        var rows = Read(Table(
            Row(1, "FK_Customers_Countries", 1, 101, Dbo, "dbo", "Customers", "CountryCode", null, null, null, null),
            Row(2, "FK_Orders_Rev", 1, 102, Dbo, "dbo", "Orders", "Id", Dbo, "dbo", "OrderHeads", "Id"),
            Row(2, "FK_Orders_Rev", 2, 102, Dbo, "dbo", "Orders", "Rev", Dbo, "dbo", "OrderHeads", null),
            Row(3, "FK_Ok", 1, 103, Dbo, "dbo", "Lines", "OrderId", Dbo, "dbo", "Orders", "Id")));
        var set = GroupForeignKeys(rows, Dbo);
        Assert.Equal(2, set.Hidden);
        var ok = Assert.Single(Assert.Single(set.ByParent).Value);
        Assert.Equal("FK_Ok", ok.Name);
        Assert.DoesNotContain(set.ByParent.Values.SelectMany(x => x), f => f.RefTable == "");
    }

    [Fact]
    public void SelfReference_AndSameSchemaKeys_AreOutgoing()
    {
        var rows = Read(Table(Row(1, "FK_Emp_Manager", 1, 7, Dbo, "dbo", "Employees", "ManagerId", Dbo, "dbo", "Employees", "Id")));
        var set = GroupForeignKeys(rows, Dbo);
        var fk = Assert.Single(set.ByParent[7]);
        Assert.Equal(("dbo", "Employees", "ManagerId", "Id"), (fk.RefSchema, fk.RefTable, Assert.Single(fk.Columns), Assert.Single(fk.RefColumns)));
        Assert.Empty(set.ReferencingSchemas);
    }
}
