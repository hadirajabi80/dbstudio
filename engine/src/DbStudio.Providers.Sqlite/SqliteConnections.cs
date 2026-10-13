using DbStudio.Core.Models;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>Builds and opens SQLite connections from a <see cref="ConnectionProfile"/> (props: path, readOnly, createIfMissing, attach).</summary>
internal static class SqliteConnections
{
    public const string MemoryPath = ":memory:";

    public static string ResolvePath(ConnectionProfile profile)
    {
        var raw = profile.GetString("path")?.Trim().Trim('"') ?? "";
        return raw.Length == 0 ? "" : raw == MemoryPath ? raw : Path.GetFullPath(Environment.ExpandEnvironmentVariables(raw));
    }

    public static string BuildConnectionString(ConnectionProfile profile, bool forceReadOnly = false)
    {
        var path = ResolvePath(profile);
        if (path.Length == 0) throw new ArgumentException("The SQLite connection has no database file path.");
        var readOnly = forceReadOnly || profile.GetBool("readOnly");
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = path == MemoryPath ? SqliteOpenMode.Memory
                : readOnly ? SqliteOpenMode.ReadOnly
                : profile.GetBool("createIfMissing") ? SqliteOpenMode.ReadWriteCreate
                : SqliteOpenMode.ReadWrite,
            ForeignKeys = profile.GetBool("foreignKeys", true),
            Pooling = false, // one physical connection per tab; also keeps the file unlocked once closed
            DefaultTimeout = Math.Max(0, profile.GetInt("busyTimeout", 30)),
        };
        return builder.ToString();
    }

    /// <summary>Attached databases from the "attach" prop: entries "name=path" (list or comma separated).</summary>
    public static IReadOnlyList<(string Name, string Path)> Attachments(ConnectionProfile profile)
    {
        var result = new List<(string, string)>();
        foreach (var entry in profile.GetList("attach"))
        {
            var eq = entry.IndexOf('=');
            if (eq <= 0 || eq == entry.Length - 1) continue;
            var name = entry[..eq].Trim();
            var path = entry[(eq + 1)..].Trim().Trim('"');
            if (name.Length == 0 || path.Length == 0) continue;
            if (path != MemoryPath) path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
            result.Add((name, path));
        }
        return result;
    }

    public static async Task<SqliteConnection> OpenAsync(ConnectionProfile profile, bool forceReadOnly, CancellationToken ct)
    {
        var path = ResolvePath(profile);
        if (path.Length == 0) throw new ArgumentException("The SQLite connection has no database file path.");
        var mustExist = path != MemoryPath && (forceReadOnly || profile.GetBool("readOnly") || !profile.GetBool("createIfMissing"));
        if (mustExist && !File.Exists(path))
            throw new FileNotFoundException($"Database file not found: {path}", path);

        var connection = new SqliteConnection(BuildConnectionString(profile, forceReadOnly));
        try
        {
            await connection.OpenAsync(ct).ConfigureAwait(false);
            foreach (var (name, attachPath) in Attachments(profile))
            {
                if (attachPath != MemoryPath && !File.Exists(attachPath) && (forceReadOnly || profile.GetBool("readOnly")))
                    throw new FileNotFoundException($"Attached database file not found: {attachPath}", attachPath);
                await using var cmd = connection.CreateCommand();
                cmd.CommandText = $"ATTACH DATABASE $path AS {SqliteNames.Quote(name)}";
                cmd.Parameters.AddWithValue("$path", attachPath);
                await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            return connection;
        }
        catch
        {
            await connection.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }
}

internal static class SqliteNames
{
    public static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    /// <summary>Primary result code names (sqlite.org/rescode.html).</summary>
    public static string CodeName(int code) => (code & 0xFF) switch
    {
        0 => "SQLITE_OK", 1 => "SQLITE_ERROR", 2 => "SQLITE_INTERNAL", 3 => "SQLITE_PERM", 4 => "SQLITE_ABORT",
        5 => "SQLITE_BUSY", 6 => "SQLITE_LOCKED", 7 => "SQLITE_NOMEM", 8 => "SQLITE_READONLY", 9 => "SQLITE_INTERRUPT",
        10 => "SQLITE_IOERR", 11 => "SQLITE_CORRUPT", 12 => "SQLITE_NOTFOUND", 13 => "SQLITE_FULL", 14 => "SQLITE_CANTOPEN",
        15 => "SQLITE_PROTOCOL", 16 => "SQLITE_EMPTY", 17 => "SQLITE_SCHEMA", 18 => "SQLITE_TOOBIG", 19 => "SQLITE_CONSTRAINT",
        20 => "SQLITE_MISMATCH", 21 => "SQLITE_MISUSE", 22 => "SQLITE_NOLFS", 23 => "SQLITE_AUTH", 24 => "SQLITE_FORMAT",
        25 => "SQLITE_RANGE", 26 => "SQLITE_NOTADB", 27 => "SQLITE_NOTICE", 28 => "SQLITE_WARNING",
        _ => $"SQLITE_{code}",
    };

    /// <summary>"SQLite Error 1: 'no such table: x'." → "no such table: x".</summary>
    public static string CleanMessage(string message)
    {
        const string prefix = "SQLite Error ";
        if (!message.StartsWith(prefix, StringComparison.Ordinal)) return message;
        var colon = message.IndexOf(": '", StringComparison.Ordinal);
        if (colon < 0) return message;
        var inner = message[(colon + 3)..];
        if (inner.EndsWith("'.", StringComparison.Ordinal)) inner = inner[..^2];
        else if (inner.EndsWith('\'')) inner = inner[..^1];
        return inner;
    }
}
