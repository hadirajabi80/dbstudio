using System.Collections;
using System.Data;
using System.Data.Common;
using System.Globalization;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Wraps the driver's reader so that the bookkeeping result sets Snowflake returns for DML and DDL do not show up as grids:
/// <list type="bullet">
/// <item>DML: <c>number of rows inserted</c> / <c>updated</c> / <c>deleted</c> / <c>number of multi-joined rows updated</c> → rows
/// affected (<see cref="Counts"/>);</item>
/// <item>DDL, USE, GRANT, ALTER SESSION …: the single <c>status</c> column ("Table T successfully created.") → an info
/// message (<see cref="Statuses"/>).</item>
/// </list>
/// Hidden result sets report <see cref="FieldCount"/> 0 and no rows; every other result set passes through unchanged.
/// </summary>
public sealed class SnowflakeResultReader : DbDataReader
{
    private readonly DbDataReader _inner;
    private bool _hidden;

    /// <summary>Statement kind and count per hidden DML result ("INSERT", 3).</summary>
    public List<(string Kind, long Count)> Counts { get; } = [];

    /// <summary>Texts of the hidden status results.</summary>
    public List<string> Statuses { get; } = [];

    public SnowflakeResultReader(DbDataReader inner)
    {
        _inner = inner;
        Inspect();
    }

    public DbDataReader Inner => _inner;

    /// <summary>True when the column names are the DML bookkeeping columns ("number of rows inserted", …).</summary>
    public static bool IsCountResult(IReadOnlyList<string> names) =>
        names.Count > 0 && names.All(n => n.StartsWith("number of ", StringComparison.OrdinalIgnoreCase));

    public static bool IsStatusResult(IReadOnlyList<string> names) =>
        names.Count == 1 && names[0].Equals("status", StringComparison.OrdinalIgnoreCase);

    private void Inspect()
    {
        _hidden = false;
        int count;
        try { count = _inner.FieldCount; } catch (InvalidOperationException) { return; }
        if (count == 0) return;
        var names = new List<string>(count);
        for (var i = 0; i < count; i++) names.Add(_inner.GetName(i));
        if (IsCountResult(names))
        {
            _hidden = true;
            while (_inner.Read())
            {
                for (var i = 0; i < count; i++)
                {
                    if (_inner.IsDBNull(i)) continue;
                    var n = Convert.ToInt64(_inner.GetValue(i), CultureInfo.InvariantCulture);
                    var name = names[i].ToLowerInvariant();
                    var kind = name.Contains("inserted", StringComparison.Ordinal) ? "INSERT"
                        : name.Contains("multi-joined", StringComparison.Ordinal) ? null
                        : name.Contains("updated", StringComparison.Ordinal) ? "UPDATE"
                        : name.Contains("deleted", StringComparison.Ordinal) ? "DELETE"
                        : name.Contains("unloaded", StringComparison.Ordinal) ? "COPY"
                        : name.Contains("loaded", StringComparison.Ordinal) ? "COPY" : null;
                    if (kind is not null) Counts.Add((kind, n));
                }
            }
        }
        else if (IsStatusResult(names))
        {
            _hidden = true;
            while (_inner.Read())
            {
                if (!_inner.IsDBNull(0)) Statuses.Add(Convert.ToString(_inner.GetValue(0), CultureInfo.InvariantCulture) ?? "");
            }
        }
    }

    public override bool NextResult()
    {
        if (!_inner.NextResult()) return false;
        Inspect();
        return true;
    }

    public override async Task<bool> NextResultAsync(CancellationToken cancellationToken)
    {
        if (!await _inner.NextResultAsync(cancellationToken).ConfigureAwait(false)) return false;
        Inspect();
        return true;
    }

    public override bool Read() => !_hidden && _inner.Read();

    public override Task<bool> ReadAsync(CancellationToken cancellationToken) =>
        _hidden ? Task.FromResult(false) : _inner.ReadAsync(cancellationToken);

    public override int FieldCount => _hidden ? 0 : _inner.FieldCount;
    public override int VisibleFieldCount => FieldCount;
    public override bool HasRows => !_hidden && _inner.HasRows;
    public override int RecordsAffected => _inner.RecordsAffected;
    public override bool IsClosed => _inner.IsClosed;
    public override int Depth => _inner.Depth;
    public override object this[int ordinal] => _inner[ordinal];
    public override object this[string name] => _inner[name];
    public override bool GetBoolean(int ordinal) => _inner.GetBoolean(ordinal);
    public override byte GetByte(int ordinal) => _inner.GetByte(ordinal);
    public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => _inner.GetBytes(ordinal, dataOffset, buffer, bufferOffset, length);
    public override char GetChar(int ordinal) => _inner.GetChar(ordinal);
    public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length) => _inner.GetChars(ordinal, dataOffset, buffer, bufferOffset, length);
    public override string GetDataTypeName(int ordinal) => _inner.GetDataTypeName(ordinal);
    public override DateTime GetDateTime(int ordinal) => _inner.GetDateTime(ordinal);
    public override decimal GetDecimal(int ordinal) => _inner.GetDecimal(ordinal);
    public override double GetDouble(int ordinal) => _inner.GetDouble(ordinal);
    public override Type GetFieldType(int ordinal) => _inner.GetFieldType(ordinal);
    public override float GetFloat(int ordinal) => _inner.GetFloat(ordinal);
    public override Guid GetGuid(int ordinal) => _inner.GetGuid(ordinal);
    public override short GetInt16(int ordinal) => _inner.GetInt16(ordinal);
    public override int GetInt32(int ordinal) => _inner.GetInt32(ordinal);
    public override long GetInt64(int ordinal) => _inner.GetInt64(ordinal);
    public override string GetName(int ordinal) => _inner.GetName(ordinal);
    public override int GetOrdinal(string name) => _inner.GetOrdinal(name);
    public override string GetString(int ordinal) => _inner.GetString(ordinal);
    public override object GetValue(int ordinal) => _inner.GetValue(ordinal);
    public override int GetValues(object[] values) => _inner.GetValues(values);
    public override bool IsDBNull(int ordinal) => _inner.IsDBNull(ordinal);
    public override DataTable? GetSchemaTable() => _hidden ? null : _inner.GetSchemaTable();
    public override IEnumerator GetEnumerator() => ((IEnumerable)_inner).GetEnumerator();
    public override void Close() => _inner.Close();

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _inner.DisposeAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }
}
