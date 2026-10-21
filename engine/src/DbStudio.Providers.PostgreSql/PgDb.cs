using System.Data;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>Small ADO.NET helpers for metadata queries (positional <c>$1</c> parameters, like the catalog SQL).</summary>
internal static class PgDb
{
    public static NpgsqlCommand Command(NpgsqlConnection conn, string sql, params object?[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.CommandTimeout = 0;
        foreach (var value in parameters)
        {
            cmd.Parameters.Add(value switch
            {
                null => new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Unknown },
                uint oid => new NpgsqlParameter { Value = oid, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Oid },
                string s => new NpgsqlParameter { Value = s, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text },
                _ => new NpgsqlParameter { Value = value },
            });
        }
        return cmd;
    }

    public static async Task<List<T>> QueryAsync<T>(NpgsqlConnection conn, string sql, Func<NpgsqlDataReader, T> map, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    public static async Task<object?> ScalarAsync(NpgsqlConnection conn, string sql, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is DBNull ? null : v;
    }

    public static async Task ExecuteAsync(NpgsqlConnection conn, string sql, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    public static string? Str(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : r.GetValue(i) switch
    {
        string s => s,
        char c => c.ToString(),
        var v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture),
    };

    public static bool Bool(NpgsqlDataReader r, int i) => !r.IsDBNull(i) && r.GetBoolean(i);

    public static uint Oid(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? 0 : r.GetFieldValue<uint>(i);

    public static int Int(NpgsqlDataReader r, int i, int fallback = 0) => r.IsDBNull(i) ? fallback : Convert.ToInt32(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);

    public static long? Long(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? null : Convert.ToInt64(r.GetValue(i), System.Globalization.CultureInfo.InvariantCulture);

    public static string[] Strings(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? [] : r.GetFieldValue<string[]>(i);

    /// <summary>A "char" column (relkind, contype, prokind …) as a one-letter string.</summary>
    public static string Char(NpgsqlDataReader r, int i) => r.IsDBNull(i) ? "" : r.GetValue(i) switch
    {
        char c => c.ToString(),
        string s => s,
        var v => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "",
    };
}
