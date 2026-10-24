using System.Globalization;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Params;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.MySql.Designer;
using DbStudio.Providers.MySql.Plans;

namespace DbStudio.Providers.MySql.Tests.M15;

/// <summary>Golden DDL of the shared designer cases (DesignerCases with MySQL types) plus MySQL-specific cases.</summary>
public sealed class MySqlScripterGoldenTests
{
    private static readonly MySqlDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("8.4.3", "shop");

    private static TableColumnModel Col(string name, string type, bool nullable = true, string? def = null) =>
        new() { Id = name, Name = name, Type = type, Nullable = nullable, Default = def };

    public static IReadOnlyList<DesignerCases.Case> All()
    {
        var shared = DesignerCases.All(Dialect.MySql).ToList();
        var orders = DesignerCases.Orders(Dialect.MySql);
        shared.Add(new("autoincrement_create", null, new TableModel
        {
            Schema = "shop", Name = "invoices",
            Columns = [Col("id", "bigint unsigned", false) with { Autoincrement = true }, Col("amount", "decimal(12,2)", false), Col("created", "timestamp", true, "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")],
            PrimaryKey = new PrimaryKeyModel { Columns = ["id"] },
        }));
        shared.Add(new("generated_columns", orders, orders with
        {
            Columns = [.. orders.Columns, Col("TotalWithTax", "decimal(12,2)") with { Id = "new_3", Computed = new ComputedModel("Total * 1.19", Persisted: true) },
                Col("NoteLength", "int") with { Id = "new_4", Computed = new ComputedModel("CHAR_LENGTH(Note)") }],
        }));
        shared.Add(new("prefix_index", orders, orders with
        {
            Indexes = [.. orders.Indexes, new IndexModel { Name = "IX_Orders_Note", Columns = [new IndexColumnModel("Note(20)")] }],
        }));
        shared.Add(new("reorder_columns", orders, orders with { Columns = [orders.Columns[0], orders.Columns[5], .. orders.Columns.Skip(1).Take(4)] }));
        shared.Add(new("expression_default", null, new TableModel
        {
            Schema = "shop", Name = "events",
            Columns = [Col("id", "char(36)", false, "uuid()"), Col("payload", "json", true, "'{}'"), Col("flags", "bit(4)", false, "b'0000'")],
            PrimaryKey = new PrimaryKeyModel { Columns = ["id"] },
        }));
        return shared;
    }

