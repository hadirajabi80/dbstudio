using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.SqlServer.TSql;
using Testcontainers.MsSql;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>
/// SQL Server backend shared by every test class of this assembly: a Testcontainers SQL Server 2022 container
/// (or the server named by DBSTUDIO_MSSQL_SERVER), seeded once from engine/tests/docker/seed-mssql.sql.
/// Unavailable (tests skipped) when DBSTUDIO_IT=0 or Docker cannot be reached.
/// </summary>
public static class SqlServerBackend
{
    public const string Image = "mcr.microsoft.com/mssql/server:2022-latest";
    public const string DefaultPassword = "DbStudio_It_2026!";
    public const string DatabaseName = "shop";

    public sealed record Endpoint(string Server, string User, string Password);

    private static readonly Lazy<Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)>> s_backend =
        new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    private static MsSqlContainer? s_container;

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync() => s_backend.Value;

    public static ConnectionProfile Profile(Endpoint e, string? database = DatabaseName, string id = "c_it_mssql") => new()
    {
        Id = id,
        Name = "IT SQL Server",
        ProviderId = "sqlserver",
        Props = new Dictionary<string, JsonNode?>
        {
            ["server"] = e.Server,
            ["auth"] = "sql",
            ["user"] = e.User,
            ["database"] = database,
            ["encrypt"] = "optional",
            ["trustServerCertificate"] = true,
            ["connectTimeout"] = 30,
        },
        HasPassword = true,
    };

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);

        Endpoint endpoint;
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_MSSQL_SERVER");
        if (!string.IsNullOrWhiteSpace(external))
        {
            endpoint = new Endpoint(external, Environment.GetEnvironmentVariable("DBSTUDIO_MSSQL_USER") ?? "sa",
                Environment.GetEnvironmentVariable("DBSTUDIO_MSSQL_PASSWORD") ?? "DbStudio_Dev_2026!");
        }
        else
        {
            try
            {
                var container = new MsSqlBuilder(Image).WithPassword(DefaultPassword).Build();
                await container.StartAsync().ConfigureAwait(false);
                s_container = container;
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint($"{container.Hostname},{container.GetMappedPublicPort(1433)}", "sa", DefaultPassword);
            }
            catch (Exception ex)
            {
                return (null, $"Docker/SQL Server container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }

        try
        {
            await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"SQL Server seeding failed: {ex.Message}", ex);
        }
    }

    /// <summary>Runs seed-mssql.sql (GO-split) on one session connected to master.</summary>
    private static async Task SeedAsync(Endpoint endpoint)
    {
        var provider = new SqlServerProvider();
        var script = await File.ReadAllTextAsync(SeedScriptPath).ConfigureAwait(false);
        var batches = BatchSplitter.Split(script).Where(b => !string.IsNullOrWhiteSpace(b.Text))
            .Select(b => new SqlBatch(b.Text, b.StartLine, 1)).ToList();
        await using var session = await provider.OpenSessionAsync(Profile(endpoint, "master", "c_it_mssql_admin"), endpoint.Password,
            new SessionOptions("s_it_seed", "master", TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(batches, 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
        if (summary.Status != ExecutionStatus.Ok)
            throw new InvalidOperationException("seed-mssql.sql failed:" + Environment.NewLine + sink.Describe());
    }

    public static string SeedScriptPath => Path.Combine(AppContext.BaseDirectory, "docker", "seed-mssql.sql");
}

/// <summary>Conformance fixture for SQL Server; the shop database is seeded by <see cref="SqlServerBackend"/>.</summary>
public sealed class SqlServerFixture : ProviderFixture
{
    public override IDbProvider Provider { get; } = new SqlServerProvider();

    public override string? Database => SqlServerBackend.DatabaseName;

    /// <summary>Seeded from the docker seed script instead of ShopSchema.Seed (same data plus SQL Server extras).</summary>
    protected override bool SeedOnInitialize => false;

    /// <summary>Set when the server was reachable but setting it up failed (a real failure, not a skip).</summary>
    public Exception? SetupError { get; private set; }

    public SqlServerBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await SqlServerBackend.GetAsync().ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = SqlServerBackend.Profile(endpoint);
        Password = endpoint.Password;
        return true;
    }

    public override ConnectionProfile? CreateFailingProfile() =>
        Endpoint is null ? null : SqlServerBackend.Profile(Endpoint with { User = "no_such_login_xyz" }, id: "c_it_mssql_bad");
}
