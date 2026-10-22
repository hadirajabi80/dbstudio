using System.Buffers;
using System.Globalization;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Redis;

public enum RespType { Simple, Error, Integer, Bulk, Array, Null }

/// <summary>One RESP2 reply.</summary>
public sealed record RespValue(RespType Type, byte[]? Bytes = null, long Integer = 0, IReadOnlyList<RespValue>? Items = null)
{
    public static readonly RespValue NullValue = new(RespType.Null);

    public string? Text => Bytes is null ? Type == RespType.Integer ? Integer.ToString(CultureInfo.InvariantCulture) : null : Encoding.UTF8.GetString(Bytes);

    public bool IsError => Type == RespType.Error;
}

/// <summary>
/// A dedicated RESP2 connection outside the shared multiplexer, for what must not run on a shared pipe: MONITOR,
/// MULTI/EXEC transactions, WATCH, and blocking commands (BLPOP, XREAD BLOCK...). Authenticates like the profile
/// (ACL user + password, TLS) and selects the database.
/// </summary>
public sealed class RawRedisConnection : IAsyncDisposable
{
    private readonly TcpClient _tcp;
    private readonly Stream _stream;
    private readonly byte[] _buffer = new byte[64 * 1024];
    private int _start;
    private int _end;

    private RawRedisConnection(TcpClient tcp, Stream stream)
    {
        _tcp = tcp;
        _stream = stream;
    }

    public string EndPoint { get; private init; } = "";

