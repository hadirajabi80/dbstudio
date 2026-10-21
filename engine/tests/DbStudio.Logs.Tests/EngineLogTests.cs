using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Tests;

public sealed class EngineLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-logs-tests", Guid.NewGuid().ToString("N"));

    public EngineLogTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private static string Line(DateTime t, string lvl, string ctx, string msg) =>
        $"{t:yyyy-MM-dd HH:mm:ss.fff} +02:00 [{lvl}] {ctx}: {msg}\n";

    private string Write(string name, string text)
    {
        var p = Path.Combine(_dir, name);
        File.AppendAllText(p, text, new UTF8Encoding(false));
        return p;
    }

    private static readonly DateTime T0 = new(2026, 10, 18, 13, 0, 0);

    [Fact]
    public void Parses_serilog_lines_with_exceptions()
    {
        var text = Line(T0, "INF", "DbStudio.Core.Services.SessionManager", "Session s_1 opened on c1 (sqlite)")
            + Line(T0.AddSeconds(1), "ERR", "DbStudio.Host.Infrastructure.ErrorHandlingMiddleware", "POST /api/v1/x failed")
            + "System.InvalidOperationException: boom\n   at X.Y()\n"
            + Line(T0.AddSeconds(2), "WRN", "", "no context") + "2026-10-18 13:00:03.000 +02:00 [FTL] : last words\n";
        var entries = EngineLogSource.ParseBlock(Encoding.UTF8.GetBytes(text), 0, 7);
        Assert.Equal(4, entries.Count);
        Assert.Equal("SessionManager", entries[0].Source);
        Assert.Equal("2026-10-18T11:00:00.000Z", entries[0].Ts);
        Assert.Equal("error", entries[1].Level);
        Assert.Equal("System.InvalidOperationException: boom\n   at X.Y()", entries[1].Detail);
        Assert.Equal("engine", entries[2].Source);
        Assert.Equal("fatal", entries[3].Level);
        Assert.Equal(7 * EngineLogSource.FileFactor, entries[0].Seq);
        Assert.Equal(7 * EngineLogSource.FileFactor + Encoding.UTF8.GetByteCount(Line(T0, "INF", "DbStudio.Core.Services.SessionManager", "Session s_1 opened on c1 (sqlite)")), entries[1].Seq);
    }

    [Theory]
    [InlineData("engine-20261018.log", true)]
    [InlineData("engine-20261018_001.log", true)]
    [InlineData("engine-x.log", false)]
    [InlineData("other.log", false)]
    public void File_keys(string name, bool valid)
    {
        Assert.Equal(valid, EngineLogSource.KeyOf(name) is not null);
        if (valid && name.Contains('_')) Assert.Equal(EngineLogSource.KeyOf("engine-20261018.log") + 1, EngineLogSource.KeyOf(name));
    }

    [Fact]
    public async Task Queries_newest_first_and_pages_older_across_files()
    {
        var sb = new StringBuilder();
        for (var i = 0; i < 300; i++) sb.Append(Line(T0.AddSeconds(i), i % 10 == 0 ? "ERR" : "INF", "Ctx", $"day1 line {i} {new string('x', i % 50)}"));
        Write("engine-20261017.log", sb.ToString());
        sb.Clear();
        for (var i = 0; i < 300; i++) sb.Append(Line(T0.AddDays(1).AddSeconds(i), "INF", "Ctx", $"day2 line {i}"));
        Write("engine-20261018.log", sb.ToString());
        var src = new EngineLogSource(_dir) { ChunkBytes = 1024 };

        var page = await src.QueryAsync(new LogQuery("engine", Limit: 100), default);
        Assert.Equal(100, page.Entries.Count);
        Assert.True(page.HasMore);
        Assert.Equal("day2 line 299", page.Entries[^1].Message);
        Assert.Equal("day2 line 200", page.Entries[0].Message);

        var all = new List<LogEntry>(page.Entries);
        var before = page.Entries[0].Seq;
        while (true)
        {
            var older = await src.QueryAsync(new LogQuery("engine", Limit: 250, Before: before), default);
            all.InsertRange(0, older.Entries);
            if (!older.HasMore) break;
            before = older.Entries[0].Seq;
        }
        Assert.Equal(600, all.Count);
        Assert.Equal(600, all.Select(e => e.Seq).Distinct().Count());
        Assert.True(all.Zip(all.Skip(1)).All(p => p.First.Seq < p.Second.Seq));

        var errors = await src.QueryAsync(LogFilter.Validate(new LogQuery("engine", Levels: ["error"], Q: "LINE 29")), default);
        Assert.Equal(["day1 line 290 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], errors.Entries.Select(e => e.Message));
    }

    [Fact]
    public async Task Tail_cursor_reads_forward_across_the_daily_roll_and_skips_partial_lines()
    {
        Write("engine-20261017.log", Line(T0, "INF", "A", "one") + Line(T0.AddSeconds(1), "INF", "A", "two"));
        var src = new EngineLogSource(_dir);
        var cursor = src.NewestSeq();
        Assert.Equal("two", (await src.QueryAsync(new LogQuery("engine", Limit: 1), default)).Entries[0].Message);

        Write("engine-20261017.log", Line(T0.AddSeconds(2), "WRN", "A", "three"));
        Write("engine-20261018.log", Line(T0.AddDays(1), "INF", "B", "four") + "2026-10-19 13:00:01.000 +02:00 [INF] B: partial");
        var tail = await src.QueryAsync(new LogQuery("engine", After: cursor), default);
        Assert.Equal(["three", "four"], tail.Entries.Select(e => e.Message));

        Write("engine-20261018.log", " line\n");
        var next = await src.QueryAsync(new LogQuery("engine", After: tail.Entries[^1].Seq), default);
        Assert.Equal(["partial line"], next.Entries.Select(e => e.Message));
    }

    [Fact]
    public async Task Newest_seq_of_an_empty_file_lets_the_first_line_through()
    {
        Write("engine-20261018.log", "");
        var src = new EngineLogSource(_dir);
        var cursor = src.NewestSeq();
        Write("engine-20261018.log", Line(T0, "INF", "A", "first"));
        Assert.Equal("first", (await src.QueryAsync(new LogQuery("engine", After: cursor), default)).Entries.Single().Message);
        Assert.Equal(0, new EngineLogSource(Path.Combine(_dir, "missing")).NewestSeq());
    }

    [Fact]
    public async Task Reads_while_serilog_keeps_the_file_open()
    {
        var path = Path.Combine(_dir, "engine-20261018.log");
        await using var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        var bytes = Encoding.UTF8.GetBytes(Line(T0, "INF", "A", "locked"));
        writer.Write(bytes);
        writer.Flush();
        var page = await new EngineLogSource(_dir).QueryAsync(new LogQuery("engine"), default);
        Assert.Equal("locked", page.Entries.Single().Message);
    }
}

public sealed class LogFilterAndExportTests
{
    private static LogEntry E(long seq, string level, string msg, string? ts = "2026-10-18T13:00:00.000Z", string? detail = null) =>
        new(ts, level, "src", msg, seq, detail, new Dictionary<string, string> { ["k"] = "field value" });

    [Fact]
    public void Validates_queries()
    {
        Assert.Equal(LogFilter.DefaultLimit, LogFilter.Validate(new LogQuery("x")).Limit);
        Assert.Equal(["warn", "error"], LogFilter.Validate(new LogQuery("x", Levels: ["WARN", "error", "warn"])).Levels);
        Assert.Null(LogFilter.Validate(new LogQuery("x", Q: "  ")).Q);
        void Bad(LogQuery q, string field) =>
            Assert.Equal(field, JsonSerializer.SerializeToElement(Assert.Throws<EngineException>(() => LogFilter.Validate(q)).Detail).GetProperty("field").GetString());
        Bad(new LogQuery(null), "sourceId");
        Bad(new LogQuery("x", Limit: 5001), "limit");
        Bad(new LogQuery("x", Levels: ["loud"]), "levels");
        Bad(new LogQuery("x", From: DateTimeOffset.UtcNow, To: DateTimeOffset.UtcNow.AddDays(-1)), "from");
        Bad(new LogQuery("x", Q: new string('q', 1001)), "q");
        Bad(new LogQuery("x", Archive: -1), "archive");
        Assert.Throws<EngineException>(() => LogFilter.Validate(null));
    }

    [Fact]
    public void Level_filter_groups_fatal_with_error_and_keeps_unknown()
    {
        Assert.True(LogLevels.Matches("fatal", ["error"]));
        Assert.True(LogLevels.Matches("unknown", ["warn"]));
        Assert.False(LogLevels.Matches("info", ["warn"]));
        Assert.True(LogLevels.Matches("debug", []));
        Assert.Equal("warn", LogLevels.Normalize("WARNING"));
        Assert.Equal("fatal", LogLevels.Normalize("PANIC"));
    }

    [Fact]
    public void Pages_newest_limit_ascending_with_cursors()
    {
        var entries = Enumerable.Range(1, 10).Select(i => E(i, i % 2 == 0 ? "info" : "error", $"m{i}")).Reverse().ToList();
        var page = LogFilter.Page(entries, new LogQuery("x", Limit: 3));
        Assert.Equal([8L, 9L, 10L], page.Entries.Select(e => e.Seq));
        Assert.True(page.HasMore);
        var older = LogFilter.Page(entries, new LogQuery("x", Limit: 3, Before: 8));
        Assert.Equal([5L, 6L, 7L], older.Entries.Select(e => e.Seq));
        var tail = LogFilter.Page(entries, new LogQuery("x", Limit: 2, After: 4));
        Assert.Equal([5L, 6L], tail.Entries.Select(e => e.Seq)); // oldest after the cursor first: nothing is skipped
        Assert.True(tail.HasMore);
        Assert.Equal(5, LogFilter.Page(entries, new LogQuery("x", Levels: ["error"])).Entries.Count);
        Assert.Single(LogFilter.Page(entries, new LogQuery("x", Q: "M10")).Entries);
        Assert.Equal(10, LogFilter.Page(entries, new LogQuery("x", Q: "FIELD VALUE")).Entries.Count);
        Assert.Empty(LogFilter.Page(entries, new LogQuery("x", From: DateTimeOffset.Parse("2026-10-18T14:00:00Z"))).Entries);
        Assert.Single(LogFilter.Page([E(1, "info", "no time", ts: null)], new LogQuery("x", From: DateTimeOffset.Parse("2026-10-18T14:00:00Z"))).Entries);
    }

    [Fact]
    public void Time_seq_is_strictly_increasing()
    {
        var s = new TimeSeq();
        var t = DateTimeOffset.Parse("2026-10-18T13:00:00Z");
        var a = s.Next(t);
        var b = s.Next(t);
        var c = s.Next(t.AddMilliseconds(-5)); // out of order lines keep their order
        var d = s.Next(t.AddMilliseconds(1));
        Assert.True(a < b && b < c && c < d);
        Assert.Equal(t, TimeSeq.ToTime(a));
        Assert.True(d < (1L << 53));
    }

    [Fact]
    public async Task Exports_txt_csv_json()
    {
        var entries = new List<LogEntry> { E(1, "error", "=cmd|' /C calc'!A0", detail: "line1\nline2"), E(2, "info", "plain, \"quoted\"") };
        async Task<string> Run(string f)
        {
            var ms = new MemoryStream();
            await LogExporter.WriteAsync(ms, f, entries, default);
            return Encoding.UTF8.GetString(ms.ToArray()).TrimStart('﻿');
        }
        var txt = await Run("txt");
        Assert.StartsWith("2026-10-18T13:00:00.000Z ERROR [src] =cmd", txt);
        Assert.Contains("\n    line1\n    line2\n    k=field value\n", txt);
        var csv = await Run("csv");
        Assert.StartsWith("ts,level,source,message,detail,fields\r\n", csv);
        Assert.Contains(",'=cmd|' /C calc'!A0,\"line1\nline2\",k=field value\r\n", csv); // formula guard
        Assert.Contains(",\"plain, \"\"quoted\"\"\",", csv);
        var json = JsonDocument.Parse(await Run("json")).RootElement;
        Assert.Equal(2, json.GetArrayLength());
        Assert.Equal("error", json[0].GetProperty("level").GetString());
        Assert.False(json[1].TryGetProperty("detail", out _));
        Assert.Equal("csv", LogExporter.Validate(" CSV "));
        Assert.Throws<EngineException>(() => LogExporter.Validate("xlsx"));
        Assert.Equal("logs-profiler-shop-20261018-130000.json", LogExporter.FileName("profiler:shop", "json", new DateTimeOffset(2026, 10, 18, 13, 0, 0, TimeSpan.Zero)));
    }

    [Fact]
    public void Wire_shapes_are_camel_case_and_omit_nulls()
    {
        var info = JsonSerializer.SerializeToElement(new LogSourceInfo("errorlog", "Error log", "log", true, true, ["info"], false, Needs: "GRANT X;")
            { Archives = [new LogArchiveInfo(0, null, 10)] }, CoreJson.Options);
        Assert.Equal("GRANT X;", info.GetProperty("needs").GetString());
        Assert.False(info.TryGetProperty("reason", out _));
        Assert.Equal(10, info.GetProperty("archives")[0].GetProperty("sizeBytes").GetInt64());
        var row = JsonSerializer.SerializeToElement(new ActivityRow { Id = "1", Kind = "session", State = "running", CanKill = true }, CoreJson.Options);
        Assert.Equal(["id", "kind", "state", "canKill"], row.EnumerateObject().Select(p => p.Name));
        var q = JsonSerializer.Deserialize<LogQuery>("""{"sourceId":"x","from":"2026-10-18T13:00:00.000Z","levels":["warn"],"limit":10,"before":5}""", CoreJson.Options)!;
        Assert.Equal(5, q.Before);
        Assert.Equal(DateTimeOffset.Parse("2026-10-18T13:00:00Z"), q.From);
    }
}
