using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Core.Secrets;

/// <summary>
/// Fallback secret store for hosts without DPAPI or the macOS Keychain (Linux, FreeBSD), or when forced with
/// <c>DBSTUDIO_SECRET_STORE=file</c>.
/// <para>
/// <c>secrets.aes.json</c> maps profileId → base64(nonce[12] | ciphertext | tag[16]), AES-256-GCM with the profile id
/// as associated data (a blob copied to another profile fails to decrypt). The 32-byte key is random and lives in
/// <c>secrets.key</c> next to it, created with mode 0600 (owner read/write only).
/// </para>
/// <para>
/// <b>Threat model:</b> this keeps passwords out of <c>connections.json</c>, out of casual copies of the data folder that
/// omit the key, and away from other local users (file permissions). It does <b>not</b> protect against anything that
/// runs as the same user or can read the key file (unlike a keyring daemon). A libsecret/KWallet backend is the
/// upgrade path for Linux.
/// </para>
/// </summary>
public sealed class FileSecretStore : PersistentSecretStoreBase
{
    public const string FileName = "secrets.aes.json";
    public const string KeyFileName = "secrets.key";
    private const int KeySize = 32, NonceSize = 12, TagSize = 16;
    private static readonly byte[] AadPrefix = "DbStudio.v1.secrets:"u8.ToArray();

    private readonly string _file;
    private readonly string _keyFile;
    private readonly object _gate = new();
    private Dictionary<string, string>? _persisted;
    private byte[]? _key;

    public FileSecretStore(AppPaths paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        _file = Path.Combine(paths.DataDir, FileName);
        _keyFile = Path.Combine(paths.DataDir, KeyFileName);
    }

    public string SecretsFile => _file;
    public string KeyFile => _keyFile;

    protected override string? ReadPersisted(string profileId)
    {
        lock (_gate)
        {
            if (!Load().TryGetValue(profileId, out var blob)) return null;
            if (!File.Exists(_keyFile)) return null; // key lost: secrets are unrecoverable
            try
            {
                var data = Convert.FromBase64String(blob);
                if (data.Length < NonceSize + TagSize) return null;
                var nonce = data.AsSpan(0, NonceSize);
                var tag = data.AsSpan(data.Length - TagSize);
                var cipher = data.AsSpan(NonceSize, data.Length - NonceSize - TagSize);
                var plain = new byte[cipher.Length];
                using var aes = new AesGcm(Key(), TagSize);
                aes.Decrypt(nonce, cipher, tag, plain, Aad(profileId));
                return Encoding.UTF8.GetString(plain);
            }
            catch (Exception ex) when (ex is CryptographicException or FormatException)
            {
                return null; // wrong key, tampered or swapped blob: behave as "no password"
            }
        }
    }

    protected override void WritePersisted(string profileId, string secret)
    {
        var plain = Encoding.UTF8.GetBytes(secret);
        var data = new byte[NonceSize + plain.Length + TagSize];
        var nonce = data.AsSpan(0, NonceSize);
        RandomNumberGenerator.Fill(nonce);
        lock (_gate)
        {
            using (var aes = new AesGcm(Key(), TagSize))
                aes.Encrypt(nonce, plain, data.AsSpan(NonceSize, plain.Length), data.AsSpan(NonceSize + plain.Length), Aad(profileId));
            Load()[profileId] = Convert.ToBase64String(data);
            Save();
        }
        CryptographicOperations.ZeroMemory(plain);
    }

    protected override void DeletePersisted(string profileId)
    {
        lock (_gate)
        {
            if (Load().Remove(profileId)) Save();
        }
    }

    protected override bool HasPersisted(string profileId)
    {
        lock (_gate) return Load().ContainsKey(profileId);
    }

    private static byte[] Aad(string profileId) => [.. AadPrefix, .. Encoding.UTF8.GetBytes(profileId)];

    /// <summary>Loads the key, creating it (0600) on first use.</summary>
    private byte[] Key()
    {
        if (_key is not null) return _key;
        if (File.Exists(_keyFile))
        {
            var existing = File.ReadAllBytes(_keyFile);
            if (existing.Length != KeySize) throw new CryptographicException($"{_keyFile} is not a valid DbStudio key file.");
            RestrictPermissions(_keyFile);
            return _key = existing;
        }

        var key = RandomNumberGenerator.GetBytes(KeySize);
        Directory.CreateDirectory(Path.GetDirectoryName(_keyFile)!);
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        try
        {
            using var fs = new FileStream(_keyFile, options);
            fs.Write(key);
            fs.Flush(flushToDisk: true);
        }
        catch (IOException) when (File.Exists(_keyFile))
        {
            // Another engine instance created it first: use theirs.
            return Key();
        }
        RestrictPermissions(_keyFile);
        return _key = key;
    }

    private static void RestrictPermissions(string file)
    {
        if (OperatingSystem.IsWindows()) return; // the fallback store is not used on Windows (DPAPI); ACLs are inherited
        var wanted = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if (File.GetUnixFileMode(file) != wanted) File.SetUnixFileMode(file, wanted);
    }

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
                try { File.Copy(_file, _file + ".corrupt", overwrite: true); } catch (IOException) { }
            }
        }
        return _persisted;
    }

    private void Save()
    {
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(_persisted, new JsonSerializerOptions { WriteIndented = true }));
        RestrictPermissions(_file);
    }
}
