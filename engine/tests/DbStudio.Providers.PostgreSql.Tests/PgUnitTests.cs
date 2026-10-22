using System.Collections;
using System.Data.Common;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Providers.PostgreSql.Diagnostics;
using DbStudio.Providers.PostgreSql.Params;
using Npgsql;
using NpgsqlTypes;

namespace DbStudio.Providers.PostgreSql.Tests;

public sealed class PgConnectionStringTests
{
    private static ConnectionProfile Profile(params (string Key, JsonNode? Value)[] props) => new()
    {
        Id = "c_pg",
        ProviderId = "postgresql",
        Props = props.ToDictionary(p => p.Key, p => p.Value),
    };

    [Fact]
    public void Build_DefaultsAndOptions()
    {
        var b = new NpgsqlConnectionStringBuilder(PgConnectionStrings.Build(Profile(("host", "db.local"), ("user", "app")), "secret", pooling: false));
        Assert.Equal("db.local", b.Host);
        Assert.Equal(5432, b.Port);
        Assert.Equal("postgres", b.Database);
        Assert.Equal("app", b.Username);
        Assert.Equal("secret", b.Password);
        Assert.False(b.Pooling);
        Assert.True(b.IncludeErrorDetail);
        Assert.Equal(SslMode.Prefer, b.SslMode);
        Assert.Equal("Rowlit", b.ApplicationName);
        Assert.Equal(15, b.Timeout);
        Assert.Null(b.Options);
    }

    [Fact]
    public void Build_DatabaseOverride_SearchPath_ReadOnly_SslModes()
    {
        var p = Profile(("host", "h"), ("port", 6543), ("database", "shop"), ("user", "u"), ("searchPath", "app, public"),
            ("options", "-c statement_timeout=0"), ("sslMode", "verify-full"));
        p.ReadOnly = true;
        var b = new NpgsqlConnectionStringBuilder(PgConnectionStrings.Build(p, null, pooling: true, database: "other"));
        Assert.Equal("other", b.Database);
        Assert.Equal(6543, b.Port);
        Assert.Equal("app, public", b.SearchPath);
        Assert.Equal("-c statement_timeout=0 -c default_transaction_read_only=on", b.Options);
        Assert.Equal(SslMode.VerifyFull, b.SslMode);
        Assert.True(b.Pooling);

        p.Props["trustServerCertificate"] = true;
        Assert.Equal(SslMode.Require, new NpgsqlConnectionStringBuilder(PgConnectionStrings.Build(p, null, false)).SslMode);
        foreach (var (text, mode) in new[] { ("disable", SslMode.Disable), ("allow", SslMode.Allow), ("require", SslMode.Require), ("verify-ca", SslMode.VerifyCA) })
            Assert.Equal(mode, PgConnectionStrings.ParseSslMode(text));
        Assert.Throws<ArgumentException>(() => PgConnectionStrings.ParseSslMode("bogus"));
    }

    [Fact]
    public void Build_RequiresHostAndValidPort()
    {
        Assert.Throws<ArgumentException>(() => PgConnectionStrings.Build(Profile(("user", "u")), null, false));
        Assert.Throws<ArgumentException>(() => PgConnectionStrings.Build(Profile(("host", "h"), ("port", 70000)), null, false));
    }

    [Fact]
    public void Provider_ContractValues()
    {
        var p = new PostgreSqlProvider();
        Assert.Equal("postgresql", p.Id);
        Assert.Equal(Dialect.PgSql, p.Dialect);
        Assert.Equal("pgsql", CoreJson.ToWire(p.Dialect));
        Assert.Equal("lower", p.Identifiers.CaseFolding);
        Assert.Equal("pg-prepare", p.Diagnostics!.EngineName);
        Assert.Contains(p.FormSpec.Fields, f => f.Key == "host" && f.Required);
        Assert.Contains(p.FormSpec.Fields, f => f.Key == "password" && f.Type == "password");
        Assert.Equal("17.2", PostgreSqlProvider.ProductVersion("17.2 (Debian 17.2-1.pgdg120+1)"));
        Assert.Equal(16, PostgreSqlProvider.MajorVersion("16.4"));
        Assert.Equal(0, PostgreSqlProvider.MajorVersion(null));
    }

