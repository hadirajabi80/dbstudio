using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DbStudio.Logs.Providers.PostgreSql;

/// <summary>
/// Parses PostgreSQL server log text: stderr with the default <c>log_line_prefix</c> (<c>%m [%p] </c>, also
/// <c>%m [%p] %q%u@%d </c> and <c>%t</c> variants), <c>csvlog</c> and <c>jsonlog</c> (PG 15+). Secondary lines (DETAIL,
/// HINT, CONTEXT, STATEMENT, QUERY, LOCATION) are folded into the entry they belong to.
/// </summary>
public static partial class PgLogParser
{
    public enum Format { Stderr, Csv, Json }

    /// <summary>A parsed entry before seq assignment.</summary>
    public sealed record PgEntry(DateTimeOffset? Ts, string Severity, string Message, Dictionary<string, string> Fields)
    {
        public string? Detail { get; set; }
    }

    [GeneratedRegex(@"^(?<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?: (?<tz>[A-Za-z][A-Za-z0-9_/+-]*|[+-]\d{2}(?::?\d{2})?))? (?<rest>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex Prefix();

    [GeneratedRegex(@"(?:^|\s)(?<sev>DEBUG[1-5]?|INFO|NOTICE|WARNING|ERROR|LOG|FATAL|PANIC|DETAIL|HINT|QUERY|CONTEXT|STATEMENT|LOCATION):  (?<msg>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex Severity();

    [GeneratedRegex(@"\[(?<pid>\d+)\](?:-\d+)?", RegexOptions.CultureInvariant)]
    private static partial Regex Pid();

    [GeneratedRegex(@"(?:^|\s)(?<user>[^\s@\[\]]*)@(?<db>[^\s@\[\]]*)(?=\s|$)", RegexOptions.CultureInvariant)]
    private static partial Regex UserAtDb();

    public static readonly IReadOnlySet<string> Secondary = new HashSet<string> { "DETAIL", "HINT", "QUERY", "CONTEXT", "STATEMENT", "LOCATION" };

    public static string LevelOf(string severity) => severity.ToUpperInvariant() switch
    {
        var s when s.StartsWith("DEBUG", StringComparison.Ordinal) => LogLevels.Debug,
        "LOG" or "INFO" or "NOTICE" => LogLevels.Info,
        "WARNING" => LogLevels.Warn,
        "ERROR" => LogLevels.Error,
        "FATAL" or "PANIC" => LogLevels.Fatal,
        _ => LogLevels.Unknown,
    };

    /// <summary>
    /// True when a line starts a new entry (used to cut chunks on entry boundaries). stderr: a prefixed line whose
    /// severity is primary (DETAIL / HINT / STATEMENT... lines belong to the entry above them).
    /// </summary>
    public static bool IsEntryStart(string line, Format format)
    {
        if (format == Format.Json) return line.StartsWith('{');
        if (line.Length < 19 || !char.IsDigit(line[0]) || line[4] != '-' || line[7] != '-') return false;
        if (format == Format.Csv) return true;
        var p = Prefix().Match(line);
        var s = p.Success ? Severity().Match(p.Groups["rest"].Value) : Match.Empty;
        return !s.Success || !Secondary.Contains(s.Groups["sev"].Value);
    }

    /// <summary>Converts a log timestamp; zone names other than UTC/GMT/Z use <paramref name="logOffset"/> (log_timezone).</summary>
    public static DateTimeOffset? ParseTime(string ts, string? tz, TimeSpan logOffset)
    {
        if (!DateTime.TryParse(ts.Replace(' ', 'T'), CultureInfo.InvariantCulture, DateTimeStyles.None, out var local)) return null;
        var offset = logOffset;
        if (!string.IsNullOrEmpty(tz))
        {
            if (tz is "UTC" or "GMT" or "Z" or "Etc/UTC" or "UCT") offset = TimeSpan.Zero;
            else if (tz[0] is '+' or '-')
            {
                var digits = tz[1..].Replace(":", "");
                var h = int.Parse(digits[..2], CultureInfo.InvariantCulture);
                var m = digits.Length >= 4 ? int.Parse(digits[2..4], CultureInfo.InvariantCulture) : 0;
                offset = new TimeSpan(h, m, 0) * (tz[0] == '-' ? -1 : 1);
            }
        }
        return new DateTimeOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), offset);
    }

    /// <summary>Splits "2026-10-18 13:02:11.213 UTC" into time and zone.</summary>
    public static DateTimeOffset? ParseTime(string? value, TimeSpan logOffset)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var m = Prefix().Match(value.Trim() + " x");
        return m.Success ? ParseTime(m.Groups["ts"].Value, m.Groups["tz"].Success ? m.Groups["tz"].Value : null, logOffset) : null;
    }

    public static List<PgEntry> Parse(string text, Format format, TimeSpan logOffset) => format switch
    {
        Format.Csv => ParseCsv(text, logOffset),
        Format.Json => ParseJson(text, logOffset),
        _ => ParseStderr(text, logOffset),
    };

    public static List<PgEntry> ParseStderr(string text, TimeSpan logOffset)
    {
        var list = new List<PgEntry>();
        PgEntry? current = null;
        string? lastSecondary = null;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            var p = Prefix().Match(line);
            var s = p.Success ? Severity().Match(p.Groups["rest"].Value) : Match.Empty;
            if (!p.Success || !s.Success)
            {
                // Continuation of a multi-line message or statement.
                if (current is null) continue;
                var cont = line.StartsWith('\t') ? line[1..] : line;
                if (lastSecondary is not null) current.Fields[lastSecondary] += "\n" + cont;
                else current = Replace(list, current, current with { Message = current.Message + "\n" + cont });
                if (lastSecondary == "statement") current.Detail = current.Fields["statement"];
                continue;
            }
            var sev = s.Groups["sev"].Value;
            var msg = s.Groups["msg"].Value;
            var before = p.Groups["rest"].Value[..s.Index];
            var pid = Pid().Match(before) is { Success: true } pm ? pm.Groups["pid"].Value : null;
            if (Secondary.Contains(sev) && current is null) continue; // orphan secondary line (chunk start)
            if (Secondary.Contains(sev) && current is not null && (pid is null || current.Fields.GetValueOrDefault("pid") == pid))
            {
                lastSecondary = sev.ToLowerInvariant();
                current.Fields[lastSecondary] = msg;
                if (lastSecondary == "statement" || lastSecondary == "query") current.Detail = msg;
                continue;
            }
            lastSecondary = null;
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            if (pid is not null) fields["pid"] = pid;
            if (UserAtDb().Match(before) is { Success: true } ud)
            {
                if (ud.Groups["user"].Value.Length > 0) fields["user"] = ud.Groups["user"].Value;
                if (ud.Groups["db"].Value.Length > 0) fields["database"] = ud.Groups["db"].Value;
            }
            fields["severity"] = sev;
            current = new PgEntry(ParseTime(p.Groups["ts"].Value, p.Groups["tz"].Success ? p.Groups["tz"].Value : null, logOffset), sev, msg, fields);
            list.Add(current);
        }
        return list;
    }

