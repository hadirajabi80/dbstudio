using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;
using Cassandra;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.Cassandra.Designer;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Cassandra.Tests;

/// <summary>Server-free tests: CQL text rules, settings, DDL goldens, values, errors, designer mapping and module wiring.</summary>
public sealed class CassandraUnitTests
{
    // ------------------------------------------------------------------ CqlText

    [Fact]
    public void Split_KeepsBatchesAndDollarBodiesWhole_AndSkipsComments()
    {
        var sql = """
            -- comment; with semicolon
            // another; comment
            SELECT * FROM t; /* block; */
            BEGIN UNLOGGED BATCH
              INSERT INTO t (a) VALUES (1);
              INSERT INTO t (a) VALUES (2);
            APPLY BATCH;
            CREATE FUNCTION f(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ return x; $$;
            INSERT INTO t (m) VALUES ({'k': 'v;w'})
            """;
        var statements = CqlText.Split(sql);
        Assert.Equal(4, statements.Count);
        Assert.Equal("SELECT * FROM t", statements[0].Text);
        Assert.StartsWith("BEGIN UNLOGGED BATCH", statements[1].Text);
        Assert.EndsWith("APPLY BATCH", statements[1].Text);
        Assert.EndsWith("$$ return x; $$", statements[2].Text);
        Assert.Equal("INSERT", statements[3].Head);
    }

    [Fact]
    public void Tokenize_UuidsBlobsDurationsAndMarkers()
    {
        var t = CqlText.Tokenize("SELECT * FROM t WHERE id = 6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11 AND b = 0xCAFE AND d = 1h30m AND x = :name AND y = ? AND z = @p1");
        Assert.Contains(t, x => x.Kind == CqlTokenKind.Number && x.Value == "6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11");
        Assert.Contains(t, x => x.Kind == CqlTokenKind.Number && x.Value == "0xCAFE");
        Assert.Contains(t, x => x.Kind == CqlTokenKind.Number && x.Value == "1h30m");
        Assert.Equal([":name", "?", "@p1"], t.Where(x => x.Kind == CqlTokenKind.Param).Select(x => x.Value));
        var (text, names) = CqlText.PositionalMarkers("UPDATE t SET a = @p1 WHERE k = :k AND c = ? AND s = '@notaparam'");
        Assert.Equal("UPDATE t SET a = ? WHERE k = ? AND c = ? AND s = '@notaparam'", text);
        Assert.Equal(["p1", "k", null], names);
    }

    [Theory]
    [InlineData("orders", "orders")]
    [InlineData("Orders", "\"Orders\"")]
    [InlineData("select", "\"select\"")]
    [InlineData("a\"b", "\"a\"\"b\"")]
    [InlineData("order_lines2", "order_lines2")]
    public void Quote_OnlyWhenNeeded(string name, string expected) => Assert.Equal(expected, CqlText.Quote(name));

    [Fact]
    public void LineColAt_IsOneBased() => Assert.Equal((3, 2), CqlText.LineColAt("a\nb\n cd", 5));

    // ------------------------------------------------------------------ settings

    [Fact]
    public void Settings_ParseProfile_WithDefaultsAndHostPorts()
    {
        var p = new ConnectionProfile
        {
            Id = "c1", ProviderId = "cassandra",
            Props = new() { ["contactPoints"] = "10.0.0.1, 10.0.0.2:9142", ["consistency"] = "local_one", ["serialConsistency"] = "LOCAL_SERIAL", ["pageSize"] = 50_000, ["keyspace"] = "shop" },
        };
        var s = CqlConnectionSettings.From(p);
        Assert.Equal(["10.0.0.1", "10.0.0.2:9142"], s.ContactPoints);
        Assert.Equal(ConsistencyLevel.LocalOne, s.Consistency);
        Assert.Equal(ConsistencyLevel.LocalSerial, s.SerialConsistency);
        Assert.Equal(CqlConnectionSettings.MaxPageSize, s.PageSize);
        Assert.Equal("shop", s.Keyspace);
        Assert.Equal(("10.0.0.2", 9142), CqlClusterPool.SplitHostPort("10.0.0.2:9142"));
        Assert.Equal(("::1", 9042), CqlClusterPool.SplitHostPort("[::1]:9042"));
        Assert.Equal(("cassandra-dev", null), CqlClusterPool.SplitHostPort("cassandra-dev"));
        Assert.Contains("consistency=LOCAL_ONE", s.Describe());
        Assert.DoesNotContain("password", s.Describe());
        Assert.Throws<ArgumentException>(() => CqlConnectionSettings.From(new ConnectionProfile { ProviderId = "cassandra" }));
    }

