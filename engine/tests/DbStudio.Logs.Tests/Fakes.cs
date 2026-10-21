using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Logs.Providers.Mongo;
using DbStudio.Logs.Providers.Redis;
using DbStudio.Logs.Sql;

namespace DbStudio.Logs.Tests;

/// <summary>Records every SQL batch and answers with the first matching scripted reply.</summary>
internal sealed class FakeSqlRunner : ISqlRunner, ISqlRunnerFactory
{
    private readonly List<(Func<string, bool> Match, Func<string, IReadOnlyList<SqlRowSet>> Reply)> _replies = [];
    public readonly List<string> Sql = [];

    public FakeSqlRunner On(string contains, params SqlRowSet[] sets)
    {
        _replies.Add((s => s.Contains(contains, StringComparison.Ordinal), _ => sets));
        return this;
    }

    public FakeSqlRunner OnFail(string contains, string code, string message, int? providerCode = null)
    {
        _replies.Add((s => s.Contains(contains, StringComparison.Ordinal), _ => throw new SqlQueryException(new ErrorInfo(code, message, ProviderCode: providerCode))));
        return this;
    }

    public FakeSqlRunner On(Func<string, bool> match, Func<string, IReadOnlyList<SqlRowSet>> reply)
    {
        _replies.Add((match, reply));
        return this;
    }

    public Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
    {
        Sql.Add(sql);
        foreach (var (match, reply) in _replies)
            if (match(sql)) return Task.FromResult(reply(sql));
        return Task.FromResult<IReadOnlyList<SqlRowSet>>([SqlRowSet.Of([])]);
    }

    public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => Task.FromResult<ISqlRunner>(this);
}

internal static class Rows
{
    public static SqlRowSet Set(string[] columns, params object?[][] rows) => SqlRowSet.Of(columns, rows);

    public static object?[] R(params object?[] values) => values;

    public static LogTarget Target(string provider, string id = "c1", bool readOnly = false, Dictionary<string, JsonNode?>? props = null) =>
        new(id, new ConnectionProfile { Id = id, Name = "Test " + provider, ProviderId = provider, ReadOnly = readOnly, Props = props ?? [] });

    public static string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));
}

/// <summary>Scripted Mongo gateway: replies by the command's first key (and database), records commands.</summary>
internal sealed class FakeMongoGateway : IMongoLogGateway
{
    public readonly List<(string Db, string Command)> Calls = [];
    private readonly Dictionary<string, Func<string, string, JsonElement>> _replies = new(StringComparer.Ordinal);

    public FakeMongoGateway On(string firstKey, string json)
    {
        _replies[firstKey] = (_, _) => JsonDocument.Parse(json).RootElement.Clone();
        return this;
    }

    public FakeMongoGateway OnFail(string firstKey, int code, string codeName, string message = "not authorized")
    {
        _replies[firstKey] = (_, _) => throw new MongoCommandFailure(code, codeName, message);
        return this;
    }

    public FakeMongoGateway On(string firstKey, Func<string, string, JsonElement> reply)
    {
        _replies[firstKey] = reply;
        return this;
    }

    public Task<JsonElement> RunCommandAsync(LogTarget target, string database, string commandJson, CancellationToken ct)
    {
        Calls.Add((database, commandJson));
        using var doc = JsonDocument.Parse(commandJson);
        var key = doc.RootElement.EnumerateObject().First().Name;
        return _replies.TryGetValue(key, out var r) ? Task.FromResult(r(database, commandJson)) : Task.FromResult(JsonDocument.Parse("""{"ok": 1}""").RootElement.Clone());
    }
}

/// <summary>
/// Minimal RESP2 server over loopback TCP: replies per command (upper-cased "CMD SUB") from a script, records commands,
/// supports AUTH and MONITOR (pushes the scripted lines, then keeps the connection open).
/// </summary>
internal sealed class FakeRespServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<string, Func<string[], RespValue>> _replies = new(StringComparer.OrdinalIgnoreCase);
    public readonly ConcurrentQueue<string[]> Commands = new();
    public string? Password;
    public List<string> MonitorLines = [];

    public FakeRespServer()
    {
        _listener.Start();
        _ = AcceptLoop();
        On("CLIENT SETNAME", new RespValue(RespType.Simple, "OK"));
        On("CLIENT ID", RespValue.Int(99));
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public FakeRespServer On(string command, RespValue reply)
    {
        _replies[command] = _ => reply;
        return this;
    }

    public FakeRespServer On(string command, Func<string[], RespValue> reply)
    {
        _replies[command] = reply;
        return this;
    }

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch { return; }
            _ = Serve(client);
        }
    }

    private async Task Serve(TcpClient client)
    {
        using var _ = client;
        var stream = client.GetStream();
        var reader = new RespReader(stream);
        var authed = Password is null;
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var req = await Resp.ReadAsync(reader, _cts.Token);
                var args = req.Array.Select(a => a.AsString() ?? "").ToArray();
                Commands.Enqueue(args);
                var name = args[0].ToUpperInvariant();
                RespValue reply;
                if (name == "AUTH")
                {
                    authed = args[^1] == Password;
                    reply = authed ? new RespValue(RespType.Simple, "OK") : RespValue.Err("WRONGPASS invalid username-password pair or user is disabled.");
                }
                else if (!authed) reply = RespValue.Err("NOAUTH Authentication required.");
                else if (name == "MONITOR")
                {
                    await stream.WriteAsync(Resp.EncodeReply(new RespValue(RespType.Simple, "OK")));
                    foreach (var l in MonitorLines) await stream.WriteAsync(Resp.EncodeReply(new RespValue(RespType.Simple, l)));
                    await Task.Delay(Timeout.Infinite, _cts.Token);
                    return;
                }
                else
                {
                    var key2 = args.Length > 1 ? $"{name} {args[1].ToUpperInvariant()}" : name;
                    reply = _replies.TryGetValue(key2, out var r2) ? r2(args) : _replies.TryGetValue(name, out var r1) ? r1(args) : RespValue.Err($"ERR unknown command '{args[0]}'");
                }
                await stream.WriteAsync(Resp.EncodeReply(reply));
            }
        }
        catch
        {
            // client went away
        }
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _listener.Stop();
        return ValueTask.CompletedTask;
    }
}

/// <summary>In-memory secret store.</summary>
internal sealed class MemorySecrets : ISecretStore
{
    private readonly ConcurrentDictionary<string, string> _s = new();
    public string? Get(string profileId) => _s.GetValueOrDefault(profileId);
    public void Set(string profileId, string secret, bool persist) => _s[profileId] = secret;
    public void Remove(string profileId) => _s.TryRemove(profileId, out _);
    public bool Has(string profileId) => _s.ContainsKey(profileId);
}

/// <summary>Records published events.</summary>
internal sealed class Recorder : IEventPublisher
{
    public readonly ConcurrentQueue<EngineEvent> Events = new();
    public void Publish(EngineEvent ev) => Events.Enqueue(ev);

    public List<JsonElement> Items(string streamId) =>
        Events.OfType<StreamDataEvent>().Where(e => e.StreamId == streamId).SelectMany(e => e.Items).ToList();
}

internal static class Wait
{
    public static async Task Until(Func<bool> condition, int timeoutMs = 10_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("Condition not met in time.");
            await Task.Delay(20);
        }
    }
}
