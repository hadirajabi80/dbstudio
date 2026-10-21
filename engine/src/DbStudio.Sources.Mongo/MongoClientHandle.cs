using System.Collections.Concurrent;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using MongoDB.Bson;
using MongoDB.Driver;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// The long-lived MongoDB client of one connection profile (docs/PLAN-M2.md D2). Services go through
/// <see cref="Gateway"/>; <see cref="Client"/> / <see cref="Database"/> expose the driver objects to other packages
/// (M2-L log sources) and are null when the handle is backed by a fake.
/// </summary>
public sealed class MongoClientHandle : IDataSourceClient
{
    private readonly ConcurrentDictionary<string, (string Type, DateTimeOffset At)> _types = new(StringComparer.Ordinal);

    public MongoClientHandle(string connectionId, ConnectionProfile profile, IMongoGateway gateway, ServerInfo server, BsonDocument? hello = null)
    {
        ConnectionId = connectionId;
        Profile = profile;
        Gateway = gateway;
        Server = server;
        Hello = hello ?? new BsonDocument();
    }

    public string ConnectionId { get; }
    public ConnectionProfile Profile { get; }
    public IMongoGateway Gateway { get; }
    public ServerInfo Server { get; }

    /// <summary>The <c>hello</c> reply of the handshake.</summary>
    public BsonDocument Hello { get; }

    public DateTimeOffset LastUsed { get; set; }

    /// <summary>The driver client; null when fake-backed.</summary>
    public IMongoClient? Client => Gateway.Client;

    /// <summary>A driver database; null when fake-backed.</summary>
    public IMongoDatabase? Database(string name) => Client?.GetDatabase(name);

    /// <summary>The profile's default database (form field <c>database</c>), or null.</summary>
    public string? DefaultDatabase => string.IsNullOrWhiteSpace(Profile.GetString("database")) ? null : Profile.GetString("database")!.Trim();

    /// <summary>403 READ_ONLY for writes on a read-only profile.</summary>
    public void EnsureWritable(string action)
    {
        if (Profile.ReadOnly) throw EngineException.ReadOnly(Profile.Name, action);
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            await Gateway.RunCommandAsync("admin", new BsonDocument("ping", 1), ct).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>"collection" | "view" | "timeseries" (listCollections, cached 30 s); "collection" when unknown.</summary>
    public async Task<string> CollectionTypeAsync(string db, string coll, CancellationToken ct)
    {
        var key = db + "\0" + coll;
        if (_types.TryGetValue(key, out var hit) && DateTimeOffset.UtcNow - hit.At < TimeSpan.FromSeconds(30)) return hit.Type;
        string type;
        try
        {
            var list = await Gateway.ListCollectionsAsync(db, new BsonDocument("name", coll), ct).ConfigureAwait(false);
            type = list.Count > 0 ? list[0].GetValue("type", "collection").AsString : "collection";
        }
        catch (Exception ex) when (MongoErrors.IsUnauthorized(ex))
        {
            type = "collection";
        }
        _types[key] = (type, DateTimeOffset.UtcNow);
        return type;
    }

    internal void ForgetTypes(string db)
    {
        foreach (var k in _types.Keys.Where(k => k.StartsWith(db + "\0", StringComparison.Ordinal)).ToList()) _types.TryRemove(k, out _);
    }

    public ValueTask DisposeAsync() => Gateway.DisposeAsync();
}
