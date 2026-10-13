using DbStudio.Core.Models;
using DbStudio.Providers.SqlServer.TSql;

namespace DbStudio.Providers.SqlServer.Tests;

public sealed class DdlGeneratorTests
{
    private static SqlServerTableDefinition Orders() => new(
        "dbo", "Orders",
        [
            new SqlServerColumnDefinition("Id", "int", false, IsIdentity: true, IdentitySeed: 100, IdentityIncrement: 5),
            new SqlServerColumnDefinition("CustomerId", "int", false),
            new SqlServerColumnDefinition("OrderDate", "datetime2(7)", false, DefaultDefinition: "(sysutcdatetime())", DefaultName: "DF_Orders_Date"),
            new SqlServerColumnDefinition("Note", "nvarchar(max)", true, Collation: "Latin1_General_CI_AS"),
            new SqlServerColumnDefinition("Total", "decimal(12,2)", false),
            new SqlServerColumnDefinition("Tax", "decimal(14,4)", true, ComputedDefinition: "([Total]*(0.19))", IsPersisted: true),
        ],
        [
            new SqlServerIndexDefinition("PK_Orders", true, true, false, "CLUSTERED", [new SqlServerIndexColumn("Id")], []),
            new SqlServerIndexDefinition("UQ_Orders_Note", true, false, true, "NONCLUSTERED", [new SqlServerIndexColumn("CustomerId"), new SqlServerIndexColumn("OrderDate", true)], []),
            new SqlServerIndexDefinition("IX_Orders_Customer", false, false, false, "NONCLUSTERED", [new SqlServerIndexColumn("CustomerId")], ["Total"], "([Total]>(0))"),
            new SqlServerIndexDefinition("CCI_Orders", false, false, false, "NONCLUSTERED COLUMNSTORE", [new SqlServerIndexColumn("Total")], []),
        ],
        [new SqlServerForeignKeyDefinition("FK_Orders_Customers", ["CustomerId"], "dbo", "Customers", ["Id"], "CASCADE", "NO_ACTION")],
        [new SqlServerCheckDefinition("CK_Orders_Total", "([Total]>=(0))")]);

    [Fact]
    public void Generate_FullDefinition()
    {
        var ddl = TSqlDdlGenerator.Generate(Orders());
        Assert.StartsWith("CREATE TABLE [dbo].[Orders] (\n", ddl);
        Assert.Contains("    [Id] int IDENTITY(100,5) NOT NULL,\n", ddl);
        Assert.Contains("[OrderDate] datetime2(7) NOT NULL CONSTRAINT [DF_Orders_Date] DEFAULT (sysutcdatetime())", ddl);
        Assert.Contains("[Note] nvarchar(max) COLLATE Latin1_General_CI_AS NULL", ddl);
        Assert.Contains("[Tax] AS ([Total]*(0.19)) PERSISTED", ddl);
        Assert.Contains("CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id] ASC)", ddl);
        Assert.Contains("CONSTRAINT [UQ_Orders_Note] UNIQUE NONCLUSTERED ([CustomerId] ASC, [OrderDate] DESC)", ddl);
        Assert.Contains("CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id]) ON DELETE CASCADE", ddl);
        Assert.Contains("CONSTRAINT [CK_Orders_Total] CHECK ([Total]>=(0))", ddl);
        Assert.Contains("CREATE NONCLUSTERED INDEX [IX_Orders_Customer] ON [dbo].[Orders] ([CustomerId] ASC) INCLUDE ([Total]) WHERE ([Total]>(0));", ddl);
        Assert.Contains("CREATE NONCLUSTERED COLUMNSTORE INDEX [CCI_Orders] ON [dbo].[Orders] ([Total]);", ddl);
        Assert.DoesNotContain("ON UPDATE", ddl);
    }

    [Fact]
    public void GeneratedDdl_IsValidTsql() => Assert.Empty(ScriptDomDiagnostics.Analyze(TSqlDdlGenerator.Generate(Orders())));

    [Fact]
    public void GenerateTableDdl_FromObjectDetails()
    {
        var details = new ObjectDetails(
            new ObjectRef("shop", "dbo", "Customers", ObjectTypes.Table),
            [
                new ColumnDetail("Id", "int", false, null, true, true, false, null, 1),
                new ColumnDetail("Name", "nvarchar(100)", false, "(N'')", false, false, false, "Display name", 2),
                new ColumnDetail("Upper", "nvarchar(100)", true, "(upper([Name]))", false, false, true, null, 3),
            ],
            [new IndexDetail("PK_Customers", true, ["Id"], "CLUSTERED", true), new IndexDetail("IX_Name", false, ["Name"], "NONCLUSTERED")],
            [new ForeignKeyRef("FK_C_Countries", ["Id"], "dbo", "Countries", ["Id"])],
            [], [], [], null, null, null);
        var ddl = new SqlServerProvider().DdlGenerator.GenerateTableDdl(details.Ref, details);
        Assert.Contains("[Id] int IDENTITY(1,1) NOT NULL", ddl);
        Assert.Contains("[Name] nvarchar(100) NOT NULL DEFAULT (N'')", ddl);
        Assert.Contains("[Upper] AS (upper([Name]))", ddl);
        Assert.Contains("CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([Id] ASC)", ddl);
        Assert.Contains("CREATE NONCLUSTERED INDEX [IX_Name] ON [dbo].[Customers] ([Name] ASC);", ddl);
        Assert.Empty(ScriptDomDiagnostics.Analyze(ddl));
    }

    [Fact]
    public void PrimaryKeyFromColumns_WhenNoIndexListed()
    {
        var details = new ObjectDetails(new ObjectRef(null, "s", "T", ObjectTypes.Table),
            [new ColumnDetail("A", "int", false, null, true, false, false, null, 1), new ColumnDetail("B", "int", false, null, true, false, false, null, 2)],
            [], [], [], [], [], null, null, null);
        var ddl = new TSqlDdlGenerator().GenerateTableDdl(details.Ref, details);
        Assert.Contains("CONSTRAINT [PK_T] PRIMARY KEY CLUSTERED ([A] ASC, [B] ASC)", ddl);
        Assert.Empty(ScriptDomDiagnostics.Analyze(ddl));
    }

    [Fact]
    public void Names_AreBracketQuoted() =>
        Assert.Contains("CREATE TABLE [my schema].[odd]]name]", TSqlDdlGenerator.Generate(new SqlServerTableDefinition("my schema", "odd]name",
            [new SqlServerColumnDefinition("c", "int", true)], [], [], [])));
}

public sealed class SeedScriptTests
{
    [Fact]
    public void SeedScript_IsValidTsql_AndSplitsIntoBatches()
    {
        var script = File.ReadAllText(SqlServerBackend.SeedScriptPath);
        Assert.Empty(ScriptDomDiagnostics.Analyze(script));
        var batches = BatchSplitter.Split(script).Where(b => !string.IsNullOrWhiteSpace(b.Text)).ToList();
        Assert.True(batches.Count >= 10, $"Only {batches.Count} batches.");
        Assert.StartsWith("USE shop", batches[1].Text.Trim());
        foreach (var name in new[] { "dbo.GetCustomerReport", "dbo.fnTax", "dbo.OrdersOf", "dbo.Cust", "dbo.CustomerOrders", "Sales.Invoices", "dbo.IdList", "dbo.OrderNumbers" })
            Assert.Contains(name, script);
    }
}
