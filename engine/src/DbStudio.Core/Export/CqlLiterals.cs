using System.Text;
using System.Text.Json;

namespace DbStudio.Core.Export;

/// <summary>
/// CQL literals of collection, tuple and UDT values for "Copy as / Export SQL INSERT". The grid carries these values as
/// JSON text (<c>["a","b"]</c>, <c>{"k":1}</c>); CQL wants <c>['a', 'b']</c>, <c>{'k': 1}</c>, <c>{field: 'x'}</c> and
/// unquoted uuids / numbers. The column's type text (<c>map&lt;text, frozen&lt;list&lt;uuid&gt;&gt;&gt;</c>) says which
/// brackets and which elements are quoted; an unknown type falls back to what the JSON value looks like.
/// </summary>
public static class CqlLiterals
{
    public static string FromJson(string json, string? cqlType)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var sb = new StringBuilder();
            Append(sb, doc.RootElement, Normalize(cqlType));
            return sb.ToString();
        }
        catch (JsonException)
        {
            return Quote(json);
        }
    }

    private static string Normalize(string? t)
    {
        t = (t ?? "").Trim().ToLowerInvariant();
        while (t.StartsWith("frozen<", StringComparison.Ordinal) && t.EndsWith('>')) t = t[7..^1].Trim();
        return t;
    }

    /// <summary>The type arguments of <c>name&lt;a, b&gt;</c>, split at top-level commas.</summary>
    private static List<string> Args(string type)
    {
        var open = type.IndexOf('<');
        var list = new List<string>();
        if (open < 0 || !type.EndsWith('>')) return list;
        var inner = type[(open + 1)..^1];
        int depth = 0, from = 0;
        for (var i = 0; i < inner.Length; i++)
        {
            if (inner[i] == '<') depth++;
            else if (inner[i] == '>') depth--;
            else if (inner[i] == ',' && depth == 0) { list.Add(inner[from..i].Trim()); from = i + 1; }
        }
        list.Add(inner[from..].Trim());
        return list;
    }

    private static bool Bare(string type) => type is "int" or "bigint" or "smallint" or "tinyint" or "varint" or "decimal" or "float" or "double"
        or "counter" or "boolean" or "uuid" or "timeuuid";

    private static void Append(StringBuilder sb, JsonElement e, string type)
    {
        var args = Args(type);
        switch (e.ValueKind)
        {
            case JsonValueKind.Array:
            {
                var set = type.StartsWith("set<", StringComparison.Ordinal);
                var tuple = type.StartsWith("tuple<", StringComparison.Ordinal);
                sb.Append(set ? '{' : tuple ? '(' : '[');
                var i = 0;
                foreach (var item in e.EnumerateArray())
                {
                    if (i > 0) sb.Append(", ");
                    Append(sb, item, tuple ? (i < args.Count ? Normalize(args[i]) : "") : args.Count > 0 ? Normalize(args[0]) : "");
                    i++;
                }
                sb.Append(set ? '}' : tuple ? ')' : ']');
                break;
            }
            case JsonValueKind.Object:
            {
                var map = type.StartsWith("map<", StringComparison.Ordinal);
                var keyType = map && args.Count > 0 ? Normalize(args[0]) : "";
                var valType = map && args.Count > 1 ? Normalize(args[1]) : "";
                sb.Append('{');
                var i = 0;
                foreach (var p in e.EnumerateObject())
                {
                    if (i++ > 0) sb.Append(", ");
                    if (map) AppendKey(sb, p.Name, keyType);
                    else sb.Append(SimpleName(p.Name) ? p.Name : "\"" + p.Name.Replace("\"", "\"\"") + "\""); // UDT field
                    sb.Append(": ");
                    Append(sb, p.Value, valType);
                }
                sb.Append('}');
                break;
            }
            case JsonValueKind.String:
            {
                var s = e.GetString() ?? "";
                if (Bare(type) && s.Length > 0) sb.Append(s);
                else if (type == "blob" && s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) sb.Append(s);
                else sb.Append(Quote(s));
                break;
            }
            case JsonValueKind.Number: sb.Append(e.GetRawText()); break;
            case JsonValueKind.True: sb.Append("true"); break;
            case JsonValueKind.False: sb.Append("false"); break;
            default: sb.Append("null"); break;
        }
    }

    private static void AppendKey(StringBuilder sb, string key, string keyType)
    {
        if (Bare(keyType)) sb.Append(key);
        else sb.Append(Quote(key));
    }

    private static bool SimpleName(string n) => n.Length > 0 && (char.IsLetter(n[0]) || n[0] == '_') && n.All(c => char.IsLetterOrDigit(c) || c == '_');

    private static string Quote(string s) => "'" + s.Replace("'", "''") + "'";
}
