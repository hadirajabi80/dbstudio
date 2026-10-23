using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>Catalog, details, DDL, dependencies, object list and search over the recorded SHOW / DESCRIBE / GET_DDL fixtures.</summary>
public sealed class CatalogTests
{
    private readonly FakeGatewayFactory _gateways = new();
    private SnowflakeProvider Provider => new(_gateways);
    private static readonly CancellationToken Ct = CancellationToken.None;

    private async Task<ICatalogReader> ReaderAsync() => await Provider.OpenCatalogReaderAsync(SfTestProfiles.Shop(), "pw", Ct);

    [Fact]
    public async Task Databases_and_schemas_hide_information_schema()
    {
        await using var r = await ReaderAsync();
        Assert.Equal(["SHOP", "SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA", "ANALYTICS"], await r.ListDatabasesAsync(Ct));
        Assert.Equal("SHOP", await r.GetCurrentDatabaseAsync(Ct)); // profile "shop" folds to upper case
        Assert.Equal("PUBLIC", await r.GetDefaultSchemaAsync(null, Ct));
        var schemas = await r.ListSchemasAsync("SHOP", Ct);
        Assert.Equal(["PUBLIC", "SALES"], schemas.Select(s => s.Name));
        Assert.Contains("SHOW SCHEMAS IN DATABASE \"SHOP\"", _gateways.Opened[0].Sent);
    }

    [Fact]
    public async Task Load_schema_maps_every_object_kind()
    {
        await using var r = await ReaderAsync();
        var cat = await r.LoadSchemaAsync("SHOP", "PUBLIC", Ct);
        Assert.Equal("SHOP", cat.Database);
        var byName = cat.Objects.GroupBy(o => (o.Type, o.Name)).ToDictionary(g => g.Key, g => g.First());

        var customers = byName[(ObjectTypes.Table, "CUSTOMERS")];
        Assert.Equal("Shop customers", customers.Comment);
        Assert.Equal(["ID"], customers.PrimaryKey);
        Assert.Equal(["ID", "NAME", "EMAIL", "COUNTRY_ID", "PROFILE"], customers.Columns.Select(c => c.Name));
        Assert.Equal("NUMBER(38,0)", customers.Columns[0].TypeText);
        Assert.Equal(1, customers.Columns[0].Flags & 1); // identity
        Assert.True(customers.Columns[0].IsPk);
        Assert.False(customers.Columns[1].Nullable);
        Assert.Equal("VARCHAR(100)", customers.Columns[1].TypeText);
        Assert.Equal("VARIANT", customers.Columns[4].TypeText);
        Assert.Equal("Contact address", customers.Columns[2].Comment);
        var fk = Assert.Single(customers.ForeignKeys);
        Assert.Equal(("FK_CUSTOMERS_COUNTRIES", "COUNTRIES", "PUBLIC"), (fk.Name, fk.RefTable, fk.RefSchema));

        var lines = byName[(ObjectTypes.Table, "ORDER_LINES")];
        Assert.Equal(["ORDER_ID", "PRODUCT_ID"], lines.PrimaryKey); // ordered by key_sequence
        Assert.Equal(2, lines.ForeignKeys.Count);

        var products = byName[(ObjectTypes.Table, "PRODUCTS")];
        Assert.Equal("VARCHAR", products.Columns[1].TypeText); // VARCHAR(16777216) is the default length
        Assert.Equal("VECTOR(FLOAT, 3)", products.Columns.Single(c => c.Name == "EMBEDDING").TypeText);
        Assert.Equal("TIMESTAMP_NTZ", byName[(ObjectTypes.Table, "ORDERS")].Columns.Single(c => c.Name == "ORDER_DATE").TypeText);

        Assert.True(byName.ContainsKey((ObjectTypes.Table, "EVENTS_RAW")));      // transient
        Assert.True(byName.ContainsKey((ObjectTypes.Table, "DAILY_REVENUE")));   // dynamic
        Assert.Equal(4, byName[(ObjectTypes.View, "CUSTOMER_ORDERS")].Columns.Count);
        Assert.True(byName.ContainsKey((ObjectTypes.MView, "ORDER_TOTALS_MV")));

        var refresh = byName[(ObjectTypes.Proc, "REFRESH_TOTALS")];
        Assert.Equal("Recomputes ORDERS.TOTAL", refresh.Comment);
        Assert.Equal("NUMBER", Assert.Single(refresh.Parameters).TypeText);
        var archive = byName[(ObjectTypes.Proc, "ARCHIVE_ORDERS")];
        Assert.Null(archive.Comment); // "user-defined procedure" placeholder
        Assert.Equal(["DATE", "BOOLEAN"], archive.Parameters.Select(p => p.TypeText));

        var tax = Assert.Single(cat.Objects, o => o.Type == ObjectTypes.Func && o.Name == "ORDER_TAX"); // overloads collapse
        Assert.Equal("return", tax.Parameters[^1].Direction);
        var udtf = byName[(ObjectTypes.TableFunc, "ORDERS_OF")];
        Assert.Equal(["ORDER_ID", "TOTAL"], udtf.Columns.Select(c => c.Name));
        Assert.Equal("Order numbers", byName[(ObjectTypes.Sequence, "ORDERS_SEQ")].Comment);
    }

