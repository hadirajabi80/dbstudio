using System.Diagnostics;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Providers.Conformance;

namespace DbStudio.Providers.ClickHouse.Tests;

/// <summary>Session behaviour against <see cref="FakeClickHouse"/> (no Docker): splitting, query ids, cancel + KILL, summaries, USE.</summary>
public sealed class ChFakeServerTests
{
    private static async Task<(ClickHouseProvider Provider, FakeClickHouse Fake, IDbSession Session)> OpenAsync(Action<FakeClickHouse>? setup = null)
    {
        var fake = new FakeClickHouse();
        setup?.Invoke(fake);
        var provider = new ClickHouseProvider { Handler = fake };
        var session = await provider.OpenSessionAsync(FakeClickHouse.Profile(), "pw", new SessionOptions("s1", null, TransactionMode.Auto, false), CancellationToken.None);
        return (provider, fake, session);
    }

    private static ExecuteRequest Req(string sql, int maxRows = 100, IReadOnlyList<QueryParam>? ps = null) =>
        new([new SqlBatch(sql, 1, 1)], maxRows, true, false, "script", ps);

    [Fact]
    public async Task Batch_IsSplit_IntoOneRequestPerStatement_WithOwnQueryIdsAndTheSession()
    {
        var (_, fake, session) = await OpenAsync(f => f.Route = (r, _) => Task.FromResult<HttpResponseMessage?>(
            r.Query.StartsWith("SELECT 'x'", StringComparison.Ordinal) ? FakeClickHouse.Rows(r, ["b"], [["x"]]) :
            r.Query.StartsWith("SELECT 1", StringComparison.Ordinal) ? FakeClickHouse.Rows(r, ["a"], [["1"]]) : null));
        await using var _ = session;
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(Req("SELECT 1 AS a; -- c\nSELECT 'x' AS b;"), sink, CancellationToken.None);
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        Assert.Equal(2, sink.ResultSets.Count);
        var sent = fake.Requests.Where(r => !r.Query.Contains("version()")).ToList();
        Assert.Equal(["SELECT 1 AS a", "SELECT 'x' AS b"], sent.Select(r => r.Query.Trim()));
        Assert.All(sent, r => Assert.StartsWith("rowlit-", r.SessionId));
        Assert.Equal(2, sent.Select(r => r.QueryId).Distinct().Count());
    }

    [Fact]
    public async Task Insert_ReportsWrittenRows_FromTheSummaryHeader()
    {
        var (_, _, session) = await OpenAsync(f => f.Route = (r, _) => Task.FromResult<HttpResponseMessage?>(
            r.Query.StartsWith("INSERT", StringComparison.Ordinal)
                ? FakeClickHouse.Empty(r, """{"read_rows":"3","written_rows":"3","written_bytes":"12","result_rows":"3","elapsed_ns":"1"}""") : null));
        await using var _ = session;
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(Req("INSERT INTO t VALUES (1), (2), (3)"), sink, CancellationToken.None);
        Assert.Equal(ExecutionStatus.Ok, summary.Status);
        var a = Assert.Single(sink.Affected);
        Assert.Equal(3, a.Count);
        Assert.Equal("INSERT", a.StatementKind);
        Assert.Equal(3, summary.RowsAffected);
    }

    [Fact]
    public async Task Use_SwitchesTheDatabaseOfLaterRequests()
    {
        var (_, fake, session) = await OpenAsync();
        await using var _ = session;
        var sink = new RecordingSink();
        await session.ExecuteAsync(Req("USE analytics; SELECT 1"), sink, CancellationToken.None);
        Assert.Equal("analytics", session.CurrentDatabase);
        var last = fake.Requests.Last();
        Assert.Equal("analytics", last.Database);
    }

