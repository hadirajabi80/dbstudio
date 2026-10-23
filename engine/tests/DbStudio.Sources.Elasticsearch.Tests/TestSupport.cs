using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DbStudio.Sources.Elasticsearch.Tests;

public static class Es
{
    public static ConnectionProfile Profile(string url = "http://es-fake:9200", bool readOnly = false, string name = "ES test", params (string Key, object? Value)[] props)
    {
        var p = new ConnectionProfile { Id = "", Name = name, ProviderId = "elasticsearch", ReadOnly = readOnly, Props = new() { ["url"] = url } };
        foreach (var (k, v) in props) p.Props[k] = v is null ? null : JsonSerializer.SerializeToNode(v);
        return p;
    }

    /// <summary>An open client over the fake (no SourceClientManager).</summary>
    public static async Task<EsClient> ClientAsync(FakeEs fake, ConnectionProfile? profile = null)
    {
        var p = profile ?? Profile();
        if (string.IsNullOrEmpty(p.Id)) p.Id = "c_test";
        return (EsClient)await new EsProvider(_ => fake).OpenAsync(p, null, default);
    }

    public static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();
}

/// <summary>Captures engine events (job progress/done, stream data).</summary>
public sealed class Events : IEventPublisher
{
    public ConcurrentQueue<EngineEvent> All { get; } = new();

    public void Publish(EngineEvent ev) => All.Enqueue(ev);

    public IEnumerable<T> Of<T>() where T : EngineEvent => All.OfType<T>();

    public async Task<JobDoneEvent> DoneAsync(string jobId, int timeoutMs = 30_000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < until)
        {
            if (Of<JobDoneEvent>().FirstOrDefault(e => e.JobId == jobId) is { } done) return done;
            await Task.Delay(20);
        }
        throw new TimeoutException($"job {jobId} did not finish");
    }
}

/// <summary>
/// The module's endpoints on an in-memory TestServer with the real framework services (ConnectionStore, SourceRegistry,
/// SourceClientManager, StreamManager, JobManager) and the provider wired to <see cref="FakeEs"/> (or a live URL).
/// </summary>
public sealed class EndpointHost : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-es-tests", Guid.NewGuid().ToString("N"));
    private WebApplication _app = null!;

    public FakeEs Fake { get; } = new();
    public Events Events { get; } = new();
    public HttpClient Http { get; private set; } = null!;
    public string Cid { get; private set; } = "";
    public string ReadOnlyCid { get; private set; } = "";

    /// <param name="liveUrl">Null: the fake; else a real cluster.</param>
    public static async Task<EndpointHost> StartAsync(string? liveUrl = null)
    {
        var h = new EndpointHost();
        await h.InitAsync(liveUrl);
        return h;
    }

    private async Task InitAsync(string? liveUrl)
    {
        Directory.CreateDirectory(_dir);
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        var s = builder.Services;
        s.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
        s.AddSingleton<IDataSourceProvider>(new EsProvider(liveUrl is null ? _ => Fake : null));
        s.AddSingleton(new AppPaths(_dir));
        s.AddSingleton<ISecretStore, InMemorySecretStore>();
        s.AddSingleton(new ProviderRegistry([]));
        s.AddSingleton(sp => new SourceRegistry(sp.GetRequiredService<ProviderRegistry>(), sp.GetServices<IDataSourceProvider>()));
        s.AddSingleton(sp => new ConnectionStore(sp.GetRequiredService<AppPaths>(), sp.GetRequiredService<ISecretStore>(), sp.GetRequiredService<SourceRegistry>()));
        s.AddSingleton<IEventPublisher>(Events);
        s.AddSingleton(sp => new SourceClientManager(sp.GetRequiredService<SourceRegistry>(), sp.GetRequiredService<ConnectionStore>(), Events));
        s.AddSingleton(sp => new StreamManager(Events, kind => sp.GetKeyedService<IStreamFactory>(kind), sp.GetRequiredService<ConnectionStore>(),
            clients: sp.GetRequiredService<SourceClientManager>(), options: new StreamManagerOptions { FlushInterval = TimeSpan.FromMilliseconds(20) }));
        s.AddSingleton(_ => new JobManager(Events));
        ElasticsearchModule.AddServices(s);
        s.AddSingleton(new Services.JobsService { PollInterval = TimeSpan.FromMilliseconds(50) });

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
        var api = _app.MapGroup("/api/v1");
        new ElasticsearchModule().MapEndpoints(api);
        api.MapPost("/streams", async (StreamOpen req, HttpContext http, StreamManager streams, CancellationToken ct) =>
            Results.Json(await streams.OpenAsync(req.Kind, req.ConnectionId, req.Params, http.Request.Headers["X-DbStudio-Client"].ToString(), ct),
                CoreJson.Options, statusCode: 202));
        api.MapPost("/connections/test", async (TestReq req, SourceRegistry reg, CancellationToken ct) =>
            await reg.Get(req.Profile.ProviderId).TestAsync(req.Profile, req.Password, ct));
        await _app.StartAsync();
        Http = _app.GetTestClient();
        Http.BaseAddress = new Uri("http://localhost/api/v1/");
        Http.DefaultRequestHeaders.Add("X-DbStudio-Client", "test-client");

        var store = _app.Services.GetRequiredService<ConnectionStore>();
        var url = liveUrl ?? "http://es-fake:9200";
        Cid = store.Create(Es.Profile(url, name: "ES"), null).Id;
        ReadOnlyCid = store.Create(Es.Profile(url, readOnly: true, name: "ES read-only"), null).Id;
    }

    public sealed record StreamOpen(string Kind, string ConnectionId, JsonElement? Params);

    public sealed record TestReq(ConnectionProfile Profile, string? Password);

    public async Task<(int Status, JsonElement Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path.TrimStart('/'));
        if (body is not null) req.Content = body is JsonNode node ? new StringContent(node.ToJsonString(), System.Text.Encoding.UTF8, "application/json") : JsonContent.Create(body, options: CoreJson.Options);
        using var res = await Http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        JsonElement parsed = default;
        if (!string.IsNullOrEmpty(text))
        {
            try { parsed = Es.J(text); }
            catch (JsonException) { parsed = JsonSerializer.SerializeToElement(text); }
        }
        return ((int)res.StatusCode, parsed);
    }

    public Task<(int Status, JsonElement Body)> Get(string path) => Send(HttpMethod.Get, path);
    public Task<(int Status, JsonElement Body)> Post(string path, object? body = null) => Send(HttpMethod.Post, path, body ?? new { });
    public Task<(int Status, JsonElement Body)> Put(string path, object body) => Send(HttpMethod.Put, path, body);
    public Task<(int Status, JsonElement Body)> Delete(string path) => Send(HttpMethod.Delete, path);

    public async ValueTask DisposeAsync()
    {
        await _app.Services.GetRequiredService<StreamManager>().DisposeAsync();
        await _app.Services.GetRequiredService<JobManager>().DisposeAsync();
        await _app.Services.GetRequiredService<SourceClientManager>().DisposeAsync();
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, true); } catch (IOException) { /* best effort */ }
    }
}
