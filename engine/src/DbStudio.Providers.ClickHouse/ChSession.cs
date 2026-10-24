using System.Data;
using System.Data.Common;
using System.Globalization;
using ClickHouse.Driver;
using ClickHouse.Driver.ADO;
using ClickHouse.Driver.ADO.Parameters;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.ClickHouse.Params;

namespace DbStudio.Providers.ClickHouse;

/// <summary>
/// One ClickHouse console session (plan-batch3 WP-CH) over an HTTP session (<c>session_id</c>): <c>SET</c> values and
/// temporary tables live as long as the tab.
/// <list type="bullet">
/// <item>A batch is split into statements (one HTTP request each, own <c>query_id</c>), streamed through <see cref="ChBatchReader"/>.</item>
/// <item>Cancel aborts the HTTP request and runs <c>KILL QUERY WHERE query_id = '…' SYNC</c> on a side connection, so the
/// server stops (an aborted HTTP request alone does not stop an INSERT … SELECT or OPTIMIZE).</item>
/// <item>A single query with a row cap is sent with <c>max_result_rows = cap + 1</c>, <c>result_overflow_mode = 'break'</c>:
/// the server stops producing rows once the cap is reached.</item>
/// <item><c>USE db</c> switches the database of the following requests (the driver sends it with every request).</item>
/// <item>No transactions: manual mode answers NOT_SUPPORTED; the session always reports auto-commit.</item>
/// <item>INSERT reports the written rows from <c>X-ClickHouse-Summary</c>; <c>ALTER TABLE … UPDATE/DELETE</c> and lightweight
/// <c>DELETE</c> report the mutation from <c>system.mutations</c> (they run in the background).</item>
/// </list>
/// </summary>
public sealed class ChSession : AdoSessionBase, IDbSession
{
    public const string TransactionsNotSupported =
        "ClickHouse has no multi-statement transactions: every statement is applied on its own. Use auto-commit mode.";

    private const string ReaderKey = "ch.reader";
    private const string KillKey = "ch.kill";

    private readonly ChConnection _ch;
    private readonly ConnectionProfile _profile;
    private readonly string? _password;
    private readonly HttpMessageHandler? _handler;
    private readonly SemaphoreSlim _sideGate = new(1, 1);
    private ChConnection? _side;
    private volatile ChBatchReader? _reader;

    public ChSession(ChConnection connection, ConnectionProfile profile, string? password, SessionOptions options, ServerInfo server,
        HttpMessageHandler? handler = null)
        : base(connection.Connection, profile, options with { TxMode = TransactionMode.Auto }, Dialect.ClickHouse, server)
    {
        _ch = connection;
        _profile = profile;
        _password = password;
        _handler = handler;
        CurrentDatabase = connection.Connection.Database;
    }

    private ClickHouseConnection Conn => _ch.Connection;

    // ------------------------------------------------------------------ transactions (none)

    /// <summary>Manual mode is refused (NOT_SUPPORTED); auto stays auto.</summary>
    Task IDbSession.SetTransactionModeAsync(TransactionMode mode, CancellationToken ct) =>
        mode == TransactionMode.Manual
            ? throw new EngineException(400, ErrorCodes.NotSupported, TransactionsNotSupported)
            : SetTransactionModeAsync(mode, ct);

    public override bool TxOpen => false;

    protected override Task<DbTransaction> BeginTransactionAsync(CancellationToken ct) =>
        throw new EngineException(400, ErrorCodes.NotSupported, TransactionsNotSupported);

    protected override Task CommitCoreAsync(CancellationToken ct) => Task.CompletedTask;

    protected override Task RollbackCoreAsync(CancellationToken ct) => Task.CompletedTask;

    // ------------------------------------------------------------------ hooks

    protected override IParamBinder? ParamBinder => ChParamBinder.Instance;

