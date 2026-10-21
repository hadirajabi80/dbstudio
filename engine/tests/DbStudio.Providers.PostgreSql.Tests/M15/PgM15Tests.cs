using System.Text.RegularExpressions;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.PostgreSql.Designer;
using DbStudio.Providers.PostgreSql.Plans;

namespace DbStudio.Providers.PostgreSql.Tests.M15;

/// <summary>The designer cases of docs/PLAN-PG.md 2.9 with PostgreSQL names (lower snake, schema public).</summary>
public static class PgDesignerCases
{
    private static TableColumnModel Col(string name, string type, bool nullable = true, string? def = null) =>
        new() { Id = name, Name = name, Type = type, Nullable = nullable, Default = def };

    public static TableModel Orders() => new()
    {
        Schema = "public",
        Name = "orders",
        Columns =
        [
            Col("id", "integer", false), Col("customer_id", "integer", false), Col("order_date", "date", false),
            Col("status", "varchar(20)", false, "'new'"), Col("total", "numeric(12,2)", false, "0"), Col("note", "text"),
        ],
        PrimaryKey = new PrimaryKeyModel { Name = "pk_orders", Columns = ["id"], Clustered = false },
        Indexes = [new IndexModel { Name = "ix_orders_customer_id", Columns = [new IndexColumnModel("customer_id")] }],
        ForeignKeys = [new ForeignKeyModel { Name = "fk_orders_customers", Columns = ["customer_id"], RefTable = "customers", RefColumns = ["id"] }],
        Checks = [new CheckModel { Name = "ck_orders_total", Expression = "total >= 0" }],
    };

    private static TableModel Edit(TableModel t, string name, Func<TableColumnModel, TableColumnModel> edit) =>
        t with { Columns = t.Columns.Select(c => c.Name == name ? edit(c) : c).ToList() };

    public static IReadOnlyList<DesignerCases.Case> All()
    {
        var orders = Orders();
        return
        [
            new("create", null, orders with
            {
                Comment = "Customer orders",
                Columns = orders.Columns.Select(c => c.Name == "note" ? c with { Comment = "Free text" } : c).ToList(),
                Uniques = [new UniqueModel { Name = "uq_orders_customer_date", Columns = ["customer_id", "order_date"] }],
            }),
            new("add_column", orders, orders with { Columns = [.. orders.Columns, Col("refunded_at", "timestamptz") with { Id = "new_1" }] }),
            new("add_column_not_null_default", orders, orders with { Columns = [.. orders.Columns, Col("channel", "text", false, "'web'") with { Id = "new_2" }] }),
            new("drop_column", orders, orders with { Columns = orders.Columns.Where(c => c.Name != "note").ToList() }),
            new("rename_column", orders, Edit(orders, "note", c => c with { Name = "remarks" })),
            new("change_type", orders, Edit(orders, "note", c => c with { Type = "varchar(400)" })),
            new("change_type_using", orders, Edit(orders, "status", c => c with { Type = "integer", Default = null })),
            new("narrow_type_not_null", orders, Edit(Edit(orders, "status", c => c with { Type = "varchar(10)" }), "note", c => c with { Nullable = false })),
            new("drop_default", orders, Edit(orders, "status", c => c with { Default = null })),
            new("change_default", orders, Edit(orders, "total", c => c with { Default = "1" })),
            new("add_fk", orders with { ForeignKeys = [] }, orders with { ForeignKeys = [orders.ForeignKeys[0] with { OnDelete = ReferentialActions.Cascade, OnUpdate = ReferentialActions.Restrict }] }),
            new("indexes", orders, orders with
            {
                Indexes =
                [
                    new IndexModel { Name = "ix_orders_date_status", Columns = [new IndexColumnModel("order_date", Desc: true), new IndexColumnModel("status")], Include = ["total"] },
                    new IndexModel { Name = "ix_orders_open", Unique = true, Columns = [new IndexColumnModel("customer_id")], Filter = "status <> 'cancelled'" },
                ],
            }),
            new("checks_and_uniques", orders, orders with
            {
                Checks = [new CheckModel { Name = "ck_orders_total", Expression = "total >= 0 AND total < 1000000" }],
                Uniques = [new UniqueModel { Name = "uq_orders_customer_date", Columns = ["customer_id", "order_date"] }],
            }),
            new("rename_table", orders, orders with { Name = "sales_orders" }),
            new("move_schema", orders, orders with { Schema = "sales" }),
            new("comments", orders, Edit(orders with { Comment = "All orders" }, "total", c => c with { Comment = "Gross total" })),
            new("clear_comment", Edit(orders, "note", c => c with { Comment = "x" }), orders),
            new("identity_create", null, orders with
            {
                Name = "invoices",
                Columns = [Col("id", "bigint", false) with { Identity = new IdentityModel(1, 1, Always: true) }, Col("amount", "numeric(12,2)", false)],
                PrimaryKey = new PrimaryKeyModel { Columns = ["id"] }, Indexes = [], ForeignKeys = [], Checks = [],
            }),
            new("identity_alter", orders, Edit(orders, "id", c => c with { Identity = new IdentityModel(1000, 1) })),
            new("identity_change", Edit(orders, "id", c => c with { Identity = new IdentityModel(1, 1) }), Edit(orders, "id", c => c with { Identity = new IdentityModel(1, 5, Always: true) })),
            new("identity_drop", Edit(orders, "id", c => c with { Identity = new IdentityModel(1, 1) }), orders),
            new("generated_column", orders, orders with { Columns = [.. orders.Columns, Col("total_with_tax", "numeric(12,2)") with { Id = "new_3", Computed = new ComputedModel("total * 1.19", Persisted: true) }] }),
            new("array_column", null, new TableModel
            {
                Schema = "public", Name = "tagged",
                Columns = [Col("id", "integer", false), Col("tags", "text[]", false, "'{}'"), Col("meta", "jsonb"), Col("status", "public.order_status"), Col("name", "text") with { Collation = "C" }],
                PrimaryKey = new PrimaryKeyModel { Columns = ["id"] },
            }),
            new("mixed_case", null, new TableModel { Schema = "Sales", Name = "Orders", Columns = [Col("Id", "integer", false), Col("order", "text")], PrimaryKey = new PrimaryKeyModel { Columns = ["Id"] } }),
        ];
    }
}

