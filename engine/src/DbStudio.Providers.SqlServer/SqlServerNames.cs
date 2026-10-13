using System.Text;

namespace DbStudio.Providers.SqlServer;

/// <summary>Identifier quoting, multi-part name parsing and type-text rendering for T-SQL.</summary>
public static class SqlServerNames
{
    /// <summary>QUOTENAME equivalent: [name] with ] doubled.</summary>
    public static string Quote(string name) => "[" + name.Replace("]", "]]") + "]";

    public static string Qualify(string? schema, string name) =>
        string.IsNullOrEmpty(schema) ? Quote(name) : Quote(schema) + "." + Quote(name);

    /// <summary>N'...' literal.</summary>
    public static string Literal(string value) => "N'" + value.Replace("'", "''") + "'";

    /// <summary>
    /// Splits a multi-part name such as <c>[srv].[db].[dbo].[T]</c>, <c>db..T</c> or <c>dbo.T</c> into parts (brackets and
    /// double quotes removed, escapes resolved). Empty parts (db..T) are returned as empty strings.
    /// </summary>
    public static IReadOnlyList<string> SplitMultipart(string name)
    {
        var parts = new List<string>();
        var sb = new StringBuilder();
        int i = 0;
        while (i < name.Length)
        {
            char c = name[i];
            if (c == '[' || c == '"')
            {
                char close = c == '[' ? ']' : '"';
                i++;
                while (i < name.Length)
                {
                    if (name[i] == close)
                    {
                        if (i + 1 < name.Length && name[i + 1] == close) { sb.Append(close); i += 2; continue; }
                        i++;
                        break;
                    }
                    sb.Append(name[i++]);
                }
                continue;
            }
            if (c == '.') { parts.Add(sb.ToString()); sb.Clear(); i++; continue; }
            if (!char.IsWhiteSpace(c)) sb.Append(c);
            i++;
        }
        parts.Add(sb.ToString());
        return parts;
    }

    /// <summary>Renders a column/parameter type: nvarchar(50), varchar(max), decimal(18,2), datetime2(7), float, ...</summary>
    public static string TypeText(string typeName, int maxLength, int precision, int scale, bool isUserDefined = false)
    {
        if (isUserDefined) return typeName;
        switch (typeName.ToLowerInvariant())
        {
            case "nvarchar":
            case "nchar":
                return $"{typeName}({(maxLength == -1 ? "max" : (maxLength / 2).ToString())})";
            case "varchar":
            case "char":
            case "varbinary":
            case "binary":
                return $"{typeName}({(maxLength == -1 ? "max" : maxLength.ToString())})";
            case "decimal":
            case "numeric":
                return $"{typeName}({precision},{scale})";
            case "datetime2":
            case "time":
            case "datetimeoffset":
                return $"{typeName}({scale})";
            case "float":
                return precision == 53 || precision == 0 ? typeName : $"{typeName}({precision})";
            default:
                return typeName;
        }
    }
}
