using System.Data.Common;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.Snowflake.Params;
using Snowflake.Data.Client;

namespace DbStudio.Providers.Snowflake.Tests;

public sealed class ConnectionStringTests
{
    private static ConnectionProfile Profile(params (string Key, object? Value)[] props) => new()
    {
        Id = "c1", Name = "sf", ProviderId = "snowflake",
        Props = props.ToDictionary(p => p.Key, p => p.Value is null ? null : (JsonNode?)JsonValue.Create(p.Value)),
    };

    [Theory]
    [InlineData("xy12345.eu-central-1", null, "xy12345.eu-central-1", null)]
    [InlineData("https://ORG-ACCT.snowflakecomputing.com/", null, "ORG-ACCT", null)]
    [InlineData("xy12345.eu-central-1.snowflakecomputing.com", null, "xy12345.eu-central-1", null)]
    [InlineData("xy12345.eu-central-1.privatelink.snowflakecomputing.com", null, "xy12345.eu-central-1.privatelink", "xy12345.eu-central-1.privatelink.snowflakecomputing.com")]
    [InlineData("org-acct", "https://custom.host.example/", "org-acct", "custom.host.example")]
    public void Account_identifiers_are_normalised(string account, string? host, string expected, string? expectedHost)
    {
        var (a, h) = SnowflakeConnectionStrings.NormalizeAccount(account, host);
        Assert.Equal(expected, a);
        Assert.Equal(expectedHost, h);
    }

    [Fact]
    public void Password_auth_keeps_the_secret_out_of_the_string()
    {
        var b = SnowflakeConnectionStrings.Build(Profile(("account", "org-acct"), ("user", "JSMITH"), ("warehouse", "COMPUTE_WH"), ("database", "SHOP"),
            ("schema", "PUBLIC"), ("role", "SYSADMIN"), ("queryTag", "my;tag")), "p;ss", pooling: false);
        Assert.DoesNotContain("p;ss", b.ConnectionString);
        Assert.NotNull(b.Password);
        Assert.Contains("account=org-acct;authenticator=snowflake;user=JSMITH", b.ConnectionString);
        Assert.Contains("db=SHOP;schema=PUBLIC;warehouse=COMPUTE_WH;role=SYSADMIN", b.ConnectionString);
        Assert.Contains("query_tag=my;;tag", b.ConnectionString); // ';' doubled
        Assert.Contains("poolingEnabled=false", b.ConnectionString);
        Assert.Contains("CLIENT_TELEMETRY_ENABLED=false", b.ConnectionString);
        Assert.Contains("application=Rowlit", b.ConnectionString);
    }

