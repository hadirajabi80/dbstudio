using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Providers.Mongo;

/// <summary>
/// MongoDB (docs/PLAN-M2.md 8.1): <c>getLog</c> (global log ring, JSON lines 4.4+ and legacy text), <c>profiler:&lt;db&gt;</c>
/// (system.profile, profiling level hint), <c>changes</c> (cluster change stream, live only) and activity ($currentOp,
/// killOp).
/// </summary>
public sealed partial class MongoLogSource(IMongoLogGateway gateway) : ILogSource, IActivitySource
{
    public const string GetLog = "getLog", ProfilerPrefix = "profiler:", Changes = "changes", Activity = "activity";

    public string ProviderId => "mongodb";

    public static string RoleNeeds(string? user, string role) =>
        $"db.getSiblingDB(\"admin\").grantRolesToUser(\"{(string.IsNullOrEmpty(user) ? "<user>" : user)}\", [{{ role: \"{role}\", db: \"admin\" }}])";

    private static string? UserOf(LogTarget t)
    {
        if (t.Profile?.GetString("user") is { Length: > 0 } u) return u;
        var uri = t.Profile?.GetString("uri") ?? "";
        var m = Regex.Match(uri, @"^mongodb(?:\+srv)?://([^:@/]+)(?::[^@/]*)?@");
        return m.Success ? Uri.UnescapeDataString(m.Groups[1].Value) : null;
    }

    public async Task<IReadOnlyList<LogSourceInfo>> ListAsync(LogTarget target, CancellationToken ct)
    {
        var user = UserOf(target);
        var levels = LogLevels.Standard;
        var getLog = new LogSourceInfo(GetLog, "Server log (getLog)", "log", true, true, levels, true);
        var changes = new LogSourceInfo(Changes, "Change stream", "log", true, false, [LogLevels.Info], true);
        var activity = new LogSourceInfo(Activity, "Current operations", "activity", false, false, [], true);
        var list = new List<LogSourceInfo>();
        try
        {
            await gateway.RunCommandAsync(target, "admin", """{"getLog": "startupWarnings"}""", ct).ConfigureAwait(false);
        }
        catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
        {
            getLog = getLog.Unavailable("Reading the server log requires the clusterMonitor role.", RoleNeeds(user, "clusterMonitor"));
        }
        try
        {
            var hello = await gateway.RunCommandAsync(target, "admin", """{"hello": 1}""", ct).ConfigureAwait(false);
            if (!hello.TryGetProperty("setName", out _) && !(hello.TryGetProperty("msg", out var msg) && msg.GetString() == "isdbgrid"))
                changes = changes.Unavailable("Change streams need a replica set or a sharded cluster.", null);
        }
        catch (MongoCommandFailure ex)
        {
            changes = changes.Unavailable(ex.Message, null);
        }
        list.Add(getLog);
        foreach (var db in await DatabasesAsync(target, ct).ConfigureAwait(false))
        {
            var info = new LogSourceInfo(ProfilerPrefix + db, $"Profiler — {db}", "log", true, true, [LogLevels.Info, LogLevels.Warn, LogLevels.Error], true);
            try
            {
                var p = await gateway.RunCommandAsync(target, db, """{"profile": -1}""", ct).ConfigureAwait(false);
                var was = p.TryGetProperty("was", out var w) ? w.GetInt32() : 0;
                var slowms = p.TryGetProperty("slowms", out var s) ? s.GetInt32() : 100;
                if (was == 0)
                    info = info with { Reason = "Profiling is off (level 0) for this database.", Needs = $"db.getSiblingDB(\"{db}\").setProfilingLevel(1, {{ slowms: {slowms} }})" };
            }
            catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
            {
                info = info.Unavailable("Reading the profiler requires the dbAdmin role on the database.", $"db.getSiblingDB(\"admin\").grantRolesToUser(\"{user ?? "<user>"}\", [{{ role: \"dbAdmin\", db: \"{db}\" }}])");
            }
            catch (MongoCommandFailure ex)
            {
                info = info.Unavailable(ex.Message, null);
            }
            list.Add(info);
        }
        list.Add(changes);
        try
        {
            await gateway.RunCommandAsync(target, "admin", """{"aggregate": 1, "pipeline": [{"$currentOp": {"allUsers": true, "idleConnections": false}}, {"$limit": 1}], "cursor": {}}""", ct).ConfigureAwait(false);
        }
        catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
        {
            activity = activity with { Reason = "Without the inprog privilege only your own operations are visible.", Needs = RoleNeeds(user, "clusterMonitor") };
        }
        list.Add(activity);
        return list;
    }

