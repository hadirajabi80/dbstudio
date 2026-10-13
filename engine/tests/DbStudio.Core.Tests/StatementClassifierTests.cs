using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Tests;

public class StatementClassifierTests
{
    private static StatementClassification One(string sql, Dialect d = Dialect.TSql) =>
        Assert.Single(StatementClassifier.Classify(sql, d).Statements);

    [Theory]
    [InlineData("SELECT * FROM t", StatementCategory.Query, "SELECT")]
    [InlineData("  -- comment\n/* block */ select 1", StatementCategory.Query, "SELECT")]
    [InlineData("(SELECT 1) UNION (SELECT 2)", StatementCategory.Query, "SELECT")]
    [InlineData("WITH c AS (SELECT 1 AS x) SELECT * FROM c", StatementCategory.Query, "SELECT")]
    [InlineData("WITH c AS (SELECT 1 AS x) DELETE FROM t WHERE id IN (SELECT x FROM c)", StatementCategory.Dml, "DELETE")]
    [InlineData("INSERT INTO t VALUES (1)", StatementCategory.Dml, "INSERT")]
    [InlineData("update t set x = 1 where id = 2", StatementCategory.Dml, "UPDATE")]
    [InlineData("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE", StatementCategory.Dml, "MERGE")]
    [InlineData("CREATE TABLE dbo.T (id int)", StatementCategory.Ddl, "CREATE TABLE")]
    [InlineData("DROP VIEW IF EXISTS v", StatementCategory.Ddl, "DROP VIEW")]
    [InlineData("TRUNCATE TABLE t", StatementCategory.Ddl, "TRUNCATE TABLE")]
    [InlineData("BEGIN TRAN", StatementCategory.Transaction, "BEGIN TRANSACTION")]
    [InlineData("COMMIT", StatementCategory.Transaction, "COMMIT")]
    [InlineData("SET NOCOUNT ON", StatementCategory.Session, "SET")]
    [InlineData("USE master", StatementCategory.Session, "USE")]
    [InlineData("DECLARE @x int = 1", StatementCategory.Session, "DECLARE")]
    [InlineData("EXEC dbo.GetCustomer @Id = 1", StatementCategory.Other, "EXEC")]
    [InlineData("IF 1 = 1 SELECT 1", StatementCategory.Block, "IF")]
    [InlineData("BEGIN SELECT 1 END", StatementCategory.Block, "BEGIN")]
    public void TSql(string sql, StatementCategory category, string kind)
    {
        var s = One(sql);
        Assert.Equal(category, s.Category);
        Assert.Equal(kind, s.Kind);
    }

    [Theory]
    [InlineData("SELECT * FROM t", true)]
    [InlineData("SELECT REPLACE(name, 'a', 'b') FROM t", true)]
    [InlineData("SELECT 'DELETE FROM t' AS text", true)]
    [InlineData("SELECT [update] FROM t -- delete everything", true)]
    [InlineData("SET NOCOUNT ON; SELECT 1", true)]
    [InlineData("DECLARE @n int; SELECT @n = COUNT(*) FROM t", true)]
    [InlineData("SELECT 1 DELETE FROM t", false)]
    [InlineData("SELECT * INTO newtable FROM t", false)]
    [InlineData("SELECT @x = 1", true)]
    [InlineData("EXEC sp_who", false)]
    [InlineData("UPDATE t SET x = 1", false)]
    [InlineData("WITH c AS (SELECT 1 AS x) INSERT INTO t SELECT x FROM c", false)]
    public void IsQueryOnly_TSql(string sql, bool expected) => Assert.Equal(expected, StatementClassifier.IsQueryOnly(sql, Dialect.TSql));

    [Theory]
    [InlineData("SELECT * FROM t", true)]
    [InlineData("PRAGMA table_info(t)", true)]
    [InlineData("PRAGMA user_version", true)]
    [InlineData("PRAGMA user_version = 3", false)]
    [InlineData("PRAGMA journal_mode(WAL)", false)]
    [InlineData("EXPLAIN QUERY PLAN SELECT * FROM t", true)]
    [InlineData("REPLACE INTO t VALUES (1)", false)]
    [InlineData("ATTACH 'x.db' AS x", false)]
    [InlineData("VACUUM", false)]
    [InlineData("SELECT replace(name, 'a', 'b') FROM t", true)]
    public void IsQueryOnly_Sqlite(string sql, bool expected) => Assert.Equal(expected, StatementClassifier.IsQueryOnly(sql, Dialect.Sqlite));

