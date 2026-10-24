using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Logs;
using DbStudio.Logs.Providers.MySql;
using DbStudio.Logs.Sql;
using DbStudio.Providers.MySql.Params;
using Microsoft.Extensions.DependencyInjection;
using MySqlConnector;

namespace DbStudio.Providers.MySql.Tests;

/// <summary>Splitter, lexer, placeholders, classification, connection strings, flavors, errors and types (no server).</summary>
public sealed class MySqlSqlTextTests
{
    private static List<string> Texts(string sql) => MySqlSqlText.Split(sql).Select(s => s.Text(sql)).ToList();

    [Fact]
    public void Split_Semicolons_StringsCommentsAndBackticks()
    {
        Assert.Equal(["SELECT 'a;b', \"c;d\", `e;f`", "SELECT 2 # x; y", "SELECT 'it\\'s;' -- z;"],
            Texts("SELECT 'a;b', \"c;d\", `e;f`;SELECT 2 # x; y\n;SELECT 'it\\'s;' -- z;\n"));
        Assert.Equal(["SELECT 1--1", "SELECT 2"], Texts("SELECT 1--1;SELECT 2"));
        Assert.Equal(["SELECT 1 /* ; */ + 1"], Texts("SELECT 1 /* ; */ + 1;"));
    }

    [Theory]
    [InlineData("$$")]
    [InlineData("//")]
    [InlineData(";;")]
    [InlineData("|")]
    public void Split_DelimiterLines_KeepBodiesWhole(string d)
    {
        var sql = $"DELIMITER {d}\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND{d}\nDELIMITER ;\nCALL p();\nSELECT 3";
        var parts = MySqlSqlText.Split(sql);
        Assert.Equal(3, parts.Count);
        Assert.Equal("CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND", parts[0].Text(sql));
        Assert.Equal(d, parts[0].Delimiter);
        Assert.Equal("CALL p()", parts[1].Text(sql));
        Assert.Equal("SELECT 3", parts[2].Text(sql));
    }

    [Fact]
    public void Split_CompoundBodiesWithoutDelimiter()
    {
        const string proc = "CREATE DEFINER=`root`@`%` PROCEDURE p(IN n INT)\nBEGIN\n  DECLARE i INT DEFAULT 0;\n  lbl: LOOP\n    SET i = i + 1;\n    IF i > n THEN LEAVE lbl; END IF;\n  END LOOP lbl;\n" +
                            "  WHILE i > 0 DO SET i = i - 1; END WHILE;\n  REPEAT SET i = i + 1; UNTIL i >= 2 END REPEAT;\n  CASE i WHEN 2 THEN SELECT 'two'; ELSE SELECT 'other'; END CASE;\n  SELECT IF(i > 1, 'a', 'b'), CASE WHEN i THEN 1 END;\nEND";
        Assert.Equal([proc, "SELECT 1"], Texts(proc + ";\nSELECT 1;"));
        const string trigger = "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN IF NEW.a < 0 THEN SIGNAL SQLSTATE '45000'; END IF; END";
        Assert.Equal([trigger, "SELECT 2"], Texts(trigger + ";SELECT 2"));
        const string func = "CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC RETURN IF(a > 0, a, 0)";
        Assert.Equal([func, "SELECT f(1)"], Texts(func + "; SELECT f(1);"));
        const string ev = "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM x; DELETE FROM y; END";
        Assert.Equal([ev, "SELECT 3"], Texts(ev + "; SELECT 3"));
        const string anon = "BEGIN NOT ATOMIC DECLARE x INT; SET x = 1; SELECT x; END";
        Assert.Equal([anon, "SELECT 4"], Texts(anon + "; SELECT 4"));
    }