    [Fact]
    public async Task Test_UnreachableServer_ReturnsAnError()
    {
        var result = await new PostgreSqlProvider().TestAsync(Profile(("host", "127.0.0.1"), ("port", 1), ("user", "u"), ("connectTimeout", 2)), "x", CancellationToken.None);
        Assert.False(result.Ok);
        Assert.Equal("PROVIDER_ERROR", result.Error!.Code);
        Assert.False(string.IsNullOrWhiteSpace(result.Error.Message));
    }
}

public sealed class PgTypesTests
{
    [Theory]
    [InlineData("integer", ColumnKinds.Int)]
    [InlineData("bigint", ColumnKinds.Int)]
    [InlineData("numeric(12,2)", ColumnKinds.Decimal)]
    [InlineData("double precision", ColumnKinds.Float)]
    [InlineData("boolean", ColumnKinds.Bool)]
    [InlineData("character varying(20)", ColumnKinds.String)]
    [InlineData("uuid", ColumnKinds.Guid)]
    [InlineData("jsonb", ColumnKinds.Json)]
    [InlineData("bytea", ColumnKinds.Binary)]
    [InlineData("date", ColumnKinds.Date)]
    [InlineData("time with time zone", ColumnKinds.Time)]
    [InlineData("timestamp without time zone", ColumnKinds.DateTime)]
    [InlineData("timestamp(3) with time zone", ColumnKinds.DateTimeOffset)]
    [InlineData("interval", ColumnKinds.String)]
    [InlineData("integer[]", ColumnKinds.String)]
    [InlineData("_int4", ColumnKinds.String)]
    [InlineData("point", ColumnKinds.Other)]
    [InlineData("int4range", ColumnKinds.Other)]
    [InlineData("inet", ColumnKinds.String)]
    [InlineData("public.order_status", ColumnKinds.String)]
    [InlineData("refcursor", ColumnKinds.String)]
    public void KindFor_TypeNames(string type, string kind) => Assert.Equal(kind, PgTypes.KindFor(type, typeof(object)));

    [Fact]
    public void ArrayLiteral_QuotesAndNests()
    {
        Assert.Equal("{1,2,NULL}", PgTypes.ArrayLiteral(new int?[] { 1, 2, null }));
        Assert.Equal("{vip,\"a b\",\"q\\\"x\",\"\",\"NULL\"}", PgTypes.ArrayLiteral(new[] { "vip", "a b", "q\"x", "", "NULL" }));
        Assert.Equal("{{1,2},{3,4}}", PgTypes.ArrayLiteral(new[,] { { 1, 2 }, { 3, 4 } }));
        Assert.Equal("{t,f}", PgTypes.ArrayLiteral(new[] { true, false }));
        Assert.Equal("{\"\\\\xdead\"}", PgTypes.ArrayLiteral(new[] { new byte[] { 0xde, 0xad } }));
    }

    [Fact]
    public void IntervalText_PostgresStyle()
    {
        Assert.Equal("1 year 2 mons 3 days 04:05:06.5", PgTypes.IntervalText(new NpgsqlInterval(14, 3, ((4 * 3600 + 5 * 60 + 6) * 1_000_000L) + 500_000)));
        Assert.Equal("1 year 2 days 03:04:05", PgTypes.IntervalText(new NpgsqlInterval(12, 2, (3 * 3600 + 4 * 60 + 5) * 1_000_000L)));
        Assert.Equal("00:00:00", PgTypes.IntervalText(new NpgsqlInterval(0, 0, 0)));
        Assert.Equal("-1 days", PgTypes.IntervalText(new NpgsqlInterval(0, -1, 0)));
        Assert.Equal("1 mon -00:00:01", PgTypes.IntervalText(new NpgsqlInterval(1, 0, -1_000_000)));
    }

