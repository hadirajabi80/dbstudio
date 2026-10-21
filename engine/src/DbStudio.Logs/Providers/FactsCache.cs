using System.Collections.Concurrent;

namespace DbStudio.Logs.Providers;

/// <summary>Per-connection cache of probe results (privileges, versions, server offsets), five minutes by default.</summary>
public sealed class FactsCache<T>(TimeSpan? ttl = null) where T : class
{
    private readonly ConcurrentDictionary<string, (T Value, DateTimeOffset Expires)> _items = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _gates = new(StringComparer.Ordinal);
    private readonly TimeSpan _ttl = ttl ?? TimeSpan.FromMinutes(5);

    public async Task<T> GetAsync(string key, Func<CancellationToken, Task<T>> load, CancellationToken ct)
    {
        if (_items.TryGetValue(key, out var hit) && hit.Expires > DateTimeOffset.UtcNow) return hit.Value;
        var gate = _gates.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_items.TryGetValue(key, out hit) && hit.Expires > DateTimeOffset.UtcNow) return hit.Value;
            var value = await load(ct).ConfigureAwait(false);
            _items[key] = (value, DateTimeOffset.UtcNow + _ttl);
            return value;
        }
        finally
        {
            gate.Release();
        }
    }

    public void Set(string key, T value) => _items[key] = (value, DateTimeOffset.UtcNow + _ttl);

    public void Invalidate(string key) => _items.TryRemove(key, out _);
}
