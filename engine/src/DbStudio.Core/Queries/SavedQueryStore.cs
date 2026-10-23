using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Core.Queries;

/// <summary>
/// A query saved into a schema (Navicat's "Queries" node; ui/src/api/savedQueries.ts SavedQuery). <see cref="Database"/>
/// and <see cref="Schema"/> are the explorer's names of the node the query belongs to: the database as the catalog keys
/// it (null on Oracle, which has no database level) and the schema (the user on Oracle, <c>main</c> on SQLite).
/// </summary>
public sealed record SavedQuery(
    string Id,
    string ConnectionId,
    string? Database,
    string? Schema,
    string Name,
    string Sql,
    string? Description,
    string CreatedAt,
    string UpdatedAt);

/// <summary>POST /connections/{cid}/queries body.</summary>
public sealed record SavedQueryInput(string? Database, string? Schema, string? Name, string? Sql, string? Description);

/// <summary>PUT /connections/{cid}/queries/{id} body: rename, new text, new description (absent members are kept; an empty description clears it).</summary>
public sealed record SavedQueryPatch(string? Name, string? Sql, string? Description);

/// <summary>POST /connections/{cid}/queries/{id}/duplicate body (optional): the copy's name, else "name (copy)".</summary>
public sealed record SavedQueryDuplicate(string? Name);

/// <summary>
/// Saved queries in <c>queries.json</c> under the engine data directory (next to <c>diagrams.json</c>; same guarantees as
/// <see cref="Filters.FilterStore"/>): thread-safe, written atomically, a corrupt file is kept as <c>.corrupt</c> and the
/// store starts empty. A name is unique per (connection, database, schema), ignoring case.
/// </summary>
public sealed class SavedQueryStore
{
    public const int MaxQueries = 10_000;
    public const int MaxNameLength = 200;
    public const int MaxDescriptionLength = 2_000;
    public const int MaxSqlLength = 4_000_000;
    public const int MaxScopeLength = 512;

    private readonly string _file;
    private readonly object _gate = new();
    private List<SavedQuery>? _items;

    public SavedQueryStore(AppPaths paths) => _file = Path.Combine(paths.DataDir, "queries.json");

    public string FilePath => _file;

    /// <summary>
    /// Queries of a connection, by name. A non-null <paramref name="database"/> / <paramref name="schema"/> keeps only that
    /// database / schema; the empty string selects the queries saved without one.
    /// </summary>
    public IReadOnlyList<SavedQuery> List(string connectionId, string? database = null, string? schema = null)
    {
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        lock (_gate)
        {
            return Load()
                .Where(q => q.ConnectionId == connectionId)
                .Where(q => database is null || string.Equals(q.Database ?? "", database, StringComparison.Ordinal))
                .Where(q => schema is null || string.Equals(q.Schema ?? "", schema, StringComparison.Ordinal))
                .OrderBy(q => q.Name, StringComparer.OrdinalIgnoreCase)
                .ThenBy(q => q.Database ?? "", StringComparer.Ordinal)
                .ThenBy(q => q.Schema ?? "", StringComparer.Ordinal)
                .ToList();
        }
    }

    public SavedQuery Get(string connectionId, string id)
    {
        lock (_gate) return Load().FirstOrDefault(q => q.ConnectionId == connectionId && q.Id == id) ?? throw EngineException.NotFound($"Saved query '{id}'");
    }

    public SavedQuery Create(string connectionId, SavedQueryInput? input)
    {
        if (string.IsNullOrWhiteSpace(connectionId)) throw EngineException.Validation("connectionId is required.", new { field = "connectionId" });
        if (input is null) throw EngineException.Validation("A request body is required.");
        var database = Scope(input.Database, "database");
        var schema = Scope(input.Schema, "schema");
        var name = ValidName(input.Name);
        var sql = ValidSql(input.Sql ?? "");
        var description = ValidDescription(input.Description);
        var now = Now();
        var query = new SavedQuery(Ids.New("q"), connectionId, database, schema, name, sql, description, now, now);
        lock (_gate)
        {
            var items = Load();
            if (items.Count >= MaxQueries) throw EngineException.Validation($"At most {MaxQueries} queries can be saved.");
            EnsureUnique(items, connectionId, database, schema, name, null);
            items.Add(query);
            Save(items);
        }
        return query;
    }

    public SavedQuery Update(string connectionId, string id, SavedQueryPatch? patch)
    {
        if (patch is null) throw EngineException.Validation("A request body is required.");
        lock (_gate)
        {
            var items = Load();
            var index = items.FindIndex(q => q.ConnectionId == connectionId && q.Id == id);
            if (index < 0) throw EngineException.NotFound($"Saved query '{id}'");
            var current = items[index];
            var name = patch.Name is null ? current.Name : ValidName(patch.Name);
            if (!string.Equals(name, current.Name, StringComparison.Ordinal))
                EnsureUnique(items, connectionId, current.Database, current.Schema, name, id);
            var updated = current with
            {
                Name = name,
                Sql = patch.Sql is null ? current.Sql : ValidSql(patch.Sql),
                Description = patch.Description is null ? current.Description : ValidDescription(patch.Description),
                UpdatedAt = Now(),
            };
            items[index] = updated;
            Save(items);
            return updated;
        }
    }

