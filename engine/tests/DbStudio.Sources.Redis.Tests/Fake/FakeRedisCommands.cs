using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace DbStudio.Sources.Redis.Tests.Fake;

internal sealed class FakeEntry
{
    public object Value = null!;
    public DateTime? ExpiresAt;
}

internal sealed class FakeStream
{
    public readonly List<(ulong Ms, ulong Seq, List<(string F, string V)> Fields)> Entries = [];
    public readonly Dictionary<string, FakeGroup> Groups = new(StringComparer.Ordinal);
    public (ulong Ms, ulong Seq) Last;
}

internal sealed class FakeGroup
{
    public (ulong, ulong) LastDelivered;
    public readonly Dictionary<string, DateTime> Consumers = new(StringComparer.Ordinal);
    public readonly SortedDictionary<(ulong, ulong), (string Consumer, DateTime At, long Count)> Pending = new();
}

/// <summary>One logical database of the fake: values are byte[] (string), Dictionary (hash), List (list), HashSet (set),
/// Dictionary of double (zset), FakeStream, JsonNode (ReJSON).</summary>
internal sealed class FakeDb
{
    public readonly Dictionary<string, FakeEntry> Data = new(StringComparer.Ordinal);
    // SCAN order: keys are appended once and never move, so a SCAN that runs while keys are deleted still returns every
    // key that existed for the whole iteration (the real guarantee); removed keys stay as tombstones until FLUSHDB.
    private readonly List<string> _order = [];
    private readonly HashSet<string> _ordered = new(StringComparer.Ordinal);

    public void Touch()
    {
        if (Data.Count == 0) { _order.Clear(); _ordered.Clear(); }
    }

    public List<string> Order => _order;

    public FakeEntry? Get(string key)
    {
        if (!Data.TryGetValue(key, out var e)) return null;
        if (e.ExpiresAt is { } at && at <= DateTime.UtcNow)
        {
            Data.Remove(key);
            return null;
        }
        return e;
    }

    public void Set(string key, object value, DateTime? expires = null)
    {
        if (_ordered.Add(key)) _order.Add(key);
        Data[key] = new FakeEntry { Value = value, ExpiresAt = expires };
    }

    public bool Remove(string key)
    {
        if (Get(key) is null) return false;
        Data.Remove(key);
        return true;
    }
}

internal sealed partial class FakeRedisServer
{
    private static readonly Err WrongType = new("WRONGTYPE Operation against a key holding the wrong kind of value");
    private static readonly Err Syntax = new("ERR syntax error");
    private static readonly Simple Ok = new("OK");

    private static string S(byte[] b) => Encoding.UTF8.GetString(b);

    private static Err Arity(string cmd) => new($"ERR wrong number of arguments for '{cmd.ToLowerInvariant()}' command");

    /// <summary>Test seeding helpers (bypass the protocol).</summary>
    public void SeedString(int db, string key, string value, TimeSpan? ttl = null)
    {
        lock (Gate) Dbs[db].Set(key, Encoding.UTF8.GetBytes(value), ttl is null ? null : DateTime.UtcNow + ttl);
    }

    public void SeedBytes(int db, string key, byte[] value)
    {
        lock (Gate) Dbs[db].Set(key, value);
    }

    internal object? Dispatch(Conn c, List<byte[]> args)
    {
        var cmd = S(args[0]).ToUpperInvariant();
        Received.Enqueue(cmd);
        Interlocked.Increment(ref CommandsProcessed);
        c.LastCommand = cmd.ToLowerInvariant();
        if (cmd == "AUTH") return Auth(c, args);
        if (cmd == "HELLO") return new Err("ERR unknown command 'HELLO'");
        if (!c.Authenticated) return new Err("NOAUTH Authentication required.");
        if (cmd == "QUIT") return Quit.Instance;
        if (Users.TryGetValue(c.User, out var acl) && acl.Allowed is not null && !acl.Allowed.Contains(cmd) && cmd is not ("CLIENT" or "PING" or "INFO" or "CONFIG" or "CLUSTER" or "ECHO" or "SUBSCRIBE" or "SELECT"))
            return new Err($"NOPERM User {c.User} has no permissions to run the '{cmd.ToLowerInvariant()}' command");

        if (c.Multi is not null && cmd is not ("EXEC" or "DISCARD" or "MULTI" or "WATCH"))
        {
            c.Multi.Add(args);
            return new Simple("QUEUED");
        }
        if (c.Subscribed && cmd is not ("SUBSCRIBE" or "PSUBSCRIBE" or "UNSUBSCRIBE" or "PUNSUBSCRIBE" or "PING"))
            return new Err($"ERR Can't execute '{cmd.ToLowerInvariant()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context");

        if (cmd is not ("MONITOR" or "CLIENT" or "INFO" or "CONFIG" or "PING" or "ECHO" or "CLUSTER")) FeedMonitors(c, args);

        switch (cmd)
        {
            case "MULTI":
                c.Multi = [];
                return Ok;
            case "EXEC":
                if (c.Multi is null) return new Err("ERR EXEC without MULTI");
                var queued = c.Multi;
                c.Multi = null;
                return queued.Select(q => Run(c, S(q[0]).ToUpperInvariant(), q)).ToList();
            case "DISCARD":
                if (c.Multi is null) return new Err("ERR DISCARD without MULTI");
                c.Multi = null;
                return Ok;
            case "WATCH":
            case "UNWATCH":
                return Ok;
            case "BLPOP":
            case "BRPOP":
                return BlockingPop(c, cmd, args);
        }
        return Run(c, cmd, args);
    }

