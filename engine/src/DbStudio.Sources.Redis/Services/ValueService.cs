using System.Globalization;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>Query of <c>GET /keys/{key}</c> (paging fields depend on the type).</summary>
public sealed record RedisKeyQuery(string? Cursor = null, int? Count = null, string? Field = null, string? Start = null, string? Stop = null);

/// <summary>
/// Typed key values and their edits (docs/PLAN-M2.md 5.3): string (1 MB cap, binary → hex, JSON detection), hash (HSCAN),
/// list (LRANGE pages), set (SSCAN), sorted set (ZRANGE by rank, ZSCAN when filtered), stream (XREVRANGE pages, groups,
/// consumers, pending), RedisJSON (JSON.GET/SET). Every mutation is READ_ONLY-guarded.
/// </summary>
public sealed class ValueService
{
    public const int StringLimit = 1024 * 1024;
    public const int DefaultPage = 200;
    public const int DefaultStreamPage = 100;

    // ------------------------------------------------------------------ read

    public async Task<RedisKeyValue> GetAsync(RedisClient c, int db, string key, RedisKeyQuery q)
    {
        var d = c.Db(db);
        var batch = d.CreateBatch();
        var typeTask = batch.ExecuteAsync("TYPE", (RedisKey)key);
        var ttlTask = batch.ExecuteAsync("TTL", (RedisKey)key);
        var encTask = batch.ExecuteAsync("OBJECT", "ENCODING", (RedisKey)key);
        batch.Execute();
        var type = Resp.WireType((string?)await RedisErrors.Guard(() => typeTask, "type").ConfigureAwait(false));
        if (type == "none") throw EngineException.NotFound($"Key '{key}'");
        var ttl = Resp.Long(await RedisErrors.Guard(() => ttlTask, "ttl").ConfigureAwait(false));
        string? encoding;
        try
        {
            encoding = (string?)await encTask.ConfigureAwait(false);
        }
        catch (RedisServerException)
        {
            encoding = null;
        }
        var memory = (await KeyBrowser.MemoryOfAsync(d, [key], c.Supports(4)).ConfigureAwait(false)).GetValueOrDefault(key);

        return type switch
        {
            "string" => await StringAsync(d, db, key, ttl, encoding, memory).ConfigureAwait(false),
            "hash" => await HashAsync(d, db, key, ttl, encoding, memory, q).ConfigureAwait(false),
            "list" => await ListAsync(d, db, key, ttl, encoding, memory, q).ConfigureAwait(false),
            "set" => await SetAsync(d, db, key, ttl, encoding, memory, q).ConfigureAwait(false),
            "zset" => await ZsetAsync(d, db, key, ttl, encoding, memory, q).ConfigureAwait(false),
            "stream" => await StreamAsync(c, d, db, key, ttl, encoding, memory, q).ConfigureAwait(false),
            "rejson" => await JsonAsync(d, db, key, ttl, encoding, memory).ConfigureAwait(false),
            _ => throw new EngineException(400, ErrorCodes.NotSupported, $"Key '{key}' has a module type DbStudio cannot display yet; use the Workbench."),
        };
    }

