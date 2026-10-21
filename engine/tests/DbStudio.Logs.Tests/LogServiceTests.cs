using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Sqlite;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Logs.Tests;

/// <summary>
/// The logs package wired like the Host does (module discovery, ConnectionStore, real SQLite provider, StreamManager,
/// JobManager) over a temporary data directory, plus an in-memory HTTP server for the endpoints.
/// </summary>
internal sealed class LogsHarness : IAsyncDisposable
{
    public readonly string DataDir = Path.Combine(Path.GetTempPath(), "dbstudio-logs-tests", Guid.NewGuid().ToString("N"));
    public readonly Recorder Events = new();
    public readonly WebApplication App;
    public readonly HttpClient Http;
    public readonly FakeSqlRunner Sql = new();
    public ConnectionProfile Sqlite = null!, SqlServer = null!, ReadOnlySqlServer = null!;

    public IServiceProvider Services => App.Services;
    public LogService Logs => Services.GetRequiredService<LogService>();
    public StreamManager Streams => Services.GetRequiredService<StreamManager>();
    public string LogsDir => Path.Combine(DataDir, "logs");

    public LogsHarness(bool fakeSql = true)
    {
        Directory.CreateDirectory(Path.Combine(DataDir, "logs"));
        File.WriteAllBytes(Path.Combine(DataDir, "shop.db"), []);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Testing" });
        builder.WebHost.UseTestServer();
        var s = builder.Services;
        s.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
        var paths = new AppPaths(DataDir);
        s.AddSingleton(paths);
        s.AddSingleton<ISecretStore>(new MemorySecrets());
        s.AddSingleton<IDbProvider, SqliteProvider>();
        s.AddSingleton<IDbProvider, DbStudio.Providers.SqlServer.SqlServerProvider>();
        s.AddSingleton<ProviderRegistry>();
        s.AddSingleton<SourceRegistry>();
        s.AddSingleton(sp => new ConnectionStore(paths, sp.GetRequiredService<ISecretStore>(), sp.GetRequiredService<SourceRegistry>()));
        s.AddSingleton<SettingsService>();
        s.AddSingleton<IEventPublisher>(Events);
        s.AddSingleton(sp => new SourceClientManager(sp.GetRequiredService<SourceRegistry>(), sp.GetRequiredService<ConnectionStore>(), Events));
        s.AddSingleton(sp => new StreamManager(Events, kind => sp.GetKeyedService<IStreamFactory>(kind), sp.GetRequiredService<ConnectionStore>(),
            clients: sp.GetRequiredService<SourceClientManager>(), options: new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(30) }));
        s.AddSingleton(sp => new JobManager(Events));
        if (fakeSql) s.AddSingleton<ISqlRunnerFactory>(Sql);
        foreach (var m in EngineModules.Discover(typeof(LogsModule).Assembly)) m.ConfigureServices(s);
        App = builder.Build();
        App.Use(async (ctx, next) =>
        {
            try { await next(); }
            catch (EngineException ex)
            {
                ctx.Response.StatusCode = ex.Status;
                await ctx.Response.WriteAsJsonAsync(new { error = new { code = ex.Code, message = ex.Message, detail = ex.Detail } }, CoreJson.Options);
            }
        });
        var api = App.MapGroup("/api/v1");
        foreach (var m in EngineModules.Discover(typeof(LogsModule).Assembly)) m.MapEndpoints(api);
        App.StartAsync().GetAwaiter().GetResult();
        Http = App.GetTestClient();

        var store = Services.GetRequiredService<ConnectionStore>();
        Sqlite = store.Create(new ConnectionProfile { Name = "Shop", ProviderId = "sqlite", Props = new() { ["path"] = Path.Combine(DataDir, "shop.db") } }, null);
    }

    /// <summary>A SQL Server profile (never connected: the tests fake its SQL runner).</summary>
    public ConnectionProfile AddProfile(string providerId, bool readOnly = false) =>
        Services.GetRequiredService<ConnectionStore>().Create(new ConnectionProfile
        {
            Name = $"{providerId} test", ProviderId = providerId, ReadOnly = readOnly,
            Props = new() { ["server"] = "localhost", ["auth"] = "sql", ["user"] = "app" },
        }, null);

    public async ValueTask DisposeAsync()
    {
        await Streams.DisposeAsync();
        await App.DisposeAsync();
        try { Directory.Delete(DataDir, true); } catch (IOException) { }
    }
}

public sealed class LogServiceTests : IAsyncLifetime
{
    private LogsHarness _h = null!;