    private object? Auth(Conn c, List<byte[]> args)
    {
        if (args.Count == 2)
        {
            if (Password is null) return new Err("ERR AUTH <password> called without any password configured for the default user.");
            if (S(args[1]) != Password) return new Err("WRONGPASS invalid username-password pair or user is disabled.");
            c.Authenticated = true;
            c.User = "default";
            return Ok;
        }
        if (args.Count == 3)
        {
            var user = S(args[1]);
            var pass = S(args[2]);
            if (user == "default" && pass == Password || Users.TryGetValue(user, out var u) && u.Password == pass)
            {
                c.Authenticated = true;
                c.User = user;
                return Ok;
            }
            return new Err("WRONGPASS invalid username-password pair or user is disabled.");
        }
        return Arity("auth");
    }

    private object? BlockingPop(Conn c, string cmd, List<byte[]> args)
    {
        if (args.Count < 3) return Arity(cmd);
        var timeout = double.Parse(S(args[^1]), CultureInfo.InvariantCulture);
        var deadline = DateTime.UtcNow + (timeout <= 0 ? TimeSpan.FromSeconds(30) : TimeSpan.FromSeconds(timeout));
        while (DateTime.UtcNow < deadline)
        {
            lock (Gate)
            {
                for (var i = 1; i < args.Count - 1; i++)
                {
                    var key = S(args[i]);
                    if (Dbs[c.Db].Get(key)?.Value is List<byte[]> list && list.Count > 0)
                    {
                        var v = cmd == "BLPOP" ? list[0] : list[^1];
                        list.RemoveAt(cmd == "BLPOP" ? 0 : list.Count - 1);
                        if (list.Count == 0) Dbs[c.Db].Remove(key);
                        return new object?[] { key, v };
                    }
                }
            }
            Thread.Sleep(20);
        }
        return NullArray.Instance;
    }

    private object? Run(Conn c, string cmd, List<byte[]> args)
    {
        lock (Gate)
        {
            try
            {
                return Execute(c, cmd, args);
            }
            catch (FormatException)
            {
                return new Err("ERR value is not an integer or out of range");
            }
            catch (InvalidCastException)
            {
                return WrongType;
            }
        }
    }

    private object? Execute(Conn c, string cmd, List<byte[]> a)
    {
        var db = Dbs[c.Db];
        string Arg(int i) => S(a[i]);
        long L(int i) => long.Parse(Arg(i), CultureInfo.InvariantCulture);
        switch (cmd)
        {
            // ---------------------------------------------------------- connection / server
            case "PING":
                if (c.Subscribed) return new object?[] { "pong", a.Count > 1 ? a[1] : "" };
                return a.Count > 1 ? a[1] : new Simple("PONG");
            case "ECHO": return a.Count == 2 ? a[1] : Arity(cmd);
            case "SELECT":
            {
                var n = (int)L(1);
                if (n < 0 || n >= Dbs.Length) return new Err("ERR DB index is out of range");
                c.Db = n;
                return Ok;
            }
            case "CLIENT": return Client(c, a);
            case "CONFIG": return ConfigCmd(a);
            case "CLUSTER": return new Err("ERR This instance has cluster support disabled");
            case "INFO": return Info(a.Count > 1 ? Arg(1).ToLowerInvariant() : null);
            case "DBSIZE": return (long)db.Data.Keys.ToList().Count(k => db.Get(k) is not null);
            case "TIME": return new object?[] { DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture), "0" };
            case "FLUSHDB":
                db.Data.Clear();
                db.Touch();
                return Ok;
            case "FLUSHALL":
                foreach (var d in Dbs) { d.Data.Clear(); d.Touch(); }
                return Ok;
            case "MODULE":
                if (a.Count > 1 && Arg(1).Equals("LIST", StringComparison.OrdinalIgnoreCase))
                    return JsonModule ? new object?[] { new object?[] { "name", "ReJSON", "ver", 20612L, "path", "/opt/rejson.so", "args", Array.Empty<object>() } } : Array.Empty<object>();
                return Syntax;
            case "SLOWLOG":
                switch (Arg(1).ToUpperInvariant())
                {
                    case "GET":
                        var n = a.Count > 2 ? (int)L(2) : 10;
                        return Slowlog.Take(n).ToList();
                    case "RESET": Slowlog.Clear(); return Ok;
                    case "LEN": return (long)Slowlog.Count;
                }
                return Syntax;
            case "MONITOR":
                c.Monitoring = true;
                return Ok;
            case "PUBLISH": return (long)Publish(Arg(1), a[2]);
            case "SUBSCRIBE":
            case "PSUBSCRIBE":
            {
                var replies = new List<object?>();
                foreach (var ch in a.Skip(1).Select(S))
                {
                    (cmd == "SUBSCRIBE" ? c.Channels : c.Patterns).Add(ch);
                    replies.Add(new object?[] { cmd.ToLowerInvariant(), ch, (long)(c.Channels.Count + c.Patterns.Count) });
                }
                foreach (var r in replies.Take(replies.Count - 1)) c.Send(r);
                return replies[^1];
            }
            case "UNSUBSCRIBE":
            case "PUNSUBSCRIBE":
            {
                var set = cmd == "UNSUBSCRIBE" ? c.Channels : c.Patterns;
                var names = a.Count > 1 ? a.Skip(1).Select(S).ToList() : [.. set];
                if (names.Count == 0) return new object?[] { cmd.ToLowerInvariant(), null, 0L };
                object? last = null;
                foreach (var n in names)
                {
                    set.Remove(n);
                    var r = new object?[] { cmd.ToLowerInvariant(), n, (long)(c.Channels.Count + c.Patterns.Count) };
                    if (last is not null) c.Send(last);
                    last = r;
                }
                return last;
            }
            case "PUBSUB":
                switch (Arg(1).ToUpperInvariant())
                {
                    case "CHANNELS":
                        var pat = a.Count > 2 ? Arg(2) : "*";
                        return Connections.SelectMany(x => x.Channels).Distinct().Where(ch => Glob.IsMatch(pat, ch)).OrderBy(x => x, StringComparer.Ordinal).ToList();
                    case "NUMSUB":
                        return a.Skip(2).Select(S).SelectMany(ch => new object?[] { ch, (long)Connections.Count(x => x.Channels.Contains(ch)) }).ToList();
                    case "NUMPAT": return (long)Connections.Sum(x => x.Patterns.Count);
                }
                return Syntax;

