using System.Numerics;
using System.Text.Json.Nodes;
using ClickHouse.Driver.ADO;
using ClickHouse.Driver.Numerics;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Search;
using DbStudio.Core.Sql;
using DbStudio.Providers.ClickHouse.Params;
using DbStudio.Providers.ClickHouse.Plans;

namespace DbStudio.Providers.ClickHouse.Tests;

public sealed class ChSqlTextTests
{
    [Fact]
    public void Split_AtDepth0Semicolons_SkippingStringsAndComments()
    {
        var sql = "SELECT 'a;b' AS x; # hash comment;\nSELECT `we;ird` FROM t -- c;\n;INSERT INTO t VALUES (1)";
        var st = ChSqlText.Split(sql);
        Assert.Equal(3, st.Count);
        Assert.Equal("SELECT 'a;b' AS x", st[0].Text);
        Assert.Equal("SELECT `we;ird` FROM t", st[1].Text);
        Assert.True(st[0].IsQuery);
        Assert.True(st[2].IsInsert);
        Assert.Equal(sql.IndexOf("SELECT `", StringComparison.Ordinal), st[1].Start);
    }

    [Fact]
    public void InsertWithInlineFormat_KeepsTheRestOfTheBatchAsData()
    {
        var st = ChSqlText.Split("INSERT INTO t FORMAT CSV\n1,\"a;b\"\n2,c;");
        var only = Assert.Single(st);
        Assert.EndsWith("2,c;", only.Text);
    }

    [Fact]
    public void Use_And_Mutations_AreRecognised()
    {
        var st = ChSqlText.Split("USE `analytics`; ALTER TABLE shop.t ON CLUSTER c UPDATE v = 1 WHERE id = 2; DELETE FROM t WHERE x; ALTER TABLE t ADD COLUMN c UInt8");
        Assert.Equal("analytics", st[0].UseDatabase);
        Assert.Equal(("shop", "t"), st[1].Mutation!.Value);
        Assert.Equal(((string?)null, "t"), st[2].Mutation!.Value);
        Assert.Null(st[3].Mutation);
    }

    [Theory]
    [InlineData("SELECT 1", 1, 0)]
    [InlineData("SELECT 'سلام' FROM x", 17, 12)] // the Persian word is 4 chars / 8 bytes: byte 16 is the closing quote
    public void BytePositions_MapToCharacterOffsets(string text, int position, int expected) =>
        Assert.Equal(expected, ChSqlText.CharOffsetOfBytePosition(text, position));

    [Theory]
    [InlineData("orders", "orders")]
    [InlineData("Order Lines", "`Order Lines`")]
    [InlineData("select", "`select`")]
    [InlineData("a`b", "`a\\`b`")]
    public void Quote_OnlyWhenNeeded(string name, string expected) => Assert.Equal(expected, ChSqlText.Quote(name));

    [Fact]
    public void Literal_EscapesBackslashAndQuote() => Assert.Equal(@"'it\'s \\ ok\n'", ChSqlText.Literal("it's \\ ok\n"));
}

public sealed class ChParamBinderTests
{
    [Fact]
    public void Scan_FindsNativeAndConsolePlaceholders_ButNotTernaryOrCasts()
    {
        var ph = ChParamBinder.Scan("SELECT {id:UInt32}, {m:Map(String, Array(Nullable(UInt8)))}, :name, @x, a ? b : c, x::String, '{no:String}' FROM t");
        Assert.Equal(["id", "m", "name", "x"], ph.Select(p => p.Name));
        Assert.Equal("Map(String, Array(Nullable(UInt8)))", ph[1].Type);
        Assert.Null(ph[2].Type);
    }

