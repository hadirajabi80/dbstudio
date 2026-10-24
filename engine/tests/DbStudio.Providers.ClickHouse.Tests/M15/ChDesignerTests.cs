using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Providers.ClickHouse.Designer;
using DbStudio.Providers.Conformance.M15;

namespace DbStudio.Providers.ClickHouse.Tests.M15;

/// <summary>Golden DDL of the shared designer cases (DesignerCases with ClickHouse types) and the MergeTree specifics.</summary>
public sealed class ChDesignerTests
{
    private static readonly ChDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("24.8.14.39", "shop");

    public static IEnumerable<object[]> Cases() => DesignerCases.All(Dialect.ClickHouse).Select(c => new object[] { c.Name });

    [Theory]
    [MemberData(nameof(Cases))]
    public void SharedCases_MatchGolden(string name)
    {
        var c = DesignerCases.All(Dialect.ClickHouse).Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, Context);
        Golden.Match($"clickhouse_{name}.sql", Golden.Render(script));
        Assert.False(script.Transactional);
    }

    [Fact]
    public void Create_WithEngineOptions()
    {
        var t = DesignerCases.Orders(Dialect.ClickHouse);
        var script = Scripter.ScriptTable(null, t, Context, null, new ChEngineOptions("ReplacingMergeTree", "(customer_id, id)", "toYYYYMM(order_date)",
            "customer_id", null, "order_date + INTERVAL 1 YEAR", "index_granularity = 4096"));
        Golden.Match("clickhouse_create_engine.sql", Golden.Render(script));
    }

    [Fact]
    public void Alter_EngineOptions_TtlAndSettings()
    {
        var t = DesignerCases.Orders(Dialect.ClickHouse);
        var script = Scripter.ScriptTable(t, t, Context, new ChEngineOptions(Ttl: "order_date + INTERVAL 1 YEAR"),
            new ChEngineOptions(Ttl: "order_date + INTERVAL 2 YEAR", Settings: "ttl_only_drop_parts = 1", PartitionBy: "toYYYYMM(order_date)"));
        Assert.Contains(script.Statements, s => s.Sql.EndsWith("MODIFY TTL order_date + INTERVAL 2 YEAR", StringComparison.Ordinal));
        Assert.Contains(script.Statements, s => s.Sql.EndsWith("MODIFY SETTING ttl_only_drop_parts = 1", StringComparison.Ordinal));
        Assert.Contains(script.Warnings, w => w.Contains("PARTITION BY", StringComparison.Ordinal));
    }

    [Fact]
    public void Nullable_RoundTripsThroughTheType()
    {
        Assert.Equal("Nullable(String)", ChDdlScripter.ComposeType("String", true));
        Assert.Equal("LowCardinality(Nullable(String))", ChDdlScripter.ComposeType("LowCardinality(String)", true));
        Assert.Equal("Array(String)", ChDdlScripter.ComposeType("Array(String)", true));
        Assert.Equal(("LowCardinality(String)", true), ChDdlScripter.DecomposeType("LowCardinality(Nullable(String))"));
        Assert.Equal(("Decimal(12, 2)", false), ChDdlScripter.DecomposeType("Decimal(12, 2)"));
    }

    [Fact]
    public void AppendingAKeyColumn_ModifiesOrderBy_OtherKeyChangesWarn()
    {
        var t = DesignerCases.Orders(Dialect.ClickHouse);
        var added = t with
        {
            Columns = [.. t.Columns, new TableColumnModel { Id = "new_1", Name = "region", Type = "LowCardinality(String)", Nullable = false }],
            PrimaryKey = new PrimaryKeyModel { Columns = ["id", "region"] },
        };
        var ok = Scripter.ScriptTable(t, added, Context);
        Assert.Contains(ok.Statements, s => s.Sql.EndsWith("MODIFY ORDER BY (id, region)", StringComparison.Ordinal));
        var changed = Scripter.ScriptTable(t, t with { PrimaryKey = new PrimaryKeyModel { Columns = ["customer_id"] } }, Context);
        Assert.DoesNotContain(changed.Statements, s => s.Sql.Contains("ORDER BY", StringComparison.Ordinal));
        Assert.Contains(changed.Warnings, w => w.Contains("sorting key", StringComparison.Ordinal));
    }

    [Fact]
    public void View_CreateOrReplace()
    {
        var s = Scripter.ScriptView(new ViewDefinition("shop", "v_orders", "v_old", "SELECT id FROM shop.orders;", new ViewOptions()), Context);
        Golden.Match("clickhouse_view_rename.sql", Golden.Render(s));
    }

    [Fact]
    public void Types_AndFeatures()
    {
        var info = Scripter.GetTypes(Context);
        Assert.Contains(info.Types, t => t.Name == "LowCardinality(String)");
        Assert.False(info.Features.TransactionalDdl);
        Assert.False(info.Features.Identity);
        Assert.True(info.Features.Computed);
    }
}
