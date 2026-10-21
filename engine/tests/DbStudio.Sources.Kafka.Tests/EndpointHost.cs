using System.Net.Http.Json;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DbStudio.Sources.Kafka.Tests;

/// <summary>
/// The Kafka module's endpoints on an in-memory TestServer with the real framework services (ConnectionStore,
/// SourceRegistry, SourceClientManager, StreamManager, JobManager) and the provider wired to <see cref="KafkaFake"/>.
/// Errors use the Host's envelope <c>{ error: { code, message, detail } }</c>.
/// </summary>
public sealed class EndpointHost : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "dbstudio-kafka-tests", Guid.NewGuid().ToString("N"));
    private WebApplication _app = null!;

    public KafkaFake Fake { get; } = new();
    public FakeSchemaRegistry Registry { get; } = new();
    public Events Events { get; } = new();
    public HttpClient Http { get; private set; } = null!;
    public IServiceProvider Services => _app.Services;
    public string Cid { get; private set; } = "";
    public string ReadOnlyCid { get; private set; } = "";

    public static async Task<EndpointHost> StartAsync()
    {
        var h = new EndpointHost();
        await h.InitAsync();
        return h;
    }

    private async Task InitAsync()
    {
        Directory.CreateDirectory(_dir);
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        var s = builder.Services;
        s.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
        var provider = new KafkaProvider((_, _) => Fake, settings => settings.HasSchemaRegistry
            ? new HttpSchemaRegistry(settings.SchemaRegistryUrl!, settings.SchemaRegistryUser, settings.SchemaRegistrySecret, Registry) : null);
        s.AddSingleton<IDataSourceProvider>(provider);
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
        KafkaModule.AddServices(s);

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
        new KafkaModule().MapEndpoints(api);
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
        Cid = store.Create(Harness.Profile("x"), null).Id;
        ReadOnlyCid = store.Create(Harness.Profile("y", readOnly: true), null).Id;
    }

    public sealed record StreamOpen(string Kind, string ConnectionId, JsonElement? Params);

    public sealed record TestReq(ConnectionProfile Profile, string? Password);

    public StreamManager Streams => _app.Services.GetRequiredService<StreamManager>();

    public async Task<(int Status, JsonElement Body)> Send(HttpMethod method, string path, object? body = null)
    {
        using var req = new HttpRequestMessage(method, path.TrimStart('/'));
        if (body is not null) req.Content = JsonContent.Create(body, options: CoreJson.Options);
        using var res = await Http.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        return ((int)res.StatusCode, string.IsNullOrEmpty(text) ? default : Util.Json(text));
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
