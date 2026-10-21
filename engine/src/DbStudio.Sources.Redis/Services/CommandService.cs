using System.Diagnostics;
using System.Globalization;
using System.Text;
using DbStudio.Core.Services;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>
/// Workbench / CLI execution (docs/PLAN-M2.md 5.4). Raw lines are split with redis-cli quoting (<see cref="RedisArgs"/>).
/// Refused before anything runs: commands flagged <c>blocked</c> (MONITOR, SUBSCRIBE*, SYNC, PSYNC, QUIT, SHUTDOWN, AUTH...)
/// with 400 and a hint, and on read-only profiles every command that is not flagged <c>readonly</c> (403 READ_ONLY).
/// Ordinary commands run on the shared multiplexer (cluster routing by the first key); batches with MULTI/EXEC/WATCH or
/// blocking commands (BLPOP, XREAD BLOCK...) run on a dedicated connection so they cannot stall other users.
/// SELECT is tracked per request: later commands of the batch use the selected database, and the response says which.
/// </summary>
public sealed class CommandService
{
    public const int MaxCommands = 1000;

    /// <summary>Upper bound of one blocking command or dedicated batch.</summary>
    public static TimeSpan DedicatedTimeout { get; set; } = TimeSpan.FromMinutes(5);

    private static readonly RedisCommandCatalog Catalog = RedisCommandCatalog.Instance;

    public async Task<RedisCommandsResponse> ExecuteAsync(RedisClient c, RedisCommandsRequest req, CancellationToken ct)
    {
        var db = c.CheckDb(req.Db ?? c.Settings.Database);
        var lines = new List<(List<byte[]>? Args, string? ParseError)>();
        if (req.Raw is { } raw)
        {
            foreach (var line in raw)
            {
                try
                {
                    lines.Add((RedisArgs.Parse(line ?? ""), null));
                }
                catch (FormatException ex)
                {
                    lines.Add((null, ex.Message));
                }
            }
        }
        else if (req.Commands is { } commands)
        {
            foreach (var cmd in commands) lines.Add(((cmd ?? []).Select(a => Encoding.UTF8.GetBytes(a ?? "")).ToList(), null));
        }
        else throw EngineException.Validation("commands or raw is required.", new { field = "raw" });
        if (lines.Count == 0) throw EngineException.Validation("No command to run.", new { field = "raw" });
        if (lines.Count > MaxCommands) throw EngineException.Validation($"At most {MaxCommands} commands per request.", new { field = "raw" });

        var dedicated = false;
        foreach (var (args, _) in lines)
        {
            if (args is not { Count: > 0 }) continue;
            var words = Words(args);
            var spec = Catalog.Find(words);
            var name = Catalog.DisplayName(words);
            if (spec?.IsRefused == true || IsRefusedByName(name))
                throw EngineException.Validation(RefusalHint(name), new { field = "raw", command = name });
            if (c.ReadOnly && spec?.IsReadOnly != true)
                throw EngineException.ReadOnly(c.Profile.Name, $"{name} (only read commands run on a read-only connection)");
            if (spec is { IsBlocking: true } or { IsTransaction: true }) dedicated = true;
        }

        var results = dedicated
            ? await RunDedicatedAsync(c, db, lines, ct).ConfigureAwait(false)
            : await RunSharedAsync(c, db, lines, ct).ConfigureAwait(false);
        return new RedisCommandsResponse(results.Results, results.Db);
    }

    private static List<string> Words(List<byte[]> args) => args.Take(2).Select(a => Encoding.UTF8.GetString(a)).ToList();

    private static bool IsRefusedByName(string name) => name is "MONITOR" or "SUBSCRIBE" or "PSUBSCRIBE" or "SSUBSCRIBE" or "SYNC" or "PSYNC"
        or "QUIT" or "SHUTDOWN" or "UNSUBSCRIBE" or "PUNSUBSCRIBE";

    internal static string RefusalHint(string name) => name switch
    {
        "MONITOR" => "MONITOR cannot run here: open Info › Monitor, which streams it with a time limit.",
        "SUBSCRIBE" or "PSUBSCRIBE" or "SSUBSCRIBE" or "UNSUBSCRIBE" or "PUNSUBSCRIBE" => $"{name} cannot run here: use the Pub/Sub tab.",
        "QUIT" or "RESET" or "HELLO" or "AUTH" or "CLIENT SETNAME" or "READONLY" =>
            $"{name} would change the shared connection: DbStudio manages authentication and the connection itself (edit the connection instead).",
        _ => $"{name} cannot run in the Workbench or CLI (use the Pub/Sub or Slowlog tab, or redis-cli).",
    };