    [Fact]
    public async Task Missing_schema_is_not_found()
    {
        await using var r = await ReaderAsync();
        var ex = await Assert.ThrowsAsync<EngineException>(() => r.LoadSchemaAsync("SHOP", "MISSING", Ct));
        Assert.Equal(404, ex.Status);
    }

    [Fact]
    public async Task Table_details_have_keys_cluster_key_and_referencing_tables()
    {
        await using var r = await ReaderAsync();
        var d = await r.GetObjectDetailsAsync(new ObjectRef("SHOP", "PUBLIC", "ORDERS", ObjectTypes.Table), Ct);
        Assert.Equal(["ID", "CUSTOMER_ID", "ORDER_DATE", "TOTAL"], d.Columns.Select(c => c.Name));
        Assert.Equal("0", d.Columns[3].Default);
        Assert.Equal("Order total incl. tax", d.Columns[3].Comment);
        Assert.True(d.Columns[0].IsPk);
        Assert.Equal(6, d.RowCountEstimate);
        Assert.NotNull(d.Created);
        var pk = Assert.Single(d.Indexes, i => i.IsPrimaryKey);
        Assert.Equal("PK_ORDERS", pk.Name);
        var cluster = Assert.Single(d.Indexes, i => i.Type == "clustering key");
        Assert.Equal(["ORDER_DATE", "TO_DATE(ORDER_DATE)"], cluster.Columns);
        Assert.Equal("CUSTOMERS", Assert.Single(d.ForeignKeys).RefTable);
        Assert.Equal([("PUBLIC", "ORDER_LINES"), ("SALES", "INVOICES")], d.ReferencedBy.Select(x => (x.Schema!, x.Table)));
    }

    [Fact]
    public async Task Identity_columns_and_unique_keys_in_details()
    {
        await using var r = await ReaderAsync();
        var d = await r.GetObjectDetailsAsync(new ObjectRef(null, null, "CUSTOMERS", ObjectTypes.Table), Ct);
        Assert.Equal("SHOP", d.Ref.Database);
        Assert.True(d.Columns[0].IsIdentity);
        Assert.Null(d.Columns[0].Default);
        Assert.Contains(d.Indexes, i => i.Name == "UQ_CUSTOMERS_EMAIL" && i.Unique);
    }

    [Fact]
    public async Task Routine_details_name_parameters_from_describe()
    {
        await using var r = await ReaderAsync();
        var f = await r.GetObjectDetailsAsync(new ObjectRef("SHOP", "PUBLIC", "ORDER_TAX", ObjectTypes.Func), Ct);
        Assert.Equal([("AMOUNT", "NUMBER", "in"), ("", "NUMBER(38,2)", "return")], f.Parameters.Select(p => (p.Name, p.TypeText, p.Direction)));
        var p = await r.GetObjectDetailsAsync(new ObjectRef("SHOP", "PUBLIC", "REFRESH_TOTALS", ObjectTypes.Proc), Ct);
        Assert.Equal("DAYS", Assert.Single(p.Parameters).Name);
    }

