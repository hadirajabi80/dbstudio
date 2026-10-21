using System.Collections.Frozen;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DbStudio.Sources.Redis;

/// <summary>One entry of <c>Commands/redis-commands.json</c> (shared with the UI copy in <c>ui/src/redis/</c>).</summary>
/// <param name="Name">Upper case; container sub-commands are two words ("CONFIG GET").</param>
/// <param name="Flags">
/// <c>readonly</c> (no side effects: allowed on read-only connections), <c>write</c>, <c>admin</c>, <c>blocking</c>
/// (runs on a dedicated connection), <c>transaction</c> (MULTI/EXEC/WATCH: the batch runs on a dedicated connection),
/// <c>blocked</c> (refused by the Workbench/CLI: MONITOR, SUBSCRIBE, AUTH...), <c>dangerous</c>, <c>pubsub</c>, <c>module</c>.
/// </param>
/// <param name="Keys">[first, last, step] argument positions of key names (1 = first argument; last -1 = to the end).</param>
public sealed record RedisCommandSpec(
    string Name, string Group, string Summary, string Syntax, string Since, string Complexity, int Arity,
    IReadOnlyList<string> Flags, IReadOnlyList<int>? Keys)
{
    [JsonIgnore] public bool IsReadOnly => Flags.Contains("readonly");
    [JsonIgnore] public bool IsBlocking => Flags.Contains("blocking");
    [JsonIgnore] public bool IsTransaction => Flags.Contains("transaction");
    [JsonIgnore] public bool IsRefused => Flags.Contains("blocked");

    /// <summary>Number of words of the name (1, or 2 for container sub-commands).</summary>
    [JsonIgnore] public int Words => Name.Contains(' ') ? 2 : 1;

    /// <summary>The argument index (0 = the command word; sub-command words count) of the first key, or -1.</summary>
    [JsonIgnore] public int FirstKeyIndex => Keys is { Count: > 0 } k ? k[0] : -1;
}

/// <summary>The Redis command table: docs, flags (read-only enforcement), key positions (cluster routing).</summary>
public sealed class RedisCommandCatalog
{
    private static readonly Lazy<RedisCommandCatalog> Shared = new(Load);

    public static RedisCommandCatalog Instance => Shared.Value;

    private readonly FrozenDictionary<string, RedisCommandSpec> _byName;

    public IReadOnlyList<RedisCommandSpec> All { get; }

    /// <summary>First words that have sub-commands ("CONFIG", "CLIENT", "XGROUP"...).</summary>
    public FrozenSet<string> Containers { get; }

    private RedisCommandCatalog(IReadOnlyList<RedisCommandSpec> all)
    {
        All = all;
        _byName = all.ToFrozenDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
        Containers = all.Where(c => c.Words == 2).Select(c => c.Name[..c.Name.IndexOf(' ')]).ToFrozenSet(StringComparer.OrdinalIgnoreCase);
    }

    private static RedisCommandCatalog Load()
    {
        using var stream = typeof(RedisCommandCatalog).Assembly.GetManifestResourceStream("DbStudio.Sources.Redis.redis-commands.json")
            ?? throw new InvalidOperationException("The Redis command table resource is missing.");
        var list = JsonSerializer.Deserialize<List<RedisCommandSpec>>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("The Redis command table is empty.");
        return new RedisCommandCatalog(list);
    }

    public RedisCommandSpec? Get(string name) => _byName.GetValueOrDefault(name);

    /// <summary>The spec of a command line: two-word container commands first ("CONFIG GET"), then the first word.</summary>
    public RedisCommandSpec? Find(IReadOnlyList<string> args)
    {
        if (args.Count == 0) return null;
        if (args.Count > 1 && Containers.Contains(args[0]) && _byName.TryGetValue($"{args[0]} {args[1]}", out var sub)) return sub;
        return _byName.GetValueOrDefault(args[0]);
    }

    /// <summary>Display name of a command line ("CONFIG SET", "GET", "FOO" for unknown).</summary>
    public string DisplayName(IReadOnlyList<string> args)
    {
        var spec = Find(args);
        if (spec is not null) return spec.Name;
        if (args.Count == 0) return "";
        return args.Count > 1 && Containers.Contains(args[0]) ? $"{args[0].ToUpperInvariant()} {args[1].ToUpperInvariant()}" : args[0].ToUpperInvariant();
    }
}
