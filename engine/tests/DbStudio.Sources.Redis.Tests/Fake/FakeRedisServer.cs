using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace DbStudio.Sources.Redis.Tests.Fake;

/// <summary>Simple-string reply (<c>+OK</c>).</summary>
internal sealed record Simple(string Text);

/// <summary>Error reply (<c>-ERR ...</c>).</summary>
internal sealed record Err(string Text);

/// <summary>Null array reply (<c>*-1</c>).</summary>
internal sealed class NullArray
{
    public static readonly NullArray Instance = new();
}

/// <summary>
/// A RESP2 Redis server on loopback TCP for engine tests without Docker (docs/PLAN-M2.md 5.6, D11). StackExchange.Redis
/// connects to it like to a real server (handshake: AUTH, CLIENT SETNAME/SETINFO, CONFIG GET, INFO, CLUSTER NODES →
/// error, tie-breaker GET, SUBSCRIBE on the subscription connection). Implements the commands the Redis package uses
/// plus MULTI/EXEC, BLPOP, MONITOR, pub/sub, SLOWLOG, CLIENT LIST/KILL, ACL users (NOPERM) and a simulated RedisJSON.
/// </summary>
internal sealed partial class FakeRedisServer : IAsyncDisposable
{
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<long, Conn> _conns = new();
    private readonly Task _accept;
    private long _nextClientId;
    internal readonly object Gate = new();

    public FakeRedisServer(string? password = null, string version = "7.2.4", bool jsonModule = true)
    {
        Password = password;
        Version = version;
        JsonModule = jsonModule;
        for (var i = 0; i < Dbs.Length; i++) Dbs[i] = new FakeDb();
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _accept = Task.Run(AcceptLoopAsync);
    }

    public int Port { get; }
    public string Host => "127.0.0.1";
    public string? Password { get; }
    public string Version { get; }
    public bool JsonModule { get; set; }
    public FakeDb[] Dbs { get; } = new FakeDb[16];

    /// <summary>ACL users: name → (password, allowed command names upper case; null = all).</summary>
    public Dictionary<string, (string Password, HashSet<string>? Allowed)> Users { get; } = new(StringComparer.Ordinal);

    public List<object?[]> Slowlog { get; } = [];
    public Dictionary<string, string> Config { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["databases"] = "16", ["slowlog-log-slower-than"] = "10000", ["slowlog-max-len"] = "128", ["maxmemory"] = "0",
        ["maxmemory-policy"] = "noeviction", ["timeout"] = "0", ["appendonly"] = "no",
    };

    /// <summary>Every command name received (upper case), for assertions.</summary>
    public ConcurrentQueue<string> Received { get; } = new();

    public long CommandsProcessed;

