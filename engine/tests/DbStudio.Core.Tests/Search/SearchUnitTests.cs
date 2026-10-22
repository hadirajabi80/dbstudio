using System.Runtime.CompilerServices;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Search;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests.Search;

public sealed class SearchMatcherTests
{
    [Fact]
    public void Literal_IsCaseInsensitiveByDefault_AndFindsEveryMatch()
    {
        var m = new SearchMatcher("cust");
        Assert.Equal([[0, 4], [9, 4]], m.Matches("Customer customers"));
        Assert.Equal("cust", m.Literal);
        Assert.False(m.IsRegex);
    }

    [Fact]
    public void MatchCase_WholeWord_AndRegexMetaCharactersInALiteral()
    {
        Assert.Empty(new SearchMatcher("cust", matchCase: true).Matches("Customer"));
        var word = new SearchMatcher("id", wholeWord: true);
        Assert.Equal([[0, 2], [6, 2]], word.Matches("id, x.ID, idx, customer_id")); // "id" and "ID", not idx / customer_id
        // A term starting with a non-word character still gets a word boundary.
        Assert.Single(new SearchMatcher("@id", wholeWord: true).Matches("WHERE x = @id AND y = @idx"));
        // Regex metacharacters are literal unless regex is on.
        Assert.Single(new SearchMatcher("a.b").Matches("a.b axb"));
        Assert.Equal(2, new SearchMatcher("a.b", regex: true).Matches("a.b axb").Count);
    }

    [Fact]
    public void Regex_IsValidated_AndHasNoLiteral()
    {
        var m = new SearchMatcher(@"cust\w+s\b", regex: true);
        Assert.Null(m.Literal);
        Assert.True(m.IsMatch("all customers here"));
        var ex = Assert.Throws<EngineException>(() => new SearchMatcher("(unclosed", regex: true));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        Assert.Throws<EngineException>(() => new SearchMatcher(""));
        Assert.Throws<EngineException>(() => new SearchMatcher(new string('x', SearchMatcher.MaxTermLength + 1)));
    }

    [Fact]
    public void Snippet_KeepsShortLines_AndCutsAWindowAroundTheFirstMatch()
    {
        var (text, ranges) = SearchMatcher.Snippet("SELECT\tName", [[7, 4]]);
        Assert.Equal("SELECT Name", text);
        Assert.Equal([[7, 4]], ranges);

        var line = new string('a', 500) + "NEEDLE" + new string('b', 500);
        var m = new SearchMatcher("needle");
        var (cut, shifted) = SearchMatcher.Snippet(line, m.Matches(line), 120);
        Assert.StartsWith("…", cut);
        Assert.EndsWith("…", cut);
        Assert.True(cut.Length <= 122);
        Assert.Equal("NEEDLE", cut.Substring(shifted[0][0], shifted[0][1]));
    }
}

public sealed class SearchSqlTests
{
    [Theory]
    [InlineData(Dialect.TSql, "50%_off![x]", "%50!%!_off!!![x]%")]
    [InlineData(Dialect.PlSql, "50%_off![x]", "%50!%!_off!![x]%")]
    [InlineData(Dialect.PgSql, "50%_off![x]", "%50!%!_off!![x]%")]
    [InlineData(Dialect.Sqlite, "a\\b'c", "%a\\b'c%")]
    public void LikePattern_EscapesWildcardsAndTheEscapeCharacter(Dialect d, string literal, string expected) =>
        Assert.Equal(expected, SearchSql.LikePattern(d, literal));

