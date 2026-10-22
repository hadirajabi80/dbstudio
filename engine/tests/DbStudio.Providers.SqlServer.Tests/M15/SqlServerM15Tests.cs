using System.Data;
using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.SqlServer.Designer;
using DbStudio.Providers.SqlServer.Params;
using DbStudio.Providers.SqlServer.Plans;
using DbStudio.Providers.SqlServer.TSql;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Providers.SqlServer.Tests.M15;

public sealed class SqlServerScripterGoldenTests
{
    private static readonly SqlServerDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("16.0.4135.4", "dbo");

    public static TheoryData<string> CaseNames => new(DesignerCases.All(Dialect.TSql).Select(c => c.Name));

    /// <summary>Every generated statement must be valid T-SQL (ScriptDom, SQL Server 2022 grammar).</summary>
    internal static void AssertParses(IEnumerable<DdlStatement> statements)
    {
        foreach (var s in statements)
        {
            var parser = ScriptDomDiagnostics.CreateParser();
            parser.Parse(new StringReader(s.Sql), out var errors);
            Assert.True(errors.Count == 0, $"{s.Sql}\n→ {string.Join("; ", errors.Select(e => $"{e.Line}:{e.Column} {e.Message}"))}");
        }
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Script_MatchesGolden_AndParses(string name)
    {
        var c = DesignerCases.All(Dialect.TSql).Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, Context);
        Assert.True(script.Transactional);
        AssertParses(script.Statements);
        Golden.Match($"tsql_{name}.sql", Golden.Render(script, "GO"));
    }

