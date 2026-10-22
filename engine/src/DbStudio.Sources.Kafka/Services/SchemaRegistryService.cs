using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka.Services;

public sealed record SrReference(string Name, string Subject, int Version);

/// <param name="SchemaType">AVRO | PROTOBUF | JSON.</param>
public sealed record SrSchema(int Id, string SchemaType, string Schema, IReadOnlyList<SrReference> References);

public sealed record SrVersion(string Subject, int Version, int Id, string SchemaType, string Schema, IReadOnlyList<SrReference> References)
{
    public SrSchema ToSchema() => new(Id, SchemaType, Schema, References);
}

/// <summary>The Confluent Schema Registry REST API subset Rowlit uses (seam: tests pass a fake HttpMessageHandler).</summary>
public interface ISchemaRegistry
{
    Task<IReadOnlyList<string>> SubjectsAsync(CancellationToken ct);
    Task<IReadOnlyList<int>> VersionsAsync(string subject, CancellationToken ct);

    /// <param name="version">A version number or "latest".</param>
    Task<SrVersion> VersionAsync(string subject, string version, CancellationToken ct);

    Task<SrSchema> SchemaByIdAsync(int id, CancellationToken ct);

    /// <summary>Subjects/versions using a schema id (empty when the registry does not support the endpoint).</summary>
    Task<IReadOnlyList<(string Subject, int Version)>> SubjectsOfIdAsync(int id, CancellationToken ct);
}

/// <summary>
/// REST client of the Schema Registry with per-id caches (schemas never change for an id, docs/PLAN-M2.md 7.4).
/// Basic auth from <c>schemaRegistryUser</c> / <c>schemaRegistrySecret</c>.
/// </summary>
public sealed class HttpSchemaRegistry : ISchemaRegistry, IDisposable
{
    private readonly HttpClient _http;
    private readonly ConcurrentDictionary<int, Task<SrSchema>> _byId = new();
    private readonly ConcurrentDictionary<int, IReadOnlyList<(string, int)>> _subjectsOfId = new();

    public HttpSchemaRegistry(string baseUrl, string? user, string? secret, HttpMessageHandler? handler = null, TimeSpan? timeout = null)
    {
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: true);
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.Timeout = timeout ?? TimeSpan.FromSeconds(15);
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.schemaregistry.v1+json"));
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (user is not null)
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic",
                Convert.ToBase64String(Encoding.UTF8.GetBytes($"{user}:{secret ?? ""}")));
    }

    public async Task<IReadOnlyList<string>> SubjectsAsync(CancellationToken ct)
    {
        using var doc = await GetAsync("subjects", ct).ConfigureAwait(false);
        return doc.RootElement.EnumerateArray().Select(e => e.GetString() ?? "").Where(s => s.Length > 0).Order(StringComparer.Ordinal).ToList();
    }

    public async Task<IReadOnlyList<int>> VersionsAsync(string subject, CancellationToken ct)
    {
        using var doc = await GetAsync($"subjects/{Uri.EscapeDataString(subject)}/versions", ct).ConfigureAwait(false);
        return doc.RootElement.EnumerateArray().Select(e => e.GetInt32()).Order().ToList();
    }

    public async Task<SrVersion> VersionAsync(string subject, string version, CancellationToken ct)
    {
        using var doc = await GetAsync($"subjects/{Uri.EscapeDataString(subject)}/versions/{Uri.EscapeDataString(version)}", ct).ConfigureAwait(false);
        var r = doc.RootElement;
        var v = new SrVersion(r.GetProperty("subject").GetString() ?? subject, r.GetProperty("version").GetInt32(), r.GetProperty("id").GetInt32(),
            TypeOf(r), r.GetProperty("schema").GetString() ?? "", RefsOf(r));
        _byId.TryAdd(v.Id, Task.FromResult(v.ToSchema()));
        return v;
    }

    public Task<SrSchema> SchemaByIdAsync(int id, CancellationToken ct)
    {
        var task = _byId.GetOrAdd(id, i => LoadByIdAsync(i));
        if (task.IsFaulted || task.IsCanceled) _byId.TryRemove(new KeyValuePair<int, Task<SrSchema>>(id, task));
        return task.WaitAsync(ct);
    }

    private async Task<SrSchema> LoadByIdAsync(int id)
    {
        try
        {
            using var doc = await GetAsync($"schemas/ids/{id}", CancellationToken.None).ConfigureAwait(false);
            var r = doc.RootElement;
            return new SrSchema(id, TypeOf(r), r.GetProperty("schema").GetString() ?? "", RefsOf(r));
        }
        catch
        {
            _byId.TryRemove(id, out _);
            throw;
        }
    }

    public async Task<IReadOnlyList<(string Subject, int Version)>> SubjectsOfIdAsync(int id, CancellationToken ct)
    {
        if (_subjectsOfId.TryGetValue(id, out var cached)) return cached;
        try
        {
            using var doc = await GetAsync($"schemas/ids/{id}/versions", ct).ConfigureAwait(false);
            IReadOnlyList<(string, int)> list = doc.RootElement.EnumerateArray()
                .Select(e => (e.GetProperty("subject").GetString() ?? "", e.GetProperty("version").GetInt32())).ToList();
            _subjectsOfId[id] = list;
            return list;
        }
        catch (EngineException)
        {
            _subjectsOfId[id] = [];
            return [];
        }
    }

    private static string TypeOf(JsonElement r) =>
        r.TryGetProperty("schemaType", out var t) && t.GetString() is { Length: > 0 } s ? s.ToUpperInvariant() : "AVRO";

    private static IReadOnlyList<SrReference> RefsOf(JsonElement r) =>
        r.TryGetProperty("references", out var refs) && refs.ValueKind == JsonValueKind.Array
            ? refs.EnumerateArray().Select(x => new SrReference(x.GetProperty("name").GetString() ?? "", x.GetProperty("subject").GetString() ?? "",
                x.GetProperty("version").GetInt32())).ToList()
            : [];

    private async Task<JsonDocument> GetAsync(string path, CancellationToken ct)
    {
        HttpResponseMessage res;
        try { res = await _http.GetAsync(path, ct).ConfigureAwait(false); }
        catch (HttpRequestException ex) { throw new EngineException(422, ErrorCodes.ProviderError, $"Schema Registry is unreachable: {ex.Message}"); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { throw new EngineException(422, ErrorCodes.ProviderError, "Schema Registry did not answer in time."); }
        using (res)
        {
            var body = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (res.IsSuccessStatusCode) return JsonDocument.Parse(body);
            var message = body;
            try
            {
                using var err = JsonDocument.Parse(body);
                if (err.RootElement.TryGetProperty("message", out var m)) message = m.GetString() ?? body;
            }
            catch (JsonException) { /* not JSON */ }
            throw res.StatusCode switch
            {
                HttpStatusCode.NotFound => new EngineException(404, ErrorCodes.NotFound, $"Schema Registry: {message}"),
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => EngineException.Privilege($"Schema Registry denied the request: {message}", "Schema Registry read access"),
                _ => new EngineException(422, ErrorCodes.ProviderError, $"Schema Registry answered {(int)res.StatusCode}: {message}"),
            };
        }
    }

    public void Dispose() => _http.Dispose();
}

