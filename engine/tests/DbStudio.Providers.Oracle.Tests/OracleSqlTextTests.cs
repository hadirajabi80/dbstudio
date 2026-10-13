namespace DbStudio.Providers.Oracle.Tests;

public sealed class BindVariableDetectorTests
{
    [Theory]
    [InlineData("SELECT * FROM t WHERE id = :id", new[] { "id" })]
    [InlineData("SELECT * FROM t WHERE a = :a AND b = :B AND c = :a", new[] { "a", "B" })]
    [InlineData("INSERT INTO t VALUES (:1, :2)", new[] { "1", "2" })]
    [InlineData("SELECT :\"Quoted Name\" FROM dual", new[] { "\"Quoted Name\"" })]
    [InlineData("BEGIN :out := f(:in); END;", new[] { "out", "in" })]
    [InlineData("SELECT :x$1#y FROM dual", new[] { "x$1#y" })]
    public void FindsBinds(string sql, string[] expected) => Assert.Equal(expected, OracleSqlText.FindBindVariables(sql));

    [Theory]
    [InlineData("SELECT ':notabind' FROM dual")]
    [InlineData("SELECT 'it''s :x' FROM dual")]
    [InlineData("SELECT q'[:x ']' still string]' FROM dual")]
    [InlineData("SELECT Q'{:x}' FROM dual")]
    [InlineData("SELECT q'<a:b>' , q'(c:d)', q'!e:f!' FROM dual")]
    [InlineData("SELECT nq'[:x]', N':y' FROM dual")]
    [InlineData("SELECT 1 FROM dual -- WHERE a = :a")]
    [InlineData("SELECT /* :a \n :b */ 1 FROM dual")]
    [InlineData("SELECT \"COL:A\" FROM t")]
    [InlineData("DECLARE v NUMBER; BEGIN v := 1; END;")]
    [InlineData("SELECT TO_CHAR(SYSDATE, 'HH24:MI:SS') FROM dual")]
    [InlineData("SELECT INTERVAL '1:30' HOUR TO MINUTE FROM dual")]
    [InlineData("SELECT JSON_VALUE('{\"a\":1}', '$.a') FROM dual")]
    public void IgnoresStringsCommentsAndAssignments(string sql) => Assert.Empty(OracleSqlText.FindBindVariables(sql));

    [Theory]
    [InlineData("CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :NEW.id := :OLD.id; END;")]
    [InlineData("create trigger trg before update on t referencing new as n for each row begin :n.x := 1; end;")]
    public void TriggerCorrelationNames_AreNotBinds(string sql) => Assert.Empty(OracleSqlText.FindBindVariables(sql));
}

public sealed class StatementPreparationTests
{
    [Theory]
    [InlineData("SELECT 1 FROM dual;", "SELECT 1 FROM dual")]
    [InlineData("  SELECT 1 FROM dual ;  \n", "SELECT 1 FROM dual")]
    [InlineData("SELECT ';' FROM dual;", "SELECT ';' FROM dual")]
    [InlineData("SELECT 1 FROM dual -- trailing comment;", "SELECT 1 FROM dual -- trailing comment;")]
    [InlineData("CREATE VIEW v AS SELECT 1 x FROM dual;", "CREATE VIEW v AS SELECT 1 x FROM dual")]
    [InlineData("CREATE OR REPLACE FORCE VIEW v AS SELECT 1 x FROM dual;", "CREATE OR REPLACE FORCE VIEW v AS SELECT 1 x FROM dual")]
    [InlineData("BEGIN NULL; END;", "BEGIN NULL; END;")]
    [InlineData("DECLARE x NUMBER; BEGIN NULL; END;\n/", "DECLARE x NUMBER; BEGIN NULL; END;")]
    [InlineData("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;\n/\n", "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;")]
    [InlineData("CREATE OR REPLACE EDITIONABLE PACKAGE BODY pk AS END;", "CREATE OR REPLACE EDITIONABLE PACKAGE BODY pk AS END;")]
    [InlineData("CREATE TYPE t AS OBJECT (a NUMBER);", "CREATE TYPE t AS OBJECT (a NUMBER);")]
    [InlineData("<<lbl>> BEGIN NULL; END;", "<<lbl>> BEGIN NULL; END;")]
    [InlineData("WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual;", "WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual;")]
    [InlineData("WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a;", "WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a")]
    [InlineData("SELECT 10 / 2 FROM dual", "SELECT 10 / 2 FROM dual")]
    public void Prepare_NormalizesTerminators(string input, string expected) => Assert.Equal(expected, OracleSqlText.Prepare(input).Sql);

