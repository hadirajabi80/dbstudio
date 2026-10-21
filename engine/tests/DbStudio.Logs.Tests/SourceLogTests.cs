using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;
using DbStudio.Logs.Providers.Kafka;
using DbStudio.Logs.Providers.Mongo;
using DbStudio.Logs.Providers.Redis;
using static DbStudio.Logs.Tests.Rows;

namespace DbStudio.Logs.Tests;

public sealed class RedisLogTests
{
    /// <summary>A recorded SLOWLOG GET 2 reply (Redis 7.2).</summary>
    private const string SlowlogReply =
        "*2\r\n" +
        "*6\r\n:14\r\n:1760792531\r\n:1204512\r\n*2\r\n$4\r\nKEYS\r\n$6\r\nuser:*\r\n$14\r\n10.0.0.5:51234\r\n$6\r\nworker\r\n" +
        "*6\r\n:13\r\n:1760792500\r\n:2210\r\n*3\r\n$4\r\nHGET\r\n$9\r\nsession:7\r\n$7\r\nlast se\r\n$14\r\n10.0.0.7:40112\r\n$0\r\n\r\n";

    private static LogTarget RedisTarget(int port, string? user = null) =>
        Target("redis", props: new Dictionary<string, JsonNode?> { ["host"] = "127.0.0.1", ["port"] = port, ["user"] = user, ["connectTimeout"] = 5 });

