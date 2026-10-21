using System.Net.Sockets;
using System.Text;
using DbStudio.Core.Models;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// Maps Npgsql errors and notices to engine models (docs/PLAN-PG.md 2.2): SQLSTATE as the code, the server's
/// position mapped back to the user's text (through the placeholder rewrite) as a document line/column, and
/// DETAIL / HINT / CONTEXT / internal query joined into <see cref="ErrorInfo.Detail"/>.
/// </summary>
public static class PgErrors
{
    /// <summary>
    /// Maps a server error raised by the batch. <paramref name="mapPosition"/> turns the server's 1-based position (in the
    /// text that was sent) into a 0-based offset in <c>batch.Sql</c>; null = no mapping possible (first code line).
    /// </summary>
    public static ErrorInfo FromException(PostgresException pg, SqlBatch batch, Func<int, int?>? mapPosition = null)
    {
        ArgumentNullException.ThrowIfNull(pg);
        int? line = null, col = null;
        if (pg.Position > 0 && mapPosition?.Invoke(pg.Position) is int offset)
        {
            var (l, c) = PgSqlText.LineColAt(batch.Sql, Math.Clamp(offset, 0, batch.Sql.Length));
            line = DocumentLine(batch, l);
            col = DocumentCol(batch, l, c);
        }
        line ??= DocumentLine(batch, PgSqlText.FirstTokenLine(batch.Sql));
        return new ErrorInfo(
            Code: string.IsNullOrEmpty(pg.SqlState) ? "PG" : pg.SqlState,
            Message: pg.MessageText,
            Line: line,
            Col: col,
            Detail: Detail(pg));
    }

    /// <summary>DETAIL / HINT / CONTEXT / QUERY lines in psql style; null when the server sent none.</summary>
    public static string? Detail(PostgresException pg)
    {
        var sb = new StringBuilder();
        void Add(string label, string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            if (sb.Length > 0) sb.Append('\n');
            sb.Append(label).Append(": ").Append(value.Trim());
        }
        Add("DETAIL", pg.Detail);
        Add("HINT", pg.Hint);
        Add("CONTEXT", pg.Where);
        if (!string.IsNullOrWhiteSpace(pg.InternalQuery))
            Add("QUERY", pg.InternalPosition > 0 ? $"{pg.InternalQuery} (at character {pg.InternalPosition})" : pg.InternalQuery);
        if (!string.IsNullOrEmpty(pg.ConstraintName)) Add("CONSTRAINT", pg.ConstraintName);
        return sb.Length == 0 ? null : sb.ToString();
    }

    /// <summary>Message text of a NOTICE/WARNING/INFO, with DETAIL / HINT / CONTEXT lines (CONTEXT names the PL/pgSQL line of a RAISE).</summary>
    public static string NoticeText(PostgresNotice n)
    {
        var sb = new StringBuilder(n.MessageText);
        if (!string.IsNullOrWhiteSpace(n.Detail)) sb.Append("\nDETAIL: ").Append(n.Detail.Trim());
        if (!string.IsNullOrWhiteSpace(n.Hint)) sb.Append("\nHINT: ").Append(n.Hint.Trim());
        if (!string.IsNullOrWhiteSpace(n.Where)) sb.Append("\nCONTEXT: ").Append(n.Where.Trim());
        return sb.ToString();
    }

    /// <summary>WARNING → Warning; NOTICE, INFO, LOG, DEBUG → Info.</summary>
    public static MessageSeverity NoticeSeverity(PostgresNotice n) =>
        (n.InvariantSeverity ?? n.Severity ?? "").ToUpperInvariant() switch
        {
            "WARNING" => MessageSeverity.Warning,
            "ERROR" or "FATAL" or "PANIC" => MessageSeverity.Error,
            _ => MessageSeverity.Info,
        };

    /// <summary>SQLSTATEs after which the connection is gone (admin shutdown, crash shutdown, cannot connect now, class 08).</summary>
    public static bool IsConnectionLossState(string? sqlState) =>
        sqlState is "57P01" or "57P02" or "57P03" || (sqlState?.StartsWith("08", StringComparison.Ordinal) ?? false);

    /// <summary>Connection-level failure (socket, I/O, server shutdown) as opposed to a statement error.</summary>
    public static bool IsConnectionFailure(Exception? ex) => ex switch
    {
        PostgresException pg => IsConnectionLossState(pg.SqlState),
        NpgsqlException { InnerException: IOException or SocketException or TimeoutException } => true,
        NpgsqlException n => n.IsTransient && n is not PostgresException,
        IOException or SocketException => true,
        _ => false,
    };

    /// <summary>The error of <c>POST /connections/test</c>: code PROVIDER_ERROR, the SQLSTATE (28P01 bad password, 3D000 unknown database) in Detail.</summary>
    public static ErrorInfo ToProviderError(Exception ex) => ex switch
    {
        PostgresException pg => new ErrorInfo("PROVIDER_ERROR", pg.MessageText,
            Detail: string.Join("\n", new[] { "SQLSTATE " + pg.SqlState, Detail(pg) }.Where(s => !string.IsNullOrEmpty(s)))),
        NpgsqlException { InnerException: { } inner } n when n.Message.StartsWith("Exception while", StringComparison.Ordinal) =>
            new ErrorInfo("PROVIDER_ERROR", inner.Message, Detail: inner.GetType().Name),
        _ => new ErrorInfo("PROVIDER_ERROR", ex.Message, Detail: ex.GetType().Name),
    };

    private static int DocumentLine(SqlBatch batch, int batchRelativeLine) => batch.Line + Math.Max(1, batchRelativeLine) - 1;

    private static int DocumentCol(SqlBatch batch, int batchRelativeLine, int col) => batchRelativeLine <= 1 ? batch.Col + col - 1 : col;
}
