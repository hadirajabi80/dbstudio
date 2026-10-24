using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Tests.Batch3;

/// <summary>CQL in the shared Core: <c>$$</c> bodies and <c>//</c> comments in the tokenizer, CQL literals in SQL INSERT exports.</summary>
public class CqlCoreTests
{
    [Fact]
    public void Dollar_bodies_stay_whole_and_slash_comments_are_not_code()
    {
        var sql = "CREATE FUNCTION f(a int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ return a; $$; // DROP TABLE t\nSELECT * FROM t";
        var c = StatementClassifier.Classify(sql, Dialect.Cql);
        Assert.Equal(2, c.Statements.Count);
        Assert.DoesNotContain(c.Statements, s => s.IsDestructive);
    }

    [Fact]
    public void Slash_slash_is_a_comment_only_for_cql()
    {
        Assert.DoesNotContain(SqlTokenizer.Tokenize("SELECT 1 // x", Dialect.Cql), t => t.Value == "x");
        Assert.Contains(SqlTokenizer.Tokenize("SELECT 1 // x", Dialect.PgSql), t => t.Value == "x");
    }

    private static ColumnInfo Col(string dbType, string kind) => new("c", 0, dbType, kind, true);

    [Fact]
    public void Insert_export_writes_cql_literals()
    {
        var w = new SqlInsertResultWriter(Stream.Null, new ExportOptions(), Dialect.Cql);
        Assert.Equal("['a', 'it''s']", w.Literal("[\"a\",\"it's\"]", Col("list<text>", ColumnKinds.Json)));
        Assert.Equal("{1, 2}", w.Literal("[1,2]", Col("set<int>", ColumnKinds.Json)));
        Assert.Equal("{'k': 1}", w.Literal("{\"k\":1}", Col("map<text, int>", ColumnKinds.Json)));
        Assert.Equal("{1: 'x'}", w.Literal("{\"1\":\"x\"}", Col("map<int, text>", ColumnKinds.Json)));
        Assert.Equal("{street: 'Main', zip: 12}", w.Literal("{\"street\":\"Main\",\"zip\":12}", Col("frozen<address>", ColumnKinds.Json)));
        Assert.Equal("[11111111-1111-1111-1111-111111111111]", w.Literal("[\"11111111-1111-1111-1111-111111111111\"]", Col("list<uuid>", ColumnKinds.Json)));
        Assert.Equal("(1, 'a', true)", w.Literal("[1,\"a\",true]", Col("tuple<int, text, boolean>", ColumnKinds.Json)));
        Assert.Equal("11111111-1111-1111-1111-111111111111", w.Literal("11111111-1111-1111-1111-111111111111", Col("uuid", ColumnKinds.Guid)));
    }

    [Fact]
    public void Other_dialects_keep_json_as_a_string()
    {
        var w = new SqlInsertResultWriter(Stream.Null, new ExportOptions(), Dialect.PgSql);
        Assert.Equal("'[1,2]'", w.Literal("[1,2]", Col("jsonb", ColumnKinds.Json)));
    }
}
