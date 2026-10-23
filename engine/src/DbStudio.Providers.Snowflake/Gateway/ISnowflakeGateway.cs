using DbStudio.Core.Models;
using DbStudio.Logs.Sql;

namespace DbStudio.Providers.Snowflake.Gateway;

/// <summary>
/// The seam between the Snowflake metadata code and the server (plan-batch3 D10): every catalog, DDL, dependency, object
/// list, search, designer-read and module read goes through <see cref="QueryAsync"/> with plain SQL text (mostly SHOW
/// commands, which need no running warehouse) and gets a <see cref="SqlRowSet"/> back. The real implementation runs on a
/// pooled Snowflake.Data connection; tests replay recorded JSON fixtures (<c>SnowflakeGatewayFake</c>).
/// </summary>
public interface ISnowflakeGateway : IAsyncDisposable
{
    /// <summary>Runs one statement and returns its result (columns as the server names them; cells are plain values:
    /// strings, longs, decimals, doubles, bools, DateTime/DateTimeOffset). Server errors throw <see cref="SnowflakeQueryException"/>.</summary>
    Task<SqlRowSet> QueryAsync(string sql, CancellationToken ct);

    /// <summary>Runs one statement with numeric binds (<c>:1</c>, <c>:2</c> … in the text).</summary>
    Task<SqlRowSet> QueryAsync(string sql, IReadOnlyList<object?> binds, CancellationToken ct);

    /// <summary>Runs a statement for its side effect (USE, ALTER WAREHOUSE … RESUME, SYSTEM$CANCEL_QUERY).</summary>
    Task ExecuteAsync(string sql, CancellationToken ct);
}

/// <summary>Opens gateways for a connection profile (the real one logs in; tests return fakes).</summary>
public interface ISnowflakeGatewayFactory
{
    Task<ISnowflakeGateway> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct);
}

/// <summary>A server error of a gateway query: the Snowflake error code (e.g. 2003 "does not exist or not authorized"), SQLSTATE and query id.</summary>
public sealed class SnowflakeQueryException(string message, int errorCode, string? sqlState, string? queryId, Exception? inner = null)
    : Exception(message, inner)
{
    public int ErrorCode { get; } = errorCode;
    public string? SqlState { get; } = sqlState;
    public string? QueryId { get; } = queryId;

    /// <summary>002003: object does not exist or not authorized; 003001/003540: insufficient privileges.</summary>
    public bool IsNotFoundOrDenied => ErrorCode is 2003 or 2043;
    public bool IsPrivilege => ErrorCode is 3001 or 3540 or 3041 || Message.Contains("insufficient privileges", StringComparison.OrdinalIgnoreCase);
    /// <summary>000606: no active warehouse (INFORMATION_SCHEMA / table functions need one).</summary>
    public bool IsNoWarehouse => ErrorCode == 606 || Message.Contains("No active warehouse", StringComparison.OrdinalIgnoreCase);

    public ErrorInfo ToError() => new(SnowflakeErrors.Code(ErrorCode), Message, Detail: QueryId is null ? SqlState : $"query id {QueryId}", ProviderCode: ErrorCode);
}
