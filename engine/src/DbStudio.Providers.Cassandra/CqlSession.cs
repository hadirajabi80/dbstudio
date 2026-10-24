using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Cassandra;

/// <summary>
/// One console (tab session) on a Cassandra / ScyllaDB cluster (plan-batch3 WP-CS), implemented directly on the driver
/// (no ADO.NET):
/// <list type="bullet">
/// <item>its own driver <see cref="ISession"/> on the profile's shared cluster, so <c>USE ks</c> stays with the tab;</item>
/// <item>batches are split into CQL statements (<c>BEGIN BATCH … APPLY BATCH</c> whole); rows are streamed page by page
/// (driver paging, page size of the console) and sent in chunks of 200 up to the row cap; cancel stops the paging;</item>
/// <item>cqlsh shell commands: <c>CONSISTENCY</c>, <c>SERIAL CONSISTENCY</c>, <c>TRACING ON|OFF</c>, <c>PAGING</c>,
/// <c>SHOW VERSION|HOST|SESSION</c>; DESCRIBE falls back to generated DDL on servers without it;</item>
/// <item>tracing adds the trace as a result set and remembers it for the trace view;</item>
/// <item>manual transactions are NOT_SUPPORTED (Cassandra has none); <c>BEGIN/COMMIT/ROLLBACK</c> are rejected with an
/// explanation;</item>
/// <item>data-grid statements (label <c>data</c>/<c>filter</c>) are adapted to CQL: OFFSET paging through paging states,
/// ORDER BY dropped, ALLOW FILTERING for filters, OR-ed key lookups split, distinct values counted client-side,
/// optimistic checks turned into lightweight-transaction IF clauses, INSERT … IF NOT EXISTS.</item>
/// </list>
/// </summary>
public sealed class CqlSession : IDbSession
{
    public const string NoTransactionsMessage =
        "Cassandra has no multi-statement transactions: every statement is applied (and durable) on its own. For atomic writes " +
        "use BEGIN BATCH … APPLY BATCH (atomic per partition), for compare-and-set use lightweight transactions (INSERT … IF NOT EXISTS, " +
        "UPDATE … IF col = value).";

    public const string NoExplainMessage =
        "Cassandra has no EXPLAIN. Turn on tracing (TRACING ON in the console, or Cassandra: Toggle tracing) to see how a request " +
        "was executed across the replicas.";

    private const int StateIdle = 0, StateExecuting = 1, StateBroken = 2, StateClosed = 3;
    private const int MaxTraces = 50;
    private const int DistinctScanLimit = 100_000;
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private readonly CqlClusterPool.Lease _lease;
    private readonly ISession _session;
    private readonly ConcurrentDictionary<string, Task<PreparedStatement>> _prepared = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (CqlTableMeta? Meta, DateTime At)> _tables = new(StringComparer.Ordinal);
    private readonly LinkedList<CqlTraceSummary> _traces = new();
    private readonly object _cancelLock = new();
    private readonly Dictionary<string, byte[]> _pageStates = new(StringComparer.Ordinal);
    private int _state = StateIdle;
    private CancellationTokenSource? _cts;
    private Task? _running;

    internal CqlSession(CqlClusterPool.Lease lease, ISession session, ConnectionProfile profile, SessionOptions options, ServerInfo server)
    {
        _lease = lease;
        _session = session;
        SessionId = options.SessionId;
        ConnectionId = profile.Id;
        Server = server;
        Settings = new CqlSessionSettings(lease.Settings);
    }

    public string SessionId { get; }
    public string ConnectionId { get; }
    public Dialect Dialect => Dialect.Cql;
    public SessionState State => (SessionState)Volatile.Read(ref _state);
    public TransactionMode TxMode => TransactionMode.Auto;
    public bool TxOpen => false;
    public string? CurrentDatabase => string.IsNullOrEmpty(_session.Keyspace) ? null : _session.Keyspace;
    public ServerInfo Server { get; }
    public CqlSessionSettings Settings { get; }
    public ISession DriverSession => _session;

    public string? LastTraceId { get { lock (_traces) return _traces.First?.Value.TraceId; } }

    public IReadOnlyList<CqlTraceSummary> Traces() { lock (_traces) return _traces.ToList(); }

    public CqlSessionSettingsInfo SettingsInfo() => new(
        CqlConnectionSettings.ConsistencyName(Settings.Consistency), CqlConnectionSettings.ConsistencyName(Settings.SerialConsistency),
        Settings.Tracing, Settings.PageSize, Settings.InsertTtl, CurrentDatabase, LastTraceId);

    // ------------------------------------------------------------------ transactions / keyspace

    public Task SetTransactionModeAsync(TransactionMode mode, CancellationToken ct) =>
        mode == TransactionMode.Auto ? Task.CompletedTask : throw new EngineException(400, ErrorCodes.NotSupported, NoTransactionsMessage);

    public Task CommitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task RollbackAsync(CancellationToken ct) => Task.CompletedTask;

