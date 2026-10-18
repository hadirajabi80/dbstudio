using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Sample;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.Sqlite.Designer;
using DbStudio.Providers.Sqlite.Plans;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Tests.M15;

public sealed class SqliteScripterGoldenTests
{
    private static readonly SqliteDdlScripter Scripter = new();

    /// <summary>A rebuild context: the Orders table has an index, a trigger, a referencing view and another table's trigger.</summary>
    private static DdlScriptContext RebuildContext => new("3.46.1", "main",
    [
        new DependentObject("trigger", "TR_Orders_Audit", "CREATE TRIGGER TR_Orders_Audit AFTER UPDATE ON Orders BEGIN UPDATE Orders SET Note = Note WHERE Id = NEW.Id; END", true),
        new DependentObject("view", "OrderSummary", "CREATE VIEW OrderSummary AS SELECT CustomerId, sum(Total) AS Total, max(Note) AS LastNote FROM Orders GROUP BY CustomerId", false),
    ]);

    public static TheoryData<string> CaseNames => new(DesignerCases.All(Dialect.Sqlite).Select(c => c.Name));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Script_MatchesGolden(string name)
    {
        var c = DesignerCases.All(Dialect.Sqlite).Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, RebuildContext);
        Golden.Match($"sqlite_{name}.sql", Golden.Render(script));
    }

    [Fact]
    public void Rebuild_PreservesIndexesTriggersAndViews_Golden()
    {
        var orders = DesignerCases.Orders(Dialect.Sqlite);
        var desired = orders with
        {
            Columns = orders.Columns.Select(c => c.Name == "Note" ? c with { Name = "Remarks", Type = "VARCHAR(500)" } : c).ToList(),
            Indexes = [.. orders.Indexes, new IndexModel { Name = "IX_Orders_Date", Columns = [new IndexColumnModel("OrderDate", true)], Filter = "Status <> 'cancelled'" }],
        };
        var script = Scripter.ScriptTable(orders, desired, RebuildContext);
        Assert.True(script.RebuildRequired);
        Assert.True(script.Transactional);
        var sql = script.Statements.Select(s => s.Sql).ToList();
        Assert.Equal("PRAGMA foreign_keys = OFF", sql[0]);
        Assert.Equal("PRAGMA foreign_keys = ON", sql[^1]);
        Assert.Equal("PRAGMA foreign_key_check", sql[^2]);
        Assert.Contains(sql, s => s.StartsWith("DROP VIEW IF EXISTS \"OrderSummary\"", StringComparison.Ordinal));
        Assert.Contains(sql, s => s.Contains("max(Remarks)", StringComparison.Ordinal)); // the view follows the column rename
        Assert.Contains(sql, s => s.StartsWith("CREATE TRIGGER TR_Orders_Audit", StringComparison.Ordinal) && s.Contains("Remarks = Remarks", StringComparison.Ordinal));
        Assert.Contains(sql, s => s == "CREATE INDEX \"IX_Orders_Date\" ON \"Orders\" (\"OrderDate\" DESC) WHERE Status <> 'cancelled'");
        Golden.Match("sqlite_rebuild_with_dependents.sql", Golden.Render(script));
    }

    [Fact]
    public void NativeAlters_AreUsedWhenPossible()
    {
        var orders = DesignerCases.Orders(Dialect.Sqlite);
        Assert.False(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "add_column").Desired, DdlScriptContext.Default).RebuildRequired);
        Assert.False(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "rename_column").Desired, DdlScriptContext.Default).RebuildRequired);
        Assert.False(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "drop_column").Desired, DdlScriptContext.Default).RebuildRequired);
        Assert.False(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "indexes").Desired, DdlScriptContext.Default).RebuildRequired);
        // Old servers: RENAME COLUMN needs 3.25, DROP COLUMN 3.35.
        Assert.True(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "rename_column").Desired, new DdlScriptContext("3.24.0")).RebuildRequired);
        Assert.True(Scripter.ScriptTable(orders, DesignerCases.All(Dialect.Sqlite).Single(c => c.Name == "drop_column").Desired, new DdlScriptContext("3.34.1")).RebuildRequired);
        // A column used by an index cannot be dropped natively.
        var dropIndexed = orders with { Columns = orders.Columns.Where(c => c.Name != "CustomerId").ToList(), ForeignKeys = [], Indexes = [] };
        Assert.True(Scripter.ScriptTable(orders, dropIndexed, DdlScriptContext.Default).RebuildRequired);
        // NOT NULL without default, CURRENT_TIMESTAMP default, or a column in the middle need a rebuild.
        Assert.True(Scripter.ScriptTable(orders, orders with { Columns = [.. orders.Columns, new TableColumnModel { Name = "X", Type = "TEXT", Nullable = false }] }, DdlScriptContext.Default).RebuildRequired);
        Assert.True(Scripter.ScriptTable(orders, orders with { Columns = [.. orders.Columns, new TableColumnModel { Name = "X", Type = "DATETIME", Default = "CURRENT_TIMESTAMP" }] }, DdlScriptContext.Default).RebuildRequired);
        Assert.True(Scripter.ScriptTable(orders, orders with { Columns = [new TableColumnModel { Name = "X", Type = "TEXT" }, .. orders.Columns] }, DdlScriptContext.Default).RebuildRequired);
    }

    [Fact]
    public void Autoincrement_IsAColumnConstraint()
    {
        var t = new TableModel
        {
            Name = "T",
            Columns = [new TableColumnModel { Name = "Id", Type = "INTEGER", Nullable = false, Autoincrement = true }, new TableColumnModel { Name = "V", Type = "TEXT" }],
            PrimaryKey = new PrimaryKeyModel { Name = "PK_T", Columns = ["Id"] },
        };
        var sql = Scripter.ScriptTable(null, t, DdlScriptContext.Default).Statements[0].Sql;
        Assert.Contains("\"Id\" INTEGER CONSTRAINT \"PK_T\" PRIMARY KEY AUTOINCREMENT NOT NULL", sql);
        Assert.DoesNotContain("PRIMARY KEY (", sql);
    }

    [Fact]
    public void Rebuild_OfAutoincrementTable_KeepsTheSequence_Golden()
    {
        var t = new TableModel
        {
            Name = "Customers",
            Columns = [new TableColumnModel { Id = "Id", Name = "Id", Type = "INTEGER", Nullable = false, Autoincrement = true }, new TableColumnModel { Id = "Phone", Name = "Phone", Type = "TEXT" }],
            PrimaryKey = new PrimaryKeyModel { Name = "PK_Customers", Columns = ["Id"] },
        };
        var desired = t with { Columns = t.Columns.Select(c => c.Name == "Phone" ? c with { Type = "VARCHAR(40)" } : c).ToList() };
        var script = Scripter.ScriptTable(t, desired, new DdlScriptContext("3.46.1", "main", []));
        Assert.True(script.RebuildRequired);
        var sql = script.Statements.Select(s => s.Sql).ToList();
        var keep = sql.FindIndex(s => s.StartsWith("UPDATE \"sqlite_sequence\" SET seq = MAX(seq, COALESCE((SELECT seq FROM \"sqlite_sequence\" WHERE name = 'Customers'), 0))", StringComparison.Ordinal));
        var insert = sql.FindIndex(s => s.StartsWith("INSERT INTO \"sqlite_sequence\"", StringComparison.Ordinal));
        var drop = sql.IndexOf("DROP TABLE \"Customers\"");
        Assert.True(insert >= 0 && insert < keep && keep < drop, string.Join("\n", sql)); // read while the old table still exists
        Golden.Match("sqlite_rebuild_autoincrement.sql", Golden.Render(script));

        // No AUTOINCREMENT, no sequence handling.
        var plain = t with { Columns = t.Columns.Select(c => c with { Autoincrement = false }).ToList() };
        var plainScript = Scripter.ScriptTable(plain, plain with { Columns = desired.Columns.Select(c => c with { Autoincrement = false }).ToList() }, DdlScriptContext.Default);
        Assert.DoesNotContain(plainScript.Statements, s => s.Sql.Contains("sqlite_sequence", StringComparison.Ordinal));
    }

    [Fact]
    public void Views_DropAndCreate()
    {
        // Renamed: CREATE under the new name (never dropped first, so an existing object of that name fails), then drop the old.
        var s = Scripter.ScriptView(new ViewDefinition(null, "V2", "V1", "SELECT 1 AS a;", new ViewOptions(CheckOption: true)), DdlScriptContext.Default);
        Assert.True(s.Transactional);
        Assert.Equal(["CREATE VIEW \"V2\" AS\nSELECT 1 AS a", "DROP VIEW IF EXISTS \"V1\""], s.Statements.Select(x => x.Sql));
        Assert.Single(s.Warnings);
        Golden.Match("sqlite_view_rename.sql", Golden.Render(s));

        // New view: a plain CREATE.
        var created = Scripter.ScriptView(new ViewDefinition(null, "V2", null, "SELECT 1 AS a", new ViewOptions()), DdlScriptContext.Default);
        Assert.Equal(["CREATE VIEW \"V2\" AS\nSELECT 1 AS a"], created.Statements.Select(x => x.Sql));

        // Editing the same view (case-insensitive): SQLite has no OR REPLACE, so it is dropped and recreated.
        var edited = Scripter.ScriptView(new ViewDefinition(null, "V1", "v1", "SELECT 2 AS a", new ViewOptions()), DdlScriptContext.Default);
        Assert.Equal(["DROP VIEW IF EXISTS \"v1\"", "CREATE VIEW \"V1\" AS\nSELECT 2 AS a"], edited.Statements.Select(x => x.Sql));
    }

    [Theory]
    [InlineData("0", "0")]
    [InlineData("'x'", "'x'")]
    [InlineData("CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP")]
    [InlineData("datetime('now')", "(datetime('now'))")]
    [InlineData("(1 + 2)", "(1 + 2)")]
    [InlineData("-1.5e3", "-1.5e3")]
    public void DefaultSql_ParenthesizesExpressions(string input, string expected) => Assert.Equal(expected, SqliteDdlScripter.DefaultSql(input));
}