    [Fact]
    public void LikePredicate_PerDialect()
    {
        Assert.Equal("UPPER(o.name) LIKE UPPER(@p) ESCAPE '!'", SearchSql.LikePredicate(Dialect.TSql, "o.name", "@p", false));
        Assert.Equal("o.name LIKE @p ESCAPE '!'", SearchSql.LikePredicate(Dialect.TSql, "o.name", "@p", true));
        Assert.Equal("UPPER(text) LIKE UPPER(:p) ESCAPE '!'", SearchSql.LikePredicate(Dialect.PlSql, "text", ":p", false));
        Assert.Equal("x ILIKE $2 ESCAPE '!'", SearchSql.LikePredicate(Dialect.PgSql, "x", "$2", false));
        Assert.Equal("x LIKE $2 ESCAPE '!'", SearchSql.LikePredicate(Dialect.PgSql, "x", "$2", true));
        Assert.Equal("x LIKE @p ESCAPE '!'", SearchSql.LikePredicate(Dialect.Sqlite, "x", "@p", false));
    }

    [Theory]
    [InlineData(Dialect.TSql, "nvarchar(50)", "[c]")]
    [InlineData(Dialect.TSql, "varchar(max)", "[c]")]
    [InlineData(Dialect.TSql, "ntext", "CAST([c] AS nvarchar(max))")]
    [InlineData(Dialect.TSql, "xml", "CAST([c] AS nvarchar(max))")]
    [InlineData(Dialect.TSql, "uniqueidentifier", "CAST([c] AS nvarchar(36))")]
    [InlineData(Dialect.TSql, "int", null)]
    [InlineData(Dialect.TSql, "varbinary(max)", null)]
    [InlineData(Dialect.PlSql, "VARCHAR2(100 CHAR)", "\"c\"")]
    [InlineData(Dialect.PlSql, "CLOB", "\"c\"")]
    [InlineData(Dialect.PlSql, "NUMBER(10,2)", null)]
    [InlineData(Dialect.PlSql, "LONG", null)]
    [InlineData(Dialect.PgSql, "character varying(20)", "\"c\"")]
    [InlineData(Dialect.PgSql, "text[]", "CAST(\"c\" AS text)")]
    [InlineData(Dialect.PgSql, "jsonb", "CAST(\"c\" AS text)")]
    [InlineData(Dialect.PgSql, "uuid", "CAST(\"c\" AS text)")]
    [InlineData(Dialect.PgSql, "integer", null)]
    [InlineData(Dialect.PgSql, "bytea", null)]
    [InlineData(Dialect.Sqlite, "TEXT", "\"c\"")]
    [InlineData(Dialect.Sqlite, "VARCHAR(10)", "\"c\"")]
    [InlineData(Dialect.Sqlite, "", "\"c\"")]
    [InlineData(Dialect.Sqlite, "INTEGER", null)]
    [InlineData(Dialect.Sqlite, "BLOB", null)]
    public void TextExpression_ClassifiesColumnTypes(Dialect d, string type, string? expected) =>
        Assert.Equal(expected, SearchSql.TextExpression(d, SearchSql.Quote(d, "c"), type));

    private static readonly (string, string?)[] Columns = [("Id", "int"), ("Na]me", "nvarchar(50)"), ("Notes", "ntext"), ("Total", "decimal(10,2)")];

    [Fact]
    public void DataQuery_SqlServer_TopQuotedIdentifiersAndOneBoundParameter()
    {
        var q = SearchSql.BuildDataQuery(Dialect.TSql, "dbo", "Order]s", ["Id"], Columns, new SearchMatcher("50%"), 25)!;
        Assert.Equal("SELECT TOP (25) [Id], [Na]]me], CAST([Notes] AS nvarchar(max)) FROM [dbo].[Order]]s] " +
                     "WHERE (UPPER([Na]]me]) LIKE UPPER(@p) ESCAPE '!' OR UPPER(CAST([Notes] AS nvarchar(max))) LIKE UPPER(@p) ESCAPE '!')", q.Sql);
        Assert.Equal(("p", (object?)"%50!%%"), Assert.Single(q.Parameters));
        Assert.Equal(["Id"], q.KeyColumns);
        Assert.Equal(["Na]me", "Notes"], q.TextColumns);
    }

