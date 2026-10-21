using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;

namespace DbStudio.Logs;

/// <summary>
/// The engine's own Serilog files (<c>engine-yyyyMMdd.log</c>, <c>engine-yyyyMMdd_001.log</c> under AppPaths.LogsDir;
/// template <c>{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}</c>).
/// Served under <c>cid = "engine"</c>, source id <c>engine</c>. Seq = file key × 2^31 + byte offset of the entry, so the
/// tail cursor resumes exactly where it stopped, even across the daily roll.
/// </summary>
public sealed partial class EngineLogSource(string logsDir)
{
    public const string SourceId = "engine";
    public const long FileFactor = 1L << 31;

    public int ChunkBytes { get; init; } = 256 * 1024;
    public long ReadBudgetBytes { get; init; } = 32L << 20;

    public string LogsDir { get; } = logsDir;

    public static LogSourceInfo Info { get; } = new(SourceId, "Engine log", "log", true, true, LogLevels.Standard, true);

    [GeneratedRegex(@"^engine-(?<d>\d{8})(?:_(?<n>\d{3}))?\.log$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex FileName();

    [GeneratedRegex(@"^(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)(?: (?<tz>[+-]\d{2}:\d{2}))? \[(?<lvl>VRB|DBG|INF|WRN|ERR|FTL)\] (?<rest>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex EntryLine();

    /// <summary>A log file with its ordering key (days since 2020-01-01 × 64 + roll index).</summary>
    public sealed record LogFile(string Path, long Key);

    public static long? KeyOf(string fileName)
    {
        var m = FileName().Match(fileName);
        if (!m.Success || !DateTime.TryParseExact(m.Groups["d"].Value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)) return null;
        var n = m.Groups["n"].Success ? int.Parse(m.Groups["n"].Value, CultureInfo.InvariantCulture) : 0;
        return (long)(day - new DateTime(2020, 1, 1)).TotalDays * 64 + Math.Min(n, 63); // < 2^53 / 2^31 for centuries
    }

    /// <summary>Log files, oldest first.</summary>
    public IReadOnlyList<LogFile> Files()
    {
        if (!Directory.Exists(LogsDir)) return [];
        return Directory.EnumerateFiles(LogsDir, "engine-*.log")
            .Select(p => (p, k: KeyOf(Path.GetFileName(p))))
            .Where(x => x.k is not null).OrderBy(x => x.k).Select(x => new LogFile(x.p, x.k!.Value)).ToList();
    }

    public static string LevelOf(string u3) => u3 switch
    {
        "VRB" or "DBG" => LogLevels.Debug,
        "INF" => LogLevels.Info,
        "WRN" => LogLevels.Warn,
        "ERR" => LogLevels.Error,
        "FTL" => LogLevels.Fatal,
        _ => LogLevels.Unknown,
    };

    public static bool IsEntryStart(string line) => line.Length > 24 && char.IsDigit(line[0]) && EntryLine().IsMatch(line);

    /// <summary>
    /// Parses a block of whole entries. <paramref name="baseOffset"/> is the byte position of <paramref name="data"/>[0] in
    /// its file; leading continuation lines without a header are ignored.
    /// </summary>
    public static List<LogEntry> ParseBlock(byte[] data, long baseOffset, long fileKey)
    {
        var list = new List<LogEntry>();
        string? ts = null, level = null, ctx = null;
        StringBuilder? msg = null, detail = null;
        long start = 0;
        void Flush()
        {
            if (msg is null) return;
            list.Add(new LogEntry(ts, level!, ctx!, msg.ToString(), fileKey * FileFactor + start,
                detail is { Length: > 0 } ? detail.ToString().TrimEnd() : null));
            msg = null;
            detail = null;
        }
        var pos = 0;
        while (pos < data.Length)
        {
            var nl = Array.IndexOf(data, (byte)'\n', pos);
            var end = nl < 0 ? data.Length : nl;
            var line = Encoding.UTF8.GetString(data, pos, end - pos).TrimEnd('\r');
            var m = line.Length > 24 && char.IsDigit(line[0]) ? EntryLine().Match(line) : Match.Empty;
            if (m.Success)
            {
                Flush();
                start = baseOffset + pos;
                var parsed = DateTime.ParseExact(m.Groups["ts"].Value, ["yyyy-MM-dd HH:mm:ss.fff", "yyyy-MM-dd HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None);
                var offset = m.Groups["tz"].Success ? TimeSpan.Parse(m.Groups["tz"].Value.TrimStart('+'), CultureInfo.InvariantCulture) : TimeSpan.Zero;
                ts = TimeSeq.Iso(new DateTimeOffset(parsed, offset));
                level = LevelOf(m.Groups["lvl"].Value);
                var rest = m.Groups["rest"].Value;
                var colon = rest.IndexOf(": ", StringComparison.Ordinal);
                var space = rest.IndexOf(' ');
                if (colon >= 0 && (space < 0 || colon < space))
                {
                    var full = rest[..colon];
                    ctx = full.Length == 0 ? "engine" : full[(full.LastIndexOf('.') + 1)..];
                    msg = new StringBuilder(rest[(colon + 2)..]);
                }
                else
                {
                    ctx = "engine";
                    msg = new StringBuilder(rest);
                }
            }
            else if (msg is not null && line.Length > 0)
            {
                (detail ??= new StringBuilder()).Append(line).Append('\n');
            }
            pos = end + 1;
        }
        Flush();
        return list;
    }

    private static FileStream OpenShared(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.None);

    private static byte[] ReadRange(FileStream fs, long start, int count)
    {
        var buf = new byte[count];
        fs.Seek(start, SeekOrigin.Begin);
        var done = 0;
        while (done < count)
        {
            var n = fs.Read(buf, done, count - done);
            if (n == 0) break;
            done += n;
        }
        return done == count ? buf : buf[..done];
    }

    public Task<LogQueryResponse> QueryAsync(LogQuery query, CancellationToken ct)
    {
        if (query.SourceId != SourceId) throw Providers.SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
        return Task.FromResult(query.After is { } after ? ReadForward(query, after, ct) : ReadBackward(query, ct));
    }

    /// <summary>Tail: everything after the cursor (same file from the cursor's offset, then newer files).</summary>
    private LogQueryResponse ReadForward(LogQuery query, long after, CancellationToken ct)
    {
        var key = after / FileFactor;
        var offset = after % FileFactor;
        var entries = new List<LogEntry>();
        foreach (var f in Files().Where(f => f.Key >= key))
        {
            ct.ThrowIfCancellationRequested();
            using var fs = OpenShared(f.Path);
            var start = f.Key == key ? offset : 0;
            if (start >= fs.Length) continue;
            var length = (int)Math.Min(fs.Length - start, ReadBudgetBytes);
            var data = ReadRange(fs, start, length);
            // Keep only whole lines: the writer may be in the middle of one.
            var lastNl = Array.LastIndexOf(data, (byte)'\n');
            if (lastNl < 0) continue;
            entries.AddRange(ParseBlock(data[..(lastNl + 1)], start, f.Key));
        }
        // The entry at the cursor itself (seq == after) is excluded by LogFilter.
        return LogFilter.Page(entries, query);
    }

    private LogQueryResponse ReadBackward(LogQuery query, CancellationToken ct)
    {
        var limit = LogFilter.LimitOf(query);
        var files = Files().Reverse().ToList();
        var collected = new List<LogEntry>();
        long budget = ReadBudgetBytes;
        var truncated = false;
        foreach (var f in files)
        {
            if (query.Before is { } b && f.Key > b / FileFactor) continue;
            using var fs = OpenShared(f.Path);
            var pos = fs.Length;
            if (query.Before is { } before && before / FileFactor == f.Key) pos = Math.Min(pos, before % FileFactor);
            // Drop a partially written last line.
            var tail = ReadRange(fs, Math.Max(0, pos - 4096), (int)Math.Min(4096, pos));
            var lastNl = Array.LastIndexOf(tail, (byte)'\n');
            if (pos == fs.Length && lastNl >= 0) pos = Math.Max(0, pos - 4096) + lastNl + 1;
            byte[] carry = [];
            var stop = false;
            while (pos > 0 || carry.Length > 0)
            {
                ct.ThrowIfCancellationRequested();
                if (budget <= 0) { truncated = true; stop = true; break; }
                var start = Math.Max(0, pos - ChunkBytes);
                var chunk = pos > start ? ReadRange(fs, start, (int)(pos - start)) : [];
                budget -= chunk.Length;
                var data = carry.Length == 0 ? chunk : [.. chunk, .. carry];
                pos = start;
                var cut = 0;
                if (start > 0)
                {
                    cut = FirstEntryStart(data);
                    if (cut < 0) { carry = data; continue; }
                }
                carry = start > 0 ? data[..cut] : [];
                var parsed = ParseBlock(data[cut..], start + cut, f.Key);
                collected.InsertRange(0, parsed);
                if (parsed.Count > 0 && query.From is { } from && parsed[0].Time is { } first && first < from) { stop = true; break; }
                if (collected.Count(e => LogFilter.Matches(e, query)) > limit) { stop = true; break; }
            }
            if (stop) break;
        }
        return LogFilter.Page(collected, query, truncated, sourceHasMore: truncated);
    }

    private static int FirstEntryStart(byte[] data)
    {
        var i = Array.IndexOf(data, (byte)'\n');
        while (i >= 0 && i + 1 < data.Length)
        {
            var s = i + 1;
            var e = Array.IndexOf(data, (byte)'\n', s);
            var head = Encoding.UTF8.GetString(data, s, Math.Min((e < 0 ? data.Length : e) - s, 64));
            if (head.Length > 24 && char.IsDigit(head[0]) && EntryLine().IsMatch(head)) return s;
            i = e;
        }
        return -1;
    }

    /// <summary>Seq of the newest entry (tail start cursor), or 0 without files.</summary>
    public long NewestSeq()
    {
        var last = ReadBackward(new LogQuery(SourceId, Limit: 1), CancellationToken.None).Entries.LastOrDefault();
        if (last is not null) return last.Seq;
        return Files().LastOrDefault() is { } f ? f.Key * FileFactor - 1 : 0;
    }
}