    [Fact]
    public void Split_BeginIsATransaction_AndBackslashG()
    {
        Assert.Equal(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"], Texts("BEGIN; INSERT INTO t VALUES (1); COMMIT;"));
        Assert.Equal(["SELECT 1", "SELECT 2"], Texts("SELECT 1\\G SELECT 2\\g"));
        Assert.Equal(["DROP TABLE IF EXISTS a", "SELECT 1"], Texts("DROP TABLE IF EXISTS a; SELECT 1"));
        Assert.Empty(Texts("-- nothing\nDELIMITER $$\n"));
    }

    [Fact]
    public void Placeholders_NamedUserVariablesAndPositional()
    {
        var p = MySqlSqlText.Placeholders("SELECT :a, @b, ?, @@version, @x := 1, ':c', `:d`, -- :e\n lbl:BEGIN, a::b, @'q'");
        Assert.Equal([("a", ':'), ("b", '@'), (null, '?'), ("x", '@')], p.Select(x => (x.Name, x.Prefix)));
    }

    [Fact]
    public void Binder_RewritesNamedAndPositional_LeavesUserVariables()
    {
        using var cmd = new MySqlCommand("SELECT :id, ?, @n, @keep, :missing");
        var bound = MySqlParamBinder.Instance.Bind(cmd, [new QueryParam("id", "int", JsonValue.Create(5)), new QueryParam("1", "string", JsonValue.Create("x")),
            new QueryParam("n", "decimal", JsonValue.Create("1.5"))], new ParamBindCursor());
        Assert.Equal("SELECT @id, @__p1_0, @n, @keep, :missing", cmd.CommandText);
        Assert.Equal(["@id", "@__p1_0", "@n"], cmd.Parameters.Cast<MySqlParameter>().Select(x => x.ParameterName));
        Assert.Equal(["missing"], bound.Missing);
        Assert.Equal(5L, cmd.Parameters["@id"].Value);
        Assert.Throws<EngineException>(() => MySqlParamBinder.Instance.Bind(new MySqlCommand("SELECT :c"), [new QueryParam("c", "refcursor")], new ParamBindCursor()));

        using var outCmd = new MySqlCommand("CALL p(:a, :o)");
        var outs = MySqlParamBinder.Instance.Bind(outCmd, [new QueryParam("a", "int", JsonValue.Create(1)), new QueryParam("o", "int", null, "out")], new ParamBindCursor());
        Assert.Equal("CALL p(@a, @o)", outCmd.CommandText);
        Assert.Single(outCmd.Parameters);
        Assert.Equal("@o", Assert.Single(MySqlParamBinder.OutputVariables(outs)).Parameter.ParameterName);
    }

    [Fact]
    public void Classify_MySqlHeads()
    {
        BatchClassification C(string sql) => StatementClassifier.Classify(sql, Dialect.MySql);
        Assert.True(C("SHOW TABLES").IsQueryOnly);
        Assert.True(C("DESC orders").IsQueryOnly);
        Assert.Equal("BEGIN", C("START TRANSACTION READ ONLY").Statements[0].Kind);
        Assert.Equal(StatementCategory.Transaction, C("BEGIN").Statements[0].Category);
        Assert.Equal(StatementCategory.Block, C("BEGIN NOT ATOMIC SELECT 1; END").Statements[0].Category);
        Assert.Equal("ROLLBACK TO SAVEPOINT", C("ROLLBACK TO SAVEPOINT s1").Statements[0].Kind);
        Assert.Equal(StatementCategory.Dml, C("LOAD DATA INFILE 'x' INTO TABLE t").Statements[0].Category);
        Assert.Equal(StatementCategory.Dml, C("EXPLAIN ANALYZE DELETE FROM t WHERE id = 1").Statements[0].Category);
        Assert.True(C("EXPLAIN SELECT 1").IsQueryOnly);
        Assert.Equal("LOCK TABLES", C("LOCK TABLES t READ").Statements[0].Kind);
        var proc = C("CREATE DEFINER=`root`@`%` PROCEDURE shop.p() BEGIN SELECT 1; END").Statements[0];
        Assert.Equal((ObjectTypes.Proc, "shop", "p"), (proc.Ddl!.ObjectType, proc.Ddl.Schema, proc.Ddl.Name));
        var view = C("CREATE OR REPLACE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY INVOKER VIEW v AS SELECT 1").Statements[0];
        Assert.Equal((ObjectTypes.View, "v"), (view.Ddl!.ObjectType, view.Ddl.Name));
        var ev = C("CREATE EVENT IF NOT EXISTS ev ON SCHEDULE EVERY 1 DAY DO SELECT 1").Statements[0];
        Assert.Equal((ObjectTypes.Proc, "ev"), (ev.Ddl!.ObjectType, ev.Ddl.Name));
        var rename = C("RENAME TABLE a TO b").Statements[0];
        Assert.Equal(("RENAME", "a"), (rename.Ddl!.Action, rename.Ddl.Name));
        Assert.True(C("DELETE FROM t").IsDestructive);
        Assert.False(C("SELECT * FROM t").Statements.Any(s => s.IsDestructive));
    }

    [Fact]
    public void Classify_MySqlSqlText_KeepsBodiesAndHonoursDelimiter()
    {
        var c = MySqlSqlText.Classify("DELIMITER $$\nCREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; END$$\nDELIMITER ;\nCALL p()");
        Assert.Equal(["CREATE PROCEDURE", "CALL"], c.Statements.Select(s => s.Kind));
        Assert.Equal(ObjectTypes.Proc, c.Statements[0].Ddl!.ObjectType);
        Assert.False(MySqlSqlText.Classify("SELECT 1; SET @a = 1").Statements.Any(s => s.Category != StatementCategory.Query && s.Category != StatementCategory.Session));
    }

    [Fact]
    public void CoreTokenizer_KeepsRoutineBodies_AndTreatsBeginAsTransaction()
    {
        var tokens = SqlTokenizer.Tokenize("CREATE DEFINER=`u`@`h` PROCEDURE p() BEGIN SELECT 1; SELECT 2; END; SELECT 3; BEGIN; COMMIT", Dialect.MySql);
        Assert.Equal(4 + 0, SqlTokenizer.SplitStatements(tokens, Dialect.MySql).Count); // proc, SELECT 3, BEGIN, COMMIT
    }

    [Fact]
    public void SearchSql_MySqlPredicates()
    {
        Assert.Equal("CONVERT(`name` USING utf8mb4) COLLATE utf8mb4_general_ci REGEXP @term", SearchSql.RegexPredicate(Dialect.MySql, "`name`", "@term", false));
        Assert.Equal("UPPER(x) LIKE UPPER(@t) ESCAPE '!'", SearchSql.LikePredicate(Dialect.MySql, "x", "@t", false));
        Assert.Equal("CAST(`j` AS CHAR)", SearchSql.TextExpression(Dialect.MySql, "`j`", "json"));
        Assert.Equal("`e`", SearchSql.TextExpression(Dialect.MySql, "`e`", "enum('a','b')"));
        Assert.Null(SearchSql.TextExpression(Dialect.MySql, "`i`", "int"));
        Assert.All(MySqlSearcher.All.Values, q => Assert.Contains("@p0", q));
    }

    [Fact]
    public void Quoting_AndLiterals()
    {
        Assert.Equal("`we``ird`", MySqlSqlText.Quote("we`ird"));
        Assert.Equal("`shop`.`orders`", MySqlSqlText.Qualify("shop", "orders"));
        Assert.Equal("'it''s a \\\\ b'", MySqlSqlText.Literal("it's a \\ b"));
        Assert.Equal("orders", MySqlSqlText.QuoteIfNeeded("orders"));
        Assert.Equal("`order`", MySqlSqlText.QuoteIfNeeded("order"));
    }
}

public sealed class MySqlProviderUnitTests
{
    private static ConnectionProfile Profile(params (string Key, JsonNode? Value)[] props) => new()
    {
        Id = "c1", ProviderId = "mysql",
        Props = props.ToDictionary(p => p.Key, p => p.Value),
    };