    [Fact]
    public void DataQuery_Oracle_RownumAndColonParameter()
    {
        var q = SearchSql.BuildDataQuery(Dialect.PlSql, "SHOP", "CUSTOMERS", ["ID"], [("ID", "NUMBER(10)"), ("NAME", "VARCHAR2(100)"), ("BIO", "CLOB")],
            new SearchMatcher("smith", matchCase: true), 10)!;
        Assert.Equal("SELECT \"ID\", \"NAME\", \"BIO\" FROM \"SHOP\".\"CUSTOMERS\" WHERE (\"NAME\" LIKE :p ESCAPE '!' OR \"BIO\" LIKE :p ESCAPE '!') AND ROWNUM <= 10", q.Sql);
    }

    [Fact]
    public void DataQuery_PostgresAndSqlite_LimitAndDialectRegex()
    {
        var pg = SearchSql.BuildDataQuery(Dialect.PgSql, "public", "t\"x", [], [("a", "text"), ("b", "jsonb")], new SearchMatcher("^ab+", regex: true), 5)!;
        Assert.Equal("SELECT \"a\", CAST(\"b\" AS text) FROM \"public\".\"t\"\"x\" WHERE (\"a\" ~* $1 OR CAST(\"b\" AS text) ~* $1) LIMIT 5", pg.Sql);
        Assert.Equal("^ab+", pg.Parameters[0].Value);
        Assert.Empty(pg.KeyColumns);

        var lite = SearchSql.BuildDataQuery(Dialect.Sqlite, "main", "t", ["id"], [("id", "INTEGER"), ("a", "TEXT")], new SearchMatcher("x+", regex: true), 2000)!;
        Assert.Equal("SELECT \"id\", \"a\" FROM \"main\".\"t\" WHERE (\"a\" REGEXP @p) LIMIT 1000", lite.Sql);
        Assert.Equal("(?i)x+", lite.Parameters[0].Value);

        var ora = SearchSql.BuildDataQuery(Dialect.PlSql, "S", "T", [], [("A", "VARCHAR2(10)")], new SearchMatcher("a|b", regex: true, matchCase: true), 3)!;
        Assert.Contains("REGEXP_LIKE(\"A\", :p, 'c')", ora.Sql);
    }

    [Fact]
    public void DataQuery_NullWithoutTextColumns_OrForARegexOnSqlServer()
    {
        Assert.Null(SearchSql.BuildDataQuery(Dialect.TSql, "dbo", "t", ["Id"], [("Id", "int")], new SearchMatcher("1"), 10));
        Assert.Null(SearchSql.BuildDataQuery(Dialect.TSql, "dbo", "t", [], [("A", "nvarchar(10)")], new SearchMatcher("a+", regex: true), 10));
    }

    [Fact]
    public void DataQuery_TheTermIsNeverPartOfTheSqlText()
    {
        const string evil = "'; DROP TABLE x; --";
        foreach (var d in new[] { Dialect.TSql, Dialect.PlSql, Dialect.PgSql, Dialect.Sqlite })
        {
            var q = SearchSql.BuildDataQuery(d, "s", "t", [], [("a", d == Dialect.PlSql ? "VARCHAR2(10)" : "varchar(10)")], new SearchMatcher(evil), 10)!;
            Assert.DoesNotContain("DROP", q.Sql);
            Assert.Contains("DROP TABLE", (string)q.Parameters[0].Value!);
        }
    }
}

public sealed class SearchRequestTests
{
    private static SearchRequest Parse(string json) => SearchRequest.Parse(JsonDocument.Parse(json).RootElement);

