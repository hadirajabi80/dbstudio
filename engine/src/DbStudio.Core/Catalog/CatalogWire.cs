using System.Buffers;
using System.Text.Json;
using DbStudio.Core.Models;
using DbStudio.Core.Services;

namespace DbStudio.Core.Catalog;

/// <summary>
/// Compact catalog JSON (docs/PLAN.md 3.3, D-10; ui/src/api/types.ts CatalogSnapshot/CatalogObject):
/// <c>{"t","n","cm"?,"c"?:[[name,type,nullable,isPk,flags,comment]],"pk"?,"fk"?:[{"n","cols","rs","rt","rcols","dis"?,"nt"?}],"p"?:[[name,type,dir,hasDefault]],
/// "target"?:{"d","s","n","t"},"members"?:[{"n","k","ov","p"}],"st"?}</c>. Empty/null optional members are omitted.
/// </summary>
public static class CatalogWire
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        SkipValidation = false,
    };

    /// <summary>
    /// Serializes one schema as <c>{"name","version","objects":[...],"refBy"?:[schema],"fkHidden"?:n}</c>: <c>refBy</c> names
    /// the other schemas with foreign keys into this one, <c>fkHidden</c> counts foreign keys left out because their
    /// target is not visible to the login (both optional, read by the ER diagram).
    /// </summary>
    public static byte[] SerializeSchema(SchemaCatalog schema, int version)
    {
        var buffer = new ArrayBufferWriter<byte>(4096);
        using (var w = new Utf8JsonWriter(buffer, WriterOptions))
        {
            w.WriteStartObject();
            w.WriteString("name", schema.Name);
            w.WriteNumber("version", version);
            w.WriteStartArray("objects");
            foreach (var o in schema.Objects) WriteObject(w, o);
            w.WriteEndArray();
            if (schema.ReferencingSchemas.Count > 0) WriteStrings(w, "refBy", schema.ReferencingSchemas);
            if (schema.HiddenForeignKeys > 0) w.WriteNumber("fkHidden", schema.HiddenForeignKeys);
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary>Composes a snapshot from pre-serialized schema payloads (no re-serialization of the objects).</summary>
    public static byte[] ComposeSnapshot(string connectionId, Dialect dialect, string? database, string defaultSchema, int version,
        IReadOnlyList<string> databases, IEnumerable<byte[]> schemas, IReadOnlyList<string>? searchPath = null)
    {
        var buffer = new ArrayBufferWriter<byte>(16 * 1024);
        using (var w = new Utf8JsonWriter(buffer, WriterOptions))
        {
            w.WriteStartObject();
            w.WriteString("connectionId", connectionId);
            w.WriteString("dialect", CoreJson.ToWire(dialect));
            if (database is null) w.WriteNull("database"); else w.WriteString("database", database);
            w.WriteString("defaultSchema", defaultSchema);
            w.WriteNumber("version", version);
            w.WriteStartArray("databases");
            foreach (var d in databases) w.WriteStringValue(d);
            w.WriteEndArray();
            if (searchPath is { Count: > 0 })
            {
                // PostgreSQL (docs/PLAN-PG.md D-PG7): unqualified names resolve in this order.
                w.WriteStartArray("searchPath");
                foreach (var s in searchPath) w.WriteStringValue(s);
                w.WriteEndArray();
            }
            w.WriteStartArray("schemas");
            foreach (var s in schemas) w.WriteRawValue(s, skipInputValidation: true);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        return buffer.WrittenSpan.ToArray();
    }

    public static void WriteObject(Utf8JsonWriter w, CatalogObject o)
    {
        w.WriteStartObject();
        w.WriteString("t", o.Type);
        w.WriteString("n", o.Name);
        if (!string.IsNullOrEmpty(o.Comment)) w.WriteString("cm", o.Comment);

        if (o.Columns.Count > 0)
        {
            w.WriteStartArray("c");
            foreach (var c in o.Columns)
            {
                w.WriteStartArray();
                w.WriteStringValue(c.Name);
                w.WriteStringValue(c.TypeText);
                w.WriteNumberValue(c.Nullable ? 1 : 0);
                w.WriteNumberValue(c.IsPk ? 1 : 0);
                w.WriteNumberValue(c.Flags);
                if (c.Comment is null) w.WriteNullValue(); else w.WriteStringValue(c.Comment);
                w.WriteEndArray();
            }
            w.WriteEndArray();
        }

        if (o.PrimaryKey.Count > 0) WriteStrings(w, "pk", o.PrimaryKey);

        if (o.ForeignKeys.Count > 0)
        {
            w.WriteStartArray("fk");
            foreach (var fk in o.ForeignKeys)
            {
                w.WriteStartObject();
                w.WriteString("n", fk.Name);
                WriteStrings(w, "cols", fk.Columns);
                if (fk.RefSchema is null) w.WriteNull("rs"); else w.WriteString("rs", fk.RefSchema);
                w.WriteString("rt", fk.RefTable);
                WriteStrings(w, "rcols", fk.RefColumns);
                if (fk.IsDisabled) w.WriteBoolean("dis", true);
                if (fk.IsNotTrusted) w.WriteBoolean("nt", true);
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }

        if (o.Parameters.Count > 0) WriteParams(w, "p", o.Parameters);

        if (o.Target is { } t)
        {
            w.WriteStartObject("target");
            if (t.Database is not null) w.WriteString("d", t.Database);
            if (t.Schema is null) w.WriteNull("s"); else w.WriteString("s", t.Schema);
            w.WriteString("n", t.Name);
            if (t.Type is null) w.WriteNull("t"); else w.WriteString("t", t.Type);
            w.WriteEndObject();
        }

        if (o.Members.Count > 0)
        {
            w.WriteStartArray("members");
            foreach (var m in o.Members)
            {
                w.WriteStartObject();
                w.WriteString("n", m.Name);
                w.WriteString("k", m.Kind);
                w.WriteNumber("ov", m.Overload);
                WriteParams(w, "p", m.Parameters);
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }

        if (!string.IsNullOrEmpty(o.Status)) w.WriteString("st", o.Status);
        w.WriteEndObject();
    }

    private static void WriteParams(Utf8JsonWriter w, string name, IReadOnlyList<ParamInfo> ps)
    {
        w.WriteStartArray(name);
        foreach (var p in ps)
        {
            w.WriteStartArray();
            w.WriteStringValue(p.Name);
            w.WriteStringValue(p.TypeText);
            w.WriteStringValue(p.Direction);
            w.WriteNumberValue(p.HasDefault ? 1 : 0);
            w.WriteEndArray();
        }
        w.WriteEndArray();
    }

    private static void WriteStrings(Utf8JsonWriter w, string name, IEnumerable<string> values)
    {
        w.WriteStartArray(name);
        foreach (var v in values) w.WriteStringValue(v);
        w.WriteEndArray();
    }
}
