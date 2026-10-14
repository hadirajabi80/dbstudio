using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Core.Filters;

/// <summary>A saved grid filter (docs/PLAN-M1.5.md 3.7, ui/src/api/types.ts SavedFilter).</summary>
public sealed record SavedFilter(
    string Id,
    string ConnectionId,
    string Signature,
    string Name,
    JsonObject Model,
    string CreatedAt,
    string? LastUsedAt);

/// <summary>POST /filters body.</summary>
public sealed record SavedFilterInput(string? ConnectionId, string? Signature, string? Name, JsonObject? Model);

/// <summary>PUT /filters/{id} body (absent members are kept).</summary>
public sealed record SavedFilterPatch(string? Name, JsonObject? Model, string? LastUsedAt);

/// <summary>
/// Saved filters in <c>filters.json</c> under the engine data directory (shared by Electron and browser modes).
/// Thread-safe; every change is written atomically. The filter model itself is opaque JSON validated only for shape
/// (an object with a <c>root</c> group) — evaluation happens in the renderer.
/// </summary>
public sealed class FilterStore
{
    public const int MaxNameLength = 200;
    public const int MaxFilters = 5000;

    private readonly string _file;
    private readonly object _gate = new();
    private List<SavedFilter>? _items;

    public FilterStore(AppPaths paths) => _file = Path.Combine(paths.DataDir, "filters.json");

    public string FilePath => _file;

    /// <summary>Filters of a connection, optionally only those saved for one column signature; most recently used first.</summary>
    public IReadOnlyList<SavedFilter> List(string connectionId, string? signature)
    {
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        lock (_gate)
        {
            return Load()
                .Where(f => f.ConnectionId == connectionId && (string.IsNullOrEmpty(signature) || f.Signature == signature))
                .OrderByDescending(f => f.LastUsedAt ?? f.CreatedAt, StringComparer.Ordinal)
                .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }

    public SavedFilter Create(SavedFilterInput? input)
    {
        if (input is null) throw EngineException.Validation("A request body is required.");
        if (string.IsNullOrWhiteSpace(input.ConnectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        var name = ValidName(input.Name);
        ValidateModel(input.Model);
        var now = Now();
        var filter = new SavedFilter(Ids.New("f"), input.ConnectionId, input.Signature ?? "", name, (JsonObject)input.Model!.DeepClone(), now, null);
        lock (_gate)
        {
            var items = Load();
            if (items.Count >= MaxFilters) throw EngineException.Validation($"At most {MaxFilters} filters can be saved.");
            items.Add(filter);
            Save(items);
        }
        return filter;
    }

    public SavedFilter Update(string id, SavedFilterPatch? patch)
    {
        if (patch is null) throw EngineException.Validation("A request body is required.");
        lock (_gate)
        {
            var items = Load();
            var index = items.FindIndex(f => f.Id == id);
            if (index < 0) throw EngineException.NotFound($"Filter '{id}'");
            var current = items[index];
            if (patch.Model is not null) ValidateModel(patch.Model);
            string? lastUsed = current.LastUsedAt;
            if (patch.LastUsedAt is not null)
            {
                if (!DateTimeOffset.TryParse(patch.LastUsedAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var t))
                    throw EngineException.Validation("lastUsedAt must be an ISO timestamp.", new { field = "lastUsedAt" });
                lastUsed = t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
            }
            var updated = current with
            {
                Name = patch.Name is null ? current.Name : ValidName(patch.Name),
                Model = patch.Model is null ? current.Model : (JsonObject)patch.Model.DeepClone(),
                LastUsedAt = lastUsed,
            };
            items[index] = updated;
            Save(items);
            return updated;
        }
    }

    public bool Delete(string id)
    {
        lock (_gate)
        {
            var items = Load();
            var removed = items.RemoveAll(f => f.Id == id) > 0;
            if (removed) Save(items);
            return removed;
        }
    }

    /// <summary>Removes the filters of a deleted connection.</summary>
    public int DeleteForConnection(string connectionId)
    {
        lock (_gate)
        {
            var items = Load();
            var n = items.RemoveAll(f => f.ConnectionId == connectionId);
            if (n > 0) Save(items);
            return n;
        }
    }

    private static string ValidName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var n = name.Trim();
        if (n.Length > MaxNameLength) throw EngineException.Validation($"name must be at most {MaxNameLength} characters.", new { field = "name" });
        return n;
    }

    private static void ValidateModel(JsonObject? model)
    {
        if (model is null) throw EngineException.Validation("model is required.", new { field = "model" });
        if (model["root"] is not JsonObject root || root["items"] is not JsonArray)
            throw EngineException.Validation("model.root must be a filter group with an items array.", new { field = "model.root" });
        var logic = root["logic"]?.GetValueKind() == JsonValueKind.String ? root["logic"]!.GetValue<string>() : null;
        if (logic is not ("and" or "or")) throw EngineException.Validation("model.root.logic must be \"and\" or \"or\".", new { field = "model.root.logic" });
    }

    private static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private List<SavedFilter> Load()
    {
        if (_items is not null) return _items;
        var list = new List<SavedFilter>();
        if (File.Exists(_file))
        {
            try
            {
                list = JsonSerializer.Deserialize<List<SavedFilter>>(File.ReadAllText(_file), CoreJson.Options) ?? [];
                list.RemoveAll(f => f is null || string.IsNullOrEmpty(f.Id) || f.Model is null);
            }
            catch (JsonException)
            {
                // Corrupted file: keep a copy and start empty rather than failing every request.
                try { File.Copy(_file, _file + ".corrupt", overwrite: true); } catch (IOException) { }
                list = [];
            }
        }
        _items = list;
        return list;
    }

    private void Save(List<SavedFilter> items) =>
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(items, CoreJson.Indented));
}
