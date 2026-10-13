using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using Microsoft.Data.SqlClient;
using SqlBatch = DbStudio.Core.Models.SqlBatch;

namespace DbStudio.Providers.SqlServer;

/// <summary>Maps SqlClient errors/messages to engine models with document-absolute lines.</summary>
public static partial class SqlServerErrors
{
    /// <summary>A driver-independent view of <see cref="SqlError"/> (testable without a server).</summary>
    public readonly record struct ServerError(int Number, byte Class, byte State, int LineNumber, string? Procedure, string Message);

    public static ServerError From(SqlError e) => new(e.Number, e.Class, e.State, e.LineNumber, e.Procedure, e.Message);

    /// <summary>Severity ≥ 11 is an error; 0–10 are informational (PRINT, RAISERROR(..,10,..), "Changed database context").</summary>
    public static bool IsError(in ServerError e) => e.Class >= 11;

    /// <summary>
    /// Document line of a server error: SQL Server reports lines relative to the batch, or to the module when the error
    /// was raised inside a stored procedure/function/trigger that the batch merely calls (then the line is unknown here).
    /// </summary>
    public static int? DocumentLine(in ServerError e, SqlBatch batch)
    {
        if (e.LineNumber <= 0) return null;
        if (!string.IsNullOrEmpty(e.Procedure) && !BatchDefinesModule(batch.Sql, e.Procedure)) return null;
        return batch.Line + e.LineNumber - 1;
    }

    public static ErrorInfo ToErrorInfo(in ServerError e, SqlBatch batch) => new(
        Code: e.Number.ToString(CultureInfo.InvariantCulture),
        Message: e.Message,
        Line: DocumentLine(e, batch),
        Col: null,
        State: e.State,
        Detail: Header(e),
        ProviderCode: e.Number);

    /// <summary>SSMS-style header: "Msg 207, Level 16, State 1, Procedure p, Line 3".</summary>
    public static string Header(in ServerError e)
    {
        var s = $"Msg {e.Number}, Level {e.Class}, State {e.State}";
        if (!string.IsNullOrEmpty(e.Procedure)) s += $", Procedure {e.Procedure}";
        if (e.LineNumber > 0) s += $", Line {e.LineNumber}";
        return s;
    }

    /// <summary>Maps a thrown SqlException: the most severe error is primary, the others go into Detail.</summary>
    public static ErrorInfo FromException(SqlException ex, SqlBatch batch)
    {
        var errors = ex.Errors.Cast<SqlError>().Select(From).ToList();
        if (errors.Count == 0)
            return new ErrorInfo(ex.Number.ToString(CultureInfo.InvariantCulture), ex.Message, null, null, ex.State, null, ex.Number);
        var primary = errors.OrderByDescending(e => e.Class).First();
        var info = ToErrorInfo(primary, batch);
        if (errors.Count > 1)
        {
            var others = string.Join("\n", errors.Where(e => !e.Equals(primary)).Select(e => Header(e) + ": " + e.Message));
            info = info with { Detail = info.Detail + "\n" + others };
        }
        return info;
    }

    [GeneratedRegex(@"\b(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)\s+(?<name>(?:(?:\[[^\]]+\]|""[^""]+""|[\w@#$]+)\s*\.\s*){0,2}(?:\[[^\]]+\]|""[^""]+""|[\w@#$]+))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ModuleDefinition();

    /// <summary>True when the batch text itself creates/alters the module named <paramref name="procedure"/>.</summary>
    public static bool BatchDefinesModule(string sql, string procedure)
    {
        foreach (Match m in ModuleDefinition().Matches(sql))
        {
            var parts = SqlServerNames.SplitMultipart(m.Groups["name"].Value);
            if (string.Equals(parts[^1], procedure, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
