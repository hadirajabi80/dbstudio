using DbStudio.Core.Designer;
using DbStudio.Providers.ClickHouse.Designer;

namespace DbStudio.Providers.ClickHouse.Tests;

/// <summary>R3-1: the MergeTree clauses travel in <c>TableOptions.Extra</c> (designer model ↔ scripter ↔ system.tables).</summary>
public sealed class ChEngineExtraTests
{
    private static TableModel Table(Dictionary<string, string>? extra, string name = "events") => new()
    {
        Schema = "shop",
        Name = name,
        Options = new TableOptions { Extra = extra },
        Columns = [new TableColumnModel { Id = "id", Name = "id", Type = "UInt64", Nullable = false }, new TableColumnModel { Id = "d", Name = "d", Type = "Date", Nullable = false }],
        PrimaryKey = new PrimaryKeyModel { Columns = ["id"] },
    };

    private static readonly DdlScriptContext Ctx = new("24.8", "shop");

    [Fact]
    public void From_ReadsEveryKey_AndIsNullWithoutExtra()
    {
        Assert.Null(ChEngineOptions.From(Table(null)));
        var o = ChEngineOptions.From(Table(new() { ["engine"] = "ReplacingMergeTree", ["orderBy"] = "(id, d)", ["partitionBy"] = "toYYYYMM(d)", ["primaryKey"] = "id", ["sampleBy"] = "id", ["ttl"] = "d + INTERVAL 1 YEAR", ["settings"] = "index_granularity = 4096" }))!;
        Assert.Equal("ReplacingMergeTree", o.Engine);
        Assert.Equal("(id, d)", o.OrderBy);
        Assert.Equal("toYYYYMM(d)", o.PartitionBy);
        Assert.Equal("id", o.PrimaryKey);
        Assert.Equal("id", o.SampleBy);
        Assert.Equal("d + INTERVAL 1 YEAR", o.Ttl);
        Assert.Equal("index_granularity = 4096", o.Settings);
    }

    [Fact]
    public void CreateTable_UsesTheOptionsOfTheModel()
    {
        var sql = Assert.Single(new ChDdlScripter().ScriptTable(null, Table(new() { ["engine"] = "ReplacingMergeTree", ["partitionBy"] = "toYYYYMM(d)", ["ttl"] = "d + INTERVAL 1 YEAR" }), Ctx).Statements).Sql;
        Assert.Contains("ENGINE = ReplacingMergeTree", sql);
        Assert.Contains("PARTITION BY toYYYYMM(d)", sql);
        Assert.Contains("TTL d + INTERVAL 1 YEAR", sql);
        Assert.Contains("ORDER BY id", sql);
    }

    [Fact]
    public void Alter_ChangedTtlAndSettings_ScriptModifyStatements_UnchangedOptionsNothing()
    {
        var before = new Dictionary<string, string> { ["engine"] = "MergeTree", ["orderBy"] = "id", ["ttl"] = "d + INTERVAL 1 YEAR" };
        var same = new ChDdlScripter().ScriptTable(Table(before), Table(new(before)), Ctx);
        Assert.Empty(same.Statements);

        var after = new Dictionary<string, string> { ["engine"] = "MergeTree", ["orderBy"] = "id", ["ttl"] = "d + INTERVAL 2 YEAR", ["settings"] = "index_granularity = 4096" };
        var script = new ChDdlScripter().ScriptTable(Table(before), Table(after), Ctx);
        Assert.Contains(script.Statements, s => s.Sql.EndsWith("MODIFY TTL d + INTERVAL 2 YEAR", StringComparison.Ordinal));
        Assert.Contains(script.Statements, s => s.Sql.EndsWith("MODIFY SETTING index_granularity = 4096", StringComparison.Ordinal));
    }

    [Fact]
    public void Diff_SeesAChangedExtra_IgnoringBlanks()
    {
        Assert.True(TableDiff.SameExtra(null, new() { ["ttl"] = " " }));
        Assert.True(TableDiff.SameExtra(new() { ["Engine"] = "MergeTree" }, new() { ["engine"] = "MergeTree" }));
        Assert.False(TableDiff.SameExtra(new() { ["ttl"] = "a" }, new() { ["ttl"] = "b" }));
    }

    [Fact]
    public void EngineExtra_ParsesSystemTablesColumns()
    {
        var x = ChDesignerDatabase.EngineExtra("MergeTree", "id, d", "id", "toYYYYMM(d)", "",
            "MergeTree PARTITION BY toYYYYMM(d) ORDER BY (id, d) PRIMARY KEY id TTL d + toIntervalYear(1) SETTINGS index_granularity = 8192");
        Assert.Equal("MergeTree", x["engine"]);
        Assert.Equal("id, d", x["orderBy"]);
        Assert.Equal("id", x["primaryKey"]);
        Assert.Equal("toYYYYMM(d)", x["partitionBy"]);
        Assert.Equal("d + toIntervalYear(1)", x["ttl"]);
        Assert.Equal("index_granularity = 8192", x["settings"]);
        Assert.False(x.ContainsKey("sampleBy"));

        var plain = ChDesignerDatabase.EngineExtra("Memory", "", "", "", "", "Memory");
        Assert.Equal(["engine"], plain.Keys);
        var samePk = ChDesignerDatabase.EngineExtra("MergeTree", "id", "id", "", "", "MergeTree ORDER BY id");
        Assert.False(samePk.ContainsKey("primaryKey"));
    }
}
