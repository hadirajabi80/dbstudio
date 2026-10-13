using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Host.Infrastructure;

/// <summary>Writes the error envelope <c>{"error":{"code","message","detail"}}</c> (docs/PLAN.md section 3).</summary>
public static class ErrorEnvelope
{
    public static Task WriteAsync(HttpContext ctx, int status, string code, string message, object? detail = null)
    {
        if (ctx.Response.HasStarted) return Task.CompletedTask;
        ctx.Response.Clear();
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        var body = new { error = new { code, message, detail } };
        return ctx.Response.WriteAsync(JsonSerializer.Serialize(body, CoreJson.Options));
    }

    public static IResult Result(int status, string code, string message, object? detail = null) =>
        Results.Json(new { error = new { code, message, detail } }, CoreJson.Options, statusCode: status);
}

/// <summary>Maps exceptions to the error envelope and fills empty 404/405 responses.</summary>
public sealed class ErrorHandlingMiddleware(RequestDelegate next, ILogger<ErrorHandlingMiddleware> log)
{
    public async Task InvokeAsync(HttpContext ctx)
    {
        try
        {
            await next(ctx);
            if (!ctx.Response.HasStarted && ctx.Response.ContentLength is null && string.IsNullOrEmpty(ctx.Response.ContentType)
                && !ctx.WebSockets.IsWebSocketRequest)
            {
                if (ctx.Response.StatusCode == 404)
                    await ErrorEnvelope.WriteAsync(ctx, 404, ErrorCodes.NotFound, $"No endpoint {ctx.Request.Method} {ctx.Request.Path}.");
                else if (ctx.Response.StatusCode == 405)
                    await ErrorEnvelope.WriteAsync(ctx, 405, ErrorCodes.NotFound, $"Method {ctx.Request.Method} is not allowed on {ctx.Request.Path}.");
            }
        }
        catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested)
        {
            // Client went away.
        }
        catch (Exception ex)
        {
            var (status, code, message, detail) = Map(ex);
            if (status >= 500) log.LogError(ex, "Unhandled error for {Method} {Path}", ctx.Request.Method, ctx.Request.Path);
            else log.LogDebug("{Method} {Path} → {Status} {Code}: {Message}", ctx.Request.Method, ctx.Request.Path, status, code, message);
            await ErrorEnvelope.WriteAsync(ctx, status, code, message, detail);
        }
    }

    public static (int Status, string Code, string Message, object? Detail) Map(Exception ex) => ex switch
    {
        EngineException e => (e.Status, e.Code, e.Message, e.Detail),
        SessionBusyException => (409, ErrorCodes.SessionBusy, ex.Message, null),
        SessionBrokenException => (409, ErrorCodes.SessionBroken, ex.Message, null),
        TxOpenException => (409, ErrorCodes.TxOpen, ex.Message, null),
        NotSupportedException => (400, ErrorCodes.NotSupported, ex.Message, null),
        BadHttpRequestException bad => (400, ErrorCodes.Validation, bad.InnerException?.Message ?? bad.Message, null),
        JsonException json => (400, ErrorCodes.Validation, json.Message, null),
        DbException db => (422, ErrorCodes.ProviderError, db.Message, new { providerCode = db.ErrorCode, sqlState = db.SqlState }),
        FileNotFoundException fnf => (422, ErrorCodes.ProviderError, fnf.Message, null),
        UnauthorizedAccessException ua => (422, ErrorCodes.ProviderError, ua.Message, null),
        ArgumentException arg => (400, ErrorCodes.Validation, arg.Message, null),
        TimeoutException t => (504, ErrorCodes.ProviderError, t.Message, null),
        ObjectDisposedException => (409, ErrorCodes.NotFound, "The session is closed.", null),
        _ when ex.GetType().Namespace?.StartsWith("Oracle", StringComparison.Ordinal) == true
               || ex.GetType().Namespace?.StartsWith("Microsoft.Data", StringComparison.Ordinal) == true
            => (422, ErrorCodes.ProviderError, ex.Message, null),
        _ => (500, ErrorCodes.EngineError, ex.Message, null),
    };
}

/// <summary>Requires <c>Authorization: Bearer &lt;token&gt;</c> on every /api request (CORS preflights excepted).</summary>
public sealed class TokenAuthMiddleware(RequestDelegate next, EngineOptions options)
{
    private readonly byte[] _expected = Encoding.UTF8.GetBytes(options.Token);

    public Task InvokeAsync(HttpContext ctx)
    {
        var path = ctx.Request.Path;
        if (!path.StartsWithSegments("/api") || HttpMethods.IsOptions(ctx.Request.Method) || IsWebSocketPath(path))
            return next(ctx);
        var header = ctx.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && Matches(header[prefix.Length..].Trim()))
            return next(ctx);
        return ErrorEnvelope.WriteAsync(ctx, 401, ErrorCodes.Unauthorized, "Missing or invalid bearer token.");
    }

    public static bool IsWebSocketPath(PathString path) => path == "/ws" || path == "/api/v1/ws";

    public bool Matches(string token) => CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), _expected);
}
