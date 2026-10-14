using System.Data;
using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Oracle.Params;
using Oracle.ManagedDataAccess.Client;
using Oracle.ManagedDataAccess.Types;

namespace DbStudio.Providers.Oracle;

/// <summary>
/// One Oracle editor-tab session (pooling and statement cache off). Each batch is one statement. Handles the
/// DBMS_OUTPUT pump, ALL_ERRORS after CREATE of PL/SQL units (ORA-24344), BIND_VARS_UNSUPPORTED, auto-commit
/// after each batch in Auto mode and ALTER SESSION SET CURRENT_SCHEMA.
/// </summary>
public sealed class OracleSession : AdoSessionBase
{
    /// <summary>Rows per round trip are bounded by bytes: 1 MB per fetch (docs/PLAN.md 2.5).</summary>
    public const long FetchSizeBytes = 1024 * 1024;

    private const int DbmsOutputChunk = 1000;
    private const int DbmsOutputLineSize = 32767;
    private const string PreparedKey = "oracle.prepared";
    private const string CompileErrorKey = "oracle.compileError";

    private readonly OracleConnection _conn;
    private bool _dbmsOutputEnabled;

    public OracleSession(OracleConnection connection, ConnectionProfile profile, SessionOptions options, ServerInfo server, bool dbmsOutputEnabled)
        : base(connection, profile, options, Dialect.PlSql, server)
    {
        _conn = connection;
        _dbmsOutputEnabled = dbmsOutputEnabled;
        _conn.InfoMessage += OnInfoMessage;
    }

    protected override string PingSql => "SELECT 1 FROM dual";

    /// <summary>Oracle is always in an implicit transaction: COMMIT after every successful batch in Auto mode.</summary>
    protected override bool AutoCommitAfterBatch => true;

    // ------------------------------------------------------------------ hooks

    protected override async ValueTask OnExecutionStartingAsync(ExecuteRequest request, IExecutionSink sink, CancellationToken ct)
    {
        if (request.CaptureServerOutput == _dbmsOutputEnabled) return;
        await using var cmd = CreateCommand(request.CaptureServerOutput ? "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;" : "BEGIN DBMS_OUTPUT.DISABLE; END;");
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        _dbmsOutputEnabled = request.CaptureServerOutput;
    }

    protected override ErrorInfo? ValidateBatch(SqlBatch batch, BatchContext context)
    {
        var (sql, offset) = OracleSqlText.Prepare(batch.Sql);
        context.Items[PreparedKey] = new Prepared(sql, offset, OracleSqlText.RewriteExec(batch.Sql.Trim()) is not null);
        if (sql.Length == 0)
            return new ErrorInfo(ErrorCodes.Validation, "The statement is empty.", batch.Line, batch.Col);
        var binds = OracleSqlText.FindBindVariables(sql);
        if (binds.Count == 0) return null;
        // M1.5: binds with a typed parameter are bound (OracleParamBinder); the error remains for binds without one.
        var supplied = new HashSet<string>((context.Request.Params ?? []).Select(p => p.BareName), StringComparer.OrdinalIgnoreCase);
        var missing = binds.Where(b => !supplied.Contains(OracleParamBinder.BindName(":" + b))).ToList();
        if (missing.Count == 0) return null;
        var first = OracleSqlText.Tokenize(sql).First(t => t.Kind == OracleTokenKind.Bind
            && missing.Contains(t.Text[1..], StringComparer.OrdinalIgnoreCase));
        var (line, col) = OracleErrors.FromBatchOffset(batch, offset + first.Offset);
        return new ErrorInfo(ErrorCodes.BindVarsUnsupported,
            $"Bind variables need typed values ({OracleSqlText.JoinNames(missing)}). Run with parameters (Ctrl+Alt+P) or replace them with literal values.",
            line, col, Detail: string.Join(",", missing));
    }

    /// <summary>M1.5: :name / :1 binds, REF CURSOR outs.</summary>
    protected override IParamBinder? ParamBinder => OracleParamBinder.Instance;

