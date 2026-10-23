using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Providers.Conformance.M15;
using DbStudio.Providers.Snowflake.Designer;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>Scripter goldens over the shared designer cases (M15/golden/snowflake_*.sql) and the designer reads over fixtures.</summary>
public sealed class DesignerTests
{
    private static readonly SnowflakeDdlScripter Scripter = new();
    private static readonly DdlScriptContext Context = new("9.33.1", "PUBLIC");

    public static TheoryData<string> CaseNames => new(DesignerCases.All(Dialect.Snowflake).Select(c => c.Name));

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Script_matches_golden(string name)
    {
        var c = DesignerCases.All(Dialect.Snowflake).Single(x => x.Name == name);
        var script = Scripter.ScriptTable(c.Original, c.Desired, Context);
        Assert.False(script.Transactional);
        Golden.Match($"snowflake_{name}.sql", Golden.Render(script));
    }

    private static TableModel Orders() => new()
    {
        Schema = "PUBLIC",
        Name = "ORDERS",
        Comment = "Shop orders",
        Columns =
        [
            new() { Id = "ID", Name = "ID", Type = "NUMBER(38,0)", Nullable = false, Identity = new IdentityModel(1, 1) },
            new() { Id = "CUSTOMER_ID", Name = "CUSTOMER_ID", Type = "NUMBER(38,0)", Nullable = false },
            new() { Id = "NOTE", Name = "NOTE", Type = "VARCHAR(100)", Comment = "free text" },
            new() { Id = "ORDER_DATE", Name = "ORDER_DATE", Type = "TIMESTAMP_NTZ(9)", Nullable = false, Default = "CURRENT_TIMESTAMP()" },
        ],
        PrimaryKey = new PrimaryKeyModel { Name = "PK_ORDERS", Columns = ["ID"] },
        ForeignKeys = [new ForeignKeyModel { Name = "FK_ORDERS_CUSTOMERS", Columns = ["CUSTOMER_ID"], RefTable = "CUSTOMERS", RefColumns = ["ID"] }],
        Indexes = [new IndexModel { Name = SnowflakeDdlScripter.ClusterIndexName, Clustered = true, Columns = [new IndexColumnModel("ORDER_DATE")] }],
    };

    [Fact]
    public void Create_has_identity_cluster_key_and_comment()
    {
        var s = Scripter.ScriptTable(null, Orders(), Context);
        Golden.Match("snowflake_create_cluster.sql", Golden.Render(s));
        var sql = Assert.Single(s.Statements).Sql;
        Assert.Contains("ID NUMBER(38,0) IDENTITY(1, 1) NOT NULL", sql);
        Assert.Contains("CLUSTER BY (ORDER_DATE)", sql);
        Assert.Contains("COMMENT = 'Shop orders'", sql);
        Assert.Contains(s.Warnings, w => w.Contains("does not enforce"));
    }

    [Fact]
    public void Alter_widens_types_and_warns_on_narrowing()
    {
        var o = Orders();
        var d = o with
        {
            Columns =
            [
                o.Columns[0], o.Columns[1] with { Type = "NUMBER(38,2)" }, o.Columns[2] with { Type = "VARCHAR(200)", Nullable = false, Comment = null },
                o.Columns[3] with { Default = null },
            ],
            Indexes = [],
            Comment = null,
        };
        var s = Scripter.ScriptTable(o, d, Context);
        Golden.Match("snowflake_alter_types.sql", Golden.Render(s));
        Assert.Contains(s.Statements, x => x.Sql == "ALTER TABLE PUBLIC.ORDERS ALTER COLUMN NOTE SET DATA TYPE VARCHAR(200)" && x.Warning is null);
        Assert.Contains(s.Statements, x => x.Sql.EndsWith("CUSTOMER_ID SET DATA TYPE NUMBER(38,2)", StringComparison.Ordinal) && x.Warning is not null);
        Assert.Contains(s.Statements, x => x.Sql == "ALTER TABLE PUBLIC.ORDERS DROP CLUSTERING KEY");
        Assert.Contains(s.Statements, x => x.Sql == "ALTER TABLE PUBLIC.ORDERS UNSET COMMENT");
        Assert.True(SnowflakeDdlScripter.IsWidening("VARCHAR(10)", "STRING"));
        Assert.False(SnowflakeDdlScripter.IsWidening("NUMBER(10,2)", "NUMBER(12,3)"));
        Assert.False(SnowflakeDdlScripter.IsWidening("VARCHAR", "NUMBER"));
    }

    [Fact]
    public void Two_clustering_keys_are_refused()
    {
        var t = Orders() with { Indexes = [new IndexModel { Name = "A", Clustered = true, Columns = [new("ID")] }, new IndexModel { Name = "B", Clustered = true, Columns = [new("NOTE")] }] };
        Assert.Throws<ArgumentException>(() => Scripter.ScriptTable(null, t, Context));
    }

