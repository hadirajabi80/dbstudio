using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Logs;

/// <summary>Writes log entries as txt, csv (RFC 4180, UTF-8 with BOM for Excel) or json (an array of LogEntry).</summary>
public static class LogExporter
{
    public const int MaxEntries = 100_000;

    public static readonly IReadOnlyList<string> Formats = ["txt", "csv", "json"];

    public static string ContentType(string format) => format switch
    {
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };

    public static string Validate(string? format) =>
        format?.Trim().ToLowerInvariant() is { } f && Formats.Contains(f) ? f
            : throw EngineException.Validation("format must be txt, csv or json.", new { field = "format" });

    public static string FileName(string sourceId, string format, DateTimeOffset now) =>
        $"logs-{new string(sourceId.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray())}-{now:yyyyMMdd-HHmmss}.{format}";

    public static async Task WriteAsync(Stream output, string format, IReadOnlyList<LogEntry> entries, CancellationToken ct)
    {
        switch (format)
        {
            case "json":
                await JsonSerializer.SerializeAsync(output, entries, CoreJson.Indented, ct).ConfigureAwait(false);
                return;
            case "csv":
            {
                await using var w = new StreamWriter(output, new UTF8Encoding(true), 64 * 1024, leaveOpen: true);
                await w.WriteAsync("ts,level,source,message,detail,fields\r\n").ConfigureAwait(false);
                foreach (var e in entries)
                {
                    ct.ThrowIfCancellationRequested();
                    var fields = e.Fields is null ? "" : string.Join("; ", e.Fields.Select(kv => $"{kv.Key}={kv.Value}"));
                    await w.WriteAsync($"{Csv(e.Ts)},{Csv(e.Level)},{Csv(e.Source)},{Csv(e.Message)},{Csv(e.Detail)},{Csv(fields)}\r\n").ConfigureAwait(false);
                }
                return;
            }
            default:
            {
                await using var w = new StreamWriter(output, new UTF8Encoding(false), 64 * 1024, leaveOpen: true);
                foreach (var e in entries)
                {
                    ct.ThrowIfCancellationRequested();
                    await w.WriteAsync(Text(e)).ConfigureAwait(false);
                    await w.WriteAsync('\n').ConfigureAwait(false);
                }
                return;
            }
        }
    }

    /// <summary>One txt line: <c>2026-10-18T13:02:11.213Z ERROR [spid52] message</c>, detail and fields indented below.</summary>
    public static string Text(LogEntry e)
    {
        var sb = new StringBuilder();
        sb.Append(e.Ts ?? "-").Append(' ').Append(e.Level.ToUpperInvariant().PadRight(5)).Append(" [").Append(e.Source).Append("] ").Append(e.Message);
        if (!string.IsNullOrEmpty(e.Detail)) foreach (var l in e.Detail.Split('\n')) sb.Append("\n    ").Append(l.TrimEnd('\r'));
        if (e.Fields is { Count: > 0 }) sb.Append("\n    ").Append(string.Join(" ", e.Fields.Select(kv => $"{kv.Key}={kv.Value}")));
        return sb.ToString();
    }

    public static string Csv(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        // Formula injection guard (=, +, -, @ at the start are prefixed with a quote).
        if (s[0] is '=' or '+' or '-' or '@') s = "'" + s;
        return s.IndexOfAny([',', '"', '\n', '\r']) >= 0 ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
    }

    /// <summary>Collects up to <see cref="MaxEntries"/> entries of a query by paging to older entries with <c>before</c>.</summary>
    public static async Task<List<LogEntry>> CollectAsync(LogService logs, string cid, LogQuery query, Action<int>? progress, CancellationToken ct)
    {
        var all = new List<LogEntry>();
        var q = query with { Limit = LogFilter.MaxLimit };
        while (all.Count < MaxEntries)
        {
            var page = await logs.QueryAsync(cid, q, ct).ConfigureAwait(false);
            all.InsertRange(0, page.Entries);
            progress?.Invoke(all.Count);
            if (!page.HasMore || page.Entries.Count == 0) break;
            q = q with { Before = page.Entries[0].Seq };
        }
        return all.Count > MaxEntries ? all.GetRange(all.Count - MaxEntries, MaxEntries) : all;
    }
}
