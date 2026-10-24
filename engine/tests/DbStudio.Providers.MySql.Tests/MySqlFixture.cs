using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using DotNet.Testcontainers.Containers;
using Testcontainers.MariaDb;
using Testcontainers.MySql;

namespace DbStudio.Providers.MySql.Tests;

/// <summary>Which server a backend runs.</summary>
public enum Flavor { MySql, MariaDb }

/// <summary>
/// MySQL 8.4 and MariaDB 11 backends shared by every test class of this assembly (plan-batch3 WP-MY): a Testcontainers
/// container per flavor on a random port (or the server named by DBSTUDIO_MYSQL_HOST/PORT/USER/PASSWORD resp.
/// DBSTUDIO_MARIADB_*, e.g. the compose services on 13306/13307), seeded once from engine/tests/docker/seed-mysql.sql
/// (+ seed-mariadb.sql) through a provider session as root. Unavailable (tests skipped) when DBSTUDIO_IT=0 or Docker
/// cannot be reached.
/// </summary>
public static class MySqlBackend
{
    public const string MySqlImage = "mysql:8.4";
    public const string MariaDbImage = "mariadb:11";
    public const string DefaultPassword = "shop";
    public const string DatabaseName = "shop";

    public sealed record Endpoint(Flavor Flavor, string Host, int Port, string User, string Password);