    [Fact]
    public void Views_create_and_replace_with_copy_grants()
    {
        var create = Scripter.ScriptView(new ViewDefinition("PUBLIC", "V_ORDERS", null, "SELECT * FROM ORDERS;", new ViewOptions()), Context);
        Assert.Equal("CREATE VIEW PUBLIC.V_ORDERS AS\nSELECT * FROM ORDERS", Assert.Single(create.Statements).Sql);
        var rename = Scripter.ScriptView(new ViewDefinition("PUBLIC", "V2", "V_ORDERS", "SELECT 1", new ViewOptions(CheckOption: true)), Context);
        Assert.Equal("ALTER VIEW PUBLIC.V_ORDERS RENAME TO PUBLIC.V2", rename.Statements[0].Sql);
        Assert.StartsWith("CREATE OR REPLACE VIEW PUBLIC.V2 COPY GRANTS AS", rename.Statements[1].Sql);
        Assert.NotEmpty(rename.Warnings);
    }

    [Fact]
    public void Types_and_features()
    {
        var info = Scripter.GetTypes(Context);
        Assert.Contains(info.Types, t => t.Name == "VARIANT");
        Assert.Contains(info.Types, t => t is { Name: "NUMBER", Params: "precisionScale" });
        Assert.False(info.Features.TransactionalDdl);
        Assert.True(info.Features.ClusteredIndexes);
        Assert.False(info.Features.Computed);
    }

    [Fact]
    public async Task Read_table_model_from_describe_and_keys()
    {
        var db = new SnowflakeDesignerDatabase(new FakeGatewayFactory());
        var t = await db.ReadTableAsync(SfTestProfiles.Shop(), "pw", "SHOP", "PUBLIC", "CUSTOMERS", CancellationToken.None);
        Assert.Equal("Shop customers", t.Comment);
        Assert.Equal(new IdentityModel(1, 1), t.Columns[0].Identity);
        Assert.Null(t.Columns[0].Default);
        Assert.Equal(("VARCHAR(200)", "en-ci"), (t.Columns[2].Type, t.Columns[2].Collation));
        Assert.Equal("PK_CUSTOMERS", t.PrimaryKey!.Name);
        Assert.Equal(["EMAIL"], Assert.Single(t.Uniques).Columns);
        var fk = Assert.Single(t.ForeignKeys);
        Assert.Equal(("COUNTRIES", "SET NULL"), (fk.RefTable, fk.OnDelete));

        var orders = await db.ReadTableAsync(SfTestProfiles.Shop(), "pw", "SHOP", "PUBLIC", "ORDERS", CancellationToken.None);
        Assert.Empty(orders.Indexes); // LINEAR(ORDER_DATE, TO_DATE(ORDER_DATE)): an expression key stays out of the model

        var plain = SnowflakeDesignerDatabase.BuildTableModel("PUBLIC", "ORDERS",
            SnowflakeFixtures.Find("DESCRIBE TABLE \"SHOP\".\"PUBLIC\".\"ORDERS\"")!.Result!,
            DbStudio.Logs.Sql.SqlRowSet.Of(["name", "comment", "cluster_by"], ["ORDERS", "", "LINEAR(order_date, CUSTOMER_ID)"]),
            new([], []), new([], []), new([], []));
        var cluster = Assert.Single(plain.Indexes);
        Assert.True(cluster.Clustered);
        Assert.Equal(["ORDER_DATE", "CUSTOMER_ID"], cluster.Columns.Select(c => c.Name));

        // Round trip: the model scripts no changes against itself.
        Assert.Empty(new SnowflakeDdlScripter().ScriptTable(orders, orders, Context).Statements);
    }

    [Fact]
    public async Task Read_view_splits_the_stored_ddl()
    {
        var db = new SnowflakeDesignerDatabase(new FakeGatewayFactory());
        var v = await db.ReadViewAsync(SfTestProfiles.Shop(), "pw", "SHOP", "PUBLIC", "CUSTOMER_ORDERS", CancellationToken.None);
        Assert.StartsWith("SELECT c.ID AS CUSTOMER_ID", v.Body);
        Assert.EndsWith("ON o.CUSTOMER_ID = c.ID", v.Body);
    }

    [Fact]
    public async Task Apply_runs_statement_by_statement_and_reports_the_failure()
    {
        var factory = new FakeGatewayFactory
        {
            Configure = g =>
            {
                g.Overrides["ALTER TABLE PUBLIC.ORDERS ADD COLUMN X INT"] = () => new DbStudio.Logs.Sql.SqlRowSet(["status"], [["Statement executed successfully."]]);
                g.Overrides["ALTER TABLE PUBLIC.ORDERS ALTER COLUMN X SET DATA TYPE VARCHAR"] = () =>
                    throw new Gateway.SnowflakeQueryException("SQL compilation error: cannot change column X from type NUMBER(38,0) to VARCHAR", 2263, "0A000", "01b7");
            },
        };
        var db = new SnowflakeDesignerDatabase(factory);
        var ex = await Assert.ThrowsAsync<DdlFailedException>(() => db.ApplyAsync(SfTestProfiles.Shop(), "pw",
            new DdlApplyRequest("ANALYTICS", ["ALTER TABLE PUBLIC.ORDERS ADD COLUMN X INT;", "ALTER TABLE PUBLIC.ORDERS ALTER COLUMN X SET DATA TYPE VARCHAR"], false),
            CancellationToken.None));
        Assert.Equal((1, 1, false), (ex.FailedIndex, ex.Executed, ex.RolledBack));
        Assert.Equal("002263", ex.ProviderError.Code);
        Assert.Equal("ANALYTICS", factory.Profiles.Single().GetString("database")); // opened on the target database
    }
}
