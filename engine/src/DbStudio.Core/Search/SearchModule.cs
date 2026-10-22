using System.Text.Json;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DbStudio.Core.Search;

/// <summary>
/// Composition root of "Find in database": the <c>db.search</c> engine stream. The UI opens it with
/// <c>POST /streams { kind: "db.search", connectionId: "engine", params: SearchRequest }</c>; hits, progress and errors arrive
/// as <c>stream.data</c> items (<see cref="SearchItem"/>), a <see cref="SearchDone"/> item ends a finished search, and
/// <c>DELETE /streams/{id}</c> cancels it (every in-flight command is cancelled).
/// </summary>
public sealed class SearchModule : IEngineModule
{
    public const string StreamKind = "db.search";

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton(sp => new DatabaseSearchService(sp.GetRequiredService<ConnectionStore>(), sp.GetRequiredService<ProviderRegistry>(),
            sp.GetService<ILogger<DatabaseSearchService>>()));
        services.AddKeyedSingleton<IStreamFactory, SearchStreamFactory>(StreamKind);
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
    }
}

/// <summary>Validates the request before the stream opens (400/404 on the POST), then runs it as a stream.</summary>
public sealed class SearchStreamFactory(DatabaseSearchService service) : IStreamFactory
{
    /// <summary>The UI subscribes with the id from the 202 response; the first batch waits this long for it.</summary>
    public static TimeSpan StartDelay { get; set; } = TimeSpan.FromMilliseconds(150);

    public Task<IEngineStream> CreateAsync(StreamContext ctx, CancellationToken ct)
    {
        var request = SearchRequest.Parse(ctx.Params);
        service.Validate(request);
        return Task.FromResult<IEngineStream>(new SearchStream(service, request));
    }

    private sealed class SearchStream(DatabaseSearchService service, SearchRequest request) : IEngineStream
    {
        public async Task RunAsync(IStreamSink sink, CancellationToken ct)
        {
            if (StartDelay > TimeSpan.Zero) await Task.Delay(StartDelay, ct).ConfigureAwait(false);
            await service.RunAsync(request, item => sink.Push(JsonSerializer.SerializeToElement(item, item.GetType(), CoreJson.Options)), ct)
                .ConfigureAwait(false);
        }
    }
}
