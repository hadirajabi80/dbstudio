using System.Data.Common;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using Npgsql;
using NpgsqlTypes;

namespace DbStudio.Providers.PostgreSql.Params;

/// <summary>
/// PostgreSQL parameter binding (docs/PLAN-PG.md D-PG4, 2.4). Every placeholder — <c>$n</c>, <c>:name</c>, <c>@name</c> —
/// is rewritten to positional <c>$k</c> (<see cref="PgSqlText.Rewrite"/>) and bound as unnamed <see cref="NpgsqlParameter"/>s
/// in slot order (Npgsql positional mode); <c>$k</c> without a value gets an untyped NULL so <c>$3</c> without <c>$2</c>
/// still works. <c>?</c> is never a placeholder (it is the jsonb key-exists operator). Strings and nulls bind as
/// <see cref="NpgsqlDbType.Unknown"/> so the server infers the type like a quoted literal (<c>uuid_col = $1</c>,
/// <c>jsonb_col @&gt; $1</c>, <c>enum_col = $1</c> all work). PostgreSQL has no OUT binds or REF CURSOR parameters.
/// </summary>
public sealed class PgParamBinder : IParamBinder
{
    public static readonly PgParamBinder Instance = new();

    public string ProviderId => "postgresql";

    /// <summary><c>$n</c> → name "n" (positional), <c>:x</c>/<c>@x</c> → "x"; in order of appearance, duplicates kept.</summary>
    public IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql) =>
        PgSqlText.Placeholders(sql).Select(p => new ParamPlaceholder(p.Name, p.Start)).ToList();

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(command);
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Count == 0) return BoundParameters.None;
        var rewrite = PgSqlText.Rewrite(command.CommandText);
        if (rewrite.Slots.Count == 0) return BoundParameters.None;

        var byName = new Dictionary<string, QueryParam>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters) byName.TryAdd(p.BareName, p);

        command.CommandText = rewrite.Text;
        command.Parameters.Clear();
        var bound = new List<(QueryParam, DbParameter)>();
        var missing = new List<string>();
        var slots = rewrite.Slots.ToDictionary(s => s.Index, s => s.Name);
        for (var index = 1; index <= rewrite.MaxIndex; index++)
        {
            if (!slots.TryGetValue(index, out var name))
            {
                command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Unknown, Value = DBNull.Value });
                continue;
            }
            if (byName.TryGetValue(name, out var param))
            {
                DbParameter parameter;
                try
                {
                    parameter = CreateParameter(param);
                }
                catch (FormatException ex)
                {
                    throw EngineException.Validation($"Parameter '{param.BareName}': {ex.Message}", new { field = "params", name = param.BareName });
                }
                command.Parameters.Add(parameter);
                bound.Add((param, parameter));
            }
            else
            {
                missing.Add(name);
                command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Unknown, Value = DBNull.Value });
            }
        }
        return new BoundParameters(bound, missing);
    }

    /// <summary>The unnamed (positional) Npgsql parameter for one value.</summary>
    public static NpgsqlParameter CreateParameter(QueryParam p)
    {
        if (p.Kind == ParamKinds.RefCursor)
            throw EngineException.Validation($"Parameter '{p.BareName}': PostgreSQL has no REF CURSOR binds; FETCH ALL FROM the cursor inside the same transaction.",
                new { field = "params", name = p.BareName });
        if (p.IsOutput)
            throw EngineException.Validation($"Parameter '{p.BareName}': PostgreSQL returns OUT parameters as a result row; bind them as in.",
                new { field = "params", name = p.BareName });

        var value = ParamValues.ToClr(p);
        var parameter = new NpgsqlParameter();
        if (value is null)
        {
            parameter.NpgsqlDbType = NpgsqlDbType.Unknown;
            parameter.Value = DBNull.Value;
            return parameter;
        }
        switch (p.Kind)
        {
            case ParamKinds.Int:
            {
                // integer when it fits (function resolution casts int4 → int8/numeric implicitly, not int8 → int4), else bigint.
                var l = (long)value;
                if (l is >= int.MinValue and <= int.MaxValue)
                {
                    parameter.NpgsqlDbType = NpgsqlDbType.Integer;
                    parameter.Value = (int)l;
                }
                else
                {
                    parameter.NpgsqlDbType = NpgsqlDbType.Bigint;
                    parameter.Value = l;
                }
                break;
            }
            case ParamKinds.Decimal:
                parameter.NpgsqlDbType = NpgsqlDbType.Numeric;
                parameter.Value = (decimal)value;
                break;
            case ParamKinds.Float:
                parameter.NpgsqlDbType = NpgsqlDbType.Double;
                parameter.Value = (double)value;
                break;
            case ParamKinds.Bool:
                parameter.NpgsqlDbType = NpgsqlDbType.Boolean;
                parameter.Value = (bool)value;
                break;
            case ParamKinds.Date:
                parameter.NpgsqlDbType = NpgsqlDbType.Date;
                parameter.Value = DateOnly.FromDateTime((DateTime)value);
                break;
            case ParamKinds.DateTime:
            {
                var dt = (DateTime)value;
                if (dt.Kind == DateTimeKind.Utc)
                {
                    parameter.NpgsqlDbType = NpgsqlDbType.TimestampTz;
                    parameter.Value = dt;
                }
                else
                {
                    parameter.NpgsqlDbType = NpgsqlDbType.Timestamp;
                    parameter.Value = DateTime.SpecifyKind(dt, DateTimeKind.Unspecified);
                }
                break;
            }
            case ParamKinds.DateTimeOffset:
                parameter.NpgsqlDbType = NpgsqlDbType.TimestampTz;
                parameter.Value = ((DateTimeOffset)value).ToUniversalTime();
                break;
            case ParamKinds.Time:
                parameter.NpgsqlDbType = NpgsqlDbType.Time;
                parameter.Value = (TimeSpan)value;
                break;
            case ParamKinds.Guid:
                parameter.NpgsqlDbType = NpgsqlDbType.Uuid;
                parameter.Value = (Guid)value;
                break;
            case ParamKinds.Binary:
                parameter.NpgsqlDbType = NpgsqlDbType.Bytea;
                parameter.Value = (byte[])value;
                break;
            default:
                // Strings: untyped, the server infers the type from the context like a quoted literal.
                parameter.NpgsqlDbType = NpgsqlDbType.Unknown;
                parameter.Value = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? "";
                break;
        }
        return parameter;
    }

    /// <summary>PostgreSQL has no output parameters (OUT/INOUT values come back as a result row).</summary>
    public object? ReadOutput(DbParameter parameter) => ParamValues.ToWire(parameter.Value);
}
