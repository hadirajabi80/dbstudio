using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Catalog;

public sealed record CatalogDatabases(IReadOnlyList<string> Databases, string? Current);

/// <param name="SearchPathIndex">PostgreSQL: 0-based position on the session search_path; null when not on it (or no search path).</param>
public sealed record CatalogSchemaItem(string Name, bool Loaded, int? ObjectCount, int? SearchPathIndex = null);

public sealed record CatalogSchemas(string? Database, string DefaultSchema, IReadOnlyList<CatalogSchemaItem> Schemas);

/// <param name="Json">Snapshot JSON (null when <see cref="NotModified"/>).</param>
public sealed record CatalogSnapshotResult(byte[]? Json, string ETag, bool NotModified, int Version);

/// <summary>
/// Metadata cache per connection / database / schema (docs/PLAN.md 2.7). Schemas are loaded lazily with one
/// <see cref="ICatalogReader.LoadSchemaAsync"/> call over a short-lived catalog connection, serialized once to the
/// compact wire format and ETag'd. DDL executed in sessions invalidates and reloads the affected schemas in the
/// background, then pushes <c>catalog.changed</c>.
/// <para>Cache keys: SQL Server and PostgreSQL use the database name (<see cref="DialectInfo.HasDatabases"/>); Oracle and SQLite have no database level (key "").</para>
/// </summary>
public sealed class CatalogService
{
    private readonly ProviderRegistry _providers;
    private readonly ConnectionStore _connections;
    private readonly IEventPublisher _events;
    private readonly ILogger _log;
    private readonly ConcurrentDictionary<string, ConnectionCatalog> _caches = new(StringComparer.Ordinal);
    private readonly string _epoch = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();

    public CatalogService(ProviderRegistry providers, ConnectionStore connections, IEventPublisher events, ILogger<CatalogService>? log = null)
    {
        _providers = providers;
        _connections = connections;
        _events = events;
        _log = log ?? (ILogger)NullLogger.Instance;
    }

    private sealed class ConnectionCatalog
    {
        public readonly SemaphoreSlim Gate = new(1, 1);
        public readonly Dictionary<string, DbCatalog> Databases = new(StringComparer.OrdinalIgnoreCase);
        public string? CurrentDatabase;
        public IReadOnlyList<string>? DatabaseList;
    }

    private sealed class DbCatalog(string? name)
    {
        public string? Name { get; } = name;
        public int Version = 1;
        public string? DefaultSchema;
        public IReadOnlyList<SchemaInfo>? SchemaList;
        public readonly Dictionary<string, SchemaEntry> Loaded = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed record SchemaEntry(string Name, int Version, byte[] Json, int ObjectCount);

    /// <summary>Lazily opened catalog reader shared by one operation.</summary>
    private sealed class ReaderLease(IDbProvider provider, ConnectionProfile profile, string? password, CancellationToken ct) : IAsyncDisposable
    {
        private ICatalogReader? _reader;
        public async ValueTask<ICatalogReader> GetAsync() =>
            _reader ??= await provider.OpenCatalogReaderAsync(profile, password, ct).ConfigureAwait(false);
        public ValueTask DisposeAsync() => _reader?.DisposeAsync() ?? ValueTask.CompletedTask;
    }

    private (IDbProvider Provider, ConnectionProfile Profile, string? Password) Resolve(string connectionId)
    {
        var profile = _connections.Get(connectionId);
        return (_providers.Get(profile.ProviderId), profile, _connections.GetPassword(connectionId));
    }

    private ConnectionCatalog Cache(string connectionId) => _caches.GetOrAdd(connectionId, _ => new ConnectionCatalog());

    private static async Task<DbCatalog> DbAsync(ConnectionCatalog cc, Dialect dialect, string? database, ReaderLease lease)
    {
        string? name = null;
        if (DialectInfo.HasDatabases(dialect))
        {
            name = string.IsNullOrWhiteSpace(database) ? null : database;
            if (name is null)
            {
                cc.CurrentDatabase ??= await (await lease.GetAsync().ConfigureAwait(false)).GetCurrentDatabaseAsync(CancellationToken.None).ConfigureAwait(false);
                name = cc.CurrentDatabase;
            }
        }
        var key = name ?? "";
        if (!cc.Databases.TryGetValue(key, out var db))
        {
            db = new DbCatalog(name);
            cc.Databases[key] = db;
        }
        return db;
    }

