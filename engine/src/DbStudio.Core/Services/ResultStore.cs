using System.Collections.Concurrent;
using DbStudio.Core.Models;

namespace DbStudio.Core.Services;

/// <summary>
/// Keeps the (capped) rows of the latest execution per session for row replay, full-cell fetch and re-export
/// (docs/PLAN.md 2.4). Replaced on the next execute of the session, freed on session close. A global memory cap
/// (default 256 MB) evicts the least recently used executions; the running one stops storing rows when it alone
/// exceeds the cap (its result sets become <see cref="StoredResultSet.Partial"/>).
/// </summary>
public sealed class ResultStore
{
    public const long DefaultCapBytes = 256L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, StoredExecution> _byExecution = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _latestBySession = new(StringComparer.Ordinal);
    private readonly object _evictGate = new();
    private long _totalBytes;

    public ResultStore(long capBytes = DefaultCapBytes) => CapBytes = capBytes;

    public long CapBytes { get; }
    public long TotalBytes => Interlocked.Read(ref _totalBytes);

    /// <summary>Starts storing a new execution for the session, dropping the session's previous one.</summary>
    public StoredExecution Begin(string sessionId, string executionId, Models.Dialect dialect)
    {
        var exec = new StoredExecution(this, sessionId, executionId) { Dialect = dialect };
        _byExecution[executionId] = exec;
        if (_latestBySession.TryGetValue(sessionId, out var previous) && previous != executionId) Remove(previous);
        _latestBySession[sessionId] = executionId;
        return exec;
    }

    public StoredExecution? Get(string executionId)
    {
        if (!_byExecution.TryGetValue(executionId, out var e)) return null;
        e.Touch();
        return e;
    }

    public void ReleaseSession(string sessionId)
    {
        if (_latestBySession.TryRemove(sessionId, out var xid)) Remove(xid);
    }

    private void Remove(string executionId)
    {
        if (_byExecution.TryRemove(executionId, out var e)) Interlocked.Add(ref _totalBytes, -e.Release());
    }

    internal bool Reserve(StoredExecution owner, long bytes)
    {
        Interlocked.Add(ref _totalBytes, bytes);
        if (TotalBytes <= CapBytes) return true;
        lock (_evictGate)
        {
            foreach (var victim in _byExecution.Values.Where(e => e != owner).OrderBy(e => e.LastAccess).ToList())
            {
                if (TotalBytes <= CapBytes) break;
                Remove(victim.ExecutionId);
                if (_latestBySession.TryGetValue(victim.SessionId, out var x) && x == victim.ExecutionId)
                    _latestBySession.TryRemove(victim.SessionId, out _);
            }
        }
        if (TotalBytes <= CapBytes) return true;
        Interlocked.Add(ref _totalBytes, -bytes);
        return false;
    }
}

public sealed class StoredExecution
{
    private readonly ResultStore _owner;
    private readonly ConcurrentDictionary<int, StoredResultSet> _sets = new();
    private long _bytes;
    private long _lastAccess = Environment.TickCount64;
    private volatile bool _released;

    internal StoredExecution(ResultStore owner, string sessionId, string executionId)
    {
        _owner = owner;
        SessionId = sessionId;
        ExecutionId = executionId;
    }

    public string SessionId { get; }
    public string ExecutionId { get; }
    internal long LastAccess => Interlocked.Read(ref _lastAccess);
    public bool Completed { get; internal set; }
    public Dialect Dialect { get; init; }

    internal void Touch() => Interlocked.Exchange(ref _lastAccess, Environment.TickCount64);

    public IReadOnlyList<StoredResultSet> ResultSets => _sets.Values.OrderBy(s => s.Id).ToList();

    public StoredResultSet? Get(int resultSetId) => _sets.GetValueOrDefault(resultSetId);

    public StoredResultSet Start(int resultSetId, int batchIndex, ColumnInfo[] columns)
    {
        var set = new StoredResultSet(resultSetId, batchIndex, columns);
        _sets[resultSetId] = set;
        return set;
    }

    public void AddRows(int resultSetId, IReadOnlyList<object?[]> rows)
    {
        if (_released || !_sets.TryGetValue(resultSetId, out var set) || set.Partial) return;
        long bytes = 32L * rows.Count;
        foreach (var row in rows)
            foreach (var v in row) bytes += ValueConverter.EstimateSize(v);
        if (!_owner.Reserve(this, bytes))
        {
            set.MarkPartial();
            return;
        }
        Interlocked.Add(ref _bytes, bytes);
        set.Append(rows);
    }

    public void End(int resultSetId, long rowCount, bool truncated)
    {
        if (_sets.TryGetValue(resultSetId, out var set)) set.Complete(rowCount, truncated);
    }

    internal long Release()
    {
        _released = true;
        foreach (var s in _sets.Values) s.Clear();
        _sets.Clear();
        return Interlocked.Exchange(ref _bytes, 0);
    }
}

public sealed class StoredResultSet(int id, int batchIndex, ColumnInfo[] columns)
{
    private readonly List<object?[]> _rows = [];
    private readonly object _gate = new();

    public int Id { get; } = id;
    public int BatchIndex { get; } = batchIndex;
    public ColumnInfo[] Columns { get; } = columns;
    /// <summary>Rows the server returned (may exceed the stored count when <see cref="Partial"/>).</summary>
    public long RowCount { get; private set; }
    public bool Truncated { get; private set; }
    public bool IsComplete { get; private set; }
    /// <summary>True when the memory cap stopped row storage before the result set ended.</summary>
    public bool Partial { get; private set; }

    public int StoredRows { get { lock (_gate) return _rows.Count; } }

    internal void Append(IReadOnlyList<object?[]> rows)
    {
        lock (_gate)
        {
            _rows.AddRange(rows);
            if (!IsComplete) RowCount = Math.Max(RowCount, _rows.Count);
        }
    }

    internal void MarkPartial() => Partial = true;

    internal void Complete(long rowCount, bool truncated)
    {
        lock (_gate)
        {
            RowCount = rowCount;
            Truncated = truncated;
            IsComplete = true;
        }
    }

    internal void Clear()
    {
        lock (_gate) _rows.Clear();
    }

    public List<object?[]> Page(long offset, int limit)
    {
        lock (_gate)
        {
            if (offset >= _rows.Count || limit <= 0) return [];
            var start = (int)offset;
            return _rows.GetRange(start, Math.Min(limit, _rows.Count - start));
        }
    }

    public object?[]? Row(long index)
    {
        lock (_gate) return index >= 0 && index < _rows.Count ? _rows[(int)index] : null;
    }

    /// <summary>Snapshot enumeration for export (copies the row list reference under lock).</summary>
    public IReadOnlyList<object?[]> Snapshot()
    {
        lock (_gate) return _rows.ToArray();
    }
}
