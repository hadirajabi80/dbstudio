using System.Collections;
using System.Data.Common;
using ClickHouse.Driver.ADO;
using ClickHouse.Driver.ADO.Parameters;

namespace DbStudio.Providers.ClickHouse;

/// <summary>What happened to one statement of a batch (rows written, mutation target, server summary).</summary>
public sealed record ChStatementOutcome(ChStatement Statement, string QueryId, ChSummary? Summary, bool ReturnedRows);

/// <summary>
/// One <see cref="DbDataReader"/> over the statements of a batch: ClickHouse's HTTP interface runs one statement per request,
/// so each statement is its own command (own <c>query_id</c>), started lazily when the previous result set is consumed
/// (<see cref="NextResultAsync"/>). Statements without a result (INSERT, DDL, SET, USE) run back to back until the next one
/// that returns rows. <see cref="ChSession"/> sees the running statement through <see cref="Current"/> (cancel, error position).
/// </summary>
public sealed class ChBatchReader : DbDataReader
{
    private readonly ChSession _session;
    private readonly IReadOnlyList<ChStatement> _statements;
    private readonly IReadOnlyList<ClickHouseDbParameter> _parameters;
    private readonly int _maxRows;
    private readonly List<ChStatementOutcome> _outcomes = [];
    private int _next;
    private DbDataReader? _inner;
    private ClickHouseCommand? _innerCommand;
    private bool _closed;

    private ChBatchReader(ChSession session, IReadOnlyList<ChStatement> statements, IReadOnlyList<ClickHouseDbParameter> parameters, int maxRows)
    {
        _session = session;
        _statements = statements;
        _parameters = parameters;
        _maxRows = maxRows;
    }

    /// <summary>The statement that runs (or whose rows are being read) now; null before the first and after the last.</summary>
    public ChStatement? Current { get; private set; }

    /// <summary>Query id of <see cref="Current"/>.</summary>
    public string? CurrentQueryId { get; private set; }

    public IReadOnlyList<ChStatementOutcome> Outcomes => _outcomes;

    internal static async Task<ChBatchReader> OpenAsync(ChSession session, IReadOnlyList<ChStatement> statements,
        IReadOnlyList<ClickHouseDbParameter> parameters, int maxRows, CancellationToken ct, Action<ChBatchReader>? onCreated = null)
    {
        var reader = new ChBatchReader(session, statements, parameters, maxRows);
        onCreated?.Invoke(reader);
        await reader.AdvanceAsync(ct).ConfigureAwait(false);
        return reader;
    }

    /// <summary>Runs statements until one returns a result set (true) or none is left (false).</summary>
    private async Task<bool> AdvanceAsync(CancellationToken ct)
    {
        await DisposeInnerAsync().ConfigureAwait(false);
        while (_next < _statements.Count)
        {
            var st = _statements[_next++];
            Current = st;
            var single = _statements.Count == 1;
            var (cmd, queryId) = _session.CreateStatementCommand(st, _parameters, single ? _maxRows : 0);
            CurrentQueryId = queryId;
            _session.Record(st, queryId);
            _innerCommand = cmd;
            DbDataReader r;
            try
            {
                r = await _session.ExecuteStatementAsync(cmd, st, ct).ConfigureAwait(false);
            }
            catch
            {
                _innerCommand = null;
                await cmd.DisposeAsync().ConfigureAwait(false);
                throw;
            }
            if (r.FieldCount > 0)
            {
                _inner = r;
                _outcomes.Add(new ChStatementOutcome(st, queryId, null, true));
                return true;
            }
            await r.DisposeAsync().ConfigureAwait(false);
            _outcomes.Add(new ChStatementOutcome(st, queryId, _session.SummaryOf(queryId), false));
            _innerCommand = null;
            await cmd.DisposeAsync().ConfigureAwait(false);
            await _session.AfterStatementAsync(st, ct).ConfigureAwait(false);
        }
        Current = null;
        CurrentQueryId = null;
        return false;
    }

