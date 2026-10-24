using System.Data;
using System.Globalization;
using MySqlConnector;

namespace DbStudio.Providers.MySql;

/// <summary>Server flavor and version of one connection (MySQL and MariaDB differ in catalog, plans and logs).</summary>
public sealed record MySqlFlavor(bool IsMariaDb, int Major, int Minor, int Patch, string Version, string? Comment)
{
    public static readonly MySqlFlavor Unknown = new(false, 0, 0, 0, "", null);

    /// <summary>"8.4.3" / "11.4.2-MariaDB-ubu2404" + @@version_comment.</summary>
    public static MySqlFlavor From(string? version, string? comment)
    {
        var v = version ?? "";
        var maria = v.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) || (comment?.Contains("MariaDB", StringComparison.OrdinalIgnoreCase) ?? false);
        var (major, minor, patch) = MySqlSqlText.ParseVersion(v);
        return new MySqlFlavor(maria, major, minor, patch, v, comment);
    }

    public bool AtLeast(int major, int minor = 0, int patch = 0) =>
        (Major, Minor, Patch).CompareTo((major, minor, patch)) >= 0;

    public string Product => IsMariaDb ? "MariaDB" : "MySQL";

    /// <summary>"8.4.3" (MariaDB: "11.4.2").</summary>
    public string ProductVersion => $"{Major}.{Minor}.{Patch}";

    /// <summary>CHECK constraints are enforced and listed: MySQL 8.0.16+, MariaDB 10.2+.</summary>
    public bool HasCheckConstraints => IsMariaDb ? AtLeast(10, 2) : AtLeast(8, 0, 16);

    /// <summary>EXPLAIN ANALYZE (tree format): MySQL 8.0.18+. MariaDB has ANALYZE FORMAT=JSON instead.</summary>
    public bool HasExplainAnalyze => !IsMariaDb && AtLeast(8, 0, 18);

    /// <summary>information_schema.VIEW_TABLE_USAGE / VIEW_ROUTINE_USAGE: MySQL 8.0.13+.</summary>
    public bool HasViewUsage => !IsMariaDb && AtLeast(8, 0, 13);

    public bool HasSequences => IsMariaDb && AtLeast(10, 3);
}

/// <summary>ADO.NET helpers for metadata queries (named <c>@p0</c>, <c>@p1</c> … parameters).</summary>
internal static class MySqlDb
{
    public static MySqlCommand Command(MySqlConnection conn, string sql, params object?[] parameters)
    {
        var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandType = CommandType.Text;
        cmd.CommandTimeout = 0;
        for (var i = 0; i < parameters.Length; i++)
            cmd.Parameters.AddWithValue("@p" + i.ToString(CultureInfo.InvariantCulture), parameters[i] ?? DBNull.Value);
        return cmd;
    }

    public static async Task<List<T>> QueryAsync<T>(MySqlConnection conn, string sql, Func<MySqlDataReader, T> map, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await using var reader = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var list = new List<T>();
        while (await reader.ReadAsync(ct).ConfigureAwait(false)) list.Add(map(reader));
        return list;
    }

    public static async Task<object?> ScalarAsync(MySqlConnection conn, string sql, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        var v = await cmd.ExecuteScalarAsync(ct).ConfigureAwait(false);
        return v is DBNull ? null : v;
    }

    public static async Task ExecuteAsync(MySqlConnection conn, string sql, CancellationToken ct, params object?[] parameters)
    {
        await using var cmd = Command(conn, sql, parameters);
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Text of a cell (information_schema returns some columns as varbinary on old servers).</summary>
    public static string? Str(MySqlDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        return r.GetValue(i) switch
        {
            string s => s,
            byte[] b => System.Text.Encoding.UTF8.GetString(b),
            var v => Convert.ToString(v, CultureInfo.InvariantCulture),
        };
    }

    public static string S(MySqlDataReader r, int i) => Str(r, i) ?? "";

    public static long? Long(MySqlDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        var v = r.GetValue(i);
        return v switch
        {
            ulong ul => ul > long.MaxValue ? long.MaxValue : (long)ul,
            string s => long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p) ? p : null,
            byte[] b => long.TryParse(System.Text.Encoding.UTF8.GetString(b), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p2) ? p2 : null,
            _ => Convert.ToInt64(v, CultureInfo.InvariantCulture),
        };
    }

    public static int Int(MySqlDataReader r, int i, int fallback = 0) => (int?)Long(r, i) ?? fallback;

    public static bool Bool(MySqlDataReader r, int i)
    {
        if (r.IsDBNull(i)) return false;
        return r.GetValue(i) switch
        {
            bool b => b,
            string s => s is "1" or "YES" or "yes" or "Y" or "true" or "ON",
            byte[] bytes => bytes.Length > 0 && bytes[0] is (byte)'1' or (byte)'Y' or 1,
            var v => Convert.ToInt64(v, CultureInfo.InvariantCulture) != 0,
        };
    }

    public static DateTimeOffset? Time(MySqlDataReader r, int i)
    {
        if (r.IsDBNull(i)) return null;
        try
        {
            var v = r.GetValue(i);
            return v is DateTime dt && dt != DateTime.MinValue ? new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Utc)) : null;
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or MySqlConversionException)
        {
            return null;
        }
    }

    /// <summary>Server version, version comment, user, current database and connection id of an open connection.</summary>
    public static async Task<(MySqlFlavor Flavor, string? User, string? Database, long ConnectionId)> ServerFactsAsync(MySqlConnection conn, CancellationToken ct)
    {
        await using var cmd = Command(conn, "SELECT VERSION(), @@version_comment, CURRENT_USER(), DATABASE(), CONNECTION_ID()");
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        if (!await r.ReadAsync(ct).ConfigureAwait(false)) return (MySqlFlavor.From(conn.ServerVersion, null), null, conn.Database, conn.ServerThread);
        return (MySqlFlavor.From(Str(r, 0), Str(r, 1)), Str(r, 2), Str(r, 3), Long(r, 4) ?? conn.ServerThread);
    }

    /// <summary>Runs the profile's init statements (session variables, read-only) on a freshly opened connection.</summary>
    public static async Task InitializeAsync(MySqlConnection conn, Core.Models.ConnectionProfile profile, bool session, CancellationToken ct)
    {
        foreach (var sql in MySqlConnectionStrings.InitStatements(profile, session))
            await ExecuteAsync(conn, sql, ct).ConfigureAwait(false);
    }
}