public sealed class SqliteParserTests
{
    [Fact]
    public void Parse_ConstraintNamesChecksAndOptions()
    {
        var p = SqliteCreateTableParser.Parse("""
            CREATE TABLE "T" (
              Id INTEGER CONSTRAINT pk_t PRIMARY KEY AUTOINCREMENT,
              Name TEXT COLLATE NOCASE NOT NULL CONSTRAINT uq_name UNIQUE CHECK (length(Name) > 0),
              Total REAL GENERATED ALWAYS AS (Id * 2) STORED,
              Parent INTEGER REFERENCES "T" (Id) ON DELETE CASCADE,
              CONSTRAINT ck_total CHECK (Total >= 0),
              CONSTRAINT fk_x FOREIGN KEY (Parent, Id) REFERENCES Other (A, B),
              UNIQUE (Name COLLATE NOCASE DESC, Total)
            ) WITHOUT ROWID, STRICT
            """);
        Assert.Equal("pk_t", p.PrimaryKeyName);
        Assert.True(p.Columns["Id"].Autoincrement);
        Assert.Equal("NOCASE", p.Columns["Name"].Collation);
        Assert.Equal("Id * 2", p.Columns["Total"].GeneratedExpression);
        Assert.True(p.Columns["Total"].GeneratedStored);
        Assert.Equal([("uq_name", "Name"), (null, "Name,Total")], p.Uniques.Select(u => (u.Name, string.Join(",", u.Columns))));
        Assert.Equal([(null, "length(Name) > 0"), ("ck_total", "Total >= 0")], p.Checks.Select(c => (c.Name, c.Expression)));
        Assert.Equal(2, p.ForeignKeys.Count);
        Assert.Equal(("fk_x", "Other", "A,B"), (p.ForeignKeys[1].Name, p.ForeignKeys[1].RefTable, string.Join(",", p.ForeignKeys[1].RefColumns)));
        Assert.True(p.WithoutRowid);
        Assert.True(p.Strict);
    }