    [Fact]
    public void Fingerprint_ChangesWithPasswordAndAddress()
    {
        var p = new ConnectionProfile { Id = "c1", Props = new() { ["contactPoints"] = "a" } };
        var s = CqlConnectionSettings.From(p);
        Assert.NotEqual(s.Fingerprint("x"), s.Fingerprint("y"));
        Assert.NotEqual(s.Fingerprint("x"), (s with { Port = 1 }).Fingerprint("x"));
        Assert.Equal(s.Fingerprint("x"), CqlConnectionSettings.From(p).Fingerprint("x"));
    }

    [Theory]
    [InlineData("LOCAL_QUORUM", ConsistencyLevel.LocalQuorum)]
    [InlineData("each_quorum", ConsistencyLevel.EachQuorum)]
    [InlineData("One", ConsistencyLevel.One)]
    [InlineData("LOCAL_SERIAL", ConsistencyLevel.LocalSerial)]
    public void Consistency_ParsesCqlshSpelling(string text, ConsistencyLevel level)
    {
        Assert.True(CqlConnectionSettings.TryParseConsistency(text, out var parsed));
        Assert.Equal(level, parsed);
        Assert.Equal(text.ToUpperInvariant() == "ONE" ? "ONE" : text.ToUpperInvariant(), CqlConnectionSettings.ConsistencyName(level));
    }

    // ------------------------------------------------------------------ DDL goldens

    private static CqlTableMeta OrdersByCustomer() => new()
    {
        Keyspace = "shop",
        Name = "orders_by_customer",
        Columns =
        [
            new("total", "decimal", "regular", -1, "none"),
            new("order_id", "int", "clustering", 1, "asc"),
            new("customer_id", "int", "partition_key", 0, "none"),
            new("order_date", "timestamp", "clustering", 0, "desc"),
            new("customer_name", "text", "static", -1, "none"),
        ],
        Options = [new("comment", "'Orders of a customer'"), new("default_time_to_live", "0")],
    };

    [Theory]
    [InlineData(new[] { "a" }, new string[0], "PRIMARY KEY (a)")]
    [InlineData(new[] { "a" }, new[] { "b", "c" }, "PRIMARY KEY (a, b, c)")]
    [InlineData(new[] { "a", "b" }, new string[0], "PRIMARY KEY ((a, b))")]
    [InlineData(new[] { "a", "Day" }, new[] { "at" }, "PRIMARY KEY ((a, \"Day\"), at)")]
    public void PrimaryKeyText_Golden(string[] partition, string[] clustering, string expected) =>
        Assert.Equal(expected, CqlDdl.PrimaryKeyText(partition, clustering));

    [Fact]
    public void TableDdl_Golden()
    {
        Assert.Equal("""
            CREATE TABLE shop.orders_by_customer (
                customer_id int,
                order_date timestamp,
                order_id int,
                customer_name text STATIC,
                total decimal,
                PRIMARY KEY (customer_id, order_date, order_id)
            ) WITH CLUSTERING ORDER BY (order_date DESC, order_id ASC)
                AND comment = 'Orders of a customer'
                AND default_time_to_live = 0;
            """.ReplaceLineEndings("\n"), CqlDdl.Table(OrdersByCustomer()));
        var single = new CqlTableMeta { Keyspace = "shop", Name = "countries", Columns = [new("id", "int", "partition_key", 0, "none"), new("name", "text", "regular", -1, "none")] };
        Assert.Equal("CREATE TABLE shop.countries (\n    id int PRIMARY KEY,\n    name text\n);", CqlDdl.Table(single));
    }