    public Task InitializeAsync()
    {
        _h = new LogsHarness();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync() => await _h.DisposeAsync();

    private void EngineLines(params string[] messages)
    {
        var sb = new StringBuilder();
        foreach (var m in messages) sb.Append($"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} +00:00 [INF] DbStudio.Test: {m}\n");
        File.AppendAllText(Path.Combine(_h.LogsDir, $"engine-{DateTime.Now:yyyyMMdd}.log"), sb.ToString());
    }

    [Fact]
    public async Task Sqlite_lists_no_sources_and_the_engine_cid_lists_the_engine_log()
    {
        Assert.Empty(await _h.Logs.ListAsync(_h.Sqlite.Id, false, default));
        var engine = Assert.Single(await _h.Logs.ListAsync("engine", false, default));
        Assert.Equal("engine", engine.Id);
        await Assert.ThrowsAsync<EngineException>(() => _h.Logs.ListAsync("c_missing", false, default));
    }

    [Fact]
    public async Task Engine_source_is_accepted_under_any_connection()
    {
        EngineLines("hello from the engine");
        var page = await _h.Logs.QueryAsync(_h.Sqlite.Id, new LogQuery("engine"), default);
        Assert.Equal("hello from the engine", page.Entries.Single().Message);
        var ex = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.QueryAsync(_h.Sqlite.Id, new LogQuery("errorlog"), default));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
    }

