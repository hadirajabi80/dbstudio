using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Redis.Services;

namespace DbStudio.Sources.Redis.Tests;

public sealed class ValueServiceTests
{
    private readonly ValueService _values = new();

    private static async Task<(RedisHarness H, RedisClient C)> StartAsync(bool readOnly = false)
    {
        var h = await RedisHarness.StartAsync(readOnly: readOnly);
        var c = await h.ClientAsync();
        await Seed.BasicAsync(c);
        return (h, c);
    }

    [Fact]
    public async Task String_value_has_header_and_json_detection()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "config:json", new RedisKeyQuery()));
        Assert.Equal("string", v.Type);
        Assert.True(v.IsJson);
        Assert.Equal("utf8", v.Encoding);
        Assert.Equal("{\"a\":1,\"b\":[1,2]}", v.Value);
        Assert.Equal(-1, v.Ttl);
        Assert.Equal("embstr", v.ObjectEncoding);
        Assert.NotNull(v.Memory);
        var plain = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "greeting", new RedisKeyQuery()));
        Assert.False(plain.IsJson);
    }

    [Fact]
    public async Task Binary_string_is_returned_as_hex()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        h.Server.SeedBytes(0, "bin", [0x00, 0xff, 0x10, 0x41]);
        var v = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "bin", new RedisKeyQuery()));
        Assert.Equal("hex", v.Encoding);
        Assert.Equal("00ff1041", v.Value);
    }

    [Fact]
    public async Task Strings_over_1_mb_are_truncated()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        h.Server.SeedString(0, "big", new string('x', ValueService.StringLimit + 10));
        var v = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "big", new RedisKeyQuery()));
        var t = Assert.IsType<TruncatedText>(v.Value);
        Assert.Equal(ValueService.StringLimit + 10, t.Len);
        Assert.Equal(ValueService.StringLimit, t.Trunc.Length);
        var json = JsonSerializer.Serialize<object>(v, CoreJson.Options);
        Assert.Contains("\"$trunc\"", json);
    }

    [Fact]
    public async Task Missing_key_is_not_found()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var ex = await Assert.ThrowsAsync<EngineException>(() => _values.GetAsync(c, 0, "nope", new RedisKeyQuery()));
        Assert.Equal(404, ex.Status);
    }

    [Fact]
    public async Task Set_string_keeps_the_ttl()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.SetTtlAsync(c, 0, "greeting", new RedisTtlRequest(500));
        await _values.SetStringAsync(c, 0, "greeting", new RedisSetStringRequest("bonjour"));
        var v = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "greeting", new RedisKeyQuery()));
        Assert.Equal("bonjour", v.Value);
        Assert.InRange(v.Ttl, 490, 500);
    }

    [Fact]
    public async Task Hash_reads_pages_filters_and_edits()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisHashValue>(await _values.GetAsync(c, 0, "user:1001:profile", new RedisKeyQuery()));
        Assert.Equal(3, v.Length);
        Assert.Equal("Alice", v.Fields.Single(f => f.Field == "name").Value);
        var filtered = Assert.IsType<RedisHashValue>(await _values.GetAsync(c, 0, "user:1001:profile", new RedisKeyQuery(Field: "e*")));
        Assert.Equal("email", Assert.Single(filtered.Fields).Field);
        await _values.EditHashAsync(c, 0, "user:1001:profile", new RedisHashEditRequest(new() { ["tier"] = "platinum", ["age"] = "33" }, ["email"]));
        var after = Assert.IsType<RedisHashValue>(await _values.GetAsync(c, 0, "user:1001:profile", new RedisKeyQuery()));
        Assert.Equal(3, after.Length);
        Assert.Equal("platinum", after.Fields.Single(f => f.Field == "tier").Value);
        Assert.DoesNotContain(after.Fields, f => f.Field == "email");
    }

    [Fact]
    public async Task Hash_paging_returns_a_cursor()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.EditHashAsync(c, 0, "big:hash", new RedisHashEditRequest(Enumerable.Range(0, 450).ToDictionary(i => $"f{i}", i => $"v{i}"), null));
        var page1 = Assert.IsType<RedisHashValue>(await _values.GetAsync(c, 0, "big:hash", new RedisKeyQuery()));
        Assert.Equal(200, page1.Fields.Count);
        Assert.NotEqual("0", page1.Cursor);
        var page2 = Assert.IsType<RedisHashValue>(await _values.GetAsync(c, 0, "big:hash", new RedisKeyQuery(Cursor: page1.Cursor)));
        Assert.Equal(200, page2.Fields.Count);
        Assert.Empty(page1.Fields.Select(f => f.Field).Intersect(page2.Fields.Select(f => f.Field)));
    }

    [Fact]
    public async Task List_reads_ranges_and_edits()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisListValue>(await _values.GetAsync(c, 0, "queue:jobs", new RedisKeyQuery()));
        Assert.Equal(3, v.Length);
        Assert.Equal(["j1", "j2", "j3"], v.Items.Select(i => i.Value));
        Assert.Equal([0L, 1L, 2L], v.Items.Select(i => i.Index));
        await _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(new RedisListPush("left", ["j0"]), null, null));
        await _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(new RedisListPush("right", ["j4"]), null, null));
        await _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(null, new RedisListSetIndex(2, "J2"), null));
        await _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(null, null, new RedisListRemove("j3", 1)));
        var after = Assert.IsType<RedisListValue>(await _values.GetAsync(c, 0, "queue:jobs", new RedisKeyQuery(Start: "1", Stop: "3")));
        Assert.Equal(4, after.Length);
        Assert.Equal(["j1", "J2", "j4"], after.Items.Select(i => i.Value));
        Assert.Equal(1, after.Start);
    }

    [Fact]
    public async Task List_edit_requires_exactly_one_operation()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await Assert.ThrowsAsync<EngineException>(() => _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(null, null, null)));
        await Assert.ThrowsAsync<EngineException>(() => _values.EditListAsync(c, 0, "queue:jobs",
            new RedisListEditRequest(new RedisListPush("up", ["x"]), null, null)));
    }

    [Fact]
    public async Task Set_reads_and_edits()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisSetValue>(await _values.GetAsync(c, 0, "tags", new RedisKeyQuery()));
        Assert.Equal(3, v.Length);
        Assert.Equal(["blue", "green", "red"], v.Members.Order());
        await _values.EditSetAsync(c, 0, "tags", new RedisSetEditRequest(["yellow"], ["red"]));
        var after = Assert.IsType<RedisSetValue>(await _values.GetAsync(c, 0, "tags", new RedisKeyQuery(Field: "*e*")));
        Assert.Equal(["blue", "green", "yellow"], after.Members.Order());
    }

    [Fact]
    public async Task Zset_is_sorted_by_score_and_edits_round_trip()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisZsetValue>(await _values.GetAsync(c, 0, "leaderboard", new RedisKeyQuery()));
        Assert.Equal(["alice", "bob", "carol"], v.Members.Select(m => m.Member));
        Assert.Equal("0", v.Cursor);
        await _values.EditZsetAsync(c, 0, "leaderboard", new RedisZsetEditRequest([new RedisZsetMember("dave", 5.5), new RedisZsetMember("bob", 99)], ["carol"]));
        var after = Assert.IsType<RedisZsetValue>(await _values.GetAsync(c, 0, "leaderboard", new RedisKeyQuery()));
        Assert.Equal(["dave", "alice", "bob"], after.Members.Select(m => m.Member));
        Assert.Equal(5.5, after.Members[0].Score);
    }

    [Fact]
    public async Task Zset_rank_paging_and_infinite_scores()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.EditZsetAsync(c, 0, "z", new RedisZsetEditRequest(Enumerable.Range(0, 250).Select(i => new RedisZsetMember($"m{i}", i)).ToList(), null));
        await c.Db(0).ExecuteAsync("ZADD", "z", "+inf", "top");
        var p1 = Assert.IsType<RedisZsetValue>(await _values.GetAsync(c, 0, "z", new RedisKeyQuery()));
        Assert.Equal(200, p1.Members.Count);
        Assert.Equal("i:200", p1.Cursor);
        var p2 = Assert.IsType<RedisZsetValue>(await _values.GetAsync(c, 0, "z", new RedisKeyQuery(Cursor: p1.Cursor)));
        Assert.Equal(51, p2.Members.Count);
        Assert.Equal("top", p2.Members[^1].Member);
        Assert.Equal(double.MaxValue, p2.Members[^1].Score);
        Assert.Equal("0", p2.Cursor);
        JsonSerializer.Serialize<object>(p2, CoreJson.Options); // no infinity in JSON
    }

    [Fact]
    public async Task Stream_reads_newest_first_with_groups_and_paging()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(null, null, null, null, new RedisStreamGroupCreate("workers", "0"), null));
        await c.Db(0).ExecuteAsync("XREADGROUP", "GROUP", "workers", "w1", "COUNT", "2", "STREAMS", "events", ">");
        var v = Assert.IsType<RedisStreamValue>(await _values.GetAsync(c, 0, "events", new RedisKeyQuery(Count: 2)));
        Assert.Equal(["3-0", "2-0"], v.Entries.Select(e => e.Id));
        Assert.Equal("login", v.Entries[0].Fields["type"]);
        Assert.Equal(3, v.Length);
        Assert.Equal("1-0", v.FirstId);
        Assert.Equal("3-0", v.LastId);
        var g = Assert.Single(v.Groups);
        Assert.Equal("workers", g.Name);
        Assert.Equal(2, g.Pending);
        Assert.Equal(1, g.Consumers);
        Assert.Equal(1, g.Lag);
        var older = Assert.IsType<RedisStreamValue>(await _values.GetAsync(c, 0, "events", new RedisKeyQuery(Count: 2, Stop: "(2-0")));
        Assert.Equal(["1-0"], older.Entries.Select(e => e.Id));
    }

    [Fact]
    public async Task Stream_add_delete_ack_and_group_lifecycle()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var id = await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(new() { ["type"] = "purchase" }, null, null, null, null, null));
        Assert.NotNull(id);
        await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(null, null, ["1-0"], null, null, null));
        await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(null, null, null, null, new RedisStreamGroupCreate("g", "0"), null));
        await c.Db(0).ExecuteAsync("XREADGROUP", "GROUP", "g", "alice", "STREAMS", "events", ">");
        var detail = await _values.StreamGroupAsync(c, 0, "events", "g");
        Assert.Equal("alice", Assert.Single(detail.Consumers).Name);
        Assert.Equal(3, detail.Pending.Count);
        await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(null, null, null, new RedisStreamAck("g", ["2-0"]), null, null));
        Assert.Equal(2, (await _values.StreamGroupAsync(c, 0, "events", "g")).Pending.Count);
        await _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(null, null, null, null, null, "g"));
        var v = Assert.IsType<RedisStreamValue>(await _values.GetAsync(c, 0, "events", new RedisKeyQuery()));
        Assert.Empty(v.Groups);
        Assert.Equal(3, v.Length);
        Assert.Equal(id, v.Entries[0].Id);
    }

    [Theory]
    [InlineData("5-3", "5-2")]
    [InlineData("5-0", "4-18446744073709551615")]
    [InlineData("0-0", null)]
    public void Previous_stream_id(string id, string? expected) => Assert.Equal(expected, ValueService.PreviousId(id));

    [Fact]
    public async Task Rejson_reads_and_writes_paths()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var v = Assert.IsType<RedisJsonValue>(await _values.GetAsync(c, 0, "doc:1", new RedisKeyQuery()));
        Assert.Equal("rejson", v.Type);
        Assert.Equal("Widget", v.Json.GetProperty("name").GetString());
        await _values.SetJsonAsync(c, 0, "doc:1", new RedisJsonSetRequest("$.price", JsonDocument.Parse("12.25").RootElement));
        var after = Assert.IsType<RedisJsonValue>(await _values.GetAsync(c, 0, "doc:1", new RedisKeyQuery()));
        Assert.Equal(12.25, after.Json.GetProperty("price").GetDouble());
        await _values.SetJsonAsync(c, 0, "doc:1", new RedisJsonSetRequest(null, JsonDocument.Parse("{\"x\":true}").RootElement));
        var root = Assert.IsType<RedisJsonValue>(await _values.GetAsync(c, 0, "doc:1", new RedisKeyQuery()));
        Assert.True(root.Json.GetProperty("x").GetBoolean());
    }

    [Theory]
    [InlineData("string", null)]
    [InlineData("hash", null)]
    [InlineData("list", null)]
    [InlineData("set", "[\"a\",\"b\"]")]
    [InlineData("zset", "[{\"member\":\"a\",\"score\":1},{\"member\":\"b\",\"score\":2}]")]
    [InlineData("stream", null)]
    [InlineData("rejson", null)]
    public async Task Create_every_type_with_ttl(string type, string? members)
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var req = new RedisCreateKeyRequest("new:" + type, 0, 120, type, "value", new() { ["f"] = "v" }, ["a", "b"],
            members is null ? null : JsonDocument.Parse(members).RootElement, JsonDocument.Parse("{\"k\":1}").RootElement);
        await _values.CreateAsync(c, req);
        var v = await _values.GetAsync(c, 0, "new:" + type, new RedisKeyQuery());
        Assert.Equal(type, v.Type);
        Assert.InRange(v.Ttl, 110, 120);
    }

    [Fact]
    public async Task Create_refuses_existing_keys_and_bad_input()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var ex = await Assert.ThrowsAsync<EngineException>(() => _values.CreateAsync(c, new RedisCreateKeyRequest("greeting", 0, null, "string", "x", null, null, null, null)));
        Assert.Contains("already exists", ex.Message);
        await Assert.ThrowsAsync<EngineException>(() => _values.CreateAsync(c, new RedisCreateKeyRequest("h", 0, null, "hash", null, null, null, null, null)));
        await Assert.ThrowsAsync<EngineException>(() => _values.CreateAsync(c, new RedisCreateKeyRequest("t", 0, null, "teapot", null, null, null, null, null)));
        await Assert.ThrowsAsync<EngineException>(() => _values.CreateAsync(c, new RedisCreateKeyRequest("", 0, null, "string", "x", null, null, null, null)));
    }

    [Fact]
    public async Task Rename_with_and_without_overwrite()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.RenameAsync(c, 0, "greeting", new RedisRenameRequest("salutation", false));
        Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "salutation", new RedisKeyQuery()));
        var ex = await Assert.ThrowsAsync<EngineException>(() => _values.RenameAsync(c, 0, "salutation", new RedisRenameRequest("tags", false)));
        Assert.Contains("already exists", ex.Message);
        await _values.RenameAsync(c, 0, "salutation", new RedisRenameRequest("tags", true));
        Assert.Equal("string", (await _values.GetAsync(c, 0, "tags", new RedisKeyQuery())).Type);
        await Assert.ThrowsAsync<EngineException>(() => _values.RenameAsync(c, 0, "gone", new RedisRenameRequest("x", false)));
    }

    [Fact]
    public async Task Ttl_set_and_persist()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.SetTtlAsync(c, 0, "tags", new RedisTtlRequest(60));
        Assert.InRange((await _values.GetAsync(c, 0, "tags", new RedisKeyQuery())).Ttl, 55, 60);
        await _values.SetTtlAsync(c, 0, "tags", new RedisTtlRequest(null));
        Assert.Equal(-1, (await _values.GetAsync(c, 0, "tags", new RedisKeyQuery())).Ttl);
        await Assert.ThrowsAsync<EngineException>(() => _values.SetTtlAsync(c, 0, "tags", new RedisTtlRequest(0)));
        var gone = await Assert.ThrowsAsync<EngineException>(() => _values.SetTtlAsync(c, 0, "nope", new RedisTtlRequest(5)));
        Assert.Equal(404, gone.Status);
    }

    [Fact]
    public async Task Delete_unlinks_and_reports_missing_keys()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        await _values.DeleteAsync(c, 0, "tags");
        Assert.Contains("UNLINK", h.Server.Received);
        await Assert.ThrowsAsync<EngineException>(() => _values.GetAsync(c, 0, "tags", new RedisKeyQuery()));
        var ex = await Assert.ThrowsAsync<EngineException>(() => _values.DeleteAsync(c, 0, "tags"));
        Assert.Equal(404, ex.Status);
    }

    [Fact]
    public async Task Keys_with_unicode_and_spaces_round_trip()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        const string key = "café:ünï/code key";
        await _values.CreateAsync(c, new RedisCreateKeyRequest(key, 0, null, "string", "€", null, null, null, null));
        var v = Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, key, new RedisKeyQuery()));
        Assert.Equal("€", v.Value);
        Assert.Equal(Encoding.UTF8.GetByteCount("€"), v.Length);
    }

    [Fact]
    public async Task Read_only_connection_rejects_every_write_with_read_only()
    {
        var (h, c) = await StartAsync(readOnly: true);
        await using var _ = h;
        var writes = new Func<Task>[]
        {
            () => _values.SetStringAsync(c, 0, "greeting", new RedisSetStringRequest("x")),
            () => _values.EditHashAsync(c, 0, "user:1001:profile", new RedisHashEditRequest(new() { ["a"] = "b" }, null)),
            () => _values.EditListAsync(c, 0, "queue:jobs", new RedisListEditRequest(new RedisListPush("left", ["x"]), null, null)),
            () => _values.EditSetAsync(c, 0, "tags", new RedisSetEditRequest(["x"], null)),
            () => _values.EditZsetAsync(c, 0, "leaderboard", new RedisZsetEditRequest([new RedisZsetMember("x", 1)], null)),
            () => _values.EditStreamAsync(c, 0, "events", new RedisStreamEditRequest(new() { ["a"] = "b" }, null, null, null, null, null)),
            () => _values.SetJsonAsync(c, 0, "doc:1", new RedisJsonSetRequest("$", JsonDocument.Parse("1").RootElement)),
            () => _values.CreateAsync(c, new RedisCreateKeyRequest("n", 0, null, "string", "x", null, null, null, null)),
            () => _values.RenameAsync(c, 0, "greeting", new RedisRenameRequest("x", false)),
            () => _values.SetTtlAsync(c, 0, "greeting", new RedisTtlRequest(5)),
            () => _values.DeleteAsync(c, 0, "greeting"),
        };
        foreach (var w in writes)
        {
            var ex = await Assert.ThrowsAsync<EngineException>(w);
            Assert.Equal(ErrorCodes.ReadOnly, ex.Code);
            Assert.Contains("read-only", ex.Message);
        }
        // reads still work
        Assert.IsType<RedisStringValue>(await _values.GetAsync(c, 0, "greeting", new RedisKeyQuery()));
    }

    [Fact]
    public async Task Wrong_type_edits_report_the_server_error()
    {
        var (h, c) = await StartAsync();
        await using var _ = h;
        var ex = await Assert.ThrowsAsync<EngineException>(() => _values.EditHashAsync(c, 0, "tags", new RedisHashEditRequest(new() { ["a"] = "b" }, null)));
        Assert.Equal(ErrorCodes.ProviderError, ex.Code);
        Assert.StartsWith("WRONGTYPE", ex.Message);
    }
}
