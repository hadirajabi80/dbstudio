using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using Testcontainers.PostgreSql;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>
/// PostgreSQL backend shared by every test class of this assembly (docs/PLAN-PG.md 2.9): a Testcontainers postgres:17
/// container (or the server named by DBSTUDIO_PG_HOST / DBSTUDIO_PG_PORT / DBSTUDIO_PG_PASSWORD, e.g. the compose
/// service on localhost:15432), seeded once from engine/tests/docker/seed-postgres.sql through a provider session.
/// Unavailable (tests skipped) when DBSTUDIO_IT=0 or Docker cannot be reached.
/// </summary>
public static class PgBackend
{
    public const string Image = "postgres:17";
    public const string DefaultPassword = "shop";
    public const string DatabaseName = "shop";
    public const string User = "shop";

    public sealed record Endpoint(string Host, int Port, string User, string Password);

    private static readonly Lazy<Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)>> s_backend =
        new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync() => s_backend.Value;

    public static ConnectionProfile Profile(Endpoint e, string? database = DatabaseName, string id = "c_it_pg") => new()
    {
        Id = id,
        Name = "IT PostgreSQL",
        ProviderId = "postgresql",
        Props = new Dictionary<string, JsonNode?>
        {
            ["host"] = e.Host,
            ["port"] = e.Port,
            ["database"] = database,
            ["user"] = e.User,
            ["sslMode"] = "disable",
            ["connectTimeout"] = 30,
        },
        HasPassword = true,
    };

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);

        Endpoint endpoint;
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_PG_HOST");
        if (!string.IsNullOrWhiteSpace(external))
        {
            var port = int.TryParse(Environment.GetEnvironmentVariable("DBSTUDIO_PG_PORT"), out var p) ? p : 15432;
            endpoint = new Endpoint(external, port, Environment.GetEnvironmentVariable("DBSTUDIO_PG_USER") ?? User,
                Environment.GetEnvironmentVariable("DBSTUDIO_PG_PASSWORD") ?? DefaultPassword);
        }
        else
        {
            try
            {
                var container = new PostgreSqlBuilder(Image).WithDatabase(DatabaseName).WithUsername(User).WithPassword(DefaultPassword).Build();
                await container.StartAsync().ConfigureAwait(false);
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint(container.Hostname, container.GetMappedPublicPort(5432), User, DefaultPassword);
            }
            catch (Exception ex)
            {
                return (null, $"Docker/PostgreSQL container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }

        try
        {
            await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"PostgreSQL seeding failed: {ex.Message}", ex);
        }
    }

    /// <summary>Runs seed-postgres.sql statement by statement (PostgreSQL splitting keeps $$ bodies whole) on one session.</summary>
    private static async Task SeedAsync(Endpoint endpoint)
    {
        var provider = new PostgreSqlProvider();
        var script = await File.ReadAllTextAsync(SeedScriptPath).ConfigureAwait(false);
        var batches = PgSqlText.Split(script).Select(s =>
        {
            var (line, col) = PgSqlText.LineColAt(script, s.Start);
            return new SqlBatch(s.Text(script), line, col);
        }).ToList();
        await using var session = await provider.OpenSessionAsync(Profile(endpoint, id: "c_it_pg_seed"), endpoint.Password,
            new SessionOptions("s_it_pg_seed", null, TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(batches, 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
        if (summary.Status != ExecutionStatus.Ok)
            throw new InvalidOperationException("seed-postgres.sql failed:" + Environment.NewLine + sink.Describe());
    }

    public static string SeedScriptPath => Path.Combine(AppContext.BaseDirectory, "docker", "seed-postgres.sql");
}

/// <summary>Conformance fixture for PostgreSQL; the shop schema (public + sales) is seeded by <see cref="PgBackend"/>.</summary>
public sealed class PgFixture : ProviderFixture
{
    public override IDbProvider Provider { get; } = new PostgreSqlProvider();

    /// <summary>Catalog calls pass null: the profile's database (shop).</summary>
    public override string? Database => null;

    public override string ShopSchema => "public";

    public override string ShopSchemaQualifier => "";

    protected override bool SeedOnInitialize => false;

    public override string LongRunningQuery => "SELECT pg_sleep(60)";

    public Exception? SetupError { get; private set; }

    public PgBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await PgBackend.GetAsync().ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = PgBackend.Profile(endpoint);
        Password = endpoint.Password;
        return true;
    }

    public override ConnectionProfile? CreateFailingProfile() =>
        Endpoint is null ? null : PgBackend.Profile(Endpoint with { User = "no_such_role_xyz" }, id: "c_it_pg_bad");
}

/// <summary>The shared provider conformance suite against PostgreSQL 17 (skipped without Docker).</summary>
public sealed class PgConformanceTests(PgFixture fixture) : ProviderConformanceTests<PgFixture>(fixture)
{
    [SkippableFact]
    public void Backend_SetupSucceeded_WhenServerReachable()
    {
        Assert.True(Fixture.SetupError is null, Fixture.SetupError?.ToString());
        RequireAvailable();
    }
}
