namespace DbStudio.Core.Services;

/// <summary>
/// User-facing wording for a statement that gave up waiting for a lock held by another connection (SQLite
/// SQLITE_BUSY/SQLITE_LOCKED after the busy timeout). Providers report <see cref="Message"/>; the services that know
/// the open sessions (executions, designer apply) name the blocking ones with <see cref="Describe"/>.
/// </summary>
public static class LockWait
{
    /// <summary>Base message, without the blocking sessions.</summary>
    public const string Message = "Database is locked by another session";

    /// <summary>Provider error codes that mean "gave up waiting for a lock".</summary>
    public static bool IsLockError(string? code) => code is "SQLITE_BUSY" or "SQLITE_LOCKED";

    /// <summary>
    /// "Database is locked by another session: Console 1 (open transaction). Commit or roll back there, then run again."
    /// With no known holder (another process or application): "... another session or application."
    /// </summary>
    public static string Describe(IReadOnlyList<string> holders) => holders.Count == 0
        ? Message + " or application. Wait for it to finish (or end its transaction), then run again."
        : $"{Message}: {string.Join(", ", holders)}. Commit or roll back there, then run again.";
}
