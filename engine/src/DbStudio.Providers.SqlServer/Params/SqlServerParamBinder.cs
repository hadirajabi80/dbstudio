using System.Data;
using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer.Params;

/// <summary>
/// SQL Server parameter binding (docs/PLAN-M1.5.md A2): <c>@name</c> placeholders that are not declared by a
/// <c>DECLARE</c> in the same batch bind the parameter with that name; SqlClient sends the batch through
/// <c>sp_executesql</c>. Typed binds: int → int/bigint, decimal → decimal(38, s), string → nvarchar(4000|max),
/// datetime → datetime2(7), binary → varbinary(8000|max), etc. Positional <c>?</c> placeholders are rejected.
/// </summary>
public sealed class SqlServerParamBinder : ParamBinderBase
{
    public static readonly SqlServerParamBinder Instance = new();

    private static readonly HashSet<string> StatementStarters = new(StringComparer.OrdinalIgnoreCase)
    {
        "SELECT", "SET", "INSERT", "UPDATE", "DELETE", "MERGE", "EXEC", "EXECUTE", "IF", "WHILE", "BEGIN", "RETURN",
        "PRINT", "WITH", "DECLARE", "CREATE", "ALTER", "DROP", "TRUNCATE", "OPEN", "FETCH", "CLOSE", "DEALLOCATE", "RAISERROR", "THROW",
    };

    public override string ProviderId => "sqlserver";

    public override IReadOnlyList<ParamPlaceholder> FindPlaceholders(string sql)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.TSql);
        var declared = DeclaredVariables(tokens);
        var result = new List<ParamPlaceholder>();
        foreach (var t in tokens)
        {
            if (t.Kind == SqlTokenKind.Parameter && t.Value == "?")
            {
                result.Add(new ParamPlaceholder(null, t.Start));
                continue;
            }
            if (t.Kind != SqlTokenKind.Word || t.Value.Length < 2 || t.Value[0] != '@' || t.Value[1] == '@') continue;
            var name = t.Value[1..];
            if (!declared.Contains(name)) result.Add(new ParamPlaceholder(name, t.Start));
        }
        return result;
    }

    /// <summary>Variables declared by DECLARE statements of the batch (@a int, @b table(...), ...).</summary>
    public static HashSet<string> DeclaredVariables(IReadOnlyList<SqlToken> tokens)
    {
        var declared = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < tokens.Count; i++)
        {
            if (!tokens[i].IsWord("DECLARE")) continue;
            var depth = 0;
            var expectName = true;
            for (var j = i + 1; j < tokens.Count; j++)
            {
                var t = tokens[j];
                if (t.IsPunct('(')) { depth++; continue; }
                if (t.IsPunct(')')) { depth = Math.Max(0, depth - 1); continue; }
                if (depth > 0) continue;
                if (t.IsPunct(';')) break;
                if (t.IsPunct(',')) { expectName = true; continue; }
                if (expectName && t.Kind == SqlTokenKind.Word && t.Value.StartsWith('@') && !t.Value.StartsWith("@@", StringComparison.Ordinal))
                {
                    declared.Add(t.Value[1..]);
                    expectName = false;
                    continue;
                }
                if (!expectName && t.Kind == SqlTokenKind.Word && StatementStarters.Contains(t.Value)) break;
                expectName = false;
            }
        }
        return declared;
    }

    protected override DbParameter CreateParameter(DbCommand command, QueryParam p, string? placeholderName)
    {
        if (placeholderName is null)
            throw EngineException.Validation("SQL Server uses named parameters (@name), not '?'.", new { field = "params", name = p.BareName });
        if (p.Kind == ParamKinds.RefCursor)
            throw EngineException.Validation($"Parameter '{p.BareName}': SQL Server has no REF CURSOR parameters; return a result set instead.", new { field = "params", name = p.BareName });

        var parameter = new SqlParameter { ParameterName = "@" + placeholderName, Direction = DirectionOf(p) };
        var value = p.EffectiveDirection == ParamDirections.Out ? null : ParamValues.ToClr(p);
        switch (p.Kind)
        {
            case ParamKinds.Int:
                if (value is long l && l is >= int.MinValue and <= int.MaxValue && !p.IsOutput) { parameter.SqlDbType = SqlDbType.Int; parameter.Value = (int)l; }
                else { parameter.SqlDbType = SqlDbType.BigInt; parameter.Value = value ?? DBNull.Value; }
                break;
            case ParamKinds.Decimal:
                parameter.SqlDbType = SqlDbType.Decimal;
                parameter.Precision = 38;
                parameter.Scale = value is decimal m ? (byte)Math.Min((int)m.Scale, 38) : (byte)(p.IsOutput ? 10 : 0);
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Float:
                parameter.SqlDbType = SqlDbType.Float;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Bool:
                parameter.SqlDbType = SqlDbType.Bit;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Date:
                parameter.SqlDbType = SqlDbType.Date;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.DateTime:
                parameter.SqlDbType = SqlDbType.DateTime2;
                parameter.Scale = 7;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.DateTimeOffset:
                parameter.SqlDbType = SqlDbType.DateTimeOffset;
                parameter.Scale = 7;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Time:
                parameter.SqlDbType = SqlDbType.Time;
                parameter.Scale = 7;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Guid:
                parameter.SqlDbType = SqlDbType.UniqueIdentifier;
                parameter.Value = value ?? DBNull.Value;
                break;
            case ParamKinds.Binary:
                parameter.SqlDbType = SqlDbType.VarBinary;
                parameter.Size = value is byte[] { Length: > 8000 } || (p.IsOutput && OutSize(p, 8000) > 8000) ? -1 : 8000;
                parameter.Value = value ?? DBNull.Value;
                break;
            default: // string, null
                parameter.SqlDbType = SqlDbType.NVarChar;
                parameter.Size = value is string { Length: > 4000 } || (p.IsOutput && OutSize(p) > 4000) ? -1 : 4000;
                parameter.Value = value ?? DBNull.Value;
                break;
        }
        return parameter;
    }
}
