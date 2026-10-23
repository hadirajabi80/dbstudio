using System.Text.Json;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Logs;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake.Tests;

/// <summary>
/// The recorded Snowflake responses of <c>Fixtures/*.json</c> (plan-batch3 D10). An entry answers a statement whose text
/// equals its <c>sql</c> (whitespace-normalised) or matches its <c>match</c> regex; <c>error</c> entries throw like the
/// server would. Refresh them from a live account with <c>DBSTUDIO_UPDATE_GOLDEN=1</c> (see <c>LiveTests</c>).
/// </summary>
public static class SnowflakeFixtures
{
    public sealed record Entry(string? Sql, Regex? Match, SqlRowSet? Result, SnowflakeQueryException? Error, string File);

    private static readonly Lazy<IReadOnlyList<Entry>> s_entries = new(Load);

    public static IReadOnlyList<Entry> Entries => s_entries.Value;

    public static string Directory => Path.Combine(AppContext.BaseDirectory, "Fixtures");

    private static IReadOnlyList<Entry> Load()
    {
        var list = new List<Entry>();
        foreach (var file in System.IO.Directory.GetFiles(Directory, "*.json").OrderBy(f => f, StringComparer.Ordinal))
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            foreach (var e in doc.RootElement.GetProperty("entries").EnumerateArray())
            {
                var sql = e.TryGetProperty("sql", out var s) ? s.GetString() : null;
                var match = e.TryGetProperty("match", out var m) ? new Regex(m.GetString()!, RegexOptions.CultureInvariant) : null;
                SnowflakeQueryException? error = null;
                SqlRowSet? result = null;
                if (e.TryGetProperty("error", out var err))
                {
                    error = new SnowflakeQueryException(err.GetProperty("message").GetString()!, err.GetProperty("code").GetInt32(),
                        err.TryGetProperty("sqlState", out var st) ? st.GetString() : null, "01b7c2d4-0000-0000-0000-00000000dead");
                }
                else
                {
                    var columns = e.GetProperty("columns").EnumerateArray().Select(c => c.GetString()!).ToArray();
                    var rows = e.GetProperty("rows").EnumerateArray().Select(r => r.EnumerateArray().Select(Value).ToArray()).ToList();
                    result = new SqlRowSet(columns, rows);
                }
                list.Add(new Entry(sql, match, result, error, Path.GetFileName(file)));
            }
        }
        return list;
    }

    private static object? Value(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => v.TryGetInt64(out var l) ? (object)l : v.GetDouble(),
        JsonValueKind.String => v.GetString(),
        _ => v.GetRawText(),
    };

    public static string Normalize(string sql) => Regex.Replace(sql.Trim(), @"\s+", " ");

    /// <summary>The recorded answer for <paramref name="sql"/>, or null.</summary>
    public static Entry? Find(string sql)
    {
        var n = Normalize(sql);
        return Entries.FirstOrDefault(e => e.Sql is not null && Normalize(e.Sql) == n)
               ?? Entries.FirstOrDefault(e => e.Match is not null && e.Match.IsMatch(sql));
    }
}

/// <summary>An <see cref="ISnowflakeGateway"/> answering from the recorded fixtures; unknown statements fail the test.</summary>
public sealed class SnowflakeGatewayFake : ISnowflakeGateway
{
    public List<string> Sent { get; } = [];
    public List<IReadOnlyList<object?>> Binds { get; } = [];
    public bool Disposed { get; private set; }

    /// <summary>Extra answers for one test (checked before the fixtures).</summary>
    public Dictionary<string, Func<SqlRowSet>> Overrides { get; } = new(StringComparer.Ordinal);

    public Task<SqlRowSet> QueryAsync(string sql, CancellationToken ct) => QueryAsync(sql, [], ct);

    public Task<SqlRowSet> QueryAsync(string sql, IReadOnlyList<object?> binds, CancellationToken ct)
    {
        Sent.Add(sql);
        Binds.Add(binds);
        if (Overrides.TryGetValue(sql, out var o)) return Task.FromResult(o());
        var entry = SnowflakeFixtures.Find(sql) ?? throw new Xunit.Sdk.XunitException($"No Snowflake fixture for: {sql}");
        if (entry.Error is not null) throw entry.Error;
        return Task.FromResult(entry.Result!);
    }

    public async Task ExecuteAsync(string sql, CancellationToken ct) => await QueryAsync(sql, ct);

    public ValueTask DisposeAsync()
    {
        Disposed = true;
        return ValueTask.CompletedTask;
    }
}

public sealed class FakeGatewayFactory : ISnowflakeGatewayFactory
{
    public List<SnowflakeGatewayFake> Opened { get; } = [];
    public List<ConnectionProfile> Profiles { get; } = [];
    public Action<SnowflakeGatewayFake>? Configure { get; set; }

    public Task<ISnowflakeGateway> OpenAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var g = new SnowflakeGatewayFake();
        Configure?.Invoke(g);
        Opened.Add(g);
        Profiles.Add(profile);
        return Task.FromResult<ISnowflakeGateway>(g);
    }
}

/// <summary>An <see cref="ISqlRunner"/> over the fixtures for the log source (errors become <see cref="SqlQueryException"/>).</summary>
public sealed class FixtureSqlRunner : ISqlRunner, ISqlRunnerFactory
{
    public List<string> Sent { get; } = [];
    public Func<string, IReadOnlyList<SqlRowSet>?>? Override { get; set; }

    public Task<IReadOnlyList<SqlRowSet>> QueryAsync(string sql, CancellationToken ct)
    {
        Sent.Add(sql);
        if (Override?.Invoke(sql) is { } o) return Task.FromResult(o);
        var entry = SnowflakeFixtures.Find(sql) ?? throw new Xunit.Sdk.XunitException($"No Snowflake fixture for: {sql}");
        if (entry.Error is { } e) throw new SqlQueryException(new ErrorInfo(SnowflakeErrors.Code(e.ErrorCode), e.Message, ProviderCode: e.ErrorCode));
        return Task.FromResult<IReadOnlyList<SqlRowSet>>([entry.Result!]);
    }

    public Task<ISqlRunner> GetAsync(LogTarget target, CancellationToken ct) => Task.FromResult<ISqlRunner>(this);
}

public static class SfTestProfiles
{
    public static ConnectionProfile Shop(bool readOnly = false) => new()
    {
        Id = "c_sf_test",
        Name = "Snowflake Shop",
        ProviderId = "snowflake",
        ReadOnly = readOnly,
        Props = new Dictionary<string, System.Text.Json.Nodes.JsonNode?>
        {
            ["account"] = "xy12345.eu-central-1",
            ["user"] = "SHOP",
            ["authenticator"] = "snowflake",
            ["warehouse"] = "COMPUTE_WH",
            ["database"] = "shop",
            ["schema"] = "PUBLIC",
        },
        HasPassword = true,
    };
}