    [Fact]
    public async Task Kill_is_refused_on_read_only_profiles_and_for_locks()
    {
        var ro = _h.AddProfile("sqlserver", readOnly: true);
        var ex = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.KillAsync(ro.Id, new LogKillRequest("57", "session"), default));
        Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
        Assert.Contains("Kill", ex.Message);
        var lockEx = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.KillAsync(ro.Id, new LogKillRequest("lock:1", "lock"), default));
        Assert.Equal(ErrorCodes.Validation, lockEx.Code);
        var sqlite = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.KillAsync(_h.Sqlite.Id, new LogKillRequest("1", "session"), default));
        Assert.Contains("Activity is not available", sqlite.Message);
        Assert.Empty(_h.Sql.Sql);
    }

    [Fact]
    public async Task Source_lists_are_cached_and_refreshable()
    {
        var p = _h.AddProfile("sqlserver");
        _h.Sql.On("SUSER_SNAME()", SqlRowSet.Of(["login_name", "engine_edition", "product_version", "is_sysadmin", "view_server_state", "has_agent"], ["app", 3, "16.0.1", 1, 1, 0]));
        await _h.Logs.ListAsync(p.Id, false, default);
        await _h.Logs.ListAsync(p.Id, false, default);
        Assert.Equal(1, _h.Sql.Sql.Count(s => s.Contains("SUSER_SNAME()", StringComparison.Ordinal)));
        await _h.Logs.ListAsync(p.Id, true, default);
        Assert.Equal(2, _h.Sql.Sql.Count(s => s.Contains("SUSER_SNAME()", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Provider_errors_map_to_provider_error()
    {
        var p = _h.AddProfile("sqlserver");
        _h.Sql.On("SUSER_SNAME()", SqlRowSet.Of(["login_name", "is_sysadmin", "view_server_state"], ["app", 1, 1])).OnFail("xp_readerrorlog", "22004", "denied")
            .OnFail("dm_xe_session_targets", "102", "Incorrect syntax near 'x'.");
        var denied = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.QueryAsync(p.Id, new LogQuery("errorlog"), default));
        Assert.Equal(ErrorCodes.Privilege, denied.Code);
        var broken = await Assert.ThrowsAsync<EngineException>(() => _h.Logs.QueryAsync(p.Id, new LogQuery("system_health"), default));
        Assert.Equal(ErrorCodes.ProviderError, broken.Code);
    }

    [Fact]
    public async Task Engine_log_tail_stream_pushes_new_lines_only()
    {
        EngineLines("before the tail");
        var info = await _h.Streams.OpenAsync("logs.tail", "engine", JsonSerializer.SerializeToElement(new { sourceId = "engine", q = "wanted" }), "ui1", default);
        await Task.Delay(300);
        EngineLines("wanted one", "skipped", "wanted two");
        await Wait.Until(() => _h.Events.Items(info.StreamId).Count >= 2);
        var items = _h.Events.Items(info.StreamId).Select(i => i.GetProperty("message").GetString()).ToList();
        Assert.Equal(["wanted one", "wanted two"], items);
        Assert.True(await _h.Streams.CloseAsync(info.StreamId));
    }

    [Fact]
    public async Task Tail_stream_params_are_validated()
    {
        async Task<EngineException> Bad(object p, string cid = "engine") =>
            await Assert.ThrowsAsync<EngineException>(() => _h.Streams.OpenAsync("logs.tail", cid, JsonSerializer.SerializeToElement(p), "ui1", default));
        Assert.Contains("sourceId", (await Bad(new { })).Message);
        Assert.Contains("level", (await Bad(new { sourceId = "engine", levels = new[] { "loud" } })).Message);
        Assert.Contains("maxMinutes", (await Bad(new { sourceId = "engine", maxMinutes = 500 })).Message);
        Assert.Contains("errorlog", (await Bad(new { sourceId = "errorlog" })).Message);
        var poll = await Assert.ThrowsAsync<EngineException>(() => _h.Streams.OpenAsync("activity.poll", _h.Sqlite.Id, JsonSerializer.SerializeToElement(new { intervalMs = 2000 }), "ui1", default));
        Assert.Contains("Activity is not available", poll.Message);
        var fast = await Assert.ThrowsAsync<EngineException>(() => _h.Streams.OpenAsync("activity.poll", _h.Sqlite.Id, JsonSerializer.SerializeToElement(new { intervalMs = 10 }), "ui1", default));
        Assert.Contains("intervalMs", fast.Message);
    }

    [Fact]
    public async Task Activity_poll_stream_sends_snapshots()
    {
        var p = _h.AddProfile("sqlserver");
        _h.Sql.On("SUSER_SNAME()", SqlRowSet.Of(["login_name", "is_sysadmin", "view_server_state"], ["app", 1, 1]))
            .On("dm_exec_sessions", SqlRowSet.Of(["session_id", "login_name", "status"], [57, "etl", "running"]), SqlRowSet.Of(["session_id", "resource_type", "request_mode", "request_status", "lock_count"]));
        var info = await _h.Streams.OpenAsync("activity.poll", p.Id, JsonSerializer.SerializeToElement(new { intervalMs = 500 }), "ui1", default);
        await Wait.Until(() => _h.Events.Items(info.StreamId).Count >= 2);
        var first = _h.Events.Items(info.StreamId)[0];
        Assert.Equal("57", first.GetProperty("sessions")[0].GetProperty("id").GetString());
        Assert.True(first.TryGetProperty("ts", out _));
        _h.Streams.Pause(info.StreamId);
        await Task.Delay(700);
        var count = _h.Events.Items(info.StreamId).Count;
        await Task.Delay(1200);
        Assert.Equal(count, _h.Events.Items(info.StreamId).Count); // paused: no polling
        await _h.Streams.CloseAsync(info.StreamId);
    }

    // ---- HTTP endpoints

    [Fact]
    public async Task Http_sources_query_and_validation()
    {
        EngineLines("over http");
        var sources = await _h.Http.GetFromJsonAsync<JsonElement>($"/api/v1/logs/{_h.Sqlite.Id}/sources");
        Assert.Equal(0, sources.GetArrayLength());
        var engine = await _h.Http.GetFromJsonAsync<JsonElement>("/api/v1/logs/engine/sources");
        Assert.Equal("engine", engine[0].GetProperty("id").GetString());
        var res = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/query", new { sourceId = "engine", limit = 10, levels = new[] { "info" } });
        res.EnsureSuccessStatusCode();
        var page = await res.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("over http", page.GetProperty("entries")[0].GetProperty("message").GetString());
        Assert.False(page.GetProperty("hasMore").GetBoolean());
        var bad = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/query", new { sourceId = "engine", limit = 9999 });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("limit", (await bad.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("detail").GetProperty("field").GetString());
        var missing = await _h.Http.GetAsync("/api/v1/logs/c_nope/sources");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }

    [Fact]
    public async Task Http_kill_activity_and_export()
    {
        var ro = _h.AddProfile("sqlserver", readOnly: true);
        var kill = await _h.Http.PostAsJsonAsync($"/api/v1/logs/{ro.Id}/kill", new { id = "57", kind = "session" });
        Assert.Equal(HttpStatusCode.Forbidden, kill.StatusCode);
        Assert.Equal("READ_ONLY", (await kill.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString());
        var noId = await _h.Http.PostAsJsonAsync($"/api/v1/logs/{ro.Id}/kill", new { kind = "session" });
        Assert.Equal(HttpStatusCode.BadRequest, noId.StatusCode);

        _h.Sql.On("SUSER_SNAME()", SqlRowSet.Of(["login_name", "is_sysadmin", "view_server_state"], ["app", 1, 1]))
            .On("dm_exec_sessions", SqlRowSet.Of(["session_id", "status"], [61, "suspended"]));
        var snap = await _h.Http.GetFromJsonAsync<JsonElement>($"/api/v1/logs/{ro.Id}/activity");
        Assert.Equal("61", snap.GetProperty("sessions")[0].GetProperty("id").GetString());

        EngineLines("export me, please", "and me");
        var file = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/export", new { sourceId = "engine", format = "csv", path = (string?)null });
        file.EnsureSuccessStatusCode();
        Assert.Equal("text/csv", file.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("logs-engine-", file.Content.Headers.ContentDisposition!.FileName!.Trim('"'));
        var csv = await file.Content.ReadAsStringAsync();
        Assert.Contains("\"export me, please\"", csv);

        var target = Path.Combine(_h.DataDir, "out.json");
        var job = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/export", new { sourceId = "engine", format = "json", path = target });
        Assert.Equal(HttpStatusCode.Accepted, job.StatusCode);
        var jobId = (await job.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("jobId").GetString()!;
        await _h.Services.GetRequiredService<JobManager>().WaitAsync(jobId);
        Assert.Equal(2, JsonDocument.Parse(File.ReadAllText(target)).RootElement.GetArrayLength());
        var done = _h.Events.Events.OfType<JobDoneEvent>().Single(e => e.JobId == jobId);
        Assert.Equal(2, done.Result!.Value.GetProperty("entries").GetInt32());

        var badFormat = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/export", new { sourceId = "engine", format = "xlsx" });
        Assert.Equal(HttpStatusCode.BadRequest, badFormat.StatusCode);
        var relative = await _h.Http.PostAsJsonAsync("/api/v1/logs/engine/export", new { sourceId = "engine", format = "txt", path = "out.txt" });
        Assert.Equal(HttpStatusCode.BadRequest, relative.StatusCode);
    }
}

/// <summary>The session-backed SQL runner over a real SQLite connection (the relational plumbing of every SQL source).</summary>
public sealed class SessionRunnerIntegrationTests
{
    [Fact]
    public async Task Runs_sql_on_a_real_sqlite_session_and_reports_errors()
    {
        await using var h = new LogsHarness(fakeSql: false);
        var runners = h.Services.GetRequiredService<ISqlRunnerFactory>();
        Assert.IsType<SessionSqlRunnerFactory>(runners);
        var runner = await runners.GetAsync(new LogTarget(h.Sqlite.Id, h.Sqlite), default);
        var sets = await runner.QueryAsync("SELECT 42 AS answer, 'x' AS name, X'0102' AS bin", default);
        Assert.Equal(42L, SqlCells.Long(sets[0].Value(sets[0].Rows[0], "answer")));
        Assert.Equal([1, 2], (byte[])sets[0].Rows[0][2]!);
        var ex = await Assert.ThrowsAsync<SqlQueryException>(() => runner.QueryAsync("SELECT * FROM no_such_table", default));
        Assert.Contains("no_such_table", ex.Message);
        var again = await runner.QueryAsync("SELECT 1 AS one", default); // the session survives a provider error
        Assert.Single(again[0].Rows);
        await ((IAsyncDisposable)runners).DisposeAsync();
    }

    [Fact]
    public void Cells_and_literals()
    {
        Assert.Equal(DateTimeOffset.Parse("2026-10-18T13:00:00+02:00"), SqlCells.Time("2026-10-18T13:00:00", TimeSpan.FromHours(2)));
        Assert.Equal(DateTimeOffset.Parse("2026-10-18T13:00:00Z"), SqlCells.Time("2026-10-18 13:00:00 UTC", TimeSpan.FromHours(2)));
        Assert.Equal(TimeSpan.FromHours(-5), SqlCells.Time("2026-10-18T13:00:00-05:00", TimeSpan.Zero)!.Value.Offset);
        Assert.True(SqlCells.Bool("t"));
        Assert.Equal(12L, SqlCells.Long("12.0"));
        Assert.Equal("N'a''b'", SqlText.NString("a'b"));
        Assert.Equal("E'a\\\\b''c'", SqlText.PgString("a\\b'c"));
        Assert.Equal("%[[]x[%][_]%", SqlText.TSqlLikeContains("[x%_"));
        Assert.Equal("%a\\%b\\_c\\\\%", SqlText.LikeContains("a%b_c\\"));
    }
}
