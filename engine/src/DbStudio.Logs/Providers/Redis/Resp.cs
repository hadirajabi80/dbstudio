using System.Globalization;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;

namespace DbStudio.Logs.Providers.Redis;

/// <summary>A RESP2 reply (RESP3 maps/sets are not requested: the connection never sends HELLO 3).</summary>
public sealed record RespValue(RespType Type, string? Text = null, long Integer = 0, IReadOnlyList<RespValue>? Items = null)
{
    public static readonly RespValue Null = new(RespType.Null);

    public bool IsNull => Type == RespType.Null;
    public bool IsError => Type == RespType.Error;
    public IReadOnlyList<RespValue> Array => Items ?? [];

    /// <summary>Text of a simple/bulk string, the decimal text of an integer, null otherwise.</summary>
    public string? AsString() => Type switch
    {
        RespType.Simple or RespType.Bulk or RespType.Error => Text,
        RespType.Integer => Integer.ToString(CultureInfo.InvariantCulture),
        _ => null,
    };

    public long? AsLong() => Type == RespType.Integer ? Integer
        : long.TryParse(AsString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;

    public static RespValue Str(string s) => new(RespType.Bulk, s);
    public static RespValue Int(long v) => new(RespType.Integer, Integer: v);
    public static RespValue Arr(params RespValue[] items) => new(RespType.Array, Items: items);
    public static RespValue Err(string message) => new(RespType.Error, message);
}

public enum RespType { Simple, Error, Integer, Bulk, Array, Null }

/// <summary>RESP2 encoder/decoder.</summary>
public static class Resp
{
    /// <summary>A command as an array of bulk strings.</summary>
    public static byte[] Encode(IReadOnlyList<string> args)
    {
        var sb = new StringBuilder();
        sb.Append('*').Append(args.Count.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        var ms = new MemoryStream();
        ms.Write(Encoding.UTF8.GetBytes(sb.ToString()));
        foreach (var a in args)
        {
            var bytes = Encoding.UTF8.GetBytes(a);
            ms.Write(Encoding.ASCII.GetBytes($"${bytes.Length}\r\n"));
            ms.Write(bytes);
            ms.Write("\r\n"u8);
        }
        return ms.ToArray();
    }

    /// <summary>Encodes a reply (fake servers and fixtures).</summary>
    public static byte[] EncodeReply(RespValue v)
    {
        var ms = new MemoryStream();
        Write(ms, v);
        return ms.ToArray();
    }

    private static void Write(MemoryStream ms, RespValue v)
    {
        switch (v.Type)
        {
            case RespType.Simple: ms.Write(Encoding.UTF8.GetBytes($"+{v.Text}\r\n")); break;
            case RespType.Error: ms.Write(Encoding.UTF8.GetBytes($"-{v.Text}\r\n")); break;
            case RespType.Integer: ms.Write(Encoding.ASCII.GetBytes($":{v.Integer.ToString(CultureInfo.InvariantCulture)}\r\n")); break;
            case RespType.Null: ms.Write("$-1\r\n"u8); break;
            case RespType.Bulk:
                var b = Encoding.UTF8.GetBytes(v.Text ?? "");
                ms.Write(Encoding.ASCII.GetBytes($"${b.Length}\r\n"));
                ms.Write(b);
                ms.Write("\r\n"u8);
                break;
            case RespType.Array:
                ms.Write(Encoding.ASCII.GetBytes($"*{v.Array.Count}\r\n"));
                foreach (var i in v.Array) Write(ms, i);
                break;
        }
    }

    /// <summary>Parses one complete reply from a recorded fixture (e.g. a captured SLOWLOG GET).</summary>
    public static RespValue Parse(string text) => ReadAsync(new RespReader(new MemoryStream(Encoding.UTF8.GetBytes(text))), CancellationToken.None).GetAwaiter().GetResult();

    public static async Task<RespValue> ReadAsync(RespReader reader, CancellationToken ct)
    {
        var line = await reader.ReadLineAsync(ct).ConfigureAwait(false) ?? throw new IOException("The Redis server closed the connection.");
        if (line.Length == 0) throw new IOException("Empty RESP line.");
        var body = line[1..];
        switch (line[0])
        {
            case '+': return new RespValue(RespType.Simple, body);
            case '-': return new RespValue(RespType.Error, body);
            case ':': return new RespValue(RespType.Integer, Integer: long.Parse(body, CultureInfo.InvariantCulture));
            case '$':
            {
                var len = int.Parse(body, CultureInfo.InvariantCulture);
                if (len < 0) return RespValue.Null;
                var bytes = await reader.ReadBytesAsync(len + 2, ct).ConfigureAwait(false);
                return new RespValue(RespType.Bulk, Encoding.UTF8.GetString(bytes, 0, len));
            }
            case '*':
            {
                var n = int.Parse(body, CultureInfo.InvariantCulture);
                if (n < 0) return RespValue.Null;
                var items = new RespValue[n];
                for (var i = 0; i < n; i++) items[i] = await ReadAsync(reader, ct).ConfigureAwait(false);
                return new RespValue(RespType.Array, Items: items);
            }
            default:
                throw new IOException($"Unexpected RESP type '{line[0]}'.");
        }
    }
}

/// <summary>Buffered line/byte reader over a network stream.</summary>
public sealed class RespReader(Stream stream)
{
    private readonly byte[] _buf = new byte[16 * 1024];
    private int _pos, _len;

    private async ValueTask<bool> FillAsync(CancellationToken ct)
    {
        if (_pos > 0 && _pos == _len) _pos = _len = 0;
        if (_len == _buf.Length)
        {
            if (_pos == 0) return true;
            System.Array.Copy(_buf, _pos, _buf, 0, _len - _pos);
            _len -= _pos;
            _pos = 0;
        }
        var n = await stream.ReadAsync(_buf.AsMemory(_len), ct).ConfigureAwait(false);
        if (n == 0) return false;
        _len += n;
        return true;
    }

