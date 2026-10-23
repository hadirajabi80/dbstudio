using System.Net.Http.Json;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Queries;
using DbStudio.Core.Services;
using DbStudio.Providers.Sqlite;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DbStudio.Core.Tests.Queries;

/// <summary>
/// <c>/connections/{cid}/queries</c> over an in-memory TestServer with the real <see cref="QueriesModule"/>, a
/// <see cref="ConnectionStore"/> and the Host's error envelope <c>{ error: { code, message, detail } }</c>.
/// </summary>
public sealed class SavedQueryEndpointTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-queries-api", Guid.NewGuid().ToString("N"));
    private WebApplication _app = null!;
    private HttpClient _http = null!;
    private string _cid = "";

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_dir);
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        var s = builder.Services;
        s.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
        s.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);
        s.AddSingleton(new AppPaths(_dir));
        s.AddSingleton<ISecretStore, InMemorySecretStore>();
        s.AddSingleton(new SourceRegistry(new ProviderRegistry([new SqliteProvider()]), []));
        s.AddSingleton(sp => new ConnectionStore(sp.GetRequiredService<AppPaths>(), sp.GetRequiredService<ISecretStore>(), sp.GetRequiredService<SourceRegistry>()));
        var module = new QueriesModule();
        module.ConfigureServices(s);

        _app = builder.Build();
        _app.Use(async (ctx, next) =>
        {
            try { await next(ctx); }
            catch (EngineException ex)
            {
                ctx.Response.StatusCode = ex.Status;
                await ctx.Response.WriteAsJsonAsync(new { error = new { code = ex.Code, message = ex.Message, detail = ex.Detail } }, CoreJson.Options);
            }
            catch (BadHttpRequestException ex)
            {
                ctx.Response.StatusCode = 400;
                await ctx.Response.WriteAsJsonAsync(new { error = new { code = ErrorCodes.Validation, message = ex.Message, detail = (object?)null } }, CoreJson.Options);
            }
        });
        module.MapEndpoints(_app.MapGroup("/api/v1"));
        await _app.StartAsync();
        _http = _app.GetTestClient();
        _http.BaseAddress = new Uri("http://localhost/api/v1/");
        _cid = _app.Services.GetRequiredService<ConnectionStore>()
            .Create(new ConnectionProfile { Name = "lite", ProviderId = "sqlite", Props = new() { ["path"] = "x.db" } }, null).Id;
    }

    public async Task DisposeAsync()
    {
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private async Task<(int Status, JsonElement Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body, options: CoreJson.Options);
        using var res = await _http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return ((int)res.StatusCode, string.IsNullOrEmpty(text) ? default : JsonDocument.Parse(text).RootElement.Clone());
    }

    private string Q => $"connections/{_cid}/queries";

    private static string ErrorField(JsonElement body) => body.GetProperty("error").GetProperty("detail").GetProperty("field").GetString()!;

    [Fact]
    public async Task Create_List_Get_Update_Duplicate_Delete()
    {
        var (s1, created) = await Send(HttpMethod.Post, Q, new { database = "main", schema = "main", name = "Big orders", sql = "SELECT * FROM orders WHERE total > 100", description = "over 100" });
        Assert.Equal(201, s1);
        var id = created.GetProperty("id").GetString()!;
        Assert.Equal("main", created.GetProperty("schema").GetString());
        Assert.Equal(_cid, created.GetProperty("connectionId").GetString());
        await Send(HttpMethod.Post, Q, new { database = "main", schema = "other", name = "Elsewhere", sql = "SELECT 2" });

        var (s2, all) = await Send(HttpMethod.Get, Q);
        Assert.Equal(200, s2);
        Assert.Equal(2, all.GetArrayLength());
        var (_, inMain) = await Send(HttpMethod.Get, $"{Q}?database=main&schema=main");
        Assert.Equal("Big orders", Assert.Single(inMain.EnumerateArray()).GetProperty("name").GetString());

        var (s3, one) = await Send(HttpMethod.Get, $"{Q}/{id}");
        Assert.Equal(200, s3);
        Assert.Equal("SELECT * FROM orders WHERE total > 100", one.GetProperty("sql").GetString());

        var (s4, updated) = await Send(HttpMethod.Put, $"{Q}/{id}", new { sql = "SELECT 1" });
        Assert.Equal(200, s4);
        Assert.Equal(("Big orders", "SELECT 1", "over 100"), (updated.GetProperty("name").GetString(), updated.GetProperty("sql").GetString(), updated.GetProperty("description").GetString()));
        var (_, renamed) = await Send(HttpMethod.Put, $"{Q}/{id}", new { name = "Large orders" });
        Assert.Equal("Large orders", renamed.GetProperty("name").GetString());

        var (s5, copy) = await Send(HttpMethod.Post, $"{Q}/{id}/duplicate");
        Assert.Equal(201, s5);
        Assert.Equal("Large orders (copy)", copy.GetProperty("name").GetString());
        var (_, named) = await Send(HttpMethod.Post, $"{Q}/{id}/duplicate", new { name = "Third" });
        Assert.Equal("Third", named.GetProperty("name").GetString());

        Assert.Equal(204, (await Send(HttpMethod.Delete, $"{Q}/{id}")).Status);
        Assert.Equal(404, (await Send(HttpMethod.Get, $"{Q}/{id}")).Status);
        Assert.Equal(404, (await Send(HttpMethod.Delete, $"{Q}/{id}")).Status);
        Assert.Equal(3, (await Send(HttpMethod.Get, Q)).Body.GetArrayLength());
    }

    [Fact]
    public async Task Errors_UseTheEnvelope_AndNameTheField()
    {
        var (s1, b1) = await Send(HttpMethod.Post, Q, new { schema = "main", name = " ", sql = "x" });
        Assert.Equal(400, s1);
        Assert.Equal("VALIDATION", b1.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal("name", ErrorField(b1));

        await Send(HttpMethod.Post, Q, new { schema = "main", name = "Dup", sql = "x" });
        var (s2, b2) = await Send(HttpMethod.Post, Q, new { schema = "main", name = "DUP", sql = "y" });
        Assert.Equal(400, s2);
        Assert.Equal("name", ErrorField(b2));
        Assert.Equal("duplicate", b2.GetProperty("error").GetProperty("detail").GetProperty("reason").GetString());

        Assert.Equal(404, (await Send(HttpMethod.Get, "connections/c_missing/queries")).Status);
        Assert.Equal(404, (await Send(HttpMethod.Post, "connections/c_missing/queries", new { name = "n" })).Status);
        Assert.Equal(404, (await Send(HttpMethod.Put, $"{Q}/q_missing", new { name = "n" })).Status);
        Assert.Equal(404, (await Send(HttpMethod.Post, $"{Q}/q_missing/duplicate")).Status);
    }

    [Fact]
    public async Task DeleteForConnection_RemovesOnlyThatConnection()
    {
        await Send(HttpMethod.Post, Q, new { schema = "main", name = "Mine", sql = "x" });
        var store = _app.Services.GetRequiredService<SavedQueryStore>();
        store.Create("c_other", new SavedQueryInput(null, "main", "Theirs", "y", null));
        Assert.Equal(1, store.DeleteForConnection(_cid));
        Assert.Equal(0, (await Send(HttpMethod.Get, Q)).Body.GetArrayLength());
        Assert.Single(store.List("c_other"));
    }
}