    [Fact]
    public async Task Ddl_uses_get_ddl_with_argument_types_and_falls_back_to_generated()
    {
        await using var r = await ReaderAsync();
        var t = await r.GetDdlAsync(new ObjectRef("SHOP", "PUBLIC", "ORDERS", ObjectTypes.Table), Ct);
        Assert.Equal("stored", t.Source);
        Assert.StartsWith("create or replace TABLE SHOP.PUBLIC.ORDERS cluster by", t.Ddl);
        Assert.EndsWith(";\n", t.Ddl);

        var f = await r.GetDdlAsync(new ObjectRef("SHOP", "PUBLIC", "ORDER_TAX", ObjectTypes.Func), Ct);
        Assert.Contains("ORDER_TAX(\"AMOUNT\" NUMBER(38,0))", f.Ddl);
        Assert.Contains("\"COUNTRY\" VARCHAR", f.Ddl); // both overloads
        Assert.Contains(_gateways.Opened[0].Sent, s => s.Contains("ORDER_TAX\"(NUMBER, VARCHAR)'", StringComparison.Ordinal));

        var g = await r.GetDdlAsync(new ObjectRef("SHOP", "PUBLIC", "CUSTOMERS", ObjectTypes.Table), Ct);
        Assert.Equal("generated", g.Source);
        Assert.Contains("CREATE TABLE SHOP.PUBLIC.CUSTOMERS (", g.Ddl);
        Assert.Contains("ID NUMBER(38,0) IDENTITY NOT NULL", g.Ddl);
        Assert.Contains("EMAIL VARCHAR(200) COLLATE 'en-ci'", g.Ddl);
        Assert.Contains("CONSTRAINT PK_CUSTOMERS PRIMARY KEY (ID)", g.Ddl);

        var v = await r.GetDdlAsync(new ObjectRef("SHOP", "PUBLIC", "CUSTOMER_ORDERS", ObjectTypes.View), Ct);
        Assert.Contains("create or replace view SHOP.PUBLIC.CUSTOMER_ORDERS", v.Ddl);
    }