    [Fact]
    public void ToWire_ProviderValues()
    {
        Assert.Equal("1010", PgTypes.ToWire(new BitArray(new[] { true, false, true, false })));
        Assert.Equal("\"k\"=>\"v\", \"n\"=>NULL", PgTypes.HstoreText(new Dictionary<string, string?> { ["k"] = "v", ["n"] = null }));
        Assert.Equal("2026-01-05T10:00:00+00:00", PgTypes.ToWire(new DateTimeOffset(2026, 1, 5, 11, 0, 0, TimeSpan.FromHours(1))));
        Assert.Equal("2026-01-05T10:00:00+00:00", PgTypes.ToWire(new DateTime(2026, 1, 5, 10, 0, 0, DateTimeKind.Utc)));
        Assert.Equal("{1,2}", PgTypes.ToWire(new[] { 1, 2 }));
        Assert.Equal("(1.5,2)", PgTypes.ToWire(new NpgsqlPoint(1.5, 2)));
    }

    [Theory]
    [InlineData("character varying(20)", "varchar(20)")]
    [InlineData("character varying", "varchar")]
    [InlineData("character(10)", "char(10)")]
    [InlineData("timestamp with time zone", "timestamptz")]
    [InlineData("timestamp(3) with time zone", "timestamptz(3)")]
    [InlineData("timestamp without time zone", "timestamp")]
    [InlineData("time without time zone", "time")]
    [InlineData("time with time zone", "timetz")]
    [InlineData("bit varying(5)", "varbit(5)")]
    [InlineData("character varying(20)[]", "varchar(20)[]")]
    [InlineData("text[]", "text[]")]
    [InlineData("numeric(12,2)", "numeric(12,2)")]
    [InlineData("double precision", "double precision")]
    public void ShortTypeName(string formatType, string expected) => Assert.Equal(expected, PgTypes.ShortTypeName(formatType));
}

public sealed class PgErrorMappingTests
{
    private static PostgresException Pg(string sqlState, string message, int position = 0, string? detail = null, string? hint = null, string? where = null) =>
        new(message, "ERROR", "ERROR", sqlState, detail, hint, position, 0, null, where, null, null, null, null, null, null, null, null);

    [Fact]
    public void Position_MapsToDocumentLineAndColumn()
    {
        var batch = new SqlBatch("SELECT *\nFROM public.customers\nWHERE nmae = 1", 10, 5);
        var pos = batch.Sql.IndexOf("nmae", StringComparison.Ordinal) + 1;
        var e = PgErrors.FromException(Pg("42703", "column \"nmae\" does not exist", pos, hint: "Perhaps you meant \"name\"."), batch, p => p - 1);
        Assert.Equal(("42703", 12, 7), (e.Code, e.Line, e.Col));
        Assert.Equal("column \"nmae\" does not exist", e.Message);
        Assert.Equal("HINT: Perhaps you meant \"name\".", e.Detail);

        // First line: shifted by the batch column.
        var one = PgErrors.FromException(Pg("42P01", "relation \"nope\" does not exist", 15), new SqlBatch("SELECT * FROM nope", 3, 4), p => p - 1);
        Assert.Equal((3, 18), (one.Line, one.Col));
    }

    [Fact]
    public void NoPosition_UsesFirstCodeLine_AndDetailCarriesContext()
    {
        var e = PgErrors.FromException(Pg("P0001", "boom", detail: "d", where: "PL/pgSQL function f() line 3 at RAISE"), new SqlBatch("\n-- c\nCALL f()", 7, 1));
        Assert.Equal(9, e.Line);
        Assert.Null(e.Col);
        Assert.Equal("DETAIL: d\nCONTEXT: PL/pgSQL function f() line 3 at RAISE", e.Detail);
        Assert.True(PgErrors.IsConnectionLossState("57P01"));
        Assert.True(PgErrors.IsConnectionLossState("08006"));
        Assert.False(PgErrors.IsConnectionLossState("42P01"));
    }