    [Fact]
    public void ViewTypeFunctionIndexDdl_Golden()
    {
        var view = new CqlTableMeta
        {
            Keyspace = "shop", Name = "orders_by_status", IsView = true, BaseTable = "orders", WhereClause = "status IS NOT NULL AND id IS NOT NULL",
            Columns = [new("status", "text", "partition_key", 0, "none"), new("id", "int", "clustering", 0, "asc"), new("total", "decimal", "regular", -1, "none")],
        };
        Assert.Equal("CREATE MATERIALIZED VIEW shop.orders_by_status AS\n    SELECT status, id, total\n    FROM shop.orders\n    WHERE status IS NOT NULL AND id IS NOT NULL\n    PRIMARY KEY (status, id) WITH CLUSTERING ORDER BY (id ASC);",
            CqlDdl.View(view));
        Assert.Equal("CREATE TYPE shop.address (\n    street text,\n    city text\n);", CqlDdl.Type(new CqlTypeMeta("shop", "address", [("street", "text"), ("city", "text")])));
        var fn = new CqlFunctionMeta("shop", "line_total", ["qty", "unit_price"], ["int", "decimal"], "decimal", "java", " return null; ", false, false, false);
        Assert.Equal("CREATE FUNCTION shop.line_total(qty int, unit_price decimal)\n    RETURNS NULL ON NULL INPUT\n    RETURNS decimal\n    LANGUAGE java\n    AS $$ return null; $$;", CqlDdl.Function(fn));
        var sai = new CqlIndexMeta("shop", "customers", "customers_email_idx", "CUSTOM", new Dictionary<string, string> { ["target"] = "email", ["class_name"] = "org.apache.cassandra.index.sai.StorageAttachedIndex" });
        Assert.Equal("CREATE INDEX customers_email_idx ON shop.customers (email) USING 'sai';", CqlDdl.Index(sai));
        var keys = new CqlIndexMeta("shop", "t", "t_tags", "COMPOSITES", new Dictionary<string, string> { ["target"] = "keys(tags)" });
        Assert.Equal("CREATE INDEX t_tags ON shop.t (keys(tags));", CqlDdl.Index(keys));
        Assert.Equal("CREATE KEYSPACE shop WITH replication = {'class': 'SimpleStrategy', 'replication_factor': '1'} AND durable_writes = true;",
            CqlDdl.Keyspace(new CqlKeyspaceMeta { Name = "shop", Replication = new Dictionary<string, string> { ["replication_factor"] = "1", ["class"] = "SimpleStrategy" } }));
    }

    [Fact]
    public void Catalog_RoleComments_AndTableObject()
    {
        var t = OrdersByCustomer();
        var o = CqlCatalogReader.TableObject(t, ObjectTypes.Table);
        Assert.Equal(["customer_id", "order_date", "order_id"], o.PrimaryKey);
        Assert.Equal(["partition key", "clustering key DESC", "clustering key ASC", "static", null], o.Columns.Select(c => c.Comment));
        Assert.Equal([false, false, false, true, true], o.Columns.Select(c => c.Nullable));
        var gen = new CqlDdl.Generator().GenerateTableDdl(new ObjectRef(null, "shop", "orders_by_customer", "table"),
            new ObjectDetails(new ObjectRef(null, "shop", "orders_by_customer", "table"),
                o.Columns.Select((c, i) => new ColumnDetail(c.Name, c.TypeText, c.Nullable, null, c.IsPk, false, false, c.Comment, i + 1)).ToList(),
                [], [], [], [], [], null, null, null));
        Assert.Contains("PRIMARY KEY (customer_id, order_date, order_id)", gen);
        Assert.Contains("CLUSTERING ORDER BY (order_date DESC, order_id ASC)", gen);
        Assert.Contains("customer_name text STATIC", gen);
    }

    [Fact]
    public void TypeReferences_FindUdts()
    {
        Assert.Equal([(null, "address")], CqlObjectBrowser.TypeReferences("frozen<address>").ToList());
        Assert.Equal([("shop", "address")], CqlObjectBrowser.TypeReferences("list<frozen<shop.address>>").ToList());
        Assert.Empty(CqlObjectBrowser.TypeReferences("map<text, frozen<list<int>>>"));
    }

    // ------------------------------------------------------------------ values

    private static byte[] Field(byte[]? value)
    {
        var len = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(len, value?.Length ?? -1);
        return value is null ? len : [.. len, .. value];
    }

