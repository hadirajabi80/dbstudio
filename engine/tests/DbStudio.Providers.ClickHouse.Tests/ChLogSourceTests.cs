using DbStudio.Core.Models;
using DbStudio.Logs;
using DbStudio.Logs.Providers.ClickHouse;
using DbStudio.Logs.Sql;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.ClickHouse.Tests;

public sealed class ChLogSourceTests
{
    [Fact]
    public void Sql_IsDeterministic_AndEscapesLiterals()
    {
        var from = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
        var to = new DateTime(2026, 10, 2, 12, 30, 0, DateTimeKind.Utc);
        var sql = ChLogSql.QueryLog(from, to, "it's", 101);
        Assert.Contains("event_time_microseconds >= toDateTime64('2026-10-01 00:00:00.000000', 6, 'UTC')", sql);
        Assert.Contains("positionCaseInsensitiveUTF8(query, 'it\\'s') > 0", sql);
        Assert.Contains("LIMIT 101", sql);
        Assert.Equal("KILL QUERY WHERE query_id = 'a\\'b' SYNC", ChLogSql.KillQuery("a'b"));
        Assert.Equal("KILL MUTATION WHERE database = 'shop' AND table = 't' AND mutation_id = 'mutation_3.txt' SYNC",
            ChLogSql.KillMutation("shop", "t", "mutation_3.txt"));
    }

    [Fact]
    public void Sources_FollowTheSystemTablesThatExist()
    {
        var f = new ChLogSource.Facts("shop", "24.8", new HashSet<string> { "query_log", "errors", "processes" });
        var s = ChLogSource.Sources(f);
        Assert.True(s.Single(x => x.Id == "query_log").Available);
        Assert.False(s.Single(x => x.Id == "text_log").Available);
        Assert.False(s.Single(x => x.Id == "part_log").Available);
        Assert.Contains(s, x => x.Id == "activity" && x.Kind == "activity");
    }

    [Fact]
    public void QueryLog_Parses_LevelsAndFields()
    {
        var rows = SqlRowSet.Of(
            ["ts", "type", "query_id", "user", "db", "query_duration_ms", "read_rows", "read_bytes", "result_rows", "written_rows", "memory_usage", "exception_code", "exception", "query", "kind"],
            ["2026-10-02 10:00:02.000000", "ExceptionWhileProcessing", "q2", "shop", "shop", "5", "0", "0", "0", "0", "0", "60", "Unknown table", "SELECT * FROM x", "Select"],
            ["2026-10-02 10:00:01.000000", "QueryFinish", "q1", "shop", "shop", "1500", "10", "80", "1", "0", "4096", "0", "", "SELECT 1", "Select"]);
        var entries = ChLogSource.ParseQueryLog(rows);
        Assert.Equal(2, entries.Count);
        Assert.Equal("q1", entries[0].Fields!["queryId"]); // ascending
        Assert.Equal(LogLevels.Warn, entries[0].Level);
        Assert.Equal(LogLevels.Error, entries[1].Level);
        Assert.True(entries[1].Seq > entries[0].Seq);
        Assert.Equal("2026-10-02T10:00:01.000Z", entries[0].Ts);
    }

    [Fact]
    public void Activity_ProcessesMutationsAndMerges()
    {
        var p = SqlRowSet.Of(["query_id", "user", "host", "client_name", "db", "elapsed", "read_rows", "read_bytes", "memory_usage", "query", "kind", "is_cancelled"],
            ["q9", "shop", "::1", "Rowlit", "shop", 2.5, 100L, 800L, 1024L, "SELECT sleep(3)", "Select", 0]);
        var m = SqlRowSet.Of(["database", "table", "mutation_id", "command", "created", "parts_to_do", "is_done", "latest_fail_reason"],
            ["shop", "orders", "mutation_4.txt", "UPDATE status = 'paid' WHERE id = 1", "2026-10-02 10:00:00", 2L, 0, ""]);
        var g = SqlRowSet.Of(["database", "table", "elapsed", "progress", "num_parts", "result_part_name", "total_size_bytes_compressed", "rows_read", "rows_written", "memory_usage", "is_mutation", "merge_type"],
            ["shop", "orders", 1.0, 0.5, 3L, "202601_1_3_1", 1000L, 10L, 5L, 2048L, 0, "Regular"]);
        var rows = ChLogSource.ParseActivity(p, m, g);
        Assert.Equal(3, rows.Count);
        Assert.Equal(2500, rows[0].DurationMs);
        Assert.True(rows[0].CanKill);
        Assert.Equal("mutation:shop.orders:mutation_4.txt", rows[1].Id);
        Assert.False(rows[2].CanKill);
        Assert.Matches(ChLogSql.MutationId(), rows[1].Id);
    }

    [Fact]
    public void Module_RegistersTheProviderAndKeyedServices()
    {
        var services = new ServiceCollection();
        new ClickHouseModule().ConfigureServices(services);
        services.AddSingleton<ISqlRunnerFactory>(new NoRunners());
        using var sp = services.BuildServiceProvider();
        Assert.Contains(sp.GetServices<DbStudio.Core.Providers.IDbProvider>(), p => p.Id == "clickhouse" && p.Dialect == Dialect.ClickHouse);
        Assert.NotNull(sp.GetKeyedService<DbStudio.Core.Designer.IDdlScripter>("clickhouse"));
        Assert.NotNull(sp.GetKeyedService<DbStudio.Core.Designer.IDesignerDatabase>("clickhouse"));
        Assert.NotNull(sp.GetKeyedService<DbStudio.Core.Plans.IPlanReader>("clickhouse"));
        Assert.NotNull(sp.GetKeyedService<DbStudio.Core.Params.IParamBinder>("clickhouse"));
        Assert.NotNull(sp.GetKeyedService<ILogSource>("clickhouse"));
        Assert.NotNull(sp.GetKeyedService<IActivitySource>("clickhouse"));
    }

    private sealed class NoRunners : ISqlRunnerFactory
    {
        public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => throw new NotSupportedException();
    }
}
