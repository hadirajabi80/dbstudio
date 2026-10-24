using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Cassandra;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// Driver <see cref="ICluster"/>s shared per profile (plan-batch3 WP-CS: "shared Cluster/ISession per profile"). A cluster
/// holds the control connection, the node list and the schema metadata; every console (tab session) opens its own
/// <see cref="ISession"/> on it (its own keyspace via USE), catalog/designer/search calls share one keyspace-less session.
/// Entries are reference counted and shut down after <see cref="IdleTimeout"/> without users, or when the profile's
/// connection settings / password change (new fingerprint).
/// </summary>
public sealed class CqlClusterPool : IAsyncDisposable, IDisposable
{
    public void Dispose() => DisposeAsync().AsTask().GetAwaiter().GetResult();

    public static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Timer _sweep;

    public CqlClusterPool() => _sweep = new Timer(_ => _ = SweepAsync(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));

    internal sealed class Entry(string key, ICluster cluster, CqlConnectionSettings settings)
    {
        private int _refs;
        private Task<ISession>? _catalog;
        private readonly object _lock = new();

        public string Key { get; } = key;
        public ICluster Cluster { get; } = cluster;
        public CqlConnectionSettings Settings { get; } = settings;
        public DateTime LastUsed { get; set; } = DateTime.UtcNow;
        public int Refs => Volatile.Read(ref _refs);
        public void AddRef() { Interlocked.Increment(ref _refs); LastUsed = DateTime.UtcNow; }
        public void Release() { Interlocked.Decrement(ref _refs); LastUsed = DateTime.UtcNow; }

        public Task<ISession> CatalogSessionAsync()
        {
            lock (_lock)
            {
                if (_catalog is null || _catalog.IsFaulted || _catalog.IsCanceled) _catalog = Cluster.ConnectAsync();
                return _catalog;
            }
        }
    }

    /// <summary>A use of a pooled cluster; dispose it when done (the cluster itself stays pooled).</summary>
    public sealed class Lease : IAsyncDisposable
    {
        private readonly Entry _entry;
        private int _disposed;

        internal Lease(Entry entry) => _entry = entry;

        public ICluster Cluster => _entry.Cluster;
        public CqlConnectionSettings Settings => _entry.Settings;

        /// <summary>The shared keyspace-less session for metadata reads (never USE on it).</summary>
        public Task<ISession> CatalogSessionAsync() => _entry.CatalogSessionAsync();

