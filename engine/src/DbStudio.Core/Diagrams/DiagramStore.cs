using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Services;

namespace DbStudio.Core.Diagrams;

/// <summary>
/// What an ER diagram shows (docs/PLAN-M2.md section 3, ui/src/api/types.m2.ts DiagramScope): one schema, or an explicit
/// table set of <c>schema.table</c> names. Exactly one of <see cref="Schema"/> / <see cref="Tables"/> is set.
/// </summary>
public sealed record DiagramScope(string? Database, string? Schema, List<string>? Tables);

/// <summary>
/// A saved diagram layout (ui/src/api/types.m2.ts DiagramLayout). <see cref="Positions"/> maps <c>schema.table</c> to
/// <c>[x, y]</c> in diagram coordinates; <see cref="Options"/> is an opaque JSON object of view options (column mode,
/// type visibility, filters) the renderer owns.
/// </summary>
public sealed record DiagramLayout(
    string Id,
    DiagramScope Scope,
    Dictionary<string, double[]> Positions,
    List<string> Hidden,
    double Zoom,
    double[] Pan,
    string UpdatedAt,
    string? Auto = null,
    List<string>? Added = null,
    List<string>? Pinned = null,
    JsonObject? Options = null);

/// <summary>One stored layout: the layout plus the connection it belongs to and its scope key.</summary>
public sealed record StoredDiagram(string ConnectionId, string ScopeKey, DiagramLayout Layout);

/// <summary>
/// ER diagram layouts in <c>diagrams.json</c> under the engine data directory (same shape and guarantees as
/// <see cref="Filters.FilterStore"/>): thread-safe, written atomically, a corrupt file is kept as <c>.corrupt</c> and the
/// store starts empty. One layout per (connection, scope key): saving a new id for a scope that already has a layout
/// replaces it, so a diagram re-opened from another window never forks its layout.
/// </summary>
public sealed class DiagramStore
{
    public const int MaxLayouts = 2000;
    public const int MaxTables = 20000;
    public const int MaxIdLength = 128;
    public const int MaxNameLength = 512;
    public const double MinZoom = 0.05;
    public const double MaxZoom = 4;
    public const double MaxCoordinate = 10_000_000;
    public static readonly IReadOnlySet<string> AutoLayouts = new HashSet<string>(StringComparer.Ordinal) { "layered-lr", "layered-tb", "grid" };

    private readonly string _file;
    private readonly object _gate = new();
    private List<StoredDiagram>? _items;

    public DiagramStore(AppPaths paths) => _file = Path.Combine(paths.DataDir, "diagrams.json");

    public string FilePath => _file;

    /// <summary>
    /// Stable key of a scope, identical to <c>layoutScopeKey</c> in ui/src/api/er.ts: <c>db|schema</c>, or
    /// <c>db|t:a,b</c> with the table names sorted ordinally; a null database is the empty string.
    /// </summary>
    public static string ScopeKey(DiagramScope scope)
    {
        var db = scope.Database ?? "";
        if (scope.Tables is { Count: > 0 } tables)
        {
            var sorted = tables.ToList();
            sorted.Sort(StringComparer.Ordinal);
            return $"{db}|t:{string.Join(',', sorted)}";
        }
        return $"{db}|{scope.Schema ?? ""}";
    }

    /// <summary>Layouts of a connection, optionally only one database and/or one scope key; most recently updated first.</summary>
    public IReadOnlyList<DiagramLayout> List(string connectionId, string? database, string? scopeKey)
    {
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        lock (_gate)
        {
            return Load()
                .Where(d => d.ConnectionId == connectionId)
                .Where(d => database is null || string.Equals(d.Layout.Scope.Database ?? "", database, StringComparison.Ordinal))
                .Where(d => string.IsNullOrEmpty(scopeKey) || d.ScopeKey == scopeKey)
                .Select(d => d.Layout)
                .OrderByDescending(l => l.UpdatedAt, StringComparer.Ordinal)
                .ToList();
        }
    }

    public DiagramLayout? Get(string connectionId, string id)
    {
        lock (_gate) return Load().FirstOrDefault(d => d.ConnectionId == connectionId && d.Layout.Id == id)?.Layout;
    }

    /// <summary>Upsert by id (the route id wins over a missing body id; a different body id is a validation error).</summary>
    public DiagramLayout Save(string connectionId, string id, DiagramLayout? input)
    {
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        if (input is null) throw EngineException.Validation("A request body is required.");
        ValidId(id);
        if (!string.IsNullOrEmpty(input.Id) && input.Id != id)
            throw EngineException.Validation("id in the body must match the id in the path.", new { field = "id" });
        var layout = Normalize(input with { Id = id });
        var key = ScopeKey(layout.Scope);
        lock (_gate)
        {
            var items = Load();
            items.RemoveAll(d => d.ConnectionId == connectionId && (d.Layout.Id == id || d.ScopeKey == key));
            if (items.Count >= MaxLayouts) throw EngineException.Validation($"At most {MaxLayouts} diagram layouts can be saved.");
            items.Add(new StoredDiagram(connectionId, key, layout));
            Save(items);
        }
        return layout;
    }