    public async ValueTask<string?> ReadLineAsync(CancellationToken ct)
    {
        var sb = new List<byte>();
        while (true)
        {
            for (var i = _pos; i < _len; i++)
            {
                if (_buf[i] != (byte)'\n') continue;
                sb.AddRange(new ArraySegment<byte>(_buf, _pos, i - _pos));
                _pos = i + 1;
                if (sb.Count > 0 && sb[^1] == (byte)'\r') sb.RemoveAt(sb.Count - 1);
                return Encoding.UTF8.GetString(sb.ToArray());
            }
            sb.AddRange(new ArraySegment<byte>(_buf, _pos, _len - _pos));
            _pos = _len;
            if (!await FillAsync(ct).ConfigureAwait(false)) return sb.Count == 0 ? null : Encoding.UTF8.GetString(sb.ToArray());
        }
    }

    public async ValueTask<byte[]> ReadBytesAsync(int count, CancellationToken ct)
    {
        var result = new byte[count];
        var done = 0;
        while (done < count)
        {
            if (_pos == _len && !await FillAsync(ct).ConfigureAwait(false)) throw new IOException("The Redis server closed the connection.");
            var n = Math.Min(count - done, _len - _pos);
            System.Array.Copy(_buf, _pos, result, done, n);
            _pos += n;
            done += n;
        }
        return result;
    }
}

/// <summary>Thrown for a RESP error reply ("-NOPERM ...", "-ERR unknown command ...").</summary>
public sealed class RedisReplyException(string message) : Exception(message)
{
    /// <summary>First word of the error ("NOPERM", "ERR", "WRONGPASS"...).</summary>
    public string Prefix => Message.Split(' ', 2)[0];
    public bool IsPermission => Prefix is "NOPERM" or "NOAUTH" || Message.Contains("no permissions", StringComparison.OrdinalIgnoreCase);
    public bool IsUnknownCommand => Message.Contains("unknown command", StringComparison.OrdinalIgnoreCase) || Message.Contains("unknown subcommand", StringComparison.OrdinalIgnoreCase);
}

/// <summary>Where and how to connect to one Redis node.</summary>
public sealed record RedisEndpoint(string Host, int Port, string? User, string? Password, bool Tls, bool TlsSkipVerify, TimeSpan ConnectTimeout)
{
    public string Address => $"{Host}:{Port}";
}

/// <summary>One raw RESP2 connection (logs and activity use their own small connections; MONITOR needs a dedicated one).</summary>
public sealed class RespConnection : IAsyncDisposable
{
    private readonly TcpClient _tcp;
    private readonly Stream _stream;
    private readonly RespReader _reader;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public RedisEndpoint Endpoint { get; }
    public bool Broken { get; private set; }

    private RespConnection(RedisEndpoint endpoint, TcpClient tcp, Stream stream)
    {
        Endpoint = endpoint;
        _tcp = tcp;
        _stream = stream;
        _reader = new RespReader(stream);
    }

    public static async Task<RespConnection> OpenAsync(RedisEndpoint ep, CancellationToken ct)
    {
        var tcp = new TcpClient { NoDelay = true };
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeout.CancelAfter(ep.ConnectTimeout);
            try
            {
                await tcp.ConnectAsync(ep.Host, ep.Port, timeout.Token).ConfigureAwait(false);
            }
            catch
            {
                tcp.Dispose();
                throw;
            }
        }
        Stream stream = tcp.GetStream();
        if (ep.Tls)
        {
            var ssl = new SslStream(stream, false, ep.TlsSkipVerify ? (_, _, _, _) => true : null);
            await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = ep.Host }, ct).ConfigureAwait(false);
            stream = ssl;
        }
        var c = new RespConnection(ep, tcp, stream);
        try
        {
            if (!string.IsNullOrEmpty(ep.Password))
            {
                var auth = string.IsNullOrEmpty(ep.User) ? new[] { "AUTH", ep.Password } : new[] { "AUTH", ep.User, ep.Password };
                await c.ExecuteAsync(auth, ct).ConfigureAwait(false);
            }
            await c.ExecuteAsync(["CLIENT", "SETNAME", "DbStudio-logs"], ct).ConfigureAwait(false);
        }
        catch (RedisReplyException ex) when (ex.IsUnknownCommand)
        {
            // CLIENT SETNAME renamed/disabled: not fatal.
        }
        catch
        {
            await c.DisposeAsync().ConfigureAwait(false);
            throw;
        }
        return c;
    }

    /// <summary>Sends one command and reads its reply; error replies throw <see cref="RedisReplyException"/>.</summary>
    public async Task<RespValue> ExecuteAsync(IReadOnlyList<string> args, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(Resp.Encode(args), ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
            var reply = await Resp.ReadAsync(_reader, ct).ConfigureAwait(false);
            if (reply.IsError) throw new RedisReplyException(reply.Text ?? "ERR");
            return reply;
        }
        catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException)
        {
            Broken = true;
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Starts MONITOR and yields each pushed line ("1697461331.123456 [0 127.0.0.1:5000] \"GET\" \"k\"").</summary>
    public async IAsyncEnumerable<string> MonitorAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        await ExecuteAsync(["MONITOR"], ct).ConfigureAwait(false);
        while (!ct.IsCancellationRequested)
        {
            var v = await Resp.ReadAsync(_reader, ct).ConfigureAwait(false);
            if (v.AsString() is { } s) yield return s;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { await _stream.DisposeAsync().ConfigureAwait(false); } catch (IOException) { }
        _tcp.Dispose();
        _gate.Dispose();
    }
}
