using DbStudio.Core.Sql;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>PostgreSQL lexing, statement splitting, placeholder rewrite, position mapping and classification (no server).</summary>
public sealed class PgSqlTextTests
{
    private static List<(SqlTokenKind Kind, string Value)> Lex(string sql) => PgSqlText.Tokenize(sql).Select(t => (t.Kind, t.Value)).ToList();

    [Theory]
    [InlineData("E'it''s\\n'")]
    [InlineData("E'a\\'b'")]
    [InlineData("U&'d\\0061t'")]
    [InlineData("B'101'")]
    [InlineData("X'1F'")]
    [InlineData("$$ a; 'b' $$")]
    [InlineData("$tag$ ... $$ ... $tag$")]
    [InlineData("'it''s'")]
    public void Strings_AreSingleTokens(string sql)
    {
        var t = Assert.Single(PgSqlText.Tokenize(sql));
        Assert.Equal(SqlTokenKind.String, t.Kind);
        Assert.Equal(sql, t.Value);
    }

    [Fact]
    public void NestedComments_AreSkipped()
    {
        Assert.Equal([(SqlTokenKind.Word, "SELECT"), (SqlTokenKind.Number, "1")], Lex("SELECT /* a /* b */ c */ 1 -- x"));
    }

    [Fact]
    public void Operators_CastsAndParameters()
    {
        Assert.Equal([(SqlTokenKind.Word, "a"), (SqlTokenKind.Operator, "::"), (SqlTokenKind.Word, "text")], Lex("a::text"));
        Assert.Equal([(SqlTokenKind.Word, "x"), (SqlTokenKind.Operator, "@>"), (SqlTokenKind.String, "'{}'")], Lex("x @> '{}'"));
        Assert.Equal([(SqlTokenKind.Word, "m"), (SqlTokenKind.Operator, "?"), (SqlTokenKind.String, "'k'")], Lex("m ? 'k'"));
        Assert.Equal([(SqlTokenKind.Word, "m"), (SqlTokenKind.Operator, "?|"), (SqlTokenKind.Word, "a")], Lex("m ?| a"));
        Assert.Equal([(SqlTokenKind.Word, "m"), (SqlTokenKind.Operator, "->>"), (SqlTokenKind.String, "'k'")], Lex("m->>'k'"));
        // = followed by - is two operators (PostgreSQL rule: no trailing - without a special char)
        Assert.Equal([(SqlTokenKind.Word, "a"), (SqlTokenKind.Operator, "="), (SqlTokenKind.Operator, "-"), (SqlTokenKind.Number, "1")], Lex("a=-1"));
        Assert.Equal([(SqlTokenKind.Parameter, "$1"), (SqlTokenKind.Parameter, ":id"), (SqlTokenKind.Parameter, "@p")],
            Lex("$1 :id @p").ToList());
    }

    [Fact]
    public void ArraySlices_AreNotParameters_AndBracketsArePunctuation()
    {
        var tokens = Lex("arr[1:3], arr[lo:hi]");
        Assert.DoesNotContain(tokens, t => t.Kind == SqlTokenKind.Parameter);
        Assert.Contains((SqlTokenKind.Punct, "["), tokens);
        Assert.DoesNotContain(tokens, t => t.Kind == SqlTokenKind.QuotedIdentifier);
    }

    [Fact]
    public void Numbers_HexAndUnderscores()
    {
        Assert.Equal([(SqlTokenKind.Number, "1_000"), (SqlTokenKind.Punct, ","), (SqlTokenKind.Number, "0x1F"), (SqlTokenKind.Punct, ","), (SqlTokenKind.Number, "1.5e-3")],
            Lex("1_000, 0x1F, 1.5e-3"));
    }

    [Fact]
    public void QuotedIdentifiers_KeepCase()
    {
        var t = Assert.Single(PgSqlText.Tokenize("\"Mixed\"\"Case\""));
        Assert.Equal((SqlTokenKind.QuotedIdentifier, "Mixed\"Case"), (t.Kind, t.Value));
        Assert.Equal(SqlTokenKind.QuotedIdentifier, Assert.Single(PgSqlText.Tokenize("U&\"d\\0061t\"")).Kind);
    }

