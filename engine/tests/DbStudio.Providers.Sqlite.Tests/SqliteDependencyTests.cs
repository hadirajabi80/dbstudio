using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Tests;

/// <summary>Object browser (WP3) on an in-memory database: FKs, triggers, view/trigger body scan, object list.</summary>
public sealed class SqliteDependencyTests : IAsyncLifetime
{
    private SqliteConnection _conn = null!;

    public async Task InitializeAsync()
    {
        _conn = new SqliteConnection("Data Source=:memory:");
        await _conn.OpenAsync();
        await using var cmd = _conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL);
            CREATE TABLE order_lines (order_id INTEGER, line INTEGER, qty INTEGER,
              CONSTRAINT fk_lines_order FOREIGN KEY (order_id) REFERENCES orders(id), PRIMARY KEY (order_id, line));
            CREATE TABLE employees (id INTEGER PRIMARY KEY, manager_id INTEGER REFERENCES employees(id));
            CREATE TABLE audit (at TEXT, what TEXT);
            CREATE VIEW customer_orders AS SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id;
            CREATE VIEW big_orders AS SELECT * FROM customer_orders WHERE total > 100 -- orders in a comment are ignored
            ;
            CREATE TRIGGER trg_orders_audit AFTER INSERT ON orders BEGIN INSERT INTO audit VALUES (datetime('now'), 'order ' || NEW.id); END;
            CREATE INDEX ix_orders_customer ON orders (customer_id);
            INSERT INTO customers VALUES (1, 'Alice'), (2, 'Bob');
            INSERT INTO orders VALUES (10, 1, 50), (11, 2, 150), (12, 2, 300);
            """;
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task DisposeAsync() => await _conn.DisposeAsync();

    private async Task<DependencyGraph> DepsAsync(string name, string type = ObjectTypes.Table)
    {
        var reader = new SqliteDependencyReader(_conn);
        return await reader.GetDependenciesAsync(new ObjectRef(null, null, name, type), CancellationToken.None);
    }

    [Fact]
    public async Task Table_FksBothWays_TriggerAndViews()
    {
        var g = await DepsAsync("orders");
        Assert.Equal(new ObjectRef(null, "main", "orders", ObjectTypes.Table), g.Root);
        var fk = Assert.Single(g.Uses);
        Assert.Equal((DependencyKinds.Fk, "customers"), (fk.Kind, fk.Object.Name));
        Assert.EndsWith("customer_id → id", fk.Detail);
        var lines = Assert.Single(g.UsedBy, d => d.Kind == DependencyKinds.Fk);
        Assert.Equal("order_lines", lines.Object.Name);
        Assert.Equal("fk_lines_order: order_id → id", lines.Detail);
        var trg = Assert.Single(g.UsedBy, d => d.Kind == DependencyKinds.Trigger);
        Assert.Equal(("trg_orders_audit", "AFTER INSERT"), (trg.Object.Name, trg.Detail));
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object.Name == "customer_orders" && d.Object.Type == ObjectTypes.View);
        // big_orders mentions "orders" only in a comment: not a usage.
        Assert.DoesNotContain(g.UsedBy, d => d.Object.Name == "big_orders");
    }

    [Fact]
    public async Task View_UsesTablesAndViews_TriggerUsesItsTargets()
    {
        var v = await DepsAsync("big_orders", ObjectTypes.View);
        Assert.Equal(["customer_orders"], v.Uses.Select(d => d.Object.Name));
        var co = await DepsAsync("customer_orders", ObjectTypes.View);
        Assert.Equal(["customers", "orders"], co.Uses.Select(d => d.Object.Name));
        Assert.Equal(["big_orders"], co.UsedBy.Select(d => d.Object.Name));

        var t = await DepsAsync("trg_orders_audit", ObjectTypes.Trigger);
        Assert.Contains(t.Uses, d => d.Kind == DependencyKinds.Trigger && d.Object.Name == "orders" && d.Detail == "fires on");
        Assert.Contains(t.Uses, d => d.Kind == DependencyKinds.Uses && d.Object.Name == "audit");
        var audit = await DepsAsync("audit");
        Assert.Contains(audit.UsedBy, d => d.Object.Name == "trg_orders_audit" && d.Detail == "on orders");
    }

    [Fact]
    public async Task SelfReference_IsKept_UnknownObject_IsNotFound()
    {
        var g = await DepsAsync("employees");
        Assert.Contains(g.Uses, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "employees");
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "employees");
        var ex = await Assert.ThrowsAsync<EngineException>(() => DepsAsync("nope"));
        Assert.Equal(404, ex.Status);
    }

    [Fact]
    public async Task ObjectList_CountsRows_FiltersByType_SkipsIndexes()
    {
        var reader = new SqliteDependencyReader(_conn);
        var all = await reader.ListAsync(null, "main", null, CancellationToken.None);
        Assert.DoesNotContain(all, o => o.Name == "ix_orders_customer");
        Assert.Equal(3, Assert.Single(all, o => o.Name == "orders").RowCount);
        Assert.Equal(2, Assert.Single(all, o => o.Name == "customers").RowCount);
        Assert.Equal("on orders", Assert.Single(all, o => o.Name == "trg_orders_audit").Comment);
        Assert.Equal(all.Select(o => o.Name).OrderBy(n => n, StringComparer.OrdinalIgnoreCase), all.Select(o => o.Name));
        var views = await reader.ListAsync(null, null, ObjectTypes.View, CancellationToken.None);
        Assert.Equal(["big_orders", "customer_orders"], views.Select(v => v.Name));
        Assert.All(views, v => Assert.Null(v.RowCount));
    }

    [Fact]
    public void ReferencedNames_ChainsAndComments()
    {
        var refs = DependencyGraphs.ReferencedNames("SELECT a.b, main.orders FROM x /* y */ -- z\n WHERE 'q' = c", Dialect.Sqlite);
        Assert.Contains(("main", "orders"), refs);
        Assert.Contains(((string?)"a", "b"), refs);
        Assert.Contains(((string?)null, "x"), refs);
        Assert.DoesNotContain(refs, r => r.Name is "y" or "z" or "q");
    }
}
