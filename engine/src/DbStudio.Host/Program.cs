using System.Net;
using System.Text.Json;
using DbStudio.Core.Catalog;
using DbStudio.Core.Export;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Host;
using DbStudio.Host.Endpoints;
using DbStudio.Host.Infrastructure;
using DbStudio.Host.Ws;
using DbStudio.Providers.Oracle;
using DbStudio.Providers.SqlServer;
using DbStudio.Providers.Sqlite;
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
        .SetIsOriginAllowed(origin => options.AllowedOrigins.Contains(origin))
        .AllowAnyHeader()
        .AllowAnyMethod()
        .WithExposedHeaders("ETag", "Content-Disposition")
        .SetPreflightMaxAge(TimeSpan.FromHours(1))));

    services.AddSingleton(options);
    services.AddSingleton(paths);
    services.AddSingleton<ISecretStore>(_ => OperatingSystem.IsWindows() ? new DpapiSecretStore(paths) : new InMemorySecretStore());
    services.AddSingleton<IDbProvider, SqlServerProvider>();
    services.AddSingleton<IDbProvider, OracleProvider>();
    services.AddSingleton<IDbProvider, SqliteProvider>();
    services.AddSingleton<ProviderRegistry>();
    services.AddSingleton<ConnectionStore>();
    services.AddSingleton<SettingsService>();
    services.AddSingleton<HistoryService>();
    services.AddSingleton(new ResultStore());
    services.AddSingleton<WsHub>();
    services.AddSingleton<IEventPublisher>(sp => sp.GetRequiredService<WsHub>());
    services.AddSingleton<SessionManager>();
    services.AddSingleton<CatalogService>();
    services.AddSingleton<ExecutionService>();
    services.AddSingleton<ExportService>();
    services.AddHostedService<ParentWatchdog>();

    var app = builder.Build();

    app.UseMiddleware<ErrorHandlingMiddleware>();
    app.UseCors();
    app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
    app.UseMiddleware<TokenAuthMiddleware>();

    var hub = app.Services.GetRequiredService<WsHub>();
    app.Map("/ws", hub.HandleAsync);
    app.Map("/api/v1/ws", hub.HandleAsync);

    app.MapGroup("/api/v1")
        .MapMeta()
        .MapConnections()
        .MapCatalog()
        .MapSessions()
        .MapExecutions()
        .MapHistory()
        .MapSql();

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