    [Fact]
    public async Task Cancel_AbortsTheRequest_AndKillsTheQueryOnASideConnection()
    {
        var running = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var (_, fake, session) = await OpenAsync(f => f.Route = async (r, ct) =>
        {
            if (r.Query.Contains("numbers_mt", StringComparison.Ordinal))
            {
                running.TrySetResult(r.QueryId!);
                await Task.Delay(Timeout.Infinite, ct);
            }
            return null;
        });
        await using var _ = session;
        var sink = new RecordingSink();
        var exec = session.ExecuteAsync(Req("SELECT sum(number) FROM numbers_mt(1000000000000)"), sink, CancellationToken.None);
        var queryId = await running.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var sw = Stopwatch.StartNew();
        session.Cancel();
        var summary = await exec.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(ExecutionStatus.Cancelled, summary.Status);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
        var kill = Assert.Single(fake.Requests, r => r.Query.StartsWith("KILL QUERY", StringComparison.Ordinal));
        Assert.Equal($"KILL QUERY WHERE query_id = '{queryId}' SYNC", kill.Query.Trim());
        Assert.Null(kill.SessionId); // outside the HTTP session (which the killed query still holds)
        Assert.Equal(SessionState.Idle, session.State);
    }

    [Fact]
    public async Task ServerError_MapsCodePositionAndCleanMessage()
    {
        var (_, _, session) = await OpenAsync(f => f.Route = (r, _) => Task.FromResult<HttpResponseMessage?>(
            r.Query.StartsWith("SELEC", StringComparison.Ordinal) && !r.Query.StartsWith("SELECT", StringComparison.Ordinal)
                ? FakeClickHouse.Error("Syntax error: failed at position 8 ('FROM'): FROM t. Expected one of: SELECT query, WITH. (SYNTAX_ERROR)") : null));
        await using var _ = session;
        var sink = new RecordingSink();
        await session.ExecuteAsync(new ExecuteRequest([new SqlBatch("SELECT 1;\nSELEC 1 FROM t", 5, 1)], 10, false, false, "script"), sink, CancellationToken.None);
        var error = Assert.Single(sink.Errors).Error;
        Assert.Equal("62", error.Code);
        Assert.Equal(6, error.Line);
        Assert.Equal(8, error.Col);
        Assert.DoesNotContain("Expected one of", error.Message);
        Assert.StartsWith("Syntax error", error.Message);
        Assert.Contains("Expected one of", error.Detail);
    }

    [Fact]
    public async Task Params_AreRewrittenToServerParameters()
    {
        var (_, fake, session) = await OpenAsync();
        await using var _ = session;
        var sink = new RecordingSink();
        var ps = new List<QueryParam> { new("id", ParamKinds.Int, System.Text.Json.Nodes.JsonValue.Create(7)), new("n", ParamKinds.String, System.Text.Json.Nodes.JsonValue.Create("o'k")) };
        await session.ExecuteAsync(Req("SELECT * FROM t WHERE id = :id AND name = @n", ps: ps), sink, CancellationToken.None);
        var sent = fake.Requests.Last();
        Assert.Equal("SELECT * FROM t WHERE id = {id:Int64} AND name = {n:String}", sent.Query.Trim());
        Assert.Contains("param_id=7", sent.Uri.Query);
    }

    [Fact]
    public async Task ManualMode_IsNotSupported()
    {
        var (_, _, session) = await OpenAsync();
        await using var _ = session;
        var ex = await Assert.ThrowsAsync<DbStudio.Core.Services.EngineException>(() => session.SetTransactionModeAsync(TransactionMode.Manual, CancellationToken.None));
        Assert.Equal("NOT_SUPPORTED", ex.Code);
        Assert.Equal(TransactionMode.Auto, session.TxMode);
    }

    [Fact]
    public async Task Mutation_ReportsTheSubmittedMutation()
    {
        var (_, _, session) = await OpenAsync(f => f.Route = (r, _) => Task.FromResult<HttpResponseMessage?>(
            r.Query.Contains("system.mutations", StringComparison.Ordinal)
                ? FakeClickHouse.Rows(r, ["mutation_id", "command", "is_done", "parts_to_do", "latest_fail_reason"], [["mutation_7.txt", "UPDATE v = 'z' WHERE id = 1", "0", "2", ""]])
                : null));
        await using var _ = session;
        var sink = new RecordingSink();
        await session.ExecuteAsync(Req("ALTER TABLE shop.t UPDATE v = 'z' WHERE id = 1"), sink, CancellationToken.None);
        Assert.True(sink.Messages.Any(m => m.Text.Contains("mutation_7.txt", StringComparison.Ordinal) && m.Text.Contains("submitted", StringComparison.Ordinal)), sink.Describe());
    }
}
