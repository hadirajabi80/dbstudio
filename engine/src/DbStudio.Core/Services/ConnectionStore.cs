using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// Saved connection profiles in <c>connections.json</c> (no secrets; passwords live in the <see cref="ISecretStore"/>).
/// All writes are atomic. Thread-safe.
/// </summary>
public sealed class ConnectionStore
{
    private readonly string _file;
    private readonly ISecretStore _secrets;
    private readonly ProviderRegistry _providers;
    private readonly object _gate = new();
    private List<ConnectionProfile>? _profiles;

    public ConnectionStore(AppPaths paths, ISecretStore secrets, ProviderRegistry providers)
    {
        _file = paths.ConnectionsFile;
        _secrets = secrets;
        _providers = providers;
    }

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

    /// <param name="password">Null or "" = no password.</param>
    public ConnectionProfile Create(ConnectionProfile input, string? password)
    {
        Validate(input);
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
        return Get(profile.Id);
    }

    /// <param name="password">null = keep the stored password, "" = clear it, otherwise replace.</param>
    public ConnectionProfile Update(string id, ConnectionProfile input, string? password)
    {
        Validate(input);
        bool savePasswordChanged;
        lock (_gate)
        {
            var list = Load();
            var index = list.FindIndex(x => x.Id == id);
            if (index < 0) throw EngineException.NotFound($"Connection '{id}'");
            var existing = list[index];
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
        return Get(id);
    }

    public void Delete(string id)
    {
        lock (_gate)
        {
            var list = Load();
            if (list.RemoveAll(x => x.Id == id) == 0) throw EngineException.NotFound($"Connection '{id}'");
            Save();
        }
        _secrets.Remove(id);
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
        var provider = _providers.Get(p.ProviderId);
        foreach (var field in provider.FormSpec.Fields.Where(f => f.Required && f.Type != "password"))
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

    private static ConnectionProfile Clone(ConnectionProfile p) => new()
    {
        Id = p.Id,
        Name = p.Name.Trim(),
        ProviderId = p.ProviderId,
        Color = string.IsNullOrWhiteSpace(p.Color) ? null : p.Color,
        Folder = string.IsNullOrWhiteSpace(p.Folder) ? null : p.Folder,
        ReadOnly = p.ReadOnly,
        // Never persist a password that slipped into props.
        Props = p.Props.Where(kv => !kv.Key.Equals("password", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(kv => kv.Key, kv => kv.Value?.DeepClone()),
        HasPassword = false,
        SavePassword = p.SavePassword,
        CreatedAt = p.CreatedAt,
        LastUsedAt = p.LastUsedAt,
    };

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
