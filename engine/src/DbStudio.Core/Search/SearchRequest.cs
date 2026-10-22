using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Search;

/// <summary>
/// One place to search: a whole connection (every user database), a database, a schema, or chosen objects of one
/// database (their schemas come with them).
/// </summary>
public sealed record SearchTarget(string ConnectionId, string? Database = null, string? Schema = null, IReadOnlyList<ObjectRef>? Objects = null);

/// <summary>A validated <c>db.search</c> request (the stream's <c>params</c>).</summary>
public sealed class SearchRequest
{
    public const int DefaultMaxHits = 2000;
    public const int MaxMaxHits = 20_000;
    public const int DefaultDataRowLimit = 20;
    public const int MaxTargets = 64;

    public required SearchMatcher Matcher { get; init; }
    public bool Names { get; init; } = true;
    public bool Columns { get; init; } = true;
    public bool Code { get; init; } = true;
    public bool Data { get; init; }
    /// <summary>Object types to search (<see cref="ObjectTypes"/>); null = every type.</summary>
    public IReadOnlySet<string>? Types { get; init; }
    public required IReadOnlyList<SearchTarget> Targets { get; init; }
    /// <summary>Most rows read per table by a data search.</summary>
    public int DataRowLimit { get; init; } = DefaultDataRowLimit;
    /// <summary>The search stops (truncated) after this many hits.</summary>
    public int MaxHits { get; init; } = DefaultMaxHits;

    public bool AllowsType(string type) => Types is null || Types.Contains(type);

    private sealed record ObjectDto(string? Schema, string? Name, string? Type);
    private sealed record TargetDto(string? ConnectionId, string? Database, string? Schema, List<ObjectDto>? Objects);
    private sealed record InDto(bool? Names, bool? Columns, bool? Code, bool? Data);
    private sealed record ParamsDto(string? Term, bool? MatchCase, bool? WholeWord, bool? Regex, InDto? In, List<string>? Types, List<TargetDto>? Targets,
        int? DataRowLimit, int? MaxHits);

    private static readonly HashSet<string> KnownTypes =
    [
        ObjectTypes.Table, ObjectTypes.View, ObjectTypes.MView, ObjectTypes.Proc, ObjectTypes.Func, ObjectTypes.TableFunc, ObjectTypes.Synonym,
        ObjectTypes.Sequence, ObjectTypes.Package, ObjectTypes.Type, ObjectTypes.Trigger,
    ];

    /// <summary>
    /// Parses the stream params: <c>{ term, matchCase, wholeWord, regex, in: { names, columns, code, data }, types: [...],
    /// targets: [{ connectionId, database, schema, objects: [{ schema, name, type }] }], dataRowLimit, maxHits }</c>.
    /// 400 VALIDATION (naming the field) for anything malformed.
    /// </summary>
    public static SearchRequest Parse(JsonElement parameters)
    {
        ParamsDto? dto;
        try
        {
            dto = parameters.ValueKind == JsonValueKind.Object ? parameters.Deserialize<ParamsDto>(CoreJson.Options) : null;
        }
        catch (JsonException ex)
        {
            throw EngineException.Validation($"Invalid search request: {ex.Message}", new { field = "params" });
        }
        if (dto is null) throw EngineException.Validation("A search request is required.", new { field = "params" });

        if (string.IsNullOrWhiteSpace(dto.Term)) throw EngineException.Validation("Enter something to search for.", new { field = "params.term" });
        var matcher = new SearchMatcher(dto.Term, dto.MatchCase ?? false, dto.WholeWord ?? false, dto.Regex ?? false);

        var targets = new List<SearchTarget>();
        foreach (var t in dto.Targets ?? [])
        {
            if (string.IsNullOrWhiteSpace(t?.ConnectionId)) throw EngineException.Validation("Every target needs a connectionId.", new { field = "params.targets" });
            var db = Blank(t.Database);
            List<ObjectRef>? objects = null;
            if (t.Objects is { Count: > 0 })
            {
                objects = [];
                foreach (var o in t.Objects)
                {
                    if (string.IsNullOrWhiteSpace(o?.Name)) throw EngineException.Validation("Every target object needs a name.", new { field = "params.targets.objects" });
                    var type = string.IsNullOrWhiteSpace(o.Type) ? ObjectTypes.Table : o.Type.Trim().ToLowerInvariant();
                    if (!KnownTypes.Contains(type)) throw EngineException.Validation($"Unknown object type '{o.Type}'.", new { field = "params.targets.objects" });
                    objects.Add(new ObjectRef(db, Blank(o.Schema) ?? Blank(t.Schema), o.Name.Trim(), type));
                }
            }
            targets.Add(new SearchTarget(t.ConnectionId.Trim(), db, Blank(t.Schema), objects));
        }
        if (targets.Count == 0) throw EngineException.Validation("Choose where to search.", new { field = "params.targets" });
        if (targets.Count > MaxTargets) throw EngineException.Validation($"At most {MaxTargets} places can be searched at once.", new { field = "params.targets" });

        HashSet<string>? types = null;
        if (dto.Types is { Count: > 0 })
        {
            types = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in dto.Types)
            {
                var type = (raw ?? "").Trim().ToLowerInvariant();
                if (!KnownTypes.Contains(type)) throw EngineException.Validation($"Unknown object type '{raw}'.", new { field = "params.types" });
                types.Add(type);
            }
        }

        var names = dto.In?.Names ?? true;
        var columns = dto.In?.Columns ?? true;
        var code = dto.In?.Code ?? true;
        var data = dto.In?.Data ?? false;
        if (!names && !columns && !code && !data) throw EngineException.Validation("Choose what to search in.", new { field = "params.in" });

        return new SearchRequest
        {
            Matcher = matcher,
            Names = names,
            Columns = columns,
            Code = code,
            Data = data,
            Types = types,
            Targets = targets,
            DataRowLimit = Math.Clamp(dto.DataRowLimit ?? DefaultDataRowLimit, 1, SearchSql.MaxRowLimit),
            MaxHits = Math.Clamp(dto.MaxHits ?? DefaultMaxHits, 1, MaxMaxHits),
        };
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