    [Fact]
    public void Prepare_ReportsLeadingOffset()
    {
        var (sql, offset) = OracleSqlText.Prepare("\n\n  SELECT 1 FROM dual;");
        Assert.Equal("SELECT 1 FROM dual", sql);
        Assert.Equal(4, offset);
    }

    [Theory]
    [InlineData("EXEC my_proc(1, 'a')", "BEGIN my_proc(1, 'a'); END;")]
    [InlineData("exec pkg.p;", "BEGIN pkg.p; END;")]
    [InlineData("EXECUTE dbms_stats.gather_schema_stats('SHOP');", "BEGIN dbms_stats.gather_schema_stats('SHOP'); END;")]
    [InlineData("EXECUTE IMMEDIATE 'DROP TABLE x'", "BEGIN EXECUTE IMMEDIATE 'DROP TABLE x'; END;")]
    [InlineData("  EXEC p  ", "BEGIN p; END;")]
    public void ExecCommand_IsRewrittenToBlock(string input, string expected) => Assert.Equal(expected, OracleSqlText.Prepare(input).Sql);

    [Theory]
    [InlineData("EXEC")]
    [InlineData("EXECUTED_TABLE")]
    [InlineData("SELECT exec FROM t")]
    public void NonExec_IsNotRewritten(string input) => Assert.Null(OracleSqlText.RewriteExec(input));

    [Theory]
    [InlineData("SELECT 1 FROM dual", true)]
    [InlineData("  with a as (select 1 from dual) select * from a", true)]
    [InlineData("INSERT INTO t VALUES (1)", false)]
    [InlineData("BEGIN NULL; END;", false)]
    public void IsQuery(string sql, bool expected) => Assert.Equal(expected, OracleSqlText.IsQuery(sql));

    [Theory]
    [InlineData("ALTER SESSION SET CURRENT_SCHEMA = HR", true)]
    [InlineData("alter session set current_schema=\"Hr\"", true)]
    [InlineData("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'", false)]
    public void IsSetCurrentSchema(string sql, bool expected) => Assert.Equal(expected, OracleSqlText.IsSetCurrentSchema(sql));
}

