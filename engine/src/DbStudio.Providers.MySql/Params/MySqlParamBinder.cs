using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using MySqlConnector;

namespace DbStudio.Providers.MySql.Params;

/// <summary>
/// MySQL / MariaDB parameter binding (plan-batch3 WP-MY). Placeholders: <c>:name</c> (rewritten to <c>@name</c>),
/// <c>@name</c> — bound only when a value with that name is given, otherwise it stays a user variable — and <c>?</c>
/// (rewritten to <c>@__p1</c>, <c>@__p2</c> … consuming the positional values in order). MySqlConnector interpolates the
/// values client-side as escaped literals. Out / inout values are user variables: the session sets
/// <c>@name</c> before the statement (inout) and reads it back afterwards (<see cref="OutputVariables"/>).
/// </summary>
public sealed class MySqlParamBinder : IParamBinder
{
    public static readonly MySqlParamBinder Instance = new();

    public const string PositionalPrefix = "__p";

    public string ProviderId => "mysql";

    public IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql) =>
        MySqlSqlText.Placeholders(sql).Select(p => new ParamPlaceholder(p.Name, p.Start)).ToList();

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count == 0) return BoundParameters.None;
        var text = command.CommandText;
        var placeholders = MySqlSqlText.Placeholders(text);
        if (placeholders.Count == 0) return BoundParameters.None;

        var byName = new Dictionary<string, QueryParam>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters) byName.TryAdd(p.BareName, p);
        var positional = parameters.Where(p => p.IsPositional).OrderBy(p => int.Parse(p.BareName, CultureInfo.InvariantCulture)).ToList();

        var sb = new StringBuilder(text.Length + 16);
        var last = 0;
        var bound = new List<(QueryParam, DbParameter)>();
        var added = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var missing = new List<string>();
        var unnamed = 0;
        foreach (var ph in placeholders)
        {
            string? replacement = null;
            if (ph.Name is null)
            {
                unnamed++;
                var index = cursor.NextPositional++;
                if (index < positional.Count)
                {
                    var p = positional[index];
                    var name = PositionalPrefix + unnamed.ToString(CultureInfo.InvariantCulture) + "_" + index.ToString(CultureInfo.InvariantCulture);
                    replacement = "@" + name;
                    var parameter = Create(p, name);
                    if (!p.IsOutput) command.Parameters.Add(parameter);
                    bound.Add((p, parameter));
                }
                else
                {
                    missing.Add("?" + unnamed.ToString(CultureInfo.InvariantCulture));
                }
            }
            else if (byName.TryGetValue(ph.Name, out var named))
            {
                if (ph.Prefix == ':') replacement = "@" + ph.Name;
                if (added.Add(named.BareName))
                {
                    var parameter = Create(named, ph.Name);
                    if (!named.IsOutput) command.Parameters.Add(parameter);
                    bound.Add((named, parameter));
                }
            }
            else if (ph.Prefix == ':')
            {
                missing.Add(ph.Name);
            }
            // @name without a value: a user variable, left alone.

            if (replacement is null) continue;
            sb.Append(text, last, ph.Start - last).Append(replacement);
            last = ph.End;
        }
        if (last > 0)
        {
            sb.Append(text, last, text.Length - last);
            command.CommandText = sb.ToString();
        }
        return new BoundParameters(bound, missing);
    }

    /// <summary>Out / inout parameters of a bound command: the user variables to set before and read after the statement.</summary>
    public static IReadOnlyList<(QueryParam Param, MySqlParameter Parameter)> OutputVariables(BoundParameters bound) =>
        bound.Outputs.Select(o => (o.Param, (MySqlParameter)o.Parameter)).ToList();

    public static MySqlParameter Create(QueryParam p, string name)
    {
        if (p.Kind == ParamKinds.RefCursor)
            throw EngineException.Validation($"Parameter '{p.BareName}': MySQL has no REF CURSOR binds; a procedure returns its result sets directly.",
                new { field = "params", name = p.BareName });
        var parameter = new MySqlParameter { ParameterName = "@" + name };
        parameter.Direction = p.EffectiveDirection switch
        {
            ParamDirections.Out => ParameterDirection.Output,
            ParamDirections.InOut => ParameterDirection.InputOutput,
            _ => ParameterDirection.Input,
        };
        if (p.EffectiveDirection == ParamDirections.Out)
        {
            parameter.Value = DBNull.Value;
            return parameter;
        }
        var value = ParamValues.ToClr(p);
        if (value is null)
        {
            parameter.Value = DBNull.Value;
            return parameter;
        }
        switch (p.Kind)
        {
            case ParamKinds.Int:
                parameter.MySqlDbType = MySqlDbType.Int64;
                parameter.Value = (long)value;
                break;
            case ParamKinds.Decimal:
                parameter.MySqlDbType = MySqlDbType.NewDecimal;
                parameter.Value = (decimal)value;
                break;
            case ParamKinds.Float:
                parameter.MySqlDbType = MySqlDbType.Double;
                parameter.Value = (double)value;
                break;
            case ParamKinds.Bool:
                parameter.MySqlDbType = MySqlDbType.Bool;
                parameter.Value = (bool)value;
                break;
            case ParamKinds.Date:
                parameter.MySqlDbType = MySqlDbType.Date;
                parameter.Value = DateOnly.FromDateTime((DateTime)value);
                break;
            case ParamKinds.DateTime:
                parameter.MySqlDbType = MySqlDbType.DateTime;
                parameter.Value = DateTime.SpecifyKind((DateTime)value, DateTimeKind.Unspecified);
                break;
            case ParamKinds.DateTimeOffset:
                // MySQL has no zoned type: bind the UTC instant.
                parameter.MySqlDbType = MySqlDbType.DateTime;
                parameter.Value = ((DateTimeOffset)value).UtcDateTime;
                break;
            case ParamKinds.Time:
                parameter.MySqlDbType = MySqlDbType.Time;
                parameter.Value = (TimeSpan)value;
                break;
            case ParamKinds.Guid:
                parameter.MySqlDbType = MySqlDbType.VarChar;
                parameter.Value = ((Guid)value).ToString("D");
                break;
            case ParamKinds.Binary:
                parameter.MySqlDbType = MySqlDbType.VarBinary;
                parameter.Value = (byte[])value;
                break;
            default:
                parameter.MySqlDbType = MySqlDbType.VarChar;
                parameter.Value = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
                break;
        }
        return parameter;
    }

    public object? ReadOutput(DbParameter parameter) => ParamValues.ToWire(parameter.Value);
}
