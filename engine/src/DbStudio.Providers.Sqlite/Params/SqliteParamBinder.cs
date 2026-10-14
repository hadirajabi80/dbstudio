using System.Data.Common;
using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite.Params;

/// <summary>
/// SQLite parameter binding (docs/PLAN-M1.5.md A2): named <c>:x</c>, <c>@x</c>, <c>$x</c> and numbered <c>?NNN</c>
/// placeholders bind by name; unnamed <c>?</c> placeholders are rewritten to the named placeholders <c>@__p1</c>,
/// <c>@__p2</c>, ... (a numbered <c>?1</c> would share SQLite's slot 1 with the first named parameter) and consume
/// positional parameters in order. SQLite has no output parameters or cursors.
/// Values: decimals bind as REAL when exactly representable (else TEXT), booleans as 0/1, dates/times and GUIDs as
/// ISO TEXT (the usual SQLite storage), binary as BLOB.
/// </summary>
public sealed class SqliteParamBinder : ParamBinderBase
{
    /// <summary>Unnamed placeholder n becomes @__p{n}.</summary>
    public const string UnnamedPrefix = "@__p";

    public static readonly SqliteParamBinder Instance = new();

    public override string ProviderId => "sqlite";

    public override IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql)
    {
        var result = new List<ParamPlaceholder>();
        foreach (var t in SqlTokenizer.Tokenize(sql, Dialect.Sqlite))
        {
            if (t.Kind != SqlTokenKind.Parameter) continue;
            result.Add(new ParamPlaceholder(t.Value == "?" ? null : ParamNames.Bare(t.Value), t.Start));
        }
        return result;
    }

    protected override string? RewriteUnnamed(string sql, IReadOnlyList<ParamPlaceholder> placeholders)
    {
        var sb = new StringBuilder(sql.Length + 8);
        var last = 0;
        var n = 0;
        foreach (var ph in placeholders)
        {
            if (ph.Name is not null) continue;
            n++;
            sb.Append(sql, last, ph.Offset - last).Append(UnnamedPrefix).Append(n.ToString(CultureInfo.InvariantCulture));
            last = ph.Offset + 1;
        }
        sb.Append(sql, last, sql.Length - last);
        return sb.ToString();
    }

    protected override string? UnnamedPlaceholderName(int ordinal) => UnnamedPrefix + ordinal.ToString(CultureInfo.InvariantCulture);

    protected override DbParameter CreateParameter(DbCommand command, QueryParam p, string? placeholderName)
    {
        if (p.Kind == ParamKinds.RefCursor)
            throw EngineException.Validation($"Parameter '{p.BareName}': SQLite has no REF CURSOR parameters.", new { field = "params", name = p.BareName });
        if (p.IsOutput)
            throw EngineException.Validation($"Parameter '{p.BareName}': SQLite has no output parameters.", new { field = "params", name = p.BareName });

        // Numbered placeholders (?3) are bound by their literal name; named ones by the bare name (the driver tries @ $ :).
        var name = placeholderName is null ? p.BareName
            : placeholderName.StartsWith(UnnamedPrefix, StringComparison.Ordinal) ? placeholderName
            : ParamNames.IsPositional(placeholderName) ? "?" + placeholderName
            : placeholderName;
        var parameter = new SqliteParameter { ParameterName = name };
        var value = ParamValues.ToClr(p);
        switch (value)
        {
            case null:
                parameter.Value = DBNull.Value;
                break;
            case long l:
                parameter.SqliteType = SqliteType.Integer;
                parameter.Value = l;
                break;
            case bool b:
                parameter.SqliteType = SqliteType.Integer;
                parameter.Value = b ? 1L : 0L;
                break;
            case decimal m:
                var d = (double)m;
                if ((decimal)d == m)
                {
                    parameter.SqliteType = SqliteType.Real;
                    parameter.Value = d;
                }
                else
                {
                    parameter.SqliteType = SqliteType.Text;
                    parameter.Value = m.ToString(CultureInfo.InvariantCulture);
                }
                break;
            case double dbl:
                parameter.SqliteType = SqliteType.Real;
                parameter.Value = dbl;
                break;
            case DateTime dt:
                parameter.SqliteType = SqliteType.Text;
                parameter.Value = p.Kind == ParamKinds.Date
                    ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture);
                break;
            case DateTimeOffset dto:
                parameter.SqliteType = SqliteType.Text;
                parameter.Value = dto.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFFzzz", CultureInfo.InvariantCulture);
                break;
            case TimeSpan ts:
                parameter.SqliteType = SqliteType.Text;
                parameter.Value = ValueConverter.FormatTimeSpan(ts);
                break;
            case Guid g:
                parameter.SqliteType = SqliteType.Text;
                parameter.Value = g.ToString("D");
                break;
            case byte[] bytes:
                parameter.SqliteType = SqliteType.Blob;
                parameter.Value = bytes;
                break;
            default:
                parameter.SqliteType = SqliteType.Text;
                parameter.Value = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
                break;
        }
        return parameter;
    }
}