    [Fact]
    public void IdentityChange_IsARebuild_WithIdentityInsert()
    {
        var orders = DesignerCases.Orders(Dialect.TSql);
        orders = orders with { Columns = orders.Columns.Select(c => c.Name == "Note" ? c with { Comment = "Free text" } : c).ToList() };
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "Id" ? c with { Identity = new IdentityModel(1000, 1) } : c).ToList() };
        var script = Scripter.ScriptTable(orders, desired, RebuildContext);
        Assert.True(script.RebuildRequired);
        var sql = script.Statements.Select(s => s.Sql).ToList();
        Assert.Contains("SET IDENTITY_INSERT [dbo].[Orders__new] ON", sql);
        Assert.Contains("SET IDENTITY_INSERT [dbo].[Orders__new] OFF", sql);
        Assert.Contains("EXEC sys.sp_rename N'[dbo].[Orders__new]', N'Orders'", sql);
        Assert.Contains(sql, s => s.StartsWith("ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED", StringComparison.Ordinal));

        // Inbound foreign keys are dropped before DROP TABLE and recreated after the primary key.
        var dropFk = sql.IndexOf("ALTER TABLE [Sales].[OrderLines] DROP CONSTRAINT [FK_OrderLines_Orders]");
        var dropTable = sql.IndexOf("DROP TABLE [dbo].[Orders]");
        var addPk = sql.FindIndex(s => s.Contains("[PK_Orders] PRIMARY KEY", StringComparison.Ordinal));
        var addFk = sql.IndexOf("ALTER TABLE [Sales].[OrderLines] WITH CHECK ADD CONSTRAINT [FK_OrderLines_Orders] FOREIGN KEY ([OrderId]) REFERENCES [dbo].[Orders] ([Id]) ON DELETE CASCADE");
        Assert.True(dropFk >= 0 && dropFk < dropTable && addPk < addFk, string.Join("\n", sql));
        Assert.Contains("ALTER TABLE [dbo].[Audit] WITH NOCHECK ADD CONSTRAINT [FK_Audit_Orders] FOREIGN KEY ([OrderId]) REFERENCES [dbo].[Orders] ([Id])", sql);
        Assert.Contains("ALTER TABLE [dbo].[Audit] NOCHECK CONSTRAINT [FK_Audit_Orders]", sql);
        // Triggers from their definitions (disabled ones stay disabled), MS_Description from the model, permissions.
        Assert.True(sql.IndexOf(TriggerSql) > addFk);
        Assert.Contains("DISABLE TRIGGER [dbo].[TR_Orders_Audit] ON [dbo].[Orders]", sql);
        Assert.Contains(sql, s => s.StartsWith("EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Free text'", StringComparison.Ordinal));
        Assert.Contains("GRANT SELECT ON [dbo].[Orders] TO [reporting]", sql);
        Assert.Contains("GRANT UPDATE ([Note]) ON [dbo].[Orders] TO [clerks] WITH GRANT OPTION", sql);
        Assert.Contains("DENY DELETE ON [dbo].[Orders] TO [clerks]", sql);
        // What cannot be scripted is listed, so the confirm dialog shows exactly what is lost.
        Assert.Contains("Extended property Owner on table is not carried over.", script.Warnings);
        Assert.Contains("The firing order of trigger TR_Orders_Audit (sp_settriggerorder) is not carried over.", script.Warnings);
        AssertParses(script.Statements);
        Golden.Match("tsql_identity_rebuild.sql", Golden.Render(script, "GO"));
    }

    private const string TriggerSql = "CREATE TRIGGER [dbo].[TR_Orders_Stamp] ON [dbo].[Orders] AFTER UPDATE AS\nBEGIN\n    SET NOCOUNT ON;\nEND";

    /// <summary>What SqlServerDesignerDatabase reads for Orders: two inbound FKs, two triggers, permissions, an extended property.</summary>
    private static readonly DdlScriptContext RebuildContext = Context with
    {
        Dependents =
        [
            new(DependentTypes.ForeignKey, "FK_OrderLines_Orders", "", false, "Sales", "OrderLines",
                new ForeignKeyModel { Name = "FK_OrderLines_Orders", Columns = ["OrderId"], RefSchema = "dbo", RefTable = "Orders", RefColumns = ["Id"], OnDelete = ReferentialActions.Cascade }),
            new(DependentTypes.ForeignKey, "FK_Audit_Orders", "", false, "dbo", "Audit",
                new ForeignKeyModel { Name = "FK_Audit_Orders", Columns = ["OrderId"], RefSchema = "dbo", RefTable = "Orders", RefColumns = ["Id"] }, Disabled: true),
            new(DependentTypes.Trigger, "TR_Orders_Stamp", TriggerSql, true),
            new(DependentTypes.Trigger, "TR_Orders_Audit", "CREATE TRIGGER dbo.TR_Orders_Audit ON dbo.Orders AFTER DELETE AS RETURN", true, Disabled: true, Detail: "ordered"),
            new(DependentTypes.Permission, "reporting", "SELECT", true, Detail: "GRANT"),
            new(DependentTypes.Permission, "clerks", "UPDATE", true, Detail: "GRANT_WITH_GRANT_OPTION", Column: "Note"),
            new(DependentTypes.Permission, "clerks", "DELETE", true, Detail: "DENY"),
            new(DependentTypes.NotCarried, "Owner", "", true, Detail: "Extended property Owner on table is not carried over."),
        ],
    };

    [Fact]
    public void IdentityRebuild_IsRefused_WhenDependentsAreUnknownOrCannotBeRecreated()
    {
        var orders = DesignerCases.Orders(Dialect.TSql);
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "Id" ? c with { Identity = new IdentityModel(1000, 1) } : c).ToList() };

        // Not read (or the read failed): nothing is dropped blindly.
        Assert.Contains("are unknown", Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired, Context)).Message);
        var unreadable = Context with { Dependents = [new(DependentTypes.Blocker, "Orders", "", false, Detail: "The foreign keys, triggers and permissions of the table could not be read (denied).")] };
        Assert.Contains("could not be read", Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired, unreadable)).Message);

        // An encrypted trigger cannot be recreated.
        var encrypted = Context with { Dependents = [new(DependentTypes.Trigger, "TR_Secret", "", true)] };
        Assert.Contains("TR_Secret", Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired, encrypted)).Message);

        // A referenced column that the rebuild drops.
        var referenced = Context with
        {
            Dependents = [new(DependentTypes.ForeignKey, "FK_X", "", false, "dbo", "X", new ForeignKeyModel { Name = "FK_X", Columns = ["NoteRef"], RefTable = "Orders", RefColumns = ["Note"] })],
        };
        var dropsNote = desired with { Columns = desired.Columns.Where(c => c.Name != "Note").ToList() };
        Assert.Contains("FK_X", Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, dropsNote, referenced)).Message);

        // A table with triggers cannot be renamed in the same rebuild (the definitions name it).
        var withTrigger = Context with { Dependents = [new(DependentTypes.Trigger, "TR_Orders_Stamp", TriggerSql, true)] };
        Assert.Contains("separate step", Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired with { Name = "Orders2" }, withTrigger)).Message);

        // With no dependents at all the rebuild is fine.
        Assert.True(Scripter.ScriptTable(orders, desired, Context with { Dependents = [] }).RebuildRequired);
    }

    [Fact]
    public void RebuildDependencyQueries_AreRegisteredForTheParseTest()
    {
        foreach (var name in new[] { "InboundForeignKeysQuery", "TriggersQuery", "PermissionsQuery", "ExtendedPropertiesQuery", "SchemaBoundQuery", "UnsupportedStorageQuery" })
            Assert.True(SqlServerDesignerDatabase.AllQueries.ContainsKey(name), name);
    }

    public static TheoryData<string, string, string?, string> StorageCases => new()
    {
        { DependentTypes.ColumnstoreIndex, "IX_cs", "NONCLUSTERED COLUMNSTORE", "Orders has a columnstore index IX_cs; Rowlit cannot recreate it in a rebuild" },
        { DependentTypes.XmlIndex, "XI_Doc", "XML", "Orders has an XML index XI_Doc; Rowlit cannot recreate it in a rebuild" },
        { DependentTypes.SpatialIndex, "SI_Geo", "SPATIAL", "Orders has a spatial index SI_Geo; Rowlit cannot recreate it in a rebuild" },
        { DependentTypes.OtherIndex, "IX_hash", "NONCLUSTERED_HASH", "Orders has a nonclustered hash index IX_hash; Rowlit cannot recreate it" },
        { DependentTypes.FulltextIndex, "", "FT_Catalog", "Orders has a full-text index (catalog FT_Catalog); Rowlit cannot recreate it" },
        { DependentTypes.Partitioning, "PK_Orders", "PS_OrderDate", "index PK_Orders of Orders is partitioned on PS_OrderDate; Rowlit cannot recreate it" },
        { DependentTypes.Partitioning, "", "PS_OrderDate", "Orders is partitioned on PS_OrderDate; Rowlit cannot recreate it" },
        { DependentTypes.Filegroup, "", "FG_Archive", "Orders is stored on filegroup FG_Archive; Rowlit cannot recreate it" },
        { DependentTypes.Filegroup, "", "FG_Lob (TEXTIMAGE_ON)", "Orders is stored on filegroup FG_Lob (TEXTIMAGE_ON); Rowlit cannot recreate it" },
        { DependentTypes.Compression, "PK_Orders", "PAGE", "index PK_Orders of Orders uses PAGE compression; Rowlit cannot recreate it" },
        { DependentTypes.Compression, "", "ROW", "Orders uses ROW compression; Rowlit cannot recreate it" },
        { DependentTypes.ChangeTracking, "", null, "Orders has change tracking enabled; Rowlit cannot recreate it" },
        { DependentTypes.Cdc, "", null, "Orders is tracked by change data capture (CDC); Rowlit cannot recreate it" },
    };

    /// <summary>features-r1-02: storage the model does not hold refuses the identity rebuild instead of being dropped.</summary>
    [Theory]
    [MemberData(nameof(StorageCases))]
    public void IdentityRebuild_IsRefused_ForStorageTheModelDoesNotHold(string type, string name, string? detail, string expected)
    {
        var orders = DesignerCases.Orders(Dialect.TSql);
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "Id" ? c with { Identity = new IdentityModel(1000, 1) } : c).ToList() };
        // Alongside everything a rebuild can carry over (FKs, triggers, permissions): the storage dependent alone decides.
        var context = RebuildContext with { Dependents = [.. RebuildContext.Dependents!, new DependentObject(type, name, "", true, Detail: detail)] };
        var message = Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired, context)).Message;
        Assert.StartsWith("The table cannot be rebuilt safely: ", message);
        Assert.Contains(expected, message);
        Assert.EndsWith("Change the identity in a script instead.", message);
        Assert.True(DependentTypes.UnsupportedStorage.Contains(type));
    }

    [Fact]
    public void IdentityRebuild_Refusal_ListsEveryStorageFeature_AndOtherAltersIgnoreThem()
    {
        var orders = DesignerCases.Orders(Dialect.TSql);
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "Id" ? c with { Identity = new IdentityModel(1000, 1) } : c).ToList() };
        var context = Context with
        {
            Dependents =
            [
                new(DependentTypes.ColumnstoreIndex, "IX_cs", "", true, Detail: "NONCLUSTERED COLUMNSTORE"),
                new(DependentTypes.Compression, "PK_Orders", "", true, Detail: "PAGE"),
                new(DependentTypes.Compression, "PK_Orders", "", true, Detail: "PAGE"), // one row per partition: listed once
                new(DependentTypes.Cdc, "", "", true),
            ],
        };
        var message = Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(orders, desired, context)).Message;
        Assert.Equal(
            "The table cannot be rebuilt safely: Rowlit cannot recreate these in a rebuild: Orders has a columnstore index IX_cs; " +
            "index PK_Orders of Orders uses PAGE compression; Orders is tracked by change data capture (CDC). Change the identity in a script instead.",
            message);

        // A plain ALTER (no rebuild) keeps them: the dependents are not consulted.
        var addColumn = orders with { Columns = [.. orders.Columns, new TableColumnModel { Name = "Extra", Type = "int", Nullable = true }] };
        var alter = Scripter.ScriptTable(orders, addColumn, context);
        Assert.False(alter.RebuildRequired);
        Assert.NotEmpty(alter.Statements);
    }

    [Fact]
    public void UnknownDefaultName_IsLookedUpDynamically()
    {
        var orders = DesignerCases.Orders(Dialect.TSql);
        var original = orders with { Columns = orders.Columns.Select(c => c with { DefaultName = null }).ToList() };
        var desired = original with { Columns = original.Columns.Select(c => c.Name == "Status" ? c with { Default = null } : c).ToList() };
        var script = Scripter.ScriptTable(original, desired, Context);
        var drop = Assert.Single(script.Statements);
        Assert.Contains("FROM sys.default_constraints", drop.Sql);
        Assert.Contains("QUOTENAME(@df_Status)", drop.Sql);
        AssertParses(script.Statements);
    }

    [Fact]
    public void NarrowingWarnings()
    {
        Assert.NotNull(SqlServerDdlScripter.NarrowingWarning(new TableColumnModel { Type = "nvarchar(100)" }, new TableColumnModel { Type = "nvarchar(50)" }));
        Assert.NotNull(SqlServerDdlScripter.NarrowingWarning(new TableColumnModel { Type = "nvarchar(max)" }, new TableColumnModel { Type = "nvarchar(4000)" }));
        Assert.NotNull(SqlServerDdlScripter.NarrowingWarning(new TableColumnModel { Type = "decimal(12,4)" }, new TableColumnModel { Type = "decimal(12,2)" }));
        Assert.Null(SqlServerDdlScripter.NarrowingWarning(new TableColumnModel { Type = "nvarchar(50)" }, new TableColumnModel { Type = "nvarchar(100)" }));
        Assert.Contains("code page", SqlServerDdlScripter.NarrowingWarning(new TableColumnModel { Type = "nvarchar(50)" }, new TableColumnModel { Type = "varchar(50)" }));
    }

    [Fact]
    public void Views_CreateOrAlter_AndOldServers()
    {
        // A new view is a plain CREATE VIEW: an existing view of that name fails on the server instead of being replaced.
        var view = new ViewDefinition("Sales", "OrderTotals", null, "SELECT CustomerId, SUM(Total) AS Total FROM dbo.Orders GROUP BY CustomerId;", new ViewOptions(SchemaBinding: true, CheckOption: false));
        var s = Scripter.ScriptView(view, Context);
        Assert.Equal("CREATE VIEW [Sales].[OrderTotals]\nWITH SCHEMABINDING\nAS\nSELECT CustomerId, SUM(Total) AS Total FROM dbo.Orders GROUP BY CustomerId", Assert.Single(s.Statements).Sql);
        AssertParses(s.Statements);
        Golden.Match("tsql_view_create.sql", Golden.Render(s, "GO"));

        // Editing the same view: CREATE OR ALTER (2016 SP1+), ALTER VIEW on older servers; a case-only rename keeps it.
        var edited = Scripter.ScriptView(view with { OriginalName = "OrderTotals" }, Context);
        Assert.StartsWith("CREATE OR ALTER VIEW [Sales].[OrderTotals]", Assert.Single(edited.Statements).Sql);
        var editedOld = Scripter.ScriptView(view with { OriginalName = "OrderTotals" }, new DdlScriptContext("12.0.6024.0", "dbo"));
        Assert.StartsWith("ALTER VIEW [Sales].[OrderTotals]", Assert.Single(editedOld.Statements).Sql);
        var caseOnly = Scripter.ScriptView(view with { OriginalName = "ordertotals" }, Context);
        Assert.Equal("EXEC sys.sp_rename N'[Sales].[ordertotals]', N'OrderTotals'", caseOnly.Statements[0].Sql);
        Assert.StartsWith("CREATE OR ALTER VIEW [Sales].[OrderTotals]", caseOnly.Statements[1].Sql);

        // Renamed: the new name is created (never replaced), then the old view is dropped, in one transaction.
        var renamed = Scripter.ScriptView(view with { OriginalName = "Totals", Options = new ViewOptions(CheckOption: true) }, new DdlScriptContext("12.0.6024.0", "dbo"));
        Assert.True(renamed.Transactional);
        Assert.Equal(2, renamed.Statements.Count);
        Assert.StartsWith("CREATE VIEW [Sales].[OrderTotals]", renamed.Statements[0].Sql);
        Assert.EndsWith("WITH CHECK OPTION", renamed.Statements[0].Sql);
        Assert.Equal("DROP VIEW [Sales].[Totals]", renamed.Statements[1].Sql);
        Assert.DoesNotContain(renamed.Statements, st => st.Sql.Contains("OR ALTER", StringComparison.Ordinal) || st.Sql.Contains("IF EXISTS", StringComparison.Ordinal));
        Assert.Contains(renamed.Warnings, w => w.Contains("permissions", StringComparison.Ordinal));
        AssertParses(renamed.Statements);
        Assert.False(SqlServerDdlScripter.SupportsCreateOrAlter("13.0.4000.0"));
        Assert.True(SqlServerDdlScripter.SupportsCreateOrAlter("13.0.4001.0"));
    }

    [Fact]
    public void DesignerQueries_ParseWithScriptDom()
    {
        foreach (var (name, sql) in SqlServerDesignerDatabase.AllQueries)
        {
            ScriptDomDiagnostics.CreateParser().Parse(new StringReader(sql), out var errors);
            Assert.True(errors.Count == 0, $"{name}: {string.Join("; ", errors.Select(e => e.Message))}");
        }
    }

    [Fact]
    public void ViewText_SplitsStoredDefinition()
    {
        var (body, options) = ViewText.Split("CREATE VIEW [dbo].[V] WITH SCHEMABINDING AS\r\nSELECT a FROM dbo.T\r\nWITH CHECK OPTION;", Dialect.TSql);
        Assert.Equal("SELECT a FROM dbo.T", body);
        Assert.True(options.SchemaBinding);
        Assert.True(options.CheckOption);
    }
}