    /// <summary>A copy in the same schema, named <paramref name="input"/>.Name or "name (copy)", "name (copy 2)"…</summary>
    public SavedQuery Duplicate(string connectionId, string id, SavedQueryDuplicate? input)
    {
        lock (_gate)
        {
            var items = Load();
            var source = items.FirstOrDefault(q => q.ConnectionId == connectionId && q.Id == id) ?? throw EngineException.NotFound($"Saved query '{id}'");
            if (items.Count >= MaxQueries) throw EngineException.Validation($"At most {MaxQueries} queries can be saved.");
            string name;
            if (!string.IsNullOrWhiteSpace(input?.Name))
            {
                name = ValidName(input.Name);
                EnsureUnique(items, connectionId, source.Database, source.Schema, name, null);
            }
            else name = CopyName(items, source);
            var now = Now();
            var copy = source with { Id = Ids.New("q"), Name = name, CreatedAt = now, UpdatedAt = now };
            items.Add(copy);
            Save(items);
            return copy;
        }
    }

    public bool Delete(string connectionId, string id)
    {
        lock (_gate)
        {
            var items = Load();
            var removed = items.RemoveAll(q => q.ConnectionId == connectionId && q.Id == id) > 0;
            if (removed) Save(items);
            return removed;
        }
    }

    /// <summary>Removes the queries of a deleted connection.</summary>
    public int DeleteForConnection(string connectionId)
    {
        lock (_gate)
        {
            var items = Load();
            var n = items.RemoveAll(q => q.ConnectionId == connectionId);
            if (n > 0) Save(items);
            return n;
        }
    }

    private static bool SameScope(SavedQuery q, string connectionId, string? database, string? schema) =>
        q.ConnectionId == connectionId
        && string.Equals(q.Database ?? "", database ?? "", StringComparison.Ordinal)
        && string.Equals(q.Schema ?? "", schema ?? "", StringComparison.Ordinal);

    private static void EnsureUnique(List<SavedQuery> items, string connectionId, string? database, string? schema, string name, string? exceptId)
    {
        var clash = items.FirstOrDefault(q => q.Id != exceptId && SameScope(q, connectionId, database, schema)
            && string.Equals(q.Name, name, StringComparison.OrdinalIgnoreCase));
        if (clash is not null)
        {
            var where = schema ?? database;
            throw EngineException.Validation($"A query named '{clash.Name}' already exists{(where is null ? "" : $" in {where}")}.",
                new { field = "name", reason = "duplicate", id = clash.Id });
        }
    }

    private static string CopyName(List<SavedQuery> items, SavedQuery source)
    {
        var taken = new HashSet<string>(items.Where(q => SameScope(q, source.ConnectionId, source.Database, source.Schema)).Select(q => q.Name),
            StringComparer.OrdinalIgnoreCase);
        var stem = source.Name.Length > MaxNameLength - 12 ? source.Name[..(MaxNameLength - 12)] : source.Name;
        for (var n = 1; ; n++)
        {
            var candidate = n == 1 ? $"{stem} (copy)" : $"{stem} (copy {n})";
            if (!taken.Contains(candidate)) return candidate;
        }
    }

    private static string? Scope(string? value, string field)
    {
        if (string.IsNullOrEmpty(value)) return null;
        if (value.Length > MaxScopeLength) throw EngineException.Validation($"{field} must be at most {MaxScopeLength} characters.", new { field });
        return value;
    }

    private static string ValidName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var n = name.Trim();
        if (n.Length > MaxNameLength) throw EngineException.Validation($"name must be at most {MaxNameLength} characters.", new { field = "name" });
        if (n.Any(char.IsControl)) throw EngineException.Validation("name must not contain control characters.", new { field = "name" });
        return n;
    }

    private static string ValidSql(string sql)
    {
        if (sql.Length > MaxSqlLength) throw EngineException.Validation($"sql must be at most {MaxSqlLength:N0} characters.", new { field = "sql" });
        return sql;
    }

    private static string? ValidDescription(string? description)
    {
        if (description is null) return null;
        var d = description.Trim();
        if (d.Length == 0) return null;
        if (d.Length > MaxDescriptionLength) throw EngineException.Validation($"description must be at most {MaxDescriptionLength} characters.", new { field = "description" });
        return d;
    }

    private static string Now() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private List<SavedQuery> Load()
    {
        if (_items is not null) return _items;
        var list = new List<SavedQuery>();
        if (File.Exists(_file))
        {
            try
            {
                list = JsonSerializer.Deserialize<List<SavedQuery>>(File.ReadAllText(_file), CoreJson.Options) ?? [];
                list.RemoveAll(q => q is null || string.IsNullOrEmpty(q.Id) || string.IsNullOrEmpty(q.ConnectionId) || string.IsNullOrWhiteSpace(q.Name));
                for (var i = 0; i < list.Count; i++) if (list[i].Sql is null) list[i] = list[i] with { Sql = "" };
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

    private void Save(List<SavedQuery> items) =>
        AtomicFile.WriteAllText(_file, JsonSerializer.Serialize(items, CoreJson.Indented));
}
