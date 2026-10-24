using System.Text;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using Testcontainers.Cassandra;

namespace DbStudio.Providers.Cassandra.Tests;

/// <summary>
/// Cassandra backend shared by every integration test of this assembly: a Testcontainers <c>cassandra:5</c> node
/// (MAX_HEAP_SIZE=512M; materialized views and UDFs enabled in cassandra.yaml before the node starts) or the node named by
/// DBSTUDIO_CASSANDRA_HOST / DBSTUDIO_CASSANDRA_PORT (e.g. the compose service on localhost:19042), seeded once from
/// engine/tests/docker/seed-cassandra.cql through a provider session. Unavailable (tests skipped) when DBSTUDIO_IT=0 or
/// Docker cannot be reached. The first start takes 60–90 s.
/// </summary>
public static class CassandraBackend
{
    public const string Image = "cassandra:5";
    public const string Keyspace = "shop";

    public sealed record Endpoint(string Host, int Port);

    private const string EntryScript =
        "#!/bin/sh\n" +
        "sed -i -e 's/^materialized_views_enabled: false/materialized_views_enabled: true/' " +
        "-e 's/^user_defined_functions_enabled: false/user_defined_functions_enabled: true/' /etc/cassandra/cassandra.yaml\n" +
        "exec docker-entrypoint.sh cassandra -f\n";

    private static readonly Lazy<Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)>> s_backend =
        new(StartAsync, LazyThreadSafetyMode.ExecutionAndPublication);

    public static Task<(Endpoint? Endpoint, string? SkipReason, Exception? SetupError)> GetAsync() => s_backend.Value;

    public static ConnectionProfile Profile(Endpoint e, string? keyspace = Keyspace, string id = "c_it_cassandra") => new()
    {
        Id = id,
        Name = "IT Cassandra",
        ProviderId = CassandraProvider.ProviderId,
        Props = new Dictionary<string, JsonNode?>
        {
            ["contactPoints"] = e.Host,
            ["port"] = e.Port,
            ["keyspace"] = keyspace,
            ["consistency"] = "ONE",
            ["connectTimeout"] = 30,
            ["requestTimeout"] = 60,
        },
    };

    private static async Task<(Endpoint?, string?, Exception?)> StartAsync()
    {
        if (Environment.GetEnvironmentVariable("DBSTUDIO_IT") == "0")
            return (null, "Integration tests disabled (DBSTUDIO_IT=0).", null);

        Endpoint endpoint;
        var external = Environment.GetEnvironmentVariable("DBSTUDIO_CASSANDRA_HOST");
        if (!string.IsNullOrWhiteSpace(external))
        {
            var port = int.TryParse(Environment.GetEnvironmentVariable("DBSTUDIO_CASSANDRA_PORT"), out var p) ? p : 19042;
            endpoint = new Endpoint(external, port);
        }
        else
        {
            try
            {
                var container = new CassandraBuilder(Image)
                    .WithEnvironment("MAX_HEAP_SIZE", "512M")
                    .WithEnvironment("HEAP_NEWSIZE", "128M")
                    .WithResourceMapping(Encoding.UTF8.GetBytes(EntryScript), "/rowlit-entry.sh")
                    .WithEntrypoint("sh", "/rowlit-entry.sh")
                    .Build();
                await container.StartAsync().ConfigureAwait(false);
                AppDomain.CurrentDomain.ProcessExit += (_, _) =>
                {
                    try { container.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(20)); } catch { /* Ryuk cleans up */ }
                };
                endpoint = new Endpoint(container.Hostname, container.GetMappedPublicPort(9042));
            }
            catch (Exception ex)
            {
                return (null, $"Docker/Cassandra container unavailable: {ex.GetType().Name}: {ex.Message}", null);
            }
        }

        try
        {
            await SeedAsync(endpoint).ConfigureAwait(false);
            return (endpoint, null, null);
        }
        catch (Exception ex)
        {
            return (null, $"Cassandra seeding failed: {ex.Message}", ex);
        }
    }

    /// <summary>Runs seed-cassandra.cql (one batch per statement) on a session without keyspace; retries while the node warms up.</summary>
    private static async Task SeedAsync(Endpoint endpoint)
    {
        var script = await File.ReadAllTextAsync(SeedScriptPath).ConfigureAwait(false);
        var batches = CqlText.Split(script).Select(s =>
        {
            var (line, col) = CqlText.LineColAt(script, s.Start);
            return new SqlBatch(s.Text, line, col);
        }).ToList();
        var provider = new CassandraProvider();
        Exception? last = null;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                await using var session = await provider.OpenSessionAsync(Profile(endpoint, keyspace: null, id: "c_it_cassandra_seed"), null,
                    new SessionOptions("s_it_cassandra_seed", null, TransactionMode.Auto, false), CancellationToken.None).ConfigureAwait(false);
                var sink = new RecordingSink();
                var summary = await session.ExecuteAsync(new ExecuteRequest(batches, 0, true, false, "script"), sink, CancellationToken.None).ConfigureAwait(false);
                if (summary.Status != ExecutionStatus.Ok)
                    throw new InvalidOperationException("seed-cassandra.cql failed:" + Environment.NewLine + sink.Describe());
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                await Task.Delay(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
        }
        throw last!;
    }

    public static string SeedScriptPath => Path.Combine(AppContext.BaseDirectory, "docker", "seed-cassandra.cql");
}

/// <summary>Fixture of the Cassandra integration tests (subset of the conformance fixture; the shop keyspace is seeded once).</summary>
public sealed class CassandraFixture : ProviderFixture
{
    public override IDbProvider Provider => CqlProvider;

    public CassandraProvider CqlProvider { get; } = new();

    public override string ShopSchema => CassandraBackend.Keyspace;

    public override string ShopSchemaQualifier => "";

    protected override bool SeedOnInitialize => false;

    public override bool SupportsTransactions => false;

    public override string? MultiResultSetBatch => "SELECT id FROM countries; SELECT name FROM products";

    public override string InvalidQuery => "SELECT * FROM no_such_table_xyz";

    public override string CreateScratchTableSql(string table) => $"CREATE TABLE {table} (id int PRIMARY KEY, val text)";

    public override string InsertScratchRowsSql(string table, int firstId, int count) =>
        "BEGIN UNLOGGED BATCH " + string.Concat(Enumerable.Range(firstId, count).Select(i => $"INSERT INTO {table} (id, val) VALUES ({i}, 'v{i}'); ")) + "APPLY BATCH";

    public override ConnectionProfile? CreateFailingProfile() => new()
    {
        Id = "c_it_cassandra_bad",
        Name = "bad",
        ProviderId = CassandraProvider.ProviderId,
        Props = new Dictionary<string, JsonNode?> { ["contactPoints"] = "127.0.0.1", ["port"] = 1, ["connectTimeout"] = 2 },
    };

    public Exception? SetupError { get; private set; }

    public CassandraBackend.Endpoint? Endpoint { get; private set; }

    protected override async Task<bool> SetUpAsync()
    {
        var (endpoint, skip, error) = await CassandraBackend.GetAsync().ConfigureAwait(false);
        SetupError = error;
        if (endpoint is null)
        {
            SkipReason = skip;
            return false;
        }
        Endpoint = endpoint;
        Profile = CassandraBackend.Profile(endpoint);
        return true;
    }

    protected override async Task TearDownAsync() => await CqlProvider.Pool.DisposeAsync().ConfigureAwait(false);
}

[CollectionDefinition(Name)]
public sealed class CassandraCollection : ICollectionFixture<CassandraFixture>
{
    public const string Name = "cassandra";
}