    [Fact]
    public void Parse_FullRequest()
    {
        var r = Parse("""
            { "term": "cust", "matchCase": true, "wholeWord": true, "regex": false,
              "in": { "names": true, "columns": false, "code": true, "data": true },
              "types": ["table", "PROC"], "dataRowLimit": 5000, "maxHits": 10,
              "targets": [ { "connectionId": "c1", "database": "Shop", "schema": "dbo" },
                           { "connectionId": "c2", "objects": [ { "schema": "main", "name": "orders" } ] } ] }
            """);
        Assert.True(r.Matcher.MatchCase);
        Assert.True(r.Matcher.WholeWord);
        Assert.False(r.Columns);
        Assert.True(r.Data);
        Assert.Equal(new HashSet<string> { "table", "proc" }, r.Types);
        Assert.Equal(SearchSql.MaxRowLimit, r.DataRowLimit);
        Assert.Equal(10, r.MaxHits);
        Assert.Equal(new SearchTarget("c1", "Shop", "dbo"), r.Targets[0] with { Objects = null });
        var o = Assert.Single(r.Targets[1].Objects!);
        Assert.Equal(new ObjectRef(null, "main", "orders", "table"), o);
    }

    [Theory]
    [InlineData("""{ "targets": [ { "connectionId": "c1" } ] }""", "params.term")]
    [InlineData("""{ "term": "  ", "targets": [ { "connectionId": "c1" } ] }""", "params.term")]
    [InlineData("""{ "term": "x" }""", "params.targets")]
    [InlineData("""{ "term": "x", "targets": [ { "database": "x" } ] }""", "params.targets")]
    [InlineData("""{ "term": "(", "regex": true, "targets": [ { "connectionId": "c1" } ] }""", "params.term")]
    [InlineData("""{ "term": "x", "types": ["nope"], "targets": [ { "connectionId": "c1" } ] }""", "params.types")]
    [InlineData("""{ "term": "x", "in": { "names": false, "columns": false, "code": false }, "targets": [ { "connectionId": "c1" } ] }""", "params.in")]
    public void Parse_RejectsMalformedRequests(string json, string field)
    {
        var ex = Assert.Throws<EngineException>(() => Parse(json));
        Assert.Equal(ErrorCodes.Validation, ex.Code);
        Assert.Contains(field, JsonSerializer.Serialize(ex.Detail));
    }
}

/// <summary>In-memory searcher: schemas with names, columns, code and table rows.</summary>
internal sealed class FakeSearcher(Dialect dialect = Dialect.Sqlite) : IDatabaseSearcher, ICatalogReader
{
    public List<string> Databases { get; } = [];
    public Dictionary<string, List<SearchNameRow>> Names { get; } = [];
    public Dictionary<string, List<SearchColumnRow>> Cols { get; } = [];
    public Dictionary<string, List<SearchCodeRow>> Code { get; } = [];
    public Dictionary<string, SchemaCatalog> Schemas { get; } = [];
    public Dictionary<string, List<object?[]>> Rows { get; } = [];
    public List<string> Queries { get; } = [];
    public string? FailSchema { get; set; }
    public TaskCompletionSource? Block { get; set; }
    public bool Disposed { get; private set; }

