using DbStudio.Providers.ClickHouse.Designer;

namespace DbStudio.Providers.ClickHouse.Tests;

public sealed class ChDesignerApplyTests
{
    [Theory]
    [InlineData("CREATE TABLE t (a Int32)", "CREATE TABLE t (a Int32) ENGINE = MergeTree ORDER BY tuple()")]
    [InlineData("CREATE TABLE t (a Int32) ENGINE = Memory", "CREATE TABLE t (a Int32) ENGINE = Memory")]
    [InlineData("CREATE TABLE t AS s", "CREATE TABLE t AS s")]
    [InlineData("ALTER TABLE t ADD COLUMN c UInt8", "ALTER TABLE t ADD COLUMN c UInt8")]
    public void BareCreateTable_GetsADefaultEngine(string sql, string expected) =>
        Assert.Equal(expected, ChDesignerDatabase.WithDefaultEngine(sql));
}
