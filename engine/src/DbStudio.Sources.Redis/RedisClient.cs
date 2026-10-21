using System.Globalization;
using System.Net;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis;

/// <summary>
/// The long-lived client of one Redis connection profile (docs/PLAN-M2.md D2): one shared
/// <see cref="ConnectionMultiplexer"/> (it reconnects by itself), the validated settings and the server facts read at
/// open. M2-L reads <see cref="Db"/> / <see cref="Primaries"/> for SLOWLOG / CLIENT LIST log and activity sources.
/// </summary>
public sealed class RedisClient : IDataSourceClient
{
    private readonly SemaphoreSlim _modulesGate = new(1, 1);
    private IReadOnlyList<string>? _modules;

    internal RedisClient(string connectionId, ConnectionProfile profile, RedisSettings settings, IConnectionMultiplexer mux,
        ServerInfo server, Version version, bool isCluster, int databases)
    {
        ConnectionId = connectionId;
        Profile = profile;
        Settings = settings;
        Mux = mux;
        Server = server;
        Version = version;
        IsCluster = isCluster;
        Databases = databases;
    }

    public string ConnectionId { get; }
    public ConnectionProfile Profile { get; }
    public RedisSettings Settings { get; }
    public IConnectionMultiplexer Mux { get; }
    public ServerInfo Server { get; }
    public DateTimeOffset LastUsed { get; set; }

    /// <summary>Server version (INFO redis_version); gates SCAN TYPE (6.0), KEEPTTL (6.0), UNLINK (4.0), MEMORY (4.0).</summary>
    public Version Version { get; }

    /// <summary>True when connected to a Redis Cluster (one database, keys spread over the primaries).</summary>
    public bool IsCluster { get; }

    /// <summary><c>CONFIG GET databases</c> (16 when unknown; 1 in cluster mode).</summary>
    public int Databases { get; }

    public bool ReadOnly => Profile.ReadOnly;

    public RedisMode Mode => IsCluster ? RedisMode.Cluster : Settings.Mode == RedisMode.Cluster ? RedisMode.Standalone : Settings.Mode;

    public bool Supports(int major, int minor = 0) => Version >= new Version(major, minor);

    /// <summary>403 READ_ONLY when the profile is read-only; <paramref name="action"/> names what was refused.</summary>
    public void EnsureWritable(string action)
    {
        if (ReadOnly) throw EngineException.ReadOnly(Profile.Name, action);
    }

    /// <summary>Validates a database index (400 VALIDATION, field <c>db</c>).</summary>
    public int CheckDb(int db)
    {
        if (IsCluster && db != 0) throw EngineException.Validation("Redis Cluster has a single database (0).", new { field = "db" });
        if (db < 0 || db >= Math.Max(1, Databases))
            throw EngineException.Validation($"Database {db} does not exist (the server has {Databases}).", new { field = "db" });
        return db;
    }

    public IDatabase Db(int db) => Mux.GetDatabase(CheckDb(db));

    /// <summary>The connected primaries (cluster: every primary node; otherwise the single primary).</summary>
    public IReadOnlyList<IServer> Primaries()
    {
        var servers = Mux.GetServers();
        var primaries = servers.Where(s => s.IsConnected && !s.IsReplica).ToList();
        if (primaries.Count == 0) primaries = servers.Where(s => !s.IsReplica).ToList();
        if (primaries.Count == 0) throw EngineException.SourceUnavailable("No Redis primary is connected.");
        return IsCluster ? primaries : [primaries[0]];
    }

    public IServer Primary => Primaries()[0];

    /// <summary>Host and port of a server (for dedicated connections).</summary>
    public static (string Host, int Port) HostPort(EndPoint ep) => ep switch
    {
        DnsEndPoint d => (d.Host, d.Port),
        IPEndPoint ip => (ip.Address.ToString(), ip.Port),
        _ => throw new InvalidOperationException($"Unsupported endpoint {ep}"),
    };

    public static string Format(EndPoint ep)
    {
        var (h, p) = HostPort(ep);
        return h.Contains(':') ? $"[{h}]:{p}" : $"{h}:{p}";
    }

    /// <summary>The primary that owns <paramref name="key"/> (cluster), or the primary.</summary>
    public IServer ServerFor(string? key)
    {
        if (!IsCluster || key is null) return Primary;
        var slot = Mux.HashSlot(key);
        foreach (var s in Primaries())
        {
            var node = s.ClusterConfiguration?.GetBySlot(slot);
            if (node?.EndPoint is not null)
            {
                var match = Primaries().FirstOrDefault(p => Format(p.EndPoint) == Format(node.EndPoint!));
                if (match is not null) return match;
            }
        }
        return Primary;
    }

    /// <summary>Opens a dedicated connection (MONITOR, transactions, blocking commands) to a server of this client.</summary>
    public Task<RawRedisConnection> OpenDedicatedAsync(IServer server, int db, CancellationToken ct)
    {
        var (host, port) = HostPort(server.EndPoint);
        return RawRedisConnection.OpenAsync(host, port, Settings, IsCluster ? 0 : CheckDb(db), ct);
    }

    /// <summary><c>MODULE LIST</c> names (cached; empty when the command is unavailable or denied).</summary>
    public async Task<IReadOnlyList<string>> ModulesAsync()
    {
        if (_modules is not null) return _modules;
        await _modulesGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_modules is not null) return _modules;
            var names = new List<string>();
            try
            {
                var r = await Primary.ExecuteAsync("MODULE", "LIST").ConfigureAwait(false);
                if (r.Resp2Type == ResultType.Array)
                {
                    foreach (var m in (RedisResult[])r!)
                    {
                        if (m.Resp2Type != ResultType.Array) continue;
                        var parts = (RedisResult[])m!;
                        for (var i = 0; i + 1 < parts.Length; i += 2)
                            if (string.Equals((string?)parts[i], "name", StringComparison.OrdinalIgnoreCase)) names.Add((string?)parts[i + 1] ?? "");
                    }
                }
            }
            catch (RedisServerException)
            {
            }
            return _modules = names.Where(n => n.Length > 0).ToList();
        }
        finally
        {
            _modulesGate.Release();
        }
    }

    public async Task<bool> HasJsonModuleAsync() =>
        (await ModulesAsync().ConfigureAwait(false)).Any(m => m.Equals("ReJSON", StringComparison.OrdinalIgnoreCase) || m.Equals("json", StringComparison.OrdinalIgnoreCase));

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            await Mux.GetDatabase(IsCluster ? 0 : Settings.Database).PingAsync().WaitAsync(ct).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is RedisException or TimeoutException)
        {
            return false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await Mux.CloseAsync(allowCommandsToComplete: false).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is RedisException or ObjectDisposedException)
        {
        }
        Mux.Dispose();
        _modulesGate.Dispose();
    }

    internal static Version ParseVersion(string? text)
    {
        if (string.IsNullOrEmpty(text)) return new Version(0, 0);
        var parts = text.Split('.', '-').Take(3).Select(p => int.TryParse(p, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0).ToArray();
        return parts.Length switch
        {
            0 => new Version(0, 0),
            1 => new Version(parts[0], 0),
            2 => new Version(parts[0], parts[1]),
            _ => new Version(parts[0], parts[1], parts[2]),
        };
    }
}