    private async Task<List<string>> DatabasesAsync(LogTarget target, CancellationToken ct)
    {
        var fallback = target.Profile?.GetString("database") is { Length: > 0 } d ? new List<string> { d } : [];
        try
        {
            var r = await gateway.RunCommandAsync(target, "admin", """{"listDatabases": 1, "nameOnly": true}""", ct).ConfigureAwait(false);
            if (!r.TryGetProperty("databases", out var dbs)) return fallback;
            var names = dbs.EnumerateArray().Select(x => x.GetProperty("name").GetString() ?? "")
                .Where(n => n is not ("" or "admin" or "local" or "config")).Take(20).ToList();
            return names.Count > 0 ? names : fallback;
        }
        catch (MongoCommandFailure)
        {
            return fallback;
        }
    }

    public async Task<LogQueryResponse> QueryAsync(LogTarget target, LogQuery query, CancellationToken ct)
    {
        var user = UserOf(target);
        try
        {
            if (query.SourceId == GetLog)
            {
                var r = await gateway.RunCommandAsync(target, "admin", """{"getLog": "global"}""", ct).ConfigureAwait(false);
                var (entries, truncated) = ParseGetLog(r);
                return LogFilter.Page(entries, query, truncated);
            }
            if (query.SourceId is { } id && id.StartsWith(ProfilerPrefix, StringComparison.Ordinal))
            {
                var db = id[ProfilerPrefix.Length..];
                if (db.Length == 0 || db.Contains('"') || db.Contains('\\') || db.Contains('$'))
                    throw EngineException.Validation("Invalid profiler database.", new { field = "sourceId" });
                var r = await gateway.RunCommandAsync(target, db, ProfilerCommand(query), ct).ConfigureAwait(false);
                return LogFilter.Page(ParseProfiler(FirstBatch(r)), query);
            }
            if (query.SourceId == Changes)
                throw EngineException.Validation("The change stream is a live source: open a logs.tail stream instead.", new { field = "sourceId" });
        }
        catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
        {
            throw EngineException.Privilege(ex.Message, query.SourceId == GetLog ? RoleNeeds(user, "clusterMonitor") : RoleNeeds(user, "dbAdminAnyDatabase"));
        }
        throw SqlServer.SqlServerLogSource.UnknownSource(query.SourceId);
    }

    /// <summary><c>find system.profile</c>, newest first, with the time range and before/after cursors as <c>ts</c> bounds.</summary>
    public static string ProfilerCommand(LogQuery q)
    {
        var (from, to) = SqlServer.SqlServerLogSource.Range(q);
        var ts = new List<string>();
        if (from.Year > 1900) ts.Add($"\"$gte\": {{\"$date\": \"{TimeSeq.Iso(new DateTimeOffset(from, TimeSpan.Zero))}\"}}");
        if (to.Year < 9999) ts.Add($"\"$lte\": {{\"$date\": \"{TimeSeq.Iso(new DateTimeOffset(to, TimeSpan.Zero))}\"}}");
        var filter = ts.Count == 0 ? "{}" : $"{{\"ts\": {{{string.Join(", ", ts)}}}}}";
        var limit = Math.Min(LogFilter.LimitOf(q) * (q.Levels is { Count: > 0 } || q.Q is not null ? 4 : 1) + 1, 20_000);
        return $"{{\"find\": \"system.profile\", \"filter\": {filter}, \"sort\": {{\"ts\": -1}}, \"limit\": {limit}, \"singleBatch\": true}}";
    }