    [Fact]
    public void Bind_RewritesConsolePlaceholders_WithTypesFromTheValues()
    {
        using var conn = new ClickHouseConnection("Host=localhost");
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT :i, @d, :s, :n, :dt, {i:UInt8}";
        var result = ChParamBinder.Instance.Bind(cmd, [
            new QueryParam("i", ParamKinds.Int, JsonValue.Create(5)),
            new QueryParam("d", ParamKinds.Decimal, JsonValue.Create("12.345")),
            new QueryParam("s", ParamKinds.String, JsonValue.Create("x")),
            new QueryParam("n", ParamKinds.Null),
            new QueryParam("dt", ParamKinds.Date, JsonValue.Create("2026-03-04")),
        ], new ParamBindCursor());
        Assert.Equal("SELECT {i:UInt8}, {d:Decimal(38, 3)}, {s:String}, {n:Nullable(String)}, {dt:Date}, {i:UInt8}", cmd.CommandText);
        Assert.Equal(5, result.Bound.Count);
        Assert.Empty(result.Missing);
    }

    [Fact]
    public void Bind_ReportsMissingValues()
    {
        using var conn = new ClickHouseConnection("Host=localhost");
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT {a:String}, :b";
        var result = ChParamBinder.Instance.Bind(cmd, [new QueryParam("a", ParamKinds.String, JsonValue.Create("x"))], new ParamBindCursor());
        Assert.Equal(["b"], result.Missing);
    }
}

public sealed class ChTypesTests
{
    [Theory]
    [InlineData("UInt64", "int")]
    [InlineData("Nullable(Int128)", "int")]
    [InlineData("LowCardinality(Nullable(String))", "string")]
    [InlineData("Decimal(12, 2)", "decimal")]
    [InlineData("Decimal64(3)", "decimal")]
    [InlineData("DateTime64(3, 'Asia/Tehran')", "datetime")]
    [InlineData("Date32", "date")]
    [InlineData("UUID", "guid")]
    [InlineData("Enum8('a' = 1)", "string")]
    [InlineData("Array(UInt8)", "json")]
    [InlineData("Map(String, UInt64)", "json")]
    [InlineData("Tuple(a UInt8, b String)", "json")]
    [InlineData("IPv6", "string")]
    [InlineData("Bool", "bool")]
    [InlineData("Float32", "float")]
    [InlineData("SimpleAggregateFunction(sum, UInt64)", "int")]
    [InlineData("AggregateFunction(uniq, UInt64)", "binary")]
    public void KindFor(string type, string kind) => Assert.Equal(kind, ChTypes.KindFor(type));

    [Fact]
    public void ToWire_ConvertsDriverValues()
    {
        Assert.Equal("18446744073709551615", ChTypes.ToWire(ulong.MaxValue, "UInt64"));
        Assert.Equal((byte)5, ChTypes.ToWire((byte)5, "UInt8"));
        Assert.Equal("170141183460469231731687303715884105727", ChTypes.ToWire(BigInteger.Parse("170141183460469231731687303715884105727"), "Int128"));
        Assert.Equal("12.345", ChTypes.ToWire(ClickHouseDecimal.Parse("12.345"), "Decimal64(3)"));
        Assert.Equal("2026-01-02", ChTypes.ToWire(new DateTime(2026, 1, 2), "Date32"));
        Assert.Equal("2026-01-02T10:00:00.5", ChTypes.ToWire(new DateTime(2026, 1, 2, 10, 0, 0, 500), "DateTime64(3)"));
        Assert.Equal("[1,2]", ChTypes.ToWire(new byte[] { 1, 2 }, "Array(UInt8)"));
        Assert.Equal("{\"a\":1}", ChTypes.ToWire(new Dictionary<string, byte> { ["a"] = 1 }, "Map(String, UInt8)"));
        Assert.Equal("[1,\"x\"]", ChTypes.ToWire(Tuple.Create((byte)1, "x"), "Tuple(UInt8, String)"));
        Assert.Equal("[[\"a\",\"b\"],[]]", ChTypes.ToWire(new[] { new[] { "a", "b" }, Array.Empty<string>() }, "Array(Array(String))"));
        Assert.Equal("ab", ChTypes.ToWire("ab\0", "FixedString(3)"));
        Assert.Equal("1.2.3.4", ChTypes.ToWire(System.Net.IPAddress.Parse("1.2.3.4"), "IPv4"));
        Assert.Equal("سلام", ChTypes.ToWire("سلام", "String"));
    }

