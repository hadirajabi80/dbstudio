using System.Collections;
using System.Collections.ObjectModel;
using System.Data.Common;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>
/// A data reader over the statements of one batch, executed one after the other on the session connection: every
/// statement's result sets appear in order through <see cref="NextResultAsync"/>; between statements the reader records
/// the statement's rows affected and runs <c>afterStatement</c> (SHOW WARNINGS). <see cref="Index"/> always names the
/// statement executing (or the one that failed), so errors map to the right statement and line.
/// </summary>
internal sealed class MySqlStatementReader : DbDataReader, IDbColumnSchemaGenerator
{
    private readonly Func<int, CancellationToken, Task<MySqlDataReader>> _execute;
    private readonly Func<int, Task> _afterStatement;
    private readonly int _count;
    private MySqlDataReader? _current;
    private bool _closed;

    private MySqlStatementReader(int count, Func<int, CancellationToken, Task<MySqlDataReader>> execute, Func<int, Task> afterStatement)
    {
        _count = count;
        _execute = execute;
        _afterStatement = afterStatement;
        Affected = Enumerable.Repeat(-1L, count).ToArray();
    }

    /// <summary>Rows affected per statement (-1 = not run / not applicable).</summary>
    public long[] Affected { get; }

    /// <summary>The statement executing now, or the one that raised the last error.</summary>
    public int Index { get; private set; }

    public MySqlDataReader Current => _current ?? throw new InvalidOperationException("No statement is executing.");

    /// <summary>Executes the first statement; <paramref name="onIndex"/> learns every statement index before it runs.</summary>
    public static async Task<MySqlStatementReader> OpenAsync(int count, Func<int, CancellationToken, Task<MySqlDataReader>> execute, Func<int, Task> afterStatement,
        CancellationToken ct)
    {
        var reader = new MySqlStatementReader(count, execute, afterStatement);
        reader._current = await execute(0, ct).ConfigureAwait(false);
        return reader;
    }

    private async Task FinishCurrentAsync()
    {
        var current = _current;
        if (current is null) return;
        _current = null;
        await current.CloseAsync().ConfigureAwait(false);
        Affected[Index] = current.RecordsAffected;
        await current.DisposeAsync().ConfigureAwait(false);
        await _afterStatement(Index).ConfigureAwait(false);
    }

    public override async Task<bool> NextResultAsync(CancellationToken cancellationToken)
    {
        if (_current is null) return false;
        if (await _current.NextResultAsync(cancellationToken).ConfigureAwait(false)) return true;
        await FinishCurrentAsync().ConfigureAwait(false);
        if (Index + 1 >= _count) return false;
        Index++;
        _current = await _execute(Index, cancellationToken).ConfigureAwait(false);
        return true;
    }

    public override bool NextResult() => NextResultAsync(CancellationToken.None).GetAwaiter().GetResult();

    public override async Task CloseAsync()
    {
        if (_closed) return;
        _closed = true;
        await FinishCurrentAsync().ConfigureAwait(false);
    }

    public override void Close() => CloseAsync().GetAwaiter().GetResult();

    public override async ValueTask DisposeAsync()
    {
        _closed = true;
        var current = _current;
        _current = null;
        if (current is not null)
        {
            try { await current.DisposeAsync().ConfigureAwait(false); } catch (Exception ex) when (ex is MySqlException or InvalidOperationException or IOException) { }
        }
        await base.DisposeAsync().ConfigureAwait(false);
    }

    public override int RecordsAffected
    {
        get
        {
            var sum = -1L;
            foreach (var a in Affected) if (a >= 0) sum = Math.Max(0, sum) + a;
            if (_current is { RecordsAffected: >= 0 } c) sum = Math.Max(0, sum) + c.RecordsAffected;
            return (int)Math.Min(int.MaxValue, sum);
        }
    }

    public override Task<bool> ReadAsync(CancellationToken cancellationToken) => _current is null ? Task.FromResult(false) : _current.ReadAsync(cancellationToken);
    public override bool Read() => _current?.Read() ?? false;
    public override int FieldCount => _current?.FieldCount ?? 0;
    public override bool HasRows => _current?.HasRows ?? false;
    public override bool IsClosed => _closed;
    public override int Depth => 0;
    public override object this[int ordinal] => Current[ordinal];
    public override object this[string name] => Current[name];
    public override bool GetBoolean(int ordinal) => Current.GetBoolean(ordinal);
    public override byte GetByte(int ordinal) => Current.GetByte(ordinal);
    public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => Current.GetBytes(ordinal, dataOffset, buffer, bufferOffset, length);
    public override char GetChar(int ordinal) => Current.GetChar(ordinal);
    public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length) => Current.GetChars(ordinal, dataOffset, buffer, bufferOffset, length);
    public override string GetDataTypeName(int ordinal) => Current.GetDataTypeName(ordinal);
    public override DateTime GetDateTime(int ordinal) => Current.GetDateTime(ordinal);
    public override decimal GetDecimal(int ordinal) => Current.GetDecimal(ordinal);
    public override double GetDouble(int ordinal) => Current.GetDouble(ordinal);
    public override Type GetFieldType(int ordinal) => Current.GetFieldType(ordinal);
    public override float GetFloat(int ordinal) => Current.GetFloat(ordinal);
    public override Guid GetGuid(int ordinal) => Current.GetGuid(ordinal);
    public override short GetInt16(int ordinal) => Current.GetInt16(ordinal);
    public override int GetInt32(int ordinal) => Current.GetInt32(ordinal);
    public override long GetInt64(int ordinal) => Current.GetInt64(ordinal);
    public override string GetName(int ordinal) => Current.GetName(ordinal);
    public override int GetOrdinal(string name) => Current.GetOrdinal(name);
    public override string GetString(int ordinal) => Current.GetString(ordinal);
    public override object GetValue(int ordinal) => Current.GetValue(ordinal);
    public override int GetValues(object[] values) => Current.GetValues(values);
    public override bool IsDBNull(int ordinal) => Current.IsDBNull(ordinal);
    public override IEnumerator GetEnumerator() => new DbEnumerator(this);
    public ReadOnlyCollection<DbColumn> GetColumnSchema() => Current.GetColumnSchema();
}