    [Fact]
    public void Split_KeepsDollarBodiesAndAtomicBodiesWhole()
    {
        const string sql = "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  PERFORM 1; RETURN 1;\nEND\n$$;\n" +
                           "DO $x$ BEGIN RAISE NOTICE 'a;b'; END $x$;\nSELECT 1;\n" +
                           "CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 2 END; END;\nSELECT 2";
        var statements = PgSqlText.Split(sql);
        Assert.Equal(5, statements.Count);
        Assert.StartsWith("CREATE FUNCTION f()", statements[0].Text(sql));
        Assert.EndsWith("$$", statements[0].Text(sql));
        Assert.StartsWith("DO $x$", statements[1].Text(sql));
        Assert.Equal("SELECT 1", statements[2].Text(sql));
        Assert.EndsWith("END", statements[3].Text(sql));
        Assert.Equal("SELECT 2", statements[4].Text(sql));
    }

    [Fact]
    public void Placeholders_NeverQuestionMark_SkipPrepareAndStrings()
    {
        const string sql = "SELECT $1, :id, @p FROM orders WHERE id = $2 AND meta ? 'k' AND note = ':nope' AND a::int = 1 AND b @> '{}'";
        Assert.Equal(["1", "id", "p", "2"], PgSqlText.Placeholders(sql).Select(p => p.Name));
        Assert.Empty(PgSqlText.Placeholders("PREPARE q AS SELECT $1"));
        Assert.Empty(PgSqlText.Placeholders("CREATE FUNCTION f(int) RETURNS int AS 'SELECT $1' LANGUAGE sql"));
        Assert.Empty(PgSqlText.Placeholders("EXPLAIN (FORMAT JSON, GENERIC_PLAN true) SELECT $1"));
    }

    [Fact]
    public void Rewrite_AssignsPositionalSlots()
    {
        var r = PgSqlText.Rewrite("SELECT :a, $1, @b, :A, $3");
        // $1 and $3 are taken: a → $2, b → $4; :A is the same parameter as :a.
        Assert.Equal("SELECT $2, $1, $4, $2, $3", r.Text);
        Assert.Equal([(1, "1"), (2, "a"), (3, "3"), (4, "b")], r.Slots.Select(s => (s.Index, s.Name)));
        Assert.Equal(4, r.MaxIndex);
        Assert.Equal("SELECT 1", PgSqlText.Rewrite("SELECT 1").Text);
    }

    [Fact]
    public void MapPosition_MapsBackThroughTheRewrite()
    {
        const string original = "SELECT * FROM t WHERE id = :customer_id AND nmae = 1";
        var sent = PgSqlText.Rewrite(original).Text; // ... id = $1 AND nmae = 1
        var pos = sent.IndexOf("nmae", StringComparison.Ordinal) + 1;
        Assert.Equal(original.IndexOf("nmae", StringComparison.Ordinal), PgSqlText.MapPosition(sent, original, pos));
        // Inside the placeholder itself: clamped to the original token.
        var ph = sent.IndexOf("$1", StringComparison.Ordinal) + 2;
        Assert.Equal(original.IndexOf(":customer_id", StringComparison.Ordinal) + 1, PgSqlText.MapPosition(sent, original, ph));
        // Position 1 and out of range.
        Assert.Equal(0, PgSqlText.MapPosition(sent, original, 1));
        Assert.Equal(original.Length, PgSqlText.MapPosition(sent, original, 10_000));
        // Repeated named placeholder, then a string.
        const string o2 = "SELECT @a, @a, 'x' || bad";
        var s2 = PgSqlText.Rewrite(o2).Text;
        Assert.Equal(o2.IndexOf("bad", StringComparison.Ordinal), PgSqlText.MapPosition(s2, o2, s2.IndexOf("bad", StringComparison.Ordinal) + 1));
    }

