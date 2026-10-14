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
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "Id" ? c with { Identity = new IdentityModel(1000, 1) } : c).ToList() };
        var script = Scripter.ScriptTable(orders, desired, Context);
        Assert.True(script.RebuildRequired);
        var sql = script.Statements.Select(s => s.Sql).ToList();
        Assert.Contains("SET IDENTITY_INSERT [dbo].[Orders__new] ON", sql);
        Assert.Contains("SET IDENTITY_INSERT [dbo].[Orders__new] OFF", sql);
        Assert.Contains("EXEC sys.sp_rename N'[dbo].[Orders__new]', N'Orders'", sql);
        Assert.Contains(sql, s => s.StartsWith("ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED", StringComparison.Ordinal));
        AssertParses(script.Statements);
        Golden.Match("tsql_identity_rebuild.sql", Golden.Render(script, "GO"));
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
        var view = new ViewDefinition("Sales", "OrderTotals", null, "SELECT CustomerId, SUM(Total) AS Total FROM dbo.Orders GROUP BY CustomerId;", new ViewOptions(SchemaBinding: true, CheckOption: false));
        var s = Scripter.ScriptView(view, Context);
        Assert.Equal("CREATE OR ALTER VIEW [Sales].[OrderTotals]\nWITH SCHEMABINDING\nAS\nSELECT CustomerId, SUM(Total) AS Total FROM dbo.Orders GROUP BY CustomerId", Assert.Single(s.Statements).Sql);
        AssertParses(s.Statements);
        Golden.Match("tsql_view_create.sql", Golden.Render(s, "GO"));

        var renamed = Scripter.ScriptView(view with { OriginalName = "Totals", Options = new ViewOptions(CheckOption: true) }, new DdlScriptContext("12.0.6024.0", "dbo"));
        Assert.Equal("EXEC sys.sp_rename N'[Sales].[Totals]', N'OrderTotals'", renamed.Statements[0].Sql);
        Assert.StartsWith("ALTER VIEW [Sales].[OrderTotals]", renamed.Statements[1].Sql);
        Assert.EndsWith("WITH CHECK OPTION", renamed.Statements[1].Sql);
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
}
