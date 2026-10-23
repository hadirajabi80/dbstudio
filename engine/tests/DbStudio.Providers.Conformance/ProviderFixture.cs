using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Providers.Conformance;

/// <summary>
/// Per-provider fixture for <see cref="ProviderConformanceTests{TFixture}"/>. A provider test project derives from it,
/// implements <see cref="Provider"/> and <see cref="SetUpAsync"/> (start a container / create a temp file and assign
/// <see cref="Profile"/> and <see cref="Password"/>), and may override the dialect SQL below.
/// <para>When the backing server is unavailable (no Docker), return false from <see cref="SetUpAsync"/> after setting
/// <see cref="SkipReason"/>: every conformance test is then skipped instead of failing.</para>
/// </summary>
public abstract class ProviderFixture : IAsyncLifetime
{
    public abstract IDbProvider Provider { get; }

    public Dialect Dialect => Provider.Dialect;

    /// <summary>Profile used by every test (Id should be stable, e.g. "c_conformance").</summary>
    public ConnectionProfile Profile { get; protected set; } = new();

    public string? Password { get; protected set; }

    public bool IsAvailable { get; private set; }

    public string? SkipReason { get; protected set; }

    /// <summary>Database passed to catalog calls (SQL Server: the test database; others null).</summary>
    public virtual string? Database => null;

    /// <summary>Schema holding the shop objects (dbo / SHOP / main).</summary>
    public virtual string ShopSchema => Conformance.ShopSchema.DefaultSchema(Dialect);

    /// <summary>Prefix used to qualify shop tables in test SQL ("dbo." for T-SQL, "" when the shop schema is the session default).</summary>
    public virtual string ShopSchemaQualifier => Dialect == Dialect.TSql ? "dbo." : "";

    /// <summary>Seed batches executed by <see cref="InitializeAsync"/> when <see cref="SeedOnInitialize"/>.</summary>
    public virtual IReadOnlyList<string> SeedBatches => Conformance.ShopSchema.Seed(Dialect);

    /// <summary>False when the container/db is already seeded externally (docker init scripts).</summary>
    protected virtual bool SeedOnInitialize => true;

    /// <summary>Batch 3: false when the provider has no manual transactions (ClickHouse, Cassandra): the transaction tests skip.</summary>
    public virtual bool SupportsTransactions => true;

    /// <summary>Batch 3: false when manual transactions have no savepoints (Snowflake): the edit-savepoint tests skip.</summary>
    public virtual bool SupportsSavepoints => true;

    /// <summary>Batch 3: false when a running statement cannot be cancelled: the cancel tests skip.</summary>
    public virtual bool SupportsCancel => true;

    /// <summary>A query that runs for at least ~30 s unless cancelled.</summary>
    /// <remarks>
    /// Oracle: a CPU-bound query (a 10^10-row cartesian count), not <c>DBMS_SESSION.SLEEP</c>. ODP.NET cancels with a
    /// TNS break; when the network drops out-of-band (urgent) data, as Docker Desktop's port forwarding does, the break
    /// arrives in-band and a sleeping session only reads it when the sleep ends (cancel then takes the full 60 s),
    /// while a running SQL statement checks for breaks and stops in milliseconds. The provider's cancel is the same
    /// in both cases; only the statement differed.
    /// </remarks>
    public virtual string LongRunningQuery => Dialect switch
    {
        Dialect.TSql => "WAITFOR DELAY '00:01:00'",
        Dialect.PlSql => "SELECT COUNT(*) FROM (SELECT 1 FROM dual CONNECT BY LEVEL <= 100000) a, (SELECT 1 FROM dual CONNECT BY LEVEL <= 100000) b",
        _ => "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000000) SELECT count(*) FROM c",
    };

    /// <summary>One batch producing two result sets, or null when the dialect cannot (Oracle without RETURN_RESULT).</summary>
    public virtual string? MultiResultSetBatch => Dialect switch
    {
        Dialect.PlSql => null,
        _ => "SELECT 1 AS a; SELECT 'x' AS b, 2 AS c",
    };

    /// <summary>"" or " FROM dual" appended to constant SELECTs.</summary>
    public string FromDual => Dialect == Dialect.PlSql ? " FROM dual" : "";