    [Fact]
    public void ConnectionString_SessionDefaults()
    {
        var b = MySqlConnectionStrings.Builder(Profile(("host", "db.example"), ("port", 3307), ("database", "shop"), ("user", "u"), ("sslMode", "verifyfull"),
            ("sslCa", "C:\\ca.pem"), ("allowPublicKeyRetrieval", true), ("charset", "latin1"), ("compress", true), ("connectTimeout", 7)), "pw", pooling: false, database: "other");
        Assert.Equal(("db.example", 3307u, "other", "u", "pw"), (b.Server, b.Port, b.Database, b.UserID, b.Password));
        Assert.Equal(MySqlSslMode.VerifyFull, b.SslMode);
        Assert.Equal("C:\\ca.pem", b.SslCa);
        Assert.True(b.AllowPublicKeyRetrieval && b.UseCompression && b.AllowUserVariables && b.UseAffectedRows && b.ConvertZeroDateTime);
        Assert.False(b.Pooling || b.AllowLoadLocalInfile || b.TreatTinyAsBoolean);
        Assert.Equal("latin1", b.CharacterSet);
        Assert.Equal(7u, b.ConnectionTimeout);
        Assert.Equal(MySqlGuidFormat.None, b.GuidFormat);
        Assert.Throws<ArgumentException>(() => MySqlConnectionStrings.Builder(Profile(("host", " ")), null, false));
        Assert.Throws<ArgumentException>(() => MySqlConnectionStrings.ParseSslMode("bogus"));
        Assert.Equal(MySqlSslMode.None, MySqlConnectionStrings.ParseSslMode("none"));
        Assert.Equal(MySqlSslMode.Preferred, MySqlConnectionStrings.ParseSslMode(null));
    }