    public Dialect Dialect => dialect;
    public ICatalogReader Catalog => this;

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }

    public Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>(Databases);

    private void Check(string schema)
    {
        if (schema == FailSchema) throw new InvalidOperationException($"permission denied for schema {schema}");
    }

    async Task<IReadOnlyList<SearchNameRow>> IDatabaseSearcher.NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        Check(schema);
        if (Block is { } b) await b.Task.WaitAsync(ct);
        return Names.GetValueOrDefault(schema) ?? [];
    }

    Task<IReadOnlyList<SearchColumnRow>> IDatabaseSearcher.ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct)
    {
        Check(schema);
        return Task.FromResult<IReadOnlyList<SearchColumnRow>>(Cols.GetValueOrDefault(schema) ?? []);
    }

    async IAsyncEnumerable<SearchCodeRow> IDatabaseSearcher.CodeAsync(string? database, string schema, string? like, bool matchCase, [EnumeratorCancellation] CancellationToken ct)
    {
        Check(schema);
        await Task.Yield();
        foreach (var r in Code.GetValueOrDefault(schema) ?? []) yield return r;
    }

    async IAsyncEnumerable<object?[]> IDatabaseSearcher.QueryAsync(string? database, DataSearchQuery query, [EnumeratorCancellation] CancellationToken ct)
    {
        Queries.Add(query.Sql);
        await Task.Yield();
        var table = Rows.Keys.FirstOrDefault(k => query.Sql.Contains($"\"{k}\"", StringComparison.Ordinal));
        foreach (var r in table is null ? [] : Rows[table]) yield return r;
    }

    public Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>(Databases);
    public Task<string?> GetCurrentDatabaseAsync(CancellationToken ct) => Task.FromResult<string?>(null);
    public Task<IReadOnlyList<SchemaInfo>> ListSchemasAsync(string? database, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<SchemaInfo>>(Names.Keys.Union(Code.Keys).Union(Schemas.Keys).Distinct().Select(n => new SchemaInfo(n)).ToList());
    public Task<string> GetDefaultSchemaAsync(string? database, CancellationToken ct) => Task.FromResult("main");
    public Task<SchemaCatalog> LoadSchemaAsync(string? database, string schema, CancellationToken ct) => Task.FromResult(Schemas[schema]);
    public Task<ObjectDetails> GetObjectDetailsAsync(ObjectRef obj, CancellationToken ct) => throw new NotSupportedException();
    public Task<DdlResult> GetDdlAsync(ObjectRef obj, CancellationToken ct) => throw new NotSupportedException();
    public Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(ObjectRef obj, CancellationToken ct) => throw new NotSupportedException();
    public Task<CatalogObject?> ResolvePublicSynonymAsync(string name, CancellationToken ct) => throw new NotSupportedException();
}

public sealed class DatabaseSearchServiceTests
{
    private static SearchRequest Request(string term, SearchTarget[] targets, bool data = false, string[]? types = null, int maxHits = 2000, bool regex = false) => new()
    {
        Matcher = new SearchMatcher(term, regex: regex),
        Targets = targets,
        Data = data,
        Types = types?.ToHashSet(),
        MaxHits = maxHits,
    };

    private static async Task<List<SearchItem>> RunAsync(SearchRequest req, Func<string, IDatabaseSearcher> open, CancellationToken ct = default)
    {
        var items = new List<SearchItem>();
        var service = new DatabaseSearchService((id, _) => Task.FromResult(open(id)));
        await service.RunAsync(req, i => { lock (items) items.Add(i); }, ct);
        return items;
    }

    private static FakeSearcher Shop()
    {
        var s = new FakeSearcher();
        s.Names["main"] = [new("main", "customers", "table"), new("main", "orders", "table"), new("main", "customer_orders", "view"), new("main", "trg_customer", "trigger")];
        s.Cols["main"] = [new("main", "orders", "table", "customer_id", "INTEGER"), new("main", "orders", "table", "total", "REAL")];
        s.Code["main"] =
        [
            new("main", "customer_orders", "view", "CREATE VIEW customer_orders AS\nSELECT c.name\nFROM customers c JOIN orders o ON o.customer_id = c.id"),
            new("main", "trg_customer", "trigger", string.Join("\n", Enumerable.Range(1, 30).Select(i => $"-- customer {i}"))),
        ];
        return s;
    }

