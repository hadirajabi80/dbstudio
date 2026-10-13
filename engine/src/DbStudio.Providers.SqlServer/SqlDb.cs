using System.Data;
using Microsoft.Data.SqlClient;

namespace DbStudio.Providers.SqlServer;

/// <summary>Small ADO.NET helpers for metadata queries.</summary>
internal static class SqlDb
{
    public static SqlCommand Command(SqlConnection conn, string sql, params (string Name, object? Value)[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.CommandTimeout = 0;
        foreach (var (name, value) in parameters)
        {
            var p = cmd.CreateParameter();
            p.ParameterName = name;
            switch (value)
            {
                case string s:
                    p.SqlDbType = SqlDbType.NVarChar;
                    p.Size = Math.Max(s.Length, 128);
                    p.Value = s;
                    break;
                default:
                    p.Value = value ?? DBNull.Value;
                    break;
            }
            cmd.Parameters.Add(p);
        }
        return cmd;
    }

    public static async Task<List<T>> QueryAsync<T>(SqlConnection conn, string sql, Func<SqlDataReader, T> map, CancellationToken ct,
        params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    public static async Task<T?> ScalarAsync<T>(SqlConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is null or DBNull ? default : (T)v;
    }

    public static async Task ExecuteAsync(SqlConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    public static string? Str(IDataRecord r, int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));

    public static bool Bool(IDataRecord r, int i) => !r.IsDBNull(i) && r.GetBoolean(i);
}