    [Fact]
    public void ServerVariables_AndReadOnly()
    {
        Assert.Equal([("sql_mode", "'ANSI_QUOTES,STRICT_ALL_TABLES'"), ("time_zone", "'+00:00'")],
            MySqlConnectionStrings.ParseServerVariables("sql_mode='ANSI_QUOTES,STRICT_ALL_TABLES', @@session.time_zone = '+00:00'"));
        Assert.Throws<ArgumentException>(() => MySqlConnectionStrings.ParseServerVariables("x=1; DROP TABLE t"));
        Assert.Throws<ArgumentException>(() => MySqlConnectionStrings.ParseServerVariables("bad name=1"));
        var p = Profile(("host", "h"), ("serverVariables", "wait_timeout=60"));
        p.ReadOnly = true;
        Assert.Equal(["SET SESSION wait_timeout = 60", "SET SESSION TRANSACTION READ ONLY"], MySqlConnectionStrings.InitStatements(p, session: true));
        Assert.Equal(["SET SESSION wait_timeout = 60"], MySqlConnectionStrings.InitStatements(p, session: false));
    }

    [Fact]
    public void FormSpec_MatchesTheUiMock()
    {
        Assert.Equal(["host", "port", "database", "user", "password", "sslMode", "sslCa", "allowPublicKeyRetrieval", "charset", "connectTimeout", "compress", "serverVariables"],
            MySqlConnectionStrings.FormSpec.Fields.Select(f => f.Key));
        var providers = new IDbProvider[] { new MySqlProvider(), new MariaDbProvider() };
        Assert.Equal([("mysql", "MySQL"), ("mariadb", "MariaDB")], providers.Select(p => (p.Id, p.DisplayName)));
        Assert.All(providers, p => Assert.Equal(Dialect.MySql, p.Dialect));
        Assert.All(providers, p => Assert.Equal('`', p.Identifiers.QuoteOpen));
    }

    [Theory]
    [InlineData("8.4.3", false, 8, 4, 3)]
    [InlineData("8.0.36-28.1", false, 8, 0, 36)]
    [InlineData("11.4.2-MariaDB-ubu2404", true, 11, 4, 2)]
    [InlineData("5.5.5-10.6.12-MariaDB-log", true, 10, 6, 12)]
    public void Flavor_FromVersion(string version, bool maria, int major, int minor, int patch)
    {
        var f = MySqlFlavor.From(version, null);
        Assert.Equal((maria, major, minor, patch), (f.IsMariaDb, f.Major, f.Minor, f.Patch));
        Assert.Equal(!maria && major >= 8, f.HasExplainAnalyze);
        Assert.True(MySqlFlavor.From("5.7.44", "MariaDB Server").IsMariaDb);
        Assert.False(MySqlFlavor.From("8.0.17", null).HasExplainAnalyze);
    }

    [Fact]
    public void Errors_LocateNearTextAndNames()
    {
        const string stmt = "SELECT *\nFORM customers";
        Assert.Equal(stmt.IndexOf("FORM", StringComparison.Ordinal),
            MySqlErrors.Locate("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'FORM customers' at line 2", stmt));
        Assert.True(MySqlErrors.Locate("... near '' at line 2", stmt) >= stmt.IndexOf('\n'));
        const string q = "SELECT a FROM t WHERE nmae = 1";
        Assert.Equal(q.IndexOf("nmae", StringComparison.Ordinal), MySqlErrors.Locate("Unknown column 'nmae' in 'where clause'", q));
        Assert.Equal(q.IndexOf(" t ", StringComparison.Ordinal) + 1, MySqlErrors.Locate("Table 'shop.t' doesn't exist", q));
        Assert.Null(MySqlErrors.Locate("Duplicate entry '1' for key 'PRIMARY'", q));
        var e = MySqlErrors.FromException(MakeException(1146, "42S02", "Table 'shop.t' doesn't exist"), new SqlBatch("\n" + q, 10, 1), 1, q);
        Assert.Equal(("1146", 11, 15), (e.Code, e.Line, e.Col));
        Assert.Equal("SQLSTATE 42S02", e.Detail);
    }