    public static JsonElement FirstBatch(JsonElement reply) =>
        reply.TryGetProperty("cursor", out var c) && c.TryGetProperty("firstBatch", out var b) ? b : default;

    // ---- Parsers

    /// <summary>Severity letter of the 4.4+ JSON log (F, E, W, I, D1–D5).</summary>
    public static string LevelOf(string? s) => s switch
    {
        "F" => LogLevels.Fatal,
        "E" => LogLevels.Error,
        "W" => LogLevels.Warn,
        "I" => LogLevels.Info,
        { Length: > 0 } d when d[0] == 'D' => LogLevels.Debug,
        _ => LogLevels.Unknown,
    };

    [GeneratedRegex(@"^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(?<s>[FEWID]\d?)\s+(?<c>\S+)\s+\[(?<ctx>[^\]]*)\]\s?(?<msg>.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex LegacyLine();

    /// <summary><c>{ getLog: "global" }</c> reply → entries (JSON lines of 4.4+, legacy text lines of older servers).</summary>
    public static (List<LogEntry> Entries, bool Truncated) ParseGetLog(JsonElement reply)
    {
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        var lines = reply.TryGetProperty("log", out var log) ? log.EnumerateArray().Select(l => l.GetString() ?? "").ToList() : [];
        foreach (var line in lines)
        {
            if (ParseLogLine(line) is { } e) list.Add(e with { Seq = seq.Next(e.Time) });
        }
        var total = reply.TryGetProperty("totalLinesWritten", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : lines.Count;
        return (list, total > lines.Count);
    }

    public static LogEntry? ParseLogLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        if (line.TrimStart().StartsWith('{'))
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var o = doc.RootElement;
                var ts = o.TryGetProperty("t", out var t) ? Ejson.DateText(t) : null;
                var s = o.TryGetProperty("s", out var sv) ? sv.GetString() : null;
                var c = o.TryGetProperty("c", out var cv) ? cv.GetString() ?? "" : "";
                var msg = o.TryGetProperty("msg", out var mv) ? mv.GetString() ?? "" : "";
                var fields = new Dictionary<string, string>(StringComparer.Ordinal) { ["component"] = c };
                if (o.TryGetProperty("id", out var id)) fields["id"] = id.GetRawText();
                if (o.TryGetProperty("ctx", out var ctx)) fields["ctx"] = ctx.GetString() ?? "";
                string? detail = null;
                if (o.TryGetProperty("attr", out var attr) && attr.ValueKind == JsonValueKind.Object)
                {
                    detail = attr.GetRawText();
                    foreach (var p in attr.EnumerateObject().Take(12))
                        if (p.Value.ValueKind is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                            fields["attr." + p.Name] = p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString()! : p.Value.GetRawText();
                    if (attr.TryGetProperty("durationMillis", out var dm)) msg += $" ({dm.GetRawText()} ms)";
                }
                return new LogEntry(ts, LevelOf(s), c, msg, 0, detail, fields);
            }
            catch (JsonException)
            {
                return new LogEntry(null, LogLevels.Unknown, "mongod", line, 0);
            }
        }
        var m = LegacyLine().Match(line);
        if (!m.Success) return new LogEntry(null, LogLevels.Unknown, "mongod", line, 0);
        var legacyTs = DateTimeOffset.TryParse(m.Groups["ts"].Value.Length > 24 && m.Groups["ts"].Value[^5] is '+' or '-' ? m.Groups["ts"].Value.Insert(m.Groups["ts"].Value.Length - 2, ":") : m.Groups["ts"].Value,
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var lt) ? TimeSeq.Iso(lt) : null;
        return new LogEntry(legacyTs, LevelOf(m.Groups["s"].Value), m.Groups["c"].Value, m.Groups["msg"].Value, 0, null,
            new Dictionary<string, string> { ["component"] = m.Groups["c"].Value, ["ctx"] = m.Groups["ctx"].Value });
    }

    /// <summary>system.profile documents (newest first) → entries ascending; level by millis (≥ 1 s error, ≥ 100 ms warn).</summary>
    public static List<LogEntry> ParseProfiler(JsonElement docs)
    {
        if (docs.ValueKind != JsonValueKind.Array) return [];
        var all = docs.EnumerateArray().ToList();
        all.Reverse();
        var seq = new TimeSeq();
        var list = new List<LogEntry>();
        foreach (var d in all)
        {
            var ts = d.TryGetProperty("ts", out var t) ? Ejson.DateText(t) : null;
            var op = Ejson.Text(d, "op") ?? "op";
            var ns = Ejson.Text(d, "ns") ?? "";
            var millis = d.TryGetProperty("millis", out var m) ? Ejson.Number(m) : 0;
            var fields = new Dictionary<string, string>
            {
                ["op"] = op, ["ns"] = ns, ["millis"] = millis.ToString(CultureInfo.InvariantCulture),
            };
            foreach (var k in new[] { "planSummary", "keysExamined", "docsExamined", "nreturned", "user", "appName", "client", "responseLength" })
                if (d.TryGetProperty(k, out var v)) fields[k] = v.ValueKind == JsonValueKind.String ? v.GetString()! : Ejson.Number(v).ToString(CultureInfo.InvariantCulture);
            var command = d.TryGetProperty("command", out var c) ? c.GetRawText() : null;
            var plan = fields.GetValueOrDefault("planSummary");
            var level = millis >= 1000 ? LogLevels.Error : millis >= 100 || plan == "COLLSCAN" ? LogLevels.Warn : LogLevels.Info;
            var tsValue = ts is null ? (DateTimeOffset?)null : DateTimeOffset.Parse(ts, CultureInfo.InvariantCulture);
            list.Add(new LogEntry(ts, level, ns, $"{op} {ns} {millis.ToString(CultureInfo.InvariantCulture)} ms" + (plan is null ? "" : $" {plan}"),
                seq.Next(tsValue), command, fields));
        }
        return list;
    }

    /// <summary>A change event → entry (<c>{ operationType, ns: { db, coll }, documentKey, clusterTime, wallTime }</c>).</summary>
    public static LogEntry ParseChange(JsonElement ev, TimeSeq seq)
    {
        var op = Ejson.Text(ev, "operationType") ?? "change";
        var ns = ev.TryGetProperty("ns", out var n) ? $"{Ejson.Text(n, "db")}.{Ejson.Text(n, "coll")}".TrimEnd('.') : "";
        var ts = ev.TryGetProperty("wallTime", out var w) ? Ejson.DateText(w)
            : ev.TryGetProperty("clusterTime", out var ct) && ct.TryGetProperty("$timestamp", out var tsv) && tsv.TryGetProperty("t", out var secs)
                ? TimeSeq.Iso(DateTimeOffset.FromUnixTimeSeconds(secs.GetInt64())) : null;
        var key = ev.TryGetProperty("documentKey", out var k) ? k.GetRawText() : "";
        var fields = new Dictionary<string, string> { ["operationType"] = op, ["ns"] = ns };
        if (key.Length > 0) fields["documentKey"] = key;
        var detail = ev.TryGetProperty("updateDescription", out var u) ? u.GetRawText() : ev.TryGetProperty("fullDocument", out var fd) ? fd.GetRawText() : null;
        var level = op is "drop" or "dropDatabase" or "invalidate" ? LogLevels.Warn : LogLevels.Info;
        return new LogEntry(ts, level, ns.Length > 0 ? ns : "changes", $"{op} {ns} {key}".Trim(), seq.Next(ts is null ? null : DateTimeOffset.Parse(ts, CultureInfo.InvariantCulture)), detail, fields);
    }

    public IAsyncEnumerable<LogEntry>? OpenLive(LogTarget target, string sourceId, CancellationToken ct) =>
        sourceId == Changes ? ChangeEntries(target, ct) : null;

    /// <summary>Cluster-wide change stream through aggregate + getMore (maxTimeMS 1 s so cancellation is prompt).</summary>
    private async IAsyncEnumerable<LogEntry> ChangeEntries(LogTarget target, [EnumeratorCancellation] CancellationToken ct)
    {
        var seq = new TimeSeq();
        var first = await gateway.RunCommandAsync(target, "admin",
            """{"aggregate": 1, "pipeline": [{"$changeStream": {"allChangesForCluster": true}}], "cursor": {}}""", ct).ConfigureAwait(false);
        var cursor = first.GetProperty("cursor");
        foreach (var ev in cursor.GetProperty("firstBatch").EnumerateArray()) yield return ParseChange(ev, seq);
        var id = cursor.GetProperty("id").ToString();
        while (!ct.IsCancellationRequested && id != "0")
        {
            var more = await gateway.RunCommandAsync(target, "admin",
                $$"""{"getMore": {"$numberLong": "{{id}}"}, "collection": "$cmd.aggregate", "maxTimeMS": 1000}""", ct).ConfigureAwait(false);
            var c = more.GetProperty("cursor");
            id = c.GetProperty("id").ToString();
            foreach (var ev in c.GetProperty("nextBatch").EnumerateArray()) yield return ParseChange(ev, seq);
        }
    }

    // ---- Activity

    public const string CurrentOpCommand =
        """{"aggregate": 1, "pipeline": [{"$currentOp": {"allUsers": true, "idleConnections": false}}, {"$limit": 500}], "cursor": {}}""";

    public async Task<IReadOnlyList<ActivityRow>> SnapshotAsync(LogTarget target, CancellationToken ct)
    {
        JsonElement r;
        try
        {
            r = await gateway.RunCommandAsync(target, "admin", CurrentOpCommand, ct).ConfigureAwait(false);
        }
        catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
        {
            // Without inprog, $currentOp still lists the caller's own operations.
            r = await gateway.RunCommandAsync(target, "admin", CurrentOpCommand.Replace("\"allUsers\": true", "\"allUsers\": false"), ct).ConfigureAwait(false);
        }
        return ParseCurrentOp(FirstBatch(r));
    }

    public static List<ActivityRow> ParseCurrentOp(JsonElement ops)
    {
        var rows = new List<ActivityRow>();
        if (ops.ValueKind != JsonValueKind.Array) return rows;
        foreach (var o in ops.EnumerateArray())
        {
            if (!o.TryGetProperty("opid", out var opidEl)) continue;
            var opid = opidEl.ValueKind == JsonValueKind.String ? opidEl.GetString()! : Ejson.Number(opidEl).ToString(CultureInfo.InvariantCulture);
            var active = o.TryGetProperty("active", out var a) && a.ValueKind == JsonValueKind.True;
            var micros = o.TryGetProperty("microsecs_running", out var mr) ? Ejson.Number(mr) : (double?)null;
            var user = o.TryGetProperty("effectiveUsers", out var eu) && eu.ValueKind == JsonValueKind.Array && eu.GetArrayLength() > 0 ? Ejson.Text(eu[0], "user") : null;
            var ns = Ejson.Text(o, "ns");
            var desc = Ejson.Text(o, "desc");
            var waiting = o.TryGetProperty("waitingForLock", out var wl) && wl.ValueKind == JsonValueKind.True;
            var fields = new Dictionary<string, string> { ["opid"] = opid, ["killStatement"] = $"db.killOp({(opidEl.ValueKind == JsonValueKind.String ? $"\"{opid}\"" : opid)})" };
            if (desc is not null) fields["desc"] = desc;
            if (Ejson.Text(o, "planSummary") is { } plan) fields["planSummary"] = plan;
            if (o.TryGetProperty("numYields", out var ny)) fields["numYields"] = Ejson.Number(ny).ToString(CultureInfo.InvariantCulture);
            var system = desc is not null && !desc.StartsWith("conn", StringComparison.Ordinal);
            rows.Add(new ActivityRow
            {
                Id = opid,
                Kind = "op",
                User = user,
                Host = Ejson.Text(o, "client") ?? Ejson.Text(o, "client_s"),
                App = Ejson.Text(o, "appName"),
                Database = ns?.Split('.', 2)[0],
                State = waiting ? "waiting for lock" : active ? "active" : "idle",
                Since = o.TryGetProperty("currentOpTime", out var cot) ? Ejson.DateText(cot) : null,
                DurationMs = micros is { } us ? (long)(us / 1000) : null,
                WaitType = waiting ? "lock" : o.TryGetProperty("waitingForFlowControl", out var fc) && fc.ValueKind == JsonValueKind.True ? "flowControl" : null,
                Command = Ejson.Text(o, "op"),
                Text = o.TryGetProperty("command", out var c) ? c.GetRawText() : null,
                CanKill = !system,
                Fields = fields,
            });
        }
        return rows;
    }

    public async Task<LogKillResult> KillAsync(LogTarget target, LogKillRequest request, CancellationToken ct)
    {
        var id = request.Id ?? "";
        string opLiteral;
        if (long.TryParse(id, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var n)) opLiteral = n.ToString(CultureInfo.InvariantCulture);
        else if (Regex.IsMatch(id, @"^[A-Za-z0-9_.\-]+:\d+$")) opLiteral = $"\"{id}\""; // sharded: "shard01:12345"
        else throw EngineException.Validation("id must be an operation id.", new { field = "id" });
        try
        {
            var r = await gateway.RunCommandAsync(target, "admin", $"{{\"killOp\": 1, \"op\": {opLiteral}}}", ct).ConfigureAwait(false);
            var ok = r.TryGetProperty("ok", out var okEl) && Ejson.Number(okEl) == 1;
            return new LogKillResult(ok, ok ? $"Operation {id} was killed." : r.GetRawText());
        }
        catch (MongoCommandFailure ex) when (ex.IsUnauthorized)
        {
            throw EngineException.Privilege(ex.Message, RoleNeeds(UserOf(target), "clusterManager"));
        }
    }
}

