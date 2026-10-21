using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.PostgreSql.Tests;

/// <summary>
/// Core services over the PostgreSQL provider (docs/PLAN-PG.md D-PG6, D-PG7): reopening a session on another database,
/// per-database catalog caches with the search path in the snapshot, and Core's PostgreSQL classification.
/// </summary>
public sealed class PgEngineServiceTests(PgFixture fixture) : IClassFixture<PgFixture>, IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-pg-tests", Guid.NewGuid().ToString("N"));
    private SessionManager? _sessions;

    private (SessionManager Sessions, CatalogService Catalog, ConnectionProfile Profile) Env()
    {
        var providers = new ProviderRegistry([new PostgreSqlProvider()]);
        var connections = new ConnectionStore(new AppPaths(_dir), new InMemorySecretStore(), providers);
        var events = new NullPublisher();
        _sessions = new SessionManager(providers, connections, events, new ResultStore(ResultStore.DefaultCapBytes));
        var profile = connections.Create(new ConnectionProfile
        {
            Name = "pg", ProviderId = "postgresql",
            Props = new(fixture.Profile.Props.Select(kv => KeyValuePair.Create(kv.Key, kv.Value?.DeepClone()))),
        }, fixture.Password);
        return (_sessions, new CatalogService(providers, connections, events), profile);
    }

    [SkippableFact]
    public async Task ChangeDatabase_ReopensTheSession_InPlace()
    {
        Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "PostgreSQL not available.");
        var (sessions, _, profile) = Env();
        var h = await sessions.CreateAsync(profile.Id, null, TransactionMode.Auto, false, CancellationToken.None);
        Assert.Equal("shop", h.Session.CurrentDatabase);
        await Assert.ThrowsAsync<NotSupportedException>(() => h.Session.ChangeDatabaseAsync("postgres", CancellationToken.None));

        await sessions.ReopenWithDatabaseAsync(h, "postgres", CancellationToken.None);
        Assert.Equal("postgres", h.Session.CurrentDatabase);
        Assert.Equal("postgres", h.Options.Database);
        Assert.Same(h, sessions.Get(h.Id));

        await sessions.ReopenWithDatabaseAsync(h, "shop", CancellationToken.None);
        Assert.Equal("shop", h.Session.CurrentDatabase);

        await h.Session.SetTransactionModeAsync(TransactionMode.Manual, CancellationToken.None);
        var sink = new DbStudio.Providers.Conformance.RecordingSink();
        await h.Session.ExecuteAsync(new ExecuteRequest([new SqlBatch("CREATE TEMP TABLE zz_reopen (a int)", 1, 1)], 10, true, false, "script"), sink, CancellationToken.None);
        Assert.True(h.Session.TxOpen);
        var ex = await Assert.ThrowsAsync<EngineException>(() => sessions.ReopenWithDatabaseAsync(h, "postgres", CancellationToken.None));
        Assert.Equal((409, ErrorCodes.TxOpen), (ex.Status, ex.Code));
        await h.Session.RollbackAsync(CancellationToken.None);
    }

    [SkippableFact]
    public async Task Catalog_KeepsOneCachePerDatabase_AndSendsTheSearchPath()
    {
        Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "PostgreSQL not available.");
        var (_, catalog, profile) = Env();
        var dbs = await catalog.GetDatabasesAsync(profile.Id, CancellationToken.None);
        Assert.Equal("shop", dbs.Current);
        Assert.Contains("postgres", dbs.Databases);

        var shop = await catalog.GetSchemasAsync(profile.Id, null, CancellationToken.None);
        Assert.Equal("shop", shop.Database);
        Assert.Contains(shop.Schemas, s => s.Name == "sales");
        Assert.Equal(0, shop.Schemas.Single(s => s.Name == "public").SearchPathIndex);
        var other = await catalog.GetSchemasAsync(profile.Id, "postgres", CancellationToken.None);
        Assert.Equal("postgres", other.Database);
        Assert.DoesNotContain(other.Schemas, s => s.Name == "sales");

        var snapshot = await catalog.GetSnapshotAsync(profile.Id, null, null, null, CancellationToken.None);
        using var doc = System.Text.Json.JsonDocument.Parse(snapshot.Json!);
        Assert.Equal("pgsql", doc.RootElement.GetProperty("dialect").GetString());
        Assert.Equal("shop", doc.RootElement.GetProperty("database").GetString());
        Assert.Equal("public", doc.RootElement.GetProperty("searchPath")[0].GetString());
    }

    public async ValueTask DisposeAsync()
    {
        if (_sessions is not null) await _sessions.DisposeAsync();
        try { Directory.Delete(_dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private sealed class NullPublisher : IEventPublisher
    {
        public void Publish(EngineEvent ev) { }
    }
}

/// <summary>Core's tokenizer and classifier with PostgreSQL rules (ReadOnlyGuard and DDL targets use them).</summary>
public sealed class CorePgClassificationTests
{
    [Theory]
    [InlineData("SELECT $$ DELETE FROM t; $$", true)]
    [InlineData("SELECT $tag$ ; UPDATE x $tag$ AS body", true)]
    [InlineData("SELECT E'it\\'s; DROP TABLE x'", true)]
    [InlineData("SELECT meta ? 'k', a::text, arr[1:3] FROM t", true)]
    [InlineData("SELECT 1 /* nested /* DELETE */ still comment */", true)]
    [InlineData("BEGIN", true)]
    [InlineData("START TRANSACTION", true)]
    [InlineData("SHOW search_path", true)]
    [InlineData("TABLE countries", true)]
    [InlineData("DO $$ BEGIN PERFORM 1; END $$", false)]
    [InlineData("COPY t FROM '/tmp/x'", false)]
    [InlineData("SELECT * INTO newtable FROM t", false)]
    [InlineData("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", false)]
    public void IsQueryOnly(string sql, bool queryOnly) => Assert.Equal(queryOnly, StatementClassifier.Classify(sql, Dialect.PgSql).IsQueryOnly);

    [Fact]
    public void FunctionBodies_StayOneStatement_AndDdlTargetsAreFound()
    {
        const string sql = "CREATE OR REPLACE FUNCTION sales.f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM t; COMMIT; END $$;\n" +
                           "CREATE DOMAIN public.email AS text; CREATE TABLE shop.public.t (a int); END";
        var c = StatementClassifier.Classify(sql, Dialect.PgSql);
        Assert.Equal(4, c.Statements.Count);
        Assert.Equal(("CREATE FUNCTION", "sales", "f"), (c.Statements[0].Kind, c.Statements[0].Ddl!.Schema, c.Statements[0].Ddl!.Name));
        Assert.Equal(ObjectTypes.Type, c.Statements[1].Ddl!.ObjectType);
        Assert.Equal(("shop", "public", "t"), (c.Statements[2].Ddl!.Database, c.Statements[2].Ddl!.Schema, c.Statements[2].Ddl!.Name));
        Assert.Equal((StatementCategory.Transaction, "COMMIT"), (c.Statements[3].Category, c.Statements[3].Kind));
    }

    [Fact]
    public void Tokens_PlaceholdersAndOperators()
    {
        var tokens = SqlTokenizer.Tokenize("SELECT $1, :id, @p, x ? 'k', arr[1:3], a::int, b @> '{}' FROM t", Dialect.PgSql);
        Assert.Equal(["$1", ":id", "@p"], tokens.Where(t => t.Kind == SqlTokenKind.Parameter).Select(t => t.Value));
        Assert.DoesNotContain(tokens, t => t.Kind == SqlTokenKind.QuotedIdentifier);
        Assert.Single(SqlTokenizer.SplitStatements(SqlTokenizer.Tokenize("CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END", Dialect.PgSql), Dialect.PgSql));
    }
}