    [Fact]
    public void Udt_BytesDecodeToJson()
    {
        var udt = new UdtColumnInfo("shop.address");
        udt.Fields.Add(new ColumnDesc { Name = "street", TypeCode = ColumnTypeCode.Text });
        udt.Fields.Add(new ColumnDesc { Name = "zip", TypeCode = ColumnTypeCode.Int });
        udt.Fields.Add(new ColumnDesc { Name = "note", TypeCode = ColumnTypeCode.Text });
        var zip = new byte[4];
        BinaryPrimitives.WriteInt32BigEndian(zip, 10115);
        byte[] bytes = [.. Field(Encoding.UTF8.GetBytes("Hauptstraße 1")), .. Field(zip), .. Field(null)];
        var wire = CqlValues.ToWire(bytes, ColumnTypeCode.Udt, udt);
        Assert.Equal("{\"street\":\"Hauptstraße 1\",\"zip\":10115,\"note\":null}", wire);
        Assert.Equal("address", CqlValues.TypeName(ColumnTypeCode.Udt, udt));
        Assert.Equal(ColumnKinds.Json, CqlValues.KindFor(ColumnTypeCode.Udt, udt));
    }

    [Fact]
    public void Decode_DecimalVarintDurationDateTime()
    {
        // decimal 120.50 = unscaled 12050, scale 2
        byte[] dec = [0, 0, 0, 2, 0x2F, 0x12];
        Assert.Equal("120.50", CqlValues.Decode(dec, ColumnTypeCode.Decimal, null));
        Assert.Equal("-1", CqlValues.Decode([0xFF], ColumnTypeCode.Varint, null)!.ToString());
        // duration 1 month, 2 days, 3 ns: zig-zag vints 2, 4, 6
        Assert.Equal(new Duration(1, 2, 3).ToString(), CqlValues.Decode([2, 4, 6], ColumnTypeCode.Duration, null));
        // date: 2^31 = 1970-01-01
        Assert.Equal("1970-01-02", CqlValues.Decode([0x80, 0, 0, 1], ColumnTypeCode.Date, null));
    }

    [Fact]
    public void Literal_ForCollectionsTuplesAndUdts()
    {
        var map = new MapColumnInfo { KeyTypeCode = ColumnTypeCode.Text, ValueTypeCode = ColumnTypeCode.Int };
        Assert.Equal("{'a': 1, 'b': 2}", CqlValues.Literal("{\"a\": 1, \"b\": 2}", ColumnTypeCode.Map, map));
        var set = new SetColumnInfo { KeyTypeCode = ColumnTypeCode.Uuid };
        Assert.Equal("{6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11}", CqlValues.Literal("[\"6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11\"]", ColumnTypeCode.Set, set));
        var tuple = new TupleColumnInfo();
        tuple.Elements.Add(new ColumnDesc { TypeCode = ColumnTypeCode.Int });
        tuple.Elements.Add(new ColumnDesc { TypeCode = ColumnTypeCode.Text });
        var list = new ListColumnInfo { ValueTypeCode = ColumnTypeCode.Tuple, ValueTypeInfo = tuple };
        Assert.Equal("[(1, 'it''s')]", CqlValues.Literal("[[1, \"it's\"]]", ColumnTypeCode.List, list));
        var udt = new UdtColumnInfo("shop.address");
        udt.Fields.Add(new ColumnDesc { Name = "city", TypeCode = ColumnTypeCode.Text });
        udt.Fields.Add(new ColumnDesc { Name = "since", TypeCode = ColumnTypeCode.Timestamp });
        Assert.Equal("{city: 'Berlin', since: '2026-01-05T10:00:00.000Z'}", CqlValues.Literal("{\"City\": \"Berlin\", \"since\": \"2026-01-05T10:00:00Z\"}", ColumnTypeCode.Udt, udt));
        Assert.Throws<FormatException>(() => CqlValues.Literal("not json", ColumnTypeCode.Map, map));
    }