    [Fact]
    public void Unwrap_And_SplitArgs()
    {
        Assert.Equal("String", ChTypes.Unwrap("LowCardinality(Nullable(String))"));
        Assert.Equal(["String", "Array(Tuple(a, b))", "Enum8('x,y' = 1)"], ChTypes.SplitArgs("String, Array(Tuple(a, b)), Enum8('x,y' = 1)"));
        Assert.True(ChTypes.IsNullable("LowCardinality(Nullable(String))"));
        Assert.False(ChTypes.IsNullable("Array(Nullable(String))"));
    }
}

public sealed class ChErrorsTests
{
    [Fact]
    public void CleanMessage_And_Code()
    {
        const string raw = "Code: 60. DB::Exception: Unknown table expression identifier 'x' in scope SELECT * FROM x. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))";
        Assert.Equal("Unknown table expression identifier 'x' in scope SELECT * FROM x. (UNKNOWN_TABLE)", ChErrors.CleanMessage(raw));
        Assert.Equal((60, "UNKNOWN_TABLE"), ChErrors.CodeOf(raw));
    }

    [Fact]
    public void Locate_UsesThePositionInTheFailingStatement()
    {
        var batch = new SqlBatch("SELECT 1;\n\n  SELEC 2", 10, 5);
        var st = ChSqlText.Split(batch.Sql)[1];
        var (line, col) = ChErrors.Locate(batch, st, "Syntax error: failed at position 1 ('SELEC')");
        Assert.Equal(12, line);
        Assert.Equal(3, col);
    }
}

public sealed class ChClassifierTests
{
    [Theory]
    [InlineData("SHOW TABLES", StatementCategory.Query, "SHOW")]
    [InlineData("DESCRIBE TABLE t", StatementCategory.Query, "DESCRIBE")]
    [InlineData("EXISTS TABLE t", StatementCategory.Query, "EXISTS")]
    [InlineData("OPTIMIZE TABLE t FINAL", StatementCategory.Other, "OPTIMIZE")]
    [InlineData("SYSTEM FLUSH LOGS", StatementCategory.Other, "SYSTEM")]
    [InlineData("KILL QUERY WHERE query_id = 'x'", StatementCategory.Other, "KILL")]
    [InlineData("ALTER TABLE t UPDATE v = 1 WHERE id = 2", StatementCategory.Dml, "UPDATE")]
    [InlineData("ALTER TABLE t DELETE WHERE id = 2", StatementCategory.Dml, "DELETE")]
    [InlineData("ALTER TABLE t DROP PARTITION 202601", StatementCategory.Ddl, "DROP PARTITION")]
    [InlineData("ALTER TABLE t ADD COLUMN c UInt8", StatementCategory.Ddl, "ALTER TABLE")]
    [InlineData("CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(0)", StatementCategory.Ddl, "CREATE DICTIONARY")]
    [InlineData("DETACH TABLE t", StatementCategory.Ddl, "DETACH TABLE")]
    [InlineData("RENAME TABLE a TO b", StatementCategory.Ddl, "RENAME TABLE")]
    [InlineData("SELECT 1", StatementCategory.Query, "SELECT")]
    public void Classify(string sql, StatementCategory category, string kind)
    {
        var c = Assert.Single(StatementClassifier.Classify(sql, Dialect.ClickHouse).Statements);
        Assert.Equal(category, c.Category);
        Assert.Equal(kind, c.Kind);
    }

    [Fact]
    public void Destructive_Mutations()
    {
        Assert.True(StatementClassifier.Classify("ALTER TABLE t DELETE WHERE 1", Dialect.ClickHouse).IsDestructive);
        Assert.False(StatementClassifier.Classify("ALTER TABLE t DELETE WHERE id = 1", Dialect.ClickHouse).IsDestructive);
        Assert.True(StatementClassifier.Classify("ALTER TABLE t DROP PARTITION 202601", Dialect.ClickHouse).IsDestructive);
        Assert.True(StatementClassifier.Classify("SHOW TABLES", Dialect.ClickHouse).IsQueryOnly);
        Assert.Equal(ObjectTypes.Type, StatementClassifier.Classify("DROP DICTIONARY shop.d", Dialect.ClickHouse).Statements[0].Ddl!.ObjectType);
    }
}