/// <summary>Relaxed / canonical Extended JSON helpers.</summary>
public static class Ejson
{
    public static string? Text(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) ? v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            _ => v.GetRawText(),
        } : null;

    /// <summary>Number of a plain or wrapped value (<c>{"$numberLong": "5"}</c>, <c>{"$numberInt"}</c>, <c>{"$numberDouble"}</c>).</summary>
    public static double Number(JsonElement v)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.Number: return v.GetDouble();
            case JsonValueKind.String: return double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var s) ? s : 0;
            case JsonValueKind.Object:
                foreach (var p in v.EnumerateObject())
                    if (p.Name is "$numberLong" or "$numberInt" or "$numberDouble" or "$numberDecimal") return Number(p.Value);
                return 0;
            default: return 0;
        }
    }

    /// <summary>ISO text of a date (<c>{"$date": "…"}</c>, <c>{"$date": {"$numberLong": "ms"}}</c>, plain string).</summary>
    public static string? DateText(JsonElement v)
    {
        if (v.ValueKind == JsonValueKind.String)
            return DateTimeOffset.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var s) ? TimeSeq.Iso(s) : v.GetString();
        if (v.ValueKind != JsonValueKind.Object || !v.TryGetProperty("$date", out var d)) return null;
        if (d.ValueKind == JsonValueKind.String) return DateText(d);
        return TimeSeq.Iso(DateTimeOffset.FromUnixTimeMilliseconds((long)Number(d)));
    }
}
