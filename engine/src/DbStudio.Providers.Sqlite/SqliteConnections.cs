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

    public const int Busy = 5, Locked = 6, Interrupt = 9;

    /// <summary>Busy timeout in seconds (prop "busyTimeout", default 30, at least 1: 0 means "forever" to the driver).</summary>
    public static int BusyTimeoutSeconds(ConnectionProfile profile) => Math.Max(1, profile.GetInt("busyTimeout", 30));

    /// <summary>SQLITE_BUSY / SQLITE_LOCKED (any extended code): another connection holds a conflicting lock.</summary>
    public static bool IsLockError(SqliteException e) => e.SqliteErrorCode is Busy or Locked;

    /// <summary>
    /// Ends the driver's busy-retry loop of a command waiting for a lock: Microsoft.Data.Sqlite re-reads CommandTimeout on
    /// every retry (sqlite3_interrupt alone is lost, each retry resets the statement), so 1 s makes it give up with
    /// SQLITE_BUSY at the next retry. Safe from any thread; a statement already past the lock is unaffected.
    /// </summary>
    public static void StopBusyWait(System.Data.Common.DbCommand command)
    {
        try { command.CommandTimeout = 1; } catch { /* disposed */ }
    }

    /// <summary>The profile is read-only: the profile flag (ConnectionProfile.ReadOnly) or the legacy prop "readOnly".</summary>
    public static bool IsReadOnly(ConnectionProfile profile, bool forceReadOnly = false) =>
        forceReadOnly || profile.ReadOnly || profile.GetBool("readOnly");

    /// <summary>
    /// Connection string of <paramref name="profile"/>. A read-only profile opens the file read-only (defense in depth: the
    /// driver refuses writes the engine guards miss), except a tab session (<paramref name="queryOnlyGuard"/>): it opens
    /// read-write and switches <c>PRAGMA query_only</c> on, so the explicit "Run with writes" override can lift it for one
    /// confirmed execution (<see cref="SqliteSession"/>).
    /// </summary>
    public static string BuildConnectionString(ConnectionProfile profile, bool forceReadOnly = false, bool queryOnlyGuard = false)
    {
        var path = ResolvePath(profile);
        if (path.Length == 0) throw new ArgumentException("The SQLite connection has no database file path.");
        // The "readOnly" prop always means a read-only file handle; the profile flag does too, except for guarded sessions.
        var readOnly = forceReadOnly || profile.GetBool("readOnly") || (profile.ReadOnly && !queryOnlyGuard);
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = path == MemoryPath ? SqliteOpenMode.Memory
                : readOnly ? SqliteOpenMode.ReadOnly
                : profile.GetBool("createIfMissing") ? SqliteOpenMode.ReadWriteCreate
                : SqliteOpenMode.ReadWrite,
            ForeignKeys = profile.GetBool("foreignKeys", true),
            Pooling = false, // one physical connection per tab; also keeps the file unlocked once closed
            DefaultTimeout = BusyTimeoutSeconds(profile),
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

    /// <summary>True when a tab session of <paramref name="profile"/> runs with the <c>PRAGMA query_only</c> guard (read-only profile on a file).</summary>
    public static bool UsesQueryOnlyGuard(ConnectionProfile profile) =>
        profile.ReadOnly && !profile.GetBool("readOnly") && ResolvePath(profile) != MemoryPath;

    /// <param name="queryOnlyGuard">Tab sessions: a read-only profile opens read-write with <c>PRAGMA query_only = ON</c> (see <see cref="BuildConnectionString"/>).</param>
    public static async Task<SqliteConnection> OpenAsync(ConnectionProfile profile, bool forceReadOnly, CancellationToken ct, bool queryOnlyGuard = false)
    {
        var path = ResolvePath(profile);
        if (path.Length == 0) throw new ArgumentException("The SQLite connection has no database file path.");
        var guard = queryOnlyGuard && !forceReadOnly && UsesQueryOnlyGuard(profile);
        // A file opened read-only must exist; a guarded session opens read-write (createIfMissing applies as before).
        var readOnly = forceReadOnly || profile.GetBool("readOnly") || (profile.ReadOnly && !guard);
        var mustExist = path != MemoryPath && (readOnly || !profile.GetBool("createIfMissing"));
        if (mustExist && !File.Exists(path))
            throw new FileNotFoundException($"Database file not found: {path}", path);

        var connection = new SqliteConnection(BuildConnectionString(profile, forceReadOnly, guard));
        try
        {
            await connection.OpenAsync(ct).ConfigureAwait(false);
            foreach (var (name, attachPath) in Attachments(profile))
            {
                if (attachPath != MemoryPath && !File.Exists(attachPath) && readOnly)
                    throw new FileNotFoundException($"Attached database file not found: {attachPath}", attachPath);
                await using var cmd = connection.CreateCommand();
                cmd.CommandText = $"ATTACH DATABASE $path AS {SqliteNames.Quote(name)}";
                cmd.Parameters.AddWithValue("$path", attachPath);
                await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
            }
            if (guard)
            {
                await using var pragma = connection.CreateCommand();
                pragma.CommandText = "PRAGMA query_only = ON";
                await pragma.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
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