public sealed class ChSearchSqlTests
{
    [Theory]
    [InlineData("String", "`c`")]
    [InlineData("Nullable(String)", "`c`")]
    [InlineData("LowCardinality(Nullable(String))", "`c`")]
    [InlineData("UUID", "toString(`c`)")]
    [InlineData("Array(String)", "toString(`c`)")]
    [InlineData("Nullable(Int32)", null)]
    [InlineData("DateTime", null)]
    public void TextExpression(string type, string? expected) =>
        Assert.Equal(expected, SearchSql.TextExpression(Dialect.ClickHouse, "`c`", type));

    [Fact]
    public void DataQuery_UsesIlikeAndAServerParameter()
    {
        var q = SearchSql.BuildDataQuery(Dialect.ClickHouse, "shop", "customers", ["id"], [("id", "UInt32"), ("name", "String")],
            new SearchMatcher("a_b", false, false, false), 100)!;
        Assert.Equal("SELECT `id`, `name` FROM `shop`.`customers` WHERE (`name` ilike {p:String}) LIMIT 100", q.Sql);
        Assert.Equal(@"%a\_b%", q.Parameters[0].Value);
    }
}

public sealed class ChMiscTests
{
    [Fact]
    public void ParseSettings()
    {
        var s = ChConnections.ParseSettings("max_threads=4, readonly = '2'\nmax_memory_usage=1000");
        Assert.Equal("4", s["max_threads"]);
        Assert.Equal("2", s["readonly"]);
        Assert.Equal(3, s.Count);
        Assert.Throws<ArgumentException>(() => ChConnections.ParseSettings("bad key=1"));
    }

    [Fact]
    public void Summary_Parses()
    {
        var s = ChSummary.Parse("""{"read_rows":"10","read_bytes":"80","written_rows":"7","written_bytes":"40","total_rows_to_read":"10","result_rows":"10","result_bytes":"40","elapsed_ns":"2922400"}""")!;
        Assert.Equal(7, s.WrittenRows);
        Assert.Equal(10, s.ReadRows);
        Assert.Null(ChSummary.Parse("not json"));
    }

    [Fact]
    public void Profile_HostAsUrl_GivesProtocolAndPort()
    {
        var p = new ConnectionProfile { ProviderId = "clickhouse", Props = new() { ["host"] = "https://abc.clickhouse.cloud:8443", ["protocol"] = "https" } };
        Assert.Equal("abc.clickhouse.cloud", ChConnections.Host(p));
        Assert.Equal(8443, ChConnections.Port(p));
        Assert.Equal("https", ChConnections.Protocol(p));
    }

    [Fact]
    public void DependencyTargets()
    {
        Assert.Equal(("shop", "daily_sales_agg"), ChDependencyReader.TargetOf("CREATE MATERIALIZED VIEW shop.daily_sales TO shop.daily_sales_agg (`day` Date) AS SELECT 1")!.Value);
        Assert.Equal(("shop", "products"), ChDependencyReader.SourceOf("CREATE DICTIONARY shop.d (id UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'products' DB 'shop')) LAYOUT(FLAT())")!.Value);
        Assert.Null(ChDependencyReader.TargetOf("CREATE MATERIALIZED VIEW shop.mv ENGINE = MergeTree ORDER BY x AS SELECT x FROM t"));
    }

    [Fact]
    public void KeyColumns_FromKeyExpressions()
    {
        Assert.Equal(["order_id", "product_id"], ChCatalogReader.KeyColumns("order_id, product_id", ["order_id", "product_id", "qty"]));
        Assert.Equal(["id"], ChCatalogReader.KeyColumns("tuple(id, toDate(ts))", ["id", "ts"]));
        Assert.Empty(ChCatalogReader.KeyColumns("", ["id"]));
    }

    [Fact]
    public void ObjectTypes_FromEngines()
    {
        Assert.Equal(ObjectTypes.MView, ChCatalogReader.ObjectType("MaterializedView"));
        Assert.Equal(ObjectTypes.View, ChCatalogReader.ObjectType("View"));
        Assert.Equal(ObjectTypes.Type, ChCatalogReader.ObjectType("Dictionary"));
        Assert.Equal(ObjectTypes.Table, ChCatalogReader.ObjectType("ReplacingMergeTree"));
    }