    public static async Task<RawRedisConnection> OpenAsync(string host, int port, RedisSettings settings, int database, CancellationToken ct)
    {
        var tcp = new TcpClient { NoDelay = true };
        try
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                timeout.CancelAfter(TimeSpan.FromSeconds(settings.ConnectTimeoutSeconds));
                try
                {
                    await tcp.ConnectAsync(host, port, timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw EngineException.SourceUnavailable($"Timed out connecting to {host}:{port}.");
                }
                catch (SocketException ex)
                {
                    throw EngineException.SourceUnavailable($"Cannot connect to {host}:{port}: {ex.Message}");
                }
            }
            Stream stream = tcp.GetStream();
            if (settings.Tls)
            {
                var ssl = new SslStream(stream, false, settings.TlsSkipVerify ? (_, _, _, _) => true : null);
                await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = host }, ct).ConfigureAwait(false);
                stream = ssl;
            }
            var conn = new RawRedisConnection(tcp, stream) { EndPoint = $"{host}:{port}" };
            if (settings.Password is not null)
            {
                var auth = settings.User is null
                    ? await conn.CommandAsync(["AUTH", settings.Password], ct).ConfigureAwait(false)
                    : await conn.CommandAsync(["AUTH", settings.User, settings.Password], ct).ConfigureAwait(false);
                if (auth.IsError) throw RedisErrors.FromServerError(auth.Text ?? "AUTH failed", "auth");
            }
            await conn.CommandAsync(["CLIENT", "SETNAME", "Rowlit-dedicated"], ct).ConfigureAwait(false);
            if (database != 0)
            {
                var sel = await conn.CommandAsync(["SELECT", database.ToString(CultureInfo.InvariantCulture)], ct).ConfigureAwait(false);
                if (sel.IsError) throw RedisErrors.FromServerError(sel.Text ?? "SELECT failed", "select");
            }
            return conn;
        }
        catch
        {
            tcp.Dispose();
            throw;
        }
    }

    public Task<RespValue> CommandAsync(IReadOnlyList<string> args, CancellationToken ct) =>
        CommandAsync(args.Select(a => Encoding.UTF8.GetBytes(a)).ToList(), ct);

    public async Task<RespValue> CommandAsync(IReadOnlyList<byte[]> args, CancellationToken ct)
    {
        await SendAsync(args, ct).ConfigureAwait(false);
        return await ReadAsync(ct).ConfigureAwait(false);
    }

    public async Task SendAsync(IReadOnlyList<byte[]> args, CancellationToken ct)
    {
        var size = 16 + args.Sum(a => a.Length + 16);
        var buf = ArrayPool<byte>.Shared.Rent(size);
        try
        {
            var n = 0;
            n += WriteHeader(buf, n, '*', args.Count);
            foreach (var a in args)
            {
                n += WriteHeader(buf, n, '$', a.Length);
                a.CopyTo(buf, n);
                n += a.Length;
                buf[n++] = (byte)'\r';
                buf[n++] = (byte)'\n';
            }
            await _stream.WriteAsync(buf.AsMemory(0, n), ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buf);
        }
    }

    private static int WriteHeader(byte[] buf, int at, char prefix, int value)
    {
        var text = $"{prefix}{value.ToString(CultureInfo.InvariantCulture)}\r\n";
        return Encoding.ASCII.GetBytes(text, 0, text.Length, buf, at);
    }

    /// <summary>Reads one complete reply (nested arrays included).</summary>
    public async Task<RespValue> ReadAsync(CancellationToken ct)
    {
        var line = await ReadLineAsync(ct).ConfigureAwait(false);
        if (line.Length == 0) throw new IOException("Protocol error: empty reply line.");
        var prefix = (char)line[0];
        var body = line.AsSpan(1);
        switch (prefix)
        {
            case '+': return new RespValue(RespType.Simple, body.ToArray());
            case '-': return new RespValue(RespType.Error, body.ToArray());
            case ':': return new RespValue(RespType.Integer, Integer: ParseLong(body));
            case '$':
            {
                var len = ParseLong(body);
                if (len < 0) return RespValue.NullValue;
                var bytes = await ReadExactAsync((int)len, ct).ConfigureAwait(false);
                await ReadExactAsync(2, ct).ConfigureAwait(false);
                return new RespValue(RespType.Bulk, bytes);
            }
            case '*':
            {
                var count = ParseLong(body);
                if (count < 0) return RespValue.NullValue;
                var items = new List<RespValue>((int)Math.Min(count, 10_000));
                for (var i = 0; i < count; i++) items.Add(await ReadAsync(ct).ConfigureAwait(false));
                return new RespValue(RespType.Array, Items: items);
            }
            default:
                throw new IOException($"Protocol error: unexpected reply type '{prefix}'.");
        }
    }

    private static long ParseLong(ReadOnlySpan<byte> s) =>
        long.Parse(Encoding.ASCII.GetString(s), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);

    /// <summary>Reads a CRLF-terminated line (without the CRLF).</summary>
    public async Task<byte[]> ReadLineAsync(CancellationToken ct)
    {
        while (true)
        {
            var span = _buffer.AsSpan(_start, _end - _start);
            var lf = span.IndexOf((byte)'\n');
            if (lf >= 0)
            {
                var len = lf > 0 && span[lf - 1] == '\r' ? lf - 1 : lf;
                var line = span[..len].ToArray();
                _start += lf + 1;
                return line;
            }
            if (_start > 0 && _end == _buffer.Length || _end - _start == 0) Compact();
            if (_end == _buffer.Length) throw new IOException("Protocol error: reply line too long.");
            await FillAsync(ct).ConfigureAwait(false);
        }
    }

    private async Task<byte[]> ReadExactAsync(int count, CancellationToken ct)
    {
        var result = new byte[count];
        var copied = 0;
        while (copied < count)
        {
            if (_end - _start == 0)
            {
                Compact();
                await FillAsync(ct).ConfigureAwait(false);
            }
            var take = Math.Min(count - copied, _end - _start);
            Buffer.BlockCopy(_buffer, _start, result, copied, take);
            _start += take;
            copied += take;
        }
        return result;
    }

    private void Compact()
    {
        var live = _end - _start;
        if (live > 0 && _start > 0) Buffer.BlockCopy(_buffer, _start, _buffer, 0, live);
        _start = 0;
        _end = live;
    }

    private async Task FillAsync(CancellationToken ct)
    {
        var n = await _stream.ReadAsync(_buffer.AsMemory(_end), ct).ConfigureAwait(false);
        if (n == 0) throw new IOException("The server closed the connection.");
        _end += n;
    }

    public ValueTask DisposeAsync()
    {
        try
        {
            _stream.Dispose();
        }
        catch (IOException)
        {
        }
        _tcp.Dispose();
        return ValueTask.CompletedTask;
    }
}