    [Theory]
    [InlineData("SELECT * FROM dual", true)]
    [InlineData("SELECT q'[it's DELETE]' FROM dual", true)]
    [InlineData("SELECT * FROM t FOR UPDATE", false)]
    [InlineData("BEGIN NULL; END;", false)]
    [InlineData("CREATE OR REPLACE VIEW v AS SELECT 1 x FROM dual", false)]
    public void IsQueryOnly_PlSql(string sql, bool expected) => Assert.Equal(expected, StatementClassifier.IsQueryOnly(sql, Dialect.PlSql));

    [Fact]
    public void Ddl_Targets_TSql()
    {
        var t = One("CREATE TABLE [Sales].[Invoices] (Id int)").Ddl!;
        Assert.Equal(("CREATE", ObjectTypes.Table, (string?)null, "Sales", "Invoices", DdlScope.Object), (t.Action, t.ObjectType, t.Database, t.Schema, t.Name, t.Scope));

        var three = One("ALTER VIEW Shop.dbo.V AS SELECT 1 AS x").Ddl!;
        Assert.Equal(("Shop", "dbo", "V"), (three.Database, three.Schema, three.Name));

        var orAlter = One("CREATE OR ALTER PROCEDURE dbo.P AS SELECT 1").Ddl!;
        Assert.Equal((ObjectTypes.Proc, "dbo", "P"), (orAlter.ObjectType, orAlter.Schema, orAlter.Name));

        var index = One("CREATE UNIQUE NONCLUSTERED INDEX IX_A ON Sales.Orders (A)").Ddl!;
        Assert.Equal(("index", "Sales", "Orders"), (index.ObjectType, index.Schema, index.Name));

        var temp = One("CREATE TABLE #tmp (x int)").Ddl!;
        Assert.Equal(DdlScope.Temporary, temp.Scope);

        var schema = One("CREATE SCHEMA Reporting").Ddl!;
        Assert.Equal(DdlScope.Database, schema.Scope);

        var selectInto = One("SELECT Id INTO dbo.Copy FROM dbo.Orders");
        Assert.Equal("SELECT INTO", selectInto.Kind);
        Assert.Equal(("dbo", "Copy"), (selectInto.Ddl!.Schema, selectInto.Ddl.Name));

        var rename = One("EXEC sp_rename 'dbo.A', 'B'");
        Assert.NotNull(rename.Ddl);
    }

    [Fact]
    public void Ddl_EmbeddedStatementsWithoutSemicolons_TSql()
    {
        var c = StatementClassifier.Classify("CREATE TABLE a (x int)\nCREATE TABLE b.c (y int)\nDROP TABLE d", Dialect.TSql);
        Assert.Equal(new[] { "a", "c", "d" }, c.DdlTargets.Select(t => t.Name));

        // Procedure bodies are one statement: inner CREATE TABLE #t is not a separate catalog change.
        var proc = StatementClassifier.Classify("CREATE PROCEDURE p AS BEGIN CREATE TABLE x (i int) END", Dialect.TSql);
        Assert.Single(proc.DdlTargets);
    }

    [Fact]
    public void Ddl_Targets_PlSql()
    {
        var pkg = One("CREATE OR REPLACE EDITIONABLE PACKAGE BODY shop.order_api AS END;", Dialect.PlSql).Ddl!;
        Assert.Equal((ObjectTypes.Package, "shop", "order_api"), (pkg.ObjectType, pkg.Schema, pkg.Name));

        var syn = One("CREATE PUBLIC SYNONYM cust FOR shop.customers", Dialect.PlSql).Ddl!;
        Assert.Equal(("PUBLIC", "cust"), (syn.Schema, syn.Name));

        var mview = One("CREATE MATERIALIZED VIEW mv AS SELECT 1 x FROM dual", Dialect.PlSql);
        Assert.Equal("CREATE MATERIALIZED VIEW", mview.Kind);
        Assert.Equal(ObjectTypes.MView, mview.Ddl!.ObjectType);

        var user = One("DROP USER scott CASCADE", Dialect.PlSql).Ddl!;
        Assert.Equal(DdlScope.Database, user.Scope);

        var gtt = One("CREATE GLOBAL TEMPORARY TABLE g (x NUMBER)", Dialect.PlSql).Ddl!;
        Assert.Equal(DdlScope.Temporary, gtt.Scope);

        var comment = One("COMMENT ON COLUMN shop.customers.name IS 'x'", Dialect.PlSql).Ddl!;
        Assert.Equal(("shop", "customers"), (comment.Schema, comment.Name));
    }