    private static MySqlException MakeException(int number, string state, string message)
    {
        var ctor = typeof(MySqlException).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)
            .First(c => c.GetParameters().Select(p => p.ParameterType).SequenceEqual([typeof(MySqlErrorCode), typeof(string), typeof(string)]));
        return (MySqlException)ctor.Invoke([(MySqlErrorCode)number, state, message]);
    }

    [Fact]
    public void Types_KindsAndBitStrings()
    {
        Assert.Equal("int", MySqlTypes.BaseName("INT UNSIGNED"));
        Assert.Equal(ColumnKinds.String, MySqlTypes.KindFor("BIT", typeof(ulong)));
        Assert.Equal(ColumnKinds.Int, MySqlTypes.KindFor("YEAR", typeof(int)));
        Assert.Equal(ColumnKinds.Json, MySqlTypes.KindFor("JSON", typeof(string)));
        Assert.Equal(ColumnKinds.Binary, MySqlTypes.KindFor("GEOMETRY", typeof(byte[])));
        Assert.Equal(ColumnKinds.Date, MySqlTypes.KindFor("DATE", typeof(DateTime)));
        Assert.Equal(ColumnKinds.Decimal, MySqlTypes.KindFor("DECIMAL", typeof(decimal)));
        Assert.Equal(ColumnKinds.String, MySqlTypes.KindFor("ENUM", typeof(string)));
        Assert.Equal("1010", MySqlTypes.BitString(10, 4));
        Assert.Equal("00000001", MySqlTypes.BitString(1, 8));
        Assert.Equal("18446744073709551615", MySqlTypes.Convert(ulong.MaxValue, new ColumnInfo("u", 0, "BIGINT UNSIGNED", ColumnKinds.Int, true)));
    }

    [Fact]
    public void Module_RegistersBothProvidersAndKeyedFeatures()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ISqlRunnerFactory, NoRunners>();
        new MySqlModule().ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        Assert.Equal(["mysql", "mariadb"], sp.GetServices<IDbProvider>().Select(p => p.Id));
        foreach (var id in MySqlModule.ProviderIds)
        {
            Assert.Equal(id, sp.GetRequiredKeyedService<IDdlScripter>(id).ProviderId);
            Assert.Equal(id, sp.GetRequiredKeyedService<IDesignerDatabase>(id).ProviderId);
            Assert.Equal(id, sp.GetRequiredKeyedService<IPlanReader>(id).ProviderId);
            Assert.NotNull(sp.GetRequiredKeyedService<IParamBinder>(id));
            Assert.Equal(id, sp.GetRequiredKeyedService<ILogSource>(id).ProviderId);
            Assert.Same(sp.GetRequiredKeyedService<ILogSource>(id), sp.GetRequiredKeyedService<IActivitySource>(id));
        }
        Assert.All(sp.GetServices<IDbProvider>(), p => Assert.IsAssignableFrom<IObjectBrowserProvider>(p));
        Assert.All(sp.GetServices<IDbProvider>(), p => Assert.IsAssignableFrom<IDatabaseSearchProvider>(p));
    }

    private sealed class NoRunners : ISqlRunnerFactory
    {
        public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => throw new NotSupportedException();
    }
}

public sealed class MySqlLogParsingTests
{
    [Fact]
    public void InnoDbStatus_OneEntryPerSection()
    {
        const string status = "\n=====================================\n2026-10-24 10:00:00 INNODB MONITOR OUTPUT\n=====================================\n" +
                              "-----------------\nBACKGROUND THREAD\n-----------------\nsrv_master_thread loops: 1\n" +
                              "------------------------\nLATEST DETECTED DEADLOCK\n------------------------\n*** (1) TRANSACTION:\n" +
                              "------------\nTRANSACTIONS\n------------\nTrx id counter 1234\n";
        var entries = MySqlLogSource.ParseInnoDbStatus(SqlRowSet.Of(["Type", "Name", "Status"], ["InnoDB", "", status]), DateTimeOffset.UnixEpoch);
        Assert.Equal(["BACKGROUND THREAD", "LATEST DETECTED DEADLOCK", "TRANSACTIONS"], entries.Select(e => e.Message));
        Assert.Equal(LogLevels.Warn, entries[1].Level);
        Assert.Equal("Trx id counter 1234", entries[2].Detail);
    }