public sealed class PgScripterGoldenTests
{
    private static readonly PgDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("17.2", "public");

    public static TheoryData<string> CaseNames => new(PgDesignerCases.All().Select(c => c.Name));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Script_MatchesGolden_AndLexes(string name)
    {
        var c = PgDesignerCases.All().Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, Context);
        Assert.True(script.Transactional);
        Assert.False(script.RebuildRequired);
        foreach (var s in script.Statements) Assert.Single(PgSqlText.Split(s.Sql)); // one statement each, balanced quoting
        Golden.Match($"pgsql_{name}.sql", Golden.Render(script));
    }

    [Fact]
    public void Alter_CombinesSubcommands_InOneStatement()
    {
        var orders = PgDesignerCases.Orders();
        var desired = orders with
        {
            Columns = [.. orders.Columns.Where(c => c.Name != "note").Select(c => c.Name == "total" ? c with { Default = null } : c), new TableColumnModel { Id = "n", Name = "extra", Type = "text" }],
        };
        var script = Scripter.ScriptTable(orders, desired, Context);
        var alter = Assert.Single(script.Statements);
        Assert.Equal("ALTER TABLE public.orders\n    DROP COLUMN note,\n    ADD COLUMN extra text,\n    ALTER COLUMN total DROP DEFAULT", alter.Sql);
        Assert.Contains("deletes its data", alter.Warning);
    }

    [Fact]
    public void NoChange_IsEmpty_AndClusteredDifferencesAreIgnored()
    {
        var orders = PgDesignerCases.Orders();
        Assert.Empty(Scripter.ScriptTable(orders, orders with { PrimaryKey = orders.PrimaryKey! with { Clustered = true } }, Context).Statements);
    }

    [Fact]
    public void Validation_GeneratedColumnNeedsAType_SerialAlterWarns()
    {
        var orders = PgDesignerCases.Orders();
        Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(null, orders with
        {
            Columns = [.. orders.Columns, new TableColumnModel { Name = "g", Type = "", Computed = new ComputedModel("1") }],
        }, Context));
        var s = Scripter.ScriptTable(orders, orders with { Columns = orders.Columns.Select(c => c.Name == "id" ? c with { Type = "serial" } : c).ToList() }, Context);
        Assert.Contains(s.Warnings, w => w.Contains("identity", StringComparison.Ordinal));
        var virt = Scripter.ScriptTable(null, orders with { Columns = [.. orders.Columns, new TableColumnModel { Name = "g", Type = "int", Computed = new ComputedModel("1", false) }] }, Context);
        Assert.Contains(virt.Warnings, w => w.Contains("STORED", StringComparison.Ordinal));
    }

    [Fact]
    public void Views_CreateReplaceRename()
    {
        var view = new ViewDefinition("sales", "order_totals", null, "SELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id;", new ViewOptions(CheckOption: true));
        var s = Scripter.ScriptView(view, Context);
        Assert.Equal("CREATE VIEW sales.order_totals AS\nSELECT customer_id, sum(total) AS total FROM public.orders GROUP BY customer_id\nWITH CASCADED CHECK OPTION",
            Assert.Single(s.Statements).Sql);
        Golden.Match("pgsql_view_create.sql", Golden.Render(s));
        var edited = Scripter.ScriptView(view with { OriginalName = "order_totals", Options = new ViewOptions() }, Context);
        Assert.StartsWith("CREATE OR REPLACE VIEW sales.order_totals AS", Assert.Single(edited.Statements).Sql);
        Assert.Contains(edited.Warnings, w => w.Contains("append columns", StringComparison.Ordinal));
        var renamed = Scripter.ScriptView(view with { OriginalName = "totals" }, Context);
        Assert.Equal("ALTER VIEW sales.totals RENAME TO order_totals", renamed.Statements[0].Sql);
        Golden.Match("pgsql_view_rename.sql", Golden.Render(renamed));
    }

    [Fact]
    public void Types_AndFeatures_RecordedForTheUi()
    {
        var types = Scripter.GetTypes(Context);
        Assert.True(types.Features.TransactionalDdl);
        Assert.False(types.Features.ClusteredIndexes);
        Assert.True(types.Features.IncludedColumns && types.Features.FilteredIndexes && types.Features.Comments && types.Features.Schemas);
        Assert.Contains(types.Types, t => t.Name == "jsonb");
        Golden.MatchUiFixture("designer/pgsql-types.json", types);
    }

    [Fact]
    public void CheckExpression_FromConstraintDef()
    {
        Assert.Equal("amount >= 0::numeric", PgDesignerDatabase.CheckExpression("CHECK (amount >= 0::numeric)"));
        Assert.Equal("a > 0 AND b > 0", PgDesignerDatabase.CheckExpression("CHECK ((a > 0 AND b > 0)) NOT VALID"));
    }
}