    private static async Task<RedisStringValue> StringAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory)
    {
        var len = Resp.Long(await Exec(d, "strlen", "STRLEN", (RedisKey)key).ConfigureAwait(false));
        var reply = len > StringLimit
            ? await Exec(d, "getrange", "GETRANGE", (RedisKey)key, 0, StringLimit - 1).ConfigureAwait(false)
            : await Exec(d, "get", "GET", (RedisKey)key).ConfigureAwait(false);
        var bytes = Resp.Bytes(reply) ?? [];
        var binary = RedisArgs.IsBinary(bytes);
        var text = binary ? Convert.ToHexString(bytes).ToLowerInvariant() : Encoding.UTF8.GetString(bytes);
        var isJson = !binary && len <= StringLimit && LooksLikeJson(text);
        object value = len > StringLimit ? new TruncatedText(text, len) : text;
        return new RedisStringValue(key, db, ttl, enc, memory, value, binary ? "hex" : "utf8", isJson, len);
    }

    internal static bool LooksLikeJson(string text)
    {
        var t = text.AsSpan().Trim();
        if (t.Length < 2 || !(t[0] == '{' && t[^1] == '}' || t[0] == '[' && t[^1] == ']')) return false;
        try
        {
            using var _ = JsonDocument.Parse(text);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int Page(int? count, int fallback, int max = 5000)
    {
        var n = count ?? fallback;
        if (n < 1 || n > max) throw EngineException.Validation($"count must be between 1 and {max}.", new { field = "count" });
        return n;
    }

    private static string Cursor(string? cursor)
    {
        var c = string.IsNullOrEmpty(cursor) ? "0" : cursor;
        if (!ulong.TryParse(c, NumberStyles.None, CultureInfo.InvariantCulture, out _))
            throw EngineException.Validation("cursor must be a SCAN cursor.", new { field = "cursor" });
        return c;
    }

    private static string? Match(string? field) => string.IsNullOrEmpty(field) ? null : field;

    private static async Task<RedisHashValue> HashAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory, RedisKeyQuery q)
    {
        var count = Page(q.Count, DefaultPage);
        var args = new List<object> { (RedisKey)key, Cursor(q.Cursor) };
        if (Match(q.Field) is { } m) { args.Add("MATCH"); args.Add(m); }
        args.Add("COUNT"); args.Add(count);
        var reply = Resp.Arr(await Exec(d, "hscan", "HSCAN", [.. args]).ConfigureAwait(false));
        var items = reply.Length > 1 ? Resp.Arr(reply[1]) : [];
        var fields = new List<RedisHashField>(items.Length / 2);
        for (var i = 0; i + 1 < items.Length; i += 2) fields.Add(new RedisHashField(Resp.Text(items[i]), Resp.Text(items[i + 1])));
        var len = Resp.Long(await Exec(d, "hlen", "HLEN", (RedisKey)key).ConfigureAwait(false));
        return new RedisHashValue(key, db, ttl, enc, memory, fields, (string?)reply[0] ?? "0", len);
    }

    private static long ParseIndex(string? s, long fallback, string field)
    {
        if (string.IsNullOrEmpty(s)) return fallback;
        if (!long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n))
            throw EngineException.Validation($"{field} must be an integer index.", new { field });
        return n;
    }

    private static async Task<RedisListValue> ListAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory, RedisKeyQuery q)
    {
        var start = ParseIndex(q.Start, 0, "start");
        var stop = ParseIndex(q.Stop, start + Page(q.Count, DefaultPage) - 1, "stop");
        if (stop - start >= 5000) throw EngineException.Validation("At most 5000 list items per page.", new { field = "stop" });
        var len = Resp.Long(await Exec(d, "llen", "LLEN", (RedisKey)key).ConfigureAwait(false));
        var items = Resp.Arr(await Exec(d, "lrange", "LRANGE", (RedisKey)key, start, stop).ConfigureAwait(false));
        var first = start < 0 ? Math.Max(0, len + start) : start;
        var list = items.Select((v, i) => new RedisListItem(first + i, Resp.Text(v))).ToList();
        return new RedisListValue(key, db, ttl, enc, memory, list, len, first, first + list.Count - 1);
    }

    private static async Task<RedisSetValue> SetAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory, RedisKeyQuery q)
    {
        var count = Page(q.Count, DefaultPage);
        var args = new List<object> { (RedisKey)key, Cursor(q.Cursor) };
        if (Match(q.Field) is { } m) { args.Add("MATCH"); args.Add(m); }
        args.Add("COUNT"); args.Add(count);
        var reply = Resp.Arr(await Exec(d, "sscan", "SSCAN", [.. args]).ConfigureAwait(false));
        var members = (reply.Length > 1 ? Resp.Arr(reply[1]) : []).Select(Resp.Text).ToList();
        var len = Resp.Long(await Exec(d, "scard", "SCARD", (RedisKey)key).ConfigureAwait(false));
        return new RedisSetValue(key, db, ttl, enc, memory, members, (string?)reply[0] ?? "0", len);
    }

    /// <summary>
    /// Unfiltered: ZRANGE by rank WITHSCORES (sorted by score; cursor <c>i:{rank}</c>). Filtered: ZSCAN MATCH (the UI
    /// sorts the page by score).
    /// </summary>
    private static async Task<RedisZsetValue> ZsetAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory, RedisKeyQuery q)
    {
        var count = Page(q.Count, DefaultPage);
        var len = Resp.Long(await Exec(d, "zcard", "ZCARD", (RedisKey)key).ConfigureAwait(false));
        var cursor = string.IsNullOrEmpty(q.Cursor) ? "0" : q.Cursor;
        var members = new List<RedisZsetMember>();
        string next;
        if (Match(q.Field) is null && (cursor == "0" || cursor.StartsWith("i:", StringComparison.Ordinal)))
        {
            var start = cursor == "0" ? 0 : ParseIndex(cursor[2..], 0, "cursor");
            var items = Resp.Arr(await Exec(d, "zrange", "ZRANGE", (RedisKey)key, start, start + count - 1, "WITHSCORES").ConfigureAwait(false));
            for (var i = 0; i + 1 < items.Length; i += 2) members.Add(new RedisZsetMember(Resp.Text(items[i]), Resp.Double(items[i + 1])));
            next = start + count < len ? $"i:{start + count}" : "0";
        }
        else
        {
            var args = new List<object> { (RedisKey)key, Cursor(cursor) };
            if (Match(q.Field) is { } m) { args.Add("MATCH"); args.Add(m); }
            args.Add("COUNT"); args.Add(count);
            var reply = Resp.Arr(await Exec(d, "zscan", "ZSCAN", [.. args]).ConfigureAwait(false));
            var items = reply.Length > 1 ? Resp.Arr(reply[1]) : [];
            for (var i = 0; i + 1 < items.Length; i += 2) members.Add(new RedisZsetMember(Resp.Text(items[i]), Resp.Double(items[i + 1])));
            members.Sort((a, b) => a.Score.CompareTo(b.Score));
            next = (string?)reply[0] ?? "0";
        }
        return new RedisZsetValue(key, db, ttl, enc, memory, members, next, len);
    }

    /// <summary>Newest first: XREVRANGE stop start COUNT n. A stop of "(id" is exclusive (works on every version).</summary>
    private static async Task<RedisStreamValue> StreamAsync(RedisClient c, IDatabase d, int db, string key, long ttl, string? enc, long? memory, RedisKeyQuery q)
    {
        var count = Page(q.Count, DefaultStreamPage, 1000);
        var stop = string.IsNullOrEmpty(q.Stop) ? "+" : q.Stop;
        var start = string.IsNullOrEmpty(q.Start) ? "-" : q.Start;
        if (stop.StartsWith('(')) stop = PreviousId(stop[1..]) ?? "-";
        if (start.StartsWith('(')) start = NextId(start[1..]);
        ValidateId(stop, "stop");
        ValidateId(start, "start");
        var entries = stop == "-" ? [] : ParseEntries(await Exec(d, "xrevrange", "XREVRANGE", (RedisKey)key, stop, start, "COUNT", count).ConfigureAwait(false));
        var len = Resp.Long(await Exec(d, "xlen", "XLEN", (RedisKey)key).ConfigureAwait(false));
        var first = ParseEntries(await Exec(d, "xrange", "XRANGE", (RedisKey)key, "-", "+", "COUNT", 1).ConfigureAwait(false)).FirstOrDefault()?.Id;
        var last = ParseEntries(await Exec(d, "xrevrange", "XREVRANGE", (RedisKey)key, "+", "-", "COUNT", 1).ConfigureAwait(false)).FirstOrDefault()?.Id;
        var groups = new List<RedisStreamGroup>();
        try
        {
            foreach (var g in Resp.Arr(await d.ExecuteAsync("XINFO", "GROUPS", (RedisKey)key).ConfigureAwait(false)))
            {
                var m = Resp.Map(g);
                long? lag = m.TryGetValue("lag", out var l) && !l.IsNull ? Resp.Long(l) : null;
                groups.Add(new RedisStreamGroup(Resp.Text(m.GetValueOrDefault("name") ?? RedisResult.Create(RedisValue.EmptyString)),
                    Resp.Long(m.GetValueOrDefault("consumers") ?? RedisResult.Create(0)), Resp.Long(m.GetValueOrDefault("pending") ?? RedisResult.Create(0)),
                    (string?)m.GetValueOrDefault("last-delivered-id") ?? "0-0", lag));
            }
        }
        catch (RedisServerException ex) when (!RedisErrors.IsPermissionError(ex.Message))
        {
            // XINFO unavailable (old server / renamed command): show entries without groups.
        }
        _ = c;
        return new RedisStreamValue(key, db, ttl, enc, memory, entries, len, first, last, groups);
    }

    internal static List<RedisStreamEntry> ParseEntries(RedisResult reply)
    {
        var list = new List<RedisStreamEntry>();
        foreach (var e in Resp.Arr(reply))
        {
            var parts = Resp.Arr(e);
            if (parts.Length < 2) continue;
            var kv = Resp.Arr(parts[1]);
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 0; i + 1 < kv.Length; i += 2) fields[Resp.Text(kv[i])] = Resp.Text(kv[i + 1]);
            list.Add(new RedisStreamEntry((string?)parts[0] ?? "", fields));
        }
        return list;
    }

    private static void ValidateId(string id, string field)
    {
        if (id is "-" or "+") return;
        if (!TryParseId(id, out _, out _)) throw EngineException.Validation($"{field} must be a stream id (ms-seq), '-' or '+'.", new { field });
    }

    internal static bool TryParseId(string id, out ulong ms, out ulong seq)
    {
        seq = 0;
        var dash = id.IndexOf('-');
        if (dash < 0) return ulong.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out ms);
        return ulong.TryParse(id.AsSpan(0, dash), NumberStyles.None, CultureInfo.InvariantCulture, out ms)
            & ulong.TryParse(id.AsSpan(dash + 1), NumberStyles.None, CultureInfo.InvariantCulture, out seq);
    }

    /// <summary>The greatest id below <paramref name="id"/>, or null when it is 0-0.</summary>
    internal static string? PreviousId(string id)
    {
        if (!TryParseId(id, out var ms, out var seq)) throw EngineException.Validation("stop must be a stream id.", new { field = "stop" });
        if (seq > 0) return $"{ms}-{seq - 1}";
        if (ms == 0) return null;
        return $"{ms - 1}-{ulong.MaxValue}";
    }

    internal static string NextId(string id)
    {
        if (!TryParseId(id, out var ms, out var seq)) throw EngineException.Validation("start must be a stream id.", new { field = "start" });
        return seq < ulong.MaxValue ? $"{ms}-{seq + 1}" : $"{ms + 1}-0";
    }

    private static async Task<RedisJsonValue> JsonAsync(IDatabase d, int db, string key, long ttl, string? enc, long? memory)
    {
        var text = (string?)await Exec(d, "json.get", "JSON.GET", (RedisKey)key, "$").ConfigureAwait(false) ?? "[]";
        using var doc = JsonDocument.Parse(text);
        // "$" answers an array of matches; the root has exactly one.
        var root = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0 ? doc.RootElement[0] : doc.RootElement;
        return new RedisJsonValue(key, db, ttl, enc, memory, root.Clone(), "$");
    }

    public async Task<RedisStreamGroupDetail> StreamGroupAsync(RedisClient c, int db, string key, string group)
    {
        var d = c.Db(db);
        var consumers = new List<RedisStreamConsumer>();
        foreach (var e in Resp.Arr(await Exec(d, "xinfo|consumers", "XINFO", "CONSUMERS", (RedisKey)key, group).ConfigureAwait(false)))
        {
            var m = Resp.Map(e);
            long? inactive = m.TryGetValue("inactive", out var i) && !i.IsNull ? Resp.Long(i) : null;
            consumers.Add(new RedisStreamConsumer(m.TryGetValue("name", out var n) ? Resp.Text(n) : "", m.TryGetValue("pending", out var p) ? Resp.Long(p) : 0,
                m.TryGetValue("idle", out var idle) ? Resp.Long(idle) : 0, inactive));
        }
        var pending = new List<RedisPendingEntry>();
        foreach (var e in Resp.Arr(await Exec(d, "xpending", "XPENDING", (RedisKey)key, group, "-", "+", 100).ConfigureAwait(false)))
        {
            var parts = Resp.Arr(e);
            if (parts.Length >= 4) pending.Add(new RedisPendingEntry((string?)parts[0] ?? "", Resp.Text(parts[1]), Resp.Long(parts[2]), Resp.Long(parts[3])));
        }
        return new RedisStreamGroupDetail(group, consumers, pending);
    }

    // ------------------------------------------------------------------ write

    public async Task SetStringAsync(RedisClient c, int db, string key, RedisSetStringRequest req)
    {
        c.EnsureWritable("editing a string value");
        var value = req.Value ?? throw EngineException.Validation("value is required.", new { field = "value" });
        var d = c.Db(db);
        if (c.Supports(6))
        {
            await Exec(d, "set", "SET", (RedisKey)key, value, "KEEPTTL").ConfigureAwait(false);
            return;
        }
        var pttl = Resp.Long(await Exec(d, "pttl", "PTTL", (RedisKey)key).ConfigureAwait(false));
        if (pttl > 0) await Exec(d, "set", "SET", (RedisKey)key, value, "PX", pttl).ConfigureAwait(false);
        else await Exec(d, "set", "SET", (RedisKey)key, value).ConfigureAwait(false);
    }

    public async Task EditHashAsync(RedisClient c, int db, string key, RedisHashEditRequest req)
    {
        c.EnsureWritable("editing hash fields");
        if ((req.Set is null || req.Set.Count == 0) && (req.Del is null || req.Del.Count == 0))
            throw EngineException.Validation("set or del is required.", new { field = "set" });
        var d = c.Db(db);
        if (req.Del is { Count: > 0 } del)
            await Exec(d, "hdel", "HDEL", [(RedisKey)key, .. del.Select(f => (object)f)]).ConfigureAwait(false);
        if (req.Set is { Count: > 0 } set)
            await Exec(d, "hset", "HSET", [(RedisKey)key, .. set.SelectMany(kv => new object[] { kv.Key, kv.Value })]).ConfigureAwait(false);
    }

    public async Task EditListAsync(RedisClient c, int db, string key, RedisListEditRequest req)
    {
        c.EnsureWritable("editing list items");
        var d = c.Db(db);
        var ops = (req.Push is null ? 0 : 1) + (req.SetIndex is null ? 0 : 1) + (req.Remove is null ? 0 : 1);
        if (ops != 1) throw EngineException.Validation("Exactly one of push, setIndex or remove is required.", new { field = "push" });
        if (req.Push is { } push)
        {
            var values = push.Values is { Count: > 0 } v ? v : throw EngineException.Validation("push.values is required.", new { field = "push.values" });
            var cmd = push.Side switch
            {
                "left" => "LPUSH",
                "right" or null => "RPUSH",
                _ => throw EngineException.Validation("push.side must be left or right.", new { field = "push.side" }),
            };
            await Exec(d, cmd.ToLowerInvariant(), cmd, [(RedisKey)key, .. values.Select(x => (object)x)]).ConfigureAwait(false);
        }
        else if (req.SetIndex is { } si)
        {
            var index = si.Index ?? throw EngineException.Validation("setIndex.index is required.", new { field = "setIndex.index" });
            await Exec(d, "lset", "LSET", (RedisKey)key, index, si.Value ?? "").ConfigureAwait(false);
        }
        else if (req.Remove is { } rm)
        {
            var value = rm.Value ?? throw EngineException.Validation("remove.value is required.", new { field = "remove.value" });
            await Exec(d, "lrem", "LREM", (RedisKey)key, rm.Count ?? 1, value).ConfigureAwait(false);
        }
    }

    public async Task EditSetAsync(RedisClient c, int db, string key, RedisSetEditRequest req)
    {
        c.EnsureWritable("editing set members");
        if ((req.Add is null || req.Add.Count == 0) && (req.Remove is null || req.Remove.Count == 0))
            throw EngineException.Validation("add or remove is required.", new { field = "add" });
        var d = c.Db(db);
        if (req.Remove is { Count: > 0 } rm) await Exec(d, "srem", "SREM", [(RedisKey)key, .. rm.Select(x => (object)x)]).ConfigureAwait(false);
        if (req.Add is { Count: > 0 } add) await Exec(d, "sadd", "SADD", [(RedisKey)key, .. add.Select(x => (object)x)]).ConfigureAwait(false);
    }

    public async Task EditZsetAsync(RedisClient c, int db, string key, RedisZsetEditRequest req)
    {
        c.EnsureWritable("editing sorted set members");
        if ((req.Add is null || req.Add.Count == 0) && (req.Remove is null || req.Remove.Count == 0))
            throw EngineException.Validation("add or remove is required.", new { field = "add" });
        var d = c.Db(db);
        if (req.Remove is { Count: > 0 } rm) await Exec(d, "zrem", "ZREM", [(RedisKey)key, .. rm.Select(x => (object)x)]).ConfigureAwait(false);
        if (req.Add is { Count: > 0 } add)
        {
            if (add.Any(m => m.Member is null)) throw EngineException.Validation("add[].member is required.", new { field = "add" });
            await Exec(d, "zadd", "ZADD", [(RedisKey)key, .. add.SelectMany(m => new object[] { Resp.Score(m.Score), m.Member })]).ConfigureAwait(false);
        }
    }

    /// <summary>Returns the new entry id for <c>add</c>, otherwise null.</summary>
    public async Task<string?> EditStreamAsync(RedisClient c, int db, string key, RedisStreamEditRequest req)
    {
        c.EnsureWritable("editing a stream");
        var d = c.Db(db);
        var ops = new object?[] { req.Add, req.Delete, req.Ack, req.GroupCreate, req.GroupDestroy }.Count(o => o is not null);
        if (ops != 1) throw EngineException.Validation("Exactly one of add, delete, ack, groupCreate or groupDestroy is required.", new { field = "add" });
        if (req.Add is { } add)
        {
            if (add.Count == 0) throw EngineException.Validation("add needs at least one field.", new { field = "add" });
            var id = string.IsNullOrWhiteSpace(req.Id) ? "*" : req.Id.Trim();
            var r = await Exec(d, "xadd", "XADD", [(RedisKey)key, id, .. add.SelectMany(kv => new object[] { kv.Key, kv.Value })]).ConfigureAwait(false);
            return (string?)r;
        }
        if (req.Delete is { } ids)
        {
            if (ids.Count == 0) throw EngineException.Validation("delete needs at least one id.", new { field = "delete" });
            await Exec(d, "xdel", "XDEL", [(RedisKey)key, .. ids.Select(x => (object)x)]).ConfigureAwait(false);
        }
        else if (req.Ack is { } ack)
        {
            var group = ack.Group ?? throw EngineException.Validation("ack.group is required.", new { field = "ack.group" });
            if (ack.Ids is not { Count: > 0 } ackIds) throw EngineException.Validation("ack.ids is required.", new { field = "ack.ids" });
            await Exec(d, "xack", "XACK", [(RedisKey)key, group, .. ackIds.Select(x => (object)x)]).ConfigureAwait(false);
        }
        else if (req.GroupCreate is { } gc)
        {
            var name = string.IsNullOrWhiteSpace(gc.Name) ? throw EngineException.Validation("groupCreate.name is required.", new { field = "groupCreate.name" }) : gc.Name;
            await Exec(d, "xgroup|create", "XGROUP", "CREATE", (RedisKey)key, name, string.IsNullOrWhiteSpace(gc.Id) ? "$" : gc.Id).ConfigureAwait(false);
        }
        else if (req.GroupDestroy is { } destroy)
        {
            await Exec(d, "xgroup|destroy", "XGROUP", "DESTROY", (RedisKey)key, destroy).ConfigureAwait(false);
        }
        return null;
    }

    public async Task SetJsonAsync(RedisClient c, int db, string key, RedisJsonSetRequest req)
    {
        c.EnsureWritable("editing a JSON document");
        if (req.Value is not { } value || value.ValueKind == JsonValueKind.Undefined)
            throw EngineException.Validation("value is required.", new { field = "value" });
        var path = string.IsNullOrWhiteSpace(req.Path) ? "$" : req.Path;
        await Exec(c.Db(db), "json.set", "JSON.SET", (RedisKey)key, path, value.GetRawText()).ConfigureAwait(false);
    }

    public async Task CreateAsync(RedisClient c, RedisCreateKeyRequest req)
    {
        c.EnsureWritable("creating a key");
        var key = req.Key is { Length: > 0 } k ? k : throw EngineException.Validation("key is required.", new { field = "key" });
        var db = c.CheckDb(req.Db ?? c.Settings.Database);
        var d = c.Db(db);
        if (req.Ttl is <= 0) throw EngineException.Validation("ttl must be a positive number of seconds.", new { field = "ttl" });
        if (Resp.Long(await Exec(d, "exists", "EXISTS", (RedisKey)key).ConfigureAwait(false)) > 0)
            throw EngineException.Validation($"Key '{key}' already exists.", new { field = "key" });
        switch (req.Type)
        {
            case "string":
                await Exec(d, "set", "SET", (RedisKey)key, req.Value ?? "").ConfigureAwait(false);
                break;
            case "hash":
                if (req.Fields is not { Count: > 0 } fields) throw EngineException.Validation("A hash needs at least one field.", new { field = "fields" });
                await Exec(d, "hset", "HSET", [(RedisKey)key, .. fields.SelectMany(kv => new object[] { kv.Key, kv.Value })]).ConfigureAwait(false);
                break;
            case "list":
                if (req.Values is not { Count: > 0 } values) throw EngineException.Validation("A list needs at least one element.", new { field = "values" });
                await Exec(d, "rpush", "RPUSH", [(RedisKey)key, .. values.Select(v => (object)v)]).ConfigureAwait(false);
                break;
            case "set":
            {
                var members = StringMembers(req.Members);
                await Exec(d, "sadd", "SADD", [(RedisKey)key, .. members.Select(v => (object)v)]).ConfigureAwait(false);
                break;
            }
            case "zset":
            {
                var members = ZsetMembers(req.Members);
                await Exec(d, "zadd", "ZADD", [(RedisKey)key, .. members.SelectMany(m => new object[] { Resp.Score(m.Score), m.Member })]).ConfigureAwait(false);
                break;
            }
            case "stream":
                if (req.Fields is not { Count: > 0 } sf) throw EngineException.Validation("A stream entry needs at least one field.", new { field = "fields" });
                await Exec(d, "xadd", "XADD", [(RedisKey)key, "*", .. sf.SelectMany(kv => new object[] { kv.Key, kv.Value })]).ConfigureAwait(false);
                break;
            case "rejson":
                if (!await c.HasJsonModuleAsync().ConfigureAwait(false))
                    throw new EngineException(400, ErrorCodes.NotSupported, "The server has no RedisJSON module (use Redis Stack).");
                if (req.Json is not { } json || json.ValueKind == JsonValueKind.Undefined)
                    throw EngineException.Validation("json is required.", new { field = "json" });
                await Exec(d, "json.set", "JSON.SET", (RedisKey)key, "$", json.GetRawText()).ConfigureAwait(false);
                break;
            default:
                throw EngineException.Validation("type must be string, hash, list, set, zset, stream or rejson.", new { field = "type" });
        }
        if (req.Ttl is { } ttl) await Exec(d, "expire", "EXPIRE", (RedisKey)key, ttl).ConfigureAwait(false);
    }

    private static List<string> StringMembers(JsonElement? members)
    {
        if (members is not { ValueKind: JsonValueKind.Array } arr || arr.GetArrayLength() == 0)
            throw EngineException.Validation("A set needs at least one member.", new { field = "members" });
        return arr.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText()).ToList();
    }

    private static List<RedisZsetMember> ZsetMembers(JsonElement? members)
    {
        if (members is not { ValueKind: JsonValueKind.Array } arr || arr.GetArrayLength() == 0)
            throw EngineException.Validation("A sorted set needs at least one member.", new { field = "members" });
        var list = new List<RedisZsetMember>();
        foreach (var e in arr.EnumerateArray())
        {
            if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty("member", out var m) || !e.TryGetProperty("score", out var s) || !s.TryGetDouble(out var score))
                throw EngineException.Validation("members[] must be { member, score }.", new { field = "members" });
            list.Add(new RedisZsetMember(m.ValueKind == JsonValueKind.String ? m.GetString()! : m.GetRawText(), score));
        }
        return list;
    }

    public async Task RenameAsync(RedisClient c, int db, string key, RedisRenameRequest req)
    {
        c.EnsureWritable("renaming a key");
        var newKey = req.NewKey is { Length: > 0 } nk ? nk : throw EngineException.Validation("newKey is required.", new { field = "newKey" });
        if (newKey == key) throw EngineException.Validation("The new name is the current name.", new { field = "newKey" });
        if (c.IsCluster && c.Mux.HashSlot(key) != c.Mux.HashSlot(newKey))
            throw EngineException.Validation(
                $"In Redis Cluster both names must hash to the same slot ({c.Mux.HashSlot(key)} vs {c.Mux.HashSlot(newKey)}). Use a hash tag, e.g. {{user:1}}:profile.",
                new { field = "newKey" });
        var d = c.Db(db);
        if (Resp.Long(await Exec(d, "exists", "EXISTS", (RedisKey)key).ConfigureAwait(false)) == 0) throw EngineException.NotFound($"Key '{key}'");
        if (req.Overwrite == true)
        {
            await Exec(d, "rename", "RENAME", (RedisKey)key, (RedisKey)newKey).ConfigureAwait(false);
            return;
        }
        var ok = Resp.Long(await Exec(d, "renamenx", "RENAMENX", (RedisKey)key, (RedisKey)newKey).ConfigureAwait(false));
        if (ok == 0) throw EngineException.Validation($"Key '{newKey}' already exists (tick Overwrite to replace it).", new { field = "newKey" });
    }

    public async Task SetTtlAsync(RedisClient c, int db, string key, RedisTtlRequest req)
    {
        c.EnsureWritable(req.Seconds is null ? "removing a TTL" : "setting a TTL");
        var d = c.Db(db);
        if (req.Seconds is null)
        {
            if (Resp.Long(await Exec(d, "exists", "EXISTS", (RedisKey)key).ConfigureAwait(false)) == 0) throw EngineException.NotFound($"Key '{key}'");
            await Exec(d, "persist", "PERSIST", (RedisKey)key).ConfigureAwait(false);
            return;
        }
        if (req.Seconds <= 0) throw EngineException.Validation("seconds must be positive (null removes the TTL).", new { field = "seconds" });
        var set = Resp.Long(await Exec(d, "expire", "EXPIRE", (RedisKey)key, req.Seconds.Value).ConfigureAwait(false));
        if (set == 0) throw EngineException.NotFound($"Key '{key}'");
    }

    public async Task DeleteAsync(RedisClient c, int db, string key)
    {
        c.EnsureWritable("deleting a key");
        var d = c.Db(db);
        var n = c.Supports(4)
            ? Resp.Long(await Exec(d, "unlink", "UNLINK", (RedisKey)key).ConfigureAwait(false))
            : Resp.Long(await Exec(d, "del", "DEL", (RedisKey)key).ConfigureAwait(false));
        if (n == 0) throw EngineException.NotFound($"Key '{key}'");
    }

    /// <summary>
    /// Job body of <c>POST /keys/delete-pattern</c>: SCAN MATCH + UNLINK in pipelines of 500, progress after every
    /// page, cancellable between pages.
    /// </summary>
    public async Task<RedisDeletePatternResult> DeletePatternAsync(RedisClient c, int db, string pattern, JobContext job, CancellationToken ct)
    {
        var d = c.Db(db);
        var total = await KeyBrowser.DbSizeAsync(c, db).ConfigureAwait(false);
        long scanned = 0, deleted = 0;
        var unlink = c.Supports(4) ? "UNLINK" : "DEL";
        foreach (var node in c.IsCluster ? c.Primaries().Select(p => (IServer?)p).ToList() : [null])
        {
            var cursor = "0";
            do
            {
                ct.ThrowIfCancellationRequested();
                var args = new object[] { cursor, "MATCH", pattern, "COUNT", 500 };
                var reply = Resp.Arr(await RedisErrors.Guard(() => node is null ? d.ExecuteAsync("SCAN", args) : node.ExecuteAsync("SCAN", args), "scan").ConfigureAwait(false));
                cursor = reply.Length > 0 ? (string?)reply[0] ?? "0" : "0";
                var keys = reply.Length > 1 ? Resp.Arr(reply[1]).Select(r => (RedisKey)(byte[])r!).ToArray() : [];
                scanned += 500;
                if (keys.Length > 0)
                {
                    if (c.IsCluster)
                    {
                        var batch = d.CreateBatch();
                        var tasks = keys.Select(k => batch.ExecuteAsync(unlink, k)).ToArray();
                        batch.Execute();
                        var replies = await RedisErrors.Guard(() => Task.WhenAll(tasks), unlink.ToLowerInvariant()).ConfigureAwait(false);
                        deleted += replies.Sum(Resp.Long);
                    }
                    else
                    {
                        deleted += Resp.Long(await Exec(d, unlink.ToLowerInvariant(), unlink, [.. keys.Select(k => (object)k)]).ConfigureAwait(false));
                    }
                }
                job.Report(deleted, null, $"Deleted {deleted:N0} keys, scanned ~{Math.Min(scanned, Math.Max(total, scanned)):N0} of ~{total:N0}");
            } while (cursor != "0");
        }
        job.Report(deleted, deleted, $"Deleted {deleted:N0} keys", force: true);
        return new RedisDeletePatternResult(Math.Max(scanned, 0), deleted);
    }

    private static Task<RedisResult> Exec(IDatabase d, string acl, string command, params object[] args) =>
        RedisErrors.Guard(() => d.ExecuteAsync(command, args), acl);
}
