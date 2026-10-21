using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Logs.Sql;

/// <summary>One result set of a log/activity query; cells are plain values (strings, numbers, bools, byte[]).</summary>
public sealed class SqlRowSet(IReadOnlyList<string> columns, IReadOnlyList<object?[]> rows)
{
    private readonly Dictionary<string, int> _index = columns
        .Select((c, i) => (c, i)).GroupBy(x => x.c, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First().i, StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<string> Columns { get; } = columns;
    public IReadOnlyList<object?[]> Rows { get; } = rows;

    public int IndexOf(string column) => _index.TryGetValue(column, out var i) ? i : -1;

    public object? Value(object?[] row, string column) => IndexOf(column) is var i and >= 0 && i < row.Length ? row[i] : null;

    public string? Str(object?[] row, string column) => SqlCells.Str(Value(row, column));

    public long? Long(object?[] row, string column) => SqlCells.Long(Value(row, column));

    public double? Double(object?[] row, string column) => SqlCells.Double(Value(row, column));

    public bool Bool(object?[] row, string column) => SqlCells.Bool(Value(row, column));

    public DateTimeOffset? Time(object?[] row, string column, TimeSpan assumeOffset) => SqlCells.Time(Value(row, column), assumeOffset);

    public static SqlRowSet Of(string[] columns, params object?[][] rows) => new(columns, rows);
}

/// <summary>Cell conversions tolerant of every provider's wire values.</summary>
public static class SqlCells
{
    public static string? Str(object? v) => v switch
    {
        null => null,
        string s => s,
        byte[] b => Convert.ToBase64String(b),
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString(),
    };

    public static long? Long(object? v) => v switch
    {
        null => null,
        long l => l,
        int i => i,
        short s => s,
        byte b => b,
        decimal d => (long)d,
        double d when !double.IsNaN(d) => (long)d,
        float f when !float.IsNaN(f) => (long)f,
        bool b => b ? 1 : 0,
        string s when long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) => p,
        string s when decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => (long)d,
        _ => null,
    };

    public static double? Double(object? v) => v switch
    {
        null => null,
        double d => d,
        float f => f,
        decimal m => (double)m,
        long l => l,
        int i => i,
        string s when double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var p) => p,
        _ => null,
    };

    public static bool Bool(object? v) => v switch
    {
        bool b => b,
        string s => s is "1" or "t" or "true" or "TRUE" or "True" or "YES" or "yes" or "on",
        _ => Long(v) is { } l && l != 0,
    };

    /// <summary>Parses a timestamp cell; values without an offset are taken in <paramref name="assumeOffset"/> (server local time).</summary>
    public static DateTimeOffset? Time(object? v, TimeSpan assumeOffset)
    {
        switch (v)
        {
            case null: return null;
            case DateTimeOffset dto: return dto;
            case DateTime dt: return new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified), assumeOffset);
        }
        var s = Str(v);
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        var hasOffset = s.EndsWith('Z') || s.EndsWith(" UTC", StringComparison.Ordinal) || HasNumericOffset(s);
        if (s.EndsWith(" UTC", StringComparison.Ordinal)) s = s[..^4] + "Z";
        if (hasOffset && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var withOffset)) return withOffset;
        if (DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
            return new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), assumeOffset);
        return null;
    }

    private static bool HasNumericOffset(string s)
    {
        // ...T10:00:00+02:00 | +0200 | +02 (after the time part)
        var t = s.IndexOfAny(['T', ' ']);
        if (t < 0) return false;
        var tail = s[(t + 1)..];
        var i = tail.LastIndexOfAny(['+', '-']);
        return i > 0 && tail.Length - i >= 3 && char.IsDigit(tail[i + 1]);
    }
}

/// <summary>A provider error raised by a log query (code = provider error number, e.g. "297", "ORA-00942", "42501").</summary>
public sealed class SqlQueryException(ErrorInfo error) : Exception(error.Message)
{
    public ErrorInfo Error { get; } = error;
    public string Code => Error.Code;
    public int? ProviderCode => Error.ProviderCode;
}

