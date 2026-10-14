using DbStudio.Core.Catalog;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Host.Contracts;

namespace DbStudio.Host.Endpoints;

public static class ConnectionEndpoints
{
    public static RouteGroupBuilder MapConnections(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/connections");

        g.MapGet("", (ConnectionStore store) => store.List());

        g.MapPost("", (ConnectionInput? input, ConnectionStore store) =>
        {
            if (input is null) throw EngineException.Validation("A connection body is required.");
            return store.Create(input.ToProfile(), input.Password);
        });

        g.MapPut("/{id}", (string id, ConnectionInput? input, ConnectionStore store, CatalogService catalog) =>
        {
            if (input is null) throw EngineException.Validation("A connection body is required.");
            var updated = store.Update(id, input.ToProfile(), input.Password);
            catalog.Forget(id); // the target may have changed; open sessions keep their connection until closed
            return updated;
        });

        g.MapDelete("/{id}", async (string id, ConnectionStore store, CatalogService catalog, SessionManager sessions, Core.Filters.FilterStore filters) =>
        {
            store.Get(id); // 404 when unknown
            await sessions.CloseAllForConnectionAsync(id);
            store.Delete(id);
            catalog.Forget(id);
            filters.DeleteForConnection(id); // M1.5 saved filters of the connection
            return Results.NoContent();
        });

        g.MapPost("/test", async (TestConnectionRequest? req, ConnectionStore store, ProviderRegistry providers, CancellationToken ct) =>
        {
            if (req?.Profile is null) throw EngineException.Validation("profile is required.", new { field = "profile" });
            var provider = providers.Get(req.Profile.ProviderId);
            var password = req.Password;
            if (password is null && req.UseStoredPassword && !string.IsNullOrEmpty(req.Profile.Id))
                password = store.GetPassword(req.Profile.Id);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(req.Profile.GetInt("connectTimeout", 15) + 15, 5, 300)));
            try
            {
                return await provider.TestAsync(req.Profile, password, timeout.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return new TestConnectionResult(false, null, 0, new ErrorInfo(ErrorCodes.ProviderError, "The connection test timed out."));
            }
        });

        return api;
    }
}