            // ---------------------------------------------------------- generic
            case "TYPE": return new Simple(TypeOf(db.Get(Arg(1))));
            case "EXISTS": return (long)a.Skip(1).Count(k => db.Get(S(k)) is not null);
            case "DEL":
            case "UNLINK": return (long)a.Skip(1).Count(k => db.Remove(S(k)));
            case "TTL":
            case "PTTL":
            {
                var e = db.Get(Arg(1));
                if (e is null) return -2L;
                if (e.ExpiresAt is null) return -1L;
                var left = e.ExpiresAt.Value - DateTime.UtcNow;
                return cmd == "TTL" ? (long)Math.Ceiling(left.TotalSeconds) : (long)left.TotalMilliseconds;
            }
            case "EXPIRE":
            case "PEXPIRE":
            {
                var e = db.Get(Arg(1));
                if (e is null) return 0L;
                e.ExpiresAt = DateTime.UtcNow + (cmd == "EXPIRE" ? TimeSpan.FromSeconds(L(2)) : TimeSpan.FromMilliseconds(L(2)));
                return 1L;
            }
            case "PERSIST":
            {
                var e = db.Get(Arg(1));
                if (e?.ExpiresAt is null) return 0L;
                e.ExpiresAt = null;
                return 1L;
            }
            case "RENAME":
            case "RENAMENX":
            {
                var e = db.Get(Arg(1));
                if (e is null) return new Err("ERR no such key");
                if (cmd == "RENAMENX" && db.Get(Arg(2)) is not null) return 0L;
                db.Remove(Arg(1));
                db.Set(Arg(2), e.Value, e.ExpiresAt);
                return cmd == "RENAME" ? Ok : 1L;
            }
            case "KEYS": return db.Order.Where(k => Glob.IsMatch(Arg(1), k) && db.Get(k) is not null).ToList();
            case "SCAN": return Scan(db, a);
            case "MEMORY":
            {
                if (!Arg(1).Equals("USAGE", StringComparison.OrdinalIgnoreCase)) return Syntax;
                var e = db.Get(Arg(2));
                return e is null ? null : (object)(long)(56 + Arg(2).Length + SizeOf(e.Value));
            }
            case "OBJECT":
            {
                var e = db.Get(Arg(2));
                if (e is null) return null;
                return e.Value switch
                {
                    byte[] b => long.TryParse(S(b), out _) ? "int" : b.Length <= 44 ? "embstr" : "raw",
                    Dictionary<string, byte[]> h => h.Count <= 128 ? "listpack" : "hashtable",
                    List<byte[]> => "quicklist",
                    HashSet<string> => "listpack",
                    Dictionary<string, double> z => z.Count <= 128 ? "listpack" : "skiplist",
                    FakeStream => "stream",
                    _ => "raw",
                };
            }

            // ---------------------------------------------------------- strings
            case "GET":
            {
                var e = db.Get(Arg(1));
                return e is null ? null : (byte[])e.Value;
            }
            case "SET": return Set(db, a);
            case "STRLEN": return db.Get(Arg(1)) is { } e2 ? (long)((byte[])e2.Value).Length : 0L;
            case "GETRANGE":
            {
                var b = db.Get(Arg(1)) is { } e ? (byte[])e.Value : [];
                var start = (int)Math.Max(0, L(2));
                var end = (int)Math.Min(b.Length - 1, L(3) < 0 ? b.Length + L(3) : L(3));
                return end < start ? Array.Empty<byte>() : b[start..(end + 1)];
            }
            case "INCR":
            {
                var cur = db.Get(Arg(1)) is { } e ? long.Parse(S((byte[])e.Value), CultureInfo.InvariantCulture) : 0;
                db.Set(Arg(1), Encoding.ASCII.GetBytes((cur + 1).ToString(CultureInfo.InvariantCulture)), db.Get(Arg(1))?.ExpiresAt);
                return cur + 1;
            }
            case "MGET": return a.Skip(1).Select(k => db.Get(S(k)) is { Value: byte[] b } ? b : null).ToList();
            case "MSET":
                for (var i = 1; i + 1 < a.Count; i += 2) db.Set(Arg(i), a[i + 1]);
                return Ok;

