namespace DbStudio.Core.Services;

/// <summary>
/// Which UI clients (browser windows / Electron renderers, identified by the client id they send in the WebSocket auth
/// frame and the <c>X-DbStudio-Client</c> header) currently have a live WebSocket. The WebSocket hub reports connects
/// and disconnects; <see cref="SessionManager"/> uses it to find sessions whose owner went away (logic-08).
/// A client may hold several sockets (reconnect overlap); it is live while at least one is open.
/// </summary>
public sealed class ClientPresence(TimeProvider? time = null)
{
    /// <summary>Longest client id accepted (ids are opaque; the UI sends a UUID).</summary>
    public const int MaxClientIdLength = 128;

    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _gate = new();
    private readonly Dictionary<string, int> _live = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> _goneSince = new(StringComparer.Ordinal);

    /// <summary>Raised (outside the lock) when the last socket of a client closed.</summary>
    public event Action<string>? ClientGone;

    /// <summary>Normalizes an untrusted client id: null when empty, too long or not printable ASCII.</summary>
    public static string? Normalize(string? clientId)
    {
        if (string.IsNullOrWhiteSpace(clientId)) return null;
        var id = clientId.Trim();
        if (id.Length > MaxClientIdLength) return null;
        foreach (var ch in id)
        {
            if (ch is < '!' or > '~') return null;
        }
        return id;
    }

    public void Connected(string clientId)
    {
        lock (_gate)
        {
            _live[clientId] = _live.GetValueOrDefault(clientId) + 1;
            _goneSince.Remove(clientId);
        }
    }

    public void Disconnected(string clientId)
    {
        var gone = false;
        lock (_gate)
        {
            if (!_live.TryGetValue(clientId, out var n)) return;
            if (n <= 1)
            {
                _live.Remove(clientId);
                _goneSince[clientId] = _time.GetUtcNow();
                gone = true;
            }
            else
            {
                _live[clientId] = n - 1;
            }
        }
        if (gone) ClientGone?.Invoke(clientId);
    }

    public bool IsLive(string clientId)
    {
        lock (_gate) return _live.ContainsKey(clientId);
    }

    /// <summary>When the client's last socket closed; null while it is live or when it never connected.</summary>
    public DateTimeOffset? GoneSince(string clientId)
    {
        lock (_gate) return _goneSince.TryGetValue(clientId, out var t) ? t : null;
    }

    public DateTimeOffset Now => _time.GetUtcNow();
}
