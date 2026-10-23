using System.Data;
using System.Data.Common;
using DbStudio.Core.Models;
using DbStudio.Logs.Sql;
using Snowflake.Data.Client;

namespace DbStudio.Providers.Snowflake.Gateway;

/// <summary>Process-wide Snowflake.Data settings, applied once before the first connection.</summary>
internal static class SnowflakeDriver
{
    private static int s_initialized;

    public static void EnsureInitialized()
    {
        if (Interlocked.Exchange(ref s_initialized, 1) == 1) return;
        // Browser SSO / MFA tokens stay in memory: nothing is written to the user's credential store or home folder
        // (on macOS/Linux the file manager would also need the Mono.Unix native library for chmod).
        try { SnowflakeCredentialManagerFactory.UseInMemoryCredentialManager(); } catch (Exception) { /* older drivers */ }
    }

    /// <summary>Opens a connection (secrets as SecureString properties).</summary>
    public static async Task<SnowflakeDbConnection> OpenAsync(SnowflakeConnectionStrings.Built built, CancellationToken ct)
    {
        EnsureInitialized();
        var conn = new SnowflakeDbConnection(built.ConnectionString);
        if (built.Password is not null) conn.Password = built.Password;
        if (built.Token is not null) conn.Token = built.Token;
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>A cell as a plain value: VARIANT/OBJECT/ARRAY as their JSON text, everything else as the driver reads it.</summary>
    public static object? Cell(DbDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        try
        {
            return r.GetValue(i) switch
            {
                DBNull => null,
                var v => v,
            };
        }
        catch (Exception ex) when (ex is OverflowException or InvalidCastException or FormatException)
        {
            return r.GetString(i);
        }
    }
}

/// <summary>The real gateway: one pooled Snowflake.Data connection, statements run sequentially.</summary>
public sealed class SnowflakeGateway : ISnowflakeGateway
{
    private readonly SnowflakeDbConnection _conn;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public SnowflakeGateway(SnowflakeDbConnection connection) => _conn = connection;

    public SnowflakeDbConnection Connection => _conn;

    public Task<SqlRowSet> QueryAsync(string sql, CancellationToken ct) => QueryAsync(sql, [], ct);

    public async Task<SqlRowSet> QueryAsync(string sql, IReadOnlyList<object?> binds, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var cmd = Command(sql, binds);
            await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
            var columns = new string[r.FieldCount];
            for (var i = 0; i < columns.Length; i++) columns[i] = r.GetName(i);
            var rows = new List<object?[]>();
            while (await r.ReadAsync(ct).ConfigureAwait(false))
            {
                var row = new object?[columns.Length];
                for (var i = 0; i < row.Length; i++) row[i] = SnowflakeDriver.Cell(r, i);
                rows.Add(row);
            }
            return new SqlRowSet(columns, rows);
        }
        catch (SnowflakeDbException ex)
        {
            throw new SnowflakeQueryException(SnowflakeErrors.CleanMessage(ex.Message), ex.ErrorCode, ex.SqlState, ex.QueryId, ex);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ExecuteAsync(string sql, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await using var cmd = Command(sql, []);
            await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        }
        catch (SnowflakeDbException ex)
        {
            throw new SnowflakeQueryException(SnowflakeErrors.CleanMessage(ex.Message), ex.ErrorCode, ex.SqlState, ex.QueryId, ex);
        }
        finally
        {
            _gate.Release();
        }
    }

    private DbCommand Command(string sql, IReadOnlyList<object?> binds)
    {
        var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.CommandTimeout = 0;
        for (var i = 0; i < binds.Count; i++)
        {
            var p = cmd.CreateParameter();
            p.ParameterName = (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var v = binds[i];
            p.DbType = v switch
            {
                long or int => DbType.Int64,
                decimal => DbType.Decimal,
                double => DbType.Double,
                bool => DbType.Boolean,
                _ => DbType.String,
            };
            p.Value = v ?? DBNull.Value;
            cmd.Parameters.Add(p);
        }
        return cmd;
    }

    public async ValueTask DisposeAsync()
    {
        try { await _conn.DisposeAsync().ConfigureAwait(false); }
        catch (Exception) { /* returning a dead session to the pool */ }
        _gate.Dispose();
    }
}

/// <summary>Opens pooled gateway connections (application "Rowlit").</summary>
public sealed class SnowflakeGatewayFactory(SnowflakeSecrets? secrets = null) : ISnowflakeGatewayFactory
{
    public async Task<ISnowflakeGateway> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var built = SnowflakeConnectionStrings.Build((secrets ?? SnowflakeSecrets.None).Hydrate(profile), password, pooling: true);
        var conn = await SnowflakeDriver.OpenAsync(built, ct).ConfigureAwait(false);
        return new SnowflakeGateway(conn);
    }
}