    public static TheoryData<string> CaseNames => new(All().Select(c => c.Name));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Script_MatchesGolden_AndSplitsIntoOneStatementEach(string name)
    {
        var c = All().Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, Context);
        Assert.False(script.Transactional);
        Assert.False(script.RebuildRequired);
        foreach (var s in script.Statements) Assert.Single(MySqlSqlText.Split(s.Sql));
        Golden.Match($"mysql_{name}.sql", Golden.Render(script));
    }

    [Fact]
    public void Alter_RenameUsesChange_ModifyKeepsName_AddGoesAfterPrevious()
    {
        var orders = DesignerCases.Orders(Dialect.MySql);
        var desired = orders with
        {
            Columns = [.. orders.Columns.Select(c => c.Name == "Note" ? c with { Name = "Remarks", Type = "varchar(400)" } : c.Name == "Total" ? c with { Comment = "Gross" } : c),
                Col("Extra", "int") with { Id = "n1" }],
        };
        var script = Scripter.ScriptTable(orders, desired, Context);
        var alter = Assert.Single(script.Statements);
        Assert.Equal("ALTER TABLE `shop`.`Orders`\n" +
                     "    MODIFY COLUMN `Total` decimal(12,2) NOT NULL DEFAULT 0 COMMENT 'Gross',\n" +
                     "    CHANGE COLUMN `Note` `Remarks` varchar(400) NULL,\n" +
                     "    ADD COLUMN `Extra` int NULL AFTER `Remarks`", alter.Sql);
    }

    [Fact]
    public void ForeignKeys_DropFirst_AddLast_RestrictEqualsNoAction()
    {
        var orders = DesignerCases.Orders(Dialect.MySql);
        Assert.Empty(Scripter.ScriptTable(orders, orders with { ForeignKeys = [orders.ForeignKeys[0] with { OnDelete = "RESTRICT" }] }, Context).Statements);
        var changed = Scripter.ScriptTable(orders, orders with { ForeignKeys = [orders.ForeignKeys[0] with { OnDelete = ReferentialActions.Cascade }] }, Context);
        Assert.Equal(2, changed.Statements.Count);
        Assert.Contains("DROP FOREIGN KEY `FK_Orders_Customers`", changed.Statements[0].Sql);
        Assert.Contains("ADD CONSTRAINT `FK_Orders_Customers` FOREIGN KEY (`CustomerId`) REFERENCES `shop`.`Customers` (`Id`) ON DELETE CASCADE", changed.Statements[1].Sql);
    }

    [Fact]
    public void Checks_DropConstraint_OnMariaDbAndNewMySql_DropCheckOnOld()
    {
        var orders = DesignerCases.Orders(Dialect.MySql);
        var noCheck = orders with { Checks = [] };
        Assert.Contains("DROP CONSTRAINT `CK_Orders_Total`", Scripter.ScriptTable(orders, noCheck, new DdlScriptContext("11.4.2-MariaDB", "shop")).Statements[0].Sql);
        Assert.Contains("DROP CHECK `CK_Orders_Total`", Scripter.ScriptTable(orders, noCheck, new DdlScriptContext("8.0.17", "shop")).Statements[0].Sql);
    }

    [Fact]
    public void Defaults_LiteralsAsTyped_ExpressionsParenthesized()
    {
        Assert.Equal("0", MySqlDdlScripter.DefaultSql("0"));
        Assert.Equal("'new'", MySqlDdlScripter.DefaultSql("'new'"));
        Assert.Equal("CURRENT_TIMESTAMP(6)", MySqlDdlScripter.DefaultSql("CURRENT_TIMESTAMP(6)"));
        Assert.Equal("(uuid())", MySqlDdlScripter.DefaultSql("uuid()"));
        Assert.Equal("NULL ON UPDATE CURRENT_TIMESTAMP", MySqlDdlScripter.DefaultSql("NULL ON UPDATE CURRENT_TIMESTAMP"));
        Assert.Equal("b'1010'", MySqlDdlScripter.DefaultSql("b'1010'"));
    }

    [Fact]
    public void Validation_OneAutoIncrement_GeneratedNeedsType()
    {
        var orders = DesignerCases.Orders(Dialect.MySql);
        Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(null, orders with
        {
            Columns = orders.Columns.Select(c => c.Name is "Id" or "CustomerId" ? c with { Autoincrement = true } : c).ToList(),
        }, Context));
        Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(null, orders with
        {
            Columns = [.. orders.Columns, new TableColumnModel { Name = "g", Type = "", Computed = new ComputedModel("1") }],
        }, Context));
    }

    [Fact]
    public void Views_CreateReplaceRename()
    {
        var view = new ViewDefinition("shop", "order_totals", null, "SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id;", new ViewOptions(CheckOption: true));
        var s = Scripter.ScriptView(view, Context);
        Assert.Equal("CREATE VIEW `shop`.`order_totals` AS\nSELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id\nWITH CASCADED CHECK OPTION",
            Assert.Single(s.Statements).Sql);
        Golden.Match("mysql_view_create.sql", Golden.Render(s));
        var renamed = Scripter.ScriptView(view with { OriginalName = "totals" }, Context);
        Assert.Equal("RENAME TABLE `shop`.`totals` TO `shop`.`order_totals`", renamed.Statements[0].Sql);
        Assert.StartsWith("CREATE OR REPLACE VIEW `shop`.`order_totals` AS", renamed.Statements[1].Sql);
        Golden.Match("mysql_view_rename.sql", Golden.Render(renamed));
    }

    [Fact]
    public void Types_AndFeatures()
    {
        var types = Scripter.GetTypes(Context);
        Assert.False(types.Features.TransactionalDdl);
        Assert.True(types.Features.Autoincrement && types.Features.Computed && types.Features.Comments && types.Features.RenameColumn);
        Assert.False(types.Features.Identity || types.Features.IncludedColumns || types.Features.FilteredIndexes);
        Assert.Contains(types.Types, t => t.Name == "json");
    }

    [Fact]
    public void Reader_Helpers_CanonicalTypesAndChecks()
    {
        Assert.Equal("int", MySqlDesignerDatabase.CanonicalType("int(11)"));
        Assert.Equal("bigint unsigned", MySqlDesignerDatabase.CanonicalType("bigint(20) unsigned"));
        Assert.Equal("tinyint(1)", MySqlDesignerDatabase.CanonicalType("tinyint(1)"));
        Assert.Equal("int(5) unsigned zerofill", MySqlDesignerDatabase.CanonicalType("int(5) unsigned zerofill"));
        Assert.Equal("amount >= 0", MySqlDesignerDatabase.CheckExpression("(`amount` >= 0)"));
        Assert.Equal("`odd name` > 1", MySqlDesignerDatabase.CheckExpression("`odd name` > 1"));
    }
}