    [Fact]
    public async Task Names_Columns_AndCodeLinesWithLineNumbers_ThenDone()
    {
        var s = Shop();
        var items = await RunAsync(Request("customer", [new SearchTarget("c1", Schema: "main")]), _ => s);
        var hits = items.OfType<SearchHit>().ToList();
        Assert.Equal(["customers", "customer_orders", "trg_customer"], hits.Where(h => h.Match == "name").Select(h => h.Object.Name));
        var col = Assert.Single(hits, h => h.Match == "column");
        Assert.Equal(("orders", "customer_id", "INTEGER"), (col.Object.Name, col.Column, col.DataType));
        Assert.Equal([[0, 8]], col.Ranges);

        var view = hits.Where(h => h.Match == "code" && h.Object.Name == "customer_orders").ToList();
        Assert.Equal([1, 3], view.Select(h => h.Line!.Value));
        Assert.Equal("FROM customers c JOIN orders o ON o.customer_id = c.id", view[1].Text);
        Assert.Equal(2, view[1].Ranges.Count);

        // 30 matching trigger lines: 20 sent, the rest summed up in one "more" hit.
        var trigger = hits.Where(h => h.Match == "code" && h.Object.Name == "trg_customer").ToList();
        Assert.Equal(21, trigger.Count);
        Assert.Equal(10, trigger[^1].More);
        Assert.Null(trigger[^1].Line);

        Assert.Contains(items, i => i is SearchProgress { Phase: "code" });
        var done = Assert.IsType<SearchDone>(items[^1]);
        Assert.Equal(hits.Count - 1, done.Hits);
        Assert.False(done.Truncated);
        Assert.True(s.Disposed);
    }

    [Fact]
    public async Task TypeFilter_AndObjectsScope()
    {
        var items = await RunAsync(Request("customer", [new SearchTarget("c1", Schema: "main")], types: ["view"]), _ => Shop());
        Assert.All(items.OfType<SearchHit>(), h => Assert.Equal("view", h.Object.Type));
        Assert.DoesNotContain(items.OfType<SearchHit>(), h => h.Match == "column"); // views have no matching column here

        var scoped = await RunAsync(Request("customer", [new SearchTarget("c1", Objects: [new ObjectRef(null, "main", "orders", "table")])]), _ => Shop());
        var hits = scoped.OfType<SearchHit>().ToList();
        Assert.All(hits, h => Assert.Equal("orders", h.Object.Name));
        Assert.Equal("column", Assert.Single(hits).Match);
    }

    [Fact]
    public async Task WholeConnection_SearchesEveryUserDatabaseAndSchema_AndAFailingPartDoesNotStopTheRest()
    {
        var s = Shop();
        s.Names["secret"] = [new("secret", "customer_cards", "table")];
        s.FailSchema = "secret";
        s.Databases.AddRange(["master", "Shop"]);
        var items = await RunAsync(Request("customer", [new SearchTarget("c1")]), _ => s);
        Assert.All(items.OfType<SearchHit>(), h => Assert.Equal("Shop", h.Database)); // master is a system database
        var err = Assert.Single(items.OfType<SearchError>());
        Assert.Equal(("secret", "Shop"), (err.Schema, err.Database));
        Assert.Contains("permission denied", err.Message);
        Assert.IsType<SearchDone>(items[^1]);
    }

    [Fact]
    public async Task OneConnectionFailing_TheOthersStillReport()
    {
        var items = await RunAsync(Request("customer", [new SearchTarget("bad"), new SearchTarget("c1", Schema: "main")]),
            id => id == "bad" ? throw new InvalidOperationException("login failed") : Shop());
        Assert.Contains(items, i => i is SearchError { ConnectionId: "bad" } e && e.Message.Contains("login failed"));
        Assert.Contains(items, i => i is SearchHit { ConnectionId: "c1" });
        Assert.Equal(2, Assert.IsType<SearchDone>(items[^1]).Connections);
    }

    [Fact]
    public async Task HitLimit_StopsTheSearch_Truncated()
    {
        var items = await RunAsync(Request("customer", [new SearchTarget("c1", Schema: "main")], maxHits: 3), _ => Shop());
        Assert.Equal(3, items.OfType<SearchHit>().Count());
        var done = Assert.IsType<SearchDone>(items[^1]);
        Assert.True(done.Truncated);
        Assert.Equal(3, done.Hits);
    }