    [Fact]
    public async Task Dependencies_combine_keys_view_texts_and_account_usage()
    {
        var browser = (IObjectBrowserProvider)Provider;
        await using var reader = await browser.OpenDependencyReaderAsync(SfTestProfiles.Shop(), "pw", Ct);
        var g = await reader.GetDependenciesAsync(new ObjectRef("SHOP", "PUBLIC", "ORDERS", ObjectTypes.Table), Ct);
        Assert.Contains(g.Uses, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "CUSTOMERS");
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object.Name == "ORDER_LINES");
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.Fk && d.Object is { Schema: "SALES", Name: "INVOICES" });
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "CUSTOMER_ORDERS", Type: ObjectTypes.View });
        Assert.Contains(g.UsedBy, d => d.Kind == DependencyKinds.UsedBy && d.Object is { Name: "ORDER_TOTALS_MV", Type: ObjectTypes.MView });
        Assert.Contains(g.UsedBy, d => d.Object is { Database: "ANALYTICS", Schema: "MART", Name: "REVENUE_BY_MONTH" });
        var fake = _gateways.Opened.Single();
        Assert.Equal(["SHOP", "PUBLIC", "ORDERS"], fake.Binds[fake.Sent.FindIndex(s => s.Contains("OBJECT_DEPENDENCIES"))]);

        var vg = await reader.GetDependenciesAsync(new ObjectRef("SHOP", "PUBLIC", "CUSTOMER_ORDERS", ObjectTypes.View), Ct);
        Assert.Contains(vg.Uses, d => d.Object is { Name: "CUSTOMERS", Type: ObjectTypes.Table });
        Assert.Contains(vg.Uses, d => d.Object is { Name: "ORDERS", Type: ObjectTypes.Table });
    }

    [Fact]
    public async Task Object_list_has_rows_bytes_and_types()
    {
        var browser = (IObjectBrowserProvider)Provider;
        await using var reader = await browser.OpenObjectListReaderAsync(SfTestProfiles.Shop(), "pw", Ct);
        var items = await reader.ListAsync("SHOP", "PUBLIC", null, Ct);
        var orders = items.Single(i => i.Name == "ORDERS");
        Assert.Equal((ObjectTypes.Table, 6L, 3072L), (orders.Type, orders.RowCount!.Value, orders.SizeBytes!.Value));
        Assert.Contains(items, i => i is { Name: "ORDER_TOTALS_MV", Type: ObjectTypes.MView });
        Assert.Contains(items, i => i is { Name: "ORDERS_OF", Type: ObjectTypes.TableFunc });
        Assert.Single(items, i => i.Name == "ORDER_TAX"); // overloads once
        Assert.Contains(items, i => i is { Name: "ORDERS_SEQ", Type: ObjectTypes.Sequence });
        var onlyViews = await reader.ListAsync("SHOP", "PUBLIC", ObjectTypes.View, Ct);
        Assert.Equal(["CUSTOMER_ORDERS"], onlyViews.Select(i => i.Name));
    }

    [Fact]
    public async Task Search_reads_names_columns_code_and_binds_data_queries()
    {
        var provider = (IDatabaseSearchProvider)Provider;
        await using var s = await provider.OpenSearcherAsync(SfTestProfiles.Shop(), "pw", Ct);
        Assert.Equal(["SHOP", "ANALYTICS"], await s.SearchDatabasesAsync(Ct));
        var names = await s.NamesAsync("SHOP", "PUBLIC", null, false, Ct);
        Assert.Contains(names, n => n is { Name: "ORDERS_SEQ", Type: ObjectTypes.Sequence });
        Assert.Contains(names, n => n is { Name: "REFRESH_TOTALS", Type: ObjectTypes.Proc });
        var cols = await s.ColumnsAsync("SHOP", "PUBLIC", null, false, Ct);
        Assert.Contains(cols, c => c is { Object: "CUSTOMER_ORDERS", ObjectType: ObjectTypes.View, Column: "NAME", DataType: "VARCHAR(100)" });
        var code = new List<SearchCodeRow>();
        await foreach (var c in s.CodeAsync("SHOP", "PUBLIC", null, false, Ct)) code.Add(c);
        Assert.Contains(code, c => c.Name == "CUSTOMER_ORDERS" && c.Text.Contains("JOIN ORDERS"));
        Assert.Contains(code, c => c is { Name: "REFRESH_TOTALS", Type: ObjectTypes.Proc });

        var matcher = new SearchMatcher("alice");
        var q = SearchSql.BuildDataQuery(Dialect.Snowflake, "PUBLIC", "CUSTOMERS", ["ID"], [("NAME", "VARCHAR(100)"), ("EMAIL", "VARCHAR(200)")], matcher, 50)!;
        Assert.Equal("SELECT \"ID\", \"NAME\", \"EMAIL\" FROM \"PUBLIC\".\"CUSTOMERS\" WHERE (\"NAME\" ILIKE :1 ESCAPE '!' OR \"EMAIL\" ILIKE :1 ESCAPE '!') LIMIT 50", q.Sql);
        var rows = new List<object?[]>();
        await foreach (var row in s.QueryAsync("SHOP", q, Ct)) rows.Add(row);
        Assert.Single(rows);
        var fake = _gateways.Opened.Single();
        Assert.Equal("%alice%", Assert.Single(fake.Binds[^1]));
        Assert.StartsWith("SELECT \"ID\", \"NAME\", \"EMAIL\" FROM \"SHOP\".\"PUBLIC\".\"CUSTOMERS\"", fake.Sent[^1]);
    }
}
