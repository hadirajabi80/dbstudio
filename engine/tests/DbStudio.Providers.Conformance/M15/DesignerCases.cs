using DbStudio.Core.Designer;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Conformance.M15;

/// <summary>
/// The designer scripting cases shared by the three scripter golden tests (docs/PLAN-M1.5.md WP-F acceptance):
/// create, add/drop/rename column, change type, drop default, add FK, indexes, checks/uniques, table rename, comments.
/// Names and types follow each dialect's conventions (T-SQL PascalCase, Oracle UPPER, SQLite PascalCase).
/// </summary>
public static class DesignerCases
{
    public sealed record Case(string Name, TableModel? Original, TableModel Desired);

    private sealed record Types(string Int, string Date, string ShortText, string Money, string LongText, string? Schema);

    private static Types For(Dialect d) => d switch
    {
        Dialect.TSql => new("int", "date", "nvarchar(20)", "decimal(12,2)", "nvarchar(200)", "dbo"),
        Dialect.PlSql => new("NUMBER(10)", "DATE", "VARCHAR2(20)", "NUMBER(12,2)", "VARCHAR2(200)", "SHOP"),
        _ => new("INTEGER", "DATE", "TEXT", "NUMERIC(12,2)", "TEXT", "main"),
    };

    private static string N(Dialect d, string pascal) => d == Dialect.PlSql ? ShopSchema.ToSnake(pascal).ToUpperInvariant() : pascal;

    private static TableColumnModel Col(Dialect d, string name, string type, bool nullable = true, string? def = null) =>
        new() { Id = N(d, name), Name = N(d, name), Type = type, Nullable = nullable, Default = def };

    /// <summary>Orders(Id PK, CustomerId FK, OrderDate, Status default 'new', Total default 0, Note) + index + check.</summary>
    public static TableModel Orders(Dialect d)
    {
        var t = For(d);
        return new TableModel
        {
            Schema = t.Schema,
            Name = N(d, "Orders"),
            Columns =
            [
                Col(d, "Id", t.Int, false),
                Col(d, "CustomerId", t.Int, false),
                Col(d, "OrderDate", t.Date, false),
                Col(d, "Status", t.ShortText, false, "'new'") with { DefaultName = d == Dialect.TSql ? "DF_Orders_Status" : null },
                Col(d, "Total", t.Money, false, "0") with { DefaultName = d == Dialect.TSql ? "DF_Orders_Total" : null },
                Col(d, "Note", t.LongText),
            ],
            PrimaryKey = new PrimaryKeyModel { Name = N(d, "PK_Orders"), Columns = [N(d, "Id")] },
            Indexes = [new IndexModel { Name = N(d, "IX_Orders_CustomerId"), Columns = [new IndexColumnModel(N(d, "CustomerId"))] }],
            ForeignKeys = [new ForeignKeyModel { Name = N(d, "FK_Orders_Customers"), Columns = [N(d, "CustomerId")], RefSchema = t.Schema == "main" ? null : t.Schema, RefTable = N(d, "Customers"), RefColumns = [N(d, "Id")] }],
            Checks = [new CheckModel { Name = N(d, "CK_Orders_Total"), Expression = $"{N(d, "Total")} >= 0" }],
        };
    }

    private static TableModel EditColumn(TableModel t, string name, Func<TableColumnModel, TableColumnModel> edit) =>
        t with { Columns = t.Columns.Select(c => c.Name == name ? edit(c) : c).ToList() };

    public static IReadOnlyList<Case> All(Dialect d)
    {
        var t = For(d);
        var orders = Orders(d);
        var withRefund = orders with { Columns = [.. orders.Columns, Col(d, "RefundedAt", t.Date) with { Id = "new_1" }] };
        var cases = new List<Case>
        {
            new("create", null, orders with
            {
                Comment = "Customer orders",
                Columns = orders.Columns.Select(c => c.Name == N(d, "Note") ? c with { Comment = "Free text" } : c).ToList(),
                Uniques = [new UniqueModel { Name = N(d, "UQ_Orders_Customer_Date"), Columns = [N(d, "CustomerId"), N(d, "OrderDate")] }],
            }),
            new("add_column", orders, withRefund),
            new("add_column_not_null_default", orders, orders with { Columns = [.. orders.Columns, Col(d, "Channel", t.ShortText, false, "'web'") with { Id = "new_2" }] }),
            new("drop_column", orders, orders with { Columns = orders.Columns.Where(c => c.Name != N(d, "Note")).ToList() }),
            new("rename_column", orders, EditColumn(orders, N(d, "Note"), c => c with { Name = N(d, "Remarks") })),
            new("change_type", orders, EditColumn(orders, N(d, "Note"), c => c with { Type = d switch { Dialect.TSql => "nvarchar(max)", Dialect.PlSql => "VARCHAR2(400)", _ => "VARCHAR(400)" } })),
            new("narrow_type_not_null", orders, EditColumn(orders, N(d, "Status"), c => c with { Type = d switch { Dialect.TSql => "nvarchar(10)", Dialect.PlSql => "VARCHAR2(10)", _ => "VARCHAR(10)" } })),
            new("drop_default", orders, EditColumn(orders, N(d, "Status"), c => c with { Default = null })),
            new("change_default", orders, EditColumn(orders, N(d, "Total"), c => c with { Default = "1" })),
            new("add_fk", orders with { ForeignKeys = [] }, orders with
            {
                ForeignKeys = [orders.ForeignKeys[0] with { OnDelete = ReferentialActions.Cascade }],
            }),
            new("indexes", orders, orders with
            {
                Indexes = [new IndexModel { Name = N(d, "IX_Orders_Date_Status"), Columns = [new IndexColumnModel(N(d, "OrderDate"), Desc: true), new IndexColumnModel(N(d, "Status"))], Unique = false }],
            }),
            new("checks_and_uniques", orders, orders with
            {
                Checks = [new CheckModel { Name = N(d, "CK_Orders_Total"), Expression = $"{N(d, "Total")} >= 0 AND {N(d, "Total")} < 1000000" }],
                Uniques = [new UniqueModel { Name = N(d, "UQ_Orders_Customer_Date"), Columns = [N(d, "CustomerId"), N(d, "OrderDate")] }],
            }),
            new("rename_table", orders, orders with { Name = N(d, "SalesOrders") }),
            new("comments", orders, EditColumn(orders with { Comment = "All orders" }, N(d, "Total"), c => c with { Comment = "Gross total" })),
        };
        return cases;
    }
}
