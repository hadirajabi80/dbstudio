using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Providers.Kafka;

/// <summary>One consumer group of the connection (M2-K <c>GroupService.ListAsync</c>), shown in Activity.</summary>
public sealed record KafkaGroupActivity(string GroupId, string State, string? Protocol, int Members, IReadOnlyList<string> Topics, long? LagTotal);

/// <summary>A librdkafka log callback captured by the Kafka client handle.</summary>
/// <param name="Level">Syslog level 0–7 (0–2 fatal, 3 error, 4 warn, 5–6 info, 7 debug).</param>
public sealed record KafkaLogLine(DateTimeOffset Ts, int Level, string Facility, string Name, string Message);

/// <summary>
/// Seam to the per-client librdkafka log ring buffer (M2-K: <c>KafkaClientHandle.LogBuffer</c>, 5000 lines). Kafka has no
/// broker log over the protocol, so the client log is the only log source (documented in the walkthrough).
/// </summary>
public interface IKafkaLogGateway
{
    /// <summary>The buffered lines, or null when the client handle does not expose a log buffer.</summary>
    Task<IReadOnlyList<KafkaLogLine>?> ReadAsync(LogTarget target, CancellationToken ct);

    /// <summary>The consumer groups of the cluster with members and lag, or null when they cannot be listed.</summary>
    Task<IReadOnlyList<KafkaGroupActivity>?> GroupsAsync(LogTarget target, CancellationToken ct) => Task.FromResult<IReadOnlyList<KafkaGroupActivity>?>(null);
}

/// <summary>
/// Reads <c>LogBuffer</c> (any enumerable property) of the shared source client by reflection: items may be strings in
/// librdkafka's stderr format (<c>%7|1697461331.123|BROKER|rdkafka#producer-1| message</c>) or objects with
/// Timestamp/Ts, Level, Facility, Name and Message properties (Confluent <c>LogMessage</c>). Consumer groups come from
/// M2-K's <c>GroupService.ListAsync(KafkaClientHandle, CancellationToken)</c> resolved from <paramref name="services"/>.
/// </summary>
public sealed partial class ReflectionKafkaGateway(SourceClientManager clients, IServiceProvider? services = null) : IKafkaLogGateway
{
    public const string GroupServiceType = "DbStudio.Sources.Kafka.Services.GroupService, DbStudio.Sources.Kafka";

    public async Task<IReadOnlyList<KafkaGroupActivity>?> GroupsAsync(LogTarget target, CancellationToken ct)
    {
        if (services is null || Type.GetType(GroupServiceType, throwOnError: false) is not { } type || services.GetService(type) is not { } svc) return null;
        var client = await clients.GetAsync(target.ConnectionId, ct).ConfigureAwait(false);
        if (type.GetMethod("ListAsync", [client.GetType(), typeof(CancellationToken)]) is not { } list) return null;
        var task = (Task)list.Invoke(svc, [client, ct])!;
        await task.ConfigureAwait(false);
        if (task.GetType().GetProperty("Result")?.GetValue(task) is not IEnumerable items) return null;
        var rows = new List<KafkaGroupActivity>();
        foreach (var g in items)
        {
            if (g is null) continue;
            var t = g.GetType();
            object? P(string name) => t.GetProperty(name)?.GetValue(g);
            if (P("GroupId") is not string id) continue;
            rows.Add(new KafkaGroupActivity(id, P("State") as string ?? "Unknown", P("Protocol") as string, P("Members") is int m ? m : 0,
                (P("Topics") as IEnumerable)?.OfType<string>().ToList() ?? [], P("LagTotal") as long?));
        }
        return rows;
    }

    public async Task<IReadOnlyList<KafkaLogLine>?> ReadAsync(LogTarget target, CancellationToken ct)
    {
        var client = await clients.GetAsync(target.ConnectionId, ct).ConfigureAwait(false);
        var prop = client.GetType().GetProperty("LogBuffer");
        if (Items(prop?.GetValue(client)) is not { } items) return null;
        var list = new List<KafkaLogLine>();
        foreach (var item in items)
            if (FromObject(item) is { } line) list.Add(line);
        return list;
    }

    /// <summary>
    /// The entries of a log buffer: an enumerable itself, or an object with <c>Snapshot(long afterSeq)</c> (M2-K's
    /// <c>KafkaLogBuffer</c>).
    /// </summary>
    public static IEnumerable? Items(object? buffer)
    {
        switch (buffer)
        {
            case null: return null;
            case string: return null;
            case IEnumerable e: return e;
        }
        var snapshot = buffer.GetType().GetMethod("Snapshot", [typeof(long)]);
        if (snapshot is not null) return snapshot.Invoke(buffer, [0L]) as IEnumerable;
        return buffer.GetType().GetMethod("Snapshot", Type.EmptyTypes)?.Invoke(buffer, null) as IEnumerable;
    }

