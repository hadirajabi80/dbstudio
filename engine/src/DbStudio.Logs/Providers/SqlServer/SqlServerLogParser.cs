using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Providers.SqlServer;

/// <summary>Turns <c>xp_readerrorlog</c> rows and system_health XE events into log entries.</summary>
public static partial class SqlServerLogParser
{
    [GeneratedRegex(@"^Error:\s*(?<num>\d+),\s*Severity:\s*(?<sev>\d+),\s*State:\s*(?<state>\d+)\.?\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex ErrorLine();

    /// <summary>Level of one error log line (docs/PLAN-M2.md 8.1: "Error:"/severity ≥ 16 → error, "Login failed" → warn).</summary>
    public static string LevelOf(string text, int? severity = null)
    {
        if (severity is { } sev) return sev >= 20 ? LogLevels.Fatal : sev >= 16 ? LogLevels.Error : sev >= 11 ? LogLevels.Warn : LogLevels.Info;
        if (ErrorLine().Match(text) is { Success: true } m) return LevelOf("", int.Parse(m.Groups["sev"].Value, CultureInfo.InvariantCulture));
        if (text.Contains("Login failed", StringComparison.OrdinalIgnoreCase)) return LogLevels.Warn;
        if (text.Contains("Stack Dump", StringComparison.OrdinalIgnoreCase) || text.Contains("access violation", StringComparison.OrdinalIgnoreCase))
            return LogLevels.Fatal;
        if (text.StartsWith("Error:", StringComparison.OrdinalIgnoreCase) || text.Contains(" error ", StringComparison.OrdinalIgnoreCase) && text.Contains("failed", StringComparison.OrdinalIgnoreCase))
            return LogLevels.Error;
        if (text.StartsWith("Warning", StringComparison.OrdinalIgnoreCase) || text.Contains("warning:", StringComparison.OrdinalIgnoreCase))
            return LogLevels.Warn;
        return LogLevels.Info;
    }

    /// <summary>
    /// Error log rows (newest first, as <c>xp_readerrorlog … 'desc'</c> returns them) → entries ascending. An
    /// "Error: n, Severity: s, State: t." row is merged into the message row that follows it with the same time and
    /// process (the error log writes them as two lines).
    /// </summary>
    /// <param name="logType">1 = error log (ProcessInfo column), 2 = Agent log (ErrorLevel column: 1 error, 2 warning, 3 info).</param>
    public static List<LogEntry> ParseErrorLog(SqlRowSet rows, int logType, TimeSpan serverOffset)
    {
        var raw = new List<(DateTimeOffset? Ts, string Process, int? AgentLevel, string Text)>();
        for (var i = rows.Rows.Count - 1; i >= 0; i--)
        {
            var r = rows.Rows[i];
            var text = (rows.Str(r, "Text") ?? "").TrimEnd();
            raw.Add((rows.Time(r, "LogDate", serverOffset), logType == 2 ? "SQLAgent" : rows.Str(r, "ProcessInfo") ?? "", (int?)rows.Long(r, "ErrorLevel"), text));
        }
        var seq = new TimeSeq();
        var list = new List<LogEntry>(raw.Count);
        for (var i = 0; i < raw.Count; i++)
        {
            var (ts, process, agentLevel, text) = raw[i];
            Dictionary<string, string>? fields = null;
            string level;
            if (ErrorLine().Match(text) is { Success: true } m)
            {
                fields = new()
                {
                    ["error"] = m.Groups["num"].Value,
                    ["severity"] = m.Groups["sev"].Value,
                    ["state"] = m.Groups["state"].Value,
                };
                var sev = int.Parse(m.Groups["sev"].Value, CultureInfo.InvariantCulture);
                level = LevelOf("", sev);
                if (i + 1 < raw.Count && raw[i + 1].Ts == ts && raw[i + 1].Process == process && !ErrorLine().IsMatch(raw[i + 1].Text))
                {
                    var next = raw[++i].Text;
                    if (next.Contains("Login failed", StringComparison.OrdinalIgnoreCase) && sev < 16) level = LogLevels.Warn;
                    list.Add(new LogEntry(Iso(ts), level, process, next, seq.Next(ts), text, fields));
                    continue;
                }
            }
            else
            {
                level = agentLevel switch
                {
                    1 => LogLevels.Error,
                    2 => LogLevels.Warn,
                    3 => LogLevels.Info,
                    _ => LevelOf(text),
                };
            }
            if (process.Length > 0 && process.StartsWith("spid", StringComparison.OrdinalIgnoreCase))
                (fields ??= [])["spid"] = process[4..].TrimEnd('s', 'S');
            list.Add(new LogEntry(Iso(ts), level, process.Length > 0 ? process : "Server", text, seq.Next(ts), null, fields));
        }
        return list;
    }

    /// <summary><c>sp_enumerrorlogs</c> rows ("Archive #", "Date", "Log File Size (Byte)").</summary>
    public static List<LogArchiveInfo> ParseArchives(SqlRowSet rows, TimeSpan serverOffset)
    {
        var list = new List<LogArchiveInfo>();
        foreach (var r in rows.Rows)
        {
            var index = rows.Long(r, "Archive #") ?? (r.Length > 0 ? SqlCells.Long(r[0]) : null);
            if (index is null) continue;
            var date = rows.Time(r, "Date", serverOffset);
            list.Add(new LogArchiveInfo((int)index, date is null ? null : TimeSeq.Iso(date.Value), rows.Long(r, "Log File Size (Byte)") ?? 0));
        }
        return list.OrderBy(a => a.Index).ToList();
    }

    /// <summary>system_health rows (ts UTC, name, event_xml), newest first → entries ascending.</summary>
    public static List<LogEntry> ParseSystemHealth(SqlRowSet rows)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>(rows.Rows.Count);
        for (var i = rows.Rows.Count - 1; i >= 0; i--)
        {
            var r = rows.Rows[i];
            var ts = rows.Time(r, "ts", TimeSpan.Zero);
            var name = rows.Str(r, "name") ?? "event";
            var e = ParseXeEvent(name, rows.Str(r, "event_xml"));
            list.Add(e with { Ts = Iso(ts) ?? e.Ts, Seq = seq.Next(ts ?? e.Time) });
        }
        return list;
    }

    /// <summary>One XE event document (<c>&lt;event name=… timestamp=…&gt;&lt;data name=…&gt;&lt;value&gt;…</c>).</summary>
    public static LogEntry ParseXeEvent(string name, string? xml)
    {
        XElement? ev = null;
        try
        {
            if (!string.IsNullOrWhiteSpace(xml)) ev = XElement.Parse(xml);
        }
        catch (System.Xml.XmlException)
        {
            // Truncated or invalid event XML: show the raw text.
        }
        if (ev is null) return new LogEntry(null, LogLevels.Unknown, name, xml ?? name, 0);
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var d in ev.Elements("data").Concat(ev.Elements("action")))
        {
            var key = (string?)d.Attribute("name");
            if (key is null || key == "xml_report") continue;
            var text = (string?)d.Element("text");
            var value = d.Element("value");
            var v = !string.IsNullOrEmpty(text) ? text : value?.HasElements == true ? null : value?.Value;
            if (!string.IsNullOrEmpty(v)) fields[key] = v.Trim();
        }
        var ts = (string?)ev.Attribute("timestamp");
        string F(string k) => fields.TryGetValue(k, out var v) ? v : "";
        string level;
        string message;
        string? detail = null;
        switch (name)
        {
            case "error_reported":
            {
                var sev = int.TryParse(F("severity"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s) ? s : (int?)null;
                level = LevelOf(F("message"), sev ?? 16);
                message = F("message").Length > 0 ? F("message") : $"Error {F("error_number")}";
                if (F("error_number").Length > 0) message = $"Error {F("error_number")}, severity {F("severity")}: {message}";
                detail = fields.GetValueOrDefault("sql_text");
                break;
            }
            case "wait_info" or "wait_info_external":
                level = LogLevels.Warn;
                message = $"Long wait {F("wait_type")} {F("duration")} ms" + (F("session_id").Length > 0 ? $" (session {F("session_id")})" : "");
                detail = fields.GetValueOrDefault("sql_text");
                break;
            case "xml_deadlock_report":
            {
                level = LogLevels.Error;
                var report = ev.Elements("data").FirstOrDefault(d => (string?)d.Attribute("name") == "xml_report")?.Element("value")?.Elements().FirstOrDefault();
                var processes = report?.Element("process-list")?.Elements("process").ToList() ?? [];
                var victimId = (string?)report?.Element("victim-list")?.Element("victimProcess")?.Attribute("id");
                var victim = processes.FirstOrDefault(p => (string?)p.Attribute("id") == victimId);
                var spids = processes.Select(p => (string?)p.Attribute("spid")).Where(s => s is not null).ToList();
                message = $"Deadlock between {processes.Count} processes" + (spids.Count > 0 ? $" (sessions {string.Join(", ", spids)})" : "")
                    + (victim is not null ? $"; victim session {(string?)victim.Attribute("spid")}" : "");
                if (spids.Count > 0) fields["sessions"] = string.Join(",", spids);
                if (victim is not null) fields["victim"] = (string?)victim.Attribute("spid") ?? "";
                detail = report?.ToString();
                break;
            }
            case "security_error_ring_buffer_recorded":
                level = LogLevels.Warn;
                message = $"Security error {F("error_code")} in {F("api_name")}" + (F("calling_api_name").Length > 0 ? $" (called by {F("calling_api_name")})" : "");
                break;
            case "connectivity_ring_buffer_recorded":
                level = F("os_error") is "" or "0" ? LogLevels.Info : LogLevels.Warn;
                message = $"Connectivity {F("type")}" + (F("remote_host").Length > 0 ? $" from {F("remote_host")}:{F("remote_port")}" : "")
                    + (F("os_error") is not ("" or "0") ? $", OS error {F("os_error")}" : "") + (F("sni_error") is not ("" or "0") ? $", SNI error {F("sni_error")}" : "");
                break;
            default:
                level = LogLevels.Info;
                message = name;
                break;
        }
        fields["event"] = name;
        return new LogEntry(ts, level, "system_health", message, 0, detail, fields);
    }

    internal static string? Iso(DateTimeOffset? t) => t is null ? null : t.Value.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", CultureInfo.InvariantCulture);
}