    [Fact]
    public void Parses_recorded_slowlog_reply()
    {
        var reply = Resp.Parse(SlowlogReply);
        var entries = RedisLogSource.ParseSlowlog(reply, null);
        Assert.Equal([14L, 13L], entries.Select(e => e.Seq));
        Assert.Equal("error", entries[0].Level); // 1.2 s
        Assert.Equal("1204.512 ms  KEYS user:*", entries[0].Message);
        Assert.Equal("worker", entries[0].Fields!["clientName"]);
        Assert.Equal("10.0.0.5:51234", entries[0].Source);
        Assert.Equal("2.21 ms  HGET session:7 \"last se\"", entries[1].Message);
        Assert.Equal("info", entries[1].Level);
        Assert.False(entries[1].Fields!.ContainsKey("clientName"));
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1760792531), entries[0].Time);
    }

    [Fact]
    public void Resp_round_trips_and_reports_errors()
    {
        var v = RespValue.Arr(RespValue.Str("a b"), RespValue.Int(-3), RespValue.Null, RespValue.Arr());
        var back = Resp.Parse(System.Text.Encoding.UTF8.GetString(Resp.EncodeReply(v)));
        Assert.Equal("a b", back.Array[0].AsString());
        Assert.Equal(-3, back.Array[1].AsLong());
        Assert.True(back.Array[2].IsNull);
        Assert.Empty(back.Array[3].Array);
        Assert.True(Resp.Parse("-NOPERM this user has no permissions to run the 'slowlog' command\r\n").IsError);
        Assert.True(new RedisReplyException("NOPERM this user has no permissions").IsPermission);
        Assert.Equal("*2\r\n$3\r\nGET\r\n$1\r\nk\r\n", System.Text.Encoding.UTF8.GetString(Resp.Encode(["GET", "k"])));
    }

    [Fact]
    public void Parses_latency_latest_and_history()
    {
        var latest = Resp.Parse("*1\r\n*4\r\n$7\r\ncommand\r\n:1760792531\r\n:120\r\n:480\r\n");
        var history = new Dictionary<string, RespValue> { ["command"] = Resp.Parse("*2\r\n*2\r\n:1760792400\r\n:48\r\n*2\r\n:1760792531\r\n:120\r\n") };
        var entries = RedisLogSource.ParseLatency(latest, history, null);
        Assert.Equal(2, entries.Count);
        Assert.Equal("command: 120 ms (max 480 ms)", entries[1].Message);
        Assert.Equal("warn", entries[1].Level);
        Assert.Equal("info", entries[0].Level);
        Assert.Single(RedisLogSource.ParseLatency(latest, new Dictionary<string, RespValue>(), "n1:6379"));
    }

    [Fact]
    public void Parses_monitor_lines()
    {
        var seq = new TimeSeq();
        var e = RedisLogSource.ParseMonitorLine("1760792531.123456 [0 127.0.0.1:52555] \"SET\" \"k\" \"a \\\"b\\\"\" \"\\xe2\\x82\\xac\"", seq)!;
        Assert.Equal("SET k \"a \\\"b\\\"\" €", e.Message);
        Assert.Equal("127.0.0.1:52555", e.Fields!["client"]);
        Assert.Equal("0", e.Fields["db"]);
        Assert.Equal("SET", e.Fields["command"]);
        Assert.Equal("2025-10-18T13:02:11.123Z", e.Ts);
        var lua = RedisLogSource.ParseMonitorLine("1760792531.2 [0 lua] \"GET\" \"x\"", seq)!;
        Assert.Equal("lua", lua.Source);
        Assert.Null(RedisLogSource.ParseMonitorLine("OK", seq));
        Assert.Equal(["a b", "", "x\ny"], RedisLogSource.UnquoteArgs(" \"a b\" \"\" \"x\\ny\""));
    }

    [Fact]
    public void Parses_client_list()
    {
        const string text = "id=12 addr=10.0.0.5:51234 laddr=10.0.0.1:6379 fd=8 name=worker age=3600 idle=0 flags=b db=0 sub=0 psub=0 multi=-1 cmd=blpop user=default lib-name=redis-py\n" +
                            "id=15 addr=10.0.0.7:40112 laddr=10.0.0.1:6379 fd=9 name= age=86400 idle=12 flags=N db=2 cmd=get user=app\n" +
                            "id=99 addr=127.0.0.1:60110 fd=10 name=DbStudio-logs age=1 idle=0 flags=N db=0 cmd=client|list user=default\n";
        var now = DateTimeOffset.Parse("2026-10-18T13:00:00Z");
        var rows = RedisLogSource.ParseClientList(text, 99, null, now);
        Assert.Equal(3, rows.Count);
        Assert.Equal("blocked", rows[0].State);
        Assert.Equal("blocking command", rows[0].WaitType);
        Assert.Equal("worker", rows[0].App);
        Assert.Equal("idle", rows[1].State);
        Assert.Equal("redis-py", RedisLogSource.ParseClientList(text.Replace("name=worker", "name="), null, null, now)[0].App);
        Assert.False(rows[2].CanKill); // our own connection
        Assert.Equal("CLIENT KILL ID 15", rows[1].Fields!["killStatement"]);
        Assert.Equal("2026-10-17T13:00:00.000Z", rows[1].Since);
        Assert.Equal("15@n2:7000", RedisLogSource.ParseClientList(text, null, "n2:7000", now)[1].Id);
    }

    [Fact]
    public void Parses_cluster_nodes_and_addresses()
    {
        const string nodes = "07c37dfeb235213a872192d90877d0cd55635b91 127.0.0.1:30004@31004,hostname4 slave e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca 0 1426238317239 4 connected\n" +
                             "67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 127.0.0.1:30002@31002 master - 0 1426238316232 2 connected 5461-10922\n" +
                             "6ec23923021cf3ffec47632106199cb7f496ce01 127.0.0.1:30005@31005 slave,fail 67ed2db8d677e59ec4a4cefb06858cf2a1a89fa1 0 1426238316232 5 connected\n" +
                             "e7d1eecce10fd6bb5eb35b9f99a514335d9ba9ca :0@0 master,noaddr - 1426238316232 1426238316232 1 disconnected\n";
        Assert.Equal(["127.0.0.1:30004", "127.0.0.1:30002"], RespRedisGateway.ParseClusterNodes(nodes));
        Assert.Equal(("::1", 6380), RespRedisGateway.ParseAddress("[::1]:6380", 6379));
        Assert.Equal(("redis.local", 6379), RespRedisGateway.ParseAddress("redis.local", 6379));
    }

    [Fact]
    public async Task Slowlog_and_clients_over_a_fake_resp_server()
    {
        await using var server = new FakeRespServer { Password = "s3cret" };
        server.On("SLOWLOG GET", Resp.Parse(SlowlogReply)).On("SLOWLOG LEN", RespValue.Int(2))
            .On("CONFIG GET", RespValue.Arr(RespValue.Str("latency-monitor-threshold"), RespValue.Str("0")))
            .On("LATENCY LATEST", RespValue.Arr()).On("CLIENT LIST", RespValue.Str("id=12 addr=1.2.3.4:5 name=w age=1 idle=0 flags=N db=0 cmd=get user=default\n"))
            .On("CLIENT KILL", RespValue.Int(1));
        await using var gateway = new RespRedisGateway(_ => "s3cret");
        var src = new RedisLogSource(gateway);
        var target = RedisTarget(server.Port);

        var list = await src.ListAsync(target, default);
        Assert.Equal(["slowlog", "latency", "monitor", "activity"], list.Select(s => s.Id));
        Assert.Equal("CONFIG SET latency-monitor-threshold 100", list[1].Needs);
        Assert.True(list[1].Available);
        Assert.False(list[2].SupportsRange);

        var page = await src.QueryAsync(target, LogFilter.Validate(new LogQuery("slowlog", Before: 14)), default);
        Assert.Equal([13L], page.Entries.Select(e => e.Seq));
        Assert.Contains(server.Commands, c => c[0] == "AUTH" && c[^1] == "s3cret");
        Assert.Contains(server.Commands, c => c is ["SLOWLOG", "GET", "1000"]);

        var clients = await src.SnapshotAsync(target, default);
        Assert.Single(clients);
        var kill = await src.KillAsync(target, new LogKillRequest("12", "client"), default);
        Assert.True(kill.Killed);
        Assert.Contains(server.Commands, c => c is ["CLIENT", "KILL", "ID", "12"]);
    }

    [Fact]
    public async Task Noperm_becomes_privilege_with_acl_hint()
    {
        await using var server = new FakeRespServer();
        server.On("SLOWLOG", RespValue.Err("NOPERM User app has no permissions to run the 'slowlog|get' command"));
        await using var gateway = new RespRedisGateway(_ => null);
        var src = new RedisLogSource(gateway);
        var ex = await Assert.ThrowsAsync<EngineException>(() => src.QueryAsync(RedisTarget(server.Port, "app"), LogFilter.Validate(new LogQuery("slowlog")), default));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
        var list = await src.ListAsync(RedisTarget(server.Port, "app"), default);
        Assert.False(list[0].Available);
        Assert.Equal("ACL SETUSER app +slowlog", list[0].Needs);
    }

    [Fact]
    public async Task Monitor_streams_live_entries()
    {
        await using var server = new FakeRespServer { MonitorLines = ["1760792531.1 [0 1.2.3.4:5] \"GET\" \"a\"", "1760792531.2 [0 1.2.3.4:5] \"SET\" \"b\" \"1\""] };
        await using var gateway = new RespRedisGateway(_ => null);
        var src = new RedisLogSource(gateway);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var got = new List<LogEntry>();
        await foreach (var e in src.OpenLive(RedisTarget(server.Port), "monitor", cts.Token)!)
        {
            got.Add(e);
            if (got.Count == 2) break;
        }
        Assert.Equal(["GET a", "SET b 1"], got.Select(e => e.Message));
        Assert.Null(src.OpenLive(RedisTarget(server.Port), "slowlog", default));
    }

    [Fact]
    public async Task Unreachable_server_is_source_unavailable()
    {
        await using var gateway = new RespRedisGateway(_ => null);
        var ex = await Assert.ThrowsAsync<EngineException>(() => new RedisLogSource(gateway).QueryAsync(RedisTarget(1), LogFilter.Validate(new LogQuery("slowlog")), default));
        Assert.Equal(ErrorCodes.SourceUnavailable, ex.Code);
    }
}

