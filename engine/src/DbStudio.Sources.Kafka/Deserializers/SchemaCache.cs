using System.Collections.Concurrent;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Deserializers;

/// <summary>A registry schema parsed for one format, cached per schema id.</summary>
public sealed record ParsedSchema(int Id, string SchemaType, string? Subject, Avro.Schema? Avro, ProtobufSchema? Protobuf);

/// <summary>
/// Parsed schemas by id (docs/PLAN-M2.md 7.4: "schemas cached per id"), with registry references resolved recursively
/// (Avro named types, Protobuf imports). Failed loads are not cached, so a registry outage heals.
/// </summary>
public sealed class SchemaCache(ISchemaRegistry? registry)
{
    private readonly ConcurrentDictionary<int, Lazy<Task<ParsedSchema>>> _byId = new();

    public bool Available => registry is not null;

    public ISchemaRegistry Registry => registry ?? throw NoRegistry();

    public static EngineException NoRegistry() =>
        new(400, ErrorCodes.NotSupported, "No Schema Registry is configured for this connection (edit the connection: Schema Registry URL).",
            new { field = "schemaRegistryUrl" });

    public async Task<ParsedSchema> GetAsync(int id, CancellationToken ct)
    {
        var lazy = _byId.GetOrAdd(id, i => new Lazy<Task<ParsedSchema>>(() => LoadAsync(i)));
        try { return await lazy.Value.WaitAsync(ct).ConfigureAwait(false); }
        catch
        {
            if (lazy.Value.IsFaulted || lazy.Value.IsCanceled) _byId.TryRemove(new KeyValuePair<int, Lazy<Task<ParsedSchema>>>(id, lazy));
            throw;
        }
    }

    /// <summary>A subject version (produce with schema: subject + version or "latest").</summary>
    public async Task<ParsedSchema> GetVersionAsync(string subject, string version, CancellationToken ct)
    {
        var v = await Registry.VersionAsync(subject, version, ct).ConfigureAwait(false);
        var parsed = await GetAsync(v.Id, ct).ConfigureAwait(false);
        return parsed with { Subject = subject };
    }

    private async Task<ParsedSchema> LoadAsync(int id)
    {
        var sr = Registry;
        var schema = await sr.SchemaByIdAsync(id, CancellationToken.None).ConfigureAwait(false);
        string? subject = null;
        try { subject = (await sr.SubjectsOfIdAsync(id, CancellationToken.None).ConfigureAwait(false)).Select(s => s.Subject).FirstOrDefault(); }
        catch (EngineException) { /* optional endpoint */ }
        var refs = new List<(string Name, string Schema)>();
        await CollectReferencesAsync(sr, schema.References, refs, new HashSet<string>(StringComparer.Ordinal)).ConfigureAwait(false);
        try
        {
            return schema.SchemaType switch
            {
                "AVRO" => new ParsedSchema(id, "AVRO", subject, AvroCodec.Parse(schema.Schema, refs.Select(r => r.Schema)), null),
                "PROTOBUF" => new ParsedSchema(id, "PROTOBUF", subject, null, ProtobufSchema.Parse(schema.Schema, refs.ToDictionary(r => r.Name, r => r.Schema))),
                _ => new ParsedSchema(id, schema.SchemaType, subject, null, null),
            };
        }
        catch (Exception ex) when (ex is FormatException or Avro.SchemaParseException or Avro.AvroException)
        {
            throw new EngineException(422, ErrorCodes.ProviderError, $"Schema {id} could not be parsed: {ex.Message}");
        }
    }

    /// <summary>Dependencies first (depth-first), each once.</summary>
    private static async Task CollectReferencesAsync(ISchemaRegistry sr, IReadOnlyList<SrReference> refs, List<(string, string)> into, HashSet<string> seen)
    {
        foreach (var r in refs)
        {
            if (!seen.Add($"{r.Subject}/{r.Version}")) continue;
            var v = await sr.VersionAsync(r.Subject, r.Version.ToString(System.Globalization.CultureInfo.InvariantCulture), CancellationToken.None).ConfigureAwait(false);
            await CollectReferencesAsync(sr, v.References, into, seen).ConfigureAwait(false);
            into.Add((r.Name, v.Schema));
        }
    }
}