    [GeneratedRegex(@"^%(?<lvl>\d)\|(?<ts>\d+(?:\.\d+)?)\|(?<fac>[^|]*)\|(?<name>[^|]*)\|\s?(?<msg>.*)$", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex StderrLine();

    /// <summary>librdkafka stderr log line: <c>%{level}|{unix seconds.millis}|{facility}|{name}| {message}</c>.</summary>
    public static KafkaLogLine? ParseLine(string line)
    {
        var m = StderrLine().Match(line.TrimEnd());
        if (!m.Success) return null;
        var secs = double.Parse(m.Groups["ts"].Value, CultureInfo.InvariantCulture);
        return new KafkaLogLine(DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Round(secs * 1000)), int.Parse(m.Groups["lvl"].Value, CultureInfo.InvariantCulture),
            m.Groups["fac"].Value, m.Groups["name"].Value, m.Groups["msg"].Value);
    }

    public static KafkaLogLine? FromObject(object? item)
    {
        switch (item)
        {
            case null: return null;
            case KafkaLogLine l: return l;
            case string s: return ParseLine(s);
        }
        var t = item.GetType();
        object? P(params string[] names) => names.Select(n => t.GetProperty(n)?.GetValue(item)).FirstOrDefault(v => v is not null);
        var ts = P("Timestamp", "Ts", "Time") switch
        {
            DateTimeOffset d => d,
            DateTime dt => new DateTimeOffset(dt.ToUniversalTime()),
            _ => DateTimeOffset.UtcNow,
        };
        var level = P("Level") switch
        {
            int i => i,
            Enum e => Convert.ToInt32(e, CultureInfo.InvariantCulture),
            string s => s.ToLowerInvariant() switch { "error" => 3, "warning" or "warn" => 4, "debug" => 7, _ => 6 },
            _ => 6,
        };
        var message = P("Message")?.ToString();
        if (message is null) return item.ToString() is { } text ? ParseLine(text) : null;
        return new KafkaLogLine(ts, level, P("Facility")?.ToString() ?? "", P("Name", "Client")?.ToString() ?? "", message);
    }
}

/// <summary>
/// Kafka (docs/PLAN-M2.md 8.1): <c>client</c> (librdkafka log/error callbacks of the client handle) and activity (the engine
/// jobs and streams of the connection: fetches, tails; cancel = "kill").
/// </summary>
public sealed class KafkaLogSource(IKafkaLogGateway gateway, JobManager jobs, Func<StreamManager?> streams) : ILogSource, IActivitySource
{
    public const string Client = "client", Activity = "activity";

    /// <summary>Consumer groups are listed at most this often per connection (lag needs one offsets call per group).</summary>
    public static readonly TimeSpan GroupsTtl = TimeSpan.FromSeconds(10);

    private readonly ConcurrentDictionary<string, (DateTimeOffset At, IReadOnlyList<KafkaGroupActivity> Groups)> _groups = new(StringComparer.Ordinal);
    public const string NoBuffer = "The Kafka client does not expose its librdkafka log buffer yet (package M2-K: KafkaClientHandle.LogBuffer).";

    public string ProviderId => "kafka";

    public static string LevelOf(int syslog) => syslog switch
    {
        <= 2 => LogLevels.Fatal,
        3 => LogLevels.Error,
        4 => LogLevels.Warn,
        5 or 6 => LogLevels.Info,
        _ => LogLevels.Debug,
    };

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        var client = new LogSourceInfo(Client, "Client log (librdkafka)", "log", true, true, LogLevels.Standard, true,
            Reason: "Kafka has no broker log over the protocol; this is the log of Rowlit's own client.");
        IReadOnlyList<KafkaLogLine>? lines = null;
        try { lines = await gateway.ReadAsync(target, ct).ConfigureAwait(false); }
        catch (EngineException ex) { client = client.Unavailable(ex.Message, null); }
        if (client.Available && lines is null) client = client.Unavailable(NoBuffer, null);
        return [client, new LogSourceInfo(Activity, "Jobs and streams", "activity", false, false, [], true)];
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        if (query.SourceId != Client) throw SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
        var lines = await gateway.ReadAsync(target, ct).ConfigureAwait(false) ?? throw EngineException.Validation(NoBuffer, new { field = "sourceId" });
        return LogFilter.Page(ToEntries(lines), query, truncated: lines.Count >= 5000);
    }