    [Fact]
    public void Notices_SeverityAndText()
    {
        var n = new PostgresNotice("Report for customer Alice", "NOTICE", "NOTICE", "00000", null, null, 0, 0, null, "PL/pgSQL function get_customer_report(integer) line 5 at RAISE",
            null, null, null, null, null, null, null, null);
        Assert.Equal(MessageSeverity.Info, PgErrors.NoticeSeverity(n));
        Assert.Equal("Report for customer Alice\nCONTEXT: PL/pgSQL function get_customer_report(integer) line 5 at RAISE", PgErrors.NoticeText(n));
        Assert.Equal(MessageSeverity.Warning, PgErrors.NoticeSeverity(new PostgresNotice("w", "WARNING", "WARNING", "01000")));
    }

    [Fact]
    public void ProviderError_KeepsSqlState()
    {
        var e = PgErrors.ToProviderError(Pg("28P01", "password authentication failed for user \"x\""));
        Assert.Equal("PROVIDER_ERROR", e.Code);
        Assert.StartsWith("SQLSTATE 28P01", e.Detail);
    }

    [Fact]
    public void Session_MapsPositionThroughStatementAndRewrite()
    {
        // Batch "SELECT :a; SELECT nmae FROM t WHERE x = :b" → global "SELECT $1; SELECT nmae FROM t WHERE x = $2"; statement 2 sent as "... = $1".
        const string original = "SELECT :a; SELECT nmae FROM t WHERE x = :b";
        var global = PgSqlText.Rewrite(original).Text;
        var statements = PgSqlText.Split(global);
        var cmd2 = new NpgsqlBatchCommand();
        var sent = new PgSession.SentBatch(global,
        [
            new PgSession.SentStatement(new NpgsqlBatchCommand(), statements[0].Start, statements[0].Text(global), "SELECT $1"),
            new PgSession.SentStatement(cmd2, statements[1].Start, statements[1].Text(global), PgSession.Renumber(statements[1].Text(global)).Text),
        ]);
        var offset = PgSession.MapServerPosition(sent, cmd2, original, "SELECT nmae".IndexOf("nmae", StringComparison.Ordinal) + 1);
        Assert.Equal(original.IndexOf("nmae", StringComparison.Ordinal), offset);
    }
}

public sealed class PgParamBinderTests
{
    private static QueryParam P(string name, string kind, object? value, string? direction = null) =>
        new(name, kind, value is null ? null : JsonValue.Create(value), direction);

    [Fact]
    public void Bind_RewritesToPositional_InSlotOrder()
    {
        using var cmd = new NpgsqlCommand("SELECT * FROM t WHERE a = :a AND b = @b AND c = $1 AND d = :a AND meta ? 'k'");
        var bound = PgParamBinder.Instance.Bind(cmd, [P("1", "int", 5), P("a", "string", "x"), P("b", "guid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"), P("unused", "int", 1)],
            new ParamBindCursor());
        Assert.Equal("SELECT * FROM t WHERE a = $2 AND b = $3 AND c = $1 AND d = $2 AND meta ? 'k'", cmd.CommandText);
        Assert.Empty(bound.Missing);
        Assert.Equal(3, cmd.Parameters.Count);
        Assert.All(cmd.Parameters, p => Assert.Equal("", p.ParameterName));
        Assert.Equal((NpgsqlDbType.Integer, (object)5), (cmd.Parameters[0].NpgsqlDbType, cmd.Parameters[0].Value!));
        Assert.Equal((NpgsqlDbType.Unknown, (object)"x"), (cmd.Parameters[1].NpgsqlDbType, cmd.Parameters[1].Value!));
        Assert.Equal(NpgsqlDbType.Uuid, cmd.Parameters[2].NpgsqlDbType);
    }

    [Fact]
    public void Bind_GapsGetUntypedNull_AndMissingAreReported()
    {
        using var cmd = new NpgsqlCommand("SELECT $3, :x");
        var bound = PgParamBinder.Instance.Bind(cmd, [P("3", "decimal", "1.5")], new ParamBindCursor());
        Assert.Equal("SELECT $3, $1", cmd.CommandText);
        Assert.Equal(3, cmd.Parameters.Count);
        Assert.Equal(["x"], bound.Missing);
        Assert.Equal(NpgsqlDbType.Numeric, cmd.Parameters[2].NpgsqlDbType);
        Assert.Equal(DBNull.Value, cmd.Parameters[1].Value);
    }

