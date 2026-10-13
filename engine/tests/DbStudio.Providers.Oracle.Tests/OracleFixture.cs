using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using Testcontainers.Oracle;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>
/// Oracle backend shared by every test class of this assembly: a Testcontainers gvenzl/oracle-free:23-slim container
/// with APP_USER=shop (or the server named by DBSTUDIO_ORACLE_HOST), seeded once from engine/tests/docker/seed-oracle.sql
/// as SYSTEM. Unavailable (tests skipped) when DBSTUDIO_IT=0 or Docker cannot be reached.
/// </summary>
public static class OracleBackend
{
    public const string Image = "gvenzl/oracle-free:23-slim";
    public const string DefaultPassword = "DbStudioIt2026";
    public const string ServiceName = "FREEPDB1";
    public const string AppUser = "shop";

    /// <param name="SystemPassword">SYSTEM password used for seeding; null skips seeding (externally seeded server).</param>
    public sealed record Endpoint(string Host, int Port, string Service, string User, string Password, string? SystemPassword);

    private static readonly Lazy<Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)>> s_backend =
        new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync() => s_backend.Value;

    public static ConnectionProfile Profile(Endpoint e, string? user = null, string id = "c_it_oracle") => new()
    {
        Id = id,
        Name = "IT Oracle",
        ProviderId = "oracle",
        Props = new Dictionary<string, JsonNode?>
        {
            ["connectionType"] = "basic",
            ["host"] = e.Host,
            ["port"] = e.Port,
            ["serviceName"] = e.Service,
            ["user"] = user ?? e.User,
            ["role"] = "normal",
            ["connectTimeout"] = 60,
        },
        HasPassword = true,
    };

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);

        Endpoint endpoint;
        var host = Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_HOST");
        if (!string.IsNullOrWhiteSpace(host))
        {
            endpoint = new Endpoint(host,
                int.TryParse(Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_PORT"), out var port) ? port : 1521,
                Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_SERVICE") ?? ServiceName,
                Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_USER") ?? AppUser,
                Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_PASSWORD") ?? "shop",
                Environment.GetEnvironmentVariable("DBSTUDIO_ORACLE_SYSTEM_PASSWORD"));
        }
        else
        {
            try
            {
                var container = new OracleBuilder(Image).WithUsername(AppUser).WithPassword(DefaultPassword).Build();
                await container.StartAsync().ConfigureAwait(false);
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint(container.Hostname, container.GetMappedPublicPort(1521), ServiceName, AppUser, DefaultPassword, DefaultPassword);
            }
            catch (Exception ex)
            {
                return (null, $"Docker/Oracle container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }

        try
        {
            if (endpoint.SystemPassword is not null) await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"Oracle seeding failed: {ex.Message}", ex);
        }
    }

    /// <summary>Statements of seed-oracle.sql (split on "/" lines), minus the CDB-only ALTER SESSION SET CONTAINER.</summary>
    public static IReadOnlyList<SqlBatch> SeedStatements()
    {
        var lines = File.ReadAllText(SeedScriptPath).Replace("\r\n", "\n").Split('\n');
        var result = new List<SqlBatch>();
        var current = new List<string>();
        int start = 1;
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].Trim() == "/")
            {
                var text = string.Join("\n", current);
                if (!string.IsNullOrWhiteSpace(text)) result.Add(new SqlBatch(text, start, 1));
                current.Clear();
                start = i + 2;
                continue;
            }
            current.Add(lines[i]);
        }
        if (current.Any(l => !string.IsNullOrWhiteSpace(l) && !l.TrimStart().StartsWith("--")))
            throw new InvalidOperationException("seed-oracle.sql: the last statement is not terminated by '/'.");
        return result;
    }

    private static async Task SeedAsync(Endpoint endpoint)
    {
        var provider = new OracleProvider();
        var statements = SeedStatements()
            .Where(s => !OracleSqlText.Tokenize(s.Sql).Take(4).Select(t => t.Text.ToUpperInvariant()).SequenceEqual(["ALTER", "SESSION", "SET", "CONTAINER"]))
            .ToList();
        await using var session = await provider.OpenSessionAsync(Profile(endpoint, "system", "c_it_oracle_admin"), endpoint.SystemPassword,
            new SessionOptions("s_it_seed", null, TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(statements, 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
        if (summary.Status != ExecutionStatus.Ok)
            throw new InvalidOperationException("seed-oracle.sql failed:" + Environment.NewLine + sink.Describe());
    }

    public static string SeedScriptPath => Path.Combine(AppContext.BaseDirectory, "docker", "seed-oracle.sql");
}

/// <summary>Conformance fixture for Oracle; the SHOP schema is seeded by <see cref="OracleBackend"/>.</summary>
public sealed class OracleFixture : ProviderFixture
{
    public override IDbProvider Provider { get; } = new OracleProvider();

    protected override bool SeedOnInitialize => false;

    public Exception? SetupError { get; private set; }

    public OracleBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await OracleBackend.GetAsync().ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = OracleBackend.Profile(endpoint);
        Password = endpoint.Password;
        return true;
    }

    public override ConnectionProfile? CreateFailingProfile() =>
        Endpoint is null ? null : OracleBackend.Profile(Endpoint, user: "no_such_user_xyz", id: "c_it_oracle_bad");
}