            // ---------------------------------------------------------- hashes
            case "HSET":
            case "HMSET":
            {
                if (a.Count < 4 || a.Count % 2 != 0) return Arity(cmd);
                var h = GetOrCreate(db, Arg(1), () => new Dictionary<string, byte[]>(StringComparer.Ordinal));
                long added = 0;
                for (var i = 2; i + 1 < a.Count; i += 2) { if (!h.ContainsKey(Arg(i))) added++; h[Arg(i)] = a[i + 1]; }
                return cmd == "HSET" ? added : Ok;
            }
            case "HGET": return db.Get(Arg(1)) is { } he && ((Dictionary<string, byte[]>)he.Value).TryGetValue(Arg(2), out var hv) ? hv : null;
            case "HGETALL": return db.Get(Arg(1)) is { } hge ? ((Dictionary<string, byte[]>)hge.Value).SelectMany(kv => new object?[] { kv.Key, kv.Value }).ToList() : new List<object?>();
            case "HLEN": return db.Get(Arg(1)) is { } hle ? (long)((Dictionary<string, byte[]>)hle.Value).Count : 0L;
            case "HDEL":
            {
                if (db.Get(Arg(1)) is not { } e) return 0L;
                var h = (Dictionary<string, byte[]>)e.Value;
                var n = a.Skip(2).Count(f => h.Remove(S(f)));
                if (h.Count == 0) db.Remove(Arg(1));
                return (long)n;
            }
            case "HSCAN":
            {
                var h = db.Get(Arg(1)) is { } e ? (Dictionary<string, byte[]>)e.Value : [];
                var (next, items) = ScanItems(h.Keys.ToList(), a, 2);
                return new object?[] { next, items.SelectMany(f => new object?[] { f, h[f] }).ToList() };
            }

            // ---------------------------------------------------------- lists
            case "LPUSH":
            case "RPUSH":
            {
                var l = GetOrCreate(db, Arg(1), () => new List<byte[]>());
                foreach (var v in a.Skip(2)) { if (cmd == "LPUSH") l.Insert(0, v); else l.Add(v); }
                return (long)l.Count;
            }
            case "LLEN": return db.Get(Arg(1)) is { } lle ? (long)((List<byte[]>)lle.Value).Count : 0L;
            case "LRANGE":
            {
                var l = db.Get(Arg(1)) is { } e ? (List<byte[]>)e.Value : [];
                var (s, t) = Range(L(2), L(3), l.Count);
                return s > t ? new List<object?>() : l.Skip(s).Take(t - s + 1).Cast<object?>().ToList();
            }
            case "LSET":
            {
                if (db.Get(Arg(1)) is not { } e) return new Err("ERR no such key");
                var l = (List<byte[]>)e.Value;
                var i = L(2) < 0 ? l.Count + L(2) : L(2);
                if (i < 0 || i >= l.Count) return new Err("ERR index out of range");
                l[(int)i] = a[3];
                return Ok;
            }
            case "LREM":
            {
                if (db.Get(Arg(1)) is not { } e) return 0L;
                var l = (List<byte[]>)e.Value;
                var count = L(2);
                var removed = 0L;
                for (var i = 0; i < l.Count && (count == 0 || removed < Math.Abs(count));)
                {
                    if (l[i].AsSpan().SequenceEqual(a[3])) { l.RemoveAt(i); removed++; } else i++;
                }
                if (l.Count == 0) db.Remove(Arg(1));
                return removed;
            }
            case "LPOP":
            case "RPOP":
            {
                if (db.Get(Arg(1)) is not { } e) return null;
                var l = (List<byte[]>)e.Value;
                var v = cmd == "LPOP" ? l[0] : l[^1];
                l.RemoveAt(cmd == "LPOP" ? 0 : l.Count - 1);
                if (l.Count == 0) db.Remove(Arg(1));
                return v;
            }

            // ---------------------------------------------------------- sets
            case "SADD":
            {
                var s = GetOrCreate(db, Arg(1), () => new HashSet<string>(StringComparer.Ordinal));
                return (long)a.Skip(2).Count(m => s.Add(S(m)));
            }
            case "SREM":
            {
                if (db.Get(Arg(1)) is not { } e) return 0L;
                var s = (HashSet<string>)e.Value;
                var n = a.Skip(2).Count(m => s.Remove(S(m)));
                if (s.Count == 0) db.Remove(Arg(1));
                return (long)n;
            }
            case "SCARD": return db.Get(Arg(1)) is { } sce ? (long)((HashSet<string>)sce.Value).Count : 0L;
            case "SMEMBERS": return db.Get(Arg(1)) is { } sme ? ((HashSet<string>)sme.Value).Cast<object?>().ToList() : new List<object?>();
            case "SISMEMBER": return db.Get(Arg(1)) is { } sie && ((HashSet<string>)sie.Value).Contains(Arg(2)) ? 1L : 0L;
            case "SSCAN":
            {
                var s = db.Get(Arg(1)) is { } e ? (HashSet<string>)e.Value : [];
                var (next, items) = ScanItems([.. s], a, 2);
                return new object?[] { next, items };
            }

