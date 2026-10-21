using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Providers.Redis;

/// <summary>One Redis node the logs package can send commands to.</summary>
public interface IRedisNode
{
    /// <summary>"host:port".</summary>
    string Address { get; }

    Task<RespValue> ExecuteAsync(IReadOnlyList<string> args, CancellationToken ct);
}

/// <summary>
/// Seam between the Redis log/activity source and the server. The default (<see cref="RespRedisGateway"/>) opens small
/// raw RESP2 connections from the connection profile, so the logs package does not depend on the M2-R client; an
/// integrator may register another implementation that reuses <c>RedisClient</c>.
/// </summary>
public interface IRedisLogGateway
{
    /// <summary>Standalone/sentinel: the one server; cluster: every reachable node (masters and replicas, ≤ 16).</summary>
    Task<IReadOnlyList<IRedisNode>> NodesAsync(LogTarget target, CancellationToken ct);

    /// <summary>MONITOR on a dedicated connection (first node only) until cancelled.</summary>
    IAsyncEnumerable<(string Node, string Line)> MonitorAsync(LogTarget target, CancellationToken ct);
}

/// <summary>Raw RESP2 implementation of <see cref="IRedisLogGateway"/> (one cached connection per node, two idle minutes).</summary>
public sealed class RespRedisGateway : IRedisLogGateway, IAsyncDisposable
{
    public const int MaxNodes = 16;
    private readonly Func<string, string?> _passwordOf;
    private readonly ConcurrentDictionary<string, Pool> _pools = new(StringComparer.Ordinal);
    private readonly Timer _reaper;