    [Fact]
    public void Each_authenticator_validates_its_fields()
    {
        Assert.Throws<ArgumentException>(() => SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("user", "u")), null, false));
        Assert.Throws<ArgumentException>(() => SnowflakeConnectionStrings.Build(Profile(("user", "u")), "p", false));
        Assert.Throws<ArgumentException>(() => SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("user", "u"), ("authenticator", "snowflake_jwt")), null, false));
        Assert.Throws<ArgumentException>(() => SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("authenticator", "oauth")), null, false));
        Assert.Throws<ArgumentException>(() => SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("authenticator", "ldap")), null, false));

        var key = Path.Combine(Path.GetTempPath(), "rowlit-sf-test-key.p8");
        File.WriteAllText(key, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n");
        try
        {
            var jwt = SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("user", "u"), ("authenticator", "snowflake_jwt"),
                ("privateKeyFile", key), ("privateKeyPassphrase", "pa;ss")), null, false);
            Assert.Contains("authenticator=snowflake_jwt", jwt.ConnectionString);
            Assert.Contains($"private_key_file={key}", jwt.ConnectionString);
            Assert.Contains("private_key_pwd=pa;;ss", jwt.ConnectionString);
            Assert.Contains("private_key_pwd=***", SnowflakeConnectionStrings.Masked(jwt));
        }
        finally { File.Delete(key); }

        var sso = SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("user", "me@corp.example"), ("authenticator", "externalbrowser")), null, false);
        Assert.Contains("client_store_temporary_credential=true", sso.ConnectionString);
        Assert.Null(sso.Password);

        var oauth = SnowflakeConnectionStrings.Build(Profile(("account", "a"), ("authenticator", "oauth"), ("token", "tok")), null, false);
        Assert.NotNull(oauth.Token);
        Assert.DoesNotContain("tok", oauth.ConnectionString.Replace("authenticator=oauth", ""));
    }

    [Fact]
    public void Secrets_are_restored_from_the_store_for_sessions()
    {
        var secrets = new SnowflakeSecrets((id, key) => id == "c1" && key == "token" ? "stored-token" : null);
        var p = secrets.Hydrate(Profile(("account", "a"), ("authenticator", "oauth")));
        Assert.Equal("stored-token", p.GetString("token"));
        var kept = Profile(("account", "a"), ("token", "typed"));
        Assert.Same(kept, secrets.Hydrate(kept));
    }

    [Fact]
    public void Form_spec_has_auth_dependent_fields()
    {
        var spec = SnowflakeConnectionStrings.FormSpec;
        Assert.Equal("snowflake_jwt", spec.Fields.Single(f => f.Key == "privateKeyFile").VisibleWhen!["authenticator"]);
        Assert.Equal("password", spec.Fields.Single(f => f.Key == "privateKeyPassphrase").Type);
        Assert.Equal("password", spec.Fields.Single(f => f.Key == "token").Type);
        Assert.Equal(["account", "user", "authenticator"], spec.Fields.Take(3).Select(f => f.Key));
    }
}

public sealed class ErrorTests
{
    [Fact]
    public void Positions_map_to_document_lines_and_columns()
    {
        var ex = new SnowflakeDbException("42000", 1003,
            "SQL compilation error:\nsyntax error line 2 at position 5 unexpected 'FORM'.", "01b7c2d4-0306-8a21-0000-00041c2b9e5f");
        var e = SnowflakeErrors.FromException(ex, new SqlBatch("SELECT 1\nFROM FORM t", 10, 3));
        Assert.Equal("001003", e.Code);
        Assert.Equal(11, e.Line);
        Assert.Equal(6, e.Col);
        Assert.DoesNotContain("VendorCode", e.Message);
        Assert.Contains("query id 01b7c2d4-0306-8a21-0000-00041c2b9e5f", e.Detail);
        Assert.Equal(1003, e.ProviderCode);
        var first = SnowflakeErrors.FromException(new SnowflakeDbException("42000", 904, "SQL compilation error: error line 1 at position 7\ninvalid identifier 'FOO'", ""),
            new SqlBatch("SELECT FOO", 4, 9));
        Assert.Equal((4, 16), (first.Line!.Value, first.Col!.Value));
    }

    [Fact]
    public void Driver_wrappers_are_removed()
    {
        Assert.Equal("Object 'X' does not exist or not authorized.",
            SnowflakeErrors.CleanMessage("Error: Object 'X' does not exist or not authorized. SqlState: 02000, VendorCode: 2003, QueryId: 01b7"));
        Assert.Equal("000606", SnowflakeErrors.Code(606));
        Assert.True(SnowflakeErrors.IsCancellation(new SnowflakeDbException("57014", 604, "SQL execution canceled", "")));
        Assert.True(SnowflakeErrors.IsCancellation(new OperationCanceledException()));
        var login = SnowflakeErrors.ToProviderError(new AggregateException(new SnowflakeDbException("08001", 390100, "Incorrect username or password was specified.", "")));
        Assert.Equal("390100", login.Code);
        Assert.Contains("Check user and password", login.Message);
        Assert.Equal(ErrorCodes.Validation, SnowflakeErrors.ToProviderError(new ArgumentException("Account is required")).Code);
    }
}

public sealed class ParamBinderTests
{
    private static DbCommand Command(string sql) => new SnowflakeDbCommand { CommandText = sql };

