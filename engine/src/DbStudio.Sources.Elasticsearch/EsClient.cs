using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Elasticsearch;

/// <summary>
/// The long-lived client of one Elasticsearch / OpenSearch connection: the HTTP transport, the detected flavor and
/// version. Obtain it with <c>EsEndpoints.ClientAsync(clients, cid, ct)</c>.
/// </summary>
public sealed class EsClient(ConnectionProfile profile, EsTransport transport, string flavor, string version, ServerInfo server) : IDataSourceClient
{
    public string ConnectionId => Profile.Id;
    public ConnectionProfile Profile { get; } = profile;
    public EsTransport Transport { get; } = transport;

    /// <summary>"elasticsearch" | "opensearch".</summary>
    public string Flavor { get; } = flavor;

    public string Version { get; } = version;
    public bool IsOpenSearch => Flavor == "opensearch";
    public ServerInfo Server { get; } = server;
    public DateTimeOffset LastUsed { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>Major version number (8 for "8.15.3"; 0 when unknown).</summary>
    public int Major => int.TryParse(Version.Split('.')[0], out var m) ? m : 0;

    /// <summary>403 READ_ONLY naming the action.</summary>
    public void EnsureWritable(string action)
    {
        if (Profile.ReadOnly) throw EngineException.ReadOnly(Profile.Name, action);
    }

    public async Task<bool> PingAsync(CancellationToken ct)
    {
        try
        {
            var res = await Transport.SendAsync(HttpMethod.Get, "", null, null, ct, TimeSpan.FromSeconds(10)).ConfigureAwait(false);
            return res.Ok;
        }
        catch (EngineException)
        {
            return false;
        }
    }

    public ValueTask DisposeAsync()
    {
        Transport.Dispose();
        return ValueTask.CompletedTask;
    }
}
