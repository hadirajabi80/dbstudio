using System.Text.Json;
using System.Text.Json.Nodes;

namespace DbStudio.Core.Services;

/// <summary>
/// Engine-owned user settings (<c>settings.json</c>, shared by Electron and browser modes). PUT merges partially:
/// objects are merged recursively, other values replace; <c>null</c> resets a key to its default.
/// Known keys are type-checked; <c>ui</c> is a free-form bag.
/// </summary>
public sealed class SettingsService
{
    private readonly string _file;
    private readonly object _gate = new();
    private JsonObject? _current;

    public SettingsService(AppPaths paths) => _file = paths.SettingsFile;

    public static JsonObject Defaults() => new()
    {
        ["theme"] = "system",
        ["editor"] = new JsonObject
        {
            ["fontSize"] = 14,
            ["keywordCase"] = "upper",
            ["identifierCase"] = "asIs",
            ["qualifyObjects"] = "nonDefaultSchema",
            ["qualifyColumns"] = "ambiguous",
            ["tabSize"] = 4,
            ["blankLineSplitsStatements"] = true,
        },
        ["results"] = new JsonObject
        {
            ["maxRows"] = 10000,
            ["nullText"] = "NULL",
            ["dateFormat"] = "iso",
        },
        ["confirmDestructive"] = true,
        ["ui"] = new JsonObject(),
    };

    private static readonly Dictionary<string, string[]> Enums = new()
    {
        ["theme"] = ["system", "light", "dark"],
        ["editor.keywordCase"] = ["upper", "lower", "asIs"],
        ["editor.identifierCase"] = ["asIs", "lower", "upper", "matchPrefix"],
        ["editor.qualifyObjects"] = ["never", "nonDefaultSchema", "always"],
        ["editor.qualifyColumns"] = ["ambiguous", "always"],
        ["results.dateFormat"] = ["iso", "locale"],
    };

    public JsonObject Get()
    {
        lock (_gate) return (JsonObject)Load().DeepClone();
    }

    public JsonObject Update(JsonObject patch)
    {
        lock (_gate)
        {
            var merged = (JsonObject)Load().DeepClone();
            Merge(merged, patch, Defaults(), "");
            Validate(merged);
            _current = merged;
            AtomicFile.WriteAllText(_file, merged.ToJsonString(CoreJson.Indented));
            return (JsonObject)merged.DeepClone();
        }
    }

    private JsonObject Load()
    {
        if (_current is not null) return _current;
        var result = Defaults();
        if (File.Exists(_file))
        {
            try
            {
                if (JsonNode.Parse(File.ReadAllText(_file)) is JsonObject stored)
                {
                    Merge(result, stored, Defaults(), "");
                    try { Validate(result); }
                    catch (EngineException) { result = Defaults(); }
                }
            }
            catch (JsonException)
            {
                // Corrupted settings: fall back to defaults.
            }
        }
        _current = result;
        return result;
    }

    private static void Merge(JsonObject target, JsonObject patch, JsonObject? defaults, string path)
    {
        foreach (var (key, value) in patch.ToList())
        {
            var defaultValue = defaults?[key];
            if (value is null)
            {
                if (defaultValue is not null) target[key] = defaultValue.DeepClone();
                else target.Remove(key);
                continue;
            }
            if (value is JsonObject obj && target[key] is JsonObject existing)
            {
                Merge(existing, obj, defaultValue as JsonObject, path + key + ".");
                continue;
            }
            target[key] = value.DeepClone();
        }
    }

    private static void Validate(JsonObject s)
    {
        CheckKind(s, "theme", JsonValueKind.String);
        CheckKind(s, "confirmDestructive", JsonValueKind.True, JsonValueKind.False);
        if (s["editor"] is not JsonObject editor) throw Invalid("editor", "object");
        CheckKind(editor, "fontSize", JsonValueKind.Number);
        CheckKind(editor, "tabSize", JsonValueKind.Number);
        CheckKind(editor, "blankLineSplitsStatements", JsonValueKind.True, JsonValueKind.False);
        if (s["results"] is not JsonObject results) throw Invalid("results", "object");
        CheckKind(results, "maxRows", JsonValueKind.Number);
        CheckKind(results, "nullText", JsonValueKind.String);
        if (s["ui"] is not null and not JsonObject) throw Invalid("ui", "object");

        if (Number(results["maxRows"]) < 0) throw EngineException.Validation("results.maxRows must be >= 0.", new { field = "results.maxRows" });
        var fontSize = Number(editor["fontSize"]);
        if (fontSize is < 6 or > 72) throw EngineException.Validation("editor.fontSize must be between 6 and 72.", new { field = "editor.fontSize" });

        foreach (var (path, allowed) in Enums)
        {
            var parts = path.Split('.');
            var node = parts.Length == 1 ? s[parts[0]] : (s[parts[0]] as JsonObject)?[parts[1]];
            var text = node?.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;
            if (text is null || !allowed.Contains(text))
                throw EngineException.Validation($"{path} must be one of: {string.Join(", ", allowed)}.", new { field = path });
        }
    }

    /// <summary>Numeric value of a settings node regardless of how it was created (int, double, parsed JSON).</summary>
    public static double Number(JsonNode? node) =>
        node is null ? 0 : double.Parse(node.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>Current results.maxRows setting.</summary>
    public int DefaultMaxRows() => (int)Math.Clamp(Number(Get()["results"]?["maxRows"]), 0, int.MaxValue);

    private static void CheckKind(JsonObject o, string key, params JsonValueKind[] kinds)
    {
        var node = o[key];
        if (node is null || !kinds.Contains(node.GetValueKind()))
            throw Invalid(key, string.Join(" or ", kinds.Select(k => k.ToString().ToLowerInvariant())));
    }

    private static EngineException Invalid(string key, string expected) =>
        EngineException.Validation($"Setting '{key}' must be {expected}.", new { field = key });
}