public sealed class SqlServerPlanReaderTests
{
    private static string Load(string name) => File.ReadAllText(Path.Combine(Path.GetDirectoryName(Here())!, "plans", name));
    private static string Here([System.Runtime.CompilerServices.CallerFilePath] string path = "") => path;

    [Fact]
    public void Estimated_HashJoinTree_CostsAndWarnings()
    {
        var plan = SqlServerPlanReader.Parse([Load("estimated.xml")], actual: false);
        var root = plan.Root;
        Assert.Equal("SELECT", root.Op);
        Assert.Equal(0.0563219, root.Cost);
        var hash = Assert.Single(root.Children);
        Assert.Equal(("Hash Match", "Inner Join"), (hash.Op, hash.LogicalOp));
        Assert.Contains("[o].[CustomerId]=", hash.Predicate);
        Assert.Equal(2, hash.Children.Count);
        Assert.Equal("dbo.Customers.PK_Customers (c)", hash.Children[0].Object);
        Assert.Equal("dbo.Orders.PK_Orders (o)", hash.Children[1].Object);
        Assert.Contains("[o].[Total]>[@min]", hash.Children[1].Predicate);
        Assert.Contains(hash.Children[1].Warnings, w => w.StartsWith("Type conversion may affect the plan", StringComparison.Ordinal));
        Assert.Contains(root.Warnings, w => w.StartsWith("Missing index (impact 71.2%): dbo.Orders (Total) INCLUDE (CustomerId)", StringComparison.Ordinal));
        Assert.Single(plan.Warnings);
        // Cost shares: own cost / root cost, summing to ~100.
        var sum = root.DescendantsAndSelf().Sum(n => n.CostPct ?? 0);
        Assert.InRange(sum, 99.5, 100.5);
        Assert.Equal(57.3, hash.Children[1].CostPct);
        Assert.Equal("xml", plan.RawFormat);
        Assert.Null(hash.ActualRows);
        Assert.Equal([0, 1, 2, 3], root.DescendantsAndSelf().Select(n => n.Id - 1));

        Golden.MatchUiFixture("plans/sqlserver-estimated.json", new ExecPlanEvent("x_fixture", Dialect.TSql, "estimated", plan.Root, plan.Raw, plan.RawFormat, plan.Warnings) { Ts = "2026-10-14T10:00:00.000Z" });
    }

