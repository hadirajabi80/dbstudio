using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Conformance.M15;

/// <summary>
/// M1.5 conformance suite (docs/PLAN-M1.5.md WP-F acceptance) run by every provider test project: typed parameter
/// binds, describe vs. a real run, explain (estimated and actual), and the designer round trip
/// (create → GET table equals desired → alter → GET table equals desired). SQLite always runs; SQL Server and Oracle
/// are skipped when their Docker backends are unavailable.
/// </summary>
public abstract class M15ConformanceTests<TFixture>(TFixture fixture) : IClassFixture<TFixture> where TFixture : ProviderFixture
{
    protected TFixture Fixture { get; } = fixture;
    protected Dialect Dialect => Fixture.Dialect;

    protected abstract IDdlScripter Scripter { get; }
    protected abstract IDesignerDatabase Database { get; }
    protected abstract IPlanReader PlanReader { get; }

    /// <summary>Folds a model the way the provider stores it (Oracle upper-cases names, SQLite drops comments...).</summary>
    protected virtual TableModel Normalize(TableModel t, DdlScriptContext context) => t;

    protected virtual string IntType => Dialect switch { Dialect.TSql => "int", Dialect.PlSql => "NUMBER(10)", _ => "INTEGER" };
    protected virtual string TextType(int n) => Dialect switch { Dialect.TSql => $"nvarchar({n})", Dialect.PlSql => $"VARCHAR2({n})", _ => $"VARCHAR({n})" };
    protected virtual string MoneyType => Dialect switch { Dialect.TSql => "decimal(12,2)", Dialect.PlSql => "NUMBER(12,2)", _ => "NUMERIC(12,2)" };
    protected virtual string DateType => Dialect switch { Dialect.TSql => "date", Dialect.PlSql => "DATE", _ => "DATE" };
    protected string Bind(string name) => Dialect == Dialect.TSql ? "@" + name : ":" + name;
    protected string N(string name) => Dialect == Dialect.PlSql ? name.ToUpperInvariant() : name;

    protected void RequireAvailable() => Skip.IfNot(Fixture.IsAvailable, Fixture.SkipReason ?? "Provider not available.");

    protected static QueryParam P(string name, string kind, object? value, string? direction = null) =>
        new(name, kind, value is null ? null : JsonValue.Create(value), direction);

