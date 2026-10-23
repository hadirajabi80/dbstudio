using System.Text.Json;
using DbStudio.Core.Export;
using DbStudio.Core.Models;
using DbStudio.Core.Search;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Tests.Batch3;

/// <summary>
/// plan-batch3 WP0: the four Batch 3 dialects and the "search" source kind are known end to end (wire tokens, traits,
/// tokenizer, classifier hooks, export literals, search SQL) while the original four dialects behave as before.
/// </summary>
public sealed class Batch3FoundationTests
{
    [Theory]
    [InlineData(Dialect.TSql, "tsql")]
    [InlineData(Dialect.PlSql, "plsql")]
    [InlineData(Dialect.Sqlite, "sqlite")]
    [InlineData(Dialect.PgSql, "pgsql")]
    [InlineData(Dialect.MySql, "mysql")]
    [InlineData(Dialect.ClickHouse, "clickhouse")]
    [InlineData(Dialect.Snowflake, "snowflake")]
    [InlineData(Dialect.Cql, "cql")]
    public void Dialect_wire_tokens_round_trip(Dialect d, string wire)
    {
        Assert.Equal(wire, CoreJson.ToWire(d));
        Assert.Equal(d, CoreJson.ParseDialect(wire));
        var json = JsonSerializer.Serialize(d, CoreJson.Options);
        Assert.Equal($"\"{wire}\"", json);
        Assert.Equal(d, JsonSerializer.Deserialize<Dialect>(json, CoreJson.Options));
    }

    [Fact]
    public void Search_source_kind_round_trips()
    {
        Assert.Equal("search", CoreJson.ToWire(SourceKind.Search));
        Assert.Equal(SourceKind.Search, CoreJson.ParseSourceKind("search"));
        Assert.Equal("\"search\"", JsonSerializer.Serialize(SourceKind.Search, CoreJson.Options));
    }