/// <summary><c>GET /kafka/{cid}/schemas/...</c>: subjects (with latest version and type, best effort) and subject versions.</summary>
public sealed class SchemaService
{
    public const int DetailedSubjects = 200;

    public async Task<IReadOnlyList<KafkaSchemaSubjectDto>> SubjectsAsync(KafkaClientHandle h, CancellationToken ct)
    {
        var sr = h.Schemas.Registry;
        var subjects = await sr.SubjectsAsync(ct).ConfigureAwait(false);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(5));
        using var gate = new SemaphoreSlim(8);
        var details = await Task.WhenAll(subjects.Take(DetailedSubjects).Select(async s =>
        {
            try
            {
                await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                try { return (s, (SrVersion?)await sr.VersionAsync(s, "latest", budget.Token).ConfigureAwait(false)); }
                finally { gate.Release(); }
            }
            catch (Exception ex) when (ex is EngineException or OperationCanceledException && !ct.IsCancellationRequested) { return (s, null); }
        })).ConfigureAwait(false);
        var bySubject = details.ToDictionary(d => d.s, d => d.Item2, StringComparer.Ordinal);
        return subjects.Select(s => bySubject.GetValueOrDefault(s) is { } v
            ? new KafkaSchemaSubjectDto(s, null, v.Version, v.SchemaType)
            : new KafkaSchemaSubjectDto(s, null, null, null)).ToList();
    }

    public async Task<KafkaSchemaVersionDto> VersionAsync(KafkaClientHandle h, string subject, string version, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(subject)) throw EngineException.Validation("A subject is required.", new { field = "subject" });
        if (version != "latest" && (!int.TryParse(version, out var n) || n < 1))
            throw EngineException.Validation("version must be a positive number or 'latest'.", new { field = "version" });
        var v = await h.Schemas.Registry.VersionAsync(subject, version, ct).ConfigureAwait(false);
        return new KafkaSchemaVersionDto(v.Subject, v.Version, v.Id, v.SchemaType, v.Schema,
            v.References.Select(r => new KafkaSchemaReferenceDto(r.Name, r.Subject, r.Version)).ToList());
    }
}
