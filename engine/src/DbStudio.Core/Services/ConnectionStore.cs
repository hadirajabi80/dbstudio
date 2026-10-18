using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// Saved connection profiles in <c>connections.json</c> (no secrets; passwords live in the <see cref="ISecretStore"/>).
/// All writes are atomic. Thread-safe.
/// <para>
/// M2 (docs/PLAN-M2.md D12): every prop whose form field has type "password" is stripped before persisting. The main
/// secret travels as <c>password</c> (stored under the profile id, as before); other password-typed fields (e.g. Kafka
/// <c>saslPassword</c>, <c>schemaRegistrySecret</c>) are kept in the secret store under <see cref="SecretKey"/>: a
/// non-empty prop value replaces the secret, a JSON <c>null</c> clears it, an empty or missing value keeps it.
/// <see cref="WithSecrets"/> restores them into a runtime copy of the profile for drivers.
/// </para>
/// </summary>
public sealed class ConnectionStore
{
    private readonly string _file;
    private readonly ISecretStore _secrets;
    private readonly Func<string, ConnectionFormSpec?> _specOf;
    private readonly object _gate = new();
    private List<ConnectionProfile>? _profiles;

    /// <summary>Relational providers only (M1 callers and tests).</summary>
    public ConnectionStore(AppPaths paths, ISecretStore secrets, ProviderRegistry providers)
        : this(paths, secrets, id => providers.Find(id)?.FormSpec)
    {
    }

    /// <summary>M2: every provider of the <see cref="SourceRegistry"/> (relational and non-relational).</summary>
    public ConnectionStore(AppPaths paths, ISecretStore secrets, SourceRegistry sources)
        : this(paths, secrets, id => sources.Find(id)?.FormSpec)
    {
    }

    private ConnectionStore(AppPaths paths, ISecretStore secrets, Func<string, ConnectionFormSpec?> specOf)
    {
        _file = paths.ConnectionsFile;
        _secrets = secrets;
        _specOf = specOf;
    }

    /// <summary>Secret store key of an extra password-typed field (D12), e.g. <c>c_01J…#saslPassword</c>.</summary>
    public static string SecretKey(string profileId, string fieldKey) => $"{profileId}#{fieldKey}";

    public IReadOnlyList<ConnectionProfile> List()
    {
        lock (_gate) return Load().Select(Present).ToList();
    }

    public ConnectionProfile? Find(string id)
    {
        lock (_gate)
        {
            var p = Load().FirstOrDefault(x => x.Id == id);
            return p is null ? null : Present(p);
        }
    }

    public ConnectionProfile Get(string id) => Find(id) ?? throw EngineException.NotFound($"Connection '{id}'");

    public string? GetPassword(string id) => _secrets.Get(id);

    /// <summary>Stored value of an extra password-typed field (e.g. "saslPassword"), or null.</summary>
    public string? GetSecret(string profileId, string fieldKey) => _secrets.Get(SecretKey(profileId, fieldKey));

    /// <summary>
    /// A runtime copy of <paramref name="profile"/> whose extra password-typed props are filled from the secret store
    /// (props already present and non-empty win, e.g. values typed into the test dialog). Never persist the result.
    /// </summary>
    public ConnectionProfile WithSecrets(ConnectionProfile profile)
    {
        var copy = new ConnectionProfile
        {
            Id = profile.Id,
            Name = profile.Name,
            ProviderId = profile.ProviderId,
            Color = profile.Color,
            Folder = profile.Folder,
            ReadOnly = profile.ReadOnly,
            Props = profile.Props.ToDictionary(kv => kv.Key, kv => kv.Value?.DeepClone()),
            HasPassword = profile.HasPassword,
            SavePassword = profile.SavePassword,
            CreatedAt = profile.CreatedAt,
            LastUsedAt = profile.LastUsedAt,
        };
        if (string.IsNullOrEmpty(profile.Id)) return copy;
        foreach (var key in ExtraSecretFields(profile.ProviderId))
        {
            if (!string.IsNullOrEmpty(copy.GetString(key))) continue;
            if (_secrets.Get(SecretKey(profile.Id, key)) is { } secret) copy.Props[key] = JsonValue.Create(secret);
        }
        return copy;
    }

