using System.Globalization;
using StackExchange.Redis;

namespace DbStudio.Sources.Redis.Services;

/// <summary>Small helpers over <see cref="RedisResult"/> (RESP2 replies of <c>Execute</c>).</summary>
internal static class Resp
{
    public static RedisResult[] Arr(RedisResult r) => r.IsNull || r.Resp2Type != ResultType.Array ? [] : (RedisResult[])r!;

    public static byte[]? Bytes(RedisResult r) => r.IsNull ? null : (byte[]?)r;

    /// <summary>Display text: UTF-8, invalid bytes as <c>\xHH</c>.</summary>
    public static string Text(RedisResult r) => r.IsNull ? "" : r.Resp2Type == ResultType.Integer ? ((long)r).ToString(CultureInfo.InvariantCulture) : RedisArgs.ToDisplay((byte[]?)r ?? []);

    public static string? TextOrNull(RedisResult r) => r.IsNull ? null : Text(r);

    public static long Long(RedisResult r)
    {
        if (r.IsNull) return 0;
        if (r.Resp2Type == ResultType.Integer) return (long)r;
        return long.TryParse((string?)r, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;
    }

    public static double Double(RedisResult r)
    {
        var s = (string?)r;
        return s switch
        {
            null => 0,
            "inf" or "+inf" => double.MaxValue,
            "-inf" => double.MinValue,
            _ => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? Wire(d) : 0,
        };
    }

    /// <summary>JSON has no infinity: ±inf travel as ±double.MaxValue (the UI shows them as +inf / -inf).</summary>
    public static double Wire(double d) => double.IsPositiveInfinity(d) ? double.MaxValue : double.IsNegativeInfinity(d) ? double.MinValue : double.IsNaN(d) ? 0 : d;

    public static string Score(double d) =>
        d >= double.MaxValue ? "+inf" : d <= double.MinValue ? "-inf" : d.ToString("R", CultureInfo.InvariantCulture);

    /// <summary>Flat [k1, v1, k2, v2...] reply → pairs (XINFO, CONFIG GET, HELLO...).</summary>
    public static Dictionary<string, RedisResult> Map(RedisResult r)
    {
        var a = Arr(r);
        var d = new Dictionary<string, RedisResult>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i + 1 < a.Length; i += 2) d[(string?)a[i] ?? ""] = a[i + 1];
        return d;
    }

    /// <summary>The wire type of a TYPE reply (ReJSON-RL → rejson; other module types → unknown).</summary>
    public static string WireType(string? type) => type switch
    {
        "string" or "hash" or "list" or "set" or "zset" or "stream" => type,
        "ReJSON-RL" => "rejson",
        "none" => "none",
        _ => "unknown",
    };

    /// <summary>SCAN TYPE argument of a wire type.</summary>
    public static string ServerType(string wire) => wire == "rejson" ? "ReJSON-RL" : wire;

    public static readonly string[] WireTypes = ["string", "hash", "list", "set", "zset", "stream", "rejson"];
}
