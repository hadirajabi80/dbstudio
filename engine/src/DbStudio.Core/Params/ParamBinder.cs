using System.Data.Common;
using DbStudio.Core.Services;

namespace DbStudio.Core.Params;

/// <summary>A bind placeholder found in a statement. <see cref="Name"/> is bare ("id", "1"); null for an unnamed <c>?</c>.</summary>
public readonly record struct ParamPlaceholder(string? Name, int Offset);

/// <summary>Parameters bound to one command.</summary>
public sealed class BoundParameters
{
    public static readonly BoundParameters None = new([], []);

    public BoundParameters(IReadOnlyList<(QueryParam Param, DbParameter Parameter)> bound, IReadOnlyList<string> missing)
    {
        Bound = bound;
        Missing = missing;
    }

    public IReadOnlyList<(QueryParam Param, DbParameter Parameter)> Bound { get; }

    /// <summary>Placeholders of the statement without a matching parameter (bare names; "?n" for the n-th unnamed one).</summary>
    public IReadOnlyList<string> Missing { get; }

    public IEnumerable<(QueryParam Param, DbParameter Parameter)> Outputs => Bound.Where(b => b.Param.IsOutput);
}

/// <summary>Consumption state of positional (<c>?</c>) parameters across the batches of one execution.</summary>
public sealed class ParamBindCursor
{
    public int NextPositional { get; set; }
}

/// <summary>
/// Binds <see cref="QueryParam"/>s to a provider command (docs/PLAN-M1.5.md 3.8). Registered as a keyed service by
/// provider id; provider sessions use their binder for every batch of a request with params.
/// </summary>
public interface IParamBinder
{
    string ProviderId { get; }

    /// <summary>Placeholders referenced by the statement text (in order of appearance, duplicates kept).</summary>
    IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql);

    /// <summary>Adds the parameters the statement references to <paramref name="command"/> (whose CommandText is final).</summary>
    BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor);

    /// <summary>Wire value of an out/inout parameter after execution.</summary>
    object? ReadOutput(DbParameter parameter);
}

/// <summary>
/// Shared matching logic: named placeholders bind the parameter with the same bare name (case-insensitive);
/// unnamed <c>?</c> placeholders consume positional parameters ("1", "2", ...) in order across the batches of an
/// execution. Parameters a statement does not reference are skipped, so a multi-statement request can carry the
/// parameters of all its statements (with distinct names).
/// </summary>
public abstract class ParamBinderBase : IParamBinder
{
    public abstract string ProviderId { get; }

    public abstract IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql);

    /// <summary>Creates the provider parameter for <paramref name="p"/> bound to placeholder <paramref name="placeholderName"/> (bare; null = unnamed).</summary>
    protected abstract DbParameter CreateParameter(DbCommand command, QueryParam p, string? placeholderName);

    public virtual object? ReadOutput(DbParameter parameter) => ParamValues.ToWire(parameter.Value);

    /// <summary>
    /// Optional rewrite of the command text when it contains unnamed <c>?</c> placeholders (SQLite rewrites the n-th one
    /// to <c>?n</c> so it can be bound by name). Return null to keep the text. Placeholder offsets refer to <paramref name="sql"/>.
    /// </summary>
    protected virtual string? RewriteUnnamed(string sql, IReadOnlyList<ParamPlaceholder> placeholders) => null;

    /// <summary>Placeholder name passed to <see cref="CreateParameter"/> for the n-th (1-based) unnamed placeholder; null by default.</summary>
    protected virtual string? UnnamedPlaceholderName(int ordinal) => null;

    public BoundParameters Bind(DbCommand command, IReadOnlyList<QueryParam> parameters, ParamBindCursor cursor)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (parameters.Count == 0) return BoundParameters.None;
        var placeholders = FindPlaceholders(command.CommandText);
        if (placeholders.Count == 0) return BoundParameters.None;
        if (placeholders.Any(p => p.Name is null) && RewriteUnnamed(command.CommandText, placeholders) is { } rewritten)
            command.CommandText = rewritten;

        var byName = new Dictionary<string, QueryParam>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters) byName.TryAdd(p.BareName, p);
        var positional = parameters.Where(p => p.IsPositional).OrderBy(p => int.Parse(p.BareName, System.Globalization.CultureInfo.InvariantCulture)).ToList();

        var bound = new List<(QueryParam, DbParameter)>();
        var missing = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var unnamed = 0;
        foreach (var ph in placeholders)
        {
            if (ph.Name is null)
            {
                unnamed++;
                var index = cursor.NextPositional++;
                if (index < positional.Count)
                {
                    var p = positional[index];
                    bound.Add((p, Add(command, p, UnnamedPlaceholderName(unnamed))));
                }
                else
                {
                    missing.Add("?" + unnamed.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
                continue;
            }
            if (!seen.Add(ph.Name)) continue;
            if (byName.TryGetValue(ph.Name, out var named)) bound.Add((named, Add(command, named, ph.Name)));
            else missing.Add(ph.Name);
        }
        return new BoundParameters(bound, missing);
    }

    private DbParameter Add(DbCommand command, QueryParam p, string? placeholderName)
    {
        DbParameter parameter;
        try
        {
            parameter = CreateParameter(command, p, placeholderName);
        }
        catch (FormatException ex)
        {
            throw EngineException.Validation($"Parameter '{p.BareName}': {ex.Message}", new { field = "params", name = p.BareName });
        }
        command.Parameters.Add(parameter);
        return parameter;
    }

    /// <summary>ParameterDirection of a param.</summary>
    protected static System.Data.ParameterDirection DirectionOf(QueryParam p) => p.EffectiveDirection switch
    {
        ParamDirections.Out => System.Data.ParameterDirection.Output,
        ParamDirections.InOut => System.Data.ParameterDirection.InputOutput,
        _ => System.Data.ParameterDirection.Input,
    };

    /// <summary>Size for variable-length out params.</summary>
    protected static int OutSize(QueryParam p, int fallback = 4000) => p.Size is > 0 ? p.Size.Value : fallback;
}