public sealed class MongoLogTests
{
    [Fact]
    public void Parses_getlog_json_lines()
    {
        var reply = JsonDocument.Parse(Fixture("mongo-getlog.json")).RootElement;
        var (entries, truncated) = MongoLogSource.ParseGetLog(reply);
        Assert.True(truncated);
        Assert.Equal(4, entries.Count);
        Assert.Equal("Connection accepted", entries[0].Message);
        Assert.Equal("NETWORK", entries[0].Source);
        Assert.Equal("10.0.0.9:50122", entries[0].Fields!["attr.remote"]);
        Assert.Equal("2026-10-18T13:02:11.213Z", entries[0].Ts);
        Assert.Equal("warn", entries[1].Level);
        Assert.Equal("Slow query (154 ms)", entries[1].Message);
        Assert.Contains("\"planSummary\":\"COLLSCAN\"", entries[1].Detail);
        Assert.Equal("debug", entries[2].Level);
        Assert.Equal("error", entries[3].Level); // legacy text line
        Assert.Equal("CONTROL", entries[3].Source);
    }

    [Theory]
    [InlineData("F", "fatal")]
    [InlineData("E", "error")]
    [InlineData("W", "warn")]
    [InlineData("I", "info")]
    [InlineData("D3", "debug")]
    [InlineData(null, "unknown")]
    public void Mongo_levels(string? s, string level) => Assert.Equal(level, MongoLogSource.LevelOf(s));