    public static List<LogEntry> ToEntries(IEnumerable<KafkaLogLine> lines)
    {
        var seq = new TimeSeq();
        return lines.OrderBy(l => l.Ts).Select(l => new LogEntry(TimeSeq.Iso(l.Ts), LevelOf(l.Level), l.Facility.Length > 0 ? l.Facility : "rdkafka", l.Message,
            seq.Next(l.Ts), null, new Dictionary<string, string> { ["facility"] = l.Facility, ["client"] = l.Name, ["syslogLevel"] = l.Level.ToString(CultureInfo.InvariantCulture) })).ToList();
    }

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var rows = new List<ActivityRow>();
        foreach (var g in await GroupsAsync(target, now, ct).ConfigureAwait(false)) rows.Add(GroupRow(g));
        foreach (var j in jobs.List().Where(j => j.ConnectionId == target.ConnectionId))
            rows.Add(new ActivityRow
            {
                Id = "job:" + j.JobId,
                Kind = "op",
                State = "running",
                Since = TimeSeq.Iso(j.StartedAt),
                DurationMs = (long)(now - j.StartedAt).TotalMilliseconds,
                Command = j.Kind,
                Text = j.Message,
                App = j.Owner,
                CanKill = true,
                Fields = new Dictionary<string, string>
                {
                    ["killStatement"] = $"Cancel job {j.JobId}", ["done"] = j.Done.ToString(CultureInfo.InvariantCulture),
                    ["total"] = j.Total?.ToString(CultureInfo.InvariantCulture) ?? "",
                },
            });
        foreach (var s in streams()?.List().Where(s => s.ConnectionId == target.ConnectionId) ?? [])
            rows.Add(new ActivityRow
            {
                Id = "stream:" + s.StreamId,
                Kind = "op",
                State = s.State,
                Since = TimeSeq.Iso(s.OpenedAt),
                DurationMs = (long)(now - s.OpenedAt).TotalMilliseconds,
                Command = s.Kind,
                App = s.Owner,
                CanKill = true,
                Fields = new Dictionary<string, string>
                {
                    ["killStatement"] = $"Close stream {s.StreamId}", ["delivered"] = s.Delivered.ToString(CultureInfo.InvariantCulture),
                    ["dropped"] = s.Dropped.ToString(CultureInfo.InvariantCulture),
                },
            });
        return rows;
    }

    /// <summary>The cached consumer groups (refreshed after <see cref="GroupsTtl"/>); a failure keeps activity working without them.</summary>
    private async Task<IReadOnlyList<KafkaGroupActivity>> GroupsAsync(LogTarget target, DateTimeOffset now, CancellationToken ct)
    {
        if (_groups.TryGetValue(target.ConnectionId, out var hit) && now - hit.At < GroupsTtl) return hit.Groups;
        IReadOnlyList<KafkaGroupActivity> groups;
        try { groups = await gateway.GroupsAsync(target, ct).ConfigureAwait(false) ?? []; }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested) { groups = hit.Groups ?? []; }
        _groups[target.ConnectionId] = (now, groups);
        return groups;
    }

    /// <summary>A consumer group as an Activity row (kind client, not killable: groups are managed in the Kafka views).</summary>
    public static ActivityRow GroupRow(KafkaGroupActivity g)
    {
        var topics = string.Join(", ", g.Topics);
        var lag = g.LagTotal?.ToString("N0", CultureInfo.InvariantCulture);
        return new ActivityRow
        {
            Id = "group:" + g.GroupId,
            Kind = "client",
            App = g.GroupId,
            State = g.State,
            Command = "consumer group",
            Text = $"{g.Members} member{(g.Members == 1 ? "" : "s")}{(topics.Length > 0 ? $" · {topics}" : "")}{(lag is null ? "" : $" · lag {lag}")}",
            CanKill = false,
            Fields = new Dictionary<string, string>
            {
                ["members"] = g.Members.ToString(CultureInfo.InvariantCulture), ["topics"] = topics, ["lag"] = lag ?? "",
                ["protocol"] = g.Protocol ?? "",
            },
        };
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var id = request.Id ?? "";
        if (id.StartsWith("job:", StringComparison.Ordinal))
        {
            var jobId = id[4..];
            if (!jobs.List().Any(j => j.JobId == jobId && j.ConnectionId == target.ConnectionId)) return new LogKillResult(false, $"Job {jobId} is not running.");
            return new LogKillResult(jobs.Cancel(jobId), $"Job {jobId} was cancelled.");
        }
        if (id.StartsWith("stream:", StringComparison.Ordinal) && streams() is { } sm)
        {
            var streamId = id[7..];
            if (!sm.List().Any(s => s.StreamId == streamId && s.ConnectionId == target.ConnectionId)) return new LogKillResult(false, $"Stream {streamId} is not open.");
            return new LogKillResult(await sm.CloseAsync(streamId).ConfigureAwait(false), $"Stream {streamId} was closed.");
        }
        throw EngineException.Validation("id must be 'job:<id>' or 'stream:<id>'.", new { field = "id" });
    }
}