    private static async Task EnsureDefaultsAsync(DbCatalog db, ConnectionCatalog cc, ReaderLease lease, CancellationToken ct)
    {
        if (db.DefaultSchema is null)
            db.DefaultSchema = await (await lease.GetAsync().ConfigureAwait(false)).GetDefaultSchemaAsync(db.Name, ct).ConfigureAwait(false);
        if (cc.DatabaseList is null)
            cc.DatabaseList = await (await lease.GetAsync().ConfigureAwait(false)).ListDatabasesAsync(ct).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ queries

    public async Task<CatalogDatabases> GetDatabasesAsync(string connectionId, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        var cc = Cache(connectionId);
        await cc.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var lease = new ReaderLease(provider, profile, password, ct);
            var reader = await lease.GetAsync().ConfigureAwait(false);
            cc.DatabaseList = await reader.ListDatabasesAsync(ct).ConfigureAwait(false);
            var current = await reader.GetCurrentDatabaseAsync(ct).ConfigureAwait(false);
            if (DialectInfo.HasDatabases(provider.Dialect)) cc.CurrentDatabase = current;
            return new CatalogDatabases(cc.DatabaseList, current);
        }
        finally
        {
            cc.Gate.Release();
        }
    }

    public async Task<CatalogSchemas> GetSchemasAsync(string connectionId, string? database, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        var cc = Cache(connectionId);
        await cc.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var lease = new ReaderLease(provider, profile, password, ct);
            var db = await DbAsync(cc, provider.Dialect, database, lease).ConfigureAwait(false);
            await EnsureDefaultsAsync(db, cc, lease, ct).ConfigureAwait(false);
            db.SchemaList = await (await lease.GetAsync().ConfigureAwait(false)).ListSchemasAsync(db.Name, ct).ConfigureAwait(false);
            var items = db.SchemaList
                .Select(s => db.Loaded.TryGetValue(s.Name, out var e)
                    ? new CatalogSchemaItem(s.Name, true, e.ObjectCount, s.SearchPathIndex)
                    : new CatalogSchemaItem(s.Name, false, s.ObjectCount, s.SearchPathIndex))
                .ToList();
            return new CatalogSchemas(db.Name, db.DefaultSchema!, items);
        }
        finally
        {
            cc.Gate.Release();
        }
    }

