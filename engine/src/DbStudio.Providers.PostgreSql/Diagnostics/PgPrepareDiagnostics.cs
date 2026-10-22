using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Sql;
using Npgsql;

namespace DbStudio.Providers.PostgreSql.Diagnostics;

/// <summary>
/// Server-side diagnostics (docs/PLAN-PG.md D-PG5, 2.6, engine name <c>pg-prepare</c>): each query/DML statement of the
/// document is compiled with <c>BEGIN READ ONLY; PREPARE __dbstudio_diag AS &lt;stmt&gt;; ROLLBACK</c> on a pooled
/// connection opened with <c>default_transaction_read_only=on</c> and a 3 s <c>statement_timeout</c>. PREPARE parses,
/// resolves names and type-checks without executing, the transaction is always rolled back and the prepared statement
/// deallocated, so nothing runs. DDL, DO, CALL, COPY, EXPLAIN, SET/SHOW, transaction control and SELECT … INTO are never
/// sent. At most <see cref="MaxStatements"/> statements per call. Without a profile nothing is reported.
/// </summary>
public sealed class PgPrepareDiagnostics : ISqlDiagnostics
{
    public const int MaxStatements = 20;
    public const string StatementName = "__dbstudio_diag";
    public const string Prefix = "PREPARE " + StatementName + " AS ";

    /// <summary>Indeterminate/ambiguous parameter types are not errors of the statement; read-only cannot happen on PREPARE.</summary>
    private static readonly HashSet<string> IgnoredStates = new(StringComparer.Ordinal) { "42P18", "42P08", "25006", "57014" };

    public string EngineName => "pg-prepare";

    /// <summary>A statement that may be sent: its position in the document and the text PREPARE compiles (placeholders as $k).</summary>
    public sealed record Candidate(PgStatement Statement, string Original, PgRewrite Rewrite);

    /// <summary>The statements of <paramref name="sql"/> that are safe to PREPARE (queries and DML only), in order.</summary>
    public static List<Candidate> Candidates(string sql)
    {
        var list = new List<Candidate>();
        foreach (var st in PgSqlText.Split(sql))
        {
            var text = st.Text(sql);
            if (!IsSafeToPrepare(text)) continue;
            list.Add(new Candidate(st, text, PgSqlText.Rewrite(text)));
            if (list.Count >= MaxStatements) break;
        }
        return list;
    }

    /// <summary>SELECT / WITH … / VALUES / TABLE and INSERT / UPDATE / DELETE / MERGE (incl. data-modifying CTEs); nothing else.</summary>
    public static bool IsSafeToPrepare(string statement)
    {
        var c = PgSqlText.Classify(statement).Statements;
        if (c.Count != 1) return false;
        var s = c[0];
        return s.Category switch
        {
            StatementCategory.Query => s.Kind is "SELECT" or "VALUES" or "TABLE",
            StatementCategory.Dml => s.Kind is "INSERT" or "UPDATE" or "DELETE" or "MERGE",
            _ => false,
        };
    }

    public async Task<IReadOnlyList<SqlDiagnostic>> AnalyzeAsync(string sql, ConnectionProfile? profile, string? password, CancellationToken ct)
    {
        if (profile is null || string.IsNullOrWhiteSpace(sql)) return [];
        var candidates = Candidates(sql);
        if (candidates.Count == 0) return [];
        PgDriver.EnsureInitialized();

        var b = PgConnectionStrings.Builder(profile, password, pooling: true);
        b.Options = ((b.Options ?? "") + " -c default_transaction_read_only=on -c statement_timeout=3000").Trim();
        b.ApplicationName = "Rowlit diagnostics";
        b.Timeout = Math.Min(b.Timeout, 10);

        var diagnostics = new List<SqlDiagnostic>();
        await using var conn = new NpgsqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is NpgsqlException or TimeoutException or IOException or System.Net.Sockets.SocketException)
        {
            return []; // diagnostics are best effort: the editor keeps its client-side checks
        }

        foreach (var c in candidates)
        {
            ct.ThrowIfCancellationRequested();
            var prepared = false;
            try
            {
                await PgDb.ExecuteAsync(conn, "BEGIN READ ONLY", ct).ConfigureAwait(false);
                await PgDb.ExecuteAsync(conn, Prefix + c.Rewrite.Text, ct).ConfigureAwait(false);
                prepared = true;
            }
            catch (PostgresException pg) when (!IgnoredStates.Contains(pg.SqlState) && !PgErrors.IsConnectionLossState(pg.SqlState))
            {
                diagnostics.Add(ToDiagnostic(sql, c, pg));
            }
            catch (PostgresException)
            {
                // ignored state
            }
            finally
            {
                if (conn.State == System.Data.ConnectionState.Open)
                {
                    try
                    {
                        await PgDb.ExecuteAsync(conn, "ROLLBACK", CancellationToken.None).ConfigureAwait(false);
                        if (prepared) await PgDb.ExecuteAsync(conn, "DEALLOCATE " + StatementName, CancellationToken.None).ConfigureAwait(false);
                    }
                    catch (NpgsqlException) { /* the connection is discarded below */ }
                }
            }
            if (conn.State != System.Data.ConnectionState.Open) break;
        }
        return diagnostics;
    }

    /// <summary>Maps a PREPARE error to a document range (the token at the server's position, else the whole statement).</summary>
    public static SqlDiagnostic ToDiagnostic(string document, Candidate c, PostgresException pg)
    {
        var message = pg.MessageText + (string.IsNullOrWhiteSpace(pg.Hint) ? "" : " Hint: " + pg.Hint.Trim());
        int from, to;
        if (pg.Position > Prefix.Length)
        {
            var local = PgSqlText.MapPosition(c.Rewrite.Text, c.Original, pg.Position - Prefix.Length);
            from = c.Statement.Start + local;
            var token = c.Statement.Tokens.FirstOrDefault(t => t.Start <= from && from < t.End);
            to = token.End > from ? token.End : Math.Min(c.Statement.End, from + 1);
        }
        else
        {
            from = c.Statement.Start;
            to = c.Statement.End;
        }
        var (line, col) = PgSqlText.LineColAt(document, from);
        var (endLine, endCol) = PgSqlText.LineColAt(document, to);
        return new SqlDiagnostic(line, col, endLine, endCol, "error", pg.SqlState, message);
    }
}
