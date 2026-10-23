using System.Data;
using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Services;
using DbStudio.Core.Sql;
using DbStudio.Providers.Snowflake.Params;
using Snowflake.Data.Client;

namespace DbStudio.Providers.Snowflake;

/// <summary>Warehouse / role / database / schema of a session (the console's session chips).</summary>
public sealed record SnowflakeSessionContext(string? Warehouse, string? Role, string? Database, string? Schema, string? SecondaryRoles, string? SessionId);

/// <summary>
/// One Snowflake editor-tab session: a dedicated Snowflake.Data connection with pooling off (USE, session variables and
/// an open transaction belong to the tab).
/// <list type="bullet">
/// <item>A batch is normally one statement (the console splits scripts); a batch with several statements is sent as a
/// multi-statement request (<c>MULTI_STATEMENT_COUNT = 0</c>), each result in order.</item>
/// <item>DML bookkeeping results ("number of rows inserted") become rows affected; DDL/USE "status" results become info
/// messages (<see cref="SnowflakeResultReader"/>).</item>
/// <item>Auto mode is autocommit; manual mode begins with <c>BEGIN</c> on the first write. DDL commits an open transaction
/// implicitly in Snowflake: the engine forgets its transaction afterwards and says so. A user-typed BEGIN/COMMIT is
/// tracked through <c>CURRENT_TRANSACTION()</c>.</item>
/// <item>Cancel aborts the request through the driver; when the statement keeps running and its query id is known,
/// <c>SYSTEM$CANCEL_QUERY</c> runs on a side connection.</item>
/// <item><c>ChangeDatabaseAsync</c> is <c>USE DATABASE</c>; <see cref="UseAsync"/> switches warehouse, role or schema.</item>
/// </list>
/// </summary>
public sealed class SnowflakeSession : AdoSessionBase
{
    public const string DdlCommittedMessage =
        "Snowflake commits the open transaction before a DDL statement and runs the DDL in its own transaction: the earlier changes are committed.";

    private const string ReaderKey = "sf.reader";
    private const string StatementsKey = "sf.statements";

    private readonly SnowflakeDbConnection _conn;
    private readonly Func<CancellationToken, Task<Gateway.ISnowflakeGateway>>? _sideConnection;
    private volatile string? _lastQueryId;
    private volatile DbCommand? _running;

    public SnowflakeSession(SnowflakeDbConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server,
        Func<CancellationToken, Task<Gateway.ISnowflakeGateway>>? sideConnection = null)
        : base(connection, profile, options, Dialect.Snowflake, server)
    {
        _conn = connection;
        _sideConnection = sideConnection;
        CurrentDatabase = string.IsNullOrEmpty(server.Database) ? options.Database : server.Database;
    }

    /// <summary>Query id of the last statement this session ran (for operator statistics, history links).</summary>
    public string? LastQueryId => _lastQueryId;

    protected override IParamBinder? ParamBinder => SnowflakeParamBinder.Instance;

    protected override int DefaultCommandTimeoutSeconds => 0;

    protected override string PingSql => "SELECT 1";

    private static IReadOnlyList<SnowflakeSql.Statement> StatementsOf(BatchContext ctx)
    {
        if (ctx.Items.TryGetValue(StatementsKey, out var s) && s is IReadOnlyList<SnowflakeSql.Statement> cached) return cached;
        var list = SnowflakeSql.SplitStatements(ctx.Batch.Sql);
        ctx.Items[StatementsKey] = list;
        return list;
    }

    /// <summary>Manual mode: queries, session and transaction statements, and DDL-only batches (Snowflake runs DDL in its own
    /// transaction anyway) run without the engine transaction; writes begin it.</summary>
    protected override bool RequiresTransaction(BatchContext context)
    {
        var c = context.Classification;
        if (c.Statements.Count > 0 && c.Statements.All(s => s.Category == StatementCategory.Ddl)) return false;
        return !c.IsQueryOnly;
    }

    protected override async Task<DbDataReader> ExecuteReaderAsync(DbCommand command, BatchContext context, CancellationToken ct)
    {
        var statements = StatementsOf(context);
        if (statements.Count > 1)
        {
            var p = command.CreateParameter();
            p.ParameterName = "MULTI_STATEMENT_COUNT";
            p.DbType = DbType.Int16;
            p.Value = (short)0;
            command.Parameters.Add(p);
        }
        _running = command;
        var inner = await command.ExecuteReaderAsync(CommandBehavior.Default, ct).ConfigureAwait(false);
        RememberQueryId(command, inner);
        var reader = new SnowflakeResultReader(inner);
        context.Items[ReaderKey] = reader;
        return reader;
    }