    /// <summary>M1.5: REF CURSOR out params whose rows the reader did not already return are streamed as result sets.</summary>
    protected override async ValueTask OnParametersAvailableAsync(BatchContext context, CancellationToken ct)
    {
        var cursors = context.Parameters.Outputs.Where(o => o.Param.Kind == ParamKinds.RefCursor).ToList();
        for (var i = context.ResultSetCount; i < cursors.Count; i++)
        {
            if (cursors[i].Parameter.Value is not OracleRefCursor rc || rc.IsNull) continue;
            await using var reader = rc.GetDataReader();
            if (reader.FieldCount == 0) continue;
            if (!await StreamResultSetAsync(reader, context, ct).ConfigureAwait(false)) break;
        }
    }

    protected override string PrepareDescribeSql(string sql) => OracleSqlText.Prepare(sql).Sql;

    protected override CommandBehavior DescribeBehavior => CommandBehavior.SchemaOnly;

    protected override void ConfigureDescribeCommand(DbCommand command)
    {
        var cmd = (OracleCommand)command;
        cmd.BindByName = true;
        cmd.InitialLONGFetchSize = -1;
        cmd.InitialLOBFetchSize = -1;
    }

    protected override void ConfigureCommand(DbCommand command, BatchContext context)
    {
        var cmd = (OracleCommand)command;
        cmd.BindByName = true;
        cmd.CommandText = GetPrepared(context).Sql;
        cmd.InitialLONGFetchSize = -1;
        cmd.InitialLOBFetchSize = -1;
        cmd.FetchSize = FetchSizeBytes;
    }