    private static readonly Lazy<Task<(Endpoint?, string?, Exception?)>> s_mysql = new(() => StartAsync(Flavor.MySql), LazyThreadSafetyMode.ExecutionAndPublication);
    private static readonly Lazy<Task<(Endpoint?, string?, Exception?)>> s_maria = new(() => StartAsync(Flavor.MariaDb), LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync(Flavor flavor) =>
        flavor == Flavor.MySql ? s_mysql.Value : s_maria.Value;

    public static ConnectionProfile Profile(Endpoint e, string? database = DatabaseName, string? id = null) => new()
    {
        Id = id ?? (e.Flavor == Flavor.MySql ? "c_it_mysql" : "c_it_mariadb"),
        Name = e.Flavor == Flavor.MySql ? "IT MySQL" : "IT MariaDB",
        ProviderId = e.Flavor == Flavor.MySql ? "mysql" : "mariadb",
        Props = new Dictionary<string, JsonNode?>
        {
            ["host"] = e.Host,
            ["port"] = e.Port,
            ["database"] = database,
            ["user"] = e.User,
            ["sslMode"] = "none",
            ["allowPublicKeyRetrieval"] = true,
            ["connectTimeout"] = 30,
        },
        HasPassword = true,
    };

    public static IDbProvider Provider(Flavor f) => f == Flavor.MySql ? new MySqlProvider() : new MariaDbProvider();

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync(Flavor flavor)
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);
        var prefix = flavor == Flavor.MySql ? "DBSTUDIO_MYSQL_" : "DBSTUDIO_MARIADB_";
        Endpoint endpoint;
        var external = Environment.GetEnvironmentVariable(prefix + "HOST");
        if (!string.IsNullOrWhiteSpace(external))
        {
            var port = int.TryParse(Environment.GetEnvironmentVariable(prefix + "PORT"), out var p) ? p : flavor == Flavor.MySql ? 13306 : 13307;
            endpoint = new Endpoint(flavor, external, port, Environment.GetEnvironmentVariable(prefix + "USER") ?? "root",
                Environment.GetEnvironmentVariable(prefix + "PASSWORD") ?? DefaultPassword);
        }
        else
        {
            try
            {
                // Modest memory: a small buffer pool; table log output for the log-source tests.
                string[] args = ["--innodb-buffer-pool-size=67108864", "--log-output=TABLE,FILE", "--slow-query-log=1", "--long-query-time=0.2",
                    "--character-set-server=utf8mb4"];
                IContainer container;
                int containerPort;
                if (flavor == Flavor.MySql)
                {
                    var c = new MySqlBuilder(MySqlImage).WithDatabase(DatabaseName).WithUsername("root").WithPassword(DefaultPassword)
                        .WithCommand([.. args, "--performance-schema=ON"]).Build();
                    await c.StartAsync().ConfigureAwait(false);
                    container = c;
                    containerPort = 3306;
                }
                else
                {
                    var c = new MariaDbBuilder(MariaDbImage).WithDatabase(DatabaseName).WithUsername("root").WithPassword(DefaultPassword)
                        .WithCommand(args).Build();
                    await c.StartAsync().ConfigureAwait(false);
                    container = c;
                    containerPort = 3306;
                }
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint(flavor, container.Hostname, container.GetMappedPublicPort(containerPort), "root", DefaultPassword);
            }
            catch (Exception ex)
            {
                return (null, $"Docker/{flavor} container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }

        try
        {
            await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"{flavor} seeding failed: {ex.Message}", ex);
        }
    }

    /// <summary>Runs the seed scripts statement by statement (DELIMITER-aware split) on one session.</summary>
    private static async Task SeedAsync(Endpoint endpoint)
    {
        var provider = Provider(endpoint.Flavor);
        await using var session = await provider.OpenSessionAsync(Profile(endpoint, id: "c_it_my_seed"), endpoint.Password,
            new SessionOptions("s_it_my_seed", null, TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
        var files = endpoint.Flavor == Flavor.MySql ? new[] { "seed-mysql.sql" } : ["seed-mysql.sql", "seed-mariadb.sql"];
        foreach (var file in files)
        {
            var script = await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "docker", file)).ConfigureAwait(false);
            var batches = MySqlSqlText.Split(script).Select(s =>
            {
                var (line, col) = MySqlSqlText.LineColAt(script, s.Start);
                return new SqlBatch(s.Text(script), line, col);
            }).ToList();
            var sink = new RecordingSink();
            var summary = await session.ExecuteAsync(new ExecuteRequest(batches, 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
            if (summary.Status != ExecutionStatus.Ok)
                throw new InvalidOperationException($"{file} failed:" + Environment.NewLine + sink.Describe());
        }
    }
}

/// <summary>Conformance fixture over one flavor; the shop is seeded by <see cref="MySqlBackend"/>.</summary>
public abstract class MySqlFixtureBase(Flavor flavor) : ProviderFixture
{
    public Flavor Flavor { get; } = flavor;

    public override IDbProvider Provider { get; } = MySqlBackend.Provider(flavor);

    public override string ShopSchema => "shop";

    public override string ShopSchemaQualifier => "";

    protected override bool SeedOnInitialize => false;

    public override string LongRunningQuery => "SELECT SLEEP(60)";

    public override string CreateScratchTableSql(string table) => $"CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY, val VARCHAR(50) NULL)";

    public Exception? SetupError { get; private set; }

    public MySqlBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await MySqlBackend.GetAsync(Flavor).ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = MySqlBackend.Profile(endpoint);
        Password = endpoint.Password;
        return true;
    }

    public override ConnectionProfile? CreateFailingProfile() =>
        Endpoint is null ? null : MySqlBackend.Profile(Endpoint with { User = "no_such_user_xyz" }, id: "c_it_my_bad");
}

public sealed class MySqlFixture() : MySqlFixtureBase(Flavor.MySql);

public sealed class MariaDbFixture() : MySqlFixtureBase(Flavor.MariaDb);

/// <summary>The shared provider conformance suite against MySQL 8.4 (skipped without Docker).</summary>
public sealed class MySqlConformanceTests(MySqlFixture fixture) : ProviderConformanceTests<MySqlFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}

/// <summary>The shared provider conformance suite against MariaDB 11 (skipped without Docker).</summary>
public sealed class MariaDbConformanceTests(MariaDbFixture fixture) : ProviderConformanceTests<MariaDbFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}
