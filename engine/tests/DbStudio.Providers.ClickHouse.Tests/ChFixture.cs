using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using Testcontainers.ClickHouse;

namespace DbStudio.Providers.ClickHouse.Tests;

/// <summary>
/// ClickHouse backend shared by the integration tests: a Testcontainers clickhouse/clickhouse-server:24.8 container (random
/// port, 1.5 GB memory cap) or the server named by DBSTUDIO_CH_HOST / DBSTUDIO_CH_PORT / DBSTUDIO_CH_USER /
/// DBSTUDIO_CH_PASSWORD (e.g. the compose service on localhost:18123), seeded once from engine/tests/docker/seed-clickhouse.sql
/// through a provider session. Unavailable (tests skipped) when DBSTUDIO_IT=0 or Docker cannot be reached.
/// </summary>
public static class ChBackend
{
    public const string Image = "clickhouse/clickhouse-server:24.8";
    public const string User = "shop";
    public const string DefaultPassword = "shop";

    public sealed record Endpoint(string Host, int Port, string User, string Password);

    private static readonly Lazy<Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)>> s_backend =
        new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync() => s_backend.Value;

    public static ConnectionProfile Profile(Endpoint e, string database = "shop", string id = "c_it_ch") => new()
    {
        Id = id,
        Name = "IT ClickHouse",
        ProviderId = "clickhouse",
        Props = new Dictionary<string, JsonNode?>
        {
            ["host"] = e.Host,
            ["port"] = e.Port,
            ["protocol"] = "http",
            ["database"] = database,
            ["user"] = e.User,
            ["connectTimeout"] = 30,
        },
        HasPassword = true,
    };

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);
        Endpoint endpoint;
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_CH_HOST");
        if (!string.IsNullOrWhiteSpace(external))
        {
            var port = int.TryParse(Environment.GetEnvironmentVariable("DBSTUDIO_CH_PORT"), out var p) ? p : 18123;
            endpoint = new Endpoint(external, port, Environment.GetEnvironmentVariable("DBSTUDIO_CH_USER") ?? User,
                Environment.GetEnvironmentVariable("DBSTUDIO_CH_PASSWORD") ?? DefaultPassword);
        }
        else
        {
            try
            {
                var container = new ClickHouseBuilder(Image)
                    .WithUsername(User)
                    .WithPassword(DefaultPassword)
                    .WithEnvironment("CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "1")
                    .WithCreateParameterModifier(p => { if (p.HostConfig is not null) p.HostConfig.Memory = 1536L * 1024 * 1024; })
                    .WithLabel("rowlit.wp", "wp-ch")
                    .Build();
                await container.StartAsync().ConfigureAwait(false);
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint(container.Hostname, container.GetMappedPublicPort(8123), User, DefaultPassword);
            }
            catch (Exception ex)
            {
                return (null, $"Docker/ClickHouse container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }
        try
        {
            await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"ClickHouse seeding failed: {ex.Message}", ex);
        }
    }

    public static string SeedScriptPath => Path.Combine(AppContext.BaseDirectory, "docker", "seed-clickhouse.sql");

    /// <summary>The seed script as one batch: the session splits it into statements (one request each).</summary>
    private static async Task SeedAsync(Endpoint endpoint)
    {
        var provider = new ClickHouseProvider();
        var script = await File.ReadAllTextAsync(SeedScriptPath).ConfigureAwait(false);
        // The database may not exist yet: seed from "default".
        await using var session = await provider.OpenSessionAsync(Profile(endpoint, "default", "c_it_ch_seed"), endpoint.Password,
            new SessionOptions("s_it_ch_seed", null, TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(script, 1, 1)], 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
        if (summary.Status != ExecutionStatus.Ok)
            throw new InvalidOperationException("seed-clickhouse.sql failed:" + Environment.NewLine + sink.Describe());
    }
}

/// <summary>Conformance fixture for ClickHouse (database "shop" seeded by <see cref="ChBackend"/>).</summary>
public sealed class ChFixture : ProviderFixture
{
    public override IDbProvider Provider { get; } = new ClickHouseProvider();

    public override string ShopSchema => "shop";

    public override string ShopSchemaQualifier => "";

    protected override bool SeedOnInitialize => false;

    public override bool SupportsTransactions => false;
    public override bool SupportsForeignKeys => false;
    public override bool SupportsIdentity => false;
    public override bool ReportsDmlRowCounts => false;

    public override string LongRunningQuery => "SELECT sum(number) FROM numbers_mt(10000000000000)";

    public override string CreateScratchTableSql(string table) => $"CREATE TABLE {table} (id Int32, val Nullable(String)) ENGINE = MergeTree ORDER BY id";

    public Exception? SetupError { get; private set; }

    public ChBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await ChBackend.GetAsync().ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = ChBackend.Profile(endpoint);
        Password = endpoint.Password;
        return true;
    }

    public override ConnectionProfile? CreateFailingProfile() =>
        Endpoint is null ? null : ChBackend.Profile(Endpoint with { User = "no_such_user_xyz" }, id: "c_it_ch_bad");
}
