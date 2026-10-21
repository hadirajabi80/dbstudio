using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs.Providers.PostgreSql;
using DbStudio.Logs.Providers.Redis;
using DbStudio.Logs.Providers.SqlServer;
using DbStudio.Logs.Sql;
using DbStudio.Providers.PostgreSql;
using DbStudio.Providers.SqlServer;
using DotNet.Testcontainers.Builders;
using Testcontainers.MsSql;
using Testcontainers.PostgreSql;

namespace DbStudio.Logs.Tests;

/// <summary>
/// Testcontainers smoke of the server-side sources (skipped with DBSTUDIO_IT=0 or without Docker): SQL Server error log,
/// system_health and activity; PostgreSQL server log with the logging collector on (skipped while the PG-A provider is a
/// stub); Redis slowlog / CLIENT LIST over the raw RESP gateway. Oracle and MongoDB smoke runs belong to the Docker QA
/// round (docs/qa/logs-walkthrough.md) because the Oracle image is large and the Mongo source needs the M2-M client.
/// </summary>
public sealed class ContainerSmokeTests
{
    private static void SkipUnlessDocker()
    {
        Skip.If(Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0", "Integration tests disabled (DBSTUDIO_IT=0).");
    }

    /// <summary>Runner over one provider + profile without a ConnectionStore.</summary>
    private sealed class DirectRunnerFactory(IDbProvider provider, ConnectionProfile profile, string password) : ISqlRunnerFactory, ISqlRunner
    {
        private IDbSession? _session;

        public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => Task.FromResult<ISqlRunner>(this);

        public async Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
        {
            _session ??= await provider.OpenSessionAsync(profile, password, new SessionOptions("lg_it", null, TransactionMode.Auto, false), ct);
            var sink = new Sink();
            await _session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "statement"), sink, ct);
            if (sink.Err is { } e) throw new SqlQueryException(e);
            return sink.Sets.Select(s => new SqlRowSet(s.Cols, s.Rows)).ToList();
        }