    [Fact]
    public void IndexFilterAndViewBody()
    {
        Assert.Equal("Status <> 'x' AND (a OR b)", SqliteCreateTableParser.IndexFilter("CREATE INDEX i ON t (a, (b + 1)) WHERE Status <> 'x' AND (a OR b);"));
        Assert.Null(SqliteCreateTableParser.IndexFilter("CREATE INDEX i ON t (a)"));
        Assert.Equal("SELECT a AS \"x\" FROM t", SqliteCreateTableParser.ViewBody("CREATE VIEW v (x) AS SELECT a AS \"x\" FROM t;"));
    }
}

/// <summary>Round trips on a real database (docs/PLAN-M1.5.md: GET table → mutate → script → apply → GET table equals desired).</summary>
public sealed class SqliteDesignerRoundTripTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-designer", Guid.NewGuid().ToString("N"));
    private ConnectionProfile _profile = new();
    private readonly SqliteDesignerDatabase _db = new();
    private readonly SqliteDdlScripter _scripter = new();

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var path = Path.Combine(_dir, "shop.sqlite");
        await SampleDatabase.CreateAsync(path, CancellationToken.None);
        _profile = new ConnectionProfile { Id = "c_rt", Name = "rt", ProviderId = "sqlite", Props = new() { ["path"] = path } };
    }

    public Task DisposeAsync()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, true); } catch (IOException) { }
        return Task.CompletedTask;
    }

    private async Task<TableModel> ApplyAsync(TableModel original, TableModel desired, bool expectRebuild)
    {
        var context = await _db.GetScriptContextAsync(_profile, null, null, "main", original.Name, CancellationToken.None);
        var script = _scripter.ScriptTable(original, desired, context);
        Assert.Equal(expectRebuild, script.RebuildRequired);
        var result = await _db.ApplyAsync(_profile, null, new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), true), CancellationToken.None);
        Assert.True(result.Ok);
        var after = await _db.ReadTableAsync(_profile, null, null, "main", desired.Name, CancellationToken.None);
        var diff = TableDiff.Compute(SqliteDdlScripter.Normalize(after), SqliteDdlScripter.Normalize(desired));
        Assert.True(diff.IsEmpty, "Round trip differs: " + string.Join("; ", diff.Changes.Select(c => $"{c.Kind} {c.Target} {c.Detail}")));
        return after;
    }

    private async Task<long> ScalarAsync(string sql)
    {
        await using var c = new SqliteConnection($"Data Source={_profile.GetString("path")};Pooling=False");
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(await cmd.ExecuteScalarAsync());
    }

    [Fact]
    public async Task ReadTable_ReturnsTheSampleModel()
    {
        var t = await _db.ReadTableAsync(_profile, null, null, null, "orderlines", CancellationToken.None);
        Assert.Equal("OrderLines", t.Name);
        Assert.Equal("PK_OrderLines", t.PrimaryKey!.Name);
        Assert.Equal(["OrderId", "LineNo"], t.PrimaryKey.Columns);
        Assert.Equal(["FK_OrderLines_Orders", "FK_OrderLines_Products"], t.ForeignKeys.Select(f => f.Name).OrderBy(x => x));
        Assert.Equal("CASCADE", t.ForeignKeys.Single(f => f.RefTable == "Orders").OnDelete);
        Assert.Equal("Qty > 0", Assert.Single(t.Checks).Expression);
        Assert.Equal("0", t.Column("Discount")!.Default);
        Assert.Equal("IX_OrderLines_ProductId", Assert.Single(t.Indexes).Name);

        var customers = await _db.ReadTableAsync(_profile, null, null, null, "Customers", CancellationToken.None);
        Assert.True(customers.Column("Id")!.Autoincrement);
        Assert.Equal("PK_Customers", customers.PrimaryKey!.Name);
        Assert.Equal("UQ_Customers_Email", Assert.Single(customers.Uniques).Name);
        Assert.Equal("CURRENT_TIMESTAMP", customers.Column("CreatedAt")!.Default);
    }

    [Fact]
    public async Task NativeAddColumn_RoundTrips()
    {
        var orders = await _db.ReadTableAsync(_profile, null, null, null, "Orders", CancellationToken.None);
        var desired = orders with { Columns = [.. orders.Columns, new TableColumnModel { Id = "n1", Name = "Channel", Type = "TEXT", Default = "'web'" }] };
        await ApplyAsync(orders, desired, expectRebuild: false);
        Assert.Equal(SampleDatabase.OrderCount, await ScalarAsync("SELECT count(*) FROM Orders WHERE Channel = 'web'"));
    }

    [Fact]
    public async Task NativeRenameAndDropColumn_AndIndexes_RoundTrip()
    {
        var orders = await _db.ReadTableAsync(_profile, null, null, null, "Orders", CancellationToken.None);
        var desired = orders with
        {
            Columns = orders.Columns.Where(c => c.Name != "ShippedAt").Select(c => c.Name == "Note" ? c with { Name = "Remarks" } : c).ToList(),
            Indexes = [.. orders.Indexes.Where(i => i.Name != "IX_Orders_OrderDate"), new IndexModel { Name = "IX_Orders_Status", Columns = [new IndexColumnModel("Status")], Filter = "Status <> 'delivered'" }],
        };
        await ApplyAsync(orders, desired, expectRebuild: false);
        Assert.Equal(SampleDatabase.OrderCount, await ScalarAsync("SELECT count(*) FROM Orders"));
    }

    [Fact]
    public async Task Rebuild_PreservesData_Indexes_Triggers_AndViews()
    {
        var orders = await _db.ReadTableAsync(_profile, null, null, null, "Orders", CancellationToken.None);
        var totalBefore = await ScalarAsync("SELECT CAST(sum(Total) * 100 AS INTEGER) FROM Orders");
        var desired = orders with
        {
            Columns = orders.Columns.Select(c => c.Name switch
            {
                "Note" => c with { Type = "VARCHAR(500)", Name = "Remarks" },
                "Status" => c with { Default = "'paid'" },
                _ => c,
            }).ToList(),
            Checks = [.. orders.Checks, new CheckModel { Name = "CK_Orders_Total", Expression = "Total >= 0" }],
        };
        await ApplyAsync(orders, desired, expectRebuild: true);

        Assert.Equal(SampleDatabase.OrderCount, await ScalarAsync("SELECT count(*) FROM Orders"));
        Assert.Equal(totalBefore, await ScalarAsync("SELECT CAST(sum(Total) * 100 AS INTEGER) FROM Orders"));
        Assert.Equal(2, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Orders' AND sql IS NOT NULL"));
        Assert.Equal(2, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE type = 'trigger'"));
        Assert.Equal(SampleDatabase.CustomerCount, await ScalarAsync("SELECT count(*) FROM CustomerOrderTotals"));
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM pragma_foreign_key_check"));
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE name LIKE '%__new'"));
        // The OrderLines triggers still update the rebuilt Orders table.
        await ScalarAsync("INSERT INTO OrderLines (OrderId, LineNo, ProductId, Qty, UnitPrice) VALUES (1, 99, 1, 1, 100); SELECT 0");
        Assert.True(await ScalarAsync("SELECT Total >= 100 FROM Orders WHERE Id = 1") == 1);
        // Foreign keys are on again for new connections (profile default) and OrderLines → Orders still enforced.
        await Assert.ThrowsAsync<SqliteException>(() => ScalarAsync("PRAGMA foreign_keys = ON; INSERT INTO OrderLines (OrderId, LineNo, ProductId, Qty, UnitPrice) VALUES (999999, 1, 1, 1, 1); SELECT 0"));
    }

    [Fact]
    public async Task Rebuild_OfReferencedTable_WithTypeChange_KeepsChildRows()
    {
        var customers = await _db.ReadTableAsync(_profile, null, null, null, "Customers", CancellationToken.None);
        var desired = customers with { Columns = customers.Columns.Select(c => c.Name == "Phone" ? c with { Type = "VARCHAR(40)" } : c).ToList() };
        await ApplyAsync(customers, desired, expectRebuild: true);
        Assert.Equal(SampleDatabase.OrderCount, await ScalarAsync("SELECT count(*) FROM Orders o JOIN Customers c ON c.Id = o.CustomerId"));
        Assert.Equal(SampleDatabase.CustomerCount + 1, await ScalarAsync("INSERT INTO Customers (FirstName, LastName, Email, CountryId) VALUES ('a', 'b', 'new@example.com', 1); SELECT max(Id) FROM Customers"));
    }

    [Fact]
    public async Task Rebuild_OfAutoincrementTable_KeepsTheCounter_SoDeletedIdsAreNotReused()
    {
        // Ids above max(Id) were handed out and deleted: AUTOINCREMENT must never hand them out again.
        var top = await ScalarAsync("SELECT max(Id) FROM Customers");
        await ScalarAsync("DELETE FROM OrderLines WHERE OrderId IN (SELECT Id FROM Orders WHERE CustomerId = (SELECT max(Id) FROM Customers)); DELETE FROM Orders WHERE CustomerId = (SELECT max(Id) FROM Customers); UPDATE sqlite_sequence SET seq = seq + 50 WHERE name = 'Customers'; DELETE FROM Customers WHERE Id = (SELECT max(Id) FROM Customers); SELECT 0");
        var counter = await ScalarAsync("SELECT seq FROM sqlite_sequence WHERE name = 'Customers'");
        Assert.True(counter >= top + 50);

        var customers = await _db.ReadTableAsync(_profile, null, null, null, "Customers", CancellationToken.None);
        var desired = customers with { Columns = customers.Columns.Select(c => c.Name == "Phone" ? c with { Type = "VARCHAR(40)" } : c).ToList() };
        await ApplyAsync(customers, desired, expectRebuild: true);

        Assert.Equal(counter, await ScalarAsync("SELECT seq FROM sqlite_sequence WHERE name = 'Customers'"));
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM sqlite_sequence WHERE name LIKE '%__new'"));
        Assert.Equal(counter + 1, await ScalarAsync("INSERT INTO Customers (FirstName, LastName, Email, CountryId) VALUES ('a', 'b', 'next@example.com', 1); SELECT max(Id) FROM Customers"));
    }

    [Fact]
    public async Task Rebuild_OfEmptyAutoincrementTable_StillKeepsTheCounter()
    {
        await ScalarAsync("CREATE TABLE Tickets (Id INTEGER CONSTRAINT PK_Tickets PRIMARY KEY AUTOINCREMENT NOT NULL, Title TEXT); "
                          + "INSERT INTO Tickets (Title) VALUES ('a'), ('b'), ('c'); DELETE FROM Tickets; SELECT 0");
        var tickets = await _db.ReadTableAsync(_profile, null, null, null, "Tickets", CancellationToken.None);
        var desired = tickets with { Columns = tickets.Columns.Select(c => c.Name == "Title" ? c with { Type = "VARCHAR(100)", Nullable = false, Default = "''" } : c).ToList() };
        await ApplyAsync(tickets, desired, expectRebuild: true);
        Assert.Equal(3, await ScalarAsync("SELECT seq FROM sqlite_sequence WHERE name = 'Tickets'"));
        Assert.Equal(4, await ScalarAsync("INSERT INTO Tickets (Title) VALUES ('d'); SELECT max(Id) FROM Tickets"));
    }

    [Fact]
    public async Task CreateTable_RoundTrips()
    {
        var t = new TableModel
        {
            Name = "Suppliers",
            Options = new TableOptions { Strict = true },
            Columns =
            [
                new TableColumnModel { Name = "Id", Type = "INTEGER", Nullable = false, Autoincrement = true },
                new TableColumnModel { Name = "Name", Type = "TEXT", Nullable = false, Collation = "NOCASE" },
                new TableColumnModel { Name = "CountryId", Type = "INTEGER" },
                new TableColumnModel { Name = "Rating", Type = "INTEGER", Nullable = false, Default = "3" },
                new TableColumnModel { Name = "Score", Type = "INTEGER", Computed = new ComputedModel("Rating * 10") },
            ],
            PrimaryKey = new PrimaryKeyModel { Columns = ["Id"] },
            Uniques = [new UniqueModel { Name = "UQ_Suppliers_Name", Columns = ["Name"] }],
            Indexes = [new IndexModel { Name = "IX_Suppliers_CountryId", Columns = [new IndexColumnModel("CountryId")] }],
            ForeignKeys = [new ForeignKeyModel { Name = "FK_Suppliers_Countries", Columns = ["CountryId"], RefTable = "Countries", RefColumns = ["Id"], OnDelete = "SET NULL" }],
            Checks = [new CheckModel { Name = "CK_Suppliers_Rating", Expression = "Rating BETWEEN 1 AND 5" }],
        };
        var script = _scripter.ScriptTable(null, t, DdlScriptContext.Default);
        await _db.ApplyAsync(_profile, null, new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), true), CancellationToken.None);
        var after = await _db.ReadTableAsync(_profile, null, null, null, "Suppliers", CancellationToken.None);
        var diff = TableDiff.Compute(SqliteDdlScripter.Normalize(after), SqliteDdlScripter.Normalize(t with { Schema = "main" }));
        Assert.True(diff.IsEmpty, string.Join("; ", diff.Changes.Select(c => $"{c.Kind} {c.Target} {c.Detail}")));
        Assert.True(after.Options.Strict);
        Assert.Equal("Rating * 10", after.Column("Score")!.Computed!.Expression);
    }

    [Fact]
    public async Task FailingApply_RollsBackEverything()
    {
        var orders = await _db.ReadTableAsync(_profile, null, null, null, "Orders", CancellationToken.None);
        // NOT NULL on a column with NULLs: the copy step fails mid-rebuild.
        var desired = orders with { Columns = orders.Columns.Select(c => c.Name == "ShippedAt" ? c with { Nullable = false } : c).ToList() };
        var context = await _db.GetScriptContextAsync(_profile, null, null, "main", "Orders", CancellationToken.None);
        var script = _scripter.ScriptTable(orders, desired, context);
        var ex = await Assert.ThrowsAsync<DdlFailedException>(() => _db.ApplyAsync(_profile, null,
            new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), true), CancellationToken.None));
        Assert.True(ex.RolledBack);
        Assert.Equal("SQLITE_CONSTRAINT", ex.ProviderError.Code);
        Assert.Contains("INSERT INTO", script.Statements[ex.FailedIndex].Sql);
        var after = await _db.ReadTableAsync(_profile, null, null, null, "Orders", CancellationToken.None);
        Assert.True(TableDiff.Compute(orders, after).IsEmpty);
        Assert.Equal(1, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE name = 'CustomerOrderTotals'"));
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE name = 'Orders__new'"));
    }

    [Fact]
    public async Task ForeignKeyCheck_FailureRollsBack()
    {
        var ex = await Assert.ThrowsAsync<DdlFailedException>(() => _db.ApplyAsync(_profile, null, new DdlApplyRequest(null,
        [
            "PRAGMA foreign_keys = OFF",
            "INSERT INTO Orders (Id, CustomerId, OrderDate) VALUES (999999, 424242, '2026-01-01')",
            "PRAGMA foreign_key_check",
            "PRAGMA foreign_keys = ON",
        ], true), CancellationToken.None));
        Assert.Equal(2, ex.FailedIndex);
        Assert.Contains("Foreign key check failed", ex.Message);
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM Orders WHERE Id = 999999"));
    }

    [Fact]
    public async Task ViewRead_AndScriptApply()
    {
        var view = await _db.ReadViewAsync(_profile, null, null, null, "customerordertotals", CancellationToken.None);
        Assert.Equal("CustomerOrderTotals", view.Name);
        Assert.StartsWith("SELECT c.Id AS CustomerId", view.Body);
        var script = _scripter.ScriptView(new ViewDefinition(null, "CustomerRevenue", view.Name, view.Body, view.Options), DdlScriptContext.Default);
        await _db.ApplyAsync(_profile, null, new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), true), CancellationToken.None);
        Assert.Equal(0, await ScalarAsync("SELECT count(*) FROM sqlite_master WHERE name = 'CustomerOrderTotals'"));
        Assert.Equal(SampleDatabase.CustomerCount, await ScalarAsync("SELECT count(*) FROM CustomerRevenue"));
    }

    [Fact]
    public async Task Dependents_AreDetected()
    {
        var context = await _db.GetScriptContextAsync(_profile, null, null, "main", "Orders", CancellationToken.None);
        Assert.Contains(context.Dependents!, d => d is { Type: "view", Name: "CustomerOrderTotals", OnTable: false });
        Assert.Contains(context.Dependents!, d => d is { Type: "trigger", Name: "TR_OrderLines_Insert", OnTable: false });
        var lines = await _db.GetScriptContextAsync(_profile, null, null, "main", "OrderLines", CancellationToken.None);
        Assert.Equal(2, lines.Dependents!.Count(d => d is { Type: "trigger", OnTable: true }));
        Assert.Matches(@"^3\.\d+", context.ServerVersion);
    }
}