    /// <param name="password">Null or "" = no password.</param>
    public ConnectionProfile Create(ConnectionProfile input, string? password)
    {
        Validate(input);
        var extra = ExtraSecrets(input);
        var profile = Clone(input);
        profile.Id = Ids.New("c");
        profile.CreatedAt = DateTimeOffset.UtcNow;
        profile.LastUsedAt = null;
        lock (_gate)
        {
            Load().Add(profile);
            Save();
        }
        if (!string.IsNullOrEmpty(password)) _secrets.Set(profile.Id, password, profile.SavePassword);
        ApplyExtraSecrets(profile.Id, profile.ProviderId, extra, profile.SavePassword, savePasswordChanged: false);
        return Get(profile.Id);
    }

    /// <param name="password">null = keep the stored password, "" = clear it, otherwise replace.</param>
    public ConnectionProfile Update(string id, ConnectionProfile input, string? password)
    {
        Validate(input);
        var extra = ExtraSecrets(input);
        bool savePasswordChanged;
        string previousProvider;
        lock (_gate)
        {
            var list = Load();
            var index = list.FindIndex(x => x.Id == id);
            if (index < 0) throw EngineException.NotFound($"Connection '{id}'");
            var existing = list[index];
            previousProvider = existing.ProviderId;
            var updated = Clone(input);
            updated.Id = id;
            updated.CreatedAt = existing.CreatedAt;
            updated.LastUsedAt = existing.LastUsedAt;
            savePasswordChanged = existing.SavePassword != updated.SavePassword;
            list[index] = updated;
            Save();
        }

        if (password is null)
        {
            // Keep the password, but move it between disk and memory when savePassword changed.
            if (savePasswordChanged && _secrets.Get(id) is { } current) _secrets.Set(id, current, input.SavePassword);
        }
        else if (password.Length == 0) _secrets.Remove(id);
        else _secrets.Set(id, password, input.SavePassword);
        if (!string.Equals(previousProvider, input.ProviderId, StringComparison.OrdinalIgnoreCase))
            RemoveExtraSecrets(id, previousProvider);
        ApplyExtraSecrets(id, input.ProviderId, extra, input.SavePassword, savePasswordChanged);
        return Get(id);
    }

    public void Delete(string id)
    {
        string providerId;
        lock (_gate)
        {
            var list = Load();
            var existing = list.FirstOrDefault(x => x.Id == id) ?? throw EngineException.NotFound($"Connection '{id}'");
            providerId = existing.ProviderId;
            list.Remove(existing);
            Save();
        }
        _secrets.Remove(id);
        RemoveExtraSecrets(id, providerId);
    }

    public void Touch(string id)
    {
        lock (_gate)
        {
            var p = Load().FirstOrDefault(x => x.Id == id);
            if (p is null) return;
            p.LastUsedAt = DateTimeOffset.UtcNow;
            Save();
        }
    }

    private void Validate(ConnectionProfile p)
    {
        if (string.IsNullOrWhiteSpace(p.Name)) throw EngineException.Validation("The connection name is required.", new { field = "name" });
        var spec = _specOf(p.ProviderId)
            ?? throw EngineException.Validation($"Unknown provider '{p.ProviderId}'.", new { field = "providerId" });
        foreach (var field in spec.Fields.Where(f => f.Required && f.Type != "password"))
        {
            if (string.IsNullOrWhiteSpace(p.GetString(field.Key)) && VisibleFor(field, p))
                throw EngineException.Validation($"'{field.Label}' is required.", new { field = field.Key });
        }
    }

    private static bool VisibleFor(FormField field, ConnectionProfile p) =>
        field.VisibleWhen is null || field.VisibleWhen.All(kv => string.Equals(p.GetString(kv.Key), kv.Value, StringComparison.OrdinalIgnoreCase));

    private ConnectionProfile Present(ConnectionProfile p)
    {
        var copy = Clone(p);
        copy.Id = p.Id;
        copy.CreatedAt = p.CreatedAt;
        copy.LastUsedAt = p.LastUsedAt;
        copy.HasPassword = _secrets.Has(p.Id);
        return copy;
    }