    /// <param name="schemas">Schemas to include; null/empty = the default schema.</param>
    /// <param name="ifNoneMatch">Value of the If-None-Match header.</param>
    public async Task<CatalogSnapshotResult> GetSnapshotAsync(string connectionId, string? database, IReadOnlyList<string>? schemas,
        string? ifNoneMatch, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        var cc = Cache(connectionId);
        await cc.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var lease = new ReaderLease(provider, profile, password, ct);
            var db = await DbAsync(cc, provider.Dialect, database, lease).ConfigureAwait(false);
            await EnsureDefaultsAsync(db, cc, lease, ct).ConfigureAwait(false);

            var requested = schemas is { Count: > 0 } ? schemas.Distinct(StringComparer.OrdinalIgnoreCase).ToList() : [db.DefaultSchema!];
            var entries = new List<SchemaEntry>(requested.Count);
            foreach (var name in requested)
            {
                if (!db.Loaded.TryGetValue(name, out var entry))
                    entry = await LoadSchemaAsync(db, name, db.Version, lease, ct).ConfigureAwait(false);
                entries.Add(entry);
            }

            var etag = ETag(connectionId, db, entries);
            if (ifNoneMatch is not null && ETagMatches(ifNoneMatch, etag))
                return new CatalogSnapshotResult(null, etag, true, db.Version);

            if (provider.Dialect == Dialect.PgSql && db.SchemaList is null)
                db.SchemaList = await (await lease.GetAsync().ConfigureAwait(false)).ListSchemasAsync(db.Name, ct).ConfigureAwait(false);
            var searchPath = db.SchemaList?.Where(s => s.SearchPathIndex is not null).OrderBy(s => s.SearchPathIndex).Select(s => s.Name).ToList();
            var json = CatalogWire.ComposeSnapshot(connectionId, provider.Dialect, db.Name, db.DefaultSchema!, db.Version,
                cc.DatabaseList ?? [], entries.Select(e => e.Json), searchPath);
            return new CatalogSnapshotResult(json, etag, false, db.Version);
        }
        finally
        {
            cc.Gate.Release();
        }
    }

    private async Task<SchemaEntry> LoadSchemaAsync(DbCatalog db, string name, int version, ReaderLease lease, CancellationToken ct)
    {
        // exact name first: a case-sensitive database may have both "Sales" and "sales"
        var canonical = (db.SchemaList?.FirstOrDefault(s => s.Name.Equals(name, StringComparison.Ordinal))
                         ?? db.SchemaList?.FirstOrDefault(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))?.Name ?? name;
        var model = await (await lease.GetAsync().ConfigureAwait(false)).LoadSchemaAsync(db.Name, canonical, ct).ConfigureAwait(false);
        var fkCount = model.Objects.Sum(o => o.ForeignKeys.Count);
        _log.LogDebug("Catalog {Database}.{Schema}: {Objects} objects, {ForeignKeys} foreign keys, referenced from [{ReferencingSchemas}]",
            db.Name, model.Name, model.Objects.Count, fkCount, string.Join(", ", model.ReferencingSchemas));
        if (model.HiddenForeignKeys > 0)
            _log.LogWarning("Catalog {Database}.{Schema}: {Hidden} foreign key(s) left out: the referenced table or columns are not visible to this login (VIEW DEFINITION)",
                db.Name, model.Name, model.HiddenForeignKeys);
        var entry = new SchemaEntry(model.Name, version, CatalogWire.SerializeSchema(model, version), model.Objects.Count);
        db.Loaded[model.Name] = entry;
        return entry;
    }

    private string ETag(string connectionId, DbCatalog db, IEnumerable<SchemaEntry> entries)
    {
        var key = new StringBuilder(connectionId).Append('|').Append(db.Name).Append('|').Append(db.Version);
        foreach (var e in entries) key.Append('|').Append(e.Name).Append(':').Append(e.Version);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(key.ToString()));
        return $"\"{_epoch}-{Convert.ToHexString(hash, 0, 8).ToLowerInvariant()}\"";
    }

    private static bool ETagMatches(string header, string etag)
    {
        if (header.Trim() == "*") return true;
        foreach (var part in header.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var p = part.StartsWith("W/", StringComparison.Ordinal) ? part[2..] : part;
            if (p == etag) return true;
        }
        return false;
    }

    public async Task<ObjectDetails> GetObjectDetailsAsync(string connectionId, ObjectRef obj, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        await using var reader = await provider.OpenCatalogReaderAsync(profile, password, ct).ConfigureAwait(false);
        return await reader.GetObjectDetailsAsync(obj, ct).ConfigureAwait(false);
    }

    public async Task<DdlResult> GetDdlAsync(string connectionId, ObjectRef obj, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        await using var reader = await provider.OpenCatalogReaderAsync(profile, password, ct).ConfigureAwait(false);
        return await reader.GetDdlAsync(obj, ct).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<ObjectError>> GetCompileErrorsAsync(string connectionId, ObjectRef obj, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        await using var reader = await provider.OpenCatalogReaderAsync(profile, password, ct).ConfigureAwait(false);
        return await reader.GetCompileErrorsAsync(obj, ct).ConfigureAwait(false);
    }

    public async Task<CatalogObject?> ResolvePublicSynonymAsync(string connectionId, string name, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        await using var reader = await provider.OpenCatalogReaderAsync(profile, password, ct).ConfigureAwait(false);
        return await reader.ResolvePublicSynonymAsync(name, ct).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ refresh / invalidation

    /// <summary>Reloads the given schemas (or every loaded one), resets list caches, bumps the version and pushes catalog.changed.</summary>
    public async Task<int> RefreshAsync(string connectionId, string? database, IReadOnlyList<string>? schemas, CancellationToken ct)
    {
        var (provider, profile, password) = Resolve(connectionId);
        var cc = Cache(connectionId);
        await cc.Gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var lease = new ReaderLease(provider, profile, password, ct);
            cc.DatabaseList = null;
            var db = await DbAsync(cc, provider.Dialect, database, lease).ConfigureAwait(false);
            db.DefaultSchema = null;
            db.SchemaList = null;
            var targets = schemas is { Count: > 0 } ? schemas.ToList() : db.Loaded.Keys.ToList();
            var reloaded = await ReloadAsync(db, targets, lease, ct).ConfigureAwait(false);
            await EnsureDefaultsAsync(db, cc, lease, ct).ConfigureAwait(false);
            _events.Publish(new CatalogChangedEvent(connectionId, db.Name, reloaded, db.Version));
            return db.Version;
        }
        finally
        {
            cc.Gate.Release();
        }
    }

    private async Task<List<string>> ReloadAsync(DbCatalog db, List<string> names, ReaderLease lease, CancellationToken ct)
    {
        db.Version++;
        var reloaded = new List<string>();
        foreach (var name in names)
        {
            db.Loaded.Remove(name);
            try
            {
                var entry = await LoadSchemaAsync(db, name, db.Version, lease, ct).ConfigureAwait(false);
                reloaded.Add(entry.Name);
            }
            catch (EngineException ex) when (ex.Status == 404)
            {
                reloaded.Add(name); // schema dropped: report it so the UI discards it
            }
        }
        return reloaded;
    }

    /// <summary>
    /// Called after a batch containing DDL succeeded. Marks the affected schemas stale, reloads the loaded ones in the
    /// background and publishes catalog.changed. <paramref name="sessionDatabase"/> is the session's current database
    /// (SQL Server) or current schema (Oracle).
    /// </summary>
    public void InvalidateAfterDdl(string connectionId, Dialect dialect, string? sessionDatabase, IEnumerable<DdlTarget> targets)
    {
        var list = targets.Where(t => t.Scope != DdlScope.Temporary).ToList();
        if (list.Count == 0 || !_caches.TryGetValue(connectionId, out var cc)) return;
        _ = Task.Run(async () =>
        {
            try
            {
                await InvalidateCoreAsync(connectionId, cc, dialect, sessionDatabase, list).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Catalog reload after DDL failed for {ConnectionId}", connectionId);
            }
        });
    }

    private async Task InvalidateCoreAsync(string connectionId, ConnectionCatalog cc, Dialect dialect, string? sessionDatabase, List<DdlTarget> targets)
    {
        var profile = _connections.Find(connectionId);
        if (profile is null) return;
        var provider = _providers.Get(profile.ProviderId);
        await cc.Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            await using var lease = new ReaderLease(provider, profile, _connections.GetPassword(connectionId), CancellationToken.None);
            var work = new Dictionary<string, (DbCatalog Db, HashSet<string> Schemas, bool Whole)>(StringComparer.OrdinalIgnoreCase);
            foreach (var t in targets)
            {
                if (t.Action is "ATTACH" or "DETACH") cc.DatabaseList = null;
                var dbName = DialectInfo.HasDatabases(dialect) ? t.Database ?? sessionDatabase ?? cc.CurrentDatabase : null;
                var key = dbName ?? "";
                if (!cc.Databases.TryGetValue(key, out var db)) continue; // nothing cached for that database
                if (!work.TryGetValue(key, out var w)) w = (db, new HashSet<string>(StringComparer.OrdinalIgnoreCase), false);
                if (t.Scope == DdlScope.Database)
                {
                    w.Whole = true;
                }
                else
                {
                    var schema = t.Schema ?? dialect switch
                    {
                        Dialect.PlSql => sessionDatabase ?? db.DefaultSchema,
                        Dialect.Sqlite => "main",
                        _ => db.DefaultSchema ?? DialectInfo.DefaultSchemaFallback(dialect),
                    };
                    if (schema is not null) w.Schemas.Add(schema);
                }
                work[key] = w;
            }

            foreach (var (_, (db, schemas, whole)) in work)
            {
                db.SchemaList = null;
                var toReload = whole ? db.Loaded.Keys.ToList() : schemas.Where(db.Loaded.ContainsKey).ToList();
                if (toReload.Count == 0 && !whole) continue;
                var reloaded = await ReloadAsync(db, toReload, lease, CancellationToken.None).ConfigureAwait(false);
                _events.Publish(new CatalogChangedEvent(connectionId, db.Name, reloaded, db.Version));
            }
        }
        finally
        {
            cc.Gate.Release();
        }
    }

    /// <summary>Drops all cached metadata of a connection (profile edited or deleted).</summary>
    public void Forget(string connectionId) => _caches.TryRemove(connectionId, out _);
}