            // ---------------------------------------------------------- sorted sets
            case "ZADD":
            {
                var z = GetOrCreate(db, Arg(1), () => new Dictionary<string, double>(StringComparer.Ordinal));
                long added = 0;
                for (var i = 2; i + 1 < a.Count; i += 2)
                {
                    var score = ParseScore(Arg(i));
                    if (!z.ContainsKey(Arg(i + 1))) added++;
                    z[Arg(i + 1)] = score;
                }
                return added;
            }
            case "ZREM":
            {
                if (db.Get(Arg(1)) is not { } e) return 0L;
                var z = (Dictionary<string, double>)e.Value;
                var n = a.Skip(2).Count(m => z.Remove(S(m)));
                if (z.Count == 0) db.Remove(Arg(1));
                return (long)n;
            }
            case "ZCARD": return db.Get(Arg(1)) is { } zce ? (long)((Dictionary<string, double>)zce.Value).Count : 0L;
            case "ZSCORE": return db.Get(Arg(1)) is { } zse && ((Dictionary<string, double>)zse.Value).TryGetValue(Arg(2), out var sc) ? Resp.FormatDouble(sc) : null;
            case "ZRANGE":
            {
                var z = db.Get(Arg(1)) is { } e ? (Dictionary<string, double>)e.Value : [];
                var sorted = z.OrderBy(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).ToList();
                var (s, t) = Range(L(2), L(3), sorted.Count);
                var withScores = a.Skip(4).Any(x => S(x).Equals("WITHSCORES", StringComparison.OrdinalIgnoreCase));
                var page = s > t ? [] : sorted.Skip(s).Take(t - s + 1).ToList();
                return withScores ? page.SelectMany(kv => new object?[] { kv.Key, Resp.FormatDouble(kv.Value) }).ToList() : page.Select(kv => (object?)kv.Key).ToList();
            }
            case "ZSCAN":
            {
                var z = db.Get(Arg(1)) is { } e ? (Dictionary<string, double>)e.Value : [];
                var (next, items) = ScanItems(z.Keys.ToList(), a, 2);
                return new object?[] { next, items.SelectMany(m => new object?[] { m, Resp.FormatDouble(z[m]) }).ToList() };
            }

            // ---------------------------------------------------------- streams
            case "XADD": return XAdd(db, a);
            case "XLEN": return db.Get(Arg(1)) is { } xle ? (long)((FakeStream)xle.Value).Entries.Count : 0L;
            case "XRANGE":
            case "XREVRANGE": return XRange(db, cmd, a);
            case "XDEL":
            {
                if (db.Get(Arg(1)) is not { } e) return 0L;
                var st = (FakeStream)e.Value;
                var ids = a.Skip(2).Select(x => ParseId(S(x), 0)).ToHashSet();
                return (long)st.Entries.RemoveAll(x => ids.Contains((x.Ms, x.Seq)));
            }
            case "XGROUP": return XGroup(db, a);
            case "XACK":
            {
                if (db.Get(Arg(1)) is not { } e || !((FakeStream)e.Value).Groups.TryGetValue(Arg(2), out var g)) return 0L;
                return (long)a.Skip(3).Count(x => g.Pending.Remove(ParseId(S(x), 0)));
            }
            case "XINFO": return XInfo(db, a);
            case "XPENDING":
            {
                if (db.Get(Arg(1)) is not { } e || !((FakeStream)e.Value).Groups.TryGetValue(Arg(2), out var g)) return new Err("NOGROUP No such key or consumer group");
                var count = a.Count > 5 ? (int)L(5) : 10;
                return g.Pending.Take(count).Select(p => (object?)new object?[] { Id(p.Key), p.Value.Consumer, (long)(DateTime.UtcNow - p.Value.At).TotalMilliseconds, p.Value.Count }).ToList();
            }
            case "XREADGROUP": return XReadGroup(db, a);