    /// <summary>Aborts the HTTP request of the running statement (the session also KILLs it on the server).</summary>
    public void CancelCurrent()
    {
        try { _innerCommand?.Cancel(); } catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException) { }
    }

    private async ValueTask DisposeInnerAsync()
    {
        if (_inner is not null)
        {
            try { await _inner.DisposeAsync().ConfigureAwait(false); } catch { /* aborted stream */ }
            _inner = null;
        }
        if (_innerCommand is not null)
        {
            try { await _innerCommand.DisposeAsync().ConfigureAwait(false); } catch { /* ignore */ }
            _innerCommand = null;
        }
    }

    private DbDataReader Inner => _inner ?? throw new InvalidOperationException("No result set is open.");

    public override bool NextResult() => NextResultAsync(CancellationToken.None).GetAwaiter().GetResult();

    public override Task<bool> NextResultAsync(CancellationToken cancellationToken) =>
        _closed ? Task.FromResult(false) : AdvanceAsync(cancellationToken);

    public override bool Read() => _inner is not null && _inner.Read();

    public override Task<bool> ReadAsync(CancellationToken cancellationToken) =>
        _inner is null ? Task.FromResult(false) : _inner.ReadAsync(cancellationToken);

    public override int FieldCount => _inner?.FieldCount ?? 0;
    public override bool HasRows => _inner?.HasRows ?? false;
    public override bool IsClosed => _closed;
    public override int RecordsAffected => -1;
    public override int Depth => 0;

    public override object this[int ordinal] => GetValue(ordinal);
    public override object this[string name] => GetValue(GetOrdinal(name));

    public override bool GetBoolean(int ordinal) => Inner.GetBoolean(ordinal);
    public override byte GetByte(int ordinal) => Inner.GetByte(ordinal);
    public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => Inner.GetBytes(ordinal, dataOffset, buffer, bufferOffset, length);
    public override char GetChar(int ordinal) => Inner.GetChar(ordinal);
    public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length) => Inner.GetChars(ordinal, dataOffset, buffer, bufferOffset, length);
    public override string GetDataTypeName(int ordinal) => Inner.GetDataTypeName(ordinal);
    public override DateTime GetDateTime(int ordinal) => Inner.GetDateTime(ordinal);
    public override decimal GetDecimal(int ordinal) => Inner.GetDecimal(ordinal);
    public override double GetDouble(int ordinal) => Inner.GetDouble(ordinal);
    public override Type GetFieldType(int ordinal) => Inner.GetFieldType(ordinal);
    public override float GetFloat(int ordinal) => Inner.GetFloat(ordinal);
    public override Guid GetGuid(int ordinal) => Inner.GetGuid(ordinal);
    public override short GetInt16(int ordinal) => Inner.GetInt16(ordinal);
    public override int GetInt32(int ordinal) => Inner.GetInt32(ordinal);
    public override long GetInt64(int ordinal) => Inner.GetInt64(ordinal);
    public override string GetName(int ordinal) => Inner.GetName(ordinal);
    public override int GetOrdinal(string name) => Inner.GetOrdinal(name);
    public override string GetString(int ordinal) => Inner.GetString(ordinal);
    public override object GetValue(int ordinal) => Inner.GetValue(ordinal);
    public override int GetValues(object[] values) => Inner.GetValues(values);
    public override bool IsDBNull(int ordinal) => Inner.IsDBNull(ordinal);
    public override IEnumerator GetEnumerator() => throw new NotSupportedException();

    public override async Task CloseAsync()
    {
        if (_closed) return;
        _closed = true;
        await DisposeInnerAsync().ConfigureAwait(false);
    }

    public override void Close() => CloseAsync().GetAwaiter().GetResult();

    public override async ValueTask DisposeAsync()
    {
        await CloseAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_closed) Close();
        base.Dispose(disposing);
    }
}