    [Fact]
    public void Actual_SeekWithRuntimeCounters()
    {
        var plan = SqlServerPlanReader.Parse([Load("actual.xml")], actual: true);
        var top = Assert.Single(plan.Root.Children);
        Assert.Equal("Top", top.Op);
        var seek = Assert.Single(top.Children);
        Assert.Equal("Clustered Index Seek", seek.Op);
        Assert.Equal("[Id] = [@id]", seek.Predicate);
        Assert.Equal(1, seek.ActualRows);
        Assert.Equal("2", seek.Props!["Logical reads"]);
        Assert.Equal(1, plan.Root.ActualRows);
        Golden.MatchUiFixture("plans/sqlserver-actual.json", new ExecPlanEvent("x_fixture", Dialect.TSql, "actual", plan.Root, plan.Raw, plan.RawFormat, plan.Warnings) { Ts = "2026-10-14T10:00:00.000Z" });
    }

    [Fact]
    public void MultipleStatements_GetABatchRoot()
    {
        var plan = SqlServerPlanReader.Parse([Load("estimated.xml"), Load("actual.xml")], actual: false);
        Assert.Equal("BATCH", plan.Root.Op);
        Assert.Equal(2, plan.Root.Children.Count);
        Assert.Equal(plan.Root.Children.Sum(c => c.Cost), plan.Root.Cost);
    }

