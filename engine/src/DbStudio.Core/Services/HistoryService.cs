using System.Globalization;
using System.Text;
using DbStudio.Core.Models;
using Microsoft.Data.Sqlite;

namespace DbStudio.Core.Services;

/// <summary>Wire shape of one history row (ui/src/api/types.ts HistoryEntry).</summary>
public sealed record HistoryEntry(
    long Id,
    string ConnectionId,
    string? Database,
    string Sql,
    string StartedAt,
    long DurationMs,
    string Status,
    long? RowsAffected,
    long? ResultRows,
    string? Error,
    string Label,
    bool Pinned);

/// <summary>M1.5 history filters (docs/PLAN-M1.5.md 1.1.3); every member is optional and they combine with AND.</summary>
/// <param name="Statuses">"ok" | "error" | "cancelled".</param>
/// <param name="From">Inclusive lower bound of started_at.</param>
/// <param name="To">Inclusive upper bound of started_at.</param>
/// <param name="PinnedOnly">true = only pinned entries.</param>
public sealed record HistoryFilter(IReadOnlyList<string>? Statuses = null, DateTimeOffset? From = null, DateTimeOffset? To = null, bool PinnedOnly = false)
{
    public static readonly HistoryFilter None = new();
}

/// <summary>
/// Query history in <c>history.db</c> (SQLite with an FTS5 index over the SQL text). One row per execution.
/// Falls back to LIKE search when FTS5 is unavailable.
/// </summary>
public sealed class HistoryService : IDisposable
{
    private readonly string _connectionString;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private bool _initialized;
    private bool _fts;

