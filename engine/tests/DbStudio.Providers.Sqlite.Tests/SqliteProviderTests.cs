using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Tests;

/// <summary>SQLite-specific behaviour beyond the conformance suite (attached databases, diagnostics, error positions, DDL).</summary>
public sealed class SqliteProviderTests(SqliteFixture fixture) : IClassFixture<SqliteFixture>
{
    private readonly SqliteProvider _provider = (SqliteProvider)fixture.Provider;

    private static async Task<RecordingSink> RunAsync(Core.Providers.IDbSession session, string sql, int line = 1, int col = 1)
    {
        var sink = new RecordingSink();
        await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, line, col)], 1000, true, false, "statement"), sink, CancellationToken.None);
        return sink;
    }

    [Fact]
    public void FormSpec_HasPathReadOnlyCreateIfMissing()
    {
        var keys = _provider.FormSpec.Fields.Select(f => f.Key).ToList();
        Assert.Equal(["path", "readOnly", "createIfMissing", "attach"], keys);
        var path = _provider.FormSpec.Fields[0];
        Assert.True(path.Required);
        Assert.Equal("file", path.Type);
        Assert.Equal("*.db;*.sqlite;*.sqlite3", path.FileFilter);
        Assert.Equal("sqlite", _provider.Id);
        Assert.Equal('"', _provider.Identifiers.QuoteOpen);
        Assert.Contains("SELECT", _provider.Identifiers.ReservedWords);
    }

    [Fact]
    public void ConnectionString_Modes()
    {
        var p = SqliteFixture.CreateProfile(@"C:\data\x.db");
        Assert.Contains("Mode=ReadWriteCreate", _provider.BuildConnectionString(p, null));
        Assert.Contains("Pooling=False", _provider.BuildConnectionString(p, null));
        p.Props["readOnly"] = true;
        Assert.Contains("Mode=ReadOnly", _provider.BuildConnectionString(p, null));
        p.Props["path"] = ":memory:";
        Assert.Contains("Mode=Memory", _provider.BuildConnectionString(p, null));
    }

    [Fact]
    public async Task TestConnection_NotADatabase_Fails()
    {
        var file = Path.Combine(fixture.Directory, "not-a-db.sqlite");
        await File.WriteAllTextAsync(file, "this is definitely not a sqlite database file, just some text....................................................");
        var result = await _provider.TestAsync(SqliteFixture.CreateProfile(file), null, CancellationToken.None);
        Assert.False(result.Ok);
        Assert.Equal("SQLITE_NOTADB", result.Error!.Code);
    }

    [Fact]
    public async Task ReadOnlyMode_RejectsWrites()
    {
        var profile = SqliteFixture.CreateProfile(fixture.DbPath);
        profile.Props["readOnly"] = true;
        await using var session = await _provider.OpenSessionAsync(profile, null, new SessionOptions("s_ro", null, TransactionMode.Auto, false), CancellationToken.None);
        var sink = await RunAsync(session, "INSERT INTO countries (id, name) VALUES (99, 'X')");
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("SQLITE_READONLY", error.Code);
        Assert.Equal(8, error.ProviderCode);
    }

    [Fact]
    public async Task SyntaxError_IsLocatedOnTheToken()
    {
        await using var session = await fixture.OpenSessionAsync();
        var sink = await RunAsync(session, "SELECT id\n  FROM countries\n WHERE id = = 1", line: 20, col: 5);
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("SQLITE_ERROR", error.Code);
        Assert.StartsWith("near \"=\": syntax error", error.Message);
        Assert.Equal(22, error.Line);
        Assert.NotNull(error.Col);
    }

    [Fact]
    public async Task ManualTransaction_SeesOwnWrites_SessionStillQueriesCatalog()
    {
        await using var session = await fixture.OpenSessionAsync(TransactionMode.Manual);
        var sink = await RunAsync(session, "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id ORDER BY o.id");
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(ShopSchema.OrderCount, rs.RowCount);
        Assert.Equal("customers", rs.Columns[0].Table);
        Assert.True(session.TxOpen);
        await session.RollbackAsync(CancellationToken.None);
    }

    [Fact]
    public async Task BooleanDeclaredColumns_AreBooleans()
    {
        await using var session = await fixture.OpenSessionAsync();
        await RunAsync(session, "CREATE TABLE IF NOT EXISTS flags (id INTEGER PRIMARY KEY, active BOOLEAN)");
        await RunAsync(session, "INSERT OR REPLACE INTO flags VALUES (1, 1), (2, 0)");
        var sink = await RunAsync(session, "SELECT active FROM flags ORDER BY id");
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(ColumnKinds.Bool, rs.Columns[0].Kind);
        Assert.Equal(new object?[] { true, false }, rs.Rows.Select(r => r[0]));
        await RunAsync(session, "DROP TABLE flags");
    }

    [Fact]
    public async Task Catalog_AttachedDatabase_IsASchema()
    {
        await using var reader = await fixture.OpenCatalogAsync();
        var schemas = await reader.ListSchemasAsync(null, CancellationToken.None);
        Assert.Equal(["main", "archive"], schemas.Select(s => s.Name));
        Assert.Equal(1, schemas[1].ObjectCount);
        Assert.Equal(["main", "archive"], await reader.ListDatabasesAsync(CancellationToken.None));
        Assert.Equal("main", await reader.GetCurrentDatabaseAsync(CancellationToken.None));

        var archive = await reader.LoadSchemaAsync(null, "ARCHIVE", CancellationToken.None);
        Assert.Equal("archive", archive.Name);
        var t = Assert.Single(archive.Objects);
        Assert.Equal("archived_orders", t.Name);
        Assert.Equal(["id", "customer_id", "total", "archived_at"], t.Columns.Select(c => c.Name));

        var ex = await Assert.ThrowsAsync<EngineException>(() => reader.LoadSchemaAsync(null, "nope", CancellationToken.None));
        Assert.Equal(404, ex.Status);
    }

    [Fact]
    public async Task Catalog_TriggersFkNamesAndRowidAlias()
    {
        await using var reader = await fixture.OpenCatalogAsync();
        var main = await reader.LoadSchemaAsync(null, "main", CancellationToken.None);
        Assert.Contains(main.Objects, o => o is { Type: ObjectTypes.Trigger, Name: "trg_orders_total_check" });
        Assert.DoesNotContain(main.Objects, o => o.Name == "ix_orders_customer"); // indexes are not catalog objects

        var customers = main.Objects.Single(o => o.Name == "customers");
        Assert.Equal("fk_customers_countries", Assert.Single(customers.ForeignKeys).Name); // parsed from CREATE TABLE
        Assert.Equal("main", customers.ForeignKeys[0].RefSchema);

        var orders = main.Objects.Single(o => o.Name == "orders");
        Assert.Equal(1, orders.Columns[0].Flags); // INTEGER PRIMARY KEY = rowid alias
        var lines = main.Objects.Single(o => o.Name == "order_lines");
        Assert.All(lines.Columns, c => Assert.Equal(0, c.Flags & 1)); // WITHOUT ROWID: no rowid alias
        Assert.Equal(["orders", "products"], lines.ForeignKeys.Select(f => f.RefTable));
    }

    [Fact]
    public async Task Catalog_DetailsIndexesTriggersEstimate()
    {
        await using var reader = await fixture.OpenCatalogAsync();
        var details = await reader.GetObjectDetailsAsync(new ObjectRef(null, "main", "ORDERS", ObjectTypes.Table), CancellationToken.None);
        Assert.Equal("orders", details.Ref.Name);
        Assert.Contains(details.Indexes, i => i.Name == "ix_orders_customer" && i.Columns.SequenceEqual(["customer_id"]) && !i.Unique);
        Assert.Equal(["trg_orders_total_check"], details.Triggers);
        Assert.Equal(ShopSchema.OrderCount, details.RowCountEstimate);
        Assert.Contains(details.ReferencedBy, r => r.Table == "order_lines");

        var lines = await reader.GetObjectDetailsAsync(new ObjectRef(null, "main", "order_lines", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(lines.Indexes, i => i.IsPrimaryKey && i.Columns.SequenceEqual(["order_id", "product_id"]));
        Assert.Null(lines.RowCountEstimate); // WITHOUT ROWID and no sqlite_stat1
    }

    [Fact]
    public async Task Ddl_TableIncludesIndexesAndTriggers()
    {
        await using var reader = await fixture.OpenCatalogAsync();
        var ddl = await reader.GetDdlAsync(new ObjectRef(null, "main", "orders", ObjectTypes.Table), CancellationToken.None);
        Assert.Equal("stored", ddl.Source);
        var create = ddl.Ddl.IndexOf("CREATE TABLE orders", StringComparison.Ordinal);
        var index = ddl.Ddl.IndexOf("CREATE INDEX ix_orders_customer", StringComparison.Ordinal);
        var trigger = ddl.Ddl.IndexOf("CREATE TRIGGER trg_orders_total_check", StringComparison.Ordinal);
        Assert.True(create >= 0 && index > create && trigger > index, ddl.Ddl);

        var gen = new SqliteDdlGenerator().GenerateTableDdl(
            new ObjectRef(null, "main", "orders", ObjectTypes.Table),
            await reader.GetObjectDetailsAsync(new ObjectRef(null, "main", "orders", ObjectTypes.Table), CancellationToken.None));
        Assert.Contains("\"id\" INTEGER PRIMARY KEY", gen);
        Assert.Contains("FOREIGN KEY (\"customer_id\") REFERENCES \"customers\" (\"id\")", gen);
        Assert.Contains("CREATE INDEX \"ix_orders_customer\" ON \"orders\" (\"customer_id\");", gen);

        // The generated DDL is valid SQLite.
        await using var c = new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "CREATE TABLE customers (id INTEGER PRIMARY KEY);" + gen;
        await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task Diagnostics_SyntaxAndSchemaErrors()
    {
        var diag = _provider.Diagnostics!;
        Assert.Equal("sqlite-prepare", diag.EngineName);
        var sql = "SELECT * FROM customers;\nSELEC 1;\nSELECT nope FROM orders;\nSELECT * FROM archive.archived_orders;\nSELECT * FROM missing_table";
        var result = await diag.AnalyzeAsync(sql, fixture.Profile, null, CancellationToken.None);
        Assert.Equal(3, result.Count);
        Assert.Equal((2, 1, 2, 6), (result[0].Line, result[0].Col, result[0].EndLine, result[0].EndCol));
        Assert.Contains("syntax error", result[0].Message);
        Assert.Equal((3, 8), (result[1].Line, result[1].Col));
        Assert.Equal("no such column: nope", result[1].Message);
        Assert.Equal((5, 15), (result[2].Line, result[2].Col));
        Assert.All(result, d => Assert.Equal("error", d.Severity));
    }

    [Fact]
    public async Task Diagnostics_SeeObjectsCreatedEarlierInTheDocument_WithoutTouchingTheDatabase()
    {
        var sql = "CREATE TABLE brand_new (a INTEGER);\nINSERT INTO brand_new (a) VALUES (1);\nDROP TABLE customers;\nSELECT * FROM customers;";
        var result = await _provider.Diagnostics!.AnalyzeAsync(sql, fixture.Profile, null, CancellationToken.None);
        var d = Assert.Single(result);
        Assert.Equal(4, d.Line);
        Assert.Contains("no such table", d.Message);

        await using var reader = await fixture.OpenCatalogAsync();
        var main = await reader.LoadSchemaAsync(null, "main", CancellationToken.None);
        Assert.DoesNotContain(main.Objects, o => o.Name == "brand_new");
        Assert.Contains(main.Objects, o => o.Name == "customers");
    }

    [Fact]
    public async Task Diagnostics_WithoutProfile_ReportsOnlySyntax()
    {
        var result = await _provider.Diagnostics!.AnalyzeAsync("SELECT * FROM t;\nSELECT FROM;\nSELECT 'unterminated", null, null, CancellationToken.None);
        Assert.Equal(2, result.Count);
        Assert.Equal(2, result[0].Line);
        Assert.Equal(3, result[1].Line);
        Assert.Empty(await _provider.Diagnostics.AnalyzeAsync("  ", null, null, CancellationToken.None));
    }

    [Fact]
    public void QualifyCreate_InsertsSchema()
    {
        Assert.Equal("CREATE TABLE \"archive\".t (a)", SqlitePrepareDiagnostics.QualifyCreate("CREATE TABLE t (a)", "archive"));
        Assert.Equal("CREATE UNIQUE INDEX IF NOT EXISTS \"archive\".\"ix\" ON t (a)", SqlitePrepareDiagnostics.QualifyCreate("CREATE UNIQUE INDEX IF NOT EXISTS \"ix\" ON t (a)", "archive"));
        Assert.Equal("CREATE VIEW x.v AS SELECT 1", SqlitePrepareDiagnostics.QualifyCreate("CREATE VIEW x.v AS SELECT 1", "archive"));
    }

    [Fact]
    public void ForeignKeyNames_ParsesTableAndColumnConstraints()
    {
        var names = SqliteCatalogReader.ForeignKeyNames(
            "CREATE TABLE t (a INTEGER CONSTRAINT fk_a REFERENCES x(id), b INT, c INT, CONSTRAINT \"fk bc\" FOREIGN KEY (b, c) REFERENCES y(p, q), FOREIGN KEY (a) REFERENCES z)");
        Assert.Equal("fk_a", names["a"]);
        Assert.Equal("fk bc", names["b,c"]);
        Assert.Equal(2, names.Count);
    }

    [Fact]
    public void ErrorLocator_FindsTokens()
    {
        Assert.Equal(19, SqliteErrorLocator.Locate("no such table: main.nope", "SELECT * FROM main.nope"));
        Assert.Equal(9, SqliteErrorLocator.Locate("no such column: c.Nmae", "SELECT c.Nmae FROM customers c"));
        Assert.Null(SqliteErrorLocator.Locate("database is locked", "SELECT 1"));
    }

    /// <summary>Writes engine/tests/fixtures/shop.sqlite (+ archive.sqlite) for manual UI testing (ignored by git).</summary>
    [Fact]
    public async Task WritesShopFixtureFiles()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "engine", "tests"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var fixtures = Path.Combine(dir!.FullName, "engine", "tests", "fixtures");
        Directory.CreateDirectory(fixtures);
        var shop = Path.Combine(fixtures, "shop.sqlite");
        var archive = Path.Combine(fixtures, "archive.sqlite");
        await SqliteFixture.CreateArchiveAsync(archive);

        var profile = SqliteFixture.CreateProfile(shop, archive);
        await using (var session = await _provider.OpenSessionAsync(profile, null, new SessionOptions("s_fixture", null, TransactionMode.Auto, false), CancellationToken.None))
        {
            foreach (var sql in ShopSchema.Seed(Dialect.Sqlite))
            {
                var sink = await RunAsync(session, sql);
                Assert.Empty(sink.Errors);
            }
        }
        SqliteConnection.ClearAllPools();
        Assert.True(new FileInfo(shop).Length > 0);
    }
}
