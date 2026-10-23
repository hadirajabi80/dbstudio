using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Logs;
using DbStudio.Logs.Providers.Snowflake;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Designer;
using DbStudio.Providers.Snowflake.Gateway;
using DbStudio.Providers.Snowflake.Module;
using DbStudio.Providers.Snowflake.Params;
using DbStudio.Providers.Snowflake.Plans;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Composition root of the "snowflake" package (plan-batch3 WP-SF, D6), discovered through the anchor in
/// <c>Host/ModuleAssemblies.cs</c>. Registers the provider, its keyed designer / plan / parameter / log services and the
/// <c>/snowflake/…</c> endpoints:
/// <code>
///   GET  /snowflake/{cid}/warehouses                          → SnowflakeWarehouse[]
///   POST /snowflake/{cid}/warehouses/{name}/{resume|suspend}  → SnowflakeActionResult
///   GET  /snowflake/{cid}/roles                               → SnowflakeRole[]
///   GET  /snowflake/{cid}/objects?database&amp;schema&amp;kind        → SnowflakeObjectsResponse (stages, streams, tasks, pipes, fileformats, dynamictables, alerts)
///   GET  /snowflake/{cid}/objects/ddl?database&amp;schema&amp;kind&amp;name → SnowflakeDdlResponse
///   POST /snowflake/{cid}/objects/action {database, schema, kind, name, action} → SnowflakeActionResult
///   GET  /snowflake/sessions/{sid}/context                    → SnowflakeSessionContext
///   POST /snowflake/sessions/{sid}/use {kind, name}           → SnowflakeSessionContext
/// </code>
/// </summary>
public sealed class SnowflakeModule : IEngineModule
{
    public const string ProviderId = "snowflake";

    public void ConfigureServices(IServiceCollection services)
    {
        // Secrets are looked up at call time (ConnectionStore depends on the provider registry, which depends on us).
        services.AddSingleton(sp => new SnowflakeSecrets((id, key) => sp.GetService<ConnectionStore>()?.GetSecret(id, key)));
        services.AddSingleton<ISnowflakeGatewayFactory>(sp => new SnowflakeGatewayFactory(sp.GetRequiredService<SnowflakeSecrets>()));
        services.AddSingleton(sp => new SnowflakeProvider(sp.GetRequiredService<ISnowflakeGatewayFactory>(), sp.GetRequiredService<SnowflakeSecrets>()));
        services.AddSingleton<IDbProvider>(sp => sp.GetRequiredService<SnowflakeProvider>());

        services.AddKeyedSingleton<IDdlScripter, SnowflakeDdlScripter>(ProviderId);
        services.AddKeyedSingleton<IDesignerDatabase>(ProviderId, (sp, _) => new SnowflakeDesignerDatabase(sp.GetRequiredService<ISnowflakeGatewayFactory>()));
        services.AddKeyedSingleton<IPlanReader, SnowflakePlanReader>(ProviderId);
        services.AddKeyedSingleton<IParamBinder>(ProviderId, SnowflakeParamBinder.Instance);

        services.AddSingleton(sp => new SnowflakeLogSource(sp.GetRequiredService<ISqlRunnerFactory>()));
        services.AddKeyedSingleton<ILogSource>(ProviderId, (sp, _) => sp.GetRequiredService<SnowflakeLogSource>());
        services.AddKeyedSingleton<IActivitySource>(ProviderId, (sp, _) => sp.GetRequiredService<SnowflakeLogSource>());
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        var g = api.MapGroup("/snowflake/{cid}");

        g.MapGet("/warehouses", async (string cid, ConnectionStore connections, ISnowflakeGatewayFactory gateways, CancellationToken ct) =>
        {
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            return await SnowflakeObjects.WarehousesAsync(gw, ct).ConfigureAwait(false);
        });

        g.MapPost("/warehouses/{name}/{action}", async (string cid, string name, string action, ConnectionStore connections,
            ISnowflakeGatewayFactory gateways, CancellationToken ct) =>
        {
            var sql = SnowflakeObjects.WarehouseActionSql(name, action);
            RefuseReadOnly(connections.Get(cid), $"{action} warehouse");
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            return await SnowflakeObjects.RunAsync(gw, sql, ct).ConfigureAwait(false);
        });

        g.MapGet("/roles", async (string cid, ConnectionStore connections, ISnowflakeGatewayFactory gateways, CancellationToken ct) =>
        {
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            return await SnowflakeObjects.RolesAsync(gw, ct).ConfigureAwait(false);
        });

        g.MapGet("/objects", async (string cid, string? database, string? schema, string? kind, ConnectionStore connections,
            ISnowflakeGatewayFactory gateways, CancellationToken ct) =>
        {
            var k = SnowflakeObjects.KindOf(kind);
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            var (db, sc) = await ScopeAsync(gw, connections.Get(cid), database, schema, ct).ConfigureAwait(false);
            return await SnowflakeObjects.ObjectsAsync(gw, db, sc, k, ct).ConfigureAwait(false);
        });

        g.MapGet("/objects/ddl", async (string cid, string? database, string? schema, string? kind, string? name, ConnectionStore connections,
            ISnowflakeGatewayFactory gateways, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(name)) throw EngineException.Validation("name is required.", new { field = "name" });
            var k = SnowflakeObjects.KindOf(kind);
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            var (db, sc) = await ScopeAsync(gw, connections.Get(cid), database, schema, ct).ConfigureAwait(false);
            try
            {
                return await SnowflakeObjects.DdlAsync(gw, db, sc, k, name, ct).ConfigureAwait(false);
            }
            catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
            {
                throw EngineException.NotFound($"{k} {sc}.{name}");
            }
        });

