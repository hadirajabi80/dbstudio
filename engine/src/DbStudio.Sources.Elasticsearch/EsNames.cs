using System.Text;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>Validation of index names, targets (patterns/aliases), document and task ids.</summary>
public static class EsNames
{
    private const string Forbidden = "\\/*?\"<>| ,#:";

    /// <summary>A concrete index name for create / delete / write (Elasticsearch rules: lowercase, no wildcards or commas).</summary>
    public static string Index(string? name, string field = "name")
    {
        var n = name?.Trim() ?? "";
        if (n.Length == 0) throw EngineException.Validation("An index name is required.", new { field });
        if (n is "." or ".." || n == "_all") throw EngineException.Validation($"'{n}' is not a valid index name.", new { field });
        if (n.Any(char.IsUpper)) throw EngineException.Validation("Index names must be lowercase.", new { field });
        if (n[0] is '-' or '_' or '+') throw EngineException.Validation("Index names cannot start with '-', '_' or '+'.", new { field });
        if (n.IndexOfAny(Forbidden.ToCharArray()) >= 0 || n.Any(char.IsControl))
            throw EngineException.Validation("Index names cannot contain \\ / * ? \" < > | , # : or spaces.", new { field });
        if (Encoding.UTF8.GetByteCount(n) > 255) throw EngineException.Validation("Index names are at most 255 bytes.", new { field });
        return n;
    }

    /// <summary>A read target: index, alias, data stream, pattern ("shop-*") or comma list.</summary>
    public static string Target(string? name, string field = "index")
    {
        var n = name?.Trim() ?? "";
        if (n.Length == 0) throw EngineException.Validation("An index (or pattern) is required.", new { field });
        if (n.IndexOfAny(['/', '\\', '?', '#', '"', '<', '>', '|', ' ']) >= 0 || n.Any(char.IsControl))
            throw EngineException.Validation($"'{n}' is not a valid index, alias or pattern.", new { field });
        return n;
    }

    public static string DocId(string? id, string field = "id")
    {
        var n = id ?? "";
        if (n.Length == 0) throw EngineException.Validation("A document id is required.", new { field });
        if (Encoding.UTF8.GetByteCount(n) > 512) throw EngineException.Validation("Document ids are at most 512 bytes.", new { field });
        return n;
    }

    public static string TaskId(string? id, string field = "taskId")
    {
        var n = id?.Trim() ?? "";
        var colon = n.LastIndexOf(':');
        if (colon <= 0 || colon == n.Length - 1 || !n[(colon + 1)..].All(char.IsAsciiDigit) || n[..colon].Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            throw EngineException.Validation("Task ids look like 'nodeId:123'.", new { field });
        return n;
    }

    /// <summary>Route values keep an encoded '/' as %2F (document ids may contain '/').</summary>
    public static string Segment(string value) => value.Replace("%2F", "/", StringComparison.OrdinalIgnoreCase);
}
