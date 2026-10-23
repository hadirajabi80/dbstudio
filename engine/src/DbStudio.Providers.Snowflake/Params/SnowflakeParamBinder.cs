using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.Snowflake.Params;

/// <summary>
/// Snowflake parameter binding. Placeholders are <c>:name</c>, <c>:1</c> and <c>?</c>; never <c>$1</c> (a staged file
/// column), <c>@stage</c> (a stage) or a VARIANT path (<c>v:name</c>, <c>t.v:a.b</c>: the colon follows the value without
/// a space). Bound placeholders are rewritten to numeric binds <c>:1 … :n</c> (one number per distinct name, one per
/// <c>?</c>) and bound as parameters "1" … "n"; placeholders without a value stay as typed (Snowflake Scripting
/// <c>:variable</c> references). Snowflake has no OUT binds: CALL returns its value as a result set.
/// </summary>
public sealed class SnowflakeParamBinder : IParamBinder
{
    public static readonly SnowflakeParamBinder Instance = new();

    public string ProviderId => "snowflake";

    public IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql) =>
        Placeholders(sql).Select(p => new ParamPlaceholder(p.Name, p.Start)).ToList();

    /// <summary>A placeholder token: <paramref name="Name"/> bare ("id", "1") or null for <c>?</c>.</summary>
    public readonly record struct Placeholder(string? Name, int Start, int End);

    public static List<Placeholder> Placeholders(string sql)
    {
        var list = new List<Placeholder>();
        foreach (var t in SqlTokenizer.Tokenize(sql, Dialect.Snowflake))
        {
            if (t.Kind != SqlTokenKind.Parameter) continue;
            if (t.Value == "?") { list.Add(new Placeholder(null, t.Start, t.End)); continue; }
            if (t.Value[0] == '?') { list.Add(new Placeholder(t.Value[1..], t.Start, t.End)); continue; }
            if (t.Value[0] != ':') continue;
            if (IsPathColon(sql, t.Start)) continue;
            list.Add(new Placeholder(t.Value[1..], t.Start, t.End));
        }
        return list;
    }

    /// <summary><c>col:field</c>, <c>"Col":field</c>, <c>v[0]:x</c>, <c>f(x):y</c>: the colon directly follows a value.</summary>
    public static bool IsPathColon(string sql, int colon)
    {
        if (colon == 0) return false;
        var prev = sql[colon - 1];
        return char.IsLetterOrDigit(prev) || prev is '_' or '$' or '"' or ']' or ')';
    }

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count == 0) return BoundParameters.None;
        var sql = command.CommandText;
        var placeholders = Placeholders(sql);
        if (placeholders.Count == 0) return BoundParameters.None;

        var byName = new Dictionary<string, QueryParam>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters) byName.TryAdd(p.BareName, p);
        var positional = parameters.Where(p => p.IsPositional)
            .OrderBy(p => int.Parse(p.BareName, CultureInfo.InvariantCulture)).ToList();

        var bound = new List<(QueryParam, DbParameter)>();
        var missing = new List<string>();
        var numberOf = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder(sql.Length + 16);
        var last = 0;
        var next = 0;
        var unnamed = 0;
        foreach (var ph in placeholders)
        {
            QueryParam? param;
            string key;
            if (ph.Name is null)
            {
                unnamed++;
                var index = cursor.NextPositional++;
                param = index < positional.Count ? positional[index] : null;
                key = "?" + unnamed.ToString(CultureInfo.InvariantCulture);
                if (param is null) { missing.Add(key); continue; }
            }
            else
            {
                key = ph.Name;
                if (!byName.TryGetValue(ph.Name, out param))
                {
                    if (!missing.Contains(ph.Name, StringComparer.OrdinalIgnoreCase)) missing.Add(ph.Name);
                    continue;
                }
            }
            if (ph.Name is null || !numberOf.TryGetValue(key, out var number))
            {
                number = ++next;
                if (ph.Name is not null) numberOf[key] = number;
                bound.Add((param, Add(command, param, number)));
            }
            sb.Append(sql, last, ph.Start - last).Append(':').Append(number.ToString(CultureInfo.InvariantCulture));
            last = ph.End;
        }
        if (bound.Count == 0) return new BoundParameters(bound, missing);
        sb.Append(sql, last, sql.Length - last);
        command.CommandText = sb.ToString();
        return new BoundParameters(bound, missing);
    }

    private static DbParameter Add(DbCommand command, QueryParam p, int number)
    {
        if (p.IsOutput)
            throw EngineException.Validation($"Parameter '{p.BareName}': Snowflake has no OUT parameters (CALL returns its value as a result).",
                new { field = "params", name = p.BareName });
        object? value;
        try
        {
            value = ParamValues.ToClr(p);
        }
        catch (FormatException ex)
        {
            throw EngineException.Validation($"Parameter '{p.BareName}': {ex.Message}", new { field = "params", name = p.BareName });
        }
        var parameter = command.CreateParameter();
        parameter.ParameterName = number.ToString(CultureInfo.InvariantCulture);
        parameter.Direction = ParameterDirection.Input;
        (parameter.DbType, parameter.Value) = (p.Kind, value) switch
        {
            (_, null) => (DbType.String, (object)DBNull.Value),
            (ParamKinds.Int, long l) => (DbType.Int64, l),
            (ParamKinds.Decimal, decimal m) => (DbType.Decimal, m),
            (ParamKinds.Float, double d) => (DbType.Double, d),
            (ParamKinds.Bool, bool b) => (DbType.Boolean, b),
            (ParamKinds.Date, DateTime dt) => (DbType.Date, dt.Date),
            (ParamKinds.DateTime, DateTime dt) => (DbType.DateTime, dt),
            (ParamKinds.DateTimeOffset, DateTimeOffset dto) => (DbType.DateTimeOffset, dto),
            (ParamKinds.Time, TimeSpan ts) => (DbType.String, ts.ToString("c", CultureInfo.InvariantCulture)),
            (ParamKinds.Binary, byte[] bytes) => (DbType.Binary, bytes),
            (_, Guid g) => (DbType.String, g.ToString()),
            (_, var v) => (DbType.String, Convert.ToString(v, CultureInfo.InvariantCulture) ?? ""),
        };
        command.Parameters.Add(parameter);
        return parameter;
    }

    public object? ReadOutput(DbParameter parameter) => ParamValues.ToWire(parameter.Value);
}