public sealed class SqlitePlanReaderTests
{
    [Fact]
    public void BuildTree_NestsByParent_AndAddsWarnings()
    {
        var root = SqlitePlanReader.BuildTree(
        [
            (2, 0, "SCAN c"),
            (4, 0, "SEARCH o USING INDEX IX_Orders_CustomerId (CustomerId=?)"),
            (7, 0, "CORRELATED SCALAR SUBQUERY 1"),
            (9, 7, "SEARCH l USING INTEGER PRIMARY KEY (rowid=?)"),
            (12, 0, "USE TEMP B-TREE FOR ORDER BY"),
        ]);
        Assert.Equal("QUERY PLAN", root.Op);
        Assert.Equal(4, root.Children.Count);
        Assert.Equal("Full scan of c", Assert.Single(root.Children[0].Warnings));
        Assert.Equal(("Seek", "o", "CustomerId=?"), (root.Children[1].LogicalOp, root.Children[1].Object, root.Children[1].Predicate));
        Assert.Equal("IX_Orders_CustomerId", root.Children[1].Props!["Index"]);
        Assert.Equal("l", Assert.Single(root.Children[2].Children).Object);
        Assert.Equal("Sort", root.Children[3].LogicalOp);
        Assert.All(root.DescendantsAndSelf(), n => Assert.Null(n.CostPct));
    }

    [Fact]
    public void SingleTopLevelRow_IsTheRoot_AndRawTextMatchesTheShell()
    {
        var rows = new List<(long, long, string)> { (2, 0, "SCAN t"), (5, 2, "x") };
        Assert.Equal("SCAN t", SqlitePlanReader.BuildTree(rows).Op);
        Assert.Equal("QUERY PLAN\n`--SCAN t\n   `--x\n", SqlitePlanReader.ToRawText(rows));
    }
}

/// <summary>The shared M1.5 conformance suite on SQLite (always runs).</summary>
public sealed class SqliteM15ConformanceTests(SqliteFixture fixture) : M15ConformanceTests<SqliteFixture>(fixture)
{
    protected override IDdlScripter Scripter { get; } = new SqliteDdlScripter();
    protected override IDesignerDatabase Database { get; } = new SqliteDesignerDatabase();
    protected override IPlanReader PlanReader { get; } = new SqlitePlanReader();
    protected override TableModel Normalize(TableModel t, DdlScriptContext context) => SqliteDdlScripter.Normalize(t);
}
