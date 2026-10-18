using System.Net;
using System.Text.Json;
using DbStudio.Core.Catalog;
using DbStudio.Core.Designer;
using DbStudio.Core.Export;
using DbStudio.Core.Filters;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Sample;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Host;
using DbStudio.Host.Endpoints;
using DbStudio.Host.Infrastructure;
using DbStudio.Host.Ws;
using DbStudio.Providers.Oracle;
using DbStudio.Providers.Oracle.Designer;
using DbStudio.Providers.Oracle.Params;
using DbStudio.Providers.Oracle.Plans;
using DbStudio.Providers.PostgreSql;
using DbStudio.Providers.PostgreSql.Designer;
using DbStudio.Providers.PostgreSql.Params;
using DbStudio.Providers.PostgreSql.Plans;
using DbStudio.Providers.SqlServer;
using DbStudio.Providers.SqlServer.Designer;
using DbStudio.Providers.SqlServer.Params;
using DbStudio.Providers.SqlServer.Plans;
using DbStudio.Providers.Sqlite;
using DbStudio.Providers.Sqlite.Designer;
using DbStudio.Providers.Sqlite.Params;
using DbStudio.Providers.Sqlite.Plans;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Json;
using Serilog;
using Serilog.Events;

// DbStudio engine: ASP.NET Core minimal API on 127.0.0.1 (docs/PLAN.md sections 1–3).
// stdout carries exactly one line, "DBSTUDIO_READY {...}"; every log goes to the rolling file (and stderr with --dev).

EngineOptions options;
try
{
    options = EngineOptions.Parse(args);
}
catch (Exception ex) when (ex is ArgumentException or FormatException or OverflowException)
{
    Console.Error.WriteLine($"Invalid arguments: {ex.Message}");
    return 2;
}

var paths = AppPaths.FromEnvironment();
var logConfig = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Information)
    .Enrich.FromLogContext()
    .WriteTo.File(Path.Combine(paths.LogsDir, "engine-.log"), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 10,
        outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}");
if (options.Dev)
    logConfig = logConfig.MinimumLevel.Debug()
        .MinimumLevel.Override("Microsoft.AspNetCore", LogEventLevel.Warning)
        .WriteTo.Console(standardErrorFromLevel: LogEventLevel.Verbose);
Log.Logger = logConfig.CreateLogger();