    public int ConnectionCount => _conns.Count;

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient tcp;
            try
            {
                tcp = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }
            catch (SocketException)
            {
                continue;
            }
            var id = Interlocked.Increment(ref _nextClientId);
            var conn = new Conn(this, id, tcp);
            _conns[id] = conn;
            _ = Task.Run(() => conn.RunAsync(_stop.Token));
        }
    }

    internal void Remove(Conn c) => _conns.TryRemove(c.Id, out _);

    internal IEnumerable<Conn> Connections => _conns.Values;

    /// <summary>Test hook: closes every connection (simulates a server restart for reconnect tests).</summary>
    public void DropConnections()
    {
        foreach (var c in _conns.Values) c.Close();
    }

    public bool Kill(long id)
    {
        if (!_conns.TryGetValue(id, out var c)) return false;
        c.Close();
        return true;
    }

    // ------------------------------------------------------------- pub/sub + monitor

    internal int Publish(string channel, byte[] payload)
    {
        var n = 0;
        foreach (var c in _conns.Values)
        {
            if (c.Channels.Contains(channel))
            {
                c.Send(new object?[] { "message", channel, payload });
                n++;
            }
            foreach (var p in c.Patterns)
            {
                if (!Glob.IsMatch(p, channel)) continue;
                c.Send(new object?[] { "pmessage", p, channel, payload });
                n++;
            }
        }
        return n;
    }

    internal void FeedMonitors(Conn from, IReadOnlyList<byte[]> args)
    {
        if (_conns.Values.All(c => !c.Monitoring)) return;
        var line = MonitorLine(from.Db, from.Address, args);
        foreach (var c in _conns.Values)
            if (c.Monitoring && c != from) c.Send(new Simple(line));
    }

    internal static string MonitorLine(int db, string addr, IReadOnlyList<byte[]> args)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000m;
        var sb = new StringBuilder();
        sb.Append(ts.ToString("0.000000", CultureInfo.InvariantCulture)).Append(" [").Append(db).Append(' ').Append(addr).Append(']');
        foreach (var a in args) sb.Append(' ').Append(RedisArgs.Quote(a));
        return sb.ToString();
    }

    /// <summary>Test hook: writes <paramref name="count"/> synthetic MONITOR lines to every monitoring connection.</summary>
    /// <summary>
    /// Sends <paramref name="count"/> MONITOR lines to every monitoring connection, written in 64 KB chunks like a busy
    /// server's socket buffer (one socket write per line made the fake, not the engine, the bottleneck of throughput tests).
    /// </summary>
    public void FloodMonitors(int count)
    {
        var monitors = _conns.Values.Where(c => c.Monitoring).ToList();
        var chunk = new MemoryStream();
        for (var i = 0; i < count; i++)
        {
            var line = MonitorLine(0, "127.0.0.1:9999", [Encoding.ASCII.GetBytes("SET"), Encoding.ASCII.GetBytes($"k:{i}"), Encoding.ASCII.GetBytes("v")]);
            Resp.Write(chunk, new Simple(line));
            if (chunk.Length < 64 * 1024 && i < count - 1) continue;
            foreach (var m in monitors) m.SendRaw(chunk.GetBuffer(), (int)chunk.Length);
            chunk.SetLength(0);
        }
    }

    public int Monitors => _conns.Values.Count(c => c.Monitoring);

    public int Subscriptions => _conns.Values.Sum(c => c.Channels.Count + c.Patterns.Count);

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _listener.Stop();
        foreach (var c in _conns.Values) c.Close();
        try
        {
            await _accept;
        }
        catch (Exception)
        {
        }
        _stop.Dispose();
    }

    // ------------------------------------------------------------- connection

    internal sealed class Conn
    {
        private readonly FakeRedisServer _server;
        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private readonly object _writeGate = new();
        private readonly byte[] _buf = new byte[64 * 1024];
        private int _start, _end;

        public Conn(FakeRedisServer server, long id, TcpClient tcp)
        {
            _server = server;
            Id = id;
            _tcp = tcp;
            _tcp.NoDelay = true;
            _stream = tcp.GetStream();
            Address = tcp.Client.RemoteEndPoint?.ToString() ?? "?";
            Authenticated = server.Password is null;
            User = "default";
        }

        public long Id { get; }
        public string Address { get; }
        public string? Name;
        public string User;
        public int Db;
        public bool Authenticated;
        public bool Monitoring;
        public string LastCommand = "NULL";
        public readonly DateTime Created = DateTime.UtcNow;
        public DateTime LastActive = DateTime.UtcNow;
        public readonly HashSet<string> Channels = new(StringComparer.Ordinal);
        public readonly HashSet<string> Patterns = new(StringComparer.Ordinal);
        public List<List<byte[]>>? Multi;
        public bool CloseAfterReply;
        private bool _closed;

        public bool Subscribed => Channels.Count + Patterns.Count > 0;

        public void Close()
        {
            _closed = true;
            try
            {
                _tcp.Client.Shutdown(SocketShutdown.Both);
            }
            catch (Exception)
            {
            }
            _tcp.Dispose();
        }

        public async Task RunAsync(CancellationToken ct)
        {
            try
            {
                while (!ct.IsCancellationRequested && !_closed)
                {
                    var args = await ReadCommandAsync(ct);
                    if (args is null) break;
                    if (args.Count == 0) continue;
                    LastActive = DateTime.UtcNow;
                    var reply = _server.Dispatch(this, args);
                    if (reply is Quit) { Send(new Simple("OK")); break; }
                    if (reply is not NoReply) Send(reply);
                    if (CloseAfterReply) break;
                }
            }
            catch (Exception)
            {
                // connection reset / server stopped
            }
            finally
            {
                _server.Remove(this);
                Close();
            }
        }

        public void SendRaw(byte[] buffer, int length)
        {
            if (_closed) return;
            lock (_writeGate)
            {
                try
                {
                    _stream.Write(buffer, 0, length);
                }
                catch (Exception)
                {
                    _closed = true;
                }
            }
        }

        public void Send(object? reply)
        {
            if (_closed) return;
            var ms = new MemoryStream();
            Resp.Write(ms, reply);
            lock (_writeGate)
            {
                try
                {
                    _stream.Write(ms.GetBuffer(), 0, (int)ms.Length);
                }
                catch (Exception)
                {
                    _closed = true;
                }
            }
        }

        private async Task<List<byte[]>?> ReadCommandAsync(CancellationToken ct)
        {
            var line = await ReadLineAsync(ct);
            if (line is null) return null;
            if (line.Length == 0) return [];
            if (line[0] != '*') return RedisArgs.Parse(line); // inline command
            var n = int.Parse(Encoding.ASCII.GetString(line, 1, line.Length - 1), CultureInfo.InvariantCulture);
            var args = new List<byte[]>(n);
            for (var i = 0; i < n; i++)
            {
                var hdr = await ReadLineAsync(ct) ?? throw new IOException("eof");
                var len = int.Parse(Encoding.ASCII.GetString(hdr, 1, hdr.Length - 1), CultureInfo.InvariantCulture);
                var data = await ReadExactAsync(len + 2, ct);
                args.Add(data[..len]);
            }
            return args;
        }

        private async Task<byte[]?> ReadLineAsync(CancellationToken ct)
        {
            while (true)
            {
                var span = _buf.AsSpan(_start, _end - _start);
                var lf = span.IndexOf((byte)'\n');
                if (lf >= 0)
                {
                    var len = lf > 0 && span[lf - 1] == '\r' ? lf - 1 : lf;
                    var line = span[..len].ToArray();
                    _start += lf + 1;
                    return line;
                }
                Compact();
                if (_end == _buf.Length) throw new IOException("line too long");
                var r = await _stream.ReadAsync(_buf.AsMemory(_end), ct);
                if (r == 0) return null;
                _end += r;
            }
        }

        private async Task<byte[]> ReadExactAsync(int count, CancellationToken ct)
        {
            var result = new byte[count];
            var copied = 0;
            while (copied < count)
            {
                if (_end == _start)
                {
                    Compact();
                    var r = await _stream.ReadAsync(_buf.AsMemory(_end), ct);
                    if (r == 0) throw new IOException("eof");
                    _end += r;
                }
                var take = Math.Min(count - copied, _end - _start);
                Buffer.BlockCopy(_buf, _start, result, copied, take);
                _start += take;
                copied += take;
            }
            return result;
        }

        private void Compact()
        {
            var live = _end - _start;
            if (_start > 0 && live > 0) Buffer.BlockCopy(_buf, _start, _buf, 0, live);
            _start = 0;
            _end = live;
        }
    }

    internal sealed class Quit
    {
        public static readonly Quit Instance = new();
    }

    internal sealed class NoReply
    {
        public static readonly NoReply Instance = new();
    }

    // ------------------------------------------------------------- RESP writer

    internal static class Resp
    {
        public static void Write(Stream s, object? r)
        {
            switch (r)
            {
                case null: Ascii(s, "$-1\r\n"); break;
                case NullArray: Ascii(s, "*-1\r\n"); break;
                case Simple x: Ascii(s, $"+{x.Text}\r\n"); break;
                case Err x: Ascii(s, $"-{x.Text}\r\n"); break;
                case int i: Ascii(s, $":{i}\r\n"); break;
                case long l: Ascii(s, $":{l}\r\n"); break;
                case bool b: Ascii(s, b ? ":1\r\n" : ":0\r\n"); break;
                case double d: Bulk(s, Encoding.ASCII.GetBytes(FormatDouble(d))); break;
                case string str: Bulk(s, Encoding.UTF8.GetBytes(str)); break;
                case byte[] bytes: Bulk(s, bytes); break;
                case System.Collections.IEnumerable list:
                {
                    var items = list.Cast<object?>().ToList();
                    Ascii(s, $"*{items.Count}\r\n");
                    foreach (var item in items) Write(s, item);
                    break;
                }
                default: Bulk(s, Encoding.UTF8.GetBytes(r.ToString() ?? "")); break;
            }
        }

        public static string FormatDouble(double d) =>
            double.IsPositiveInfinity(d) ? "inf" : double.IsNegativeInfinity(d) ? "-inf" : d.ToString("R", CultureInfo.InvariantCulture);

        private static void Bulk(Stream s, byte[] b)
        {
            Ascii(s, $"${b.Length}\r\n");
            s.Write(b);
            Ascii(s, "\r\n");
        }

        private static void Ascii(Stream s, string text) => s.Write(Encoding.UTF8.GetBytes(text));
    }
}