        private sealed class Sink : IExecutionSink
        {
            public readonly List<(string[] Cols, List<object?[]> Rows)> Sets = [];
            public ErrorInfo? Err;
            public ValueTask BatchStarted(int b) => default;
            public ValueTask ResultSetStarted(int id, int b, ColumnInfo[] c) { Sets.Add((c.Select(x => x.Name).ToArray(), [])); return default; }
            public ValueTask Rows(int id, IReadOnlyList<object?[]> rows) { Sets[^1].Rows.AddRange(rows.Select(r => r.Select(v => v is TruncatedValue t ? t.Full : v is BinaryValue b ? b.Full : v).ToArray())); return default; }
            public ValueTask ResultSetEnded(int id, long n, bool t, long ms) => default;
            public ValueTask RowsAffected(int b, long n, string? k) => default;
            public ValueTask Message(int b, MessageSeverity s, string t, int? l, int? c, MessageSource src) => default;
            public ValueTask Error(int b, ErrorInfo e) { Err ??= e; return default; }
            public ValueTask BatchEnded(int b, long ms, BatchStatus s) => default;
        }
    }

    [SkippableFact]
    public async Task Sql_server_error_log_health_and_activity()
    {
        SkipUnlessDocker();
        MsSqlContainer container;
        try
        {
            container = new MsSqlBuilder("mcr.microsoft.com/mssql/server:2022-latest").WithPassword("DbStudio_It_2026!").Build();
            await container.StartAsync();
        }
        catch (Exception ex)
        {
            throw new SkipException($"Docker/SQL Server unavailable: {ex.Message}");
        }
        await using var _ = container;
        var profile = new ConnectionProfile
        {
            Id = "c_it", Name = "IT", ProviderId = "sqlserver",
            Props = new Dictionary<string, JsonNode?> { ["server"] = $"{container.Hostname},{container.GetMappedPublicPort(1433)}", ["auth"] = "sql", ["user"] = "sa", ["encrypt"] = "optional", ["trustServerCertificate"] = true },
        };
        var src = new SqlServerLogSource(new DirectRunnerFactory(new SqlServerProvider(), profile, "DbStudio_It_2026!"));
        var target = new LogTarget("c_it", profile);
        var list = await src.ListAsync(target, default);
        Assert.All(list.Where(s => s.Id != "agentlog"), s => Assert.True(s.Available, s.Id));
        var log = await src.QueryAsync(target, LogFilter.Validate(new LogQuery("errorlog", Limit: 50)), default);
        Assert.NotEmpty(log.Entries);
        await src.QueryAsync(target, LogFilter.Validate(new LogQuery("system_health", Limit: 50)), default);
        await src.SnapshotAsync(target, default);
    }

    [SkippableFact]
    public async Task Postgres_server_log_and_activity()
    {
        SkipUnlessDocker();
        Skip.If(IsStub(), "The PostgreSQL provider is still the M2-0 stub (PG-A).");
        PostgreSqlContainer container;
        try
        {
            container = new PostgreSqlBuilder("postgres:17").WithCommand("-c", "logging_collector=on", "-c", "log_destination=stderr").Build();
            await container.StartAsync();
        }
        catch (Exception ex)
        {
            throw new SkipException($"Docker/PostgreSQL unavailable: {ex.Message}");
        }
        await using var _ = container;
        var profile = new ConnectionProfile
        {
            Id = "c_pg", Name = "IT PG", ProviderId = "postgresql",
            Props = new Dictionary<string, JsonNode?> { ["host"] = container.Hostname, ["port"] = container.GetMappedPublicPort(5432), ["database"] = "postgres", ["user"] = "postgres" },
        };
        var src = new PgLogSource(new DirectRunnerFactory(new PostgreSqlProvider(), profile, "postgres"));
        var target = new LogTarget("c_pg", profile);
        var list = await src.ListAsync(target, default);
        Assert.True(list[0].Available, list[0].Reason);
        Assert.NotEmpty((await src.QueryAsync(target, LogFilter.Validate(new LogQuery("serverlog")), default)).Entries);
        await src.SnapshotAsync(target, default);
    }

    private static bool IsStub()
    {
        try
        {
            _ = new PostgreSqlProvider().BuildConnectionString(new ConnectionProfile { ProviderId = "postgresql", Props = new() { ["host"] = "x" } }, null);
            return false;
        }
        catch (NotSupportedException)
        {
            return true;
        }
    }

    [SkippableFact]
    public async Task Redis_slowlog_and_clients()
    {
        SkipUnlessDocker();
        DotNet.Testcontainers.Containers.IContainer container;
        try
        {
            container = new ContainerBuilder("redis:7.4").WithPortBinding(6379, true)
                .WithWaitStrategy(DotNet.Testcontainers.Builders.Wait.ForUnixContainer().UntilCommandIsCompleted("redis-cli", "ping")).Build();
            await container.StartAsync();
        }
        catch (Exception ex)
        {
            throw new SkipException($"Docker/Redis unavailable: {ex.Message}");
        }
        await using var _ = container;
        var target = new LogTarget("c_r", new ConnectionProfile
        {
            Id = "c_r", ProviderId = "redis", Props = new() { ["host"] = container.Hostname, ["port"] = container.GetMappedPublicPort(6379) },
        });
        await using var gw = new RespRedisGateway(_ => null);
        var node = (await gw.NodesAsync(target, default))[0];
        await node.ExecuteAsync(["CONFIG", "SET", "slowlog-log-slower-than", "0"], default);
        await node.ExecuteAsync(["SET", "k", "v"], default);
        var src = new RedisLogSource(gw);
        Assert.NotEmpty((await src.QueryAsync(target, LogFilter.Validate(new LogQuery("slowlog")), default)).Entries);
        Assert.NotEmpty(await src.SnapshotAsync(target, default));
    }
}
