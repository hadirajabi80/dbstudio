using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Cassandra.Designer;
using DbStudio.Providers.Cassandra.Endpoints;
using DbStudio.Providers.Conformance;

namespace DbStudio.Providers.Cassandra.Tests;

/// <summary>
/// Integration tests against cassandra:5 (plan-batch3 WP-CS "Tests"): the applicable subset of the conformance suite with
/// CQL overrides, 5k-row paging, tracing, keyspace switch, data-grid statements (paging, edit by primary key, LWT checks),
/// values, catalog (MV/UDT/function/index), DDL, designer round trip, dependencies, object list, search and the cluster.
/// </summary>
[Collection(CassandraCollection.Name)]
public sealed class CassandraIntegrationTests(CassandraFixture fx)
{
    private void Require() => Skip.IfNot(fx.IsAvailable, fx.SkipReason ?? "Cassandra not available.");

    private async Task<(RecordingSink Sink, ExecutionSummary Summary)> RunAsync(IDbSession s, string sql, string label = "statement", int maxRows = 0,
        IReadOnlyList<QueryParam>? ps = null, bool stopOnError = true)
    {
        var sink = new RecordingSink();
        var summary = await s.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], maxRows, stopOnError, false, label, ps), sink, CancellationToken.None);
        return (sink, summary);
    }

    private static void Ok(RecordingSink sink, ExecutionSummary summary) =>
        Assert.True(summary.Status == ExecutionStatus.Ok, sink.Describe());

    private async Task<string> ScratchTableAsync(IDbSession s, string name, string columns)
    {
        var (sink, summary) = await RunAsync(s, $"DROP TABLE IF EXISTS {name}; CREATE TABLE {name} ({columns})");
        Ok(sink, summary);
        return name;
    }

    // ------------------------------------------------------------------ conformance subset

    [SkippableFact]
    public async Task TestConnection_Succeeds_WithServerInfo_AndFails_ForBadPort()
    {
        Require();
        var ok = await fx.Provider.TestAsync(fx.Profile, null, CancellationToken.None);
        Assert.True(ok.Ok, ok.Error?.Message);
        Assert.StartsWith("Apache Cassandra 5", ok.ServerInfo!.Version);
        Assert.Equal("5", ok.ServerInfo.ProductVersion!.Split('.')[0]);
        var bad = await fx.Provider.TestAsync(fx.CreateFailingProfile()!, null, CancellationToken.None);
        Assert.False(bad.Ok);
        Assert.Equal(CqlErrors.NoHostAvailable, bad.Error!.Code);
    }

    [SkippableFact]
    public async Task Session_IsIdle_InKeyspace_AndQueryStreamsColumnsAndRows()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        Assert.Equal(SessionState.Idle, s.State);
        Assert.Equal("shop", s.CurrentDatabase);
        Assert.Equal(Dialect.Cql, s.Dialect);
        var (sink, summary) = await RunAsync(s, "SELECT id, name, email FROM customers");
        Ok(sink, summary);
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(["id", "name", "email"], rs.Columns.Select(c => c.Name));
        Assert.Equal(ColumnKinds.Int, rs.Columns[0].Kind);
        Assert.Equal(5, rs.Rows.Count);
        Assert.Contains(rs.Rows, r => (string?)r[1] == "Alice");
    }

    [SkippableFact]
    public async Task Decimal_Uuid_Timestamp_Collections_Udt_AreWireValues()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (sink, summary) = await RunAsync(s, "SELECT total, order_date, shipping_address FROM orders WHERE id = 1; SELECT ext_id, tags, phones, preferences, address FROM customers WHERE id = 1");
        Ok(sink, summary);
        var order = sink.ResultSets[0];
        Assert.Equal(ColumnKinds.Decimal, order.Columns[0].Kind);
        Assert.Equal("120.50", order.Rows[0][0]);
        Assert.Equal(ColumnKinds.DateTimeOffset, order.Columns[1].Kind);
        Assert.Equal("2026-01-05T10:00:00+00:00", order.Rows[0][1]);
        Assert.Equal(ColumnKinds.Json, order.Columns[2].Kind);
        var address = JsonNode.Parse((string)order.Rows[0][2]!)!;
        Assert.Equal("Berlin", (string?)address["city"]);
        var cust = sink.ResultSets[1];
        Assert.Equal(ColumnKinds.Guid, cust.Columns[0].Kind);
        Assert.Equal("6f1c2b9e-8d4a-4c1e-9b7a-3e5d2f1a0b11", cust.Rows[0][0]);
        Assert.Equal("set<text>", cust.Columns[1].DbType);
        Assert.Equal("[\"newsletter\",\"vip\"]", cust.Rows[0][1]);
        Assert.Equal("{\"channel\":\"email\",\"language\":\"de\"}", cust.Rows[0][3]);
        Assert.Equal("10115", (string?)JsonNode.Parse((string)cust.Rows[0][4]!)!["postal_code"]);
    }

    [SkippableFact]
    public async Task PersianText_RoundTrips()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (sink, summary) = await RunAsync(s, "SELECT note FROM orders WHERE id = 5");
        Ok(sink, summary);
        Assert.Equal("سفارش فوری", sink.ResultSets[0].Rows[0][0]);
    }

    [SkippableFact]
    public async Task MultipleStatements_ProduceSeparateResultSets_AndBatchStaysWhole()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_batch", "id int PRIMARY KEY, val text");
        var (sink, summary) = await RunAsync(s, fx.InsertScratchRowsSql(t, 1, 3) + "; " + fx.MultiResultSetBatch);
        Ok(sink, summary);
        Assert.True(sink.ResultSets.Count == 2, sink.Describe());
        var (sink2, _) = await RunAsync(s, $"SELECT count(*) FROM {t}");
        Assert.Equal(3L, Convert.ToInt64(sink2.ResultSets[0].Rows[0][0]));
    }

    [SkippableFact]
    public async Task Paging_5000Rows_StreamsAll_AndMaxRowsTruncates()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_paging", "p int, c int, val text, PRIMARY KEY ((p), c)");
        for (var p = 0; p < 10; p++)
        {
            var batch = "BEGIN UNLOGGED BATCH " + string.Concat(Enumerable.Range(0, 500).Select(c => $"INSERT INTO {t} (p, c, val) VALUES ({p}, {c}, 'r{p}-{c}'); ")) + "APPLY BATCH";
            var (bs, bsum) = await RunAsync(s, batch);
            Ok(bs, bsum);
        }
        var (paging, _) = await RunAsync(s, "PAGING 700");
        Assert.Contains(paging.Messages, m => m.Text.Contains("700"));
        var (sink, summary) = await RunAsync(s, $"SELECT * FROM {t}");
        Ok(sink, summary);
        Assert.Equal(5000, sink.ResultSets[0].Rows.Count);
        Assert.False(sink.ResultSets[0].Truncated);
        Assert.True(sink.ResultSets[0].RowFrames >= 25); // 200-row chunks

        var (cap, capSummary) = await RunAsync(s, $"SELECT * FROM {t}", maxRows: 1234);
        Ok(cap, capSummary);
        Assert.Equal(1234, cap.ResultSets[0].Rows.Count);
        Assert.True(cap.ResultSets[0].Truncated);
    }

    [SkippableFact]
    public async Task DataGrid_Pages_ByOffset_ThroughPagingStates_AndIgnoresOrderBy()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_grid", "id int PRIMARY KEY, val text");
        var (bs, bsum) = await RunAsync(s, fx.InsertScratchRowsSql(t, 1, 250));
        Ok(bs, bsum);
        var seen = new HashSet<int>();
        for (var offset = 0; offset < 300; offset += 100)
        {
            var (sink, summary) = await RunAsync(s, $"SELECT *\nFROM {t}\nORDER BY id\nLIMIT 100 OFFSET {offset}", label: "data", maxRows: 100);
            Ok(sink, summary);
            foreach (var r in sink.ResultSets[0].Rows) Assert.True(seen.Add(Convert.ToInt32(r[0])));
        }
        Assert.Equal(250, seen.Count);
        // A jump without a cached paging state skips rows.
        await using var s2 = await fx.OpenSessionAsync();
        var (jump, jumpSummary) = await RunAsync(s2, $"SELECT * FROM {t} LIMIT 100 OFFSET 200", label: "data", maxRows: 100);
        Ok(jump, jumpSummary);
        Assert.Equal(50, jump.ResultSets[0].Rows.Count);
    }

    [SkippableFact]
    public async Task DataGrid_DescribeProbe_Count_Filter_Refetch_DistinctValues()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (probe, ps) = await RunAsync(s, "SELECT *\nFROM orders\nWHERE 1 = 0", label: "data", maxRows: 1);
        Ok(probe, ps);
        Assert.Empty(probe.ResultSets[0].Rows);
        Assert.Contains(probe.ResultSets[0].Columns, c => c.Name == "shipping_address");

        var (count, cs) = await RunAsync(s, "SELECT COUNT(*) AS \"row_count\"\nFROM orders\nWHERE status = @fp1", label: "data",
            ps: [new QueryParam("fp1", ParamKinds.String, JsonValue.Create("delivered"))]);
        Ok(count, cs);
        Assert.Equal(2L, Convert.ToInt64(count.ResultSets[0].Rows[0][0]));

        var (refetch, rs) = await RunAsync(s, "SELECT *\nFROM order_lines\nWHERE (order_id = @k1 AND product_id = @k2) OR (order_id = @k3 AND product_id = @k4)", label: "data",
            ps: [new QueryParam("k1", ParamKinds.Int, JsonValue.Create(1)), new QueryParam("k2", ParamKinds.Int, JsonValue.Create(2)),
                 new QueryParam("k3", ParamKinds.Int, JsonValue.Create(4)), new QueryParam("k4", ParamKinds.Int, JsonValue.Create(4))]);
        Ok(refetch, rs);
        Assert.Single(refetch.ResultSets);
        Assert.Equal(2, refetch.ResultSets[0].Rows.Count);

        var (distinct, ds) = await RunAsync(s, "SELECT status, COUNT(*) AS \"cnt\"\nFROM orders\nGROUP BY status\nORDER BY COUNT(*) DESC\nLIMIT 500", label: "data", maxRows: 501);
        Ok(distinct, ds);
        var top = distinct.ResultSets[0].Rows[0];
        Assert.Equal("delivered", top[0]);
        Assert.Equal(2L, Convert.ToInt64(top[1]));
    }

    [SkippableFact]
    public async Task DataGrid_EditByPrimaryKey_WithOptimisticCheck_AndInsertConflict()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_edit", "p int, c int, val text, tags set<text>, PRIMARY KEY ((p), c)");
        var insert = await RunAsync(s, $"INSERT INTO {t} (p, c, val, tags) VALUES (@p1, @p2, @p3, @p4)", label: "data",
            ps: [new QueryParam("p1", ParamKinds.Int, JsonValue.Create(1)), new QueryParam("p2", ParamKinds.Int, JsonValue.Create(2)),
                 new QueryParam("p3", ParamKinds.String, JsonValue.Create("a")), new QueryParam("p4", ParamKinds.String, JsonValue.Create("[\"x\",\"y\"]"))]);
        Ok(insert.Sink, insert.Summary);
        Assert.Equal(1, Assert.Single(insert.Sink.Affected).Count);

        var dup = await RunAsync(s, $"INSERT INTO {t} (p, c, val) VALUES (1, 2, 'b')", label: "data");
        Assert.Equal(ExecutionStatus.Error, dup.Summary.Status);
        Assert.Equal(CqlErrors.AlreadyExists, dup.Sink.Errors[0].Error.Code);

        // verifyUnchanged: the stale old value makes the LWT fail → 0 rows (conflict).
        var stale = await RunAsync(s, $"UPDATE {t} SET val = @p1 WHERE p = @p2 AND c = @p3 AND val = @p4", label: "data",
            ps: [new QueryParam("p1", ParamKinds.String, JsonValue.Create("new")), new QueryParam("p2", ParamKinds.Int, JsonValue.Create(1)),
                 new QueryParam("p3", ParamKinds.Int, JsonValue.Create(2)), new QueryParam("p4", ParamKinds.String, JsonValue.Create("not-a"))]);
        Ok(stale.Sink, stale.Summary);
        Assert.Equal(0, Assert.Single(stale.Sink.Affected).Count);
        var good = await RunAsync(s, $"UPDATE {t} SET val = @p1 WHERE p = @p2 AND c = @p3 AND val = @p4", label: "data",
            ps: [new QueryParam("p1", ParamKinds.String, JsonValue.Create("new")), new QueryParam("p2", ParamKinds.Int, JsonValue.Create(1)),
                 new QueryParam("p3", ParamKinds.Int, JsonValue.Create(2)), new QueryParam("p4", ParamKinds.String, JsonValue.Create("a"))]);
        Ok(good.Sink, good.Summary);
        Assert.Equal(1, Assert.Single(good.Sink.Affected).Count);
        // An update of a row that does not exist is a conflict too (no resurrection).
        var gone = await RunAsync(s, $"UPDATE {t} SET val = 'z' WHERE p = 9 AND c = 9", label: "data");
        Assert.Equal(0, Assert.Single(gone.Sink.Affected).Count);

        var del = await RunAsync(s, $"DELETE FROM {t} WHERE p = 1 AND c = 2", label: "data");
        Ok(del.Sink, del.Summary);
        var (after, _) = await RunAsync(s, $"SELECT * FROM {t}");
        Assert.Empty(after.ResultSets[0].Rows);
    }

    [SkippableFact]
    public async Task Params_BindAllScalarTypes_AndPositionalMarkers()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_types",
            "id uuid PRIMARY KEY, i int, b bigint, sm smallint, ti tinyint, vi varint, d decimal, f float, db double, ok boolean, ts timestamp, dt date, tm time, du duration, ip inet, bl blob, tu timeuuid, m map<text, int>, l list<frozen<tuple<int, text>>>");
        var id = Guid.NewGuid();
        var (sink, summary) = await RunAsync(s,
            $"INSERT INTO {t} (id, i, b, sm, ti, vi, d, f, db, ok, ts, dt, tm, du, ip, bl, tu, m, l) VALUES (:id, :i, :b, :sm, :ti, :vi, :d, :f, :db, :ok, :ts, :dt, :tm, :du, :ip, :bl, :tu, :m, :l)",
            ps:
            [
                new("id", ParamKinds.String, JsonValue.Create(id.ToString())), new("i", ParamKinds.Int, JsonValue.Create(7)), new("b", ParamKinds.Int, JsonValue.Create(9_000_000_000L)),
                new("sm", ParamKinds.Int, JsonValue.Create(3)), new("ti", ParamKinds.Int, JsonValue.Create(1)), new("vi", ParamKinds.String, JsonValue.Create("123456789012345678901234567890")),
                new("d", ParamKinds.Decimal, JsonValue.Create("12.345")), new("f", ParamKinds.Float, JsonValue.Create(1.5)), new("db", ParamKinds.Float, JsonValue.Create(2.25)),
                new("ok", ParamKinds.Int, JsonValue.Create(1)), new("ts", ParamKinds.DateTimeOffset, JsonValue.Create("2026-01-05T10:00:00Z")), new("dt", ParamKinds.Date, JsonValue.Create("2026-03-01")),
                new("tm", ParamKinds.Time, JsonValue.Create("08:15:30")), new("du", ParamKinds.String, JsonValue.Create("1h30m")), new("ip", ParamKinds.String, JsonValue.Create("10.0.0.1")),
                new("bl", ParamKinds.Binary, JsonValue.Create("0x0102ff")), new("tu", ParamKinds.String, JsonValue.Create("50554d6e-2bb1-11f1-8000-000000000001")),
                new("m", ParamKinds.String, JsonValue.Create("{\"a\": 1, \"b\": 2}")), new("l", ParamKinds.String, JsonValue.Create("[[1, \"x\"], [2, \"y\"]]")),
            ]);
        Ok(sink, summary);
        var (read, rs) = await RunAsync(s, $"SELECT i, b, vi, d, ok, ts, dt, tm, du, ip, bl, m, l FROM {t} WHERE id = ?", ps: [new("1", ParamKinds.Guid, JsonValue.Create(id.ToString()))]);
        Ok(read, rs);
        var r = read.ResultSets[0].Rows[0];
        Assert.Equal(7, Convert.ToInt32(r[0]));
        Assert.Equal("9000000000", Convert.ToString(r[1], System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal("123456789012345678901234567890", r[2]);
        Assert.Equal("12.345", r[3]);
        Assert.Equal(true, r[4]);
        Assert.Equal("2026-01-05T10:00:00+00:00", r[5]);
        Assert.Equal("2026-03-01", r[6]);
        Assert.Equal("08:15:30", r[7]);
        Assert.Equal("1h30m", r[8]);
        Assert.Equal("10.0.0.1", r[9]);
        Assert.IsType<BinaryValue>(r[10]);
        Assert.Equal("{\"a\":1,\"b\":2}", r[11]);
        Assert.Equal("[[1,\"x\"],[2,\"y\"]]", r[12]);
    }

    [SkippableFact]
    public async Task Errors_ReportProtocolCode_AndDocumentLine()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var sink = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT id FROM countries;\n\nSELEC x", 10, 1)], 0, true, false, "script"), sink, CancellationToken.None);
        var e = Assert.Single(sink.Errors).Error;
        Assert.True(e.Code == CqlErrors.SyntaxError, e.Code + ": " + e.Message);
        Assert.Equal(0x2000, e.ProviderCode);
        Assert.Equal(12, e.Line);
        var (inv, _) = await RunAsync(s, fx.InvalidQuery);
        Assert.Equal(CqlErrors.Invalid, inv.Errors[0].Error.Code);
    }

    [SkippableFact]
    public async Task StopOnError_StopsOrContinues()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var batches = new[] { new SqlBatch("SELECT * FROM no_such_table", 1, 1), new SqlBatch("SELECT id FROM countries", 2, 1) };
        var stop = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest(batches, 0, true, false, "script"), stop, CancellationToken.None);
        Assert.Empty(stop.ResultSets);
        var go = new RecordingSink();
        await s.ExecuteAsync(new ExecuteRequest(batches, 0, false, false, "script"), go, CancellationToken.None);
        Assert.Single(go.ResultSets);
    }

    [SkippableFact]
    public async Task Cancel_StopsPaging_AndSessionStaysUsable()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var t = await ScratchTableAsync(s, "it_cancel", "p int, c int, PRIMARY KEY ((p), c)");
        for (var p = 0; p < 4; p++)
        {
            var (bs, bsum) = await RunAsync(s, "BEGIN UNLOGGED BATCH " + string.Concat(Enumerable.Range(0, 500).Select(c => $"INSERT INTO {t} (p, c) VALUES ({p}, {c}); ")) + "APPLY BATCH");
            Ok(bs, bsum);
        }
        await RunAsync(s, "PAGING 5");
        var sink = new RecordingSink();
        var run = s.ExecuteAsync(new ExecuteRequest([new SqlBatch($"SELECT * FROM {t}", 1, 1)], 0, true, false, "statement"), sink, CancellationToken.None);
        while (sink.ResultSets.Count == 0 || sink.ResultSets[0].Rows.Count == 0) await Task.Delay(5);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        s.Cancel();
        var summary = await run;
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2));
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.True(sink.ResultSets[0].Rows.Count < 2000);
        s.Cancel(); // idle: no-op
        var (again, againSummary) = await RunAsync(s, "SELECT id FROM countries");
        Ok(again, againSummary);
    }

    [SkippableFact]
    public async Task Tracing_AddsTraceResultSet_AndRemembersIt()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var cql = (CqlSession)s;
        var (on, _) = await RunAsync(s, "TRACING ON");
        Assert.Contains(on.Messages, m => m.Text.Contains("Now tracing"));
        var (sink, summary) = await RunAsync(s, "SELECT * FROM orders WHERE id = 1");
        Ok(sink, summary);
        Assert.True(sink.ResultSets.Count == 2, sink.Describe());
        Assert.Equal("activity", sink.ResultSets[1].Columns[0].Name);
        Assert.True(sink.ResultSets[1].Rows.Count > 2);
        Assert.Contains(sink.Messages, m => m.Text.StartsWith("Tracing session: "));
        var traceId = cql.LastTraceId;
        Assert.NotNull(traceId);
        Assert.Single(cql.Traces());
        var (show, showSummary) = await RunAsync(s, $"SHOW SESSION {traceId}");
        Ok(show, showSummary);
        await RunAsync(s, "TRACING OFF");
        Assert.False(cql.Settings.Tracing);
    }

    [SkippableFact]
    public async Task ShellCommands_Consistency_Serial_ShowVersion_AndCopyRejected()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var cql = (CqlSession)s;
        var (c, _) = await RunAsync(s, "CONSISTENCY LOCAL_ONE; CONSISTENCY; SERIAL CONSISTENCY LOCAL_SERIAL");
        Assert.Equal(global::Cassandra.ConsistencyLevel.LocalOne, cql.Settings.Consistency);
        Assert.Equal(global::Cassandra.ConsistencyLevel.LocalSerial, cql.Settings.SerialConsistency);
        Assert.Contains(c.Messages, m => m.Text == "Current consistency level is LOCAL_ONE.");
        var (bad, badSummary) = await RunAsync(s, "CONSISTENCY SOMETIMES");
        Assert.Equal(ExecutionStatus.Error, badSummary.Status);
        var (v, vs) = await RunAsync(s, "SHOW VERSION");
        Ok(v, vs);
        Assert.StartsWith("5.", (string)v.ResultSets[0].Rows[0][1]!);
        var (copy, _) = await RunAsync(s, "COPY shop.orders TO 'x.csv'");
        Assert.Equal(ErrorCodes.NotSupported, copy.Errors[0].Error.Code);
    }

    [SkippableFact]
    public async Task ManualTransactions_AreNotSupported_WithExplanation()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var ex = await Assert.ThrowsAsync<EngineException>(() => s.SetTransactionModeAsync(TransactionMode.Manual, CancellationToken.None));
        Assert.Equal(ErrorCodes.NotSupported, ex.Code);
        Assert.Contains("BEGIN BATCH", ex.Message);
        var (sink, _) = await RunAsync(s, "BEGIN TRANSACTION");
        Assert.Equal(ErrorCodes.NotSupported, sink.Errors[0].Error.Code);
        await s.CommitAsync(CancellationToken.None);
        Assert.False(s.TxOpen);
    }

    [SkippableFact]
    public async Task Use_And_ChangeDatabase_SwitchKeyspace()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (sink, summary) = await RunAsync(s, "USE system_schema; SELECT count(*) FROM keyspaces");
        Ok(sink, summary);
        Assert.Equal("system_schema", s.CurrentDatabase);
        await s.ChangeDatabaseAsync("shop", CancellationToken.None);
        Assert.Equal("shop", s.CurrentDatabase);
    }

    [SkippableFact]
    public async Task Lwt_ShowsApplied_AndWarns()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (sink, summary) = await RunAsync(s, "UPDATE orders SET note = 'x' WHERE id = 1 IF status = 'nope'");
        Ok(sink, summary);
        Assert.Equal("[applied]", sink.ResultSets[0].Columns[0].Name);
        Assert.Equal(false, sink.ResultSets[0].Rows[0][0]);
        Assert.Contains(sink.Messages, m => m.Text.StartsWith("Not applied"));
    }

    [SkippableFact]
    public async Task Describe_RunsOnTheServer()
    {
        Require();
        await using var s = await fx.OpenSessionAsync();
        var (sink, summary) = await RunAsync(s, "DESCRIBE TABLE orders");
        Ok(sink, summary);
        Assert.Contains(sink.ResultSets[0].Rows, r => ((string)r[3]!).StartsWith("CREATE TABLE shop.orders"));
    }

    // ------------------------------------------------------------------ catalog

    [SkippableFact]
    public async Task Catalog_ListsKeyspaces_DefaultIsProfileKeyspace()
    {
        Require();
        await using var c = await fx.OpenCatalogAsync();
        var schemas = await c.ListSchemasAsync(null, CancellationToken.None);
        Assert.Contains(schemas, s => s.Name == "shop" && s.ObjectCount >= 10);
        Assert.DoesNotContain(schemas, s => s.Name == "system_schema");
        Assert.Equal("shop", await c.GetDefaultSchemaAsync(null, CancellationToken.None));
        Assert.Empty(await c.ListDatabasesAsync(CancellationToken.None));
    }

    [SkippableFact]
    public async Task Catalog_LoadSchema_TablesViewsTypesFunctions_WithKeyRoles()
    {
        Require();
        await using var c = await fx.OpenCatalogAsync();
        var schema = await c.LoadSchemaAsync(null, "shop", CancellationToken.None);
        var obc = schema.Objects.Single(o => o.Name == "orders_by_customer");
        Assert.Equal(ObjectTypes.Table, obc.Type);
        Assert.Equal(["customer_id", "order_date", "order_id"], obc.PrimaryKey);
        Assert.Equal("partition key", obc.Columns[0].Comment);
        Assert.Equal("clustering key DESC", obc.Columns[1].Comment);
        Assert.Equal("clustering key ASC", obc.Columns[2].Comment);
        Assert.False(obc.Columns[0].Nullable);
        var events = schema.Objects.Single(o => o.Name == "events_by_day");
        Assert.Equal("partition key (1 of 2)", events.Columns[0].Comment);
        Assert.Equal(ObjectTypes.MView, schema.Objects.Single(o => o.Name == "orders_by_status").Type);
        var udt = schema.Objects.Single(o => o.Name == "address");
        Assert.Equal(ObjectTypes.Type, udt.Type);
        Assert.Equal(4, udt.Columns.Count);
        var fn = schema.Objects.Single(o => o.Name == "line_total");
        Assert.Equal(ObjectTypes.Func, fn.Type);
        Assert.Equal("decimal", fn.Parameters.Single(p => p.Direction == "return").TypeText);
        Assert.Equal("frozen<address>", schema.Objects.Single(o => o.Name == "customers").Columns.Single(x => x.Name == "address").TypeText);
    }

    [SkippableFact]
    public async Task Catalog_ObjectDetails_IndexesAndDdl()
    {
        Require();
        await using var c = await fx.OpenCatalogAsync();
        var d = await c.GetObjectDetailsAsync(new ObjectRef(null, "shop", "customers", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains(d.Indexes, i => i.IsPrimaryKey && i.Columns.SequenceEqual(["id"]));
        Assert.Contains(d.Indexes, i => i.Name == "customers_email_idx" && i.Type == "SAI");
        var ddl = await c.GetDdlAsync(new ObjectRef(null, "shop", "orders_by_customer", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("CLUSTERING ORDER BY (order_date DESC, order_id ASC)", ddl.Ddl);
        var generated = CqlCatalogReader.GeneratedDdl((await ((CqlCatalogReader)c).KeyspaceAsync("shop", CancellationToken.None))!,
            new ObjectRef(null, "shop", "customers", ObjectTypes.Table));
        Assert.Contains("CREATE INDEX customers_email_idx ON shop.customers (email) USING 'sai';", generated);
        var view = await c.GetDdlAsync(new ObjectRef(null, "shop", "orders_by_status", ObjectTypes.MView), CancellationToken.None);
        Assert.Contains("CREATE MATERIALIZED VIEW shop.orders_by_status", view.Ddl);
        var type = await c.GetDdlAsync(new ObjectRef(null, "shop", "address", ObjectTypes.Type), CancellationToken.None);
        Assert.Contains("postal_code text", type.Ddl);
        var func = await c.GetDdlAsync(new ObjectRef(null, "shop", "line_total", ObjectTypes.Func), CancellationToken.None);
        Assert.Contains("RETURNS NULL ON NULL INPUT", func.Ddl);
    }

    [SkippableFact]
    public async Task Dependencies_ViewIndexAndUdtUsage()
    {
        Require();
        var browser = (CqlObjectBrowser)await fx.CqlProvider.OpenDependencyReaderAsync(fx.Profile, null, CancellationToken.None);
        await using (browser)
        {
            var orders = await browser.GetDependenciesAsync(new ObjectRef(null, "shop", "orders", ObjectTypes.Table), CancellationToken.None);
            Assert.Contains(orders.UsedBy, d => d.Object.Name == "orders_by_status" && d.Kind == DependencyKinds.UsedBy);
            Assert.Contains(orders.Uses, d => d.Object.Name == "address" && d.Object.Type == ObjectTypes.Type);
            var view = await browser.GetDependenciesAsync(new ObjectRef(null, "shop", "orders_by_status", ObjectTypes.MView), CancellationToken.None);
            Assert.Contains(view.Uses, d => d.Object.Name == "orders");
            var udt = await browser.GetDependenciesAsync(new ObjectRef(null, "shop", "address", ObjectTypes.Type), CancellationToken.None);
            Assert.Contains(udt.UsedBy, d => d.Object.Name == "customers");
            Assert.Contains(udt.UsedBy, d => d.Object.Name == "orders");
            var customers = await browser.GetDependenciesAsync(new ObjectRef(null, "shop", "customers", ObjectTypes.Table), CancellationToken.None);
            Assert.Contains(customers.UsedBy, d => d.Kind == DependencyKinds.Index && d.Object.Name == "customers_email_idx");

            var list = await browser.ListAsync(null, "shop", null, CancellationToken.None);
            Assert.Contains(list, i => i.Type == ObjectTypes.Table && i.Name == "orders" && i.Comment == "Orders by id");
            Assert.Contains(list, i => i.Type == ObjectTypes.MView && i.Name == "orders_by_status");
            Assert.Contains(list, i => i.Type == ObjectTypes.Type && i.Name == "address");
            Assert.Contains(list, i => i.Type == ObjectTypes.Func && i.Name == "line_total");
        }
    }

    [SkippableFact]
    public async Task Search_NamesColumnsAndCode()
    {
        Require();
        await using var searcher = await fx.CqlProvider.OpenSearcherAsync(fx.Profile, null, CancellationToken.None);
        var names = await searcher.NamesAsync(null, "shop", null, false, CancellationToken.None);
        Assert.Contains(names, n => n.Name == "orders_by_status" && n.Type == ObjectTypes.MView);
        var cols = await searcher.ColumnsAsync(null, "shop", null, false, CancellationToken.None);
        Assert.Contains(cols, c => c.Column == "postal_code" && c.Object == "address");
        var code = new List<DbStudio.Core.Search.SearchCodeRow>();
        await foreach (var r in searcher.CodeAsync(null, "shop", null, false, CancellationToken.None)) code.Add(r);
        Assert.Contains(code, r => r.Name == "line_total" && r.Text.Contains("multiply"));
    }

    // ------------------------------------------------------------------ designer

    [SkippableFact]
    public async Task Designer_CreateReadAlter_RoundTrip()
    {
        Require();
        var db = new CqlDesignerDatabase(fx.CqlProvider);
        var scripter = new CqlDdlScripter();
        await db.ApplyAsync(fx.Profile, null, new DdlApplyRequest(null, ["DROP TABLE IF EXISTS shop.it_designed"], false), CancellationToken.None);
        var context = await db.GetScriptContextAsync(fx.Profile, null, null, "shop", null, CancellationToken.None);
        Assert.StartsWith("5.", context.ServerVersion);
        var model = new TableModel
        {
            Schema = "shop",
            Name = "it_designed",
            Comment = "Designed in Rowlit",
            Columns =
            [
                new() { Name = "tenant", Type = "text" }, new() { Name = "day", Type = "date" }, new() { Name = "at", Type = "timestamp" },
                new() { Name = "owner", Type = "text", Comment = "static" }, new() { Name = "payload", Type = "map<text, text>" },
            ],
            PrimaryKey = new PrimaryKeyModel { Columns = ["tenant", "day", "at"] },
            Uniques = [new UniqueModel { Name = "partition_key", Columns = ["tenant", "day"] }],
            Indexes = [new IndexModel { Name = "clustering_order", Columns = [new("at", Desc: true)] }, new IndexModel { Name = "it_designed_owner_idx", Columns = [new("payload")], Filter = "keys" }],
            Checks = [new CheckModel { Name = "default_time_to_live", Expression = "3600" }],
        };
        var create = scripter.ScriptTable(null, model, context);
        Assert.Contains("PRIMARY KEY ((tenant, day), at)", create.Statements[0].Sql);
        await db.ApplyAsync(fx.Profile, null, new DdlApplyRequest(null, create.Statements.Select(x => x.Sql).ToList(), false), CancellationToken.None);

        var read = await db.ReadTableAsync(fx.Profile, null, null, "shop", "it_designed", CancellationToken.None);
        Assert.Equal(["tenant", "day", "at"], read.PrimaryKey!.Columns);
        Assert.Equal(["tenant", "day"], read.Uniques.Single().Columns);
        Assert.True(read.Indexes.Single(i => i.Name == "clustering_order").Columns.Single().Desc);
        Assert.Equal("keys", read.Indexes.Single(i => i.Name == "it_designed_owner_idx").Filter);
        Assert.Equal("static", read.Column("owner")!.Comment);
        Assert.Equal("3600", read.Checks.Single(c => c.Name == "default_time_to_live").Expression);
        Assert.Equal("Designed in Rowlit", read.Comment);
        Assert.Empty(scripter.ScriptTable(read, read, context).Statements);

        var altered = read with
        {
            Columns = [.. read.Columns, new TableColumnModel { Name = "note", Type = "text" }],
            Checks = [new CheckModel { Name = "default_time_to_live", Expression = "7200" }],
        };
        var alter = scripter.ScriptTable(read, altered, context);
        Assert.Contains(alter.Statements, x => x.Sql.Contains("ADD note text"));
        Assert.Contains(alter.Statements, x => x.Sql.Contains("default_time_to_live = 7200"));
        await db.ApplyAsync(fx.Profile, null, new DdlApplyRequest(null, alter.Statements.Select(x => x.Sql).ToList(), false), CancellationToken.None);
        var reread = await db.ReadTableAsync(fx.Profile, null, null, "shop", "it_designed", CancellationToken.None);
        Assert.NotNull(reread.Column("note"));

        Assert.Throws<ArgumentException>(() => scripter.ScriptTable(reread, reread with { PrimaryKey = new PrimaryKeyModel { Columns = ["tenant", "day"] } }, context));
        var failed = await Assert.ThrowsAsync<DdlFailedException>(() => db.ApplyAsync(fx.Profile, null,
            new DdlApplyRequest(null, ["ALTER TABLE shop.it_designed ADD extra int", "ALTER TABLE shop.it_designed ADD extra int"], false), CancellationToken.None));
        Assert.Equal(1, failed.FailedIndex);
        Assert.Equal(1, failed.Executed);
        Assert.False(failed.RolledBack);
    }

    // ------------------------------------------------------------------ module endpoints

    [SkippableFact]
    public async Task Cluster_ListsTheNode_AndDataCenter()
    {
        Require();
        await using var catalog = await fx.CqlProvider.OpenCqlCatalogAsync(fx.Profile, null, CancellationToken.None);
        var info = await CassandraEndpoints.ClusterAsync(catalog, CancellationToken.None);
        var node = Assert.Single(info.Nodes);
        Assert.True(node.IsUp);
        Assert.True(node.IsLocal);
        Assert.Equal("cassandra", info.Product);
        Assert.Single(info.DataCenters);
        Assert.True(info.SchemaInAgreement);
        Assert.True(node.Tokens > 0);
    }

    [SkippableFact]
    public async Task Explain_IsNotSupported_PointsToTracing()
    {
        Require();
        var services = new Microsoft.Extensions.DependencyInjection.ServiceCollection();
        new CassandraModule().ConfigureServices(services);
        await using var sp = Microsoft.Extensions.DependencyInjection.ServiceCollectionContainerBuilderExtensions.BuildServiceProvider(services);
        var features = ProviderFeatures.FromServices(sp);
        var ex = Assert.Throws<EngineException>(() => features.PlanReader(CassandraProvider.ProviderId));
        Assert.Equal(ErrorCodes.NotSupported, ex.Code);
        Assert.Contains("TRACING ON", ex.Message);
    }
}