    [Fact]
    public void Parses_profiler_documents()
    {
        var docs = JsonDocument.Parse("""
            [{"op":"query","ns":"shop.orders","command":{"find":"orders","filter":{"status":"open"}},"keysExamined":0,"docsExamined":120344,"nreturned":12,"millis":154,"planSummary":"COLLSCAN","ts":{"$date":"2026-10-18T13:02:00.000Z"},"client":"10.0.0.9","user":"app@shop"},
             {"op":"command","ns":"shop.products","command":{"aggregate":"products"},"millis":{"$numberLong":"1500"},"planSummary":"IXSCAN { category: 1 }","ts":{"$date":{"$numberLong":"1760792400000"}}}]
            """).RootElement;
        var e = MongoLogSource.ParseProfiler(docs);
        Assert.Equal("command shop.products 1500 ms IXSCAN { category: 1 }", e[0].Message);
        Assert.Equal("error", e[0].Level);
        Assert.Equal("warn", e[1].Level);
        Assert.Equal("120344", e[1].Fields!["docsExamined"]);
        Assert.Contains("\"find\":\"orders\"", e[1].Detail);
        Assert.True(e[0].Seq < e[1].Seq);
    }

    [Fact]
    public void Profiler_command_has_time_bounds()
    {
        var cmd = MongoLogSource.ProfilerCommand(LogFilter.Validate(new LogQuery("profiler:shop", From: DateTimeOffset.Parse("2026-10-18T12:00:00Z"), Limit: 50)));
        Assert.Equal("""{"find": "system.profile", "filter": {"ts": {"$gte": {"$date": "2026-10-18T12:00:00.000Z"}}}, "sort": {"ts": -1}, "limit": 51, "singleBatch": true}""", cmd);
        using var _ = JsonDocument.Parse(cmd);
    }

    [Fact]
    public void Parses_current_op()
    {
        var ops = JsonDocument.Parse("""
            [{"type":"op","host":"m1:27017","desc":"conn42","connectionId":42,"client":"10.0.0.9:50122","appName":"shop-api","active":true,"currentOpTime":"2026-10-18T13:02:00.000+00:00","effectiveUsers":[{"user":"app","db":"shop"}],"opid":12345,"secs_running":154,"microsecs_running":{"$numberLong":"154000123"},"op":"query","ns":"shop.orders","command":{"find":"orders"},"planSummary":"COLLSCAN","waitingForLock":false},
             {"type":"op","desc":"ReplWriterWorker-1","active":true,"opid":"shard01:777","op":"none","ns":"","waitingForLock":true}]
            """).RootElement;
        var rows = MongoLogSource.ParseCurrentOp(ops);
        Assert.Equal("12345", rows[0].Id);
        Assert.Equal(154000, rows[0].DurationMs);
        Assert.Equal("app", rows[0].User);
        Assert.Equal("shop", rows[0].Database);
        Assert.Equal("db.killOp(12345)", rows[0].Fields!["killStatement"]);
        Assert.True(rows[0].CanKill);
        Assert.Equal("waiting for lock", rows[1].State);
        Assert.False(rows[1].CanKill); // internal thread
        Assert.Equal("db.killOp(\"shard01:777\")", rows[1].Fields!["killStatement"]);
    }

