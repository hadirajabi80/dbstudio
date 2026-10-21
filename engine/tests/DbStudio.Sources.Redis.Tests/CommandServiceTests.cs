using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class CommandServiceTests
{
    private readonly CommandService _commands = new();

    private Task<RedisCommandsResponse> Raw(RedisClient c, params string[] lines) => Raw(c, 0, lines);

    private Task<RedisCommandsResponse> Raw(RedisClient c, int db, params string[] lines) =>
        _commands.ExecuteAsync(c, new RedisCommandsRequest(db, null, lines), CancellationToken.None);

    [Fact]
    public async Task Runs_raw_lines_with_typed_replies()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "SET k \"a b\"", "GET k", "INCR n", "GET missing", "RPUSH l x y", "LRANGE l 0 -1", "PING");
        Assert.Equal(["simple", "bulk", "int", "null", "int", "array", "simple"], r.Results.Select(x => x.Type));
        Assert.Equal("OK", r.Results[0].Value);
        Assert.Equal("a b", r.Results[1].Value);
        Assert.Equal(1L, r.Results[2].Value);
        Assert.Null(r.Results[3].Value);
        Assert.Equal(new object?[] { "x", "y" }, ((List<object?>)r.Results[5].Value!).ToArray());
        Assert.All(r.Results, x => Assert.True(x.Ok));
    }

    [Fact]
    public async Task Server_errors_are_error_results_not_failures()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "SADD s a", "GET s", "BOGUS 1", "GET s");
        Assert.True(r.Results[0].Ok);
        Assert.False(r.Results[1].Ok);
        Assert.Equal("error", r.Results[1].Type);
        Assert.StartsWith("WRONGTYPE", (string)r.Results[1].Value!);
        Assert.StartsWith("ERR unknown command", (string)r.Results[2].Value!);
        Assert.Equal(4, r.Results.Count);
    }

    [Fact]
    public async Task Quoting_errors_are_reported_per_line()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "SET k \"unterminated", "PING");
        Assert.False(r.Results[0].Ok);
        Assert.Contains("Invalid argument", (string)r.Results[0].Value!);
        Assert.True(r.Results[1].Ok);
    }

    [Theory]
    [InlineData("MONITOR", "Monitor")]
    [InlineData("SUBSCRIBE news", "Pub/Sub")]
    [InlineData("PSUBSCRIBE n*", "Pub/Sub")]
    [InlineData("SYNC", null)]
    [InlineData("PSYNC ? -1", null)]
    [InlineData("QUIT", "shared connection")]
    [InlineData("SHUTDOWN NOSAVE", null)]
    [InlineData("AUTH x", "shared connection")]
    [InlineData("CLIENT SETNAME evil", "shared connection")]
    public async Task Blocked_commands_are_refused_with_a_hint(string line, string? hint)
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var ex = await Assert.ThrowsAsync<EngineException>(() => Raw(c, "SET a 1", line));
        Assert.Equal(400, ex.Status);
        if (hint is not null) Assert.Contains(hint, ex.Message);
        // nothing of the batch ran
        Assert.DoesNotContain("SET", h.Server.Received);
    }

    [Fact]
    public async Task Select_is_tracked_within_the_batch_and_returned()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "SET where zero", "SELECT 2", "SET where two", "GET where");
        Assert.Equal(2, r.Db);
        Assert.Equal("two", r.Results[3].Value);
        var r0 = await Raw(c, 0, "GET where");
        Assert.Equal("zero", r0.Results[0].Value);
        var bad = await Raw(c, "SELECT 99");
        Assert.False(bad.Results[0].Ok);
        Assert.Equal(0, bad.Db);
    }

    [Fact]
    public async Task Request_db_is_used()
    {
        await using var h = await RedisHarness.StartAsync(configure: s => s.SeedString(5, "k5", "five"));
        var c = await h.ClientAsync();
        Assert.Equal("five", (await Raw(c, 5, "GET k5")).Results[0].Value);
    }

    [Fact]
    public async Task Read_only_allows_read_commands_only()
    {
        await using var h = await RedisHarness.StartAsync(readOnly: true, configure: s => s.SeedString(0, "k", "v"));
        var c = await h.ClientAsync();
        var r = await Raw(c, "GET k", "TTL k", "SCAN 0", "INFO server", "CONFIG GET maxmemory", "SELECT 1", "DBSIZE");
        Assert.All(r.Results, x => Assert.True(x.Ok, x.Value?.ToString()));
        foreach (var w in new[] { "SET k x", "DEL k", "FLUSHDB", "CONFIG SET maxmemory 1", "EVAL \"return 1\" 0", "PUBLISH ch hi", "UNKNOWNCMD", "XGROUP CREATE s g $" })
        {
            var ex = await Assert.ThrowsAsync<EngineException>(() => Raw(c, "GET k", w));
            Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
        }
        Assert.Equal("v", (await Raw(c, "GET k")).Results[0].Value);
    }

    [Fact]
    public async Task Transactions_run_on_a_dedicated_connection()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "MULTI", "SET t 1", "INCR t", "EXEC");
        Assert.Equal("OK", r.Results[0].Value);
        Assert.Equal("QUEUED", r.Results[1].Value);
        var exec = (List<object?>)r.Results[3].Value!;
        Assert.Equal(new object?[] { "OK", 2L }, exec.ToArray());
        Assert.Equal("2", (await Raw(c, "GET t")).Results[0].Value);
    }

    [Fact]
    public async Task Blocking_commands_do_not_stall_the_shared_connection()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var blocking = Raw(c, "BLPOP jobs 5");
        await Task.Delay(200);
        // the shared multiplexer still answers while BLPOP waits on its own connection
        var push = await Raw(c, "RPUSH jobs work");
        Assert.Equal(1L, push.Results[0].Value);
        var r = await blocking;
        Assert.Equal(new object?[] { "jobs", "work" }, ((List<object?>)r.Results[0].Value!).ToArray());
    }

    [Fact]
    public async Task Parsed_commands_are_accepted_too()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await _commands.ExecuteAsync(c, new RedisCommandsRequest(0, [["SET", "x y", "1 2"], ["GET", "x y"]], null), CancellationToken.None);
        Assert.Equal("1 2", r.Results[1].Value);
    }

    [Fact]
    public async Task Validation_of_the_request()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        await Assert.ThrowsAsync<EngineException>(() => _commands.ExecuteAsync(c, new RedisCommandsRequest(0, null, null), CancellationToken.None));
        await Assert.ThrowsAsync<EngineException>(() => Raw(c, Enumerable.Repeat("PING", CommandService.MaxCommands + 1).ToArray()));
        var empty = await Raw(c, "");
        Assert.False(empty.Results[0].Ok);
    }

    [Fact]
    public async Task Binary_replies_are_escaped_like_redis_cli()
    {
        await using var h = await RedisHarness.StartAsync();
        var c = await h.ClientAsync();
        var r = await Raw(c, "SET b \"\\x00\\xffok\"", "GET b");
        Assert.Equal("\0\\xffok", r.Results[1].Value);
    }
}