    [Fact]
    public void Script_UsesShowplanForEstimated_AndStatisticsXmlForActual()
    {
        var reader = new SqlServerPlanReader();
        var est = reader.CreateScript(new ExplainInput("x", "SELECT 1", ExplainModes.Estimated));
        Assert.Equal("SET SHOWPLAN_XML ON", est.Batches[0].Sql);
        Assert.True(est.Batches[1].CaptureAll);
        Assert.Equal(["SET SHOWPLAN_XML OFF"], est.CleanupSql);
        var act = reader.CreateScript(new ExplainInput("x", "SELECT 1", ExplainModes.Actual, Line: 4));
        Assert.Equal("SET STATISTICS XML ON", act.Batches[0].Sql);
        Assert.True(act.Batches[1].Visible);
        Assert.Equal(4, act.Batches[1].Line);
        Assert.Equal(["SET STATISTICS XML OFF"], act.CleanupSql);
        Assert.True(act.IsPlanResultSet([new ColumnInfo(SqlServerPlanReader.ShowplanColumn, 0, "xml", "xml", true)]));
    }

    [Fact]
    public void Estimated_with_parameters_declares_them_because_showplan_answers_an_rpc_with_no_plan()
    {
        var reader = new SqlServerPlanReader();
        QueryParam[] ps =
        [
            new("id", ParamKinds.Int, JsonValue.Create(1)), new("big", ParamKinds.Int, JsonValue.Create(5_000_000_000L)),
            new("name", ParamKinds.String, JsonValue.Create("x")), new("amount", ParamKinds.Decimal, JsonValue.Create("12.50")),
        ];
        var est = reader.CreateScript(new ExplainInput("x", "SELECT * FROM T WHERE Id = @id", ExplainModes.Estimated, ps, Line: 3));
        Assert.Null(est.Params); // no RPC: the batch goes as plain text
        Assert.Equal("DECLARE @id int, @big bigint, @name nvarchar(4000), @amount decimal(38, 2); SELECT * FROM T WHERE Id = @id", est.Batches[1].Sql);
        Assert.Equal(3, est.Batches[1].Line); // same line: server error line numbers still map to the editor
        // Output or positional parameters cannot be declared: the binds stay as they were.
        var outParam = reader.CreateScript(new ExplainInput("x", "EXEC p @r OUTPUT", ExplainModes.Estimated, [new QueryParam("r", ParamKinds.Int, null, ParamDirections.Out)]));
        Assert.NotNull(outParam.Params);
        Assert.Equal("EXEC p @r OUTPUT", outParam.Batches[1].Sql);
        // Actual mode executes through sp_executesql, which STATISTICS XML does report.
        var act = reader.CreateScript(new ExplainInput("x", "SELECT * FROM T WHERE Id = @id", ExplainModes.Actual, ps));
        Assert.Same(ps, act.Params);
    }
}

