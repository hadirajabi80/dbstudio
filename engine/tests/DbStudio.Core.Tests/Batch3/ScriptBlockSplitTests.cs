using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Tests.Batch3;

/// <summary>MySQL compound statements and Snowflake Scripting stay whole in the shared splitter (read-only guard, history labels).</summary>
public class ScriptBlockSplitTests
{
    private static int Count(string sql, Dialect d) => SqlTokenizer.SplitStatements(SqlTokenizer.Tokenize(sql, d), d).Count;

    [Theory]
    [InlineData("CREATE PROCEDURE p() BEGIN IF a THEN SELECT 1; END IF; SELECT 2; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN WHILE i < 3 DO SET i = i + 1; END WHILE; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN REPEAT SET i = i + 1; UNTIL i > 3 END REPEAT; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN lbl: LOOP SET i = i + 1; IF i > 3 THEN LEAVE lbl; END IF; END LOOP lbl; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN lbl:LOOP SET i = i + 1; IF i > 3 THEN LEAVE lbl; END IF; END LOOP lbl; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN IF a THEN SELECT 1; ELSEIF b THEN SELECT 2; ELSE IF c THEN SELECT 3; END IF; END IF; END; SELECT 4", 2)]
    [InlineData("CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC BEGIN RETURN IF(a > 0, 1, 2); END; SELECT f(1)", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN CASE a WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE; END; SELECT 3", 2)]
    [InlineData("CREATE PROCEDURE p() BEGIN SELECT CASE WHEN a THEN IF(b, 1, 2) END; SELECT 2; END; SELECT 3", 2)]
    [InlineData("CREATE DEFINER = `root`@`localhost` PROCEDURE p() BEGIN IF (a > 0) THEN SELECT 1; END IF; END", 1)]
    [InlineData("BEGIN NOT ATOMIC IF a THEN SELECT 1; END IF; SELECT 2; END; SELECT 3", 2)]
    public void MySql_compound_statements_stay_whole(string sql, int expected) => Assert.Equal(expected, Count(sql, Dialect.MySql));

    [Theory]
    [InlineData("SELECT IF(a, 1, 2) FROM t; SELECT 2", 2)]
    [InlineData("CREATE TABLE IF NOT EXISTS t (id INT); DROP TABLE IF EXISTS u", 2)]
    [InlineData("BEGIN; SELECT 1; COMMIT", 3)]
    public void MySql_plain_statements_split_normally(string sql, int expected) => Assert.Equal(expected, Count(sql, Dialect.MySql));

    [Theory]
    [InlineData("DECLARE x INT DEFAULT 0; BEGIN IF (x = 0) THEN x := 1; END IF; RETURN x; END; SELECT 1", 2)]
    [InlineData("BEGIN FOR i IN 1 TO 3 DO INSERT INTO t VALUES (:i); END FOR; END; SELECT 1", 2)]
    [InlineData("BEGIN WHILE (x < 3) DO x := x + 1; END WHILE; REPEAT x := x - 1; UNTIL (x = 0) END REPEAT; LOOP BREAK; END LOOP; END; SELECT 1", 2)]
    [InlineData("BEGIN CREATE TABLE IF NOT EXISTS t (a INT); IF (EXISTS (SELECT 1)) THEN SELECT 1; END IF; END; SELECT 2", 2)]
    [InlineData("DECLARE c1 CURSOR FOR SELECT 1; res RESULTSET; BEGIN OPEN c1; END; SELECT 2", 2)]
    [InlineData("BEGIN CASE WHEN a THEN SELECT 1; ELSE SELECT 2; END CASE; END; SELECT 3", 2)]
    public void Snowflake_scripting_stays_whole(string sql, int expected) => Assert.Equal(expected, Count(sql, Dialect.Snowflake));

    [Theory]
    [InlineData("BEGIN; SELECT 1; COMMIT", 3)]
    [InlineData("BEGIN TRANSACTION; SELECT 1; COMMIT", 3)]
    public void Snowflake_transactions_are_plain_statements(string sql, int expected) => Assert.Equal(expected, Count(sql, Dialect.Snowflake));

    [Fact]
    public void Classifier_sees_one_routine_not_its_inner_statements()
    {
        var c = StatementClassifier.Classify("CREATE PROCEDURE p() BEGIN IF a THEN DELETE FROM t; END IF; END", Dialect.MySql);
        Assert.Single(c.Statements);
    }
}