/// <summary>Runs log and activity SQL on one relational connection.</summary>
public interface ISqlRunner
{
    /// <summary>Runs one batch and returns its result sets. Provider errors throw <see cref="SqlQueryException"/>.</summary>
    Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct);
}

public interface ISqlRunnerFactory
{
    Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct);
}

/// <summary>
/// Runs log/activity SQL on a dedicated engine-owned session per connection (opened through the provider like a tab
/// session, but not listed in <c>/sessions</c>), serialized per connection, closed after two idle minutes or when the
/// profile changed.
/// </summary>
public sealed class SessionSqlRunnerFactory : ISqlRunnerFactory, IAsyncDisposable
{
    private readonly ProviderRegistry _providers;
    private readonly ConnectionStore _connections;
    private readonly ILogger _log;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly Timer _reaper;
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan QueryTimeout = TimeSpan.FromSeconds(30);

    public SessionSqlRunnerFactory(ProviderRegistry providers, ConnectionStore connections, ILogger<SessionSqlRunnerFactory>? log = null)
    {
        _providers = providers;
        _connections = connections;
        _log = log ?? (ILogger)NullLogger.Instance;
        _reaper = new Timer(_ => _ = ReapAsync(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }

    public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct)
    {
        var entry = _entries.GetOrAdd(target.ConnectionId, cid => new Entry(this, cid));
        return Task.FromResult<ISqlRunner>(entry);
    }

    private async Task ReapAsync()
    {
        foreach (var e in _entries.Values)
            if (DateTimeOffset.UtcNow - e.LastUsed > IdleTimeout) await e.CloseIfIdleAsync().ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await _reaper.DisposeAsync().ConfigureAwait(false);
        foreach (var e in _entries.Values) await e.CloseIfIdleAsync(force: true).ConfigureAwait(false);
    }

    private sealed class Entry(SessionSqlRunnerFactory owner, string connectionId) : ISqlRunner
    {
        private readonly SemaphoreSlim _gate = new(1, 1);
        private IDbSession? _session;
        private string? _stamp;
        public DateTimeOffset LastUsed { get; private set; } = DateTimeOffset.UtcNow;

        public async Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(QueryTimeout);
            await _gate.WaitAsync(timeout.Token).ConfigureAwait(false);
            try
            {
                LastUsed = DateTimeOffset.UtcNow;
                var session = await EnsureSessionAsync(timeout.Token).ConfigureAwait(false);
                var sink = new CollectingSink();
                using var reg = timeout.Token.Register(session.Cancel);
                try
                {
                    await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 0, true, false, "statement"), sink, timeout.Token)
                        .ConfigureAwait(false);
                }
                catch (Exception ex) when (ex is not OperationCanceledException and not EngineException)
                {
                    await DropAsync().ConfigureAwait(false);
                    throw EngineException.SourceUnavailable(ex.Message, new { connectionId });
                }
                if (sink.FirstError is { } error) throw new SqlQueryException(error);
                if (session.State is SessionState.Broken or SessionState.Closed) await DropAsync().ConfigureAwait(false);
                return sink.Sets;
            }
            finally
            {
                LastUsed = DateTimeOffset.UtcNow;
                _gate.Release();
            }
        }

        private async Task<IDbSession> EnsureSessionAsync(CancellationToken ct)
        {
            var profile = owner._connections.Get(connectionId);
            var stamp = JsonSerializer.Serialize(profile, CoreJson.Options);
            if (_session is { State: not (SessionState.Broken or SessionState.Closed) } live && _stamp == stamp) return live;
            await DropAsync().ConfigureAwait(false);
            var provider = owner._providers.Get(profile.ProviderId);
            try
            {
                _session = await provider.OpenSessionAsync(profile, owner._connections.GetPassword(connectionId),
                    new SessionOptions(Ids.New("lg"), null, TransactionMode.Auto, false), ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException and not EngineException)
            {
                throw EngineException.SourceUnavailable(ex is NotSupportedException ? ex.Message : $"Cannot connect: {ex.Message}", new { connectionId });
            }
            _stamp = stamp;
            owner._log.LogDebug("Logs session opened on {ConnectionId}", connectionId);
            return _session;
        }

        private async Task DropAsync()
        {
            var s = _session;
            _session = null;
            if (s is null) return;
            try { await s.DisposeAsync().ConfigureAwait(false); }
            catch (Exception ex) { owner._log.LogDebug(ex, "Closing the logs session of {ConnectionId} failed", connectionId); }
        }

        public async Task CloseIfIdleAsync(bool force = false)
        {
            if (!await _gate.WaitAsync(force ? 2000 : 0).ConfigureAwait(false)) return;
            try { await DropAsync().ConfigureAwait(false); }
            finally { _gate.Release(); }
        }
    }

    /// <summary>Collects result sets; the first error stops collection.</summary>
    private sealed class CollectingSink : IExecutionSink
    {
        private readonly Dictionary<int, (string[] Columns, List<object?[]> Rows)> _sets = [];
        private readonly List<int> _order = [];
        public ErrorInfo? FirstError { get; private set; }

        public IReadOnlyList<SqlRowSet> Sets => _order.Select(id => new SqlRowSet(_sets[id].Columns, _sets[id].Rows)).ToList();

        public ValueTask BatchStarted(int batchIndex) => ValueTask.CompletedTask;

        public ValueTask ResultSetStarted(int resultSetId, int batchIndex, ColumnInfo[] columns)
        {
            _sets[resultSetId] = (columns.Select(c => c.Name).ToArray(), []);
            _order.Add(resultSetId);
            return ValueTask.CompletedTask;
        }

        public ValueTask Rows(int resultSetId, IReadOnlyList<object?[]> rows)
        {
            if (_sets.TryGetValue(resultSetId, out var set))
                foreach (var r in rows) set.Rows.Add(r.Select(Plain).ToArray());
            return ValueTask.CompletedTask;
        }

        private static object? Plain(object? wire) => wire switch
        {
            TruncatedValue t => t.Full,
            BinaryValue b => b.Full,
            _ => wire,
        };

        public ValueTask ResultSetEnded(int resultSetId, long rowCount, bool truncated, long elapsedMs) => ValueTask.CompletedTask;
        public ValueTask RowsAffected(int batchIndex, long count, string? statementKind) => ValueTask.CompletedTask;
        public ValueTask Message(int batchIndex, MessageSeverity severity, string text, int? line, int? code, MessageSource source) => ValueTask.CompletedTask;

        public ValueTask Error(int batchIndex, ErrorInfo error)
        {
            FirstError ??= error;
            return ValueTask.CompletedTask;
        }

        public ValueTask BatchEnded(int batchIndex, long elapsedMs, BatchStatus status) => ValueTask.CompletedTask;
    }
}