    [Fact]
    public async Task Lists_sources_with_profiler_and_privilege_hints()
    {
        var gw = new FakeMongoGateway()
            .OnFail("getLog", 13, "Unauthorized")
            .On("hello", """{"isWritablePrimary": true, "setName": "rs0", "ok": 1}""")
            .On("listDatabases", """{"databases": [{"name": "admin"}, {"name": "shop"}, {"name": "local"}], "ok": 1}""")
            .On("profile", """{"was": 0, "slowms": 100, "ok": 1}""");
        var list = await new MongoLogSource(gw).ListAsync(Target("mongodb", props: new() { ["uri"] = "mongodb://app:pw@m1:27017/shop" }), default);
        Assert.Equal(["getLog", "profiler:shop", "changes", "activity"], list.Select(s => s.Id));
        Assert.False(list[0].Available);
        Assert.Equal("db.getSiblingDB(\"admin\").grantRolesToUser(\"app\", [{ role: \"clusterMonitor\", db: \"admin\" }])", list[0].Needs);
        Assert.True(list[1].Available);
        Assert.Equal("db.getSiblingDB(\"shop\").setProfilingLevel(1, { slowms: 100 })", list[1].Needs);
        Assert.True(list[2].Available);
        Assert.Contains(gw.Calls, c => c.Db == "shop" && c.Command.Contains("\"profile\": -1"));
    }

    [Fact]
    public async Task Standalone_has_no_change_stream_and_getlog_denial_is_privilege()
    {
        var gw = new FakeMongoGateway().On("hello", """{"isWritablePrimary": true, "ok": 1}""").OnFail("listDatabases", 13, "Unauthorized");
        var list = await new MongoLogSource(gw).ListAsync(Target("mongodb"), default);
        Assert.False(list.Single(s => s.Id == "changes").Available);
        var denied = new FakeMongoGateway().OnFail("getLog", 13, "Unauthorized");
        var ex = await Assert.ThrowsAsync<EngineException>(() => new MongoLogSource(denied).QueryAsync(Target("mongodb"), LogFilter.Validate(new LogQuery("getLog")), default));
        Assert.Equal(ErrorCodes.Privilege, ex.Code);
        await Assert.ThrowsAsync<EngineException>(() => new MongoLogSource(gw).QueryAsync(Target("mongodb"), LogFilter.Validate(new LogQuery("profiler:a\"b")), default));
    }

    [Fact]
    public async Task Change_stream_uses_getmore_until_cancelled()
    {
        var getMores = 0;
        var gw = new FakeMongoGateway()
            .On("aggregate", """{"cursor": {"id": 7356782, "firstBatch": [{"operationType": "insert", "ns": {"db": "shop", "coll": "orders"}, "documentKey": {"_id": 1}, "wallTime": {"$date": "2026-10-18T13:00:00.000Z"}}]}, "ok": 1}""")
            .On("getMore", (_, cmd) =>
            {
                Assert.Contains("\"$numberLong\": \"7356782\"", cmd);
                getMores++;
                return JsonDocument.Parse("""{"cursor": {"id": 7356782, "nextBatch": [{"operationType": "drop", "ns": {"db": "shop", "coll": "tmp"}}]}, "ok": 1}""").RootElement.Clone();
            });
        var src = new MongoLogSource(gw);
        var got = new List<LogEntry>();
        await foreach (var e in src.OpenLive(Target("mongodb"), "changes", default)!)
        {
            got.Add(e);
            if (got.Count == 3) break;
        }
        Assert.Equal("insert shop.orders {\"_id\": 1}", got[0].Message);
        Assert.Equal("warn", got[1].Level);
        Assert.Equal(2, getMores);
    }