    private async Task<(List<RedisCommandResult> Results, int Db)> RunSharedAsync(RedisClient c, int db, List<(List<byte[]>? Args, string? ParseError)> lines, CancellationToken ct)
    {
        var results = new List<RedisCommandResult>(lines.Count);
        foreach (var (args, parseError) in lines)
        {
            ct.ThrowIfCancellationRequested();
            if (parseError is not null) { results.Add(Error(parseError, 0)); continue; }
            if (args is not { Count: > 0 }) { results.Add(Error("ERR empty command", 0)); continue; }
            var words = Words(args);
            var name = words[0].ToUpperInvariant();
            if (name == "SELECT")
            {
                results.Add(Select(c, args, ref db));
                continue;
            }
            var spec = Catalog.Find(words);
            var sw = Stopwatch.StartNew();
            try
            {
                var payload = Arguments(args, spec);
                var reply = await c.Db(db).ExecuteAsync(words[0], payload).WaitAsync(ct).ConfigureAwait(false);
                results.Add(Convert(reply, sw.ElapsedMilliseconds));
            }
            catch (RedisServerException ex)
            {
                results.Add(Error(ex.Message, sw.ElapsedMilliseconds));
            }
            catch (RedisCommandException ex)
            {
                results.Add(Error($"ERR {ex.Message}", sw.ElapsedMilliseconds));
            }
            catch (Exception ex) when (RedisErrors.Map(ex) is { } mapped && mapped.Code == ErrorCodes.SourceUnavailable)
            {
                throw mapped;
            }
        }
        return (results, db);
    }

    private static RedisCommandResult Select(RedisClient c, List<byte[]> args, ref int db)
    {
        if (args.Count != 2 || !int.TryParse(Encoding.UTF8.GetString(args[1]), NumberStyles.None, CultureInfo.InvariantCulture, out var next))
            return Error("ERR wrong number of arguments for 'select' command", 0);
        if (c.IsCluster && next != 0) return Error("ERR SELECT is not allowed in cluster mode", 0);
        if (next >= c.Databases) return Error("ERR DB index is out of range", 0);
        db = next;
        return new RedisCommandResult(true, "simple", "OK", 0);
    }

    /// <summary>Arguments after the command word; the first key becomes a RedisKey so the cluster routes it.</summary>
    private static object[] Arguments(List<byte[]> args, RedisCommandSpec? spec)
    {
        var keyIndex = spec?.FirstKeyIndex ?? -1;
        var payload = new object[args.Count - 1];
        for (var i = 1; i < args.Count; i++) payload[i - 1] = i == keyIndex ? (RedisKey)args[i] : (RedisValue)args[i];
        return payload;
    }

    private static async Task<(List<RedisCommandResult> Results, int Db)> RunDedicatedAsync(RedisClient c, int db, List<(List<byte[]>? Args, string? ParseError)> lines, CancellationToken ct)
    {
        // Route by the first key of the batch (cluster), else the primary.
        string? routeKey = null;
        foreach (var (args, _) in lines)
        {
            if (args is not { Count: > 0 }) continue;
            var spec = Catalog.Find(Words(args));
            if (spec?.FirstKeyIndex is > 0 and var i && i < args.Count) { routeKey = Encoding.UTF8.GetString(args[i]); break; }
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(DedicatedTimeout);
        await using var conn = await c.OpenDedicatedAsync(c.ServerFor(routeKey), db, timeout.Token).ConfigureAwait(false);
        var results = new List<RedisCommandResult>(lines.Count);
        foreach (var (args, parseError) in lines)
        {
            if (parseError is not null) { results.Add(Error(parseError, 0)); continue; }
            if (args is not { Count: > 0 }) { results.Add(Error("ERR empty command", 0)); continue; }
            var sw = Stopwatch.StartNew();
            var reply = await conn.CommandAsync(args, timeout.Token).ConfigureAwait(false);
            if (Encoding.UTF8.GetString(args[0]).Equals("SELECT", StringComparison.OrdinalIgnoreCase) && !reply.IsError
                && int.TryParse(Encoding.UTF8.GetString(args[1]), NumberStyles.None, CultureInfo.InvariantCulture, out var next))
                db = next;
            results.Add(Convert(reply, sw.ElapsedMilliseconds));
        }
        return (results, db);
    }

    internal static RedisCommandResult Error(string message, long elapsed) => new(false, "error", message, elapsed);

    internal static RedisCommandResult Convert(RedisResult r, long elapsed)
    {
        if (r.Resp2Type == ResultType.Error) return Error(r.ToString() ?? "ERR", elapsed);
        var (type, value) = Wire(r);
        return new RedisCommandResult(true, type, value, elapsed);
    }

    internal static (string Type, object? Value) Wire(RedisResult r)
    {
        if (r.IsNull) return ("null", null);
        return r.Resp2Type switch
        {
            ResultType.SimpleString => ("simple", r.ToString()),
            ResultType.Integer => ("int", (long)r),
            ResultType.BulkString => ("bulk", RedisArgs.ToDisplay((byte[]?)r ?? [])),
            ResultType.Array => ("array", ((RedisResult[])r!).Select(x => Wire(x).Value).ToList()),
            ResultType.Error => ("error", r.ToString()),
            _ => ("bulk", r.ToString()),
        };
    }

    internal static RedisCommandResult Convert(RespValue r, long elapsed) => r.Type switch
    {
        RespType.Error => Error(r.Text ?? "ERR", elapsed),
        _ => new RedisCommandResult(true, WireType(r), WireValue(r), elapsed),
    };

    private static string WireType(RespValue r) => r.Type switch
    {
        RespType.Simple => "simple",
        RespType.Integer => "int",
        RespType.Bulk => "bulk",
        RespType.Array => "array",
        RespType.Null => "null",
        _ => "error",
    };

    private static object? WireValue(RespValue r) => r.Type switch
    {
        RespType.Null => null,
        RespType.Integer => r.Integer,
        RespType.Array => r.Items!.Select(WireValue).ToList(),
        RespType.Bulk => RedisArgs.ToDisplay(r.Bytes ?? []),
        _ => r.Text,
    };
}