    private static QueryParam P(string name, string kind, object? value) =>
        new(name, kind, value is null ? null : JsonValue.Create(value));

    [Fact]
    public void Variant_paths_stages_and_file_columns_are_not_placeholders()
    {
        var ph = SnowflakeParamBinder.Instance.FindPlaceholders(
            "SELECT v:customer.name, t.v:a::string, $1, \"Col\":x FROM @stage t WHERE id = :id AND n = ? AND c = :1 AND x::int > 0");
        Assert.Equal(["id", null, "1"], ph.Select(p => p.Name));
    }

    [Fact]
    public void Named_and_positional_placeholders_become_numeric_binds()
    {
        var cmd = Command("SELECT * FROM t WHERE a = :id OR b = :ID OR c = ? OR d = :missing");
        var bound = SnowflakeParamBinder.Instance.Bind(cmd, [P("id", ParamKinds.Int, 7), P("1", ParamKinds.String, "x")], new ParamBindCursor());
        Assert.Equal("SELECT * FROM t WHERE a = :1 OR b = :1 OR c = :2 OR d = :missing", cmd.CommandText);
        Assert.Equal(2, cmd.Parameters.Count);
        Assert.Equal("1", cmd.Parameters[0].ParameterName);
        Assert.Equal(7L, cmd.Parameters[0].Value);
        Assert.Equal("x", cmd.Parameters[1].Value);
        Assert.Equal(["missing"], bound.Missing);
    }

    [Fact]
    public void Out_parameters_are_refused()
    {
        var cmd = Command("CALL p(:x)");
        var ex = Assert.Throws<EngineException>(() => SnowflakeParamBinder.Instance.Bind(cmd, [new QueryParam("x", ParamKinds.Int, null, "out")], new ParamBindCursor()));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }
}

public sealed class SqlTextTests
{
    [Theory]
    [InlineData("ORDERS", "ORDERS")]
    [InlineData("Orders", "\"Orders\"")]
    [InlineData("ORDER", "\"ORDER\"")]
    [InlineData("MY TABLE", "\"MY TABLE\"")]
    [InlineData("A\"B", "\"A\"\"B\"")]
    public void Quoting_follows_upper_case_folding(string name, string expected) => Assert.Equal(expected, SnowflakeSql.Quote(name));

    [Fact]
    public void Literals_escape_quotes_and_backslashes() => Assert.Equal("'it''s a \\\\ path'", SnowflakeSql.Literal("it's a \\ path"));

    [Theory]
    [InlineData("shop", "SHOP")]
    [InlineData("\"Mixed\"", "Mixed")]
    public void Names_normalise(string input, string expected) => Assert.Equal(expected, SnowflakeSql.Normalize(input));

    [Fact]
    public void Arguments_and_signatures_parse()
    {
        var (args, returns) = SnowflakeSql.ParseArguments("ARCHIVE_ORDERS(DATE, [BOOLEAN], NUMBER(10, 2) DEFAULT) RETURN TABLE (A NUMBER)");
        Assert.Equal(["DATE", "BOOLEAN", "NUMBER(10, 2)"], args);
        Assert.Equal("TABLE (A NUMBER)", returns);
        Assert.Equal([("ORDER_ID", "NUMBER", false), ("NOTE", "VARCHAR", true)],
            SnowflakeSql.ParseSignature("(ORDER_ID NUMBER, NOTE VARCHAR DEFAULT 'x')").Select(p => (p.Name, p.TypeText, p.HasDefault)));
    }

    [Fact]
    public void Scripting_blocks_stay_one_statement()
    {
        const string sql = """
            BEGIN TRANSACTION;
            DECLARE
              c1 CURSOR FOR SELECT ID FROM ORDERS;
              total NUMBER DEFAULT 0;
            BEGIN
              FOR r IN c1 DO
                IF (r.ID > 2) THEN
                  total := total + 1;
                END IF;
              END FOR;
              CREATE TABLE IF NOT EXISTS T (ID INT);
              RETURN total;
            END;
            SELECT $$ a; b $$, 'x\';y';
            COMMIT
            """;
        var st = SnowflakeSql.SplitStatements(sql);
        Assert.Equal(4, st.Count);
        Assert.Equal("BEGIN TRANSACTION", st[0].Text);
        Assert.StartsWith("DECLARE", st[1].Text);
        Assert.EndsWith("END", st[1].Text);
        Assert.StartsWith("SELECT $$", st[2].Text);
        Assert.Equal("COMMIT", st[3].Text);
        Assert.Equal(2, st[1].Line);
    }