    [Fact]
    public void ParseChecks()
    {
        var checks = Designer.ChDesignerDatabase.ParseChecks("CREATE TABLE shop.t (`id` UInt32, `total` Decimal(12, 2), CONSTRAINT ck_total CHECK total >= 0, CONSTRAINT `ck 2` CHECK (id > 0) AND (id < 10)) ENGINE = MergeTree ORDER BY id");
        Assert.Equal(2, checks.Count);
        Assert.Equal("total >= 0", checks[0].Expression);
        Assert.Equal("ck 2", checks[1].Name);
        Assert.Equal("(id > 0) AND (id < 10)", checks[1].Expression);
    }
}

public sealed class ChPlanTests
{
    public const string Explain = """
        [
          {
            "Plan": {
              "Node Type": "Expression",
              "Description": "(Project names + Projection)",
              "Plans": [
                {
                  "Node Type": "ReadFromMergeTree",
                  "Description": "shop.orders",
                  "Indexes": [
                    { "Type": "MinMax", "Keys": ["order_date"], "Condition": "true", "Initial Parts": 3, "Selected Parts": 3, "Initial Granules": 3, "Selected Granules": 3 },
                    { "Type": "Partition", "Keys": ["toYYYYMM(order_date)"], "Condition": "true", "Initial Parts": 3, "Selected Parts": 3, "Initial Granules": 3, "Selected Granules": 3 },
                    { "Type": "PrimaryKey", "Keys": ["id"], "Condition": "(id in [2, 2])", "Initial Parts": 3, "Selected Parts": 1, "Initial Granules": 3, "Selected Granules": 1 }
                  ]
                }
              ]
            }
          }
        ]
        """;

    [Fact]
    public void Parse_BuildsTheTree_WithIndexFiltering()
    {
        var plan = ChPlanReader.Parse(Explain);
        Assert.Equal("Expression", plan.Root.Op);
        var read = Assert.Single(plan.Root.Children);
        Assert.Equal("ReadFromMergeTree", read.Op);
        Assert.Equal("shop.orders", read.Object);
        Assert.Equal("(id in [2, 2])", read.Predicate);
        Assert.Contains("PrimaryKey (id): parts 1/3, granules 1/3", read.Props!["indexes"]);
        Assert.Empty(read.Warnings);
        Assert.Equal("json", plan.RawFormat);
    }

    [Fact]
    public void Parse_WarnsAboutFullScans()
    {
        var plan = ChPlanReader.Parse("""[{"Plan":{"Node Type":"ReadFromMergeTree","Description":"shop.t","Indexes":[{"Type":"PrimaryKey","Condition":"true","Initial Parts":2,"Selected Parts":2,"Initial Granules":5,"Selected Granules":5}]}}]""");
        Assert.Single(plan.Root.Warnings);
        Assert.NotEmpty(plan.Warnings);
    }

    [Fact]
    public void Script_EstimatedAndActual()
    {
        var reader = new ChPlanReader();
        var est = reader.CreateScript(new DbStudio.Core.Plans.ExplainInput("x", "SELECT 1;", "estimated", Line: 3));
        Assert.Equal(2, est.Batches.Count);
        Assert.StartsWith("EXPLAIN json = 1, indexes = 1, description = 1\nSELECT 1", est.Batches[0].Sql);
        Assert.StartsWith("EXPLAIN PIPELINE", est.Batches[1].Sql);
        var act = reader.CreateScript(new DbStudio.Core.Plans.ExplainInput("x", "INSERT INTO t SELECT 1", "actual"));
        Assert.Equal(2, act.Batches.Count);
        Assert.True(act.Batches[0].Visible);
    }

    [Fact]
    public void Apply_PutsQueryLogStatsOnTheRoot()
    {
        var plan = ChPlanReader.Parse(Explain);
        ChPlanReader.Apply(plan.Root, new ChPlanReader.QueryStats(100, 800, 1, 4096, 12, 1, 1));
        Assert.Equal(1, plan.Root.ActualRows);
        Assert.Equal("100", plan.Root.Props!["readRows"]);
        Assert.Equal(100, plan.Root.Children[0].ActualRows);
    }
}