/// <summary>Redis glob patterns (<c>* ? [abc] [^a] [a-z] \x</c>).</summary>
internal static class Glob
{
    public static bool IsMatch(string pattern, string text) => Match(pattern.AsSpan(), text.AsSpan());

    private static bool Match(ReadOnlySpan<char> p, ReadOnlySpan<char> s)
    {
        while (p.Length > 0)
        {
            switch (p[0])
            {
                case '*':
                    while (p.Length > 1 && p[1] == '*') p = p[1..];
                    if (p.Length == 1) return true;
                    for (var i = 0; i <= s.Length; i++)
                        if (Match(p[1..], s[i..])) return true;
                    return false;
                case '?':
                    if (s.Length == 0) return false;
                    s = s[1..];
                    p = p[1..];
                    break;
                case '[':
                {
                    if (s.Length == 0) return false;
                    var close = p.IndexOf(']');
                    if (close < 0) goto default;
                    var set = p[1..close];
                    var negate = set.Length > 0 && set[0] == '^';
                    if (negate) set = set[1..];
                    var hit = false;
                    for (var i = 0; i < set.Length; i++)
                    {
                        if (set[i] == '\\' && i + 1 < set.Length) { if (set[++i] == s[0]) hit = true; }
                        else if (i + 2 < set.Length && set[i + 1] == '-') { if (s[0] >= set[i] && s[0] <= set[i + 2]) hit = true; i += 2; }
                        else if (set[i] == s[0]) hit = true;
                    }
                    if (hit == negate) return false;
                    s = s[1..];
                    p = p[(close + 1)..];
                    break;
                }
                case '\\' when p.Length > 1:
                    if (s.Length == 0 || s[0] != p[1]) return false;
                    s = s[1..];
                    p = p[2..];
                    break;
                default:
                    if (s.Length == 0 || s[0] != p[0]) return false;
                    s = s[1..];
                    p = p[1..];
                    break;
            }
        }
        return s.Length == 0;
    }
}
