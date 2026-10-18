using DbStudio.Core.Services;

namespace DbStudio.Host.Infrastructure;

/// <summary>
/// The UI client behind a request (logic-08): the opaque id the UI sends in <c>X-DbStudio-Client</c> on every REST call
/// and as <c>clientId</c> in the WebSocket auth frame. Sessions are owned by the client that created or last used them.
/// </summary>
public static class ClientIdentity
{
    public const string Header = "X-DbStudio-Client";

    /// <summary>The normalized client id of the request, or null (API callers without one).</summary>
    public static string? ClientId(this HttpContext http) =>
        ClientPresence.Normalize(http.Request.Headers[Header].ToString());
}
