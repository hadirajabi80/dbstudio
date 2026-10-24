using System.Data.Common;
using System.Globalization;
using System.Text;
using ClickHouse.Driver.ADO.Parameters;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.ClickHouse.Params;

/// <summary>A placeholder in ClickHouse SQL: native <c>{name:Type}</c> or a console-style <c>:name</c> / <c>@name</c>.</summary>
/// <param name="Start">0-based offset of the first character.</param>
/// <param name="End">0-based exclusive end.</param>
/// <param name="Type">Declared type of a native placeholder; null for <c>:name</c> / <c>@name</c>.</param>
public readonly record struct ChPlaceholder(string Name, int Start, int End, string? Type);

/// <summary>
/// ClickHouse parameter binding (plan-batch3 WP-CH): server-side query parameters. Native <c>{name:Type}</c> placeholders are
/// bound with their declared type; <c>:name</c> and <c>@name</c> (the console convention of the other dialects) are rewritten
/// to <c>{name:Type}</c> with a type derived from the value kind (int → Int64, decimal → Decimal(38, s), date → Date,
/// datetime → DateTime64(6), null → Nullable(String), …). <c>?</c> is never a placeholder: it is the ternary operator.
/// ClickHouse has no OUT parameters.
/// </summary>
public sealed class ChParamBinder : IParamBinder
{
    public static readonly ChParamBinder Instance = new();

    public string ProviderId => "clickhouse";

    public static List<ChPlaceholder> Scan(string sql)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.ClickHouse);
        var list = new List<ChPlaceholder>();
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (t.Kind == SqlTokenKind.Operator && t.Value == "{" && k + 1 < tokens.Count && tokens[k + 1].IsIdentifier)
            {
                // {name:Type} — the type may nest parentheses and quotes: find the matching '}' in the raw text.
                var close = FindClose(sql, tokens[k + 1].End);
                if (close > 0)
                {
                    var inner = sql[(t.Start + 1)..close];
                    var colon = inner.IndexOf(':');
                    if (colon > 0)
                    {
                        var name = inner[..colon].Trim().Trim('`');
                        var type = inner[(colon + 1)..].Trim();
                        if (name.Length > 0 && type.Length > 0)
                        {
                            list.Add(new ChPlaceholder(name, t.Start, close + 1, type));
                            while (k + 1 < tokens.Count && tokens[k + 1].Start <= close) k++;
                            continue;
                        }
                    }
                }
            }
            if (t.Kind == SqlTokenKind.Parameter && t.Value.Length > 1 && t.Value[0] is ':' or '@'
                && (char.IsLetter(t.Value[1]) || t.Value[1] == '_'))
                list.Add(new ChPlaceholder(t.Value[1..], t.Start, t.End, null));
        }
        return list;
    }

    private static int FindClose(string sql, int from)
    {
        var depth = 0;
        var quote = '\0';
        for (var i = from; i < sql.Length; i++)
        {
            var c = sql[i];
            if (quote != '\0')
            {
                if (c == '\\') { i++; continue; }
                if (c == quote) quote = '\0';
                continue;
            }
            switch (c)
            {
                case '\'' or '"' or '`': quote = c; break;
                case '(': depth++; break;
                case ')': depth--; break;
                case '}' when depth <= 0: return i;
                case '\n' or ';' or '{': return -1;
            }
        }
        return -1;
    }

    public IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql) =>
        Scan(sql).Select(p => new ParamPlaceholder(p.Name, p.Start)).ToList();

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(parameters);
        var placeholders = Scan(command.CommandText);
        if (placeholders.Count == 0 || parameters.Count == 0)
            return new BoundParameters([], placeholders.Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList());

        var byName = new Dictionary<string, QueryParam>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters) byName.TryAdd(p.BareName, p);
        // A native placeholder fixes the type for every reference of that name.
        var declared = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var ph in placeholders) if (ph.Type is not null) declared.TryAdd(ph.Name, ph.Type);

        var bound = new List<(QueryParam, DbParameter)>();
        var missing = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var ph in placeholders)
        {
            if (!seen.Add(ph.Name)) continue;
            if (!byName.TryGetValue(ph.Name, out var p)) { missing.Add(ph.Name); continue; }
            if (p.IsOutput)
                throw EngineException.Validation($"Parameter '{p.BareName}': ClickHouse has no OUT parameters.", new { field = "params", name = p.BareName });
            object? value;
            try { value = ParamValues.ToClr(p); }
            catch (FormatException ex) { throw EngineException.Validation($"Parameter '{p.BareName}': {ex.Message}", new { field = "params", name = p.BareName }); }
            var type = declared.TryGetValue(ph.Name, out var d) ? d : TypeFor(p, value);
            types[ph.Name] = type;
            var parameter = new ClickHouseDbParameter { ParameterName = ph.Name, ClickHouseType = type, Value = Convert(value, type) };
            command.Parameters.Add(parameter);
            bound.Add((p, parameter));
        }

        // Rewrite :name / @name to {name:Type} (right to left keeps offsets valid).
        var text = command.CommandText;
        var sb = new StringBuilder(text);
        foreach (var ph in placeholders.Where(x => x.Type is null && types.ContainsKey(x.Name)).OrderByDescending(x => x.Start))
            sb.Remove(ph.Start, ph.End - ph.Start).Insert(ph.Start, "{" + ph.Name + ":" + types[ph.Name] + "}");
        command.CommandText = sb.ToString();
        return new BoundParameters(bound, missing);
    }

    public object? ReadOutput(DbParameter parameter) => ParamValues.ToWire(parameter.Value);

    /// <summary>The ClickHouse type a console parameter is sent as.</summary>
    public static string TypeFor(QueryParam p, object? value)
    {
        var baseType = p.Kind switch
        {
            ParamKinds.Int => "Int64",
            ParamKinds.Decimal => value is decimal m ? $"Decimal(38, {Math.Min(Scale(m), 37).ToString(CultureInfo.InvariantCulture)})" : "Decimal(38, 10)",
            ParamKinds.Float => "Float64",
            ParamKinds.Bool => "Bool",
            ParamKinds.Date => "Date",
            ParamKinds.DateTime => "DateTime64(6)",
            ParamKinds.DateTimeOffset => "DateTime64(6, 'UTC')",
            ParamKinds.Guid => "UUID",
            _ => "String",
        };
        return value is null ? $"Nullable({baseType})" : baseType;
    }

    private static int Scale(decimal m) => (decimal.GetBits(m)[3] >> 16) & 0xFF;

    /// <summary>The CLR value handed to the driver for <paramref name="type"/>.</summary>
    public static object Convert(object? value, string type) => value switch
    {
        null => DBNull.Value,
        DateTimeOffset dto => dto.UtcDateTime,
        TimeSpan ts => ts.ToString("c", CultureInfo.InvariantCulture),
        byte[] bytes => System.Convert.ToHexString(bytes),
        bool b when ChTypes.BaseName(ChTypes.Unwrap(type)) is not ("Bool" or "Boolean") => b ? 1 : 0,
        long l when ChTypes.BaseName(ChTypes.Unwrap(type)) is "String" => l.ToString(CultureInfo.InvariantCulture),
        _ => value,
    };
}
