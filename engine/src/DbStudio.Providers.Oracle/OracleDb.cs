using System.Data;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers.Oracle;

/// <summary>Small ODP.NET helpers for metadata queries. All commands bind by name.</summary>
internal static class OracleDb
{
    public static OracleCommand Command(OracleConnection conn, string sql, params (string Name, object? Value)[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.BindByName = true;
        cmd.CommandTimeout = 0;
        cmd.InitialLONGFetchSize = -1;   // DATA_DEFAULT, ALL_VIEWS.TEXT are LONG
        cmd.InitialLOBFetchSize = -1;    // DBMS_METADATA.GET_DDL returns a CLOB
        foreach (var (name, value) in parameters)
        {
            var p = new OracleParameter(name, value ?? DBNull.Value);
            if (value is string s) { p.OracleDbType = OracleDbType.Varchar2; p.Size = Math.Max(s.Length, 1); }
            cmd.Parameters.Add(p);
        }
        return cmd;
    }

    public static async Task<List<T>> QueryAsync<T>(OracleConnection conn, string sql, Func<OracleDataReader, T> map, CancellationToken ct,
        params (string Name, object? Value)[] parameters)
    {
        using var cmd = Command(conn, sql, parameters);
        await using var reg = ct.Register(static c => { try { ((OracleCommand)c!).Cancel(); } catch { /* best effort */ } }, cmd);
        using var reader = (OracleDataReader)await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    public static async Task<object?> ScalarAsync(OracleConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        using var cmd = Command(conn, sql, parameters);
        await using var reg = ct.Register(static c => { try { ((OracleCommand)c!).Cancel(); } catch { /* best effort */ } }, cmd);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is DBNull ? null : v;
    }

    public static async Task ExecuteAsync(OracleConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        using var cmd = Command(conn, sql, parameters);
        await using var reg = ct.Register(static c => { try { ((OracleCommand)c!).Cancel(); } catch { /* best effort */ } }, cmd);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    public static string? Str(IDataRecord r, int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);

    public static int? Int(IDataRecord r, int i) => r.IsDBNull(i) ? null : Convert.ToInt32(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);

    public static long? Long(IDataRecord r, int i) => r.IsDBNull(i) ? null : Convert.ToInt64(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);
}