    [Fact]
    public void ToBind_ConvertsGridValuesToDriverTypes()
    {
        Assert.Equal(7, CqlValues.ToBind(7L, ColumnTypeCode.Int, null));
        Assert.Equal((short)7, CqlValues.ToBind(7L, ColumnTypeCode.SmallInt, null));
        Assert.Equal(true, CqlValues.ToBind(1L, ColumnTypeCode.Boolean, null));
        Assert.Equal(Guid.Parse("6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11"), CqlValues.ToBind("6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11", ColumnTypeCode.Timeuuid, null));
        Assert.Equal(new LocalDate(2026, 3, 1), CqlValues.ToBind(new DateTime(2026, 3, 1), ColumnTypeCode.Date, null));
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 10, 0, 0, TimeSpan.Zero), CqlValues.ToBind(new DateTime(2026, 1, 5, 10, 0, 0, DateTimeKind.Unspecified), ColumnTypeCode.Timestamp, null));
        Assert.Equal(System.Numerics.BigInteger.Parse("123456789012345678901234567890"), CqlValues.ToBind("123456789012345678901234567890", ColumnTypeCode.Varint, null));
        Assert.Throws<FormatException>(() => CqlValues.ToBind("x", ColumnTypeCode.Int, null));
    }

    // ------------------------------------------------------------------ errors

    [Fact]
    public void Errors_MapSyntaxLineToDocument_AndConsistencyDetail()
    {
        var batch = new SqlBatch("SELECT 1;\n  SELEC x", 5, 3);
        var e = CqlErrors.ToError(new global::Cassandra.SyntaxError("line 1:0 no viable alternative at input 'SELEC'"), batch, 12);
        Assert.Equal(CqlErrors.SyntaxError, e.Code);
        Assert.Equal(6, e.Line);
        Assert.Equal(3, e.Col);
        var u = CqlErrors.ToError(new UnavailableException(ConsistencyLevel.Quorum, 2, 1));
        Assert.Equal(CqlErrors.Unavailable, u.Code);
        Assert.Contains("QUORUM needs 2 replica(s), 1 alive", u.Message);
        Assert.Equal(0x1000, u.ProviderCode);
    }

    // ------------------------------------------------------------------ data-grid statement shapes

    [Fact]
    public void SelectShape_FindsClauses()
    {
        var t = CqlText.Tokenize("SELECT * FROM t WHERE a = 1 ORDER BY a DESC PER PARTITION LIMIT 2 LIMIT 100 OFFSET 200 ALLOW FILTERING");
        var s = CqlSession.ShapeOf(t);
        Assert.True(s.From > 0 && s.Where > s.From && s.OrderBy > s.Where && s.PerPartition > s.OrderBy && s.Limit > s.PerPartition && s.Offset > s.Limit && s.Allow > s.Offset);
        Assert.Equal(s.OrderBy, s.ClauseEnd(s.Where));
    }

    // ------------------------------------------------------------------ designer

    private static TableModel Designed() => new()
    {
        Schema = "shop",
        Name = "events",
        Comment = "It's here",
        Columns =
        [
            new() { Name = "tenant", Type = "text" }, new() { Name = "day", Type = "date" }, new() { Name = "at", Type = "timeuuid" },
            new() { Name = "owner", Type = "text", Comment = "static" }, new() { Name = "tags", Type = "set<text>" },
        ],
        PrimaryKey = new PrimaryKeyModel { Columns = ["tenant", "day", "at"] },
        Uniques = [new UniqueModel { Name = "partition_key", Columns = ["tenant", "day"] }],
        Indexes = [new IndexModel { Name = "clustering_order", Columns = [new("at", Desc: true)] }, new IndexModel { Name = "events_tags", Columns = [new("tags")] }],
        Checks = [new CheckModel { Name = "default_time_to_live", Expression = "86400" }],
    };

    [Fact]
    public void Designer_CreateTable_Golden()
    {
        var script = new CqlDdlScripter().ScriptTable(null, Designed(), new DdlScriptContext("5.0.2", "shop"));
        Assert.False(script.Transactional);
        Assert.Equal("""
            CREATE TABLE shop.events (
                tenant text,
                day date,
                at timeuuid,
                owner text STATIC,
                tags set<text>,
                PRIMARY KEY ((tenant, day), at)
            ) WITH CLUSTERING ORDER BY (at DESC)
                AND comment = 'It''s here'
                AND default_time_to_live = 86400
            """.ReplaceLineEndings("\n"), script.Statements[0].Sql);
        Assert.Equal("CREATE INDEX IF NOT EXISTS events_tags ON shop.events (tags) USING 'sai'", script.Statements[1].Sql);
        var old = new CqlDdlScripter().ScriptTable(null, Designed(), new DdlScriptContext("4.1.3", "shop"));
        Assert.Equal("CREATE INDEX IF NOT EXISTS events_tags ON shop.events (tags)", old.Statements[1].Sql);
    }

    [Fact]
    public void Designer_DefaultsToFirstKeyColumnAsPartitionKey_AndWarnsAboutFks()
    {
        var t = new TableModel
        {
            Schema = "shop", Name = "t",
            Columns = [new() { Name = "a", Type = "int" }, new() { Name = "b", Type = "int" }],
            PrimaryKey = new PrimaryKeyModel { Columns = ["a", "b"] },
            ForeignKeys = [new ForeignKeyModel { Name = "fk", Columns = ["b"], RefTable = "x" }],
        };
        var s = new CqlDdlScripter().ScriptTable(null, t, new DdlScriptContext("5.0", "shop"));
        Assert.Contains("PRIMARY KEY (a, b)", s.Statements[0].Sql);
        Assert.Contains(s.Warnings, w => w.Contains("foreign keys"));
        Assert.Throws<ArgumentException>(() => new CqlDdlScripter().ScriptTable(null, t with { PrimaryKey = null }, new DdlScriptContext("5.0", "shop")));
    }

    [Fact]
    public void Designer_Alter_AddDropOptionsIndexes_AndRefusesKeyChanges()
    {
        var scripter = new CqlDdlScripter();
        var ctx = new DdlScriptContext("5.0.2", "shop");
        var original = Designed();
        var desired = original with
        {
            Columns = [.. original.Columns.Where(c => c.Name != "tags"), new TableColumnModel { Name = "note", Type = "text" }],
            Comment = null,
            Checks = [new CheckModel { Name = "gc_grace_seconds", Expression = "3600" }],
            Indexes = [original.Indexes[0], new IndexModel { Name = "events_note", Columns = [new("note")] }],
        };
        var s = scripter.ScriptTable(original, desired, ctx).Statements.Select(x => x.Sql).ToList();
        Assert.Contains("ALTER TABLE shop.events DROP tags", s);
        Assert.Contains("ALTER TABLE shop.events ADD note text", s);
        Assert.Contains(s, x => x.StartsWith("ALTER TABLE shop.events WITH gc_grace_seconds = 3600", StringComparison.Ordinal) && x.Contains("comment = ''") && x.Contains("default_time_to_live = 0"));
        Assert.Contains("DROP INDEX IF EXISTS shop.events_tags", s);
        Assert.Contains("CREATE INDEX IF NOT EXISTS events_note ON shop.events (note) USING 'sai'", s);

        Assert.Throws<ArgumentException>(() => scripter.ScriptTable(original, original with { Name = "renamed" }, ctx));
        Assert.Throws<ArgumentException>(() => scripter.ScriptTable(original, original with { Uniques = [] }, ctx));
        Assert.Throws<ArgumentException>(() => scripter.ScriptTable(original,
            original with { Columns = original.Columns.Select(c => c.Name == "tags" ? c with { Type = "list<text>" } : c).ToList() }, ctx));
        var renameKey = original with
        {
            Columns = original.Columns.Select(c => c.Name == "at" ? c with { Name = "event_at", Id = "at" } : c with { Id = c.Name }).ToList(),
            PrimaryKey = new PrimaryKeyModel { Columns = ["tenant", "day", "event_at"] },
            Indexes = [new IndexModel { Name = "clustering_order", Columns = [new("event_at", Desc: true)] }, original.Indexes[1]],
        };
        var withIds = original with { Columns = original.Columns.Select(c => c with { Id = c.Name }).ToList() };
        Assert.Contains("ALTER TABLE shop.events RENAME at TO event_at", scripter.ScriptTable(withIds, renameKey, ctx).Statements.Select(x => x.Sql));
    }

    [Fact]
    public void Designer_ReadModel_RoundTripsThroughTheScripter()
    {
        var ks = new CqlKeyspaceMeta { Name = "shop" };
        var meta = OrdersByCustomer();
        ks.Tables.Add(meta);
        var model = CqlDesignerDatabase.ToModel(ks, meta);
        Assert.Empty(model.Uniques); // single-column partition key
        Assert.Equal("clustering_order", Assert.Single(model.Indexes).Name);
        Assert.Empty(model.Checks); // default_time_to_live = 0 is the default
        var create = new CqlDdlScripter().ScriptTable(null, model, new DdlScriptContext("5.0", "shop"));
        Assert.Contains("PRIMARY KEY (customer_id, order_date, order_id)", create.Statements[0].Sql);
        Assert.Contains("customer_name text STATIC", create.Statements[0].Sql);
        Assert.Contains("CLUSTERING ORDER BY (order_date DESC, order_id ASC)", create.Statements[0].Sql);
        Assert.Equal(("keys", "tags"), CqlDesignerDatabase.SplitTarget("keys(tags)"));
        Assert.Equal((null, "Email"), CqlDesignerDatabase.SplitTarget("\"Email\""));
    }

    [Fact]
    public void Designer_TypesAndFeatures()
    {
        var info = new CqlDdlScripter().GetTypes(DdlScriptContext.Default);
        Assert.Contains(info.Types, t => t.Name == "timeuuid");
        Assert.Contains(info.Types, t => t.Default == "map<text, text>");
        Assert.False(info.Features.TransactionalDdl);
        Assert.False(info.Features.Identity);
        Assert.True(info.Features.Schemas);
    }

    // ------------------------------------------------------------------ module / classification

    [Fact]
    public void Module_RegistersProviderDesignerAndRefusesExplain()
    {
        var services = new ServiceCollection();
        new CassandraModule().ConfigureServices(services);
        using var sp = services.BuildServiceProvider();
        var provider = Assert.Single(sp.GetServices<IDbProvider>());
        Assert.Equal("cassandra", provider.Id);
        Assert.Equal(Dialect.Cql, provider.Dialect);
        Assert.IsAssignableFrom<IObjectBrowserProvider>(provider);
        Assert.IsAssignableFrom<DbStudio.Core.Search.IDatabaseSearchProvider>(provider);
        Assert.NotNull(sp.GetKeyedService<IDdlScripter>("cassandra"));
        Assert.NotNull(sp.GetKeyedService<IDesignerDatabase>("cassandra"));
        var ex = Assert.Throws<EngineException>(() => sp.GetKeyedService<IPlanReader>("cassandra"));
        Assert.Equal(ErrorCodes.NotSupported, ex.Code);
        Assert.Contains(provider.FormSpec.Fields, f => f.Key == "contactPoints" && f.Required);
        Assert.Equal("lower", provider.Identifiers.CaseFolding);
    }

    [Theory]
    [InlineData("BEGIN BATCH INSERT INTO t (a) VALUES (1); UPDATE t SET b = 1 WHERE a = 1; APPLY BATCH", StatementCategory.Dml, "BATCH", false)]
    [InlineData("DESCRIBE TABLE shop.orders", StatementCategory.Query, "DESCRIBE", true)]
    [InlineData("CONSISTENCY QUORUM", StatementCategory.Session, "CONSISTENCY", true)]
    [InlineData("TRACING ON", StatementCategory.Session, "TRACING", true)]
    [InlineData("LIST ROLES", StatementCategory.Query, "LIST", true)]
    [InlineData("USE shop", StatementCategory.Session, "USE", true)]
    [InlineData("TRUNCATE orders", StatementCategory.Ddl, "TRUNCATE TABLE", false)]
    public void Classifier_CqlHeads(string sql, StatementCategory category, string kind, bool queryOnly)
    {
        var c = StatementClassifier.Classify(sql, Dialect.Cql);
        Assert.Equal(category, c.Statements[0].Category);
        Assert.Equal(kind, c.Statements[0].Kind);
        Assert.Equal(queryOnly, c.IsQueryOnly);
    }

    [Theory]
    [InlineData("CREATE KEYSPACE ks WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}", "schema", DdlScope.Database)]
    [InlineData("DROP KEYSPACE IF EXISTS ks", "schema", DdlScope.Database)]
    [InlineData("CREATE MATERIALIZED VIEW ks.v AS SELECT * FROM ks.t WHERE a IS NOT NULL PRIMARY KEY (a)", "mview", DdlScope.Object)]
    [InlineData("CREATE TYPE IF NOT EXISTS ks.address (city text)", "type", DdlScope.Object)]
    [InlineData("CREATE CUSTOM INDEX i ON ks.t (a) USING 'StorageAttachedIndex'", "index", DdlScope.Object)]
    [InlineData("ALTER TABLE ks.t ADD c int", "table", DdlScope.Object)]
    public void Classifier_CqlDdlTargets(string sql, string objectType, DdlScope scope)
    {
        var ddl = Assert.Single(StatementClassifier.Classify(sql, Dialect.Cql).DdlTargets);
        Assert.Equal(objectType, ddl.ObjectType);
        Assert.Equal(scope, ddl.Scope);
    }
}