    public async Task ChangeDatabaseAsync(string database, CancellationToken ct)
    {
        Enter();
        try
        {
            await _session.ExecuteAsync(new SimpleStatement("USE " + CqlText.Quote(database))).WaitAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            Exit();
        }
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        if (Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle) != StateIdle) return State == SessionState.Executing;
        try
        {
            await _session.ExecuteAsync(new SimpleStatement("SELECT release_version FROM system.local").SetConsistencyLevel(ConsistencyLevel.One))
                .WaitAsync(ct).ConfigureAwait(false);
            Interlocked.Exchange(ref _state, StateIdle);
            return true;
        }
        catch (Exception ex)
        {
            Interlocked.Exchange(ref _state, CqlErrors.IsConnectionLoss(ex) ? StateBroken : StateIdle);
            return State != SessionState.Broken;
        }
    }

    private void Enter()
    {
        switch (Interlocked.CompareExchange(ref _state, StateExecuting, StateIdle))
        {
            case StateIdle: return;
            case StateExecuting: throw new SessionBusyException();
            case StateBroken: throw new SessionBrokenException();
            default: throw new ObjectDisposedException(nameof(CqlSession), "The session is closed.");
        }
    }

    private void Exit() => Interlocked.CompareExchange(ref _state, StateIdle, StateExecuting);

    public void Cancel()
    {
        lock (_cancelLock)
        {
            if (State != SessionState.Executing || _cts is null) return;
            try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        }
    }

    // ------------------------------------------------------------------ execution

    public Task<ExecutionSummary> ExecuteAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(sink);
        Enter();
        CancellationTokenSource cts;
        lock (_cancelLock)
        {
            cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _cts = cts;
        }
        var task = Task.Run(() => RunAsync(request, sink, cts), CancellationToken.None);
        _running = task;
        return task;
    }

    /// <summary>State of one execution.</summary>
    private sealed class Run(ExecuteRequest request, IExecutionSink sink, CancellationToken ct)
    {
        public ExecuteRequest Request { get; } = request;
        public IExecutionSink Sink { get; } = sink;
        public CancellationToken Token { get; } = ct;
        public int ResultSets;
        public long RowsAffected;
        public int Positional;
        public bool IsData => Request.Label is "data" or "filter";
        public int NextResultSetId() => ResultSets++;
    }

    private async Task<ExecutionSummary> RunAsync(ExecuteRequest request, IExecutionSink sink, CancellationTokenSource cts)
    {
        var total = Stopwatch.StartNew();
        var run = new Run(request, sink, cts.Token);
        var anyError = false;
        var cancelled = false;
        try
        {
            if (request.Params is { Count: > 0 } ps) ParamValues.Validate(ps);
            for (var i = 0; i < request.Batches.Count; i++)
            {
                if (cts.IsCancellationRequested) { cancelled = true; break; }
                var status = await RunBatchAsync(run, i, request.Batches[i]).ConfigureAwait(false);
                if (status == BatchStatus.Cancelled) { cancelled = true; break; }
                if (status == BatchStatus.Error)
                {
                    anyError = true;
                    if (request.StopOnError || State == SessionState.Broken) break;
                }
            }
            var st = cancelled ? ExecutionStatus.Cancelled : anyError ? ExecutionStatus.Error : ExecutionStatus.Ok;
            return new ExecutionSummary(st, total.ElapsedMilliseconds, run.ResultSets, run.RowsAffected);
        }
        finally
        {
            lock (_cancelLock) _cts = null;
            cts.Dispose();
            Interlocked.CompareExchange(ref _state, StateIdle, StateExecuting);
        }
    }

    private async Task<BatchStatus> RunBatchAsync(Run run, int index, SqlBatch batch)
    {
        var sw = Stopwatch.StartNew();
        await run.Sink.BatchStarted(index).ConfigureAwait(false);
        var status = BatchStatus.Ok;
        foreach (var st in CqlText.Split(batch.Sql))
        {
            if (run.Token.IsCancellationRequested) { status = BatchStatus.Cancelled; break; }
            try
            {
                await RunStatementAsync(run, index, batch, st).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (run.Token.IsCancellationRequested)
            {
                status = BatchStatus.Cancelled;
                await run.Sink.Message(index, MessageSeverity.Warning,
                    "Query was cancelled. (A write that already reached the coordinator may still be applied.)", null, null, MessageSource.Engine).ConfigureAwait(false);
                break;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                status = BatchStatus.Error;
                var error = ex is FormatException fe
                    ? new ErrorInfo(ErrorCodes.Validation, fe.Message, Line(batch, st.Start), Detail: "params")
                    : CqlErrors.ToError(ex, batch, st.Start);
                await run.Sink.Error(index, error).ConfigureAwait(false);
                if (CqlErrors.IsConnectionLoss(ex)) Interlocked.CompareExchange(ref _state, StateBroken, StateExecuting);
                break;
            }
        }
        await run.Sink.BatchEnded(index, sw.ElapsedMilliseconds, status).ConfigureAwait(false);
        return status;
    }

    private static int Line(SqlBatch batch, int offset) => batch.Line + CqlText.LineColAt(batch.Sql, offset).Line - 1;

    private ValueTask Info(Run run, int index, string text) => run.Sink.Message(index, MessageSeverity.Info, text, null, null, MessageSource.Engine);

    private async Task RunStatementAsync(Run run, int index, SqlBatch batch, CqlStatement st)
    {
        var t = st.Tokens;
        switch (st.Head)
        {
            case "CONSISTENCY":
                await ConsistencyCommandAsync(run, index, batch, st, serial: false).ConfigureAwait(false);
                return;
            case "SERIAL" when st.Word(1) == "CONSISTENCY":
                await ConsistencyCommandAsync(run, index, batch, st, serial: true).ConfigureAwait(false);
                return;
            case "TRACING":
                {
                    var arg = st.Word(1);
                    if (arg is "ON" or "OFF") Settings.Tracing = arg == "ON";
                    else if (arg is not null) throw ShellError(batch, st, "Usage: TRACING ON | OFF");
                    await Info(run, index, arg is null ? $"Tracing is {(Settings.Tracing ? "ON" : "OFF")}." :
                        Settings.Tracing ? "Now tracing requests." : "Disabled tracing.").ConfigureAwait(false);
                    return;
                }
            case "PAGING":
                {
                    if (t.Count > 1)
                    {
                        if (t[1].IsWord("ON")) { }
                        else if (t[1].IsWord("OFF")) Settings.PageSize = CqlConnectionSettings.MaxPageSize;
                        else if (t[1].Kind == CqlTokenKind.Number && int.TryParse(t[1].Value, NumberStyles.None, Inv, out var n) && n > 0) Settings.PageSize = n;
                        else throw ShellError(batch, st, "Usage: PAGING ON | OFF | <page size>");
                    }
                    await Info(run, index, $"Page size: {Settings.PageSize}.").ConfigureAwait(false);
                    return;
                }
            case "SHOW":
                await ShowCommandAsync(run, index, batch, st).ConfigureAwait(false);
                return;
            case "COPY":
                throw new EngineException(400, ErrorCodes.NotSupported,
                    "COPY is a cqlsh client command, not CQL. Use Export on a result or table, or Import, instead.");
            case "SOURCE" or "CAPTURE" or "LOGIN" or "EXIT" or "QUIT" or "HELP" or "EXPAND" or "CLEAR" or "CLS" or "DEBUG":
                await Info(run, index, $"{st.Head} is a cqlsh client command; Rowlit ignores it.").ConfigureAwait(false);
                return;
            case "BEGIN" when st.Word(1) is not ("BATCH" or "UNLOGGED" or "COUNTER" or "LOGGED"):
            case "START" or "COMMIT" or "ROLLBACK" or "SAVEPOINT" or "RELEASE" or "END" or "ABORT":
                throw new EngineException(400, ErrorCodes.NotSupported, NoTransactionsMessage);
            case "DESCRIBE" or "DESC":
                await DescribeAsync(run, index, batch, st).ConfigureAwait(false);
                return;
        }

        if (run.IsData)
        {
            await RunDataStatementAsync(run, index, batch, st).ConfigureAwait(false);
            return;
        }

        var outcome = await ExecuteAsync(run, index, st.Text, new StreamOptions(run.Request.MaxRows)).ConfigureAwait(false);
        if (st.Head == "USE") _tables.Clear();
        if (outcome.Applied is false)
            await run.Sink.Message(index, MessageSeverity.Warning, "Not applied: the lightweight transaction's condition was not met (see [applied]).",
                null, null, MessageSource.Engine).ConfigureAwait(false);
    }

    private static EngineException ShellError(SqlBatch batch, CqlStatement st, string message) =>
        EngineException.Validation(message, new { line = Line(batch, st.Start) });

    private async Task ConsistencyCommandAsync(Run run, int index, SqlBatch batch, CqlStatement st, bool serial)
    {
        var argIndex = serial ? 2 : 1;
        var arg = argIndex < st.Tokens.Count ? st.Tokens[argIndex].Value : null;
        if (arg is null)
        {
            var current = serial ? Settings.SerialConsistency : Settings.Consistency;
            await Info(run, index, $"Current {(serial ? "serial consistency" : "consistency")} level is {CqlConnectionSettings.ConsistencyName(current)}.").ConfigureAwait(false);
            return;
        }
        if (!CqlConnectionSettings.TryParseConsistency(arg, out var level))
            throw ShellError(batch, st, $"Unknown consistency level '{arg}'. Use ONE, TWO, THREE, QUORUM, ALL, LOCAL_ONE, LOCAL_QUORUM, EACH_QUORUM, ANY, SERIAL or LOCAL_SERIAL.");
        if (serial)
        {
            if (level is not (ConsistencyLevel.Serial or ConsistencyLevel.LocalSerial))
                throw ShellError(batch, st, "Serial consistency must be SERIAL or LOCAL_SERIAL.");
            Settings.SerialConsistency = level;
            await Info(run, index, $"Serial consistency level set to {CqlConnectionSettings.ConsistencyName(level)}.").ConfigureAwait(false);
        }
        else
        {
            Settings.Consistency = level;
            await Info(run, index, $"Consistency level set to {CqlConnectionSettings.ConsistencyName(level)}.").ConfigureAwait(false);
        }
    }

    private async Task ShowCommandAsync(Run run, int index, SqlBatch batch, CqlStatement st)
    {
        switch (st.Word(1))
        {
            case "VERSION":
                {
                    var rows = (await _session.ExecuteAsync(new SimpleStatement("SELECT release_version, cql_version, native_protocol_version FROM system.local"))
                        .WaitAsync(run.Token).ConfigureAwait(false)).ToList();
                    var r = rows.FirstOrDefault();
                    await EmitTableAsync(run, index, ["product", "release_version", "cql_version", "protocol"],
                        [[Server.Version, r is null ? null : CqlSchemaReader.Str(r, "release_version"), r is null ? null : CqlSchemaReader.Str(r, "cql_version"),
                          _session.BinaryProtocolVersion.ToString(Inv)]]).ConfigureAwait(false);
                    return;
                }
            case "HOST":
                {
                    var hosts = _lease.Cluster.AllHosts().Where(h => h.IsUp).Select(h => h.Address.ToString()).ToList();
                    await Info(run, index, $"Connected to {Server.ServerName ?? "the cluster"} at {string.Join(", ", hosts)}.").ConfigureAwait(false);
                    return;
                }
            case "SESSION" when st.Tokens.Count > 2 && Guid.TryParse(st.Tokens[2].Value, out var id):
                {
                    var trace = await CqlTracing.ReadAsync(_session, id, run.Token).ConfigureAwait(false)
                                ?? throw EngineException.NotFound($"Trace {id}");
                    await EmitTraceAsync(run, index, trace).ConfigureAwait(false);
                    return;
                }
            default:
                throw ShellError(batch, st, "Usage: SHOW VERSION | SHOW HOST | SHOW SESSION <trace id>");
        }
    }

    // ------------------------------------------------------------------ DESCRIBE

    private async Task DescribeAsync(Run run, int index, SqlBatch batch, CqlStatement st)
    {
        try
        {
            await ExecuteAsync(run, index, st.Text, new StreamOptions(run.Request.MaxRows)).ConfigureAwait(false);
        }
        catch (global::Cassandra.SyntaxError)
        {
            // Cassandra 3.x / older ScyllaDB: DESCRIBE is a cqlsh command there; emulate the common forms.
            var rows = await EmulateDescribeAsync(st, run.Token).ConfigureAwait(false);
            if (rows is null) throw;
            await EmitTableAsync(run, index, ["keyspace_name", "type", "name", "create_statement"], rows).ConfigureAwait(false);
        }
    }

    private async Task<List<object?[]>?> EmulateDescribeAsync(CqlStatement st, CancellationToken ct)
    {
        var t = st.Tokens;
        var k = 1;
        if (k < t.Count && t[k].IsWord("FULL")) k++;
        var what = k < t.Count ? t[k].Upper : "";
        var reader = new CqlSchemaReader(_session);
        var rows = new List<object?[]>();
        switch (what)
        {
            case "KEYSPACES":
                foreach (var ks in await reader.KeyspacesAsync().WaitAsync(ct).ConfigureAwait(false)) rows.Add([ks.Name, "keyspace", ks.Name, null]);
                return rows;
            case "TABLES":
                {
                    var ks = await reader.LoadKeyspaceAsync(CurrentDatabase ?? "").WaitAsync(ct).ConfigureAwait(false);
                    if (ks is null) return null;
                    rows.AddRange(ks.Tables.Select(x => new object?[] { ks.Name, "table", x.Name, null }));
                    return rows;
                }
            case "KEYSPACE" or "SCHEMA":
                {
                    var (_, name, _) = CqlText.QualifiedName(t, k + 1);
                    var ks = await reader.LoadKeyspaceAsync(name ?? CurrentDatabase ?? "").WaitAsync(ct).ConfigureAwait(false);
                    if (ks is null) return null;
                    rows.Add([ks.Name, "keyspace", ks.Name, CqlDdl.WholeKeyspace(ks)]);
                    return rows;
                }
            case "TABLE" or "COLUMNFAMILY" or "TYPE" or "MATERIALIZED":
                {
                    var at = what == "MATERIALIZED" ? k + 2 : k + 1;
                    var (ksName, name, _) = CqlText.QualifiedName(t, at);
                    var ks = await reader.LoadKeyspaceAsync(ksName ?? CurrentDatabase ?? "").WaitAsync(ct).ConfigureAwait(false);
                    if (ks is null || name is null) return null;
                    var type = what == "TYPE" ? ObjectTypes.Type : what == "MATERIALIZED" ? ObjectTypes.MView : ObjectTypes.Table;
                    rows.Add([ks.Name, what == "TYPE" ? "type" : what == "MATERIALIZED" ? "materialized_view" : "table", name,
                        CqlCatalogReader.GeneratedDdl(ks, new ObjectRef(null, ks.Name, name, type))]);
                    return rows;
                }
            default:
                return null;
        }
    }

    // ------------------------------------------------------------------ statements

    /// <param name="MaxRows">Row cap (0 = all).</param>
    /// <param name="Skip">Rows skipped before the first sent row (emulated OFFSET).</param>
    /// <param name="PageSize">Overrides the console page size.</param>
    /// <param name="ColumnsOnly">Send the columns but no rows (describe probe).</param>
    /// <param name="PageKey">Data paging: key of the resumable paging state (query without LIMIT/OFFSET).</param>
    /// <param name="Writer">Append to this result set instead of starting one (merged lookups).</param>
    /// <param name="Collect">Hand rows to this callback instead of the sink.</param>
    /// <param name="Quiet">LWT results are not shown (data-grid writes).</param>
    private sealed record StreamOptions(int MaxRows, int Skip = 0, int? PageSize = null, bool ColumnsOnly = false, string? PageKey = null,
        ResultWriter? Writer = null, Func<CqlColumn[], Row, bool>? Collect = null, bool Quiet = false, bool KeepOpen = false);

    private sealed record Outcome(bool HasRows, long Rows, bool? Applied, bool Truncated, ResultWriter? Writer = null);

    /// <summary>Prepares (and binds) or builds a simple statement, executes it with paging and streams the rows.</summary>
    private async Task<Outcome> ExecuteAsync(Run run, int index, string cql, StreamOptions o)
    {
        var stmt = await BuildStatementAsync(run, cql).ConfigureAwait(false);
        var pageSize = o.PageSize ?? Settings.PageSize;
        stmt.SetConsistencyLevel(Settings.Consistency);
        stmt.SetSerialConsistencyLevel(Settings.SerialConsistency);
        stmt.SetPageSize(pageSize);
        stmt.SetAutoPage(false);
        var tracing = Settings.Tracing;
        if (tracing) stmt.EnableTracing();

        var skip = o.Skip;
        if (o.PageKey is not null && skip > 0)
        {
            lock (_pageStates)
            {
                if (_pageStates.TryGetValue($"{o.PageKey}@{skip}", out var state))
                {
                    stmt.SetPagingState(state);
                    skip = 0;
                }
            }
        }

        var started = Stopwatch.StartNew();
        var rs = await _session.ExecuteAsync(stmt).WaitAsync(run.Token).ConfigureAwait(false);
        var first = rs;
        await ReportWarningsAsync(run, index, rs).ConfigureAwait(false);

        bool? applied = null;
        ResultWriter? openWriter = null;
        long count = 0;
        var truncated = false;
        if (rs.Columns is { Length: > 0 } cols)
        {
            var isLwt = cols[0].Name == "[applied]";
            ResultWriter? writer = null;
            if (!(o.Quiet && isLwt) && o.Collect is null)
            {
                writer = o.Writer ?? await ResultWriter.StartAsync(run, index, cols.Select((c, i) => CqlValues.Describe(c, i)).ToArray()).ConfigureAwait(false);
            }
            var skipped = 0;
            byte[]? endState = null;
            while (true)
            {
                var stop = false;
                foreach (var row in rs)
                {
                    if (isLwt && applied is null) applied = row.GetValue<bool>(0);
                    if (o.ColumnsOnly) { stop = true; break; }
                    if (skipped < skip) { skipped++; continue; }
                    if (o.MaxRows > 0 && count >= o.MaxRows) { truncated = true; stop = true; break; }
                    if (o.Collect is not null)
                    {
                        if (!o.Collect(cols, row)) { stop = true; break; }
                    }
                    else if (writer is not null)
                    {
                        await writer.AddAsync(ReadRow(cols, row)).ConfigureAwait(false);
                    }
                    count++;
                }
                if (stop) break;
                var state = rs.PagingState;
                if (state is null) break;
                if (o.MaxRows > 0 && count >= o.MaxRows)
                {
                    // Exactly at the cap on a page boundary: more rows may follow; remember where.
                    truncated = true;
                    endState = state;
                    break;
                }
                run.Token.ThrowIfCancellationRequested();
                stmt.SetPagingState(state);
                rs = await _session.ExecuteAsync(stmt).WaitAsync(run.Token).ConfigureAwait(false);
                await ReportWarningsAsync(run, index, rs).ConfigureAwait(false);
            }
            if (o.PageKey is not null && endState is not null)
            {
                lock (_pageStates)
                {
                    if (_pageStates.Count > 64) _pageStates.Clear();
                    _pageStates[$"{o.PageKey}@{o.Skip + count}"] = endState;
                }
            }
            if (writer is not null && o.Writer is null && !o.KeepOpen) await writer.EndAsync(count, truncated, started.ElapsedMilliseconds).ConfigureAwait(false);
            if (o.KeepOpen) openWriter = writer;
        }
        if (first.Info.IsSchemaInAgreement is false)
            await run.Sink.Message(index, MessageSeverity.Warning, "The schema change has not reached every node yet (no schema agreement).",
                null, null, MessageSource.Engine).ConfigureAwait(false);
        if (tracing) await ReportTraceAsync(run, index, first, cql).ConfigureAwait(false);
        return new Outcome(first.Columns is { Length: > 0 }, count, applied, truncated, openWriter);
    }

    private static object?[] ReadRow(CqlColumn[] cols, Row row)
    {
        var values = new object?[cols.Length];
        for (var i = 0; i < cols.Length; i++)
        {
            object? v;
            try { v = row.IsNull(i) ? null : row.GetValue<object>(i); }
            catch (Exception ex) when (ex is InvalidCastException or ArgumentException) { v = null; }
            values[i] = CqlValues.ToWire(v, cols[i].TypeCode, cols[i].TypeInfo);
        }
        return values;
    }

    private static async Task ReportWarningsAsync(Run run, int index, RowSet rs)
    {
        if (rs.Info.Warnings is not { Length: > 0 } warnings) return;
        foreach (var w in warnings) await run.Sink.Message(index, MessageSeverity.Warning, w, null, null, MessageSource.Server).ConfigureAwait(false);
    }

    private async Task ReportTraceAsync(Run run, int index, RowSet rs, string cql)
    {
        CqlTrace? trace = null;
        Guid? id = null;
        try
        {
            var qt = await rs.Info.GetQueryTraceAsync().WaitAsync(TimeSpan.FromSeconds(10), run.Token).ConfigureAwait(false);
            id = qt.TraceId;
            trace = await CqlTracing.ReadAsync(_session, qt.TraceId, run.Token, attempts: 3).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await run.Sink.Message(index, MessageSeverity.Warning, $"Could not read the trace: {ex.Message}", null, null, MessageSource.Engine).ConfigureAwait(false);
            return;
        }
        if (id is null) return;
        var summary = new CqlTraceSummary(id.Value.ToString("D"), (trace?.StartedAt ?? DateTimeOffset.UtcNow.ToString(ValueConverter.DateTimeOffsetFormat, Inv)),
            cql.Length > 200 ? cql[..200] : cql, trace?.Coordinator, trace?.DurationMicros, CqlConnectionSettings.ConsistencyName(Settings.Consistency));
        lock (_traces)
        {
            _traces.AddFirst(summary);
            while (_traces.Count > MaxTraces) _traces.RemoveLast();
        }
        await run.Sink.Message(index, MessageSeverity.Info,
            $"Tracing session: {summary.TraceId}" + (trace?.DurationMicros is { } d ? $" — {d.ToString("N0", Inv)} µs on {trace.Coordinator}" : "")
            + ". Open it with \"Cassandra: Show last trace\" or SHOW SESSION " + summary.TraceId + ".", null, null, MessageSource.Engine).ConfigureAwait(false);
        if (trace is not null) await EmitTraceAsync(run, index, trace).ConfigureAwait(false);
    }

    private static Task EmitTraceAsync(Run run, int index, CqlTrace trace)
    {
        var rows = new List<object?[]> { new object?[] { trace.Request ?? "Execute CQL3 query", trace.StartedAt, trace.Coordinator, 0L, null } };
        rows.AddRange(trace.Events.Select(e => new object?[] { e.Activity, e.Timestamp, e.Source, e.SourceElapsedMicros, e.Thread }));
        if (trace.DurationMicros is { } d) rows.Add(["Request complete", null, trace.Coordinator, d, null]);
        return EmitTableAsync(run, index, ["activity", "timestamp", "source", "source_elapsed_us", "thread"], rows);
    }

    /// <summary>A result set built by the engine (shell commands, emulated DESCRIBE, traces).</summary>
    private static async Task EmitTableAsync(Run run, int index, string[] names, IReadOnlyList<object?[]> rows)
    {
        var cols = names.Select((n, i) => new ColumnInfo(n, i, n is "source_elapsed_us" ? "bigint" : "text", n is "source_elapsed_us" ? ColumnKinds.Int : ColumnKinds.String, true)).ToArray();
        var writer = await ResultWriter.StartAsync(run, index, cols).ConfigureAwait(false);
        foreach (var r in rows) await writer.AddAsync(r.Select(v => v is string s ? ValueConverter.Text(s) : v).ToArray()).ConfigureAwait(false);
        await writer.EndAsync(rows.Count, false, 0).ConfigureAwait(false);
    }

    // ------------------------------------------------------------------ binding

    private async Task<IStatement> BuildStatementAsync(Run run, string cql)
    {
        var (positional, names) = CqlText.PositionalMarkers(cql);
        if (names.Count == 0 || run.Request.Params is not { Count: > 0 } ps) return new SimpleStatement(cql);

        var values = new List<QueryParam>(names.Count);
        foreach (var name in names)
        {
            QueryParam? p;
            if (name is null)
            {
                var pos = ++run.Positional;
                p = ps.FirstOrDefault(x => x.IsPositional && x.BareName == pos.ToString(Inv))
                    ?? throw EngineException.Validation("Missing value for a positional parameter (?): supply one value per ? placeholder.", new { field = "params" });
            }
            else
            {
                p = ps.FirstOrDefault(x => x.BareName.Equals(name, StringComparison.OrdinalIgnoreCase))
                    ?? throw EngineException.Validation($"Missing value for parameter :{name}", new { field = "params", name });
            }
            values.Add(p);
        }

        var prepared = await PrepareAsync(positional).ConfigureAwait(false);
        var vars = prepared.Variables.Columns;
        if (vars.Length == values.Count && vars.Any(v => CqlValues.IsComplex(v.TypeCode, v.TypeInfo)))
        {
            // Collections, tuples, UDTs and vectors are written as literals (the driver needs CLR mappings to bind them).
            var markers = CqlText.Placeholders(CqlText.Tokenize(positional));
            var sb = new StringBuilder(positional.Length);
            var last = 0;
            var remaining = new List<(QueryParam P, CqlColumn V)>();
            for (var i = 0; i < markers.Count; i++)
            {
                sb.Append(positional, last, markers[i].Start - last);
                if (CqlValues.IsComplex(vars[i].TypeCode, vars[i].TypeInfo)) sb.Append(CqlValues.Literal(ParamValues.ToClr(values[i]), vars[i].TypeCode, vars[i].TypeInfo));
                else { sb.Append('?'); remaining.Add((values[i], vars[i])); }
                last = markers[i].End;
            }
            sb.Append(positional, last, positional.Length - last);
            var text = sb.ToString();
            if (remaining.Count == 0) return new SimpleStatement(text);
            var again = await PrepareAsync(text).ConfigureAwait(false);
            return again.Bind(remaining.Select(r => CqlValues.ToBind(ParamValues.ToClr(r.P), r.V.TypeCode, r.V.TypeInfo)).ToArray());
        }
        var bound = values.Select((p, i) => i < vars.Length ? CqlValues.ToBind(ParamValues.ToClr(p), vars[i].TypeCode, vars[i].TypeInfo) : ParamValues.ToClr(p)).ToArray();
        return prepared.Bind(bound);
    }

    private Task<PreparedStatement> PrepareAsync(string cql)
    {
        var key = (_session.Keyspace ?? "") + "\u0001" + cql;
        var task = _prepared.GetOrAdd(key, _ => _session.PrepareAsync(cql));
        if (task.IsFaulted || task.IsCanceled)
        {
            _prepared.TryRemove(key, out _);
            task = _prepared.GetOrAdd(key, _ => _session.PrepareAsync(cql));
        }
        if (_prepared.Count > 500) _prepared.Clear();
        return task;
    }

    // ------------------------------------------------------------------ data grid (labels data / filter)

    private async Task<CqlTableMeta?> TableAsync(string? keyspace, string table, CancellationToken ct)
    {
        var ks = keyspace ?? CurrentDatabase;
        if (ks is null) return null;
        var key = ks + "." + table;
        if (_tables.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.At < TimeSpan.FromSeconds(30)) return hit.Meta;
        var meta = (await new CqlSchemaReader(_session).LoadKeyspaceAsync(ks).WaitAsync(ct).ConfigureAwait(false))?.Table(table);
        _tables[key] = (meta, DateTime.UtcNow);
        return meta;
    }

    private async Task RunDataStatementAsync(Run run, int index, SqlBatch batch, CqlStatement st)
    {
        switch (st.Head)
        {
            case "SELECT":
                await DataSelectAsync(run, index, st).ConfigureAwait(false);
                return;
            case "INSERT":
                await DataInsertAsync(run, index, st).ConfigureAwait(false);
                return;
            case "UPDATE":
            case "DELETE":
                await DataUpdateDeleteAsync(run, index, st).ConfigureAwait(false);
                return;
            default:
                await ExecuteAsync(run, index, st.Text, new StreamOptions(run.Request.MaxRows)).ConfigureAwait(false);
                return;
        }
    }

    /// <summary>Token spans of a SELECT: [start, end) indices of each clause (-1 = absent).</summary>
    internal sealed record SelectShape(int From, int Where, int GroupBy, int OrderBy, int PerPartition, int Limit, int Offset, int Allow, int End)
    {
        public int ClauseEnd(int start)
        {
            var ends = new[] { Where, GroupBy, OrderBy, PerPartition, Limit, Offset, Allow, End }.Where(x => x > start).DefaultIfEmpty(End);
            return ends.Min();
        }
    }

    internal static SelectShape ShapeOf(IReadOnlyList<CqlToken> t)
    {
        var from = CqlText.FindWord(t, 1, "FROM");
        var where = from < 0 ? -1 : CqlText.FindWord(t, from, "WHERE");
        var group = from < 0 ? -1 : CqlText.FindWords(t, from, "GROUP", "BY");
        var order = from < 0 ? -1 : CqlText.FindWords(t, from, "ORDER", "BY");
        var per = from < 0 ? -1 : CqlText.FindWords(t, from, "PER", "PARTITION");
        var limit = from < 0 ? -1 : CqlText.FindTopLevel(t, from, (x, k) => x[k].IsWord("LIMIT") && !(k > 0 && x[k - 1].IsWord("PARTITION")));
        var offset = from < 0 ? -1 : CqlText.FindWord(t, from, "OFFSET");
        var allow = from < 0 ? -1 : CqlText.FindWords(t, from, "ALLOW", "FILTERING");
        return new SelectShape(from, where, group, order, per, limit, offset, allow, t.Count);
    }

    private static string Slice(CqlStatement st, int fromToken, int toToken)
    {
        if (fromToken >= toToken || fromToken >= st.Tokens.Count) return "";
        var s = st.Tokens[fromToken].Start - st.Start;
        var e = st.Tokens[toToken - 1].End - st.Start;
        return st.Text[s..e];
    }

    private async Task DataSelectAsync(Run run, int index, CqlStatement st)
    {
        var t = st.Tokens;
        var shape = ShapeOf(t);
        if (shape.From < 0)
        {
            await ExecuteAsync(run, index, st.Text, new StreamOptions(run.Request.MaxRows)).ConfigureAwait(false);
            return;
        }
        var head = Slice(st, 0, shape.ClauseEnd(shape.From));
        var whereEnd = shape.Where >= 0 ? shape.ClauseEnd(shape.Where) : -1;
        var whereTokens = shape.Where >= 0 ? t.Skip(shape.Where + 1).Take(whereEnd - shape.Where - 1).ToList() : [];

        // 1. Describe probe: SELECT * FROM t WHERE 1 = 0 → the columns of one row, no rows.
        if (whereTokens.Count == 3 && whereTokens[0].Value == "1" && whereTokens[1].IsOp("=") && whereTokens[2].Value == "0")
        {
            await ExecuteAsync(run, index, head + " LIMIT 1", new StreamOptions(0, ColumnsOnly: true)).ConfigureAwait(false);
            return;
        }

        var limit = ReadInt(t, shape.Limit);
        var offset = ReadInt(t, shape.Offset) ?? 0;

        // 2. Distinct values: SELECT c, COUNT(*) AS cnt FROM t [WHERE …] GROUP BY c ORDER BY COUNT(*) DESC LIMIT n.
        if (shape.GroupBy >= 0 && shape.OrderBy >= 0 && t.Skip(shape.OrderBy).Any(x => x.IsWord("COUNT")))
        {
            await DistinctValuesAsync(run, index, st, shape, whereTokens, limit ?? 500).ConfigureAwait(false);
            return;
        }

        var where = whereTokens.Count > 0 ? Slice(st, shape.Where, whereEnd) : "";
        var group = shape.GroupBy >= 0 ? Slice(st, shape.GroupBy, shape.ClauseEnd(shape.GroupBy)) : "";
        var per = shape.PerPartition >= 0 ? Slice(st, shape.PerPartition, shape.ClauseEnd(shape.PerPartition)) : "";
        var allow = where.Length > 0 || shape.Allow >= 0 ? " ALLOW FILTERING" : "";

        // ORDER BY: Cassandra sorts within a partition only (clustering order); the grid's default key order is dropped.
        if (shape.OrderBy >= 0)
        {
            var orderTokens = t.Skip(shape.OrderBy + 2).Take(shape.ClauseEnd(shape.OrderBy) - shape.OrderBy - 2).ToList();
            var (ks, table, _) = CqlText.QualifiedName(t, shape.From + 1);
            var meta = table is null ? null : await TableAsync(ks, table, run.Token).ConfigureAwait(false);
            var keyNames = meta?.PrimaryKey.Select(c => c.Name).ToHashSet(StringComparer.Ordinal) ?? [];
            var userSort = orderTokens.Any(x => x.IsWord("DESC")) || orderTokens.Where(x => x.IsName && !x.IsWord("ASC")).Any(x => !keyNames.Contains(x.Name));
            if (userSort && offset == 0)
                await Info(run, index, "Cassandra cannot sort across partitions: rows are shown in partition-token order (clustering order within a partition); the sort was not applied.").ConfigureAwait(false);
        }

        // 3. Key lookups OR-ed together (refetch after a save): one query per alternative, merged into one result set.
        var alternatives = SplitTopLevel(whereTokens, "OR");
        if (alternatives.Count > 1)
        {
            ResultWriter? writer = null;
            long total = 0;
            foreach (var alt in alternatives)
            {
                var cond = StripParens(st, alt);
                var cql = $"{head} WHERE {cond}{(group.Length > 0 ? " " + group : "")} ALLOW FILTERING";
                // The first alternative starts the result set (its columns); the others append to it.
                var o = await ExecuteAsync(run, index, cql, new StreamOptions(run.Request.MaxRows, Writer: writer, KeepOpen: writer is null)).ConfigureAwait(false);
                writer ??= o.Writer;
                total += o.Rows;
            }
            if (writer is not null) await writer.EndAsync(total, false, 0).ConfigureAwait(false);
            return;
        }

        // 4. A page: LIMIT n OFFSET m → driver paging (page size n) resumed from the cached paging state of offset m.
        var baseCql = head + (where.Length > 0 ? " " + where : "") + (group.Length > 0 ? " " + group : "") + (per.Length > 0 ? " " + per : "") + allow;
        var max = limit ?? run.Request.MaxRows;
        if (run.Request.MaxRows > 0 && max > run.Request.MaxRows) max = run.Request.MaxRows;
        var key = baseCql + "\u0001" + ParamsKey(run) + "\u0001" + Settings.Consistency;
        await ExecuteAsync(run, index, baseCql, new StreamOptions(max, Skip: offset, PageSize: max > 0 ? Math.Min(max, CqlConnectionSettings.MaxPageSize) : null,
            PageKey: key)).ConfigureAwait(false);
    }

    private static string ParamsKey(Run run) =>
        run.Request.Params is { Count: > 0 } ps ? string.Join("|", ps.Select(p => p.BareName + "=" + p.Value?.ToJsonString())) : "";

    private static int? ReadInt(IReadOnlyList<CqlToken> t, int at) =>
        at >= 0 && at + 1 < t.Count && t[at + 1].Kind == CqlTokenKind.Number && int.TryParse(t[at + 1].Value, NumberStyles.None, Inv, out var n) ? n : null;

    private static List<List<CqlToken>> SplitTopLevel(IReadOnlyList<CqlToken> tokens, string word)
    {
        var result = new List<List<CqlToken>>();
        var current = new List<CqlToken>();
        var depth = 0;
        foreach (var x in tokens)
        {
            if (x.IsPunct('(') || x.IsPunct('[') || x.IsPunct('{')) depth++;
            else if (x.IsPunct(')') || x.IsPunct(']') || x.IsPunct('}')) depth--;
            if (depth == 0 && x.IsWord(word))
            {
                result.Add(current);
                current = [];
                continue;
            }
            current.Add(x);
        }
        if (current.Count > 0) result.Add(current);
        return result;
    }

    private static string StripParens(CqlStatement st, List<CqlToken> alt)
    {
        var list = alt;
        while (list.Count >= 2 && list[0].IsPunct('(') && list[^1].IsPunct(')') && Balanced(list.Skip(1).Take(list.Count - 2)))
            list = list.Skip(1).Take(list.Count - 2).ToList();
        if (list.Count == 0) return "";
        return st.Text[(list[0].Start - st.Start)..(list[^1].End - st.Start)];
    }

    private static bool Balanced(IEnumerable<CqlToken> tokens)
    {
        var d = 0;
        foreach (var x in tokens)
        {
            if (x.IsPunct('(')) d++;
            else if (x.IsPunct(')') && --d < 0) return false;
        }
        return d == 0;
    }

    /// <summary>"Show only distinct values": Cassandra cannot GROUP BY a regular column, so the values are counted here.</summary>
    private async Task DistinctValuesAsync(Run run, int index, CqlStatement st, SelectShape shape, List<CqlToken> whereTokens, int limit)
    {
        var t = st.Tokens;
        var column = t[1].IsName ? t[1] : null;
        if (column is null)
        {
            await ExecuteAsync(run, index, st.Text, new StreamOptions(run.Request.MaxRows)).ConfigureAwait(false);
            return;
        }
        var countAlias = "cnt";
        var asIndex = CqlText.FindWord(t, 2, "AS");
        if (asIndex > 0 && asIndex < shape.From && asIndex + 1 < t.Count) countAlias = t[asIndex + 1].Name;
        var from = Slice(st, shape.From, shape.ClauseEnd(shape.From));
        var where = whereTokens.Count > 0 ? " " + Slice(st, shape.Where, shape.ClauseEnd(shape.Where)) : "";
        var cql = $"SELECT {column.Value} {from}{where}{(where.Length > 0 ? " ALLOW FILTERING" : "")}";
        var counts = new Dictionary<string, (object? Wire, long Count)>(StringComparer.Ordinal);
        ColumnInfo? info = null;
        long scanned = 0;
        await ExecuteAsync(run, index, cql, new StreamOptions(DistinctScanLimit, PageSize: 5000, Collect: (cols, row) =>
        {
            info ??= CqlValues.Describe(cols[0], 0);
            var wire = ReadRow(cols, row)[0];
            var keyText = wire switch { null => "\u0000null", BinaryValue b => "b:" + b.Bin, _ => "v:" + Convert.ToString(wire, Inv) };
            counts[keyText] = counts.TryGetValue(keyText, out var c) ? (c.Wire, c.Count + 1) : (wire, 1);
            scanned++;
            return true;
        })).ConfigureAwait(false);
        info ??= new ColumnInfo(column.Name, 0, "text", ColumnKinds.String, true);
        var writer = await ResultWriter.StartAsync(run, index, [info, new ColumnInfo(countAlias, 1, "bigint", ColumnKinds.Int, false)]).ConfigureAwait(false);
        var top = counts.Values.OrderByDescending(c => c.Count).Take(limit).ToList();
        foreach (var c in top) await writer.AddAsync([c.Wire, c.Count]).ConfigureAwait(false);
        await writer.EndAsync(top.Count, counts.Count > limit, 0).ConfigureAwait(false);
        await Info(run, index, scanned >= DistinctScanLimit
            ? $"Distinct values counted over the first {DistinctScanLimit:N0} rows (Cassandra cannot group by a regular column)."
            : $"Distinct values counted over {scanned:N0} rows.").ConfigureAwait(false);
    }

    private async Task DataInsertAsync(Run run, int index, CqlStatement st)
    {
        var t = st.Tokens;
        var (ks, table, _) = CqlText.QualifiedName(t, 2);
        var meta = table is null ? null : await TableAsync(ks, table, run.Token).ConfigureAwait(false);
        var cql = st.Text;
        var hasIf = CqlText.FindWord(t, 0, "IF") >= 0;
        var hasUsing = CqlText.FindWord(t, 0, "USING") >= 0;
        var lwt = !hasIf && meta is { IsCounter: false };
        if (lwt) cql += " IF NOT EXISTS";
        if (!hasUsing && Settings.InsertTtl is { } ttl) cql += " USING TTL " + ttl.ToString(Inv);
        var o = await ExecuteAsync(run, index, cql, new StreamOptions(0, Quiet: true)).ConfigureAwait(false);
        if (o.Applied is false)
            throw new EngineException(409, CqlErrors.AlreadyExists,
                "A row with this primary key already exists (INSERT … IF NOT EXISTS was not applied). Edit the existing row instead.");
        await run.Sink.RowsAffected(index, 1, "INSERT").ConfigureAwait(false);
        run.RowsAffected++;
    }

    /// <summary>
    /// UPDATE/DELETE by primary key from the grid: conditions on non-key columns (the "verify unchanged" checks) become a
    /// lightweight-transaction <c>IF</c>; a not-applied result reports 0 rows (the grid shows a conflict).
    /// </summary>
    private async Task DataUpdateDeleteAsync(Run run, int index, CqlStatement st)
    {
        var t = st.Tokens;
        var kind = st.Head;
        var tableAt = kind == "UPDATE" ? 1 : CqlText.FindWord(t, 0, "FROM") + 1;
        var (ks, table, _) = CqlText.QualifiedName(t, tableAt);
        var meta = table is null ? null : await TableAsync(ks, table, run.Token).ConfigureAwait(false);
        var whereAt = CqlText.FindWord(t, 0, "WHERE");
        var cql = st.Text;
        var hasIf = CqlText.FindWord(t, Math.Max(0, whereAt), "IF") >= 0;
        if (meta is not null && whereAt >= 0 && !hasIf)
        {
            var conds = SplitTopLevel(t.Skip(whereAt + 1).ToList(), "AND");
            var keyNames = meta.PrimaryKey.Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
            var keyConds = new List<string>();
            var ifConds = new List<string>();
            foreach (var c in conds)
            {
                if (c.Count == 0) continue;
                var text = st.Text[(c[0].Start - st.Start)..(c[^1].End - st.Start)];
                var col = c[0].IsName ? c[0].Name : null;
                if (col is not null && !keyNames.Contains(col))
                {
                    // "col IS NULL" → "col = null" (IF accepts it; WHERE does not).
                    if (c.Count == 3 && c[1].IsWord("IS") && c[2].IsWord("NULL")) text = $"{c[0].Value} = null";
                    ifConds.Add(text);
                }
                else keyConds.Add(text);
            }
            if (ifConds.Count > 0)
                cql = st.Text[..(t[whereAt].Start - st.Start)] + "WHERE " + string.Join(" AND ", keyConds) + " IF " + string.Join(" AND ", ifConds);
            else if (kind == "UPDATE" && !meta.IsCounter)
                cql += " IF EXISTS"; // never resurrect a row someone deleted meanwhile
        }
        var o = await ExecuteAsync(run, index, cql, new StreamOptions(0, Quiet: true)).ConfigureAwait(false);
        var affected = o.Applied is false ? 0 : 1;
        await run.Sink.RowsAffected(index, affected, kind).ConfigureAwait(false);
        run.RowsAffected += affected;
    }

    // ------------------------------------------------------------------ result writer

    private sealed class ResultWriter
    {
        private const int BatchRows = 200;
        private static readonly TimeSpan MaxAge = TimeSpan.FromMilliseconds(50);
        private readonly Run _run;
        private readonly int _id;
        private List<object?[]> _rows = new(BatchRows);
        private long _last = Stopwatch.GetTimestamp();
        private bool _ended;

        private ResultWriter(Run run, int id)
        {
            _run = run;
            _id = id;
        }

        public static async Task<ResultWriter> StartAsync(Run run, int index, ColumnInfo[] columns)
        {
            var w = new ResultWriter(run, run.NextResultSetId());
            await run.Sink.ResultSetStarted(w._id, index, columns).ConfigureAwait(false);
            return w;
        }

        public async ValueTask AddAsync(object?[] row)
        {
            _rows.Add(row);
            if (_rows.Count >= BatchRows || Stopwatch.GetElapsedTime(_last) >= MaxAge) await FlushAsync().ConfigureAwait(false);
        }

        private async ValueTask FlushAsync()
        {
            if (_rows.Count == 0) return;
            var batch = _rows;
            _rows = new List<object?[]>(BatchRows);
            _last = Stopwatch.GetTimestamp();
            await _run.Sink.Rows(_id, batch).ConfigureAwait(false);
        }

        public async ValueTask EndAsync(long count, bool truncated, long elapsedMs)
        {
            if (_ended) return;
            _ended = true;
            await FlushAsync().ConfigureAwait(false);
            await _run.Sink.ResultSetEnded(_id, count, truncated, elapsedMs).ConfigureAwait(false);
        }
    }

    // ------------------------------------------------------------------ disposal

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _state, StateClosed) == StateClosed) return;
        lock (_cancelLock)
        {
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }
        if (_running is { } running)
        {
            try { await running.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); } catch { /* ignore */ }
        }
        try { await _session.ShutdownAsync().ConfigureAwait(false); } catch { /* best effort */ }
        await _lease.DisposeAsync().ConfigureAwait(false);
    }
}