    private void RememberQueryId(DbCommand command, DbDataReader? reader)
    {
        try
        {
            var id = (reader as SnowflakeDbDataReader)?.GetQueryId() ?? (command as SnowflakeDbCommand)?.GetQueryId();
            if (!string.IsNullOrEmpty(id)) _lastQueryId = id;
        }
        catch (Exception) { /* not available */ }
    }

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context) =>
        SnowflakeTypes.Describe(reader is SnowflakeResultReader w ? w.Inner : reader);

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column) =>
        SnowflakeTypes.ReadValue(reader is SnowflakeResultReader w ? w.Inner : reader, ordinal, column);

    /// <summary>DML counts from the bookkeeping results (per statement), else the driver's count for DML.</summary>
    protected override async ValueTask ReportRowsAffectedAsync(BatchContext context, long recordsAffected)
    {
        if (context.Items.TryGetValue(ReaderKey, out var r) && r is SnowflakeResultReader reader && reader.Counts.Count > 0)
        {
            foreach (var group in reader.Counts.GroupBy(c => c.Kind))
                await EmitRowsAffectedAsync(group.Sum(c => c.Count), group.Key).ConfigureAwait(false);
            return;
        }
        if (recordsAffected >= 0 && context.Classification.HasDml)
            await EmitRowsAffectedAsync(recordsAffected, ClassifyAffected(context)).ConfigureAwait(false);
    }

    protected override async ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        _running = null;
        if (context.Command is not null) RememberQueryId(context.Command, null);
        if (context.Items.TryGetValue(ReaderKey, out var r) && r is SnowflakeResultReader reader)
        {
            foreach (var status in reader.Statuses.Where(s => s.Length > 0))
                await EmitMessageAsync(MessageSeverity.Info, status, null, null, MessageSource.Server).ConfigureAwait(false);
        }

        if (_conn.State != ConnectionState.Open) return;
        // The driver tracks the session's database from every response (USE DATABASE, USE SCHEMA db.s, CREATE DATABASE).
        try
        {
            var db = _conn.Database;
            if (!string.IsNullOrEmpty(db)) CurrentDatabase = db;
        }
        catch (Exception) { /* keep the last known */ }

        if (Transaction is not null && context.Status == BatchStatus.Ok && context.Classification.HasDdl)
        {
            var tx = Transaction;
            Transaction = null;
            ServerTxOpen = false;
            try { await tx.DisposeAsync().ConfigureAwait(false); } catch (Exception) { /* already ended on the server */ }
            await EmitMessageAsync(MessageSeverity.Warning, DdlCommittedMessage, null, null, MessageSource.Engine).ConfigureAwait(false);
        }
        else if (Transaction is not null && EndsTransaction(context.Classification))
        {
            // The user's COMMIT/ROLLBACK ended the engine transaction: forget it so the next write begins a new one.
            var tx = Transaction;
            Transaction = null;
            try { await tx.DisposeAsync().ConfigureAwait(false); } catch (Exception) { /* ended */ }
        }
    }

    private static bool EndsTransaction(BatchClassification c) =>
        c.Statements.Any(s => s.Category == StatementCategory.Transaction && s.Kind is "COMMIT" or "ROLLBACK");

    /// <summary>
    /// <c>CURRENT_TRANSACTION()</c> after batches that can open or end a transaction (BEGIN/COMMIT/ROLLBACK typed by the
    /// user, CALL, scripting blocks); other batches keep the known state.
    /// </summary>
    protected override async ValueTask<bool?> QueryServerTransactionOpenAsync(BatchContext context, CancellationToken ct)
    {
        if (_conn.State != ConnectionState.Open) return null;
        var statements = context.Classification.Statements;
        if (!statements.Any(s => s.Category is StatementCategory.Transaction or StatementCategory.Block || s.Kind is "CALL" or "EXECUTE IMMEDIATE"))
            return null;
        await using var cmd = CreateCommand("SELECT CURRENT_TRANSACTION()");
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is not null and not DBNull && !string.IsNullOrEmpty(Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture));
    }

    protected override bool IsCancellationException(Exception exception) =>
        base.IsCancellationException(exception) || SnowflakeErrors.IsCancellation(exception);

    protected override void CancelCommand(DbCommand command)
    {
        try { command.Cancel(); }
        catch (Exception) { /* the request may have finished meanwhile */ }
        var queryId = (command as SnowflakeDbCommand)?.GetQueryIdSafe();
        if (_sideConnection is null || string.IsNullOrEmpty(queryId)) return;
        // Fallback: the abort request reaches the driver's current request only; a statement that keeps running on the
        // server (an async child job, a stuck abort) is cancelled by id from a side connection.
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
            if (!ReferenceEquals(_running, command)) return;
            try
            {
                await using var side = await _sideConnection(CancellationToken.None).ConfigureAwait(false);
                await side.QueryAsync($"SELECT SYSTEM$CANCEL_QUERY({SnowflakeSql.Literal(queryId)})", CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception) { /* best effort */ }
        });
    }

    protected override bool IsConnectionBroken(Exception? exception) =>
        base.IsConnectionBroken(exception) || SnowflakeErrors.IsSessionGone(exception);

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        var sf = exception as SnowflakeDbException ?? exception.InnerException as SnowflakeDbException;
        if (sf is not null)
        {
            if (!string.IsNullOrEmpty(sf.QueryId)) _lastQueryId = sf.QueryId;
            return SnowflakeErrors.FromException(sf, batch);
        }
        return base.MapException(exception, batch);
    }

    protected override async Task ChangeDatabaseCoreAsync(string database, CancellationToken ct)
    {
        var name = SnowflakeSql.Normalize(database);
        await using (var cmd = CreateCommand("USE DATABASE " + SnowflakeSql.AlwaysQuote(name)))
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        CurrentDatabase = string.IsNullOrEmpty(_conn.Database) ? name : _conn.Database;
    }

    // ------------------------------------------------------------------ module endpoints (session chips)

    /// <summary>The session's warehouse, role, database and schema.</summary>
    public Task<SnowflakeSessionContext> GetContextAsync(CancellationToken ct) =>
        RunExclusiveAsync(async (scope, c) => await ReadContextAsync(scope, c).ConfigureAwait(false), ct);

    private static async Task<SnowflakeSessionContext> ReadContextAsync(SessionScope scope, CancellationToken ct)
    {
        await using var cmd = scope.CreateCommand(SnowflakeSql.SessionContext);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false)) return new SnowflakeSessionContext(null, null, null, null, null, null);
        string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);
        return new SnowflakeSessionContext(S(0), S(1), S(2), S(3), S(4), S(5));
    }

    /// <summary>
    /// <c>USE WAREHOUSE / ROLE / DATABASE / SCHEMA</c> (kind = warehouse | role | database | schema; a schema may be
    /// <c>DB.SCHEMA</c>), then the new context. Names are taken as stored (quoted).
    /// </summary>
    public Task<SnowflakeSessionContext> UseAsync(string kind, string name, CancellationToken ct)
    {
        var k = (kind ?? "").Trim().ToLowerInvariant();
        if (k is not ("warehouse" or "role" or "database" or "schema"))
            throw EngineException.Validation("kind must be warehouse, role, database or schema.", new { field = "kind" });
        if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
        var target = k == "schema" && name.Contains('.') && !name.TrimStart().StartsWith('"')
            ? string.Join('.', name.Split('.', 2).Select(p => SnowflakeSql.AlwaysQuote(p.Trim())))
            : SnowflakeSql.AlwaysQuote(name.Trim());
        var sql = $"USE {k.ToUpperInvariant()} {target}";
        return RunExclusiveAsync(async (scope, c) =>
        {
            await using (var cmd = scope.CreateCommand(sql))
            {
                try
                {
                    await cmd.ExecuteNonQueryAsync(c).ConfigureAwait(false);
                }
                catch (SnowflakeDbException ex)
                {
                    throw new EngineException(400, SnowflakeErrors.Code(ex.ErrorCode), SnowflakeErrors.CleanMessage(ex.Message));
                }
            }
            var ctx = await ReadContextAsync(scope, c).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(ctx.Database)) CurrentDatabase = ctx.Database;
            return ctx;
        }, ct);
    }
}

internal static class SnowflakeCommandExtensions
{
    public static string? GetQueryIdSafe(this SnowflakeDbCommand command)
    {
        try { return command.GetQueryId(); } catch (Exception) { return null; }
    }
}