    public bool Delete(string connectionId, string id)
    {
        lock (_gate)
        {
            var items = Load();
            var removed = items.RemoveAll(d => d.ConnectionId == connectionId && d.Layout.Id == id) > 0;
            if (removed) Save(items);
            return removed;
        }
    }

    /// <summary>Removes the layouts of a deleted connection.</summary>
    public int DeleteForConnection(string connectionId)
    {
        lock (_gate)
        {
            var items = Load();
            var n = items.RemoveAll(d => d.ConnectionId == connectionId);
            if (n > 0) Save(items);
            return n;
        }
    }

    private static void ValidId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) throw EngineException.Validation("id is required.", new { field = "id" });
        if (id.Length > MaxIdLength || id.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '_' or '-' or '.')))
            throw EngineException.Validation($"id must be 1-{MaxIdLength} characters of letters, digits, '_', '-' or '.'.", new { field = "id" });
    }

    private static List<string> Names(List<string>? names, string field)
    {
        var list = new List<string>();
        if (names is null) return list;
        if (names.Count > MaxTables) throw EngineException.Validation($"{field} has more than {MaxTables} entries.", new { field });
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var n in names)
        {
            if (string.IsNullOrWhiteSpace(n) || n.Length > MaxNameLength)
                throw EngineException.Validation($"{field} entries must be non-empty table names of at most {MaxNameLength} characters.", new { field });
            if (seen.Add(n)) list.Add(n);
        }
        return list;
    }

    private static bool Finite(double v) => double.IsFinite(v) && Math.Abs(v) <= MaxCoordinate;

    private static DiagramLayout Normalize(DiagramLayout l)
    {
        if (l.Scope is null) throw EngineException.Validation("scope is required.", new { field = "scope" });
        var tables = l.Scope.Tables is null ? null : Names(l.Scope.Tables, "scope.tables");
        var hasTables = tables is { Count: > 0 };
        var hasSchema = !string.IsNullOrEmpty(l.Scope.Schema);
        if (hasTables == hasSchema)
            throw EngineException.Validation("scope must name exactly one of schema or tables.", new { field = "scope" });
        if (l.Scope.Database is { Length: > MaxNameLength }) throw EngineException.Validation("scope.database is too long.", new { field = "scope.database" });
        var scope = new DiagramScope(l.Scope.Database, hasSchema ? l.Scope.Schema : null, hasTables ? tables : null);

        var positions = new Dictionary<string, double[]>(StringComparer.Ordinal);
        if (l.Positions is not null)
        {
            if (l.Positions.Count > MaxTables) throw EngineException.Validation($"positions has more than {MaxTables} entries.", new { field = "positions" });
            foreach (var (name, xy) in l.Positions)
            {
                if (string.IsNullOrWhiteSpace(name) || name.Length > MaxNameLength) throw EngineException.Validation("positions keys must be table names.", new { field = "positions" });
                if (xy is not { Length: 2 } || !Finite(xy[0]) || !Finite(xy[1]))
                    throw EngineException.Validation($"positions[\"{name}\"] must be [x, y] with finite numbers.", new { field = "positions" });
                positions[name] = [Math.Round(xy[0], 2), Math.Round(xy[1], 2)];
            }
        }
        if (!double.IsFinite(l.Zoom) || l.Zoom < MinZoom || l.Zoom > MaxZoom)
            throw EngineException.Validation($"zoom must be between {MinZoom} and {MaxZoom}.", new { field = "zoom" });
        var pan = l.Pan ?? [0, 0];
        if (pan.Length != 2 || !Finite(pan[0]) || !Finite(pan[1])) throw EngineException.Validation("pan must be [x, y] with finite numbers.", new { field = "pan" });
        if (l.Auto is not null && !AutoLayouts.Contains(l.Auto))
            throw EngineException.Validation("auto must be layered-lr, layered-tb or grid.", new { field = "auto" });
        if (l.Options is not null && l.Options.ToJsonString().Length > 16_384)
            throw EngineException.Validation("options is too large.", new { field = "options" });

        return new DiagramLayout(
            l.Id, scope, positions, Names(l.Hidden, "hidden"), l.Zoom, pan, Now(), l.Auto,
            l.Added is null ? null : Names(l.Added, "added"), l.Pinned is null ? null : Names(l.Pinned, "pinned"),
            l.Options is null ? null : (JsonObject)l.Options.DeepClone());
    }

    private static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private List<StoredDiagram> Load()
    {
        if (_items is not null) return _items;
        var list = new List<StoredDiagram>();
        if (File.Exists(_file))
        {
            try
            {
                list = JsonSerializer.Deserialize<List<StoredDiagram>>(File.ReadAllText(_file), CoreJson.Options) ?? [];
                list.RemoveAll(d => d is null || string.IsNullOrEmpty(d.ConnectionId) || d.Layout is null || string.IsNullOrEmpty(d.Layout.Id) || d.Layout.Scope is null);
            }
            catch (JsonException)
            {
                try { File.Copy(_file, _file + ".corrupt", overwrite: true); } catch (IOException) { }
                list = [];
            }
        }
        _items = list;
        return list;
    }

    private void Save(List<StoredDiagram> items) =>
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(items, CoreJson.Indented));
}