    [Fact]
    public void Types_DatesBigIntsAndRejections()
    {
        Assert.Equal(NpgsqlDbType.Bigint, PgParamBinder.CreateParameter(P("a", "int", 5_000_000_000L)).NpgsqlDbType);
        Assert.Equal((NpgsqlDbType.Date, (object)new DateOnly(2026, 3, 4)), (PgParamBinder.CreateParameter(P("a", "date", "2026-03-04")).NpgsqlDbType, PgParamBinder.CreateParameter(P("a", "date", "2026-03-04")).Value!));
        Assert.Equal(NpgsqlDbType.Timestamp, PgParamBinder.CreateParameter(P("a", "datetime", "2026-03-04T10:00:00")).NpgsqlDbType);
        Assert.Equal(NpgsqlDbType.TimestampTz, PgParamBinder.CreateParameter(P("a", "datetime", "2026-03-04T10:00:00Z")).NpgsqlDbType);
        Assert.Equal(NpgsqlDbType.TimestampTz, PgParamBinder.CreateParameter(P("a", "datetimeoffset", "2026-03-04T10:00:00+02:00")).NpgsqlDbType);
        Assert.Equal(NpgsqlDbType.Boolean, PgParamBinder.CreateParameter(P("a", "bool", true)).NpgsqlDbType);
        Assert.Equal(NpgsqlDbType.Unknown, PgParamBinder.CreateParameter(P("a", "null", null)).NpgsqlDbType);
        Assert.Contains("REF CURSOR", Assert.Throws<EngineException>(() => PgParamBinder.CreateParameter(P("c", "refcursor", null))).Message);
        Assert.Contains("OUT", Assert.Throws<EngineException>(() => PgParamBinder.CreateParameter(P("c", "int", null, "out"))).Message);
    }

    [Fact]
    public void FindPlaceholders_NamesAndPositions()
    {
        var ph = PgParamBinder.Instance.FindPlaceholders("SELECT $1, :id -- :no\n, '@no' , @p");
        Assert.Equal([("1", 7), ("id", 11), ("p", 32)], ph.Select(p => (p.Name!, p.Offset)));
    }
}

public sealed class PgDiagnosticsGateTests
{
    [Theory]
    [InlineData("SELECT * FROM nope", true)]
    [InlineData("WITH x AS (SELECT 1) SELECT * FROM x", true)]
    [InlineData("VALUES (1)", true)]
    [InlineData("TABLE countries", true)]
    [InlineData("INSERT INTO t VALUES (1)", true)]
    [InlineData("UPDATE t SET a = 1", true)]
    [InlineData("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", true)]
    [InlineData("CREATE TABLE x(", false)]
    [InlineData("DROP TABLE t", false)]
    [InlineData("DO $$ BEGIN PERFORM 1; END $$", false)]
    [InlineData("CALL p()", false)]
    [InlineData("COPY t FROM '/etc/passwd'", false)]
    [InlineData("EXPLAIN ANALYZE DELETE FROM t", false)]
    [InlineData("SET search_path = x", false)]
    [InlineData("BEGIN", false)]
    [InlineData("SELECT 1 INTO newtable", false)]
    [InlineData("VACUUM t", false)]
    public void OnlyQueriesAndDmlAreSent(string sql, bool sent) => Assert.Equal(sent, PgPrepareDiagnostics.IsSafeToPrepare(sql));

    [Fact]
    public void Candidates_RewritePlaceholders_AndStopAtTheBudget()
    {
        var c = Assert.Single(PgPrepareDiagnostics.Candidates("CREATE TABLE t (a int); SELECT * FROM t WHERE a = :a"));
        Assert.Equal("SELECT * FROM t WHERE a = $1", c.Rewrite.Text);
        var many = string.Join(";\n", Enumerable.Range(1, 40).Select(i => $"SELECT {i}"));
        Assert.Equal(PgPrepareDiagnostics.MaxStatements, PgPrepareDiagnostics.Candidates(many).Count);
    }