    [Fact]
    public async Task Kill_op_validates_ids()
    {
        var gw = new FakeMongoGateway().On("killOp", """{"info": "attempting to kill op", "ok": 1}""");
        var src = new MongoLogSource(gw);
        Assert.True((await src.KillAsync(Target("mongodb"), new LogKillRequest("12345", "op"), default)).Killed);
        Assert.Contains(gw.Calls, c => c.Command == """{"killOp": 1, "op": 12345}""");
        await src.KillAsync(Target("mongodb"), new LogKillRequest("shard01:777", "op"), default);
        Assert.Contains(gw.Calls, c => c.Command == """{"killOp": 1, "op": "shard01:777"}""");
        await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("mongodb"), new LogKillRequest("1}, {\"x\": 1", "op"), default));
    }
}

public sealed class KafkaLogTests
{
    [Fact]
    public void Parses_librdkafka_log_lines()
    {
        var l = ReflectionKafkaGateway.ParseLine("%3|1760792531.123|FAIL|rdkafka#consumer-2| [thrd:127.0.0.1:9093/2]: 127.0.0.1:9093/2: Connect to ipv4#127.0.0.1:9093 failed: Connection refused")!;
        Assert.Equal(3, l.Level);
        Assert.Equal("FAIL", l.Facility);
        Assert.Equal("rdkafka#consumer-2", l.Name);
        Assert.StartsWith("[thrd:127.0.0.1:9093/2]", l.Message);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1760792531123), l.Ts);
        Assert.Null(ReflectionKafkaGateway.ParseLine("not a log line"));
    }

    [Theory]
    [InlineData(0, "fatal")]
    [InlineData(3, "error")]
    [InlineData(4, "warn")]
    [InlineData(6, "info")]
    [InlineData(7, "debug")]
    public void Syslog_levels(int syslog, string level) => Assert.Equal(level, KafkaLogSource.LevelOf(syslog));

    private sealed record LogMessage(string Name, int Level, string Facility, string Message);

    private sealed class FakeHandle
    {
        public List<object> LogBuffer { get; } = [];
    }

    [Fact]
    public void Reads_confluent_style_objects_by_reflection()
    {
        var l = ReflectionKafkaGateway.FromObject(new LogMessage("rdkafka#producer-1", 4, "BROKER", "Broker down"))!;
        Assert.Equal(4, l.Level);
        Assert.Equal("Broker down", l.Message);
        Assert.Equal("BROKER", l.Facility);
        Assert.NotNull(ReflectionKafkaGateway.FromObject("%7|1.5|X|n| y"));
        Assert.NotNull(new FakeHandle().LogBuffer);
    }

    /// <summary>Shape of M2-K's KafkaLogBuffer / KafkaLogEntry.</summary>
    private sealed record BufferEntry(long Seq, DateTimeOffset Ts, string Level, string Facility, string Client, string Message);

    private sealed class SnapshotBuffer
    {
        public IReadOnlyList<BufferEntry> Snapshot(long afterSeq = 0) =>
            [new(1, DateTimeOffset.Parse("2026-10-18T13:00:00Z"), "warn", "REQTMOUT", "rdkafka#producer-1", "Timed out 1 in-flight request")];
    }

    [Fact]
    public void Reads_a_snapshot_log_buffer_by_reflection()
    {
        var items = ReflectionKafkaGateway.Items(new SnapshotBuffer())!.Cast<object>().Select(ReflectionKafkaGateway.FromObject).ToList();
        var l = Assert.Single(items)!;
        Assert.Equal(4, l.Level);
        Assert.Equal("rdkafka#producer-1", l.Name);
        Assert.Equal("REQTMOUT", l.Facility);
        Assert.Null(ReflectionKafkaGateway.Items("not a buffer"));
    }

    private sealed class FakeKafkaGateway(IReadOnlyList<KafkaLogLine>? lines) : IKafkaLogGateway
    {
        public Task<IReadOnlyList<KafkaLogLine>?> ReadAsync(LogTarget target, CancellationToken ct) => Task.FromResult(lines);
    }

    [Fact]
    public async Task Client_log_and_jobs_activity()
    {
        var t0 = DateTimeOffset.Parse("2026-10-18T13:00:00Z");
        var lines = new List<KafkaLogLine> { new(t0.AddSeconds(2), 3, "FAIL", "c-1", "refused"), new(t0, 6, "INIT", "c-1", "started") };
        await using var jobs = new JobManager(NullEventPublisher.Instance);
        var gate = new TaskCompletionSource();
        var jobId = jobs.Start("kafka.fetch", "c1", null, async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return null; });
        var src = new KafkaLogSource(new FakeKafkaGateway(lines), jobs, () => null);
        var page = await src.QueryAsync(Target("kafka"), LogFilter.Validate(new LogQuery("client")), default);
        Assert.Equal(["started", "refused"], page.Entries.Select(e => e.Message));
        Assert.Equal("error", page.Entries[1].Level);
        var rows = await src.SnapshotAsync(Target("kafka"), default);
        var job = Assert.Single(rows);
        Assert.Equal("job:" + jobId, job.Id);
        Assert.Equal("kafka.fetch", job.Command);
        var kill = await src.KillAsync(Target("kafka"), new LogKillRequest(job.Id, "op"), default);
        Assert.True(kill.Killed);
        await jobs.WaitAsync(jobId);
        Assert.Empty(await src.SnapshotAsync(Target("kafka"), default));
        gate.TrySetResult();
    }

    private sealed class GroupsGateway : IKafkaLogGateway
    {
        public int Calls;
        public bool Fail;
        public Task<IReadOnlyList<KafkaLogLine>?> ReadAsync(LogTarget target, CancellationToken ct) => Task.FromResult<IReadOnlyList<KafkaLogLine>?>([]);

        public Task<IReadOnlyList<KafkaGroupActivity>?> GroupsAsync(LogTarget target, CancellationToken ct)
        {
            Calls++;
            if (Fail) throw EngineException.SourceUnavailable("brokers down");
            return Task.FromResult<IReadOnlyList<KafkaGroupActivity>?>(
            [
                new("billing", "Empty", null, 0, ["orders", "payments"], 12), new("shipping", "Stable", "range", 2, ["orders"], null),
            ]);
        }
    }

    [Fact]
    public async Task Consumer_groups_are_listed_in_activity_cached_and_failure_tolerant()
    {
        await using var jobs = new JobManager(NullEventPublisher.Instance);
        var gw = new GroupsGateway();
        var src = new KafkaLogSource(gw, jobs, () => null);
        var rows = await src.SnapshotAsync(Target("kafka"), default);
        Assert.Equal(["group:billing", "group:shipping"], rows.Select(r => r.Id));
        var billing = rows[0];
        Assert.Equal(("client", "Empty", "consumer group", false), (billing.Kind, billing.State, billing.Command, billing.CanKill));
        Assert.Equal("0 members · orders, payments · lag 12", billing.Text);
        Assert.Equal("2 members · orders", rows[1].Text);
        Assert.Equal("12", billing.Fields!["lag"]);
        // Polled every 2 s by activity.poll: the groups are fetched at most once per GroupsTtl.
        await src.SnapshotAsync(Target("kafka"), default);
        Assert.Equal(1, gw.Calls);
        // The default gateway method (no groups) and a failing gateway keep activity working.
        Assert.Empty(await new KafkaLogSource(new FakeKafkaGateway([]), jobs, () => null).SnapshotAsync(Target("kafka"), default));
        var failing = new KafkaLogSource(new GroupsGateway { Fail = true }, jobs, () => null);
        Assert.Empty(await failing.SnapshotAsync(Target("kafka"), default));
        await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("kafka"), new LogKillRequest("group:billing", "client"), default));
    }

    [Fact]
    public async Task Without_a_log_buffer_the_client_log_is_unavailable()
    {
        await using var jobs = new JobManager(NullEventPublisher.Instance);
        var src = new KafkaLogSource(new FakeKafkaGateway(null), jobs, () => null);
        var list = await src.ListAsync(Target("kafka"), default);
        Assert.False(list[0].Available);
        Assert.Contains("LogBuffer", list[0].Reason);
        Assert.True(list[1].Available);
        await Assert.ThrowsAsync<EngineException>(() => src.KillAsync(Target("kafka"), new LogKillRequest("x", "op"), default));
    }
}