    /// <summary>Keys of the provider's password-typed form fields, always including "password" (D12).</summary>
    private HashSet<string> PasswordFields(string? providerId)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "password" };
        if (!string.IsNullOrEmpty(providerId) && _specOf(providerId) is { } spec)
        {
            foreach (var f in spec.Fields)
            {
                if (string.Equals(f.Type, "password", StringComparison.OrdinalIgnoreCase)) keys.Add(f.Key);
            }
        }
        return keys;
    }

    /// <summary>Password-typed fields other than the main "password" (stored under <see cref="SecretKey"/>).</summary>
    private List<string> ExtraSecretFields(string? providerId) =>
        PasswordFields(providerId).Where(k => !k.Equals("password", StringComparison.OrdinalIgnoreCase)).ToList();

    /// <summary>Extra secret props of an input: key → value (null = clear). Empty strings and missing keys are skipped (keep).</summary>
    private Dictionary<string, string?> ExtraSecrets(ConnectionProfile input)
    {
        var result = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in ExtraSecretFields(input.ProviderId))
        {
            var prop = input.Props.FirstOrDefault(kv => kv.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (prop.Key is null) continue;
            if (prop.Value is null)
            {
                result[key] = null;
                continue;
            }
            var text = input.GetString(prop.Key);
            if (!string.IsNullOrEmpty(text)) result[key] = text;
        }
        return result;
    }

    private void ApplyExtraSecrets(string id, string providerId, Dictionary<string, string?> extra, bool persist, bool savePasswordChanged)
    {
        foreach (var (key, value) in extra)
        {
            if (value is null) _secrets.Remove(SecretKey(id, key));
            else _secrets.Set(SecretKey(id, key), value, persist);
        }
        if (!savePasswordChanged) return;
        foreach (var key in ExtraSecretFields(providerId).Where(k => !extra.ContainsKey(k)))
        {
            if (_secrets.Get(SecretKey(id, key)) is { } current) _secrets.Set(SecretKey(id, key), current, persist);
        }
    }

    private void RemoveExtraSecrets(string id, string? providerId)
    {
        foreach (var key in ExtraSecretFields(providerId)) _secrets.Remove(SecretKey(id, key));
    }

    private ConnectionProfile Clone(ConnectionProfile p) => new()
    {
        Id = p.Id,
        Name = p.Name.Trim(),
        ProviderId = p.ProviderId,
        Color = string.IsNullOrWhiteSpace(p.Color) ? null : p.Color,
        Folder = string.IsNullOrWhiteSpace(p.Folder) ? null : p.Folder,
        ReadOnly = p.ReadOnly,
        // Never persist a password (or any password-typed field, D12) that slipped into props.
        Props = StripSecrets(p),
        HasPassword = false,
        SavePassword = p.SavePassword,
        CreatedAt = p.CreatedAt,
        LastUsedAt = p.LastUsedAt,
    };

    private Dictionary<string, JsonNode?> StripSecrets(ConnectionProfile p)
    {
        var secret = PasswordFields(p.ProviderId);
        return p.Props.Where(kv => !secret.Contains(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value?.DeepClone());
    }

    private List<ConnectionProfile> Load()
    {
        if (_profiles is not null) return _profiles;
        _profiles = [];
        if (File.Exists(_file))
        {
            try
            {
                var doc = JsonSerializer.Deserialize<ConnectionsFile>(File.ReadAllText(_file), CoreJson.Options);
                if (doc?.Connections is not null) _profiles.AddRange(doc.Connections.Where(c => !string.IsNullOrEmpty(c.Id)));
            }
            catch (JsonException)
            {
                File.Copy(_file, _file + ".corrupt", overwrite: true);
            }
        }
        return _profiles;
    }

    private void Save()
    {
        var doc = new ConnectionsFile(1, _profiles!.Select(p => { var c = Clone(p); c.HasPassword = false; return c; }).ToList());
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(doc, CoreJson.Indented));
    }

    private sealed record ConnectionsFile(int Version, List<ConnectionProfile> Connections);
}
