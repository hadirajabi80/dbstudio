using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using DbStudio.Core.Services;

namespace DbStudio.Host.Ws;

/// <summary>
/// Single-socket fan-out of engine events (docs/PLAN.md 3.6, D-6). Clients must send <c>{"type":"auth","token":..}</c>
/// as their first frame within 2 s (else closed with 4401); then they receive every event and may send
/// <c>{"type":"ping"}</c> (answered with <c>pong</c>). Each client has its own ordered send queue.
/// </summary>
public sealed class WsHub(EngineOptions options, ILogger<WsHub> log) : IEventPublisher
{
    public const WebSocketCloseStatus Unauthorized = (WebSocketCloseStatus)4401;
    private const int MaxQueuedFrames = 200_000;

    private readonly ConcurrentDictionary<long, Client> _clients = new();
    private readonly byte[] _token = Encoding.UTF8.GetBytes(options.Token);
    private long _nextId;

    public int ClientCount => _clients.Count;

    private sealed class Client(long id, WebSocket socket)
    {
        public long Id { get; } = id;
        public WebSocket Socket { get; } = socket;
        public Channel<byte[]> Queue { get; } = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
        public int Queued;
    }

    public void Publish(EngineEvent ev)
    {
        if (_clients.IsEmpty) return;
        byte[] payload;
        try
        {
            payload = JsonSerializer.SerializeToUtf8Bytes(ev, ev.GetType(), CoreJson.Options);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Could not serialize event {Type}", ev.Type);
            return;
        }
        foreach (var c in _clients.Values) Enqueue(c, payload);
    }

    private void Enqueue(Client c, byte[] payload)
    {
        if (Interlocked.Increment(ref c.Queued) > MaxQueuedFrames)
        {
            // A client that stopped reading must not exhaust memory: drop it.
            log.LogWarning("WebSocket client {Id} is not reading; disconnecting", c.Id);
            c.Queue.Writer.TryComplete();
            c.Socket.Abort();
            return;
        }
        c.Queue.Writer.TryWrite(payload);
    }

    public async Task HandleAsync(HttpContext ctx)
    {
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = 400;
            await ctx.Response.WriteAsync("WebSocket upgrade expected.");
            return;
        }
        var origin = ctx.Request.Headers.Origin.ToString();
        if (origin.Length > 0 && !options.AllowedOrigins.Contains(origin))
        {
            ctx.Response.StatusCode = 403;
            return;
        }

        using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
        var ct = ctx.RequestAborted;
        if (!await AuthenticateAsync(socket, ct)) return;

        var client = new Client(Interlocked.Increment(ref _nextId), socket);
        Enqueue(client, Serialize(new AuthOkEvent()));
        _clients[client.Id] = client;
        log.LogInformation("WebSocket client {Id} connected", client.Id);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var sender = SendLoopAsync(client, cts.Token);
        try
        {
            await ReceiveLoopAsync(client, cts.Token);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // disconnected
        }
        finally
        {
            _clients.TryRemove(client.Id, out _);
            client.Queue.Writer.TryComplete();
            await cts.CancelAsync();
            try { await sender; } catch { /* ignore */ }
            log.LogInformation("WebSocket client {Id} disconnected", client.Id);
        }
    }

    private async Task<bool> AuthenticateAsync(WebSocket socket, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            var frame = await ReceiveTextAsync(socket, 16 * 1024, timeout.Token);
            if (frame is not null)
            {
                using var doc = JsonDocument.Parse(frame);
                if (doc.RootElement.TryGetProperty("type", out var t) && t.GetString() == "auth"
                    && doc.RootElement.TryGetProperty("token", out var tok) && tok.ValueKind == JsonValueKind.String
                    && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(tok.GetString()!), _token))
                    return true;
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or JsonException or WebSocketException)
        {
            // fall through to close
        }
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseAsync(Unauthorized, "unauthorized", closeCts.Token);
            }
        }
        catch
        {
            socket.Abort();
        }
        return false;
    }

    private async Task ReceiveLoopAsync(Client client, CancellationToken ct)
    {
        while (client.Socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            var text = await ReceiveTextAsync(client.Socket, 64 * 1024, ct);
            if (text is null) break;
            try
            {
                using var doc = JsonDocument.Parse(text);
                var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "ping") Enqueue(client, Serialize(new PongEvent()));
            }
            catch (JsonException)
            {
                // ignore malformed frames
            }
        }
        if (client.Socket.State == WebSocketState.CloseReceived)
        {
            try { await client.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { /* ignore */ }
        }
    }

    private static async Task SendLoopAsync(Client client, CancellationToken ct)
    {
        await foreach (var payload in client.Queue.Reader.ReadAllAsync(ct))
        {
            Interlocked.Decrement(ref client.Queued);
            if (client.Socket.State != WebSocketState.Open) break;
            await client.Socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, ct);
        }
    }

    /// <summary>Reads one text message; null when the socket closed.</summary>
    private static async Task<string?> ReceiveTextAsync(WebSocket socket, int maxBytes, CancellationToken ct)
    {
        var buffer = new byte[4096];
        using var ms = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
            if (ms.Length > maxBytes) throw new WebSocketException("Frame too large.");
            if (result.EndOfMessage) return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
        }
    }

    private static byte[] Serialize(EngineEvent ev) => JsonSerializer.SerializeToUtf8Bytes(ev, ev.GetType(), CoreJson.Options);
}