    protected static async Task<(ExecutionSummary Summary, RecordingSink Sink)> RunAsync(IDbSession session, IReadOnlyList<QueryParam>? ps, params string[] sql)
    {
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest(sql.Select(s => new SqlBatch(s, 1, 1)).ToList(), 1000, true, false, "statement", ps), sink, CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(60));
        return (summary, sink);
    }

    private static string Unique(string prefix) => prefix + Guid.NewGuid().ToString("N")[..8];

    // ------------------------------------------------------------------ parameters

    [SkippableFact]
    public async Task M15_Params_TypedBinds_InsertAndSelect()
    {
        RequireAvailable();
        var table = N(Unique("m15_p_"));
        await Fixture.RunBatchesAsync([Fixture.CreateScratchTableSql(table)]);
        try
        {
            await using var session = await Fixture.OpenSessionAsync();
            var (insert, insertSink) = await RunAsync(session, [P("id", "int", 7), P("val", "string", "it's \"quoted\"")],
                $"INSERT INTO {table} (id, val) VALUES ({Bind("id")}, {Bind("val")})");
            Assert.True(insert.Status == ExecutionStatus.Ok, string.Join("; ", insertSink.Errors.Select(e => e.Error.Message)));
            var (select, sink) = await RunAsync(session, [P("id", "int", "7")], $"SELECT val FROM {table} WHERE id = {Bind("id")}");
            Assert.Equal(ExecutionStatus.Ok, select.Status);
            Assert.Equal("it's \"quoted\"", sink.ResultSets.Single().Rows.Single()[0]);
            var (none, noneSink) = await RunAsync(session, [P("id", "int", 8)], $"SELECT val FROM {table} WHERE id = {Bind("id")}");
            Assert.Equal(ExecutionStatus.Ok, none.Status);
            Assert.Empty(noneSink.ResultSets.Single().Rows);
        }
        finally
        {
            await Fixture.RunBatchesAsync([Fixture.DropScratchTableSql(table)]);
        }
    }

    [SkippableFact]
    public async Task M15_Params_DecimalDateAndNull()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var (summary, sink) = await RunAsync(session, [P("d", "decimal", "12.345"), P("dt", "date", "2026-03-04"), P("n", "string", null)],
            $"SELECT {Bind("d")} AS d, {Bind("dt")} AS dt, CASE WHEN {Bind("n")} IS NULL THEN 1 ELSE 0 END AS is_null{Fixture.FromDual}");
        Assert.True(summary.Status == ExecutionStatus.Ok, string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
        var row = sink.ResultSets.Single().Rows.Single();
        Assert.Equal(12.345m, decimal.Parse(Convert.ToString(row[0], System.Globalization.CultureInfo.InvariantCulture)!, System.Globalization.CultureInfo.InvariantCulture));
        Assert.StartsWith("2026-03-04", Convert.ToString(row[1], System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal(1m, Convert.ToDecimal(row[2], System.Globalization.CultureInfo.InvariantCulture));
    }

    // ------------------------------------------------------------------ describe

    [SkippableFact]
    public async Task M15_Describe_MatchesARealRun_AndExecutesNothing()
    {
        RequireAvailable();
        var sql = $"SELECT {Fixture.N("Id")}, {Fixture.N("Name")}, {Fixture.N("Email")} FROM {Fixture.ShopSchemaQualifier}{Fixture.N("Customers")} WHERE {Fixture.N("Id")} > {Bind("min")}";
        await using var session = await Fixture.OpenSessionAsync();
        var ado = Assert.IsAssignableFrom<AdoSessionBase>(session);
        var described = await ado.DescribeAsync(sql, [P("min", "int", 0)], CancellationToken.None);
        var (_, sink) = await RunAsync(session, [P("min", "int", 0)], sql);
        var run = sink.ResultSets.Single().Columns;
        Assert.Equal(run.Select(c => (c.Name, c.Kind)), described.Select(c => (c.Name, c.Kind)));
        Assert.Equal(SessionState.Idle, session.State);
    }

    // ------------------------------------------------------------------ explain

    [SkippableFact]
    public async Task M15_Explain_Estimated_ReturnsAtLeastOneNode()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var sql = $"SELECT c.{Fixture.N("Name")}, o.{Fixture.N("Total")} FROM {Fixture.ShopSchemaQualifier}{Fixture.N("Customers")} c JOIN {Fixture.ShopSchemaQualifier}{Fixture.N("Orders")} o ON o.{Fixture.N("CustomerId")} = c.{Fixture.N("Id")} WHERE c.{Fixture.N("Id")} = {Bind("id")}";
        var sink = new RecordingSink();
        var outcome = await ExplainRunner.RunAsync((AdoSessionBase)session, PlanReader,
            new ExplainInput("x_" + Guid.NewGuid().ToString("N")[..20], sql, ExplainModes.Estimated, [P("id", "int", 1)]), sink, 100, false, CancellationToken.None);
        Assert.True(outcome.Status == ExecutionStatus.Ok, string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
        Assert.NotNull(outcome.Plan);
        Assert.NotEmpty(outcome.Plan!.Root.DescendantsAndSelf().Skip(1));
        Assert.Empty(sink.ResultSets);
        Assert.Empty(outcome.CleanupErrors);
        // The session is usable afterwards (no SHOWPLAN / statistics mode left on).
        var (after, afterSink) = await RunAsync(session, null, $"SELECT 1 AS one{Fixture.FromDual}");
        Assert.Equal(ExecutionStatus.Ok, after.Status);
        Assert.Equal("one", afterSink.ResultSets.Single().Columns[0].Name, ignoreCase: true);
    }

    [SkippableFact]
    public async Task M15_Explain_Actual_DeliversRows()
    {
        RequireAvailable();
        await using var session = await Fixture.OpenSessionAsync();
        var sql = $"SELECT {Fixture.N("Id")} FROM {Fixture.ShopSchemaQualifier}{Fixture.N("Customers")} WHERE {Fixture.N("Id")} <= 3 ORDER BY {Fixture.N("Id")}";
        var sink = new RecordingSink();
        var outcome = await ExplainRunner.RunAsync((AdoSessionBase)session, PlanReader,
            new ExplainInput("x_" + Guid.NewGuid().ToString("N")[..20], sql, ExplainModes.Actual), sink, 100, false, CancellationToken.None);
        Assert.True(outcome.Status == ExecutionStatus.Ok, string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
        Assert.Equal(1, outcome.ResultSets);
        Assert.Equal(3, sink.ResultSets.Single().Rows.Count);
        Assert.NotNull(outcome.Plan);
    }

    // ------------------------------------------------------------------ designer

    private async Task<(TableModel Read, DdlScriptContext Context)> ApplyAndReadAsync(TableModel? original, TableModel desired)
    {
        var schema = desired.Schema;
        var context = await Database.GetScriptContextAsync(Fixture.Profile, Fixture.Password, Fixture.Database, schema, original?.Name, CancellationToken.None);
        var script = Scripter.ScriptTable(original, desired, context);
        await Database.ApplyAsync(Fixture.Profile, Fixture.Password, new DdlApplyRequest(Fixture.Database, script.Statements.Select(s => s.Sql).ToList(), script.Transactional, schema), CancellationToken.None);
        var read = await Database.ReadTableAsync(Fixture.Profile, Fixture.Password, Fixture.Database, schema, desired.Name, CancellationToken.None);
        var diff = TableDiff.Compute(Normalize(read, context), Normalize(desired with { Schema = read.Schema }, context));
        Assert.True(diff.IsEmpty, "Round trip differs: " + string.Join("; ", diff.Changes.Select(c => $"{c.Kind} {c.Target} {c.Detail}")));
        return (read, context);
    }

    [SkippableFact]
    public async Task M15_Designer_CreateAlterRoundTrip()
    {
        RequireAvailable();
        var name = N(Unique("M15_T_"));
        var schema = Dialect == Dialect.Sqlite ? null : Fixture.ShopSchema;
        TableColumnModel C(string n, string type, bool nullable = true, string? def = null) => new() { Id = N(n), Name = N(n), Type = type, Nullable = nullable, Default = def };
        var create = new TableModel
        {
            Schema = schema,
            Name = name,
            Columns = [C("Id", IntType, false), C("Name", TextType(100), false), C("Amount", MoneyType, false, "0"), C("CreatedAt", DateType)],
            PrimaryKey = new PrimaryKeyModel { Columns = [N("Id")] },
            Indexes = [new IndexModel { Name = N(name + "_IX"), Columns = [new IndexColumnModel(N("Name"))] }],
            Checks = [new CheckModel { Name = N(name + "_CK"), Expression = $"{N("Amount")} >= 0" }],
        };
        try
        {
            var (read, _) = await ApplyAndReadAsync(null, create);
            await Fixture.RunBatchesAsync([$"INSERT INTO {(schema is null ? "" : schema + ".")}{name} ({N("Id")}, {N("Name")}, {N("Amount")}) VALUES (1, 'one', 5)"]);

            var altered = read with
            {
                Columns =
                [
                    .. read.Columns.Select(c => c.Name == N("Name") ? c with { Name = N("Title"), Type = TextType(200) } : c),
                    C("Note", TextType(50)) with { Id = "new_1" },
                ],
                Indexes = [.. read.Indexes.Select(i => i with { Columns = i.Columns.Select(c => c.Name == N("Name") ? c with { Name = N("Title") } : c).ToList() }), new IndexModel { Name = N(name + "_IX2"), Columns = [new IndexColumnModel(N("CreatedAt"), Desc: false)] }],
            };
            var (afterAlter, _) = await ApplyAndReadAsync(read, altered);
            Assert.Equal(N("Title"), afterAlter.Columns[1].Name);
            Assert.Equal("one", await Fixture.ScalarAsync($"SELECT {N("Title")} FROM {(schema is null ? "" : schema + ".")}{name}"));
        }
        finally
        {
            try { await Fixture.RunBatchesAsync([$"DROP TABLE {(schema is null ? "" : schema + ".")}{name}"]); } catch (InvalidOperationException) { }
        }
    }

    [SkippableFact]
    public async Task M15_Designer_ViewScript_Applies_AndReadsBack()
    {
        RequireAvailable();
        var schema = Dialect == Dialect.Sqlite ? null : Fixture.ShopSchema;
        var name = N(Unique("M15_V_"));
        var body = $"SELECT {Fixture.N("Id")}, {Fixture.N("Name")} FROM {Fixture.ShopSchemaQualifier}{Fixture.N("Customers")}";
        var context = await Database.GetScriptContextAsync(Fixture.Profile, Fixture.Password, Fixture.Database, schema, null, CancellationToken.None);
        var script = Scripter.ScriptView(new ViewDefinition(schema, name, null, body, new ViewOptions()), context);
        await Database.ApplyAsync(Fixture.Profile, Fixture.Password, new DdlApplyRequest(Fixture.Database, script.Statements.Select(s => s.Sql).ToList(), script.Transactional, schema), CancellationToken.None);
        try
        {
            var view = await Database.ReadViewAsync(Fixture.Profile, Fixture.Password, Fixture.Database, schema, name, CancellationToken.None);
            Assert.Equal(name, view.Name, ignoreCase: true);
            Assert.Contains(Fixture.N("Customers").ToUpperInvariant(), view.Body.ToUpperInvariant());
        }
        finally
        {
            try { await Fixture.RunBatchesAsync([$"DROP VIEW {(schema is null ? "" : schema + ".")}{name}"]); } catch (InvalidOperationException) { }
        }
    }

    [SkippableFact]
    public async Task M15_Designer_FailedApply_ReportsFailedIndex()
    {
        RequireAvailable();
        var schema = Dialect == Dialect.Sqlite ? null : Fixture.ShopSchema;
        var name = N(Unique("M15_F_"));
        var q = (schema is null ? "" : schema + ".") + name;
        var transactional = Scripter.GetTypes(DdlScriptContext.Default).Features.TransactionalDdl;
        try
        {
            var ex = await Assert.ThrowsAsync<DdlFailedException>(() => Database.ApplyAsync(Fixture.Profile, Fixture.Password, new DdlApplyRequest(Fixture.Database,
                [$"CREATE TABLE {q} (a {IntType})", $"CREATE TABLE {q} (a {IntType})"], transactional, schema), CancellationToken.None));
            Assert.Equal(1, ex.FailedIndex);
            Assert.Equal(1, ex.Executed);
            Assert.Equal(transactional, ex.RolledBack);
            var exists = await TableExistsAsync(schema, name);
            Assert.Equal(!transactional, exists); // rolled back (SQL Server, SQLite) or committed (Oracle)
        }
        finally
        {
            if (await TableExistsAsync(schema, name)) await Fixture.RunBatchesAsync([$"DROP TABLE {q}"]);
        }
    }

    private async Task<bool> TableExistsAsync(string? schema, string name)
    {
        try
        {
            await Database.ReadTableAsync(Fixture.Profile, Fixture.Password, Fixture.Database, schema, name, CancellationToken.None);
            return true;
        }
        catch (EngineException ex) when (ex.Status == 404)
        {
            return false;
        }
    }
}