public sealed class SqlServerParamBinderTests
{
    private static QueryParam P(string name, string kind, object? value, string? direction = null) =>
        new(name, kind, value is null ? null : JsonValue.Create(value), direction);

    [Fact]
    public void Placeholders_SkipDeclaredVariables_SystemFunctions_StringsAndComments()
    {
        const string sql = "DECLARE @total int = 0, @t TABLE (a int);\nSELECT @@ROWCOUNT, @id, '@notme' -- @nope\nFROM t WHERE x = @id AND y = @total";
        Assert.Equal(["id", "id"], SqlServerParamBinder.Instance.FindPlaceholders(sql).Select(p => p.Name));
        Assert.Equal(["total", "t"], SqlServerParamBinder.DeclaredVariables(SqlTokenizer.Tokenize(sql, Dialect.TSql)).ToList());
    }

    [Fact]
    public void Bind_CreatesTypedSqlParameters_OncePerName()
    {
        using var cmd = new SqlCommand("SELECT * FROM t WHERE a = @a AND b = @b AND c = @c AND a2 = @a AND d = @d AND e = @e AND f = @f");
        var bound = SqlServerParamBinder.Instance.Bind(cmd,
        [
            P("a", "int", 5), P("b", "decimal", "12.345"), P("c", "string", "x"), P("d", "datetime", "2026-01-02T03:04:05"),
            P("e", "guid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"), P("f", "int", 5_000_000_000L), P("unused", "int", 1),
        ], new ParamBindCursor());
        Assert.Equal(6, cmd.Parameters.Count);
        Assert.Empty(bound.Missing);
        var ps = cmd.Parameters.Cast<SqlParameter>().ToDictionary(p => p.ParameterName);
        Assert.Equal(SqlDbType.Int, ps["@a"].SqlDbType);
        Assert.Equal((SqlDbType.Decimal, (byte)38, (byte)3), (ps["@b"].SqlDbType, ps["@b"].Precision, ps["@b"].Scale));
        Assert.Equal((SqlDbType.NVarChar, 4000), (ps["@c"].SqlDbType, ps["@c"].Size));
        Assert.Equal(SqlDbType.DateTime2, ps["@d"].SqlDbType);
        Assert.Equal(SqlDbType.UniqueIdentifier, ps["@e"].SqlDbType);
        Assert.Equal(SqlDbType.BigInt, ps["@f"].SqlDbType);
    }