    [Fact]
    public void Unknown_dialect_message_lists_all_eight()
    {
        var ex = Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Dialect>("\"db2\"", CoreJson.Options));
        Assert.Contains("mysql, clickhouse, snowflake or cql", ex.Message);
    }

    [Fact]
    public void Dialect_traits()
    {
        Assert.True(DialectInfo.HasDatabases(Dialect.Snowflake));
        Assert.False(DialectInfo.HasDatabases(Dialect.MySql));
        Assert.True(DialectInfo.SchemaIsDatabase(Dialect.PlSql));
        Assert.True(DialectInfo.SchemaIsDatabase(Dialect.Cql));
        Assert.False(DialectInfo.SchemaIsDatabase(Dialect.Snowflake));
        Assert.Equal("PUBLIC", DialectInfo.DefaultSchemaFallback(Dialect.Snowflake));
        Assert.Equal("default", DialectInfo.DefaultSchemaFallback(Dialect.ClickHouse));
        Assert.Equal(('[', ']'), DialectInfo.IdentifierQuote(Dialect.TSql));
        Assert.Equal(('"', '"'), DialectInfo.IdentifierQuote(Dialect.Sqlite));
        Assert.Equal(('`', '`'), DialectInfo.IdentifierQuote(Dialect.MySql));
        Assert.Equal(('"', '"'), DialectInfo.IdentifierQuote(Dialect.Snowflake));
        Assert.Equal("`a``b`", DialectInfo.QuoteIdentifier(Dialect.ClickHouse, "a`b"));
    }

    [Fact]
    public void Tokenizer_hash_comments_only_where_the_dialect_has_them()
    {
        var my = SqlTokenizer.Tokenize("SELECT 1 # note\nFROM t", Dialect.MySql);
        Assert.DoesNotContain(my, t => t.Value.Contains("note"));
        Assert.Contains(my, t => t.IsWord("FROM"));
        // T-SQL: #temp is a word, not a comment
        var ts = SqlTokenizer.Tokenize("SELECT * FROM #temp", Dialect.TSql);
        Assert.Contains(ts, t => t.Kind == SqlTokenKind.Word && t.Value == "#temp");
    }

    [Fact]
    public void Tokenizer_backslash_escapes_and_backticks()
    {
        var my = SqlTokenizer.Tokenize("SELECT 'it\\'s' AS `my col`; SELECT 2", Dialect.MySql);
        Assert.Equal("'it\\'s'", Assert.Single(my, t => t.Kind == SqlTokenKind.String).Value);
        Assert.Equal("my col", Assert.Single(my, t => t.Kind == SqlTokenKind.QuotedIdentifier).Value);
        Assert.Equal(2, SqlTokenizer.SplitStatements(my, Dialect.MySql).Count);
        // PostgreSQL keeps standard strings: the backslash is an ordinary character
        var pg = SqlTokenizer.Tokenize("SELECT 'a\\' , 'b'", Dialect.PgSql);
        Assert.Equal(2, pg.Count(t => t.Kind == SqlTokenKind.String));
    }

    [Fact]
    public void Tokenizer_dollar_quotes_for_snowflake_not_for_mysql()
    {
        var sf = SqlTokenizer.Tokenize("CREATE PROCEDURE p() RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END $$; SELECT 1", Dialect.Snowflake);
        Assert.Contains(sf, t => t.Kind == SqlTokenKind.String && t.Value.StartsWith("$$", StringComparison.Ordinal));
        Assert.Equal(2, SqlTokenizer.SplitStatements(sf, Dialect.Snowflake).Count);
    }

    [Fact]
    public void Cql_batch_is_one_statement()
    {
        var c = StatementClassifier.Classify("BEGIN BATCH INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (2); APPLY BATCH; SELECT * FROM t", Dialect.Cql);
        Assert.Equal(2, c.Statements.Count);
    }

    [Fact]
    public void Snowflake_three_part_names_have_a_database()
    {
        var c = Assert.Single(StatementClassifier.Classify("CREATE TABLE SHOP.PUBLIC.T (ID INT)", Dialect.Snowflake).Statements);
        Assert.Equal("SHOP", c.Ddl!.Database);
        Assert.Equal("PUBLIC", c.Ddl.Schema);
        Assert.Equal("T", c.Ddl.Name);
    }

    [Theory]
    [InlineData(Dialect.TSql, "0xABCD")]
    [InlineData(Dialect.PlSql, "HEXTORAW('ABCD')")]
    [InlineData(Dialect.Sqlite, "X'ABCD'")]
    [InlineData(Dialect.PgSql, "X'ABCD'")]
    [InlineData(Dialect.MySql, "0xABCD")]
    [InlineData(Dialect.ClickHouse, "unhex('ABCD')")]
    [InlineData(Dialect.Snowflake, "TO_BINARY('ABCD', 'HEX')")]
    [InlineData(Dialect.Cql, "0xABCD")]
    public void Sql_insert_binary_literals(Dialect d, string expected)
    {
        var w = new SqlInsertResultWriter(Stream.Null, new ExportOptions(), d);
        Assert.Equal(expected, w.Literal(new BinaryValue([0xAB, 0xCD]), null));
    }

    [Fact]
    public void Sql_insert_strings_double_backslashes_where_they_escape()
    {
        Assert.Equal("'a\\\\b'", new SqlInsertResultWriter(Stream.Null, new ExportOptions(), Dialect.MySql).Literal("a\\b", null));
        Assert.Equal("'a\\b'", new SqlInsertResultWriter(Stream.Null, new ExportOptions(), Dialect.PgSql).Literal("a\\b", null));
    }

    [Fact]
    public void Search_sql_has_a_value_for_every_dialect()
    {
        foreach (var d in Enum.GetValues<Dialect>())
        {
            Assert.False(string.IsNullOrEmpty(SearchSql.Param(d, "p")));
            Assert.False(string.IsNullOrEmpty(SearchSql.Quote(d, "x")));
        }
        Assert.Equal("`a`", SearchSql.Quote(Dialect.MySql, "a"));
        Assert.Equal("{p:String}", SearchSql.Param(Dialect.ClickHouse, "p"));
        Assert.Equal("%50\\%%", SearchSql.LikePattern(Dialect.ClickHouse, "50%"));
        Assert.Equal("%50!%%", SearchSql.LikePattern(Dialect.PgSql, "50%"));
        Assert.Null(SearchSql.TextExpression(Dialect.Cql, "\"c\"", "text"));
    }
}