/// <summary>SQL literal helpers (log queries embed validated values as literals so the golden SQL is exact).</summary>
public static class SqlText
{
    /// <summary>T-SQL Unicode literal: N'it''s'.</summary>
    public static string NString(string? s) => s is null ? "NULL" : "N'" + s.Replace("'", "''") + "'";

    /// <summary>Oracle / PostgreSQL literal: 'it''s' (PostgreSQL: E'' when the text has backslashes).</summary>
    public static string String(string? s) => s is null ? "NULL" : "'" + s.Replace("'", "''") + "'";

    public static string PgString(string? s) =>
        s is null ? "NULL" : s.Contains('\\') ? "E'" + s.Replace("\\", "\\\\").Replace("'", "''") + "'" : String(s);

    public static string Int(long v) => v.ToString(CultureInfo.InvariantCulture);

    /// <summary>"2026-10-18T13:02:11.213" (no zone; callers convert to the server's time first).</summary>
    public static string IsoLocal(DateTime t) => t.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture);

    /// <summary>LIKE pattern body with %, _ and [ escaped for T-SQL (ESCAPE not needed: brackets).</summary>
    public static string TSqlLikeContains(string s) => "%" + s.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]") + "%";

    /// <summary>LIKE pattern body with \ as the escape character (Oracle / PostgreSQL: append <c>ESCAPE '\'</c>).</summary>
    public static string LikeContains(string s) => "%" + s.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
}