/// <summary>EXPLAIN FORMAT=JSON / ANALYZE FORMAT=JSON / EXPLAIN ANALYZE fixtures and the explain scripts.</summary>
public sealed class MySqlPlanReaderTests
{
    private static string Load(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Plans", "fixtures", name));

    [Fact]
    public void MySqlJson_NestedLoopTablesCostsAndWarnings()
    {
        var plan = MySqlPlanReader.ParseJson(Load("mysql-estimated.json"));
        var root = plan.Root;
        Assert.StartsWith("Query block", root.Op);
        Assert.NotNull(root.Cost);
        var tables = root.DescendantsAndSelf().Where(n => n.Object is not null).ToList();
        Assert.Contains(tables, t => t.Object!.StartsWith("c", StringComparison.Ordinal));
        Assert.Contains(tables, t => t.Object!.StartsWith("o", StringComparison.Ordinal));
        Assert.InRange(root.DescendantsAndSelf().Sum(n => n.CostPct ?? 0), 99.0, 101.0);
        Assert.Equal("text", plan.RawFormat);
    }

    [Fact]
    public void MariaDbAnalyzeJson_ActualRows()
    {
        var plan = MySqlPlanReader.ParseJson(Load("mariadb-analyze.json"));
        var tables = plan.Root.DescendantsAndSelf().Where(n => n.Object is not null).ToList();
        Assert.NotEmpty(tables);
        Assert.All(tables, t => Assert.NotNull(t.ActualRows));
    }

    [Fact]
    public void MySqlTree_ExplainAnalyze()
    {
        var plan = MySqlPlanReader.ParseTree(Load("mysql-analyze.txt"));
        Assert.NotEmpty(plan.Root.DescendantsAndSelf().Skip(1));
        Assert.All(plan.Root.DescendantsAndSelf().Where(n => n.Props?.ContainsKey("Loops") == true), n => Assert.NotNull(n.ActualRows));
        Assert.Contains(plan.Root.DescendantsAndSelf(), n => n.Cost is not null);
        Assert.Contains(plan.Root.DescendantsAndSelf(), n => n.Object is not null);
    }

    [Fact]
    public void Tree_ParsesOperatorsObjectsAndRows()
    {
        const string text = """
            -> Nested loop inner join  (cost=1.10 rows=2) (actual time=0.0444..0.0512 rows=2 loops=1)
                -> Rows fetched before execution  (cost=0..0 rows=1) (actual time=125e-6..166e-6 rows=1 loops=1)
                -> Index lookup on o using fk_orders_customers (customer_id=1)  (cost=0.7 rows=2) (actual time=0.0291..0.0329 rows=2 loops=1)
            """;
        var plan = MySqlPlanReader.ParseTree(text);
        Assert.Equal("Nested loop inner join", plan.Root.Op);
        Assert.Equal(1.10, plan.Root.Cost);
        Assert.Equal(2, plan.Root.Children.Count);
        var lookup = plan.Root.Children[1];
        Assert.Equal("o (fk_orders_customers)", lookup.Object);
        Assert.Equal("customer_id=1", lookup.Predicate);
        Assert.Equal(2, lookup.ActualRows);
        Assert.Equal(2, lookup.EstRows);
    }

    [Fact]
    public void Script_EstimatedNullBinds_ActualPerFlavor()
    {
        var mysql = new MySqlPlanReader();
        var est = mysql.CreateScript(new ExplainInput("x", "SELECT * FROM t WHERE id = :id AND x = @uservar;", ExplainModes.Estimated, Line: 5, ServerVersion: "8.4.3"));
        var b = Assert.Single(est.Batches);
        Assert.Equal("EXPLAIN FORMAT=JSON\nSELECT * FROM t WHERE id = :id AND x = @uservar", b.Sql);
        Assert.Equal(4, b.Line);
        Assert.Equal(["id"], est.Params!.Select(p => p.Name));
        Assert.Equal(ParamKinds.Null, est.Params![0].Kind);

        var act = mysql.CreateScript(new ExplainInput("x", "SELECT 1", ExplainModes.Actual, ServerVersion: "8.4.3"));
        Assert.Equal(2, act.Batches.Count);
        Assert.True(act.Batches[0].Visible);
        Assert.StartsWith("EXPLAIN ANALYZE\n", act.Batches[1].Sql);
        var maria = mysql.CreateScript(new ExplainInput("x", "DELETE FROM t WHERE id = 1", ExplainModes.Actual, ServerVersion: "11.4.2-MariaDB"));
        Assert.StartsWith("ANALYZE FORMAT=JSON\n", Assert.Single(maria.Batches).Sql);
        var old = mysql.CreateScript(new ExplainInput("x", "SELECT 1", ExplainModes.Actual, ServerVersion: "5.7.44"));
        Assert.StartsWith("EXPLAIN FORMAT=JSON\n", old.Batches[1].Sql);
        Assert.False(MySqlPlanReader.DeliversRows("SELECT * FROM t FOR UPDATE; SELECT 1"));
        Assert.True(MySqlPlanReader.IsPlanResultSet([new ColumnInfo("EXPLAIN", 0, "TEXT", "string", true)]));
    }

    [Fact]
    public void AccessTypes()
    {
        Assert.Equal("Full table scan", MySqlPlanReader.AccessOp("ALL"));
        Assert.Equal("Unique index lookup", MySqlPlanReader.AccessOp("eq_ref"));
        Assert.Equal("Single-row lookup", MySqlPlanReader.AccessOp("const"));
    }
}

/// <summary>Live MySQL: params, describe, explain, designer round trip (skipped without Docker).</summary>
public sealed class MySqlM15ConformanceTests(MySqlFixture fixture) : M15ConformanceTests<MySqlFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new MySqlDdlScripter();
    protected override IDesignerDatabase Database { get; } = new MySqlDesignerDatabase();
    protected override IPlanReader PlanReader { get; } = new MySqlPlanReader();
    protected override string IntType => "int";
    protected override string TextType(int n) => $"varchar({n})";
    protected override string MoneyType => "decimal(12,2)";
    protected override string DateType => "date";
    protected override TableModel Normalize(TableModel t, DdlScriptContext context) => MySqlM15.Normalize(t);
}