    [Fact]
    public void ErrorAndSlowLog_AscendingWithTimestamps()
    {
        var rows = SqlRowSet.Of(["ts", "thread_id", "prio", "error_code", "subsystem", "data"],
            [1761300001.5, 0, "Warning", "MY-010068", "Server", "CA certificate is self signed."],
            [1761300000.25, 0, "System", "MY-010116", "Server", "mysqld starting"]);
        var entries = MySqlLogSource.ParseErrorLog(rows);
        Assert.Equal(["mysqld starting", "CA certificate is self signed."], entries.Select(e => e.Message));
        Assert.Equal([LogLevels.Info, LogLevels.Warn], entries.Select(e => e.Level));
        Assert.True(entries[0].Seq < entries[1].Seq);
        Assert.Equal("2025-10-24T10:00:00.250Z", entries[0].Ts);

        var slow = MySqlLogSource.ParseSlowLog(SqlRowSet.Of(["ts", "user_host", "query_s", "lock_s", "rows_sent", "rows_examined", "db", "sql_text"],
            [1761300000.0, "root[root] @ [::1]", 12.5, 0.0, 1L, 100000L, "shop", "SELECT SLEEP(12.5)"]));
        Assert.Equal(LogLevels.Warn, Assert.Single(slow).Level);
        Assert.StartsWith("12.5 s, 100000 rows examined", slow[0].Message);
    }

    [Fact]
    public void Activity_SessionsLocksAndKillStatements()
    {
        var sessions = SqlRowSet.Of(["id", "user_name", "host", "db", "command", "time_s", "state", "info"],
            [11L, "app", "10.0.0.5:5555", "shop", "Query", 12L, "executing", "UPDATE orders SET total = 1"],
            [12L, "app", "10.0.0.6:5555", "shop", "Sleep", 300L, "", null]);
        var waits = SqlRowSet.Of(["waiting", "blocking", "object_schema", "object_name", "lock_mode", "lock_type"], [11L, 12L, "shop", "orders", "X", "RECORD"]);
        var rows = MySqlLogSource.ParseActivity(sessions, waits);
        var active = rows.Single(r => r.Id == "11");
        Assert.Equal(("active", "12", 12000L, "KILL 11"), (active.State, active.BlockedBy, active.DurationMs!.Value, active.Fields!["killStatement"]));
        Assert.Equal("KILL QUERY 11", active.Fields["cancelStatement"]);
        Assert.Equal("idle", rows.Single(r => r.Id == "12").State);
        var lockRow = rows.Single(r => r.Kind == "lock");
        Assert.Equal("shop.orders", lockRow.Fields!["resource"]);
    }

    [Fact]
    public void Sources_ExplainWhyTheyAreUnavailable()
    {
        var maria = new MySqlLogSource.Facts("11.4.2-MariaDB", true, "shop@%", "FILE", false, false, false, false, false, false);
        var s = MySqlLogSource.Sources(maria);
        Assert.False(s[0].Available);
        Assert.Contains("MariaDB", s[0].Reason);
        Assert.False(s.Single(x => x.Id == "general_log").Available);
        Assert.Equal("SET GLOBAL log_output = 'TABLE,FILE';", s.Single(x => x.Id == "general_log").Needs);
        Assert.Equal("GRANT PROCESS ON *.* TO 'shop'@'%';", s.Single(x => x.Id == "innodb_status").Needs);
        var mysql = new MySqlLogSource.Facts("8.4.3", false, "root@%", "TABLE,FILE", false, true, true, true, true, true);
        var m = MySqlLogSource.Sources(mysql);
        Assert.All(m, x => Assert.True(x.Available));
        Assert.Contains("OFF", m.Single(x => x.Id == "general_log").Reason);
        Assert.Contains("FROM_UNIXTIME(1761300000.000)", MySqlLogSql.ErrorLog(DateTimeOffset.FromUnixTimeSeconds(1761300000), null, 10));
    }
}
