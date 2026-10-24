using System.Data.Common;
using System.Globalization;
using ClickHouse.Driver.ADO;
using ClickHouse.Driver.ADO.Parameters;

namespace DbStudio.Providers.ClickHouse;

/// <summary>Metadata query helpers: <c>{name:String}</c> parameters (values are never concatenated into SQL).</summary>
internal static class ChDb
{
    public static ClickHouseCommand Command(ClickHouseConnection conn, string sql, params (string Name, object? Value)[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            var (type, v) = value switch
            {
                null => ("Nullable(String)", (object)DBNull.Value),
                long l => ("Int64", l),
                int i => ("Int64", (long)i),
                bool b => ("Bool", b),
                IEnumerable<string> list => ("Array(String)", list.ToArray()),
                _ => ("String", (object)Convert.ToString(value, CultureInfo.InvariantCulture)!),
            };
            cmd.Parameters.Add(new ClickHouseDbParameter { ParameterName = name, ClickHouseType = type, Value = v });
        }
        return cmd;
    }

    public static async Task<List<T>> QueryAsync<T>(ClickHouseConnection conn, string sql, Func<DbDataReader, T> map, CancellationToken ct,
        params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    public static async Task<object?> ScalarAsync(ClickHouseConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is DBNull ? null : v;
    }

    public static async Task ExecuteAsync(ClickHouseConnection conn, string sql, CancellationToken ct, params (string Name, object? Value)[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    public static string? Str(DbDataReader r, int i) => r.IsDBNull(i) ? null : r.GetValue(i) switch
    {
        string s => s,
        var v => Convert.ToString(v, CultureInfo.InvariantCulture),
    };

    public static string S(DbDataReader r, int i) => Str(r, i) ?? "";

    public static long? Long(DbDataReader r, int i) => r.IsDBNull(i) ? null : r.GetValue(i) switch
    {
        System.Numerics.BigInteger b => (long)b,
        ulong u => u > long.MaxValue ? long.MaxValue : (long)u,
        var v => Convert.ToInt64(v, CultureInfo.InvariantCulture),
    };

    public static bool Bool(DbDataReader r, int i) => !r.IsDBNull(i) && r.GetValue(i) switch
    {
        bool b => b,
        var v => Convert.ToInt64(v, CultureInfo.InvariantCulture) != 0,
    };

    /// <summary>A DateTime column (server time zone) as an offset value; ClickHouse returns UTC-normalized wall time per column tz.</summary>
    public static DateTimeOffset? Time(DbDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        return r.GetValue(i) switch
        {
            DateTime dt when dt.Year <= 1970 && dt.DayOfYear == 1 && dt.TimeOfDay == TimeSpan.Zero => null,
            DateTime dt => new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified), TimeSpan.Zero),
            DateTimeOffset dto => dto,
            _ => null,
        };
    }

    public static string? Iso(DbDataReader r, int i) =>
        Time(r, i)?.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}
