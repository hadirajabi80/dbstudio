using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>Object browser (WP3) against the seeded shop: dependencies and the object list; skipped without Docker.</summary>
public sealed class PgDependencyTests(PgFixture fixture) : IClassFixture<PgFixture>
{
    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "PostgreSQL not available.");

    private async Task<DependencyGraph> DepsAsync(string schema, string name, string type)
    {
        await using var r = await new PostgreSqlProvider().OpenDependencyReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        return await r.GetDependenciesAsync(new ObjectRef(null, schema, name, type), CancellationToken.None);
    }

    private static bool Has(IEnumerable<ObjectDependency> list, string kind, string name, string? type = null) =>
        list.Any(d => d.Kind == kind && d.Object.Name == name && (type is null || d.Object.Type == type));

    [SkippableFact]
    public async Task Table_FksBothWays_ViewsAndTriggers()
    {
        RequireAvailable();
        var g = await DepsAsync("public", "orders", ObjectTypes.Table);
        Assert.True(Has(g.Uses, DependencyKinds.Fk, "customers", ObjectTypes.Table));
        Assert.True(Has(g.UsedBy, DependencyKinds.Fk, "order_lines", ObjectTypes.Table));
        Assert.True(Has(g.UsedBy, DependencyKinds.UsedBy, "customer_orders", ObjectTypes.View));
        Assert.True(Has(g.UsedBy, DependencyKinds.UsedBy, "customer_totals", ObjectTypes.MView));
        var trg = Assert.Single(g.UsedBy, d => d.Kind == DependencyKinds.Trigger);
        Assert.Equal("trg_orders_check", trg.Object.Name);
        Assert.StartsWith("BEFORE INSERT", trg.Detail);
        // Routine bodies naming the table (pg_depend does not track them).
        Assert.True(Has(g.UsedBy, DependencyKinds.UsedBy, "orders_of", ObjectTypes.TableFunc));
    }

    [SkippableFact]
    public async Task View_UsesItsTables()
    {
        RequireAvailable();
        var g = await DepsAsync("public", "customer_orders", ObjectTypes.View);
        Assert.True(Has(g.Uses, DependencyKinds.Uses, "customers"));
        Assert.True(Has(g.Uses, DependencyKinds.Uses, "orders"));
        Assert.DoesNotContain(g.Uses, d => d.Object.Name == "customer_orders");
    }

    [SkippableFact]
    public async Task Procedure_BodyScan_AndTrigger_FiresOn()
    {
        RequireAvailable();
        var p = await DepsAsync("public", "add_order_line", ObjectTypes.Proc);
        Assert.True(Has(p.Uses, DependencyKinds.Uses, "order_lines", ObjectTypes.Table));
        var t = await DepsAsync("public", "trg_orders_check", ObjectTypes.Trigger);
        Assert.True(Has(t.Uses, DependencyKinds.Trigger, "orders", ObjectTypes.Table));
        Assert.True(Has(t.Uses, DependencyKinds.Uses, "orders_check", ObjectTypes.Func));
        var f = await DepsAsync("public", "orders_check", ObjectTypes.Func);
        Assert.True(Has(f.UsedBy, DependencyKinds.Trigger, "trg_orders_check"));
    }

    [SkippableFact]
    public async Task SequenceAndType_UsedBy()
    {
        RequireAvailable();
        var t = await DepsAsync("public", "order_status", ObjectTypes.Type);
        Assert.Contains(t.UsedBy, d => d.Object.Name == "orders" && d.Detail == "column status");
    }

    [SkippableFact]
    public async Task ObjectList_HasStatsForTables_AndRoutinesOnce()
    {
        RequireAvailable();
        await using var r = await new PostgreSqlProvider().OpenObjectListReaderAsync(fixture.Profile!, fixture.Password, CancellationToken.None);
        var all = await r.ListAsync(null, "public", null, CancellationToken.None);
        var orders = Assert.Single(all, o => o.Name == "orders" && o.Type == ObjectTypes.Table);
        Assert.NotNull(orders.SizeBytes);
        Assert.Single(all, o => o.Name == "fn_tax"); // two overloads, one row
        Assert.Contains(all, o => o.Name == "trg_orders_check" && o.Type == ObjectTypes.Trigger && o.Comment == "on orders");
        Assert.Contains(all, o => o.Name == "order_numbers" && o.Type == ObjectTypes.Sequence);
        var views = await r.ListAsync(null, null, ObjectTypes.View, CancellationToken.None);
        Assert.All(views, v => Assert.Equal(ObjectTypes.View, v.Type));
        Assert.Contains(views, v => v.Name == "customer_orders");
    }
}