    [Fact]
    public void OutputParams_AndPositionalAreHandled()
    {
        using var cmd = new SqlCommand("EXEC dbo.GetTotal @id = @id, @total = @total OUTPUT; SELECT ?");
        var bound = SqlServerParamBinder.Instance.Bind(cmd, [P("id", "int", 1), P("total", "decimal", null, "out")], new ParamBindCursor());
        Assert.Equal(ParameterDirection.Output, ((SqlParameter)cmd.Parameters["@total"]).Direction);
        Assert.Single(bound.Outputs);
        Assert.Equal(["?1"], bound.Missing);
        using var cmd2 = new SqlCommand("SELECT ?");
        Assert.Throws<DbStudio.Core.Services.EngineException>(() => SqlServerParamBinder.Instance.Bind(cmd2, [P("1", "int", 1)], new ParamBindCursor()));
    }

    [Fact]
    public void RefCursor_IsRejected()
    {
        using var cmd = new SqlCommand("SELECT @c");
        var ex = Assert.Throws<DbStudio.Core.Services.EngineException>(() => SqlServerParamBinder.Instance.Bind(cmd, [P("c", "refcursor", null)], new ParamBindCursor()));
        Assert.Contains("REF CURSOR", ex.Message);
    }
}

/// <summary>Live SQL Server: params, describe, explain, designer round trip (skipped without Docker).</summary>
public sealed class SqlServerM15ConformanceTests(SqlServerFixture fixture) : M15ConformanceTests<SqlServerFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new SqlServerDdlScripter();
    protected override IDesignerDatabase Database { get; } = new SqlServerDesignerDatabase();
    protected override IPlanReader PlanReader { get; } = new SqlServerPlanReader();

    /// <summary>
    /// The UI's Execute routine call (ui/src/components/ExecuteRoutine/routineSql.ts): named binds, a parameter left on
    /// its default, OUTPUT into a declared variable, and the return value plus outputs SELECTed as the last result set.
    /// </summary>
    [SkippableFact]
    public async Task ExecuteRoutine_GeneratedCall_ReturnsOutputsAsTheLastResultSet()
    {
        RequireAvailable();
        var proc = "m15_er_" + Guid.NewGuid().ToString("N")[..8];
        await Fixture.RunBatchesAsync([
            $"CREATE PROCEDURE dbo.{proc} @Year int, @Month int = 3, @Total decimal(12,2) OUTPUT, @Note nvarchar(50) = NULL AS " +
            "BEGIN SET NOCOUNT ON; SELECT @Year AS y, @Month AS m, @Note AS note; SET @Total = @Year + @Month + 0.5; RETURN 7; END",
        ]);
        try
        {
            await using var session = await Fixture.OpenSessionAsync();
            var (summary, sink) = await RunAsync(session, [P("Year", "int", 2024), P("Note", "string", "it's")],
                "DECLARE @return_value int, @Total decimal(12,2);\n" +
                $"EXEC @return_value = [dbo].[{proc}]\n    @Year = @Year,\n    @Total = @Total OUTPUT,\n    @Note = @Note;\n" +
                "SELECT @return_value AS [Return value], @Total AS [Total];");
            Assert.True(summary.Status == ExecutionStatus.Ok, string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
            Assert.Equal(2, sink.ResultSets.Count);
            Assert.Equal(["2024", "3", "it's"], sink.ResultSets[0].Rows.Single().Select(v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)));
            Assert.Equal(["Return value", "Total"], sink.ResultSets[1].Columns.Select(c => c.Name));
            Assert.Equal(["7", "2027.50"], sink.ResultSets[1].Rows.Single().Select(v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)));

            // Scalar function with DEFAULT for an omitted argument.
            await Fixture.RunBatchesAsync([$"CREATE FUNCTION dbo.{proc}_fn(@a decimal(12,2), @rate decimal(5,2) = 0.10) RETURNS decimal(12,2) AS BEGIN RETURN @a * @rate; END"]);
            var (fn, fnSink) = await RunAsync(session, [P("a", "decimal", "200")], $"SELECT [dbo].[{proc}_fn](@a, DEFAULT) AS [Result];");
            Assert.True(fn.Status == ExecutionStatus.Ok, string.Join("; ", fnSink.Errors.Select(e => e.Error.Message)));
            Assert.Equal("20.00", Convert.ToString(fnSink.ResultSets.Single().Rows.Single()[0], System.Globalization.CultureInfo.InvariantCulture));
        }
        finally
        {
            await Fixture.RunBatchesAsync([$"DROP PROCEDURE IF EXISTS dbo.{proc}", $"DROP FUNCTION IF EXISTS dbo.{proc}_fn"]);
        }
    }
}