        g.MapPost("/objects/action", async (string cid, ObjectActionRequest? req, ConnectionStore connections, ISnowflakeGatewayFactory gateways,
            CancellationToken ct) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.Name) || string.IsNullOrWhiteSpace(req.Action))
                throw EngineException.Validation("name and action are required.", new { field = "name" });
            var profile = connections.Get(cid);
            await using var gw = await OpenAsync(cid, connections, gateways, ct).ConfigureAwait(false);
            var (db, sc) = await ScopeAsync(gw, profile, req.Database, req.Schema, ct).ConfigureAwait(false);
            var sql = SnowflakeObjects.ObjectActionSql(req.Kind ?? "", db, sc, req.Name, req.Action);
            RefuseReadOnly(profile, $"{req.Action} {req.Kind}");
            return await SnowflakeObjects.RunAsync(gw, sql, ct).ConfigureAwait(false);
        });

        var s = api.MapGroup("/snowflake/sessions/{sid}");

        s.MapGet("/context", async (string sid, SessionManager sessions, CancellationToken ct) =>
            await SessionOf(sessions, sid).GetContextAsync(ct).ConfigureAwait(false));

        s.MapPost("/use", async (string sid, SnowflakeUseRequest? req, SessionManager sessions, CancellationToken ct) =>
        {
            if (req is null) throw EngineException.Validation("kind and name are required.", new { field = "kind" });
            var h = sessions.Get(sid);
            var ctx = await SessionOf(sessions, sid).UseAsync(req.Kind ?? "", req.Name ?? "", ct).ConfigureAwait(false);
            sessions.PublishChanged(h);
            return ctx;
        });
    }

    /// <summary>Body of <c>POST /snowflake/{cid}/objects/action</c>.</summary>
    public sealed record ObjectActionRequest(string? Database, string? Schema, string? Kind, string? Name, string? Action);

    private static SnowflakeSession SessionOf(SessionManager sessions, string sid) =>
        sessions.Get(sid).Session as SnowflakeSession
        ?? throw EngineException.Validation("The session is not a Snowflake session.", new { field = "sid" });

    private static async Task<ISnowflakeGateway> OpenAsync(string cid, ConnectionStore connections, ISnowflakeGatewayFactory gateways, CancellationToken ct)
    {
        var profile = connections.Get(cid);
        if (!profile.ProviderId.Equals(ProviderId, StringComparison.OrdinalIgnoreCase))
            throw EngineException.Validation($"Connection '{profile.Name}' is not a Snowflake connection.", new { field = "cid" });
        try
        {
            return await gateways.OpenAsync(profile, connections.GetPassword(cid), ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not EngineException and not OperationCanceledException)
        {
            var error = SnowflakeErrors.ToProviderError(ex);
            throw new EngineException(503, ErrorCodes.SourceUnavailable, error.Message, new { connectionId = cid, code = error.Code });
        }
    }

    /// <summary>Database and schema of a module call: the arguments, else the connection's, else the server's current ones.</summary>
    private static async Task<(string Database, string Schema)> ScopeAsync(ISnowflakeGateway gw, ConnectionProfile profile, string? database, string? schema,
        CancellationToken ct)
    {
        var db = Blank(database) ?? (Blank(profile.GetString("database")) is { } pd ? SnowflakeSql.Normalize(pd) : null);
        var sc = Blank(schema) ?? (Blank(profile.GetString("schema")) is { } ps ? SnowflakeSql.Normalize(ps) : null);
        if (db is null || sc is null)
        {
            var rs = await gw.QueryAsync("SELECT CURRENT_DATABASE() AS DATABASE_NAME, CURRENT_SCHEMA() AS SCHEMA_NAME", ct).ConfigureAwait(false);
            var r = rs.Rows.FirstOrDefault();
            db ??= r is null ? null : rs.Str(r, "DATABASE_NAME");
            sc ??= r is null ? null : rs.Str(r, "SCHEMA_NAME");
        }
        if (db is null) throw EngineException.Validation("database is required (the connection has none).", new { field = "database" });
        return (db, sc ?? SnowflakeConnectionStrings.DefaultSchema);
    }

    private static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();

    private static void RefuseReadOnly(ConnectionProfile profile, string action)
    {
        if (profile.ReadOnly) throw EngineException.ReadOnly(profile.Name, action);
    }
}