    [Fact]
    public void ToDiagnostic_MapsPrepareOffsetToDocument()
    {
        const string doc = "SELECT 1;\nSELECT * FROM nope";
        var c = PgPrepareDiagnostics.Candidates(doc)[1];
        var pg = new PostgresException("relation \"nope\" does not exist", "ERROR", "ERROR", "42P01", null, null,
            PgPrepareDiagnostics.Prefix.Length + 15, 0, null, null, null, null, null, null, null, null, null, null);
        var d = PgPrepareDiagnostics.ToDiagnostic(doc, c, pg);
        Assert.Equal((2, 15, 2, 19, "42P01"), (d.Line, d.Col, d.EndLine, d.EndCol, d.Code));
    }

    [Fact]
    public async Task NoProfile_NoDiagnostics() =>
        Assert.Empty(await new PgPrepareDiagnostics().AnalyzeAsync("SELECT * FROM nope", null, null, CancellationToken.None));
}

public sealed class PgCatalogMappingTests
{
    private static PgCatalogReader.RawRoutine R(string kind, string result, string[] names, string[] modes, string[] types, int defaults = 0, bool set = false, uint rel = 0) =>
        new(1, "f", kind, set, result, null, "sql", defaults, names, modes, types, rel, rel == 0 ? "b" : "c", result);

    [Fact]
    public void Function_ParametersDefaultsAndReturn()
    {
        var (type, ps, cols) = PgCatalogReader.MapRoutine(R("f", "numeric", ["amount", "rate"], ["i", "i"], ["numeric", "numeric"], defaults: 1), null);
        Assert.Equal(ObjectTypes.Func, type);
        Assert.Equal([("amount", "in", false), ("rate", "in", true), ("", "return", false)], ps.Select(p => (p.Name, p.Direction, p.HasDefault)));
        Assert.Empty(cols);
    }

    [Fact]
    public void TableFunction_ColumnsFromTableArgs()
    {
        var (type, ps, cols) = PgCatalogReader.MapRoutine(R("f", "TABLE(id integer, total numeric)", ["p_customer", "id", "total"], ["i", "t", "t"],
            ["integer", "integer", "numeric"], set: true), null);
        Assert.Equal(ObjectTypes.TableFunc, type);
        Assert.Equal(["p_customer", ""], ps.Select(p => p.Name));
        Assert.Equal(["id", "total"], cols.Select(c => c.Name));
    }

    [Fact]
    public void Procedure_InOutAndVariadic_NoReturn()
    {
        var (type, ps, _) = PgCatalogReader.MapRoutine(R("p", "", ["p_order", "inserted", "rest"], ["i", "b", "v"], ["integer", "integer", "integer[]"]), null);
        Assert.Equal(ObjectTypes.Proc, type);
        Assert.Equal([("p_order", "in"), ("inserted", "inout"), ("VARIADIC rest", "in")], ps.Select(p => (p.Name, p.Direction)));
    }

    [Fact]
    public void SetofTable_UsesRowColumns_AndScalarSetofNamesTheFunction()
    {
        var rows = new List<CatalogColumn> { new("id", "integer", true, false) };
        Assert.Equal(["id"], PgCatalogReader.MapRoutine(R("f", "SETOF orders", [], [], [], set: true, rel: 42), rows).Columns.Select(c => c.Name));
        var scalar = PgCatalogReader.MapRoutine(R("f", "SETOF integer", [], [], [], set: true), null);
        Assert.Equal(("f", "integer"), (scalar.Columns.Single().Name, scalar.Columns.Single().TypeText));
        Assert.Equal("$1", PgCatalogReader.MapRoutine(R("f", "int", [], ["i"], ["integer"]), null).Parameters[0].Name);
    }

