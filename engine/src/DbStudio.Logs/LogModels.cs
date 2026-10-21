using System.Globalization;
using System.Text.Json.Serialization;

namespace DbStudio.Logs;

// Wire model of the logs and activity package (docs/PLAN-M2.md 8.1; mirrors ui/src/api/types.m2.ts "Logs & activity").
// Optional members are omitted when null so the UI's optional TS fields stay undefined.

/// <summary>Item of <c>GET /logs/{cid}/sources</c>.</summary>
/// <param name="Kind">"log" | "activity".</param>
/// <param name="Needs">Privilege hint: the exact statement to ask a DBA for (also set as a hint on available sources).</param>
/// <param name="Reason">Why the source is unavailable, or a hint for an available one.</param>
public sealed record LogSourceInfo(
    string Id,
    string Title,
    string Kind,
    bool SupportsTail,
    bool SupportsRange,
    IReadOnlyList<string> Levels,
    bool Available,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Needs = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Reason = null)
{
    /// <summary>SQL Server error log files (<c>sp_enumerrorlogs</c>); index 0 is the current file.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<LogArchiveInfo>? Archives { get; init; }

    public LogSourceInfo Unavailable(string reason, string? needs) => this with { Available = false, Reason = reason, Needs = needs ?? Needs };
}

public sealed record LogArchiveInfo(int Index, string? Date, long SizeBytes);

/// <summary>One log line. <see cref="Seq"/> is monotonic per source (natural id, byte position or timestamp based).</summary>
/// <param name="Level">debug | info | warn | error | fatal | unknown.</param>
public sealed record LogEntry(
    string? Ts,
    string Level,
    string Source,
    string Message,
    long Seq,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Detail = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyDictionary<string, string>? Fields = null)
{
    /// <summary>Parsed <see cref="Ts"/> (null when the source has no time).</summary>
    [JsonIgnore]
    public DateTimeOffset? Time => Ts is not null && DateTimeOffset.TryParse(Ts, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
}

/// <summary>Body of <c>POST /logs/{cid}/query</c> (and of the export request).</summary>
/// <param name="Limit">1..5000 (0 = default 1000).</param>
/// <param name="Before">Only entries with seq &lt; before (paging to older entries).</param>
/// <param name="After">Engine-internal (tail cursor): only entries with seq &gt; after.</param>
/// <param name="Archive">SQL Server error log file index (0 = current).</param>
public sealed record LogQuery(
    string? SourceId,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null,
    IReadOnlyList<string>? Levels = null,
    string? Q = null,
    int Limit = 0,
    long? Before = null,
    long? After = null,
    int? Archive = null);

/// <param name="Entries">Ascending by seq: the newest <c>limit</c> entries matching the query.</param>
/// <param name="HasMore">Older matching entries exist (page with <c>before = entries[0].seq</c>).</param>
/// <param name="Truncated">The source's own window was capped (e.g. getLog keeps 1024 lines, read budget hit).</param>
public sealed record LogQueryResponse(IReadOnlyList<LogEntry> Entries, bool HasMore, bool Truncated);

/// <summary>One row of the Activity view (a session, a running operation, a lock summary or a Redis client).</summary>
/// <param name="Kind">session | op | lock | client.</param>
public sealed record ActivityRow
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? User { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Host { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? App { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Database { get; init; }
    public required string State { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Since { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? DurationMs { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? WaitType { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? BlockedBy { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Command { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Text { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Cpu { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Reads { get; init; }
    public bool CanKill { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public IReadOnlyDictionary<string, string>? Fields { get; init; }
}

/// <summary><c>activity.poll</c> stream item and <c>GET /logs/{cid}/activity</c> response.</summary>
public sealed record ActivitySnapshot(string Ts, IReadOnlyList<ActivityRow> Sessions);

/// <summary>Body of <c>POST /logs/{cid}/kill</c>. <paramref name="Mode"/>: PostgreSQL "cancel" | "terminate" (default).</summary>
public sealed record LogKillRequest(string? Id, string? Kind, string? Mode = null);

public sealed record LogKillResult(bool Killed, string? Message);

/// <summary>Body of <c>POST /logs/{cid}/export</c>: the query, a format and the target path (null = respond with the file).</summary>
public sealed record LogExportRequest(
    string? SourceId,
    DateTimeOffset? From = null,
    DateTimeOffset? To = null,
    IReadOnlyList<string>? Levels = null,
    string? Q = null,
    int Limit = 0,
    long? Before = null,
    int? Archive = null,
    string? Format = null,
    string? Path = null)
{
    public LogQuery ToQuery() => new(SourceId, From, To, Levels, Q, Limit, Before, null, Archive);
}

/// <summary><c>job.done.result</c> of a log export.</summary>
public sealed record LogExportResult(string? Path, int Entries);

/// <summary>Level tokens and helpers.</summary>
public static class LogLevels
{
    public const string Debug = "debug", Info = "info", Warn = "warn", Error = "error", Fatal = "fatal", Unknown = "unknown";

    public static readonly IReadOnlyList<string> All = [Debug, Info, Warn, Error, Fatal];

    /// <summary>Levels a source can emit for the level chips (fatal is grouped with error by the UI).</summary>
    public static readonly IReadOnlyList<string> Standard = [Debug, Info, Warn, Error, Fatal];

    public static bool IsKnown(string level) => level is Debug or Info or Warn or Error or Fatal or Unknown;

    /// <summary>
    /// True when <paramref name="level"/> passes the filter. An empty filter passes everything; "unknown" always passes;
    /// "error" also selects "fatal" (one chip in the UI).
    /// </summary>
    public static bool Matches(string level, IReadOnlyCollection<string>? filter)
    {
        if (filter is null || filter.Count == 0) return true;
        if (level == Unknown) return true;
        if (filter.Contains(level)) return true;
        return level == Fatal && filter.Contains(Error);
    }

    public static string Normalize(string? level) => level?.Trim().ToLowerInvariant() switch
    {
        "debug" or "dbg" or "trace" or "verbose" or "vrb" => Debug,
        "info" or "inf" or "information" or "notice" or "log" => Info,
        "warn" or "wrn" or "warning" => Warn,
        "error" or "err" => Error,
        "fatal" or "ftl" or "panic" or "critical" => Fatal,
        _ => Unknown,
    };
}

/// <summary>Builds timestamp-based sequence numbers: unix ms × 1000 + an ordinal for entries in the same millisecond.</summary>
public sealed class TimeSeq
{
    private long _lastMs = long.MinValue;
    private int _ordinal;

    public const long Factor = 1000;

    /// <summary>Entries must be fed in ascending time order; returns a strictly increasing value.</summary>
    public long Next(DateTimeOffset? ts)
    {
        var ms = ts?.ToUnixTimeMilliseconds() ?? 0;
        if (ms < _lastMs) ms = _lastMs; // out-of-order source lines keep the order they came in
        if (ms == _lastMs) _ordinal = Math.Min(_ordinal + 1, (int)Factor - 1);
        else
        {
            _lastMs = ms;
            _ordinal = 0;
        }
        return ms * Factor + _ordinal;
    }

    /// <summary>The time a seq stands for (lower bound of its millisecond).</summary>
    public static DateTimeOffset ToTime(long seq) => DateTimeOffset.FromUnixTimeMilliseconds(Math.Max(0, seq / Factor));

    public static string Iso(DateTimeOffset t) => t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}