    [Theory]
    [InlineData("BEGIN", StatementCategory.Transaction, "BEGIN")]
    [InlineData("START TRANSACTION", StatementCategory.Transaction, "BEGIN")]
    [InlineData("END", StatementCategory.Transaction, "COMMIT")]
    [InlineData("ABORT", StatementCategory.Transaction, "ROLLBACK")]
    [InlineData("DO $$ BEGIN INSERT INTO t VALUES (1); END $$", StatementCategory.Block, "DO")]
    [InlineData("COPY t TO '/tmp/x'", StatementCategory.Dml, "COPY")]
    [InlineData("TABLE countries", StatementCategory.Query, "TABLE")]
    [InlineData("SHOW search_path", StatementCategory.Session, "SHOW")]
    [InlineData("SELECT 1 INTO newtable", StatementCategory.Ddl, "SELECT INTO")]
    [InlineData("SELECT meta ? 'k' FROM t", StatementCategory.Query, "SELECT")]
    [InlineData("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", StatementCategory.Query, "SELECT")]
    [InlineData("CALL p(1)", StatementCategory.Other, "CALL")]
    public void Classify_PostgreSqlHeads(string sql, StatementCategory category, string kind)
    {
        var s = Assert.Single(PgSqlText.Classify(sql).Statements);
        Assert.Equal((category, kind), (s.Category, s.Kind));
    }

    [Fact]
    public void Classify_DollarBodiesDoNotLeakStatements()
    {
        var c = PgSqlText.Classify("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; COMMIT; END $$");
        var s = Assert.Single(c.Statements);
        Assert.Equal(StatementCategory.Ddl, s.Category);
        Assert.True(PgSqlText.Classify("SELECT * FROM t WHERE a = 'DELETE'; SELECT $$UPDATE$$").IsQueryOnly);
        Assert.False(PgSqlText.Classify("SELECT * FROM t FOR UPDATE").IsQueryOnly);
        Assert.False(PgSqlText.Classify("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x").IsQueryOnly);
        Assert.True(PgSqlText.Classify("BEGIN").IsQueryOnly); // transaction control runs outside the engine transaction
    }

    [Theory]
    [InlineData("customers", "customers")]
    [InlineData("Customers", "\"Customers\"")]
    [InlineData("order", "\"order\"")]
    [InlineData("left", "\"left\"")]
    [InlineData("a b", "\"a b\"")]
    [InlineData("we\"ird", "\"we\"\"ird\"")]
    [InlineData("_x$1", "_x$1")]
    public void Quote_OnlyWhenNeeded(string name, string expected) => Assert.Equal(expected, PgSqlText.Quote(name));

    [Fact]
    public void Mask_PreservesOffsets()
    {
        const string sql = "SELECT E'a\\'b', $$x;y$$, m ? 'k', arr[1] /* c */ FROM t";
        var masked = PgSqlText.Mask(sql);
        Assert.Equal(sql.Length, masked.Length);
        Assert.DoesNotContain("?", masked);
        Assert.DoesNotContain("/*", masked);
        Assert.Single(SqlTokenizer.SplitStatements(SqlTokenizer.Tokenize(masked, DbStudio.Core.Models.Dialect.Sqlite), DbStudio.Core.Models.Dialect.Sqlite));
    }

    [Fact]
    public void Session_RenumbersGlobalPlaceholdersPerStatement()
    {
        var (text, order) = PgSession.Renumber("SELECT $3 + $1 + $3");
        Assert.Equal("SELECT $1 + $2 + $1", text);
        Assert.Equal([3, 1], order);
        Assert.True(PgSession.EndsTransaction("UPDATE t SET a = 1; COMMIT"));
        Assert.True(PgSession.EndsTransaction("END"));
        Assert.False(PgSession.EndsTransaction("ROLLBACK TO SAVEPOINT s"));
        Assert.False(PgSession.EndsTransaction("COMMIT PREPARED 'x'"));
    }
}