    [Theory]
    [InlineData("SHOW TABLES IN SCHEMA S", StatementCategory.Query, "SHOW")]
    [InlineData("desc table t", StatementCategory.Query, "DESCRIBE")]
    [InlineData("LIST @stage", StatementCategory.Query, "LIST")]
    [InlineData("USE WAREHOUSE COMPUTE_WH", StatementCategory.Session, "USE")]
    [InlineData("ALTER SESSION SET QUERY_TAG = 'x'", StatementCategory.Session, "ALTER SESSION")]
    [InlineData("PUT file:///tmp/a.csv @~", StatementCategory.Dml, "PUT")]
    [InlineData("COPY INTO t FROM @stage", StatementCategory.Dml, "COPY")]
    [InlineData("REMOVE @stage/a.csv", StatementCategory.Dml, "REMOVE")]
    [InlineData("CALL refresh_totals(1)", StatementCategory.Other, "CALL")]
    [InlineData("EXECUTE IMMEDIATE $$ SELECT 1 $$", StatementCategory.Block, "EXECUTE IMMEDIATE")]
    [InlineData("BEGIN", StatementCategory.Transaction, "BEGIN")]
    [InlineData("BEGIN TRANSACTION NAME t1", StatementCategory.Transaction, "BEGIN")]
    [InlineData("BEGIN SELECT 1; END", StatementCategory.Block, "BEGIN")]
    [InlineData("CREATE OR REPLACE TRANSIENT TABLE s.t (id INT)", StatementCategory.Ddl, "CREATE TABLE")]
    [InlineData("CREATE SECURE VIEW v AS SELECT 1", StatementCategory.Ddl, "CREATE VIEW")]
    [InlineData("UNDROP TABLE t", StatementCategory.Ddl, "UNDROP TABLE")]
    public void Snowflake_statement_heads_classify(string sql, StatementCategory category, string kind)
    {
        var c = StatementClassifier.Classify(sql, Dialect.Snowflake).Statements[0];
        Assert.Equal(category, c.Category);
        Assert.Equal(kind, c.Kind);
    }

    [Fact]
    public void Transient_table_ddl_target_is_found_and_reads_stay_read_only()
    {
        var c = StatementClassifier.Classify("CREATE OR REPLACE TRANSIENT TABLE SHOP.PUBLIC.T (ID INT)", Dialect.Snowflake);
        var target = Assert.Single(c.DdlTargets);
        Assert.Equal(("SHOP", "PUBLIC", "T", ObjectTypes.Table), (target.Database, target.Schema, target.Name, target.ObjectType));
        Assert.True(StatementClassifier.IsQueryOnly("SHOW WAREHOUSES", Dialect.Snowflake));
        Assert.True(StatementClassifier.IsQueryOnly("SELECT v:a FROM t", Dialect.Snowflake));
        Assert.False(StatementClassifier.IsQueryOnly("PUT file:///a @~", Dialect.Snowflake));
        Assert.Equal(2, StatementClassifier.Classify("BEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3", Dialect.Snowflake).Statements.Count);
    }
}

