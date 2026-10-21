using System.Globalization;

namespace DbStudio.Sources.Redis;

/// <summary>Parsers for the text replies of INFO, CLIENT LIST and CLUSTER NODES.</summary>
public static class InfoParser
{
    /// <summary><c>INFO</c> text → section (lower case, e.g. "memory") → key → value.</summary>
    public static Dictionary<string, Dictionary<string, string>> Parse(string text)
    {
        var sections = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
        var current = sections["default"] = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            if (line.StartsWith('#'))
            {
                var name = line.TrimStart('#').Trim().ToLowerInvariant();
                if (!sections.TryGetValue(name, out current!)) current = sections[name] = new Dictionary<string, string>(StringComparer.Ordinal);
                continue;
            }
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            current[line[..colon]] = line[(colon + 1)..];
        }
        if (sections["default"].Count == 0) sections.Remove("default");
        return sections;
    }

    /// <summary><c>db0:keys=12,expires=1,avg_ttl=0</c> → (0, 12, 1).</summary>
    public static List<(int Db, long Keys, long Expires)> Keyspace(Dictionary<string, string>? keyspace)
    {
        var list = new List<(int, long, long)>();
        if (keyspace is null) return list;
        foreach (var (k, v) in keyspace)
        {
            if (!k.StartsWith("db", StringComparison.Ordinal) || !int.TryParse(k.AsSpan(2), NumberStyles.Integer, CultureInfo.InvariantCulture, out var db)) continue;
            var fields = Pairs(v, ',');
            list.Add((db, Long(fields.GetValueOrDefault("keys")), Long(fields.GetValueOrDefault("expires"))));
        }
        return list.OrderBy(x => x.Item1).ToList();
    }

    /// <summary><c>a=1 b=2</c> (CLIENT LIST) or <c>a=1,b=2</c> (keyspace) → dictionary.</summary>
    public static Dictionary<string, string> Pairs(string line, char separator = ' ')
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in line.Split(separator, StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq > 0) d[part[..eq]] = part[(eq + 1)..];
        }
        return d;
    }

    public static long Long(string? s) => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;
}
