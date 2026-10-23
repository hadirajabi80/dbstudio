using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>
/// Opt-in live account (plan-batch3 D10): DBSTUDIO_SF_ACCOUNT, DBSTUDIO_SF_USER and DBSTUDIO_SF_PASSWORD or
/// DBSTUDIO_SF_PRIVATE_KEY_PATH (+ DBSTUDIO_SF_PRIVATE_KEY_PASSPHRASE), DBSTUDIO_SF_WAREHOUSE, DBSTUDIO_SF_DATABASE (a database
/// the role may write to; the shop lands in its PUBLIC schema), optional DBSTUDIO_SF_ROLE. DBSTUDIO_SF_SEED=1 (re)creates the
/// shop; DBSTUDIO_UPDATE_GOLDEN=1 additionally records the catalog answers to Fixtures/recorded/live.json for review.
/// Everything here is skipped without DBSTUDIO_SF_ACCOUNT or with DBSTUDIO_IT=0.
/// </summary>
public static class SnowflakeLive
{
    public static string? Env(string name) => Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : null;

    public static string? SkipReason =>
        Env("DBSTUDIO_IT") == "0" ? "Integration tests disabled (DBSTUDIO_IT=0)."
        : Env("DBSTUDIO_SF_ACCOUNT") is null ? "No Snowflake account (set DBSTUDIO_SF_ACCOUNT, DBSTUDIO_SF_USER, DBSTUDIO_SF_PASSWORD…)."
        : Env("DBSTUDIO_SF_DATABASE") is null ? "DBSTUDIO_SF_DATABASE is required for the live suite."
        : null;

    public static ConnectionProfile Profile()
    {
        var keyPath = Env("DBSTUDIO_SF_PRIVATE_KEY_PATH");
        var props = new Dictionary<string, JsonNode?>
        {
            ["account"] = Env("DBSTUDIO_SF_ACCOUNT"),
            ["user"] = Env("DBSTUDIO_SF_USER"),
            ["authenticator"] = keyPath is null ? SnowflakeAuth.Password : SnowflakeAuth.KeyPair,
            ["warehouse"] = Env("DBSTUDIO_SF_WAREHOUSE"),
            ["database"] = Env("DBSTUDIO_SF_DATABASE"),
            ["schema"] = "PUBLIC",
            ["role"] = Env("DBSTUDIO_SF_ROLE"),
            ["queryTag"] = "Rowlit tests",
        };
        if (keyPath is not null)
        {
            props["privateKeyFile"] = keyPath;
            props["privateKeyPassphrase"] = Env("DBSTUDIO_SF_PRIVATE_KEY_PASSPHRASE");
        }
        return new ConnectionProfile { Id = "c_it_sf", Name = "IT Snowflake", ProviderId = "snowflake", Props = props, HasPassword = true };
    }

    public static string? Password => Env("DBSTUDIO_SF_PASSWORD");
}

public sealed class SnowflakeLiveFixture : ProviderFixture
{
    private readonly SnowflakeProvider _provider = new();

    public override IDbProvider Provider => _provider;
    public override string? Database => SnowflakeLive.Env("DBSTUDIO_SF_DATABASE")?.ToUpperInvariant();
    protected override bool SeedOnInitialize => SnowflakeLive.Env("DBSTUDIO_SF_SEED") == "1";
    public override bool SupportsSavepoints => false;
    public override string LongRunningQuery => "SELECT SYSTEM$WAIT(60)";
    public override string InvalidQuery => "SELECT * FROM NO_SUCH_TABLE_XYZ";
    public override string CreateScratchTableSql(string table) => $"CREATE TABLE {table} (ID NUMBER(38,0) PRIMARY KEY, VAL VARCHAR(50))";

    public override ConnectionProfile? CreateFailingProfile()
    {
        var p = SnowflakeLive.Profile();
        p.Props["user"] = "NO_SUCH_USER_XYZ";
        p.Id = "c_it_sf_bad";
        return p;
    }

    protected override Task<bool> SetUpAsync()
    {
        if (SnowflakeLive.SkipReason is { } reason)
        {
            SkipReason = reason;
            return Task.FromResult(false);
        }
        Profile = SnowflakeLive.Profile();
        Password = SnowflakeLive.Password;
        return Task.FromResult(true);
    }
}

/// <summary>The shared provider conformance suite against the live account (skipped without DBSTUDIO_SF_*).</summary>
public sealed class SnowflakeConformanceTests(SnowflakeLiveFixture fixture) : ProviderConformanceTests<SnowflakeLiveFixture>(fixture);

