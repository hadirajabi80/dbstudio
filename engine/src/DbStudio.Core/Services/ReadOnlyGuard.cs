using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Core.Services;

/// <summary>
/// Engine-side enforcement of read-only connections (docs/PLAN.md D-13), shared by every path that runs user SQL on a
/// session: executions, explain (actual), and query exports.
/// </summary>
public static class ReadOnlyGuard
{
    /// <summary>
    /// 403 READ_ONLY when the session's connection is read-only and a batch is not query-only, unless the user
    /// explicitly confirmed writes (<paramref name="confirmedDestructive"/>).
    /// </summary>
    public static void Enforce(SessionHandle h, IReadOnlyList<SqlBatch> batches, bool confirmedDestructive)
    {
        if (!h.Profile.ReadOnly || confirmedDestructive) return;
        foreach (var batch in batches)
        {
            var classification = StatementClassifier.Classify(batch.Sql, h.Dialect);
            if (classification.IsQueryOnly) continue;
            throw Refusal(h, batch, classification);
        }
    }

    /// <summary>
    /// Query exports (<c>POST /export</c>) only ever read: anything but a single query is refused, with 403 READ_ONLY on
    /// read-only connections (the read-only guard has no override here) and 400 VALIDATION otherwise.
    /// </summary>
    public static void EnforceExportQuery(SessionHandle h, string sql)
    {
        var classification = StatementClassifier.Classify(sql, h.Dialect);
        var statements = classification.Statements;
        var singleQuery = classification.IsQueryOnly && statements.Count == 1 && statements[0].Category == StatementCategory.Query;
        if (singleQuery) return;
        var batch = new SqlBatch(sql, 1, 1);
        if (h.Profile.ReadOnly && !classification.IsQueryOnly) throw Refusal(h, batch, classification);
        throw EngineException.Validation("Export needs a single SELECT statement (no data changes, no multiple statements).",
            new { field = "sql", kind = classification.PrimaryKind, statements = statements.Count });
    }

    private static EngineException Refusal(SessionHandle h, SqlBatch batch, BatchClassification classification)
    {
        var kind = classification.Statements.FirstOrDefault(s => s.Category is not (StatementCategory.Query or StatementCategory.Session or StatementCategory.Transaction))?.Kind
                   ?? classification.PrimaryKind ?? "statement";
        return new EngineException(403, ErrorCodes.ReadOnly,
            $"The connection '{h.Profile.Name}' is read-only: {kind} is not allowed.",
            new { line = batch.Line, kind });
    }
}