    [Fact]
    public async Task Data_ReadsTextColumnsWithTheKey_AndNeedsASchema()
    {
        var s = Shop();
        s.Schemas["main"] = new SchemaCatalog(null, "main",
        [
            new CatalogObject
            {
                Type = "table", Name = "customers", Schema = "main", PrimaryKey = ["id"],
                Columns = [new("id", "INTEGER", false, true), new("name", "TEXT", true, false), new("photo", "BLOB", true, false)],
            },
            new CatalogObject { Type = "view", Name = "customer_orders", Schema = "main", Columns = [new("name", "TEXT", true, false)] },
        ]);
        s.Rows["customers"] = [[7L, "Ann the Customer"], [8L, null]];
        var req = Request("customer", [new SearchTarget("c1", Schema: "main")], data: true);
        var items = await RunAsync(new SearchRequest { Matcher = req.Matcher, Targets = req.Targets, Names = false, Columns = false, Code = false, Data = true }, _ => s);
        var hit = Assert.Single(items.OfType<SearchHit>());
        Assert.Equal(("data", "customers", "name", "Ann the Customer"), (hit.Match, hit.Object.Name, hit.Column, hit.Text));
        Assert.Equal([new SearchKeyValue("id", 7L)], hit.Key);
        Assert.Single(s.Queries); // tables only (not the view), one query
        Assert.Contains(items, i => i is SearchProgress { Phase: "data", Table: "customers" });

        var unscoped = await RunAsync(new SearchRequest { Matcher = req.Matcher, Targets = [new SearchTarget("c1")], Names = false, Columns = false, Code = false, Data = true }, _ => Shop());
        Assert.Contains(unscoped, i => i is SearchError { Notice: true });
        Assert.DoesNotContain(unscoped, i => i is SearchHit);
    }

    [Fact]
    public async Task Cancel_StopsWithoutADoneItem()
    {
        var s = Shop();
        s.Block = new TaskCompletionSource();
        using var cts = new CancellationTokenSource();
        var items = new List<SearchItem>();
        var service = new DatabaseSearchService((_, _) => Task.FromResult<IDatabaseSearcher>(s));
        var run = service.RunAsync(Request("customer", [new SearchTarget("c1", Schema: "main")]), i => { lock (items) items.Add(i); }, cts.Token);
        await Task.Delay(50);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        Assert.DoesNotContain(items, i => i is SearchDone);
        Assert.True(s.Disposed);
    }

    [Fact]
    public void Items_SerializeWithTheirKind()
    {
        SearchItem hit = new SearchHit("c1", null, "main", new SearchObject("t", "table"), "data", "x", [[0, 1]], Column: "a", Key: [new("id", 1L)]);
        var json = JsonSerializer.Serialize(hit, hit.GetType(), CoreJson.Options);
        Assert.Contains("\"kind\":\"hit\"", json);
        Assert.Contains("\"ranges\":[[0,1]]", json);
        Assert.Contains("\"key\":[{\"column\":\"id\",\"value\":1}]", json);
        Assert.Contains("\"kind\":\"done\"", JsonSerializer.Serialize(new SearchDone(1, false, 2, 1), CoreJson.Options));
    }

    [Fact]
    public void WireKey_AndTextOf()
    {
        Assert.Equal(5L, DatabaseSearchService.WireKey(5));
        Assert.Equal(12L, DatabaseSearchService.WireKey(12m));
        Assert.Equal("12.5", DatabaseSearchService.WireKey(12.5m));
        Assert.Equal("9007199254740993", DatabaseSearchService.WireKey(9_007_199_254_740_993L));
        Assert.Null(DatabaseSearchService.WireKey(DBNull.Value));
        Assert.Null(DatabaseSearchService.WireKey(new byte[] { 1 }));
        Assert.Equal("2026-01-02 03:04:05", DatabaseSearchService.WireKey(new DateTime(2026, 1, 2, 3, 4, 5)));
        Assert.Null(DatabaseSearchService.TextOf(new byte[] { 1 }));
        Assert.Equal("1.5", DatabaseSearchService.TextOf(1.5));
    }
}