            // ---------------------------------------------------------- RedisJSON (simulated)
            case "JSON.SET":
            {
                if (!JsonModule) return new Err("ERR unknown command 'JSON.SET'");
                var node = JsonNode.Parse(Arg(3));
                var path = Arg(2);
                if (path is "$" or ".") { db.Set(Arg(1), node!, db.Get(Arg(1))?.ExpiresAt); return Ok; }
                if (db.Get(Arg(1)) is not { Value: JsonNode root }) return new Err("ERR new objects must be created at the root");
                var (parent, name) = Navigate(root, path);
                if (parent is JsonObject o) o[name] = node;
                else return Syntax;
                return Ok;
            }
            case "JSON.GET":
            {
                if (!JsonModule) return new Err("ERR unknown command 'JSON.GET'");
                if (db.Get(Arg(1)) is not { Value: JsonNode root }) return null;
                var path = a.Count > 2 ? Arg(2) : ".";
                if (path == "$") return new JsonArray(root.DeepClone()).ToJsonString();
                if (path == ".") return root.ToJsonString();
                var (parent, name) = Navigate(root, path);
                var value = parent is JsonObject o ? o[name] : null;
                return path.StartsWith('$') ? new JsonArray(value?.DeepClone()).ToJsonString() : value?.ToJsonString();
            }
            case "JSON.TYPE":
                return db.Get(Arg(1)) is { Value: JsonNode jn } ? jn.GetValueKind().ToString().ToLowerInvariant() : null;
            case "JSON.DEL": return db.Remove(Arg(1)) ? 1L : 0L;
        }
        return new Err($"ERR unknown command '{cmd}', with args beginning with: ");
    }

    private static (JsonNode? Parent, string Name) Navigate(JsonNode root, string path)
    {
        var parts = path.TrimStart('$', '.').Split('.', StringSplitOptions.RemoveEmptyEntries);
        JsonNode? cur = root;
        for (var i = 0; i < parts.Length - 1; i++) cur = cur?[parts[i]];
        return (cur, parts.Length > 0 ? parts[^1] : "");
    }

    private static double ParseScore(string s) => s switch
    {
        "+inf" or "inf" => double.PositiveInfinity,
        "-inf" => double.NegativeInfinity,
        _ => double.Parse(s, CultureInfo.InvariantCulture),
    };

    private static (int, int) Range(long start, long stop, int count)
    {
        if (start < 0) start = Math.Max(0, count + start);
        if (stop < 0) stop = count + stop;
        stop = Math.Min(stop, count - 1);
        return ((int)start, (int)stop);
    }

    private static T GetOrCreate<T>(FakeDb db, string key, Func<T> create) where T : class
    {
        if (db.Get(key) is { } e) return (T)e.Value;
        var v = create();
        db.Set(key, v);
        return v;
    }

    private static string TypeOf(FakeEntry? e) => e?.Value switch
    {
        null => "none",
        byte[] => "string",
        Dictionary<string, byte[]> => "hash",
        List<byte[]> => "list",
        HashSet<string> => "set",
        Dictionary<string, double> => "zset",
        FakeStream => "stream",
        JsonNode => "ReJSON-RL",
        _ => "none",
    };

    private static long SizeOf(object v) => v switch
    {
        byte[] b => b.Length,
        Dictionary<string, byte[]> h => h.Sum(kv => kv.Key.Length + kv.Value.Length + 16),
        List<byte[]> l => l.Sum(x => x.Length + 8),
        HashSet<string> s => s.Sum(x => x.Length + 8),
        Dictionary<string, double> z => z.Sum(kv => kv.Key.Length + 24),
        FakeStream st => st.Entries.Sum(e => 24 + e.Fields.Sum(f => f.F.Length + f.V.Length)),
        JsonNode j => j.ToJsonString().Length * 2,
        _ => 16,
    };

    private object? Set(FakeDb db, List<byte[]> a)
    {
        if (a.Count < 3) return Arity("set");
        var key = S(a[1]);
        DateTime? expires = null;
        bool nx = false, xx = false, keep = false, get = false;
        for (var i = 3; i < a.Count; i++)
        {
            switch (S(a[i]).ToUpperInvariant())
            {
                case "EX": expires = DateTime.UtcNow.AddSeconds(long.Parse(S(a[++i]), CultureInfo.InvariantCulture)); break;
                case "PX": expires = DateTime.UtcNow.AddMilliseconds(long.Parse(S(a[++i]), CultureInfo.InvariantCulture)); break;
                case "NX": nx = true; break;
                case "XX": xx = true; break;
                case "KEEPTTL": keep = true; break;
                case "GET": get = true; break;
                default: return Syntax;
            }
        }
        var existing = db.Get(key);
        if (existing is not null && existing.Value is not byte[] && get) return WrongType;
        var old = existing?.Value as byte[];
        if (nx && existing is not null || xx && existing is null) return get ? old : null;
        db.Set(key, a[2], keep ? existing?.ExpiresAt : expires);
        return get ? old : Ok;
    }

    private static object? Scan(FakeDb db, List<byte[]> a)
    {
        var cursor = int.Parse(S(a[1]), CultureInfo.InvariantCulture);
        string pattern = "*";
        var count = 10;
        string? type = null;
        for (var i = 2; i + 1 < a.Count; i += 2)
        {
            switch (S(a[i]).ToUpperInvariant())
            {
                case "MATCH": pattern = S(a[i + 1]); break;
                case "COUNT": count = int.Parse(S(a[i + 1]), CultureInfo.InvariantCulture); break;
                case "TYPE": type = S(a[i + 1]); break;
                default: return Syntax;
            }
        }
        var order = db.Order;
        var end = Math.Min(order.Count, cursor + count);
        var keys = new List<object?>();
        for (var i = cursor; i < end; i++)
        {
            var k = order[i];
            var e = db.Get(k);
            if (e is null || !Glob.IsMatch(pattern, k)) continue;
            if (type is not null && TypeOf(e) != type) continue;
            keys.Add(k);
        }
        return new object?[] { (end >= order.Count ? 0 : end).ToString(CultureInfo.InvariantCulture), keys };
    }

    private static (string Next, List<string> Items) ScanItems(List<string> all, List<byte[]> a, int from)
    {
        var cursor = int.Parse(S(a[from]), CultureInfo.InvariantCulture);
        string pattern = "*";
        var count = 10;
        for (var i = from + 1; i + 1 < a.Count; i += 2)
        {
            if (S(a[i]).Equals("MATCH", StringComparison.OrdinalIgnoreCase)) pattern = S(a[i + 1]);
            else if (S(a[i]).Equals("COUNT", StringComparison.OrdinalIgnoreCase)) count = int.Parse(S(a[i + 1]), CultureInfo.InvariantCulture);
        }
        var end = Math.Min(all.Count, cursor + count);
        var items = all.Skip(cursor).Take(end - cursor).Where(x => Glob.IsMatch(pattern, x)).ToList();
        return ((end >= all.Count ? 0 : end).ToString(CultureInfo.InvariantCulture), items);
    }

    private object? Client(Conn c, List<byte[]> a)
    {
        switch (S(a[1]).ToUpperInvariant())
        {
            case "SETNAME": c.Name = S(a[2]); return Ok;
            case "GETNAME": return c.Name;
            case "ID": return c.Id;
            case "SETINFO": return Ok;
            case "LIST":
                var sb = new StringBuilder();
                foreach (var x in Connections.OrderBy(x => x.Id))
                    sb.Append(CultureInfo.InvariantCulture,
                        $"id={x.Id} addr={x.Address} laddr=127.0.0.1:{Port} fd=8 name={x.Name} age={(int)(DateTime.UtcNow - x.Created).TotalSeconds} idle={(int)(DateTime.UtcNow - x.LastActive).TotalSeconds} flags={(x.Subscribed ? "P" : x.Monitoring ? "O" : "N")} db={x.Db} sub={x.Channels.Count} psub={x.Patterns.Count} cmd={x.LastCommand} user={x.User}\n");
                return sb.ToString();
            case "KILL":
                if (a.Count == 4 && S(a[2]).Equals("ID", StringComparison.OrdinalIgnoreCase))
                {
                    var target = long.Parse(S(a[3]), CultureInfo.InvariantCulture);
                    if (target == c.Id) { c.CloseAfterReply = true; return 1L; }
                    return Kill(target) ? 1L : 0L;
                }
                return Syntax;
        }
        return Syntax;
    }

    private object? ConfigCmd(List<byte[]> a)
    {
        switch (S(a[1]).ToUpperInvariant())
        {
            case "GET":
                return a.Skip(2).Select(S).SelectMany(p => Config.Where(kv => Glob.IsMatch(p, kv.Key))).Distinct()
                    .SelectMany(kv => new object?[] { kv.Key, kv.Value }).ToList();
            case "SET":
                for (var i = 2; i + 1 < a.Count; i += 2) Config[S(a[i])] = S(a[i + 1]);
                return Ok;
        }
        return Syntax;
    }

    private string Info(string? section)
    {
        var sb = new StringBuilder();
        void Section(string name, params (string K, object V)[] items)
        {
            if (section is not null && section != "all" && section != "everything" && section != name) return;
            sb.Append("# ").Append(char.ToUpperInvariant(name[0])).Append(name[1..]).Append("\r\n");
            foreach (var (k, v) in items) sb.Append(k).Append(':').Append(Convert.ToString(v, CultureInfo.InvariantCulture)).Append("\r\n");
            sb.Append("\r\n");
        }
        Section("server", ("redis_version", Version), ("redis_mode", "standalone"), ("os", "Fake"), ("tcp_port", Port), ("uptime_in_seconds", 3600),
            ("run_id", "0123456789abcdef0123456789abcdef01234567"));
        Section("clients", ("connected_clients", ConnectionCount), ("blocked_clients", 0));
        Section("memory", ("used_memory", 1_048_576), ("used_memory_human", "1.00M"), ("used_memory_peak", 2_097_152), ("mem_fragmentation_ratio", "1.12"),
            ("maxmemory", 0));
        Section("stats", ("total_commands_processed", CommandsProcessed), ("instantaneous_ops_per_sec", 42), ("keyspace_hits", 90), ("keyspace_misses", 10));
        Section("replication", ("role", "master"), ("connected_slaves", 0));
        var ks = new List<(string, object)>();
        for (var i = 0; i < Dbs.Length; i++)
        {
            var keys = Dbs[i].Data.Count;
            if (keys == 0) continue;
            var expires = Dbs[i].Data.Values.Count(e => e.ExpiresAt is not null);
            ks.Add(($"db{i}", $"keys={keys},expires={expires},avg_ttl=0"));
        }
        Section("keyspace", [.. ks]);
        return sb.ToString();
    }

    // ---------------------------------------------------------------- streams

    private static (ulong, ulong) ParseId(string s, ulong defaultSeq)
    {
        if (s == "-") return (0, 0);
        if (s == "+") return (ulong.MaxValue, ulong.MaxValue);
        var dash = s.IndexOf('-');
        return dash < 0
            ? (ulong.Parse(s, CultureInfo.InvariantCulture), defaultSeq)
            : (ulong.Parse(s[..dash], CultureInfo.InvariantCulture), ulong.Parse(s[(dash + 1)..], CultureInfo.InvariantCulture));
    }

    private static string Id((ulong Ms, ulong Seq) id) => $"{id.Ms}-{id.Seq}";

    private static object? XAdd(FakeDb db, List<byte[]> a)
    {
        var st = GetOrCreate(db, S(a[1]), () => new FakeStream());
        var idText = S(a[2]);
        (ulong, ulong) id;
        if (idText == "*")
        {
            var ms = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            id = ms > st.Last.Ms ? (ms, 0) : (st.Last.Ms, st.Last.Seq + 1);
        }
        else
        {
            id = ParseId(idText, 0);
            if (id.CompareTo(st.Last) <= 0) return new Err("ERR The ID specified in XADD is equal or smaller than the target stream top item");
        }
        var fields = new List<(string, string)>();
        for (var i = 3; i + 1 < a.Count; i += 2) fields.Add((S(a[i]), S(a[i + 1])));
        if (fields.Count == 0) return Arity("xadd");
        st.Entries.Add((id.Item1, id.Item2, fields));
        st.Last = id;
        return Id(id);
    }

    private static object? Entry((ulong Ms, ulong Seq, List<(string F, string V)> Fields) e) =>
        new object?[] { Id((e.Ms, e.Seq)), e.Fields.SelectMany(f => new object?[] { f.F, f.V }).ToList() };

    private static object? XRange(FakeDb db, string cmd, List<byte[]> a)
    {
        if (db.Get(S(a[1])) is not { Value: FakeStream st }) return new List<object?>();
        var rev = cmd == "XREVRANGE";
        var lo = ParseId(S(a[rev ? 3 : 2]), 0);
        var hi = ParseId(S(a[rev ? 2 : 3]), ulong.MaxValue);
        var count = a.Count > 5 && S(a[4]).Equals("COUNT", StringComparison.OrdinalIgnoreCase) ? int.Parse(S(a[5]), CultureInfo.InvariantCulture) : int.MaxValue;
        var range = st.Entries.Where(e => (e.Ms, e.Seq).CompareTo(lo) >= 0 && (e.Ms, e.Seq).CompareTo(hi) <= 0);
        if (rev) range = range.Reverse();
        return range.Take(count).Select(Entry).ToList();
    }

    private static object? XGroup(FakeDb db, List<byte[]> a)
    {
        var sub = S(a[1]).ToUpperInvariant();
        var key = S(a[2]);
        var mk = a.Skip(5).Any(x => S(x).Equals("MKSTREAM", StringComparison.OrdinalIgnoreCase));
        if (db.Get(key) is not { Value: FakeStream st })
        {
            if (sub == "CREATE" && mk) st = GetOrCreate(db, key, () => new FakeStream());
            else return new Err("ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.");
        }
        switch (sub)
        {
            case "CREATE":
                if (st.Groups.ContainsKey(S(a[3]))) return new Err("BUSYGROUP Consumer Group name already exists");
                var idText = S(a[4]);
                st.Groups[S(a[3])] = new FakeGroup { LastDelivered = idText == "$" ? st.Last : ParseId(idText, 0) };
                return Ok;
            case "DESTROY": return st.Groups.Remove(S(a[3])) ? 1L : 0L;
        }
        return Syntax;
    }

    private static object? XInfo(FakeDb db, List<byte[]> a)
    {
        var sub = S(a[1]).ToUpperInvariant();
        if (db.Get(S(a[2])) is not { Value: FakeStream st }) return new Err("ERR no such key");
        switch (sub)
        {
            case "GROUPS":
                return st.Groups.Select(g => (object?)new object?[]
                {
                    "name", g.Key, "consumers", (long)g.Value.Consumers.Count, "pending", (long)g.Value.Pending.Count,
                    "last-delivered-id", Id(g.Value.LastDelivered), "entries-read", null,
                    "lag", (long)st.Entries.Count(e => (e.Ms, e.Seq).CompareTo(g.Value.LastDelivered) > 0),
                }).ToList();
            case "CONSUMERS":
                if (!st.Groups.TryGetValue(S(a[3]), out var grp)) return new Err("NOGROUP No such consumer group");
                return grp.Consumers.Select(c => (object?)new object?[]
                {
                    "name", c.Key, "pending", (long)grp.Pending.Count(p => p.Value.Consumer == c.Key),
                    "idle", (long)(DateTime.UtcNow - c.Value).TotalMilliseconds, "inactive", (long)(DateTime.UtcNow - c.Value).TotalMilliseconds,
                }).ToList();
            case "STREAM":
                return new object?[] { "length", (long)st.Entries.Count, "groups", (long)st.Groups.Count, "last-generated-id", Id(st.Last) };
        }
        return Syntax;
    }

    private static object? XReadGroup(FakeDb db, List<byte[]> a)
    {
        // XREADGROUP GROUP g consumer [COUNT n] STREAMS key >
        var group = S(a[2]);
        var consumer = S(a[3]);
        var count = int.MaxValue;
        var i = 4;
        for (; i < a.Count; i++)
        {
            var w = S(a[i]).ToUpperInvariant();
            if (w == "COUNT") count = int.Parse(S(a[++i]), CultureInfo.InvariantCulture);
            else if (w == "STREAMS") break;
        }
        var key = S(a[i + 1]);
        if (db.Get(key) is not { Value: FakeStream st } || !st.Groups.TryGetValue(group, out var g)) return new Err("NOGROUP No such key or consumer group");
        g.Consumers[consumer] = DateTime.UtcNow;
        var fresh = st.Entries.Where(e => (e.Ms, e.Seq).CompareTo(g.LastDelivered) > 0).Take(count).ToList();
        foreach (var e in fresh)
        {
            g.Pending[(e.Ms, e.Seq)] = (consumer, DateTime.UtcNow, 1);
            g.LastDelivered = (e.Ms, e.Seq);
        }
        if (fresh.Count == 0) return NullArray.Instance;
        return new object?[] { new object?[] { key, fresh.Select(Entry).ToList() } };
    }
}