        /// <summary>A new session (connection pools) for one console.</summary>
        public Task<ISession> ConnectAsync(string? keyspace) =>
            string.IsNullOrEmpty(keyspace) ? _entry.Cluster.ConnectAsync() : _entry.Cluster.ConnectAsync(keyspace);

        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) _entry.Release();
            return ValueTask.CompletedTask;
        }
    }

    /// <summary>Acquires the cluster of a profile, building and initialising it (control connection) when needed.</summary>
    public async Task<Lease> AcquireAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var settings = CqlConnectionSettings.From(profile);
        var key = profile.Id + "|" + settings.Fingerprint(password);
        if (_entries.TryGetValue(key, out var existing))
        {
            existing.AddRef();
            return new Lease(existing);
        }
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_entries.TryGetValue(key, out existing))
            {
                existing.AddRef();
                return new Lease(existing);
            }
            var cluster = Build(settings, password);
            try
            {
                // Connect once so a bad address / credentials fail here; the session becomes the catalog session.
                var entry = new Entry(key, cluster, settings);
                await entry.CatalogSessionAsync().WaitAsync(ct).ConfigureAwait(false);
                entry.AddRef();
                _entries[key] = entry;
                return new Lease(entry);
            }
            catch
            {
                _ = ShutdownQuietlyAsync(cluster);
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Builds a cluster without pooling it (connection tests).</summary>
    public static ICluster Build(CqlConnectionSettings s, string? password)
    {
        var b = Cluster.Builder()
            .WithApplicationName("Rowlit")
            .WithSocketOptions(new SocketOptions()
                .SetConnectTimeoutMillis(s.ConnectTimeoutSeconds * 1000)
                .SetReadTimeoutMillis(s.RequestTimeoutSeconds * 1000))
            .WithQueryTimeout(s.RequestTimeoutSeconds * 1000)
            .WithQueryOptions(new QueryOptions()
                .SetConsistencyLevel(s.Consistency)
                .SetSerialConsistencyLevel(s.SerialConsistency)
                .SetPageSize(s.PageSize))
            .WithReconnectionPolicy(new ExponentialReconnectionPolicy(1000, 60_000));
        if (s.CloudSecureBundle is not null)
        {
            b = b.WithCloudSecureConnectionBundle(s.CloudSecureBundle);
        }
        else
        {
            var port = s.Port;
            foreach (var point in s.ContactPoints)
            {
                var (host, p) = SplitHostPort(point);
                if (p is not null) port = p.Value;
                b = IPAddress.TryParse(host, out var ip) ? b.AddContactPoint(ip) : b.AddContactPoint(host);
            }
            b = b.WithPort(port);
            if (s.Ssl) b = b.WithSSL(SslOptions(s));
        }
        if (s.User is not null) b = b.WithCredentials(s.User, password ?? "");
        if (s.LocalDc is not null) b = b.WithLoadBalancingPolicy(new DefaultLoadBalancingPolicy(s.LocalDc));
        return b.Build();
    }

    /// <summary>"host:port", "[::1]:9042", "host" → (host, port?).</summary>
    public static (string Host, int? Port) SplitHostPort(string point)
    {
        var p = point.Trim();
        if (p.StartsWith('['))
        {
            var close = p.IndexOf(']');
            if (close > 0)
            {
                var host = p[1..close];
                return close + 2 < p.Length && p[close + 1] == ':' && int.TryParse(p[(close + 2)..], out var port6) ? (host, port6) : (host, null);
            }
        }
        var colon = p.LastIndexOf(':');
        if (colon > 0 && p.IndexOf(':') == colon && int.TryParse(p[(colon + 1)..], out var port)) return (p[..colon], port);
        return (p, null);
    }

    private static SSLOptions SslOptions(CqlConnectionSettings s)
    {
        X509Certificate2? ca = null;
        if (s.CaFile is not null) ca = X509CertificateLoader.LoadCertificateFromFile(s.CaFile);
        var options = new SSLOptions(System.Security.Authentication.SslProtocols.None, false, (sender, cert, chain, errors) =>
        {
            if (s.SslSkipVerify || errors == SslPolicyErrors.None) return true;
            if (ca is null || cert is null) return false;
            using var custom = new X509Chain();
            custom.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            custom.ChainPolicy.CustomTrustStore.Add(ca);
            custom.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            var ok = custom.Build(new X509Certificate2(cert));
            // A CA file validates the chain; host-name mismatches still fail unless verification is skipped.
            return ok && (errors & SslPolicyErrors.RemoteCertificateNameMismatch) == 0;
        });
        return options;
    }

    private async Task SweepAsync()
    {
        foreach (var e in _entries.Values)
        {
            if (e.Refs > 0 || DateTime.UtcNow - e.LastUsed < IdleTimeout) continue;
            if (_entries.TryRemove(e.Key, out var removed)) await ShutdownQuietlyAsync(removed.Cluster).ConfigureAwait(false);
        }
    }

    private static async Task ShutdownQuietlyAsync(ICluster cluster)
    {
        try { await cluster.ShutdownAsync().ConfigureAwait(false); }
        catch (Exception) { /* best effort */ }
    }

    public async ValueTask DisposeAsync()
    {
        await _sweep.DisposeAsync().ConfigureAwait(false);
        foreach (var e in _entries.Values) await ShutdownQuietlyAsync(e.Cluster).ConfigureAwait(false);
        _entries.Clear();
    }
}