    [Fact]
    public void Queries_AreBalanced()
    {
        foreach (var (name, sql) in PgCatalogQueries.All.Concat(Designer.PgDesignerDatabase.AllQueries))
        {
            var depth = 0;
            foreach (var t in PgSqlText.Tokenize(sql))
            {
                if (t.IsPunct('(')) depth++;
                else if (t.IsPunct(')')) depth--;
                Assert.True(depth >= 0, name);
            }
            Assert.True(depth == 0, name);
            Assert.Single(PgSqlText.Split(sql));
        }
    }

    [Fact]
    public void FkActions() =>
        Assert.Equal(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"], new[] { "a", "r", "c", "n", "d" }.Select(PgCatalogReader.Action));

    [Fact]
    public void DdlGenerator_TableViewSequenceType()
    {
        var table = new PgTableDefinition("public", "customers", "r", false, "Registered customers",
        [
            new("id", "integer", false, null, new PgIdentity(false, 1, 1), null, null, null),
            new("name", "varchar(100)", false, null, null, null, "\"C\"", "Display name"),
            new("total", "numeric(12,2)", true, null, null, "(qty * 1.0)", null, null),
            new("status", "public.order_status", false, "'new'::order_status", null, null, null, null),
        ],
        [new("pk_customers", "p", "PRIMARY KEY (id)", ["id"])],
        [new("pk_customers", true, true, "btree", "CREATE UNIQUE INDEX pk_customers ON public.customers USING btree (id)", null, ["id"], [], [false], true),
         new("ix_name", false, false, "btree", "CREATE INDEX ix_name ON public.customers USING btree (name)", null, ["name"], [], [false], false)],
        [], null, null, null, null, 5, null);
        Assert.Equal(
            "CREATE TABLE public.customers (\n    id integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n    name varchar(100) COLLATE \"C\" NOT NULL,\n" +
            "    total numeric(12,2) GENERATED ALWAYS AS (qty * 1.0) STORED,\n    status public.order_status DEFAULT 'new'::order_status NOT NULL,\n" +
            "    CONSTRAINT pk_customers PRIMARY KEY (id)\n);\nCREATE INDEX ix_name ON public.customers USING btree (name);\n" +
            "COMMENT ON TABLE public.customers IS 'Registered customers';\nCOMMENT ON COLUMN public.customers.name IS 'Display name';\n",
            PgDdlGenerator.Generate(table));

        var view = table with { Kind = "v", ViewDefinition = " SELECT 1 AS one;", Options = ["check_option=local"], Indexes = [], Columns = [], Comment = null };
        Assert.Equal("CREATE OR REPLACE VIEW public.customers AS\nSELECT 1 AS one\nWITH LOCAL CHECK OPTION;\n", PgDdlGenerator.ViewDdl(view));
        Assert.StartsWith("CREATE MATERIALIZED VIEW public.customers AS\nSELECT 1 AS one\nWITH DATA;", PgDdlGenerator.ViewDdl(view with { Kind = "m", Options = [] }));

        Assert.Equal("CREATE SEQUENCE public.s\n    AS bigint\n    START WITH 1000\n    INCREMENT BY 1\n    MINVALUE 1\n    MAXVALUE 9223372036854775807\n    CACHE 1\n    NO CYCLE;\n",
            PgDdlGenerator.SequenceDdl("public.s", new PgSequenceDefinition("bigint", 1000, 1, 1, long.MaxValue, false, 1, null, null)));
        Assert.Equal("CREATE TYPE public.e AS ENUM ('new', 'paid');\n",
            PgDdlGenerator.TypeDdl("public.e", new PgTypeDefinition("e", "e", null, ["new", "paid"], null, false, null, 0, null, [], [])));
        Assert.Equal("CREATE DOMAIN public.d AS text\n    CONSTRAINT d_check CHECK (VALUE ~ '@'::text);\nCOMMENT ON DOMAIN public.d IS 'mail';\n",
            PgDdlGenerator.TypeDdl("public.d", new PgTypeDefinition("d", "d", "mail", [], "text", false, null, 0, null, [("d_check", "CHECK (VALUE ~ '@'::text)")], [])));
    }
}