    /// <summary>Not rejected up front: a parametrised view definition (CREATE VIEW … {p:Type}) has placeholders without values; the server reports a missing one ("Substitution x is not set").</summary>
    protected override bool RejectUnboundParameters => false;

    protected override string PingSql => "SELECT 1";

    /// <summary>Describe runs the query with no rows (ClickHouse plans it but reads no data).</summary>
    protected override string PrepareDescribeSql(string sql) => "SELECT * FROM (\n" + base.PrepareDescribeSql(sql) + "\n) LIMIT 0";

    protected override CommandBehavior DescribeBehavior => CommandBehavior.Default;

    protected override async Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct)
    {
        var statements = ChSqlText.Split(command.CommandText);
        var parameters = command.Parameters.OfType<ClickHouseDbParameter>().ToList();
        var reader = await ChBatchReader.OpenAsync(this, statements, parameters, context.Request.MaxRows, ct, r =>
        {
            context.Items[ReaderKey] = r;
            _reader = r;
        }).ConfigureAwait(false);
        return reader;
    }

    /// <summary>A command for one statement: fresh query id, the batch's parameters, the row cap of a single query.</summary>
    internal (ClickHouseCommand Command, string QueryId) CreateStatementCommand(ChStatement st, IReadOnlyList<ClickHouseDbParameter> parameters, int maxRows)
    {
        var cmd = Conn.CreateCommand();
        cmd.CommandText = st.Text;
        var queryId = Guid.NewGuid().ToString();
        cmd.QueryId = queryId;
        cmd.CommandTimeout = CommandTimeoutSeconds;
        if (CommandTimeoutSeconds > 0) cmd.CustomSettings["max_execution_time"] = CommandTimeoutSeconds;
        var referenced = ChParamBinder.Scan(st.Text).Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var p in parameters.Where(p => referenced.Contains(p.ParameterName)))
            cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = p.ParameterName, ClickHouseType = p.ClickHouseType, Value = p.Value });
        if (maxRows > 0 && st.IsQuery && st.Kind is "SELECT" or "WITH")
        {
            cmd.CustomSettings["max_result_rows"] = (long)maxRows + 1;
            cmd.CustomSettings["result_overflow_mode"] = "break";
        }
        return (cmd, queryId);
    }

    /// <summary>Runs one statement. A request that finds the HTTP session still locked by a statement being killed is retried briefly.</summary>
    internal async Task<DbDataReader> ExecuteStatementAsync(ClickHouseCommand cmd, ChStatement st, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await cmd.ExecuteReaderAsync(CommandBehavior.Default, ct).ConfigureAwait(false);
            }
            catch (ClickHouseServerException ex) when (ex.ErrorCode == ChErrors.SessionIsLocked && attempt < 20 && !ct.IsCancellationRequested)
            {
                await Task.Delay(100, ct).ConfigureAwait(false);
                cmd.QueryId = Guid.NewGuid().ToString();
            }
        }
    }

    /// <summary>After a statement without result: <c>USE db</c> switches the database of the next requests.</summary>
    internal Task AfterStatementAsync(ChStatement st, CancellationToken ct)
    {
        if (st.UseDatabase is { } db)
        {
            Conn.ChangeDatabase(db);
            CurrentDatabase = db;
        }
        return Task.CompletedTask;
    }

    internal ChSummary? SummaryOf(string queryId) => _ch.Observer.SummaryOf(queryId);

    private readonly Queue<(string Kind, string QueryId)> _history = new();

    internal void Record(ChStatement st, string queryId)
    {
        lock (_history)
        {
            _history.Enqueue((st.Kind, queryId));
            while (_history.Count > 16) _history.Dequeue();
        }
    }

    /// <summary>Query id of the most recent statement whose kind is not in <paramref name="exceptKinds"/> (actual plans).</summary>
    public string? LastQueryId(IReadOnlyCollection<string> exceptKinds)
    {
        lock (_history)
            return _history.Reverse().Where(h => !exceptKinds.Contains(h.Kind)).Select(h => h.QueryId).FirstOrDefault();
    }

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        var columns = new ColumnInfo[reader.FieldCount];
        for (var i = 0; i < columns.Length; i++)
        {
            string name;
            try { name = reader.GetName(i); } catch { name = $"column{i + 1}"; }
            string dbType;
            try { dbType = reader.GetDataTypeName(i); } catch { dbType = ""; }
            var kind = ChTypes.KindFor(dbType);
            columns[i] = new ColumnInfo(name, i, dbType, kind, ChTypes.IsNullable(dbType) || dbType.Length == 0,
                Precision: kind == ColumnKinds.Decimal ? DecimalArg(dbType, 0) : null,
                Scale: kind == ColumnKinds.Decimal ? DecimalArg(dbType, 1) : null);
        }
        return columns;
    }

    private static int? DecimalArg(string type, int index)
    {
        var t = ChTypes.Unwrap(type);
        var b = ChTypes.BaseName(t);
        var p = t.IndexOf('(');
        if (p < 0) return null;
        var args = ChTypes.SplitArgs(t[(p + 1)..^1]);
        // Decimal(P, S) or Decimal32(S)
        if (b == "Decimal") return index < args.Count && int.TryParse(args[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;
        if (index == 1 && args.Count == 1 && int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var s)) return s;
        if (index == 0) return b switch { "Decimal32" => 9, "Decimal64" => 18, "Decimal128" => 38, "Decimal256" => 76, _ => null };
        return null;
    }

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column)
    {
        if (reader.IsDBNull(ordinal)) return null;
        return ChTypes.ToWire(reader.GetValue(ordinal), column.DbType);
    }

    /// <summary>A single query stops at the row cap (the server already stopped with result_overflow_mode = 'break').</summary>
    protected override ValueTask<bool> OnResultSetTruncatedAsync(DbDataReader reader, BatchContext context)
    {
        var r = reader as ChBatchReader;
        var last = r is null || r.Outcomes.Count >= StatementCount(context);
        return ValueTask.FromResult(!last);
    }

    private static int StatementCount(BatchContext context) => ChSqlText.Split(context.Batch.Sql).Count;

    /// <summary>Rows written per INSERT (and CREATE … AS SELECT), from the response summary.</summary>
    protected override async ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected)
    {
        if (context.Items.TryGetValue(ReaderKey, out var o) && o is ChBatchReader r)
            foreach (var outcome in r.Outcomes)
                if (outcome.Statement.IsInsert && outcome.Summary is { } s)
                    await EmitRowsAffectedAsync(s.WrittenRows, "INSERT").ConfigureAwait(false);
    }

    protected override async ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        _reader = null;
        if (context.Items.TryGetValue(KillKey, out var k) && k is Task kill)
        {
            try { await kill.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                await EmitMessageAsync(MessageSeverity.Warning, $"KILL QUERY failed: {ChErrors.CleanMessage(ex.Message)}", null, null, MessageSource.Engine).ConfigureAwait(false);
            }
        }
        if (context.Status != BatchStatus.Ok || !context.Items.TryGetValue(ReaderKey, out var o) || o is not ChBatchReader r) return;
        foreach (var outcome in r.Outcomes)
        {
            if (outcome.Statement.Mutation is not { } m) continue;
            var db = m.Database ?? CurrentDatabase ?? ChConnections.DefaultDatabase;
            var text = await MutationMessageAsync(db, m.Table).ConfigureAwait(false);
            if (text is not null) await EmitMessageAsync(MessageSeverity.Info, text, null, null, MessageSource.Engine).ConfigureAwait(false);
        }
    }

    private async Task<string?> MutationMessageAsync(string database, string table)
    {
        try
        {
            await using var cmd = Conn.CreateCommand();
            cmd.CommandText = "SELECT mutation_id, command, is_done, parts_to_do, latest_fail_reason FROM system.mutations " +
                              "WHERE database = {db:String} AND table = {t:String} ORDER BY create_time DESC, mutation_id DESC LIMIT 1";
            cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = "db", ClickHouseType = "String", Value = database });
            cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = "t", ClickHouseType = "String", Value = table });
            await using var r = await cmd.ExecuteReaderAsync().ConfigureAwait(false);
            if (!await r.ReadAsync().ConfigureAwait(false))
                return $"Mutation of {database}.{table} applied.";
            var id = Convert.ToString(r.GetValue(0), CultureInfo.InvariantCulture);
            var done = Convert.ToInt64(r.GetValue(2), CultureInfo.InvariantCulture) != 0;
            var parts = Convert.ToInt64(r.GetValue(3), CultureInfo.InvariantCulture);
            var fail = r.IsDBNull(4) ? null : Convert.ToString(r.GetValue(4), CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(fail)) return $"Mutation {id} of {database}.{table} is failing: {fail}";
            return done
                ? $"Mutation {id} of {database}.{table} finished."
                : $"Mutation {id} of {database}.{table} submitted ({parts} part(s) to rewrite); ClickHouse applies it in the background (see ClickHouse: Mutations).";
        }
        catch (Exception ex) when (ex is ClickHouseServerException or HttpRequestException or InvalidOperationException)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ cancel

    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception)
        || exception is ClickHouseServerException { ErrorCode: ChErrors.QueryWasCancelled }
        || exception.InnerException is OperationCanceledException or IOException;

    /// <summary>Aborts the running request; on a user cancel also KILLs the query on the server (side connection).</summary>
    protected override void CancelCommand(DbCommand command)
    {
        var reader = _reader;
        reader?.CancelCurrent();
        var queryId = reader?.CurrentQueryId;
        if (queryId is null || !CancelRequested) return; // row-cap stop of a read-only query: the server stops on close
        var ctx = CurrentBatch;
        var kill = Task.Run(() => KillQueryAsync(queryId));
        if (ctx is not null) ctx.Items[KillKey] = kill;
    }

    /// <summary><c>KILL QUERY WHERE query_id = '…' SYNC</c> on a connection outside the HTTP session.</summary>
    public async Task KillQueryAsync(string queryId)
    {
        if (!Guid.TryParse(queryId, out var id)) return;
        await _sideGate.WaitAsync().ConfigureAwait(false);
        try
        {
            _side ??= await ChConnections.OpenAsync(_profile, _password, CurrentDatabase, null, CancellationToken.None, _handler).ConfigureAwait(false);
            await using var cmd = _side.Connection.CreateCommand();
            cmd.CommandText = $"KILL QUERY WHERE query_id = '{id:D}' SYNC";
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var r = await cmd.ExecuteReaderAsync(timeout.Token).ConfigureAwait(false);
            while (await r.ReadAsync(timeout.Token).ConfigureAwait(false)) { }
        }
        finally
        {
            _sideGate.Release();
        }
    }

    // ------------------------------------------------------------------ errors

    protected override bool IsConnectionBroken(Exception? exception) => false;

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        var st = CurrentBatch?.Items.TryGetValue(ReaderKey, out var o) == true && o is ChBatchReader r ? r.Current : null;
        return ChErrors.Map(exception, batch, st);
    }

    protected override async Task ChangeDatabaseCoreAsync(string database, CancellationToken ct)
    {
        await using var cmd = Conn.CreateCommand();
        cmd.CommandText = "USE " + ChSqlText.Quote(database);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        Conn.ChangeDatabase(database);
        CurrentDatabase = database;
    }

    protected override async ValueTask DisposeCoreAsync()
    {
        if (_side is not null) await _side.DisposeAsync().ConfigureAwait(false);
        _sideGate.Dispose();
        await _ch.DisposeAsync().ConfigureAwait(false);
    }
}