    /// <param name="passwordOf">Secret of a connection id (ConnectionStore.GetPassword).</param>
    public RespRedisGateway(Func<string, string?> passwordOf)
    {
        _passwordOf = passwordOf;
        _reaper = new Timer(_ => _ = ReapAsync(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    /// <summary>Endpoint template of a profile (host/port of standalone; user, password, TLS, timeout for all modes).</summary>
    public static RedisEndpoint Template(ConnectionProfile p, string? password) => new(
        p.GetString("host") is { Length: > 0 } h ? h : "localhost",
        p.GetInt("port", 6379),
        p.GetString("user") is { Length: > 0 } u ? u : null,
        string.IsNullOrEmpty(password) ? null : password,
        p.GetBool("tls"),
        p.GetBool("tlsSkipVerify"),
        TimeSpan.FromSeconds(Math.Clamp(p.GetInt("connectTimeout", 5), 1, 60)));

    public static (string Host, int Port) ParseAddress(string s, int defaultPort)
    {
        s = s.Trim();
        var at = s.IndexOf('@');
        if (at >= 0) s = s[..at]; // CLUSTER NODES "ip:port@cport"
        var i = s.LastIndexOf(':');
        return i > 0 && int.TryParse(s[(i + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var port) ? (s[..i].Trim('[', ']'), port) : (s, defaultPort);
    }

    /// <summary>Addresses of CLUSTER NODES lines, skipping failed / handshake / address-less nodes.</summary>
    public static List<string> ParseClusterNodes(string text)
    {
        var list = new List<string>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = line.Split(' ');
            if (parts.Length < 3) continue;
            var flags = parts[2];
            if (flags.Contains("fail", StringComparison.Ordinal) || flags.Contains("noaddr", StringComparison.Ordinal) || flags.Contains("handshake", StringComparison.Ordinal)) continue;
            var addr = parts[1].Split('@')[0].Split(',')[0];
            if (addr.StartsWith(':')) continue;
            if (!list.Contains(addr)) list.Add(addr);
        }
        return list;
    }

    private async Task<List<RedisEndpoint>> ResolveAsync(LogTarget target, CancellationToken ct)
    {
        var p = target.Profile ?? throw EngineException.Validation("A Redis connection is required.");
        var tpl = Template(p, _passwordOf(target.ConnectionId));
        var mode = p.GetString("mode") ?? "standalone";
        switch (mode)
        {
            case "sentinel":
            {
                var name = p.GetString("serviceName") is { Length: > 0 } n ? n : "mymaster";
                Exception? last = null;
                foreach (var s in p.GetList("sentinels"))
                {
                    var (h, port) = ParseAddress(s, 26379);
                    try
                    {
                        await using var c = await RespConnection.OpenAsync(tpl with { Host = h, Port = port, User = null, Password = null }, ct).ConfigureAwait(false);
                        var r = await c.ExecuteAsync(["SENTINEL", "get-master-addr-by-name", name], ct).ConfigureAwait(false);
                        if (r.Array.Count == 2 && r.Array[1].AsLong() is { } mp) return [tpl with { Host = r.Array[0].AsString() ?? h, Port = (int)mp }];
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        last = ex;
                    }
                }
                throw EngineException.SourceUnavailable($"No sentinel knows the master '{name}'" + (last is null ? "." : $": {last.Message}"));
            }
            case "cluster":
            {
                Exception? last = null;
                foreach (var seed in p.GetList("nodes"))
                {
                    var (h, port) = ParseAddress(seed, 6379);
                    try
                    {
                        await using var c = await RespConnection.OpenAsync(tpl with { Host = h, Port = port }, ct).ConfigureAwait(false);
                        var r = await c.ExecuteAsync(["CLUSTER", "NODES"], ct).ConfigureAwait(false);
                        return ParseClusterNodes(r.AsString() ?? "").Take(MaxNodes)
                            .Select(a => ParseAddress(a, 6379)).Select(x => tpl with { Host = x.Item1, Port = x.Item2 }).ToList();
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        last = ex;
                    }
                }
                throw EngineException.SourceUnavailable("No cluster node is reachable" + (last is null ? "." : $": {last.Message}"));
            }
            default:
                return [tpl];
        }
    }

    public async Task<IReadOnlyList<IRedisNode>> NodesAsync(LogTarget target, CancellationToken ct)
    {
        var stamp = JsonSerializer.Serialize(target.Profile, CoreJson.Options) + "|" + _passwordOf(target.ConnectionId)?.GetHashCode();
        var pool = _pools.GetOrAdd(target.ConnectionId, _ => new Pool());
        await pool.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            pool.LastUsed = DateTimeOffset.UtcNow;
            if (pool.Stamp != stamp || pool.Nodes is null)
            {
                await pool.CloseAsync().ConfigureAwait(false);
                var eps = await ResolveAsync(target, ct).ConfigureAwait(false);
                pool.Nodes = eps.Select(e => new Node(e)).ToList();
                pool.Stamp = stamp;
            }
            return pool.Nodes;
        }
        finally
        {
            pool.Gate.Release();
        }
    }

    public async IAsyncEnumerable<(string Node, string Line)> MonitorAsync(LogTarget target, [EnumeratorCancellation] CancellationToken ct)
    {
        var eps = await ResolveAsync(target, ct).ConfigureAwait(false);
        var ep = eps.FirstOrDefault() ?? throw EngineException.SourceUnavailable("No Redis node to monitor.");
        await using var c = await Open(ep, ct).ConfigureAwait(false);
        await foreach (var line in c.MonitorAsync(ct).ConfigureAwait(false)) yield return (ep.Address, line);
    }

    internal static async Task<RespConnection> Open(RedisEndpoint ep, CancellationToken ct)
    {
        try
        {
            return await RespConnection.OpenAsync(ep, ct).ConfigureAwait(false);
        }
        catch (RedisReplyException ex)
        {
            throw EngineException.SourceUnavailable($"Redis {ep.Address}: {ex.Message}");
        }
        catch (Exception ex) when (ex is IOException or System.Net.Sockets.SocketException or System.Security.Authentication.AuthenticationException)
        {
            throw EngineException.SourceUnavailable($"Cannot connect to Redis {ep.Address}: {ex.Message}");
        }
    }

    private async Task ReapAsync()
    {
        foreach (var p in _pools.Values)
        {
            if (DateTimeOffset.UtcNow - p.LastUsed < TimeSpan.FromMinutes(2) || !await p.Gate.WaitAsync(0).ConfigureAwait(false)) continue;
            try { await p.CloseAsync().ConfigureAwait(false); }
            finally { p.Gate.Release(); }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _reaper.DisposeAsync().ConfigureAwait(false);
        foreach (var p in _pools.Values) await p.CloseAsync().ConfigureAwait(false);
    }

    private sealed class Pool
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public List<Node>? Nodes;
        public string? Stamp;
        public DateTimeOffset LastUsed = DateTimeOffset.UtcNow;

        public async Task CloseAsync()
        {
            if (Nodes is null) return;
            foreach (var n in Nodes) await n.CloseAsync().ConfigureAwait(false);
            Nodes = null;
        }
    }

    private sealed class Node(RedisEndpoint ep) : IRedisNode
    {
        private readonly SemaphoreSlim _gate = new(1, 1);
        private RespConnection? _conn;
        public string Address => ep.Address;

        public async Task<RespValue> ExecuteAsync(IReadOnlyList<string> args, CancellationToken ct)
        {
            await _gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_conn is null || _conn.Broken)
                {
                    if (_conn is not null) await _conn.DisposeAsync().ConfigureAwait(false);
                    _conn = await Open(ep, ct).ConfigureAwait(false);
                }
                try
                {
                    return await _conn.ExecuteAsync(args, ct).ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is IOException or System.Net.Sockets.SocketException)
                {
                    throw EngineException.SourceUnavailable($"Redis {ep.Address}: {ex.Message}");
                }
            }
            finally
            {
                _gate.Release();
            }
        }

        public async Task CloseAsync()
        {
            if (_conn is not null) await _conn.DisposeAsync().ConfigureAwait(false);
            _conn = null;
        }
    }
}