public sealed class PgPlanReaderTests
{
    private static string Load(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Plans", "fixtures", name));

    [Fact]
    public void Estimated_HashJoinTree()
    {
        var plan = PgPlanReader.Parse(Load("estimated.json"), actual: false);
        var root = plan.Root;
        Assert.Equal("Hash Join", root.Op);
        Assert.Equal("Inner", root.LogicalOp);
        Assert.Equal(2.25, root.Cost);
        Assert.Equal("(o.customer_id = c.id)", root.Predicate);
        Assert.Equal(4, root.DescendantsAndSelf().Count());
        Assert.Equal("public.orders (o)", root.Children[0].Object);
        var index = root.Children[1].Children[0];
        Assert.Equal("public.customers.pk_customers (c)", index.Object);
        Assert.Equal("(c.id = $1)", index.Predicate);
        Assert.Equal("json", plan.RawFormat);
        Assert.Null(root.ActualRows);
        Assert.InRange(root.DescendantsAndSelf().Sum(n => n.CostPct ?? 0), 99.5, 100.5);
        Assert.Equal([1, 2, 3, 4], root.DescendantsAndSelf().Select(n => n.Id));
        Golden.MatchUiFixture("plans/pgsql-estimated.json", new ExecPlanEvent("x_fixture", Dialect.PgSql, "estimated", plan.Root, plan.Raw, plan.RawFormat, plan.Warnings) { Ts = "2026-10-14T10:00:00.000Z" });
    }

    [Fact]
    public void Actual_RuntimeCountersAndBuffers()
    {
        var plan = PgPlanReader.Parse(Load("actual.json"), actual: true);
        Assert.Equal("Sort", plan.Root.Op);
        Assert.Equal(3, plan.Root.ActualRows);
        Assert.Equal("0.088", plan.Root.Props!["Planning Time (ms)"]);
        Assert.Equal("0.054", plan.Root.Props!["Execution Time (ms)"]);
        Assert.Equal("customers.id", plan.Root.Props!["Sort Key"]);
        Assert.Equal("4", plan.Root.Props!["Shared Hit Blocks"]);
        var scan = Assert.Single(plan.Root.Children);
        Assert.Equal("public.customers", scan.Object);
        Assert.Equal("2", scan.Props!["Rows Removed by Filter"]);
        var withWarning = plan with { Warnings = [.. plan.Warnings, PgPlanReader.RanTwiceWarning] };
        Golden.MatchUiFixture("plans/pgsql-actual.json", new ExecPlanEvent("x_fixture", Dialect.PgSql, "actual", withWarning.Root, withWarning.Raw, withWarning.RawFormat, withWarning.Warnings) { Ts = "2026-10-14T10:00:00.000Z" });
    }

    [Fact]
    public void Warnings_SeqScanFilterSpillWorkersJit()
    {
        var plan = PgPlanReader.Parse(Load("warnings.json"), actual: true);
        var all = plan.Root.DescendantsAndSelf().SelectMany(n => n.Warnings).ToList();
        Assert.Contains(all, w => w.StartsWith("Sequential scan of public.big_orders", StringComparison.Ordinal));
        Assert.Contains(all, w => w.StartsWith("Filter discards most rows", StringComparison.Ordinal));
        Assert.Contains("Sort spilled to disk", all);
        Assert.Contains(all, w => w.StartsWith("Only 1 of 2 parallel workers", StringComparison.Ordinal));
        Assert.Contains(all, w => w.StartsWith("Row estimate off", StringComparison.Ordinal));
        Assert.Contains(plan.Warnings, w => w.StartsWith("JIT", StringComparison.Ordinal));
        Assert.Equal("Aggregate (Sorted) (Finalize)", plan.Root.Op);
        Assert.Contains("trg_orders_check", plan.Root.Props!["Triggers"]);
        Assert.Equal(100, plan.Root.Children[0].Children[0].ActualRows / 2);
    }

    [Fact]
    public void Script_EstimatedActualAndGenericPlan()
    {
        var reader = new PgPlanReader();
        var est = reader.CreateScript(new ExplainInput("x", "SELECT * FROM t WHERE id = :id;", ExplainModes.Estimated, Line: 5, ServerVersion: "17.2"));
        var b = Assert.Single(est.Batches);
        Assert.Equal("EXPLAIN (FORMAT JSON, VERBOSE true, COSTS true, GENERIC_PLAN true)\nSELECT * FROM t WHERE id = $1", b.Sql);
        Assert.True(b.CaptureAll);
        Assert.Equal(4, b.Line);
        Assert.Empty(PgParams(b.Sql)); // GENERIC_PLAN leaves $1 unbound

        var old = reader.CreateScript(new ExplainInput("x", "SELECT * FROM t WHERE id = :id", ExplainModes.Estimated, ServerVersion: "15.6"));
        Assert.Equal(["id"], old.Params!.Select(p => p.Name));
        Assert.Equal(ParamKinds.Null, old.Params![0].Kind);

        var act = reader.CreateScript(new ExplainInput("x", "SELECT 1", ExplainModes.Actual, Line: 3));
        Assert.Equal(2, act.Batches.Count);
        Assert.True(act.Batches[0].Visible);
        Assert.StartsWith("EXPLAIN (ANALYZE true, BUFFERS true", act.Batches[1].Sql);
        var dml = reader.CreateScript(new ExplainInput("x", "DELETE FROM t", ExplainModes.Actual));
        Assert.Single(dml.Batches);
        Assert.False(PgPlanReader.DeliversRows("SELECT * FROM t FOR UPDATE"));
    }

    private static IReadOnlyList<PgPlaceholder> PgParams(string sql) => PgSqlText.Placeholders(sql);
}

/// <summary>Live PostgreSQL: params, describe, explain, designer round trip (skipped without Docker).</summary>
public sealed partial class PgM15ConformanceTests(PgFixture fixture) : M15ConformanceTests<PgFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new PgDdlScripter();
    protected override IDesignerDatabase Database { get; } = new PgDesignerDatabase();
    protected override IPlanReader PlanReader { get; } = new PgPlanReader();

    protected override string IntType => "integer";
    protected override string TextType(int n) => $"varchar({n})";
    protected override string MoneyType => "numeric(12,2)";
    protected override string DateType => "date";

    /// <summary>The server stores casts in defaults and checks (<c>(0)::numeric</c>, <c>'x'::text</c>): compare without them.</summary>
    protected override TableModel Normalize(TableModel t, DdlScriptContext context) => t with
    {
        PrimaryKey = t.PrimaryKey is null ? null : t.PrimaryKey with { Clustered = false },
        Indexes = t.Indexes.Select(i => i with { Clustered = false }).ToList(),
        Columns = t.Columns.Select(c => c with { Default = StripCasts(c.Default), Comment = c.Comment }).ToList(),
        Checks = t.Checks.Select(c => c with { Expression = StripCasts(c.Expression)! }).ToList(),
        Options = t.Options with { Tablespace = null },
    };

    private static string? StripCasts(string? expr) => expr is null ? null : Casts().Replace(expr, "");

    [GeneratedRegex(@"::[a-z_]+(\s+varying|\s+precision)?(\([0-9, ]+\))?(\[\])?", RegexOptions.IgnoreCase)]
    private static partial Regex Casts();
}