    /// <summary>A single-line statement that fails at the server (unknown table).</summary>
    public virtual string InvalidQuery => "SELECT * FROM no_such_table_xyz";

    /// <summary>A profile whose TestAsync must fail (bad path / unreachable host), or null to skip that test.</summary>
    public virtual ConnectionProfile? CreateFailingProfile() => null;

    /// <summary>Maps a logical (T-SQL PascalCase) shop identifier to the dialect's physical name.</summary>
    public string N(string logical) => Conformance.ShopSchema.Name(Dialect, logical);

    public virtual string CreateScratchTableSql(string table) => Dialect switch
    {
        Dialect.TSql => $"CREATE TABLE {table} (id INT NOT NULL PRIMARY KEY, val NVARCHAR(50) NULL)",
        Dialect.PlSql => $"CREATE TABLE {table} (id NUMBER(10) PRIMARY KEY, val VARCHAR2(50))",
        _ => $"CREATE TABLE {table} (id INTEGER PRIMARY KEY, val TEXT)",
    };

    public virtual string DropScratchTableSql(string table) => $"DROP TABLE {table}";

    /// <summary>One INSERT statement adding rows with ids firstId..firstId+count-1.</summary>
    public virtual string InsertScratchRowsSql(string table, int firstId, int count)
    {
        var rows = Enumerable.Range(firstId, count).ToList();
        return Dialect switch
        {
            Dialect.PlSql => $"INSERT INTO {table} (id, val) " +
                             string.Join(" UNION ALL ", rows.Select(i => $"SELECT {i}, 'v{i}' FROM dual")),
            _ => $"INSERT INTO {table} (id, val) VALUES " + string.Join(", ", rows.Select(i => $"({i}, 'v{i}')")),
        };
    }

    /// <summary>Creates the provider resources; return false (and set <see cref="SkipReason"/>) when unavailable.</summary>
    protected abstract Task<bool> SetUpAsync();

    /// <summary>Releases provider resources (containers, temp files).</summary>
    protected virtual Task TearDownAsync() => Task.CompletedTask;

    public async Task InitializeAsync()
    {
        try
        {
            IsAvailable = await SetUpAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            IsAvailable = false;
            SkipReason ??= $"Provider setup failed: {ex.Message}";
        }
        if (IsAvailable && SeedOnInitialize) await RunBatchesAsync(SeedBatches).ConfigureAwait(false);
    }

    public async Task DisposeAsync() => await TearDownAsync().ConfigureAwait(false);

    private int _sessionCounter;

    public Task<IDbSession> OpenSessionAsync(TransactionMode mode = TransactionMode.Auto, bool captureServerOutput = false, CancellationToken ct = default) =>
        Provider.OpenSessionAsync(Profile, Password,
            new SessionOptions($"s_conf_{Interlocked.Increment(ref _sessionCounter)}", Database, mode, captureServerOutput), ct);

    public Task<ICatalogReader> OpenCatalogAsync(CancellationToken ct = default) => Provider.OpenCatalogReaderAsync(Profile, Password, ct);

    /// <summary>Executes each string as one batch on a fresh auto-commit session; throws on the first error.</summary>
    public async Task RunBatchesAsync(IEnumerable<string> batches, CancellationToken ct = default)
    {
        await using var session = await OpenSessionAsync(ct: ct).ConfigureAwait(false);
        foreach (var sql in batches)
        {
            var sink = new RecordingSink();
            await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "script"), sink, ct).ConfigureAwait(false);
            if (sink.Errors.Count > 0)
                throw new InvalidOperationException($"Fixture SQL failed: {sink.Errors[0].Error.Message}{Environment.NewLine}{sql}");
        }
    }

    /// <summary>Runs one query and returns the first column of the first row as a wire value.</summary>
    public async Task<object?> ScalarAsync(string sql, CancellationToken ct = default)
    {
        await using var session = await OpenSessionAsync(ct: ct).ConfigureAwait(false);
        var sink = new RecordingSink();
        await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 10, true, false, "statement"), sink, ct).ConfigureAwait(false);
        if (sink.Errors.Count > 0) throw new InvalidOperationException(sink.Errors[0].Error.Message);
        return sink.ResultSets.FirstOrDefault()?.Rows.FirstOrDefault()?[0];
    }
}
