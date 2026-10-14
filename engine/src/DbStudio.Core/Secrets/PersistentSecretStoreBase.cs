using System.Collections.Concurrent;
using DbStudio.Core.Services;

namespace DbStudio.Core.Secrets;

/// <summary>
/// Shared <see cref="ISecretStore"/> semantics for the OS-backed stores: <c>persist: false</c> keeps the secret in
/// memory for the engine's lifetime only and removes any persisted copy; <c>persist: true</c> writes it through.
/// </summary>
public abstract class PersistentSecretStoreBase : ISecretStore
{
    private readonly ConcurrentDictionary<string, string> _memoryOnly = new(StringComparer.Ordinal);

    public string? Get(string profileId)
    {
        ArgumentException.ThrowIfNullOrEmpty(profileId);
        return _memoryOnly.TryGetValue(profileId, out var mem) ? mem : ReadPersisted(profileId);
    }

    public void Set(string profileId, string secret, bool persist)
    {
        ArgumentException.ThrowIfNullOrEmpty(profileId);
        ArgumentNullException.ThrowIfNull(secret);
        if (!persist)
        {
            _memoryOnly[profileId] = secret;
            DeletePersisted(profileId);
            return;
        }
        WritePersisted(profileId, secret);
        _memoryOnly.TryRemove(profileId, out _);
    }

    public void Remove(string profileId)
    {
        ArgumentException.ThrowIfNullOrEmpty(profileId);
        _memoryOnly.TryRemove(profileId, out _);
        DeletePersisted(profileId);
    }

    public bool Has(string profileId)
    {
        ArgumentException.ThrowIfNullOrEmpty(profileId);
        return _memoryOnly.ContainsKey(profileId) || HasPersisted(profileId);
    }

    /// <summary>Returns null when there is no (readable) persisted secret.</summary>
    protected abstract string? ReadPersisted(string profileId);

    protected abstract void WritePersisted(string profileId, string secret);

    /// <summary>Must not throw when nothing is stored.</summary>
    protected abstract void DeletePersisted(string profileId);

    protected abstract bool HasPersisted(string profileId);
}