public sealed class CreatedUnitTests
{
    [Theory]
    [InlineData("CREATE PROCEDURE p AS BEGIN NULL; END;", "PROCEDURE", null, "P")]
    [InlineData("create or replace procedure shop.p is begin null; end;", "PROCEDURE", "SHOP", "P")]
    [InlineData("CREATE OR REPLACE EDITIONABLE FUNCTION \"MyFn\" RETURN NUMBER IS BEGIN RETURN 1; END;", "FUNCTION", null, "MyFn")]
    [InlineData("CREATE OR REPLACE NONEDITIONABLE PACKAGE \"Shop\".api AS END;", "PACKAGE", "Shop", "API")]
    [InlineData("CREATE OR REPLACE PACKAGE BODY api AS END;", "PACKAGE BODY", null, "API")]
    [InlineData("CREATE TYPE t AS OBJECT (a NUMBER);", "TYPE", null, "T")]
    [InlineData("CREATE OR REPLACE TYPE BODY t AS END;", "TYPE BODY", null, "T")]
    [InlineData("CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t BEGIN NULL; END;", "TRIGGER", null, "TRG")]
    [InlineData("CREATE OR REPLACE FORCE VIEW v AS SELECT 1 x FROM dual", "VIEW", null, "V")]
    [InlineData("CREATE OR REPLACE NO FORCE EDITIONING VIEW v AS SELECT 1 x FROM dual", "VIEW", null, "V")]
    [InlineData("-- header\nCREATE PROCEDURE IF NOT EXISTS p AS BEGIN NULL; END;", "PROCEDURE", null, "P")]
    public void Recognizes(string sql, string type, string? owner, string name)
    {
        var u = OracleSqlText.FindCreatedUnit(sql);
        Assert.NotNull(u);
        Assert.Equal((type, owner, name), (u!.ObjectType, u.Owner, u.Name));
        Assert.True(sql[u.SourceOffset..].StartsWith(type.Split(' ')[0], StringComparison.OrdinalIgnoreCase)
                    || sql[u.SourceOffset..].StartsWith(type.Split(' ')[0].ToLowerInvariant(), StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("CREATE TABLE t (id NUMBER)")]
    [InlineData("CREATE OR REPLACE PUBLIC SYNONYM s FOR x.y")]
    [InlineData("CREATE INDEX ix ON t(a)")]
    [InlineData("SELECT 1 FROM dual")]
    [InlineData("CREATE")]
    public void IgnoresOtherStatements(string sql) => Assert.Null(OracleSqlText.FindCreatedUnit(sql));

    [Fact]
    public void KeywordOffset_SkipsCreateOrReplace()
    {
        const string sql = "CREATE OR REPLACE\n  PROCEDURE p AS BEGIN NULL; END;";
        var u = OracleSqlText.FindCreatedUnit(sql)!;
        Assert.Equal(sql.IndexOf("PROCEDURE", StringComparison.Ordinal), u.SourceOffset);
    }
}

public sealed class TokenizerTests
{
    [Fact]
    public void Tokens_SkipCommentsAndKeepOffsets()
    {
        const string sql = "/* c */ SELECT \"A\", 'x''y', q'[z]' -- tail\nFROM t";
        var tokens = OracleSqlText.Tokenize(sql).ToList();
        Assert.Equal(new[] { "SELECT", "\"A\"", ",", "'x''y'", ",", "q'[z]'", "FROM", "t" }, tokens.Select(t => t.Text));
        Assert.All(tokens, t => Assert.Equal(t.Text, sql.Substring(t.Offset, t.Text.Length)));
    }

    [Fact]
    public void UnterminatedConstructs_DoNotThrow()
    {
        Assert.NotEmpty(OracleSqlText.Tokenize("SELECT 'abc").ToList());
        Assert.NotEmpty(OracleSqlText.Tokenize("SELECT q'[abc").ToList());
        Assert.NotEmpty(OracleSqlText.Tokenize("SELECT \"abc").ToList());
        Assert.NotEmpty(OracleSqlText.Tokenize("SELECT 1 /* abc").ToList());
    }

    [Theory]
    [InlineData("SELECT a, B, \"Mixed\" FROM t", "b", 10)]
    [InlineData("SELECT 'b', b FROM t", "B", 12)]
    [InlineData("SELECT \"Mixed\" FROM t", "Mixed", 7)]
    [InlineData("SELECT x FROM t", "y", -1)]
    public void FindIdentifier(string sql, string ident, int expected) => Assert.Equal(expected, OracleSqlText.FindIdentifier(sql, ident));

    [Theory]
    [InlineData("SHOP", "SHOP")]
    [InlineData("shop", "SHOP")]
    [InlineData("\"Shop\"", "Shop")]
    public void FoldIdentifier(string input, string expected) => Assert.Equal(expected, OracleSqlText.FoldIdentifier(input));

    [Fact]
    public void Quote_RejectsEmbeddedQuotes() => Assert.Throws<ArgumentException>(() => OracleSqlText.Quote("a\"b"));
}
