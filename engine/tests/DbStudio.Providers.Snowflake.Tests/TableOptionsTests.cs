using DbStudio.Core.Designer;
using DbStudio.Providers.Snowflake.Designer;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>R3-9: TRANSIENT, DATA_RETENTION_TIME_IN_DAYS and CHANGE_TRACKING travel in <c>TableOptions.Extra</c>.</summary>
public sealed class TableOptionsTests
{
    private static readonly SnowflakeDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("9.33.1", "PUBLIC");

    private static TableModel Table(Dictionary<string, string>? extra) => new()
    {
        Schema = "PUBLIC",
        Name = "EVENTS",
        Options = new TableOptions { Extra = extra },
        Columns = [new() { Id = "ID", Name = "ID", Type = "NUMBER(38,0)", Nullable = false }],
        PrimaryKey = new PrimaryKeyModel { Columns = ["ID"] },
    };

    [Fact]
    public void Create_scripts_transient_retention_and_change_tracking()
    {
        var sql = Assert.Single(Scripter.ScriptTable(null, Table(new() { ["kind"] = "transient", ["retentionDays"] = "1", ["changeTracking"] = "true" }), Context).Statements).Sql;
        Assert.StartsWith("CREATE TRANSIENT TABLE PUBLIC.EVENTS", sql, StringComparison.Ordinal);
        Assert.Contains("DATA_RETENTION_TIME_IN_DAYS = 1", sql);
        Assert.Contains("CHANGE_TRACKING = TRUE", sql);
        Assert.StartsWith("CREATE TABLE ", Assert.Single(Scripter.ScriptTable(null, Table(null), Context).Statements).Sql, StringComparison.Ordinal);
    }

    [Fact]
    public void Alter_sets_and_unsets_the_changeable_options()
    {
        var before = Table(new() { ["retentionDays"] = "1" });
        var s = Scripter.ScriptTable(before, Table(new() { ["retentionDays"] = "7", ["changeTracking"] = "true" }), Context);
        Assert.Contains(s.Statements, x => x.Sql == "ALTER TABLE PUBLIC.EVENTS SET DATA_RETENTION_TIME_IN_DAYS = 7" && x.Warning is not null);
        Assert.Contains(s.Statements, x => x.Sql == "ALTER TABLE PUBLIC.EVENTS SET CHANGE_TRACKING = TRUE");

        var unset = Scripter.ScriptTable(before, Table(null), Context);
        Assert.Equal("ALTER TABLE PUBLIC.EVENTS UNSET DATA_RETENTION_TIME_IN_DAYS", Assert.Single(unset.Statements).Sql);
    }

    [Fact]
    public void Unchanged_options_script_nothing_and_transient_cannot_change()
    {
        Assert.Empty(Scripter.ScriptTable(Table(new() { ["retentionDays"] = "1" }), Table(new() { ["retentionDays"] = " 1 " }), Context).Statements);
        var s = Scripter.ScriptTable(Table(null), Table(new() { ["kind"] = "transient" }), Context);
        Assert.Empty(s.Statements);
        Assert.Contains(s.Warnings, w => w.Contains("transient", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ToExtra_reads_show_tables()
    {
        Assert.Null(SfTableOptions.ToExtra("TABLE", null, "OFF"));
        var x = SfTableOptions.ToExtra("TRANSIENT", "1", "ON")!;
        Assert.Equal("transient", x["kind"]);
        Assert.Equal("1", x["retentionDays"]);
        Assert.Equal("true", x["changeTracking"]);
    }
}