    [Fact]
    public void Ddl_Targets_Sqlite()
    {
        var t = One("CREATE TABLE IF NOT EXISTS archive.items (id INTEGER)", Dialect.Sqlite).Ddl!;
        Assert.Equal(("archive", "items"), (t.Schema, t.Name));

        var temp = One("CREATE TEMP TABLE x (a)", Dialect.Sqlite).Ddl!;
        Assert.Equal(DdlScope.Temporary, temp.Scope);

        var index = One("CREATE INDEX archive.ix ON items (id)", Dialect.Sqlite).Ddl!;
        Assert.Equal(("archive", "items"), (index.Schema, index.Name));

        var attach = One("ATTACH DATABASE 'a.db' AS a", Dialect.Sqlite);
        Assert.Equal(DdlScope.Database, attach.Ddl!.Scope);

        var trigger = StatementClassifier.Classify(
            "CREATE TRIGGER trg AFTER INSERT ON orders BEGIN UPDATE stats SET n = n + 1; SELECT CASE WHEN 1 THEN 2 END; END; SELECT 1",
            Dialect.Sqlite);
        Assert.Equal(2, trigger.Statements.Count);
        Assert.Equal(("trigger", "trg"), (trigger.Statements[0].Ddl!.ObjectType, trigger.Statements[0].Ddl!.Name));
        Assert.Equal("SELECT", trigger.Statements[1].Kind);
    }

    [Theory]
    [InlineData("DELETE FROM t", true)]
    [InlineData("DELETE FROM t WHERE id = 1", false)]
    [InlineData("UPDATE t SET a = (SELECT b FROM s WHERE s.id = 1)", true)]
    [InlineData("UPDATE t SET a = 1 WHERE id = 2", false)]
    [InlineData("DROP TABLE t", true)]
    [InlineData("TRUNCATE TABLE t", true)]
    [InlineData("SELECT * FROM t", false)]
    public void Destructive(string sql, bool expected) => Assert.Equal(expected, StatementClassifier.Classify(sql, Dialect.TSql).IsDestructive);

    [Fact]
    public void Batch_PrimaryKindAndDml()
    {
        var c = StatementClassifier.Classify("CREATE TABLE t (a int); INSERT INTO t VALUES (1); SELECT * FROM t", Dialect.Sqlite);
        Assert.Equal(3, c.Statements.Count);
        Assert.True(c.HasDml);
        Assert.True(c.HasDdl);
        Assert.Equal("INSERT", c.PrimaryKind);
        Assert.False(c.IsQueryOnly);
    }

    [Fact]
    public void Tokenizer_HandlesQuotesCommentsAndPositions()
    {
        var tokens = SqlTokenizer.Tokenize("SELECT [a]]b], \"c\"\"d\", N'x''y' /* /* nested */ */ FROM t -- end\nWHERE x", Dialect.TSql);
        Assert.Equal("a]b", tokens[1].Value);
        Assert.Equal(SqlTokenKind.QuotedIdentifier, tokens[1].Kind);
        Assert.Equal("c\"d", tokens[3].Value);
        Assert.Equal(SqlTokenKind.String, tokens[5].Kind);
        Assert.Equal("FROM", tokens[6].Value);
        var where = tokens.Single(t => t.IsWord("WHERE"));
        Assert.Equal((2, 1), (where.Line, where.Col));
    }

    [Fact]
    public void LineColAt() => Assert.Equal((3, 2), SqlTokenizer.LineColAt("a\nbc\nde", 6));
}