    public HistoryService(AppPaths paths)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = paths.HistoryDatabase,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
        }.ToString();
    }

    public bool FullTextEnabled => _fts;

    private async Task<SqliteConnection> OpenAsync(CancellationToken ct)
    {
        var c = new SqliteConnection(_connectionString);
        await c.OpenAsync(ct).ConfigureAwait(false);
        if (!_initialized) await InitializeAsync(c, ct).ConfigureAwait(false);
        return c;
    }

    private async Task InitializeAsync(SqliteConnection c, CancellationToken ct)
    {
        await ExecAsync(c, """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              connection_id TEXT NOT NULL,
              database TEXT,
              sql TEXT NOT NULL,
              started_at TEXT NOT NULL,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              rows_affected INTEGER,
              result_rows INTEGER,
              error TEXT,
              label TEXT NOT NULL DEFAULT 'statement',
              pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS ix_history_connection ON history(connection_id, id);
            """, ct).ConfigureAwait(false);
        try
        {
            await ExecAsync(c, """
                CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(sql, content='history', content_rowid='id', tokenize='unicode61');
                CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
                  INSERT INTO history_fts(rowid, sql) VALUES (new.id, new.sql);
                END;
                CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
                  INSERT INTO history_fts(history_fts, rowid, sql) VALUES ('delete', old.id, old.sql);
                END;
                CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE OF sql ON history BEGIN
                  INSERT INTO history_fts(history_fts, rowid, sql) VALUES ('delete', old.id, old.sql);
                  INSERT INTO history_fts(rowid, sql) VALUES (new.id, new.sql);
                END;
                """, ct).ConfigureAwait(false);
            _fts = true;
        }
        catch (SqliteException)
        {
            _fts = false;
        }
        _initialized = true;
    }

    private static async Task ExecAsync(SqliteConnection c, string sql, CancellationToken ct)
    {
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    public async Task<long> AddAsync(string connectionId, string? database, string sql, DateTimeOffset startedAt, long durationMs,
        ExecutionStatus status, long? rowsAffected, long? resultRows, string? error, string label, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var c = await OpenAsync(ct).ConfigureAwait(false);
            await using var cmd = c.CreateCommand();
            cmd.CommandText = """
                INSERT INTO history (connection_id, database, sql, started_at, duration_ms, status, rows_affected, result_rows, error, label)
                VALUES ($c, $d, $s, $t, $ms, $st, $ra, $rr, $e, $l);
                SELECT last_insert_rowid();
                """;
            cmd.Parameters.AddWithValue("$c", connectionId);
            cmd.Parameters.AddWithValue("$d", (object?)database ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$s", sql);
            cmd.Parameters.AddWithValue("$t", FormatTime(startedAt));
            cmd.Parameters.AddWithValue("$ms", durationMs);
            cmd.Parameters.AddWithValue("$st", StatusText(status));
            cmd.Parameters.AddWithValue("$ra", (object?)rowsAffected ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$rr", (object?)resultRows ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$e", (object?)error ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$l", label);
            return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false), CultureInfo.InvariantCulture);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <param name="query">Free text; every word must match (prefix match with FTS5).</param>
    /// <param name="before">Return entries with id &lt; before (paging).</param>
    public Task<IReadOnlyList<HistoryEntry>> SearchAsync(string? connectionId, string? query, int limit, long? before, CancellationToken ct = default) =>
        SearchAsync(connectionId, query, limit, before, HistoryFilter.None, ct);

    /// <summary>Search with the M1.5 filters (status list, started_at range, pinned only).</summary>
    public async Task<IReadOnlyList<HistoryEntry>> SearchAsync(string? connectionId, string? query, int limit, long? before, HistoryFilter filter, CancellationToken ct = default)
    {
        filter ??= HistoryFilter.None;
        limit = Math.Clamp(limit <= 0 ? 200 : limit, 1, 5000);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var c = await OpenAsync(ct).ConfigureAwait(false);
            await using var cmd = c.CreateCommand();
            var where = new List<string>();
            var sql = new StringBuilder("SELECT h.id, h.connection_id, h.database, h.sql, h.started_at, h.duration_ms, h.status, h.rows_affected, h.result_rows, h.error, h.label, h.pinned FROM history h");
            var words = Tokenize(query);
            if (words.Count > 0)
            {
                if (_fts)
                {
                    sql.Append(" JOIN history_fts f ON f.rowid = h.id");
                    where.Add("history_fts MATCH $q");
                    cmd.Parameters.AddWithValue("$q", string.Join(" AND ", words.Select(w => "\"" + w.Replace("\"", "\"\"") + "\"*")));
                }
                else
                {
                    for (var i = 0; i < words.Count; i++)
                    {
                        where.Add($"h.sql LIKE $w{i} ESCAPE '\\'");
                        cmd.Parameters.AddWithValue($"$w{i}", "%" + words[i].Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%");
                    }
                }
            }
            if (!string.IsNullOrEmpty(connectionId)) { where.Add("h.connection_id = $c"); cmd.Parameters.AddWithValue("$c", connectionId); }
            if (before is not null) { where.Add("h.id < $b"); cmd.Parameters.AddWithValue("$b", before.Value); }
            if (filter.Statuses is { Count: > 0 } statuses)
            {
                var names = new List<string>();
                for (var i = 0; i < statuses.Count; i++)
                {
                    names.Add($"$st{i}");
                    cmd.Parameters.AddWithValue($"$st{i}", statuses[i]);
                }
                where.Add($"h.status IN ({string.Join(", ", names)})");
            }
            // started_at is stored as UTC "yyyy-MM-ddTHH:mm:ss.fffZ", so text comparison orders correctly.
            if (filter.From is { } from) { where.Add("h.started_at >= $from"); cmd.Parameters.AddWithValue("$from", FormatTime(from)); }
            if (filter.To is { } to) { where.Add("h.started_at <= $to"); cmd.Parameters.AddWithValue("$to", FormatTime(to)); }
            if (filter.PinnedOnly) where.Add("h.pinned = 1");
            if (where.Count > 0) sql.Append(" WHERE ").AppendJoin(" AND ", where);
            sql.Append(" ORDER BY h.id DESC LIMIT $limit");
            cmd.Parameters.AddWithValue("$limit", limit);
            cmd.CommandText = sql.ToString();

            var list = new List<HistoryEntry>();
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                list.Add(new HistoryEntry(
                    r.GetInt64(0), r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2), r.GetString(3), r.GetString(4),
                    r.GetInt64(5), r.GetString(6), r.IsDBNull(7) ? null : r.GetInt64(7), r.IsDBNull(8) ? null : r.GetInt64(8),
                    r.IsDBNull(9) ? null : r.GetString(9), r.GetString(10), r.GetInt64(11) != 0));
            }
            return list;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> SetPinnedAsync(long id, bool pinned, CancellationToken ct = default) =>
        await NonQueryAsync("UPDATE history SET pinned = $p WHERE id = $id", ct, ("$p", pinned ? 1 : 0), ("$id", id)).ConfigureAwait(false) > 0;

    public async Task<bool> DeleteAsync(long id, CancellationToken ct = default) =>
        await NonQueryAsync("DELETE FROM history WHERE id = $id", ct, ("$id", id)).ConfigureAwait(false) > 0;

    /// <summary>Deletes unpinned entries (of one connection, or all). Pinned entries survive a clear.</summary>
    public Task<int> ClearAsync(string? connectionId, CancellationToken ct = default) =>
        string.IsNullOrEmpty(connectionId)
            ? NonQueryAsync("DELETE FROM history WHERE pinned = 0", ct)
            : NonQueryAsync("DELETE FROM history WHERE pinned = 0 AND connection_id = $c", ct, ("$c", connectionId));

    private async Task<int> NonQueryAsync(string sql, CancellationToken ct, params (string Name, object Value)[] args)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var c = await OpenAsync(ct).ConfigureAwait(false);
            await using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            foreach (var (n, v) in args) cmd.Parameters.AddWithValue(n, v);
            return await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static List<string> Tokenize(string? query)
    {
        if (string.IsNullOrWhiteSpace(query)) return [];
        var words = new List<string>();
        var sb = new StringBuilder();
        foreach (var ch in query)
        {
            if (char.IsLetterOrDigit(ch) || ch == '_') sb.Append(ch);
            else if (sb.Length > 0) { words.Add(sb.ToString()); sb.Clear(); }
        }
        if (sb.Length > 0) words.Add(sb.ToString());
        return words.Take(16).ToList();
    }

    private static string FormatTime(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string StatusText(ExecutionStatus s) => s switch
    {
        ExecutionStatus.Ok => "ok",
        ExecutionStatus.Error => "error",
        _ => "cancelled",
    };

    public void Dispose() => _gate.Dispose();
}
