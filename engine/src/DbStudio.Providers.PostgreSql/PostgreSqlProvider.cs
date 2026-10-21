using System.Diagnostics;
using System.Net.Sockets;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Providers.PostgreSql.Diagnostics;
using Npgsql;

namespace DbStudio.Providers.PostgreSql;

/// <summary>
/// PostgreSQL provider (docs/PLAN-PG.md 2, Npgsql 9.x): sessions on dedicated unpooled connections, pooled catalog /
/// designer / diagnostics connections, <c>PREPARE</c>-based server diagnostics.
/// </summary>
public sealed class PostgreSqlProvider : IDbProvider
{
    static PostgreSqlProvider() => PgDriver.EnsureInitialized();

    public string Id => "postgresql";
    public string DisplayName => "PostgreSQL";
    public Dialect Dialect => Dialect.PgSql;
    public ConnectionFormSpec FormSpec => PgConnectionStrings.FormSpec;
    public IDdlGenerator DdlGenerator { get; } = new PgDdlGenerator();
    public ISqlDiagnostics? Diagnostics { get; } = new PgPrepareDiagnostics();
    public IdentifierRules Identifiers { get; } = new('"', '"', "lower", PgReservedWords.All);

    /// <summary>The session connection string (pooling disabled).</summary>
    public string BuildConnectionString(ConnectionProfile profile, string? password) =>
        PgConnectionStrings.Build(profile, password, pooling: false);

    public async Task<TestConnectionResult> TestAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await using var conn = new NpgsqlConnection(PgConnectionStrings.Build(profile, password, pooling: false));
            await conn.OpenAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, profile, ct).ConfigureAwait(false);
            return new TestConnectionResult(true, info, sw.ElapsedMilliseconds, null);
        }
        catch (Exception ex) when (ex is NpgsqlException or SocketException or TimeoutException or ArgumentException or InvalidOperationException or IOException)
        {
            return new TestConnectionResult(false, null, sw.ElapsedMilliseconds, PgErrors.ToProviderError(ex));
        }
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile profile, string? password, SessionOptions options, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(options);
        var conn = new NpgsqlConnection(PgConnectionStrings.Build(profile, password, pooling: false, options.Database));
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            var info = await ReadServerInfoAsync(conn, profile, ct).ConfigureAwait(false);
            return new PgSession(conn, profile, options, info);
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<ICatalogReader> OpenCatalogReaderAsync(ConnectionProfile profile, string? password, CancellationToken ct)
    {
        var reader = new PgCatalogReader(profile, password);
        try
        {
            await reader.ConnectionFor(null, ct).ConfigureAwait(false); // fail fast on bad credentials
            return reader;
        }
        catch
        {
            await reader.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>version(), server_version, inet_server_addr() (profile host for Unix sockets), current_user, current_database().</summary>
    public static async Task<ServerInfo> ReadServerInfoAsync(NpgsqlConnection conn, ConnectionProfile profile, CancellationToken ct)
    {
        await using var cmd = PgDb.Command(conn, PgCatalogQueries.ServerInfo);
        await using var r = await cmd.ExecuteReaderAsync(ct).ConfigureAwait(false);
        var host = profile.GetString("host");
        if (!await r.ReadAsync(ct).ConfigureAwait(false))
            return new ServerInfo(conn.PostgreSqlVersion.ToString(), conn.PostgreSqlVersion.ToString(), host, null, conn.Database);
        return new ServerInfo(
            PgDb.Str(r, 0) ?? "PostgreSQL",
            ProductVersion(PgDb.Str(r, 1)),
            PgDb.Str(r, 2) ?? host,
            PgDb.Str(r, 3),
            PgDb.Str(r, 4));
    }

    /// <summary>"17.2 (Debian 17.2-1.pgdg120+1)" → "17.2".</summary>
    public static string? ProductVersion(string? serverVersion) =>
        string.IsNullOrWhiteSpace(serverVersion) ? null : serverVersion.Trim().Split(' ', 2)[0];

    /// <summary>Major version of a product version ("16.4" → 16, "9.6.24" → 9); 0 when unknown.</summary>
    public static int MajorVersion(string? productVersion)
    {
        if (string.IsNullOrWhiteSpace(productVersion)) return 0;
        var head = productVersion.Trim().Split('.', ' ')[0];
        return int.TryParse(head, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : 0;
    }

    public static Core.Models.ErrorInfo ToProviderError(Exception ex) => PgErrors.ToProviderError(ex);
}

/// <summary>Process-wide Npgsql settings, applied once before the first connection.</summary>
internal static class PgDriver
{
    private static int s_initialized;

    public static void EnsureInitialized()
    {
        if (Interlocked.Exchange(ref s_initialized, 1) == 1) return;
        // Unmapped enums / user-defined ranges read as text instead of failing the result set.
#pragma warning disable CS0618 // sessions use plain NpgsqlConnection (docs/PLAN-PG.md D-PG2), which reads the global mapper
        NpgsqlConnection.GlobalTypeMapper.EnableUnmappedTypes();
#pragma warning restore CS0618
    }
}