public sealed class TypeTests
{
    [Theory]
    [InlineData("{\"type\":\"FIXED\",\"precision\":38,\"scale\":0,\"nullable\":false}", "NUMBER(38,0)", false)]
    [InlineData("{\"type\":\"FIXED\",\"precision\":12,\"scale\":2,\"nullable\":true}", "NUMBER(12,2)", true)]
    [InlineData("{\"type\":\"TEXT\",\"length\":16777216,\"nullable\":true,\"fixed\":false}", "VARCHAR", true)]
    [InlineData("{\"type\":\"TEXT\",\"length\":10,\"nullable\":true,\"fixed\":true}", "CHAR(10)", true)]
    [InlineData("{\"type\":\"REAL\",\"nullable\":true}", "FLOAT", true)]
    [InlineData("{\"type\":\"TIMESTAMP_TZ\",\"precision\":0,\"scale\":3,\"nullable\":true}", "TIMESTAMP_TZ(3)", true)]
    [InlineData("{\"type\":\"BINARY\",\"length\":16,\"nullable\":true}", "BINARY(16)", true)]
    [InlineData("NUMBER(10,0)", "NUMBER(10,0)", true)]
    public void Show_columns_json_becomes_type_text(string json, string type, bool nullable) =>
        Assert.Equal((type, nullable), SnowflakeTypes.FromShowColumnsJson(json));

    [Theory]
    [InlineData("FIXED", 38, 0, ColumnKinds.Int)]
    [InlineData("FIXED", 12, 2, ColumnKinds.Decimal)]
    [InlineData("REAL", null, null, ColumnKinds.Float)]
    [InlineData("TEXT", null, null, ColumnKinds.String)]
    [InlineData("TIMESTAMP_NTZ", null, 9, ColumnKinds.DateTime)]
    [InlineData("TIMESTAMP_LTZ", null, 9, ColumnKinds.DateTimeOffset)]
    [InlineData("TIMESTAMP_TZ", null, 9, ColumnKinds.DateTimeOffset)]
    [InlineData("VARIANT", null, null, ColumnKinds.Json)]
    [InlineData("GEOGRAPHY", null, null, ColumnKinds.Json)]
    [InlineData("VECTOR", null, null, ColumnKinds.Json)]
    [InlineData("BINARY", null, null, ColumnKinds.Binary)]
    [InlineData("DECFLOAT", null, null, ColumnKinds.Decimal)]
    public void Result_types_map_to_wire_kinds(string sfType, int? precision, int? scale, string kind) =>
        Assert.Equal(kind, SnowflakeTypes.KindFor(sfType, precision, scale));

    [Fact]
    public void Sql_names_of_result_columns()
    {
        Assert.Equal("NUMBER(38,0)", SnowflakeTypes.SqlName("FIXED", null, 38, 0));
        Assert.Equal("VARCHAR(20)", SnowflakeTypes.SqlName("TEXT", 20, null, null));
        Assert.Equal("VARCHAR", SnowflakeTypes.SqlName("TEXT", 16777216, null, null));
        Assert.Equal("TIMESTAMP_NTZ", SnowflakeTypes.SqlName("TIMESTAMP_NTZ", null, 0, 9));
    }

    [Fact]
    public void Hidden_bookkeeping_results_are_recognised()
    {
        Assert.True(SnowflakeResultReader.IsCountResult(["number of rows inserted"]));
        Assert.True(SnowflakeResultReader.IsCountResult(["number of rows updated", "number of multi-joined rows updated"]));
        Assert.False(SnowflakeResultReader.IsCountResult(["NUMBER"]));
        Assert.True(SnowflakeResultReader.IsStatusResult(["status"]));
        Assert.False(SnowflakeResultReader.IsStatusResult(["status", "x"]));
    }

    [Fact]
    public void Server_info_names_account_and_region()
    {
        var info = SnowflakeProvider.ServerInfoOf(DbStudio.Logs.Sql.SqlRowSet.Of(["VERSION", "ACCOUNT", "REGION", "USER_NAME", "DATABASE_NAME"],
            ["9.33.1", "XY12345", "AWS_EU_CENTRAL_1", "SHOP", "SHOP"]), "xy12345.snowflakecomputing.com");
        Assert.Equal(("Snowflake 9.33.1", "9.33.1", "XY12345 (AWS_EU_CENTRAL_1)", "SHOP", "SHOP"),
            (info.Version, info.ProductVersion, info.ServerName, info.User, info.Database));
    }
}
