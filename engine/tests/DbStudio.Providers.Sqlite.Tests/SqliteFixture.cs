using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Tests;

/// <summary>Temp-file SQLite database seeded with the shop schema, plus an attached "archive" database.</summary>
public sealed class SqliteFixture : ProviderFixture
{
    public override IDbProvider Provider { get; } = new SqliteProvider();

    public string Directory { get; } = Path.Combine(Path.GetTempPath(), "dbstudio-tests", Guid.NewGuid().ToString("N"));
    public string DbPath => Path.Combine(Directory, "shop.sqlite");
    public string ArchivePath => Path.Combine(Directory, "archive.sqlite");

    protected override async Task<bool> SetUpAsync()
    {
        System.IO.Directory.CreateDirectory(Directory);
        await CreateArchiveAsync(ArchivePath);
        Profile = CreateProfile(DbPath, ArchivePath);
        return true;
    }

    public static ConnectionProfile CreateProfile(string dbPath, string? archivePath = null)
    {
        var profile = new ConnectionProfile
        {
            Id = "c_sqlite_conformance",
            Name = "SQLite conformance",
            ProviderId = "sqlite",
            Props = new Dictionary<string, JsonNode?>
            {
                ["path"] = dbPath,
                ["createIfMissing"] = true,
            },
        };
        if (archivePath is not null) profile.Props["attach"] = new JsonArray($"archive={archivePath}");
        return profile;
    }

    public static async Task CreateArchiveAsync(string path)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        await connection.OpenAsync();
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = """
            DROP TABLE IF EXISTS archived_orders;
            CREATE TABLE archived_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, total DECIMAL(12,2) NOT NULL, archived_at DATETIME);
            INSERT INTO archived_orders (id, customer_id, total, archived_at) VALUES (100, 1, 10.00, '2025-12-31 23:59:59');
            """;
        await cmd.ExecuteNonQueryAsync();
    }

    public override ConnectionProfile? CreateFailingProfile()
    {
        var p = CreateProfile(Path.Combine(Directory, "does-not-exist.sqlite"));
        p.Props["createIfMissing"] = false;
        return p;
    }

    protected override Task TearDownAsync()
    {
        SqliteConnection.ClearAllPools();
        try { System.IO.Directory.Delete(Directory, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        return Task.CompletedTask;
    }
}

public sealed class SqliteConformanceTests(SqliteFixture fixture) : ProviderConformanceTests<SqliteFixture>(fixture);
