using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Providers.ClickHouse.Tests;

/// <summary>
/// An in-process stand-in for the ClickHouse HTTP interface: answers each POST (query in the body, uncompressed) through a
/// route function with a RowBinaryWithNamesAndTypes body of string columns, and records every request.
/// </summary>
public sealed class FakeClickHouse : HttpMessageHandler
{
    public sealed record Request(string Query, Uri Uri, string? QueryId, string? SessionId, string? Database);

    public ConcurrentQueue<Request> Requests { get; } = new();

    /// <summary>Route: query → response (null = default: one row of empty strings for SELECTs, nothing otherwise).</summary>
    public Func<Request, CancellationToken, Task<HttpResponseMessage?>>? Route { get; set; }

    public static ConnectionProfile Profile(string id = "c_fake") => new()
    {
        Id = id,
        Name = "Fake ClickHouse",
        ProviderId = "clickhouse",
        Props = new Dictionary<string, JsonNode?>
        {
            ["host"] = "fake-clickhouse",
            ["port"] = 8123,
            ["database"] = "shop",
            ["user"] = "shop",
            ["compression"] = false,
        },
        HasPassword = true,
    };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
        var req = new Request(body.Length > 0 ? body : query["query"] ?? "", request.RequestUri, query["query_id"], query["session_id"], query["database"]);
        Requests.Enqueue(req);
        if (Route is not null && await Route(req, ct).ConfigureAwait(false) is { } routed)
        {
            if (req.QueryId is not null && !routed.Headers.Contains("X-ClickHouse-Query-Id")) routed.Headers.Add("X-ClickHouse-Query-Id", req.QueryId);
            return routed;
        }
        if (req.Query.Contains("version()", StringComparison.Ordinal))
            return Rows(req, ["version()", "hostName()", "currentUser()", "currentDatabase()", "timezone()"], [["24.8.0.1", "fake-host", "shop", req.Database ?? "shop", "UTC"]]);
        return Empty(req);
    }

    public static HttpResponseMessage Rows(Request req, string[] columns, IEnumerable<string[]> rows, string? summary = null)
    {
        var ms = new MemoryStream();
        void V(int n) { while (n >= 0x80) { ms.WriteByte((byte)(n | 0x80)); n >>= 7; } ms.WriteByte((byte)n); }
        void S(string s) { var b = Encoding.UTF8.GetBytes(s); V(b.Length); ms.Write(b); }
        V(columns.Length);
        foreach (var c in columns) S(c);
        foreach (var _ in columns) S("String");
        foreach (var row in rows) foreach (var v in row) S(v);
        var resp = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(ms.ToArray()) };
        if (req.QueryId is not null) resp.Headers.Add("X-ClickHouse-Query-Id", req.QueryId);
        if (summary is not null) resp.Headers.Add("X-ClickHouse-Summary", summary);
        return resp;
    }

    public static HttpResponseMessage Empty(Request req, string? summary = null)
    {
        var resp = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([]) };
        if (req.QueryId is not null) resp.Headers.Add("X-ClickHouse-Query-Id", req.QueryId);
        if (summary is not null) resp.Headers.Add("X-ClickHouse-Summary", summary);
        return resp;
    }

    public static HttpResponseMessage Error(string message, int code = 62) => new(HttpStatusCode.BadRequest)
    {
        Content = new StringContent($"Code: {code}. DB::Exception: {message} (version 24.8.0.1 (official build))"),
        Headers = { { "X-ClickHouse-Exception-Code", code.ToString(System.Globalization.CultureInfo.InvariantCulture) } },
    };
}