public sealed class SnowflakeLiveTests(SnowflakeLiveFixture fixture) : IClassFixture<SnowflakeLiveFixture>
{
    private void Require() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason);

    [SkippableFact]
    public async Task Session_reads_snowflake_types_and_hides_bookkeeping_results()
    {
        Require();
        await using var session = await fixture.OpenSessionAsync();
        var sink = new RecordingSink();
        await session.ExecuteAsync(new ExecuteRequest(
        [
            new SqlBatch("SELECT 42::NUMBER(38,0) AS I, 1.5::NUMBER(10,2) AS D, PARSE_JSON('{\"a\":[1,2]}') AS V, '2026-10-23 10:00:00 +02:00'::TIMESTAMP_TZ AS TZ, TO_BINARY('CAFE', 'HEX') AS B", 1, 1),
            new SqlBatch("CREATE OR REPLACE TEMPORARY TABLE RW_T (ID INT)", 2, 1),
            new SqlBatch("INSERT INTO RW_T VALUES (1), (2), (3)", 3, 1),
        ], 100, true, false, "script"), sink, CancellationToken.None);
        Assert.Empty(sink.Errors);
        var rs = Assert.Single(sink.ResultSets);
        Assert.Equal(["int", "decimal", "json", "datetimeoffset", "binary"], rs.Columns.Select(c => c.Kind));
        Assert.Equal(42L, Convert.ToInt64(rs.Rows[0][0]));
        Assert.Contains(sink.Affected, a => a is { Count: 3, StatementKind: "INSERT" });
        Assert.Contains(sink.Messages, m => m.Text.Contains("successfully created", StringComparison.OrdinalIgnoreCase));
    }

    [SkippableFact]
    public async Task Catalog_and_ddl_of_the_shop()
    {
        Require();
        await using var reader = await fixture.OpenCatalogAsync();
        var schema = await reader.LoadSchemaAsync(fixture.Database, "PUBLIC", CancellationToken.None);
        Assert.Contains(schema.Objects, o => o.Name == "CUSTOMERS");
        var ddl = await reader.GetDdlAsync(new ObjectRef(fixture.Database, "PUBLIC", "ORDERS", ObjectTypes.Table), CancellationToken.None);
        Assert.Contains("ORDERS", ddl.Ddl, StringComparison.OrdinalIgnoreCase);
        if (DbStudio.Providers.Conformance.M15.Golden.Updating) await RecordAsync();
    }

    /// <summary>Records the catalog commands' live answers (DBSTUDIO_UPDATE_GOLDEN=1) for refreshing the handwritten fixtures.</summary>
    private async Task RecordAsync([CallerFilePath] string callerFile = "")
    {
        var db = fixture.Database!;
        await using var gw = await new SnowflakeGatewayFactory().OpenAsync(fixture.Profile, fixture.Password, CancellationToken.None);
        var entries = new JsonArray();
        foreach (var sql in new[]
                 {
                     SnowflakeSql.ShowSchemas(db), SnowflakeSql.ShowTables(db, "PUBLIC"), SnowflakeSql.ShowViews(db, "PUBLIC"),
                     SnowflakeSql.ShowColumns(db, "PUBLIC"), SnowflakeSql.ShowPrimaryKeys(db, "PUBLIC"), SnowflakeSql.ShowImportedKeys(db, "PUBLIC"),
                     SnowflakeSql.DescribeTable(db, "PUBLIC", "ORDERS"), SnowflakeSql.GetDdl("TABLE", db, "PUBLIC", "ORDERS"), Module.SnowflakeObjects.ShowWarehouses,
                 })
        {
            SqlRowSet rs;
            try { rs = await gw.QueryAsync(sql, CancellationToken.None); }
            catch (SnowflakeQueryException ex) { entries.Add(new JsonObject { ["sql"] = sql, ["error"] = new JsonObject { ["code"] = ex.ErrorCode, ["message"] = ex.Message } }); continue; }
            entries.Add(new JsonObject
            {
                ["sql"] = sql,
                ["columns"] = new JsonArray(rs.Columns.Select(c => (JsonNode?)JsonValue.Create(c)).ToArray()),
                ["rows"] = new JsonArray(rs.Rows.Select(r => (JsonNode?)new JsonArray(r.Select(v => v is null ? null : JsonValue.Create(SqlCells.Str(v))).ToArray())).ToArray()),
            });
        }
        var dir = Path.Combine(Path.GetDirectoryName(callerFile)!, "Fixtures", "recorded");
        Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(Path.Combine(dir, "live.json.txt"),
            new JsonObject { ["entries"] = entries }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
    }
}