    /// <summary>ODP.NET type names (GetDataTypeName) → Oracle display type and wire kind.</summary>
    private static readonly Dictionary<string, (string Display, string Kind)> OdpTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Decimal"] = ("NUMBER", ColumnKinds.Decimal),
        ["Int16"] = ("NUMBER", ColumnKinds.Int),
        ["Int32"] = ("NUMBER", ColumnKinds.Int),
        ["Int64"] = ("NUMBER", ColumnKinds.Int),
        ["Single"] = ("NUMBER", ColumnKinds.Float),
        ["Double"] = ("NUMBER", ColumnKinds.Float),
        ["BinaryFloat"] = ("BINARY_FLOAT", ColumnKinds.Float),
        ["BinaryDouble"] = ("BINARY_DOUBLE", ColumnKinds.Float),
        ["Varchar2"] = ("VARCHAR2", ColumnKinds.String),
        ["NVarchar2"] = ("NVARCHAR2", ColumnKinds.String),
        ["Char"] = ("CHAR", ColumnKinds.String),
        ["NChar"] = ("NCHAR", ColumnKinds.String),
        ["Long"] = ("LONG", ColumnKinds.String),
        ["Clob"] = ("CLOB", ColumnKinds.String),
        ["NClob"] = ("NCLOB", ColumnKinds.String),
        ["Blob"] = ("BLOB", ColumnKinds.Binary),
        ["Raw"] = ("RAW", ColumnKinds.Binary),
        ["LongRaw"] = ("LONG RAW", ColumnKinds.Binary),
        ["BFile"] = ("BFILE", ColumnKinds.Other),
        ["Date"] = ("DATE", ColumnKinds.DateTime),
        ["TimeStamp"] = ("TIMESTAMP", ColumnKinds.DateTime),
        ["TimeStampLTZ"] = ("TIMESTAMP WITH LOCAL TIME ZONE", ColumnKinds.DateTime),
        ["TimeStampTZ"] = ("TIMESTAMP WITH TIME ZONE", ColumnKinds.DateTimeOffset),
        ["IntervalYM"] = ("INTERVAL YEAR TO MONTH", ColumnKinds.String),
        ["IntervalDS"] = ("INTERVAL DAY TO SECOND", ColumnKinds.String),
        ["XmlType"] = ("XMLTYPE", ColumnKinds.Xml),
        ["Json"] = ("JSON", ColumnKinds.Json),
        ["Boolean"] = ("BOOLEAN", ColumnKinds.Bool),
        ["RefCursor"] = ("REF CURSOR", ColumnKinds.Cursor),
        ["Rowid"] = ("ROWID", ColumnKinds.String),
        ["Urowid"] = ("UROWID", ColumnKinds.String),
    };

    private string[] _odpTypeNames = [];

    protected override ColumnInfo[] DescribeColumns(DbDataReader reader, BatchContext context)
    {
        var cols = base.DescribeColumns(reader, context);
        var names = new string[cols.Length];
        for (int i = 0; i < cols.Length; i++)
        {
            names[i] = cols[i].DbType;
            if (OdpTypes.TryGetValue(cols[i].DbType, out var t))
                cols[i] = cols[i] with { DbType = t.Display, Kind = t.Kind };
        }
        _odpTypeNames = names;
        return cols;
    }

    protected override object? ReadValue(DbDataReader reader, int ordinal, ColumnInfo column)
    {
        if (reader.IsDBNull(ordinal)) return null;
        var r = (OracleDataReader)reader;
        try
        {
            if (column.Kind == ColumnKinds.Cursor) return CursorValue.Instance;
            var type = (ordinal < _odpTypeNames.Length ? _odpTypeNames[ordinal] : column.DbType).ToUpperInvariant();
            switch (type)
            {
                case "DECIMAL":
                case "NUMBER":
                    return r.GetOracleDecimal(ordinal).ToString();
                case "TIMESTAMPTZ":
                {
                    var tz = r.GetOracleTimeStampTZ(ordinal);
                    return ValueConverter.ToWire(new DateTimeOffset(DateTime.SpecifyKind(tz.Value, DateTimeKind.Unspecified), tz.GetTimeZoneOffset()));
                }
                case "INTERVALYM":
                    return r.GetOracleIntervalYM(ordinal).ToString();
                case "INTERVALDS":
                    return r.GetOracleIntervalDS(ordinal).ToString();
                case "XMLTYPE":
                    return ValueConverter.Text(r.GetOracleXmlType(ordinal).Value);
                case "REFCURSOR":
                    return CursorValue.Instance;
            }
            var value = r.GetValue(ordinal);
            return value switch
            {
                OracleRefCursor => CursorValue.Instance,
                OracleXmlType x => ValueConverter.Text(x.Value),
                OracleBFile bf => bf.IsNull ? null : ValueConverter.Text("(BFILE " + bf.DirectoryName + "/" + bf.FileName + ")"),
                _ => ValueConverter.ToWire(value),
            };
        }
        catch (Exception ex) when (ex is InvalidCastException or OverflowException or ArgumentException)
        {
            // e.g. NUMBER outside System.Decimal: the provider-specific value keeps full precision.
            return ValueConverter.Text(r.GetProviderSpecificValue(ordinal)?.ToString() ?? "");
        }
    }

    protected override async Task CommitAfterBatchAsync(BatchContext context, CancellationToken ct)
    {
        // Queries change nothing; skip the round trip.
        if (context.Classification.IsQueryOnly && OracleSqlText.IsQuery(GetPrepared(context).Sql)) return;
        await base.CommitAfterBatchAsync(context, ct).ConfigureAwait(false);
    }

    protected override async ValueTask OnBatchCompletedAsync(BatchContext context)
    {
        if (_dbmsOutputEnabled) await PumpDbmsOutputAsync().ConfigureAwait(false);

        var prepared = GetPrepared(context);
        if (context.Status != BatchStatus.Cancelled && !prepared.Rewritten && OracleSqlText.FindCreatedUnit(prepared.Sql) is { } unit
            && (context.Status == BatchStatus.Ok || context.Items.ContainsKey(CompileErrorKey)
                || context.Exception is OracleException { Number: OracleErrors.SuccessWithCompilationError }))
        {
            await ReportCompileErrorsAsync(context, prepared, unit).ConfigureAwait(false);
        }

        if (context.Status == BatchStatus.Ok && OracleSqlText.IsSetCurrentSchema(prepared.Sql))
            CurrentDatabase = await ReadCurrentSchemaAsync(CancellationToken.None).ConfigureAwait(false);
    }

    protected override ErrorInfo MapException(Exception exception, SqlBatch batch)
    {
        if (exception is not OracleException ora) return base.MapException(exception, batch);
        var prepared = CurrentBatch?.Items.TryGetValue(PreparedKey, out var p) == true && p is Prepared pr ? pr
            : new Prepared(OracleSqlText.Prepare(batch.Sql).Sql, OracleSqlText.Prepare(batch.Sql).Offset, false);
        return OracleErrors.Map(ora.Number, ora.Message, batch, prepared.Sql, prepared.Offset, prepared.Rewritten);
    }

    protected override async Task ChangeDatabaseCoreAsync(string database, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(database);
        var name = database.Trim();
        if (name.Length >= 2 && name[0] == '"' && name[^1] == '"') name = name[1..^1];
        try
        {
            await SetCurrentSchemaAsync(name, ct).ConfigureAwait(false);
        }
        catch (OracleException ex) when (ex.Number == 1435 && name != name.ToUpperInvariant())
        {
            // ORA-01435 user does not exist: an unquoted-style name typed in lower case.
            await SetCurrentSchemaAsync(name.ToUpperInvariant(), ct).ConfigureAwait(false);
        }
        CurrentDatabase = await ReadCurrentSchemaAsync(ct).ConfigureAwait(false);
    }

    protected override ValueTask DisposeCoreAsync()
    {
        _conn.InfoMessage -= OnInfoMessage;
        return ValueTask.CompletedTask;
    }

    // ------------------------------------------------------------------ helpers

    private sealed record Prepared(string Sql, int Offset, bool Rewritten);

    private static Prepared GetPrepared(BatchContext context)
    {
        if (context.Items.TryGetValue(PreparedKey, out var p) && p is Prepared prepared) return prepared;
        var (sql, offset) = OracleSqlText.Prepare(context.Batch.Sql);
        var created = new Prepared(sql, offset, OracleSqlText.RewriteExec(context.Batch.Sql.Trim()) is not null);
        context.Items[PreparedKey] = created;
        return created;
    }

    private async Task SetCurrentSchemaAsync(string schema, CancellationToken ct)
    {
        await using var cmd = CreateCommand("ALTER SESSION SET CURRENT_SCHEMA = " + OracleSqlText.Quote(schema));
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    private async Task<string?> ReadCurrentSchemaAsync(CancellationToken ct)
    {
        await using var cmd = CreateCommand(OracleCatalogQueries.CurrentSchema);
        return Convert.ToString(await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false));
    }

    /// <summary>Drains DBMS_OUTPUT with GET_LINES into a PL/SQL associative array, 1000 lines per round trip.</summary>
    private async Task PumpDbmsOutputAsync()
    {
        while (true)
        {
            await using var cmd = (OracleCommand)CreateCommand("BEGIN DBMS_OUTPUT.GET_LINES(:lines, :numlines); END;");
            cmd.BindByName = true;
            var lines = new OracleParameter("lines", OracleDbType.Varchar2, ParameterDirection.Output)
            {
                CollectionType = OracleCollectionType.PLSQLAssociativeArray,
                Size = DbmsOutputChunk,
                ArrayBindSize = Enumerable.Repeat(DbmsOutputLineSize, DbmsOutputChunk).ToArray(),
            };
            var count = new OracleParameter("numlines", OracleDbType.Int32, ParameterDirection.InputOutput) { Value = DbmsOutputChunk };
            cmd.Parameters.Add(lines);
            cmd.Parameters.Add(count);
            await cmd.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);

            int n = count.Value switch
            {
                OracleDecimal d => d.IsNull ? 0 : d.ToInt32(),
                null or DBNull => 0,
                var v => Convert.ToInt32(v, System.Globalization.CultureInfo.InvariantCulture),
            };
            foreach (var line in DbmsOutputLines(lines.Value, n))
                await EmitMessageAsync(MessageSeverity.Info, line, null, null, MessageSource.DbmsOutput).ConfigureAwait(false);
            if (n < DbmsOutputChunk) break;
        }
    }

    /// <summary>Extracts the first <paramref name="count"/> lines of a GET_LINES output array (null lines → "").</summary>
    public static IEnumerable<string> DbmsOutputLines(object? arrayValue, int count)
    {
        if (arrayValue is not Array array) yield break;
        int n = Math.Min(count, array.Length);
        for (int i = 0; i < n; i++)
        {
            yield return array.GetValue(i) switch
            {
                OracleString s => s.IsNull ? "" : s.Value,
                null or DBNull => "",
                var v => v.ToString() ?? "",
            };
        }
    }

    private async Task ReportCompileErrorsAsync(BatchContext context, Prepared prepared, OracleCreatedUnit unit)
    {
        var owner = unit.Owner ?? await ReadCurrentSchemaAsync(CancellationToken.None).ConfigureAwait(false) ?? "";
        var rows = new List<(int Line, int Col, string Text, string Attribute)>();
        await using (var cmd = (OracleCommand)CreateCommand(OracleCatalogQueries.Errors))
        {
            cmd.BindByName = true;
            cmd.Parameters.Add(new OracleParameter("owner", owner));
            cmd.Parameters.Add(new OracleParameter("name", unit.Name));
            cmd.Parameters.Add(new OracleParameter("type", unit.ObjectType));
            await using var r = await cmd.ExecuteReaderAsync(CancellationToken.None).ConfigureAwait(false);
            while (await r.ReadAsync(CancellationToken.None).ConfigureAwait(false))
            {
                rows.Add((r.IsDBNull(0) ? 0 : Convert.ToInt32(r.GetValue(0)), r.IsDBNull(1) ? 0 : Convert.ToInt32(r.GetValue(1)),
                    r.IsDBNull(2) ? "" : r.GetString(2).TrimEnd(), r.IsDBNull(3) ? "ERROR" : r.GetString(3)));
            }
        }
        if (rows.Count == 0) return;

        int keywordOffset = prepared.Offset + unit.SourceOffset;
        var diagnostics = new List<SqlDiagnostic>(rows.Count);
        bool anyError = false;
        foreach (var e in rows)
        {
            bool isError = !string.Equals(e.Attribute, "WARNING", StringComparison.OrdinalIgnoreCase);
            anyError |= isError;
            var (line, col) = OracleErrors.MapCompileError(context.Batch, keywordOffset, e.Line, e.Col);
            var code = OracleErrors.LeadingCodeOf(e.Text);
            diagnostics.Add(new SqlDiagnostic(line, col, line, col + 1, isError ? "error" : "warning", code, e.Text));
            if (isError)
                await EmitErrorAsync(new ErrorInfo(code ?? "PLS", e.Text, line, col, Detail: $"{unit.ObjectType} {owner}.{unit.Name}, line {e.Line}, column {e.Col}")).ConfigureAwait(false);
            else
                await EmitMessageAsync(MessageSeverity.Warning, e.Text, line, null, MessageSource.Server).ConfigureAwait(false);
        }
        await EmitDiagnosticsAsync(diagnostics).ConfigureAwait(false);
        if (anyError)
        {
            if (context.Status == BatchStatus.Ok)
                await EmitMessageAsync(MessageSeverity.Error, $"{unit.ObjectType} {owner}.{unit.Name} was created with compilation errors.",
                    null, OracleErrors.SuccessWithCompilationError, MessageSource.Engine).ConfigureAwait(false);
            context.Status = BatchStatus.Error;
        }
    }

    private void OnInfoMessage(object sender, OracleInfoMessageEventArgs e)
    {
        var ctx = CurrentBatch;
        if (ctx is null) return;
        if (e.Errors is { Count: > 0 } errors)
        {
            foreach (OracleError err in errors)
            {
                if (err.Number == OracleErrors.SuccessWithCompilationError) ctx.Items[CompileErrorKey] = true;
                EmitMessage(MessageSeverity.Warning, OracleErrors.CleanMessage(err.Message).Message, null, err.Number, MessageSource.Server);
            }
        }
        else if (!string.IsNullOrWhiteSpace(e.Message))
        {
            EmitMessage(MessageSeverity.Warning, OracleErrors.CleanMessage(e.Message).Message, null, null, MessageSource.Server);
        }
    }
}