/// <summary>Live MariaDB: params, describe, explain, designer round trip (skipped without Docker).</summary>
public sealed class MariaDbM15ConformanceTests(MariaDbFixture fixture) : M15ConformanceTests<MariaDbFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new MySqlDdlScripter("mariadb");
    protected override IDesignerDatabase Database { get; } = new MySqlDesignerDatabase("mariadb");
    protected override IPlanReader PlanReader { get; } = new MySqlPlanReader("mariadb");
    protected override string IntType => "int";
    protected override string TextType(int n) => $"varchar({n})";
    protected override string MoneyType => "decimal(12,2)";
    protected override string DateType => "date";
    protected override TableModel Normalize(TableModel t, DdlScriptContext context) => MySqlM15.Normalize(t);
}

internal static class MySqlM15
{
    /// <summary>The server stores numeric defaults at the column's scale (0 → 0.00) and quotes them on MariaDB.</summary>
    public static TableModel Normalize(TableModel t) => t with
    {
        PrimaryKey = t.PrimaryKey is null ? null : t.PrimaryKey with { Clustered = false, Name = null },
        Indexes = t.Indexes.Select(i => i with { Clustered = false }).ToList(),
        Columns = t.Columns.Select(c => c with { Default = Number(c.Default) }).ToList(),
    };

    private static string? Number(string? d)
    {
        if (d is null) return null;
        var s = d.Trim().Trim('\'');
        return decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v.ToString("0.############", CultureInfo.InvariantCulture) : d;
    }
}
