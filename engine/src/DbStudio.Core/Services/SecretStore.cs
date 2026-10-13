using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace DbStudio.Core.Services;

/// <summary>Stores connection passwords. Secrets never leave the engine (the API only exposes hasPassword).</summary>
public interface ISecretStore
{
    string? Get(string profileId);

    /// <param name="persist">False keeps the secret in memory only for the engine's lifetime.</param>
    void Set(string profileId, string secret, bool persist);

    void Remove(string profileId);

    bool Has(string profileId);
}

/// <summary>
/// DPAPI-backed secret store (docs/PLAN.md 2.8): <c>secrets.dat</c> is a JSON map profileId → base64(DPAPI blob),
/// protected with <see cref="DataProtectionScope.CurrentUser"/> and an entropy made of a fixed app constant plus the
/// profile id, so blobs are bound to the Windows account and cannot be swapped between profiles.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiSecretStore : ISecretStore
{
    private static readonly byte[] AppEntropy = "DbStudio.v1.§secrets"u8.ToArray();

    private readonly string _file;
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, string> _memoryOnly = new(StringComparer.Ordinal);
    private Dictionary<string, string>? _persisted; // profileId → base64 blob

    public DpapiSecretStore(AppPaths paths) => _file = paths.SecretsFile;

    public string? Get(string profileId)
    {
        if (_memoryOnly.TryGetValue(profileId, out var mem)) return mem;
        lock (_gate)
        {
            if (!Load().TryGetValue(profileId, out var blob)) return null;
            try
            {
                var plain = ProtectedData.Unprotect(Convert.FromBase64String(blob), Entropy(profileId), DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(plain);
            }
            catch (Exception ex) when (ex is CryptographicException or FormatException)
            {
                return null; // blob from another account/machine or corrupted: behave as "no password"
            }
        }
    }

    public void Set(string profileId, string secret, bool persist)
    {
        if (!persist)
        {
            _memoryOnly[profileId] = secret;
            RemovePersisted(profileId);
            return;
        }
        _memoryOnly.TryRemove(profileId, out _);
        var blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(secret), Entropy(profileId), DataProtectionScope.CurrentUser);
        lock (_gate)
        {
            Load()[profileId] = Convert.ToBase64String(blob);
            Save();
        }
    }

    public void Remove(string profileId)
    {
        _memoryOnly.TryRemove(profileId, out _);
        RemovePersisted(profileId);
    }

    public bool Has(string profileId)
    {
        if (_memoryOnly.ContainsKey(profileId)) return true;
        lock (_gate) return Load().ContainsKey(profileId);
    }

    private void RemovePersisted(string profileId)
    {
        lock (_gate)
        {
            if (Load().Remove(profileId)) Save();
        }
    }

    private static byte[] Entropy(string profileId) => [.. AppEntropy, .. Encoding.UTF8.GetBytes(profileId)];

    private Dictionary<string, string> Load()
    {
        if (_persisted is not null) return _persisted;
        _persisted = new Dictionary<string, string>(StringComparer.Ordinal);
        if (File.Exists(_file))
        {
            try
            {
                var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(_file));
                if (map is not null) foreach (var (k, v) in map) _persisted[k] = v;
            }
            catch (JsonException)
            {
                // Corrupted file: start empty (passwords must be re-entered); keep a copy for diagnosis.
                try { File.Copy(_file, _file + ".corrupt", overwrite: true); } catch (IOException) { }
            }
        }
        return _persisted;
    }

    private void Save() =>
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(_persisted, new JsonSerializerOptions { WriteIndented = true }));
}

/// <summary>Non-persistent secret store for tests and non-Windows hosts.</summary>
public sealed class InMemorySecretStore : ISecretStore
{
    private readonly ConcurrentDictionary<string, string> _secrets = new(StringComparer.Ordinal);
    public string? Get(string profileId) => _secrets.GetValueOrDefault(profileId);
    public void Set(string profileId, string secret, bool persist) => _secrets[profileId] = secret;
    public void Remove(string profileId) => _secrets.TryRemove(profileId, out _);
    public bool Has(string profileId) => _secrets.ContainsKey(profileId);
}