try
{
    // Do not hand our own argument syntax (--dev without a value) to the configuration system.
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [], ContentRootPath = AppContext.BaseDirectory });
    builder.Logging.ClearProviders();
    builder.Host.UseSerilog();
    builder.WebHost.ConfigureKestrel(k =>
    {
        k.Listen(IPAddress.Loopback, options.Port);
        k.Limits.MaxRequestBodySize = 64L * 1024 * 1024;
        k.AddServerHeader = false;
    });

    var services = builder.Services;
    services.Configure<JsonOptions>(o => CoreJson.Configure(o.SerializerOptions));
    services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = true);
    services.AddCors(c => c.AddDefaultPolicy(p => p
        .SetIsOriginAllowed(options.IsOriginAllowed)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .WithExposedHeaders("ETag", "Content-Disposition")
        .SetPreflightMaxAge(TimeSpan.FromHours(1))));

    services.AddSingleton(options);
    services.AddSingleton(paths);
    services.AddSingleton<ISecretStore>(_ => DbStudio.Core.Secrets.SecretStoreFactory.Create(paths)); // DPAPI | Keychain | AES file
    services.AddSingleton<IDbProvider, SqlServerProvider>();
    services.AddSingleton<IDbProvider, OracleProvider>();
    services.AddSingleton<IDbProvider, SqliteProvider>();
    services.AddSingleton<IDbProvider, PostgreSqlProvider>(); // M2: PG-A (docs/PLAN-PG.md)
    services.AddSingleton<ProviderRegistry>();
    // ---- M2 (docs/PLAN-M2.md 1.1): relational + non-relational providers, source clients, streams, jobs.
    services.AddSingleton<SourceRegistry>();
    services.AddSingleton(sp => new ConnectionStore(paths, sp.GetRequiredService<ISecretStore>(), sp.GetRequiredService<SourceRegistry>()));
    services.AddSingleton<SettingsService>();
    services.AddSingleton<HistoryService>();
    services.AddSingleton(new ResultStore());
    services.AddSingleton(new ClientPresence()); // B1 (logic-08): live UI clients, fed by the WebSocket hub
    services.AddSingleton<WsHub>();
    services.AddSingleton<IEventPublisher>(sp => sp.GetRequiredService<WsHub>());
    services.AddSingleton<SessionManager>();
    services.AddSingleton(sp => new SourceClientManager(sp.GetRequiredService<SourceRegistry>(), sp.GetRequiredService<ConnectionStore>(),
        sp.GetRequiredService<IEventPublisher>(), sp.GetRequiredService<SettingsService>(), sp.GetRequiredService<ILogger<SourceClientManager>>()));
    services.AddSingleton(sp => new StreamManager(sp.GetRequiredService<IEventPublisher>(), kind => sp.GetKeyedService<IStreamFactory>(kind),
        sp.GetRequiredService<ConnectionStore>(), sp.GetRequiredService<ClientPresence>(), sp.GetRequiredService<SourceClientManager>(),
        sp.GetRequiredService<SettingsService>(), sp.GetRequiredService<ILogger<StreamManager>>()));
    services.AddSingleton(sp => new JobManager(sp.GetRequiredService<IEventPublisher>(), sp.GetRequiredService<ILogger<JobManager>>()));
    services.AddSingleton<CatalogService>();
    services.AddSingleton<ExecutionService>();
    services.AddSingleton<ExportService>();
    services.AddHostedService<ParentWatchdog>();

    // ---- M1.5 (docs/PLAN-M1.5.md): per-provider features as keyed services by provider id.
    services.AddKeyedSingleton<IDdlScripter, SqlServerDdlScripter>("sqlserver");
    services.AddKeyedSingleton<IDdlScripter, OracleDdlScripter>("oracle");
    services.AddKeyedSingleton<IDdlScripter, SqliteDdlScripter>("sqlite");
    services.AddKeyedSingleton<IDesignerDatabase, SqlServerDesignerDatabase>("sqlserver");
    services.AddKeyedSingleton<IDesignerDatabase, OracleDesignerDatabase>("oracle");
    services.AddKeyedSingleton<IDesignerDatabase, SqliteDesignerDatabase>("sqlite");
    services.AddKeyedSingleton<IPlanReader, SqlServerPlanReader>("sqlserver");
    services.AddKeyedSingleton<IPlanReader, OraclePlanReader>("oracle");
    services.AddKeyedSingleton<IPlanReader, SqlitePlanReader>("sqlite");
    services.AddKeyedSingleton<IParamBinder>("sqlserver", SqlServerParamBinder.Instance);
    services.AddKeyedSingleton<IParamBinder>("oracle", OracleParamBinder.Instance);
    services.AddKeyedSingleton<IParamBinder>("sqlite", SqliteParamBinder.Instance);
    // M2: PostgreSQL features (M2-0 stubs that throw NotSupportedException until PG-A implements them).
    services.AddKeyedSingleton<IDdlScripter, PgDdlScripter>("postgresql");
    services.AddKeyedSingleton<IDesignerDatabase, PgDesignerDatabase>("postgresql");
    services.AddKeyedSingleton<IPlanReader, PgPlanReader>("postgresql");
    services.AddKeyedSingleton<IParamBinder>("postgresql", PgParamBinder.Instance);
    services.AddSingleton(sp => ProviderFeatures.FromServices(sp));
    services.AddSingleton<FilterStore>();
    services.AddSingleton<DesignerService>();
    services.AddSingleton<DescribeService>();
    services.AddSingleton<SampleDatabase>();

    // ---- M2 (docs/PLAN-M2.md D4): feature modules register their providers, services and stream factories.
    var modules = EngineModules.Discover(ModuleAssemblies.All);
    foreach (var module in modules) module.ConfigureServices(services);

    var app = builder.Build();
    Log.Information("Engine modules: {Modules}", string.Join(", ", modules.Select(m => m.GetType().Name)));

    app.UseMiddleware<ErrorHandlingMiddleware>();
    app.UseCors();
    app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
    app.UseMiddleware<TokenAuthMiddleware>();

    var hub = app.Services.GetRequiredService<WsHub>();
    app.Map("/ws", hub.HandleAsync);
    app.Map("/api/v1/ws", hub.HandleAsync);

    var api = app.MapGroup("/api/v1");
    api.MapMeta()
        .MapConnections()
        .MapCatalog()
        .MapSessions()
        .MapExecutions()
        .MapHistory()
        .MapSql()
        // M1.5
        .MapFilters()
        .MapDescribe()
        .MapPlans()
        .MapDesigner()
        .MapSampleDb()
        // M2
        .MapStreams()
        .MapSources();
    foreach (var module in modules) module.MapEndpoints(api);

    app.Lifetime.ApplicationStarted.Register(() =>
    {
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault();
        var port = address is not null && Uri.TryCreate(address, UriKind.Absolute, out var uri) ? uri.Port : options.Port;
        var ready = JsonSerializer.Serialize(new { port, token = options.Token });
        Console.Out.WriteLine($"DBSTUDIO_READY {ready}");
        Console.Out.Flush();
        Log.Information("Engine ready on 127.0.0.1:{Port} (dev={Dev}, data={DataDir})", port, options.Dev, paths.DataDir);
    });

    app.Lifetime.ApplicationStopping.Register(() =>
    {
        // Roll back open transactions and close tab connections.
        app.Services.GetRequiredService<SessionManager>().DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(10));
        // M2: end streams ("shutdown"), cancel jobs, close source clients.
        app.Services.GetRequiredService<StreamManager>().DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(5));
        app.Services.GetRequiredService<JobManager>().DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(5));
        app.Services.GetRequiredService<SourceClientManager>().DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(5));
    });

    await app.RunAsync();
    return 0;
}
catch (Exception ex)
{
    Log.Fatal(ex, "Engine terminated unexpectedly");
    Console.Error.WriteLine($"Engine failed to start: {ex.Message}");
    return 1;
}
finally
{
    await Log.CloseAndFlushAsync();
}
