using DbStudio.Core.Services;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo;

/// <summary>Input validation shared by the endpoints (400 VALIDATION with <c>detail.field</c>).</summary>
public static class MongoValidate
{
    private const string BadDbChars = "/\\. \"$*<>:|?";

    public static EngineException Fail(string field, string message) => EngineException.Validation(message, new { field });

    public static string Db(string? name, string field = "db")
    {
        if (string.IsNullOrWhiteSpace(name)) throw Fail(field, "A database name is required.");
        if (name.Length > 64) throw Fail(field, "Database names are at most 64 characters.");
        foreach (var c in name)
            if (BadDbChars.Contains(c) || c == '\0')
                throw Fail(field, $"Database names cannot contain '{(c == ' ' ? "space" : c.ToString())}'.");
        return name;
    }

    /// <param name="forCreate">New names: no "system." prefix.</param>
    public static string Coll(string? name, string field = "coll", bool forCreate = false)
    {
        if (string.IsNullOrWhiteSpace(name)) throw Fail(field, "A collection name is required.");
        if (name.Contains('$')) throw Fail(field, "Collection names cannot contain '$'.");
        if (name.Contains('\0')) throw Fail(field, "Collection names cannot contain the null character.");
        if (name.StartsWith('.') || name.EndsWith('.')) throw Fail(field, "Collection names cannot start or end with '.'.");
        if (forCreate && name.StartsWith("system.", StringComparison.Ordinal)) throw Fail(field, "The 'system.' prefix is reserved.");
        if (name.Length > 255) throw Fail(field, "Collection names are at most 255 characters.");
        return name;
    }

    public static int Range(int value, int min, int max, string field)
    {
        if (value < min || value > max) throw Fail(field, $"{field} must be between {min:N0} and {max:N0}.");
        return value;
    }

    /// <summary>maxTimeMs: 0 = no limit, at most one hour.</summary>
    public static TimeSpan? MaxTime(int? ms, int fallback, string field = "maxTimeMs")
    {
        var v = ms ?? fallback;
        Range(v, 0, 3_600_000, field);
        return v == 0 ? null : TimeSpan.FromMilliseconds(v);
    }

    public static string FieldPath(string? path, string field)
    {
        if (string.IsNullOrWhiteSpace(path)) throw Fail(field, "A field path is required.");
        if (path.StartsWith('$')) throw Fail(field, "Field paths cannot start with '$'.");
        if (path.Split('.').Any(p => p.Length == 0)) throw Fail(field, "Field paths cannot have empty segments.");
        return path;
    }

    /// <summary>A pipeline stage: a document with exactly one <c>$stage</c> key.</summary>
    public static BsonDocument Stage(BsonDocument stage, string field)
    {
        if (stage.ElementCount != 1 || !stage.GetElement(0).Name.StartsWith('$'))
            throw Fail(field, $"{field}: a stage is a document with exactly one $stage key, e.g. {{ $match: {{ … }} }}.");
        return stage;
    }

    public static List<BsonDocument> Pipeline(IReadOnlyList<string>? stages, string field = "pipeline")
    {
        var list = new List<BsonDocument>();
        if (stages is null) return list;
        for (var i = 0; i < stages.Count; i++)
        {
            var name = $"{field}[{i}]";
            list.Add(Stage(ShellJson.ParseDocument(stages[i], name), name));
        }
        for (var i = 0; i < list.Count - 1; i++)
            if (IsWriteStage(list[i]))
                throw Fail($"{field}[{i}]", $"{list[i].GetElement(0).Name} must be the last stage of the pipeline.");
        return list;
    }

    public static bool IsWriteStage(BsonDocument stage) => stage.ElementCount == 1 && stage.GetElement(0).Name is "$out" or "$merge";
}