    private static PgEntry Replace(List<PgEntry> list, PgEntry old, PgEntry now)
    {
        now.Detail = old.Detail;
        list[^1] = now;
        return now;
    }

    /// <summary>csvlog columns (PG 13+ adds backend_type, 14+ leader_pid and query_id).</summary>
    public static readonly string[] CsvColumns =
    [
        "log_time", "user_name", "database_name", "process_id", "connection_from", "session_id", "session_line_num", "command_tag",
        "session_start_time", "virtual_transaction_id", "transaction_id", "error_severity", "sql_state_code", "message", "detail", "hint",
        "internal_query", "internal_query_pos", "context", "query", "query_pos", "location", "application_name", "backend_type",
        "leader_pid", "query_id",
    ];

    public static List<PgEntry> ParseCsv(string text, TimeSpan logOffset)
    {
        var list = new List<PgEntry>();
        foreach (var rec in CsvRecords(text))
        {
            if (rec.Count < 14) continue;
            string Col(string name) => Array.IndexOf(CsvColumns, name) is var i and >= 0 && i < rec.Count ? rec[i] : "";
            var sev = Col("error_severity");
            var fields = new Dictionary<string, string>(StringComparer.Ordinal) { ["severity"] = sev };
            void Put(string key, string col)
            {
                if (Col(col) is { Length: > 0 } v) fields[key] = v;
            }
            Put("user", "user_name"); Put("database", "database_name"); Put("pid", "process_id"); Put("client", "connection_from");
            Put("sqlstate", "sql_state_code"); Put("detail", "detail"); Put("hint", "hint"); Put("context", "context");
            Put("application", "application_name"); Put("backendType", "backend_type"); Put("statement", "query");
            list.Add(new PgEntry(ParseTime(Col("log_time"), logOffset), sev, Col("message"), fields) { Detail = Col("query") is { Length: > 0 } q ? q : null });
        }
        return list;
    }

    /// <summary>RFC 4180 records (quoted fields may contain commas, quotes and newlines).</summary>
    public static IEnumerable<List<string>> CsvRecords(string text)
    {
        var rec = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        var any = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                    else quoted = false;
                }
                else field.Append(c);
                continue;
            }
            switch (c)
            {
                case '"': quoted = true; any = true; break;
                case ',': rec.Add(field.ToString()); field.Clear(); any = true; break;
                case '\r': break;
                case '\n':
                    if (any || field.Length > 0) { rec.Add(field.ToString()); yield return rec; }
                    rec = [];
                    field.Clear();
                    any = false;
                    break;
                default: field.Append(c); any = true; break;
            }
        }
        if (any || field.Length > 0)
        {
            rec.Add(field.ToString());
            yield return rec;
        }
    }

    public static List<PgEntry> ParseJson(string text, TimeSpan logOffset)
    {
        var list = new List<PgEntry>();
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] != '{') continue;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException) { continue; }
            using (doc)
            {
                var o = doc.RootElement;
                string S(string name) => o.TryGetProperty(name, out var v) ? v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : v.GetRawText() : "";
                var sev = S("error_severity");
                var fields = new Dictionary<string, string>(StringComparer.Ordinal) { ["severity"] = sev };
                void Put(string key, string name)
                {
                    if (S(name) is { Length: > 0 } v && v != "null") fields[key] = v;
                }
                Put("user", "user"); Put("database", "dbname"); Put("pid", "pid"); Put("client", "remote_host"); Put("sqlstate", "state_code");
                Put("detail", "detail"); Put("hint", "hint"); Put("context", "context"); Put("application", "application_name");
                Put("backendType", "backend_type"); Put("statement", "statement");
                list.Add(new PgEntry(ParseTime(S("timestamp"), logOffset), sev, S("message"), fields)
                {
                    Detail = fields.GetValueOrDefault("statement"),
                });
            }
        }
        return list;
    }

    /// <summary>Entries → LogEntry (seq from time, ascending input order kept).</summary>
    public static List<LogEntry> ToEntries(IEnumerable<PgEntry> entries, TimeSeq seq) =>
        entries.Select(e => new LogEntry(SqlServer.SqlServerLogParser.Iso(e.Ts), LevelOf(e.Severity),
            e.Fields.GetValueOrDefault("pid") is { } pid ? $"[{pid}]" : "postgres", e.Message, seq.Next(e.Ts), e.Detail, e.Fields)).ToList();
}
