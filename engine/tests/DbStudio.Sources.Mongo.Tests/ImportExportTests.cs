using System.Text;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using DbStudio.Sources.Mongo.Services;
using DbStudio.Sources.Mongo.Tests.Fake;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Tests;

public sealed class CsvTests
{
    private static ImportPlan Plan(string text, bool header = true, string delimiter = ",", bool infer = true, Dictionary<string, string>? types = null,
        string mode = "insert", string? key = null, bool stop = false, int batch = 1000) =>
        ImportExportService.ParseImport(new MongoImportRequest
        {
            Format = "csv", Upload = text, Mode = mode, UpsertKey = key, StopOnError = stop, BatchSize = batch,
            Csv = new MongoCsvOptions { Header = header, Delimiter = delimiter, TypeInference = infer, Types = types },
        });

    [Fact]
    public void Rfc4180_quotes_escaped_quotes_and_newlines()
    {
        var rows = ImportExportService.ReadCsv(new StringReader("a,b,c\r\n\"x, y\",\"say \"\"hi\"\"\",\"line1\nline2\"\n\n1,,3"), ',').ToList();
        Assert.Equal(3, rows.Count);
        Assert.Equal(["x, y", "say \"hi\"", "line1\nline2"], rows[1]);
        Assert.Equal(["1", "", "3"], rows[2]);
    }

    [Fact]
    public void Inference_per_column()
    {
        var csv = "id,price,big,ok,when,ref,name\n" +
                  "1,1.5,9999999999,TRUE,2024-01-02,66f1a2b3c4d5e6f708192a3b,Lamp\n" +
                  "2,2,1,false,2024-01-03T10:00:00Z,66f1a2b3c4d5e6f708192a3c,Desk\n";
        var preview = ImportExportService.Preview(Plan(csv));
        Assert.Equal([("id", "number"), ("price", "number"), ("big", "number"), ("ok", "boolean"), ("when", "date"), ("ref", "objectId"), ("name", "string")],
            preview.Columns!.Select(c => (c.Name, c.InferredType)));
        var d = BsonDocument.Parse(preview.Docs[0]);
        Assert.Equal(BsonType.Int32, d["id"].BsonType);
        Assert.Equal(BsonType.Double, d["price"].BsonType);
        Assert.Equal(BsonType.Int64, d["big"].BsonType);
        Assert.True(d["ok"].AsBoolean);
        Assert.Equal(BsonType.DateTime, d["when"].BsonType);
        Assert.Equal(BsonType.ObjectId, d["ref"].BsonType);
        Assert.Equal(2.0, BsonDocument.Parse(preview.Docs[1])["price"].AsDouble);
        Assert.Empty(preview.Errors);
    }

    [Fact]
    public void Overrides_no_header_delimiters_and_empty_cells()
    {
        var p = ImportExportService.Preview(Plan("007;x\n008;", header: false, delimiter: ";", types: new() { ["field1"] = "string" }));
        Assert.Equal(["field1", "field2"], p.Columns!.Select(c => c.Name));
        var d0 = BsonDocument.Parse(p.Docs[0]);
        Assert.Equal("007", d0["field1"].AsString);
        Assert.False(BsonDocument.Parse(p.Docs[1]).Contains("field2")); // empty cells are omitted
        var tab = ImportExportService.Preview(Plan("a\tb\n1\t2", delimiter: "\\t", infer: false));
        Assert.Equal("1", BsonDocument.Parse(tab.Docs[0])["a"].AsString);
        Assert.Throws<EngineException>(() => Plan("a", delimiter: "#"));
    }

    [Fact]
    public void Dotted_names_build_subdocuments()
    {
        var p = ImportExportService.Preview(Plan("name,address.city,address.geo.lat\nAlice,Paris,48.8"));
        Assert.Equal(ShellJson.ParseDocument("{ name: 'Alice', address: { city: 'Paris', geo: { lat: 48.8 } } }", "x"), BsonDocument.Parse(p.Docs[0]));
    }

    [Fact]
    public void Cells_that_fail_their_type_are_row_errors()
    {
        var p = ImportExportService.Preview(Plan("total,qty\n1,1\nabc,2\n3,x", types: new() { ["total"] = "number" }));
        Assert.Equal(2, p.Docs.Count); // qty infers as string ("x"), so row 3 is fine
        Assert.Equal(new MongoImportError(1, "row 2: 'abc' is not a number for column total"), Assert.Single(p.Errors));
        Assert.Equal("row 2: 'x' is not a number for column qty", ImportExportService.Preview(Plan("total,qty\n1,1\n3,x", types: new() { ["qty"] = "number" })).Errors[0].Message);
    }

    [Fact]
    public async Task Import_insert_mode_in_batches_with_errors()
    {
        var fake = T.Shop();
        var events = new RecordingPublisher();
        await using var jobs = new JobManager(events);
        var svc = new ImportExportService();
        var csv = "_id,email,n\n" + string.Join("\n", Enumerable.Range(0, 25).Select(i => $"{1000 + i},new{i}@x,{i}")) + "\n2000,c1@example.com,1\nbad,x,notanumber";
        var plan = Plan(csv, batch: 10, types: new() { ["n"] = "number" });
        var id = jobs.Start("mongo.import", "c_mongo", null, async (ctx, ct) => await svc.ImportAsync(T.Handle(fake), "shop", "customers", plan, ctx, ct));
        var done = await events.JobDone(id);
        Assert.Equal(ExecutionStatus.Ok, done.Status);
        var r = done.Result!.Value;
        Assert.Equal(25, r.GetProperty("inserted").GetInt64());
        Assert.Equal(2, r.GetProperty("failed").GetInt64());
        var errors = r.GetProperty("errors").EnumerateArray().ToList();
        var dup = errors.Single(e => e.GetProperty("message").GetString()!.Contains("E11000"));
        Assert.Equal(25, dup.GetProperty("index").GetInt32());
        var row = errors.Single(e => e.GetProperty("index").GetInt32() == 26);
        Assert.Equal("row 27: 'bad' is not a number for column _id", row.GetProperty("message").GetString());
        Assert.Equal(45, fake.Snapshot("shop", "customers").Count);
        Assert.True(events.All.OfType<JobProgressEvent>().Count(e => e.JobId == id) >= 3);
    }

    [Fact]
    public async Task Stop_on_error_stops_after_the_failing_batch()
    {
        var fake = T.Shop();
        var csv = "x\n1\n2\nbad\n4\n5";
        var r = await new ImportExportService().ImportAsync(T.Handle(fake), "db", "c", Plan(csv, stop: true, batch: 1, types: new() { ["x"] = "number" }), null, default);
        Assert.Equal((2L, 1L), (r.Inserted, r.Failed));
        Assert.Equal(2, fake.Snapshot("db", "c").Count);
    }

    [Fact]
    public async Task Upsert_mode_replaces_by_key()
    {
        var fake = T.Shop();
        var svc = new ImportExportService();
        var plan = ImportExportService.ParseImport(new MongoImportRequest
        {
            Format = "jsonl", Mode = "upsert", UpsertKey = "email",
            Upload = "{ email: 'c1@example.com', name: 'Replaced' }\n{ email: 'fresh@example.com', name: 'New' }\n{ name: 'no key' }\n",
        });
        var r = await svc.ImportAsync(T.Handle(fake), "shop", "customers", plan, null, default);
        Assert.Equal(new MongoImportResult(1, 1, 1, r.Errors), r);
        Assert.Contains("no 'email'", r.Errors[0].Message);
        var c1 = fake.Snapshot("shop", "customers").Single(d => d["email"] == "c1@example.com");
        Assert.Equal(1, c1["_id"].AsInt32); // _id kept
        Assert.Equal("Replaced", c1["name"].AsString);
        Assert.False(c1.Contains("tier"));
    }
}

public sealed class JsonImportTests
{
    [Fact]
    public void Json_array_concatenated_and_shell_helpers()
    {
        var arr = ImportExportService.Preview(ImportExportService.ParseImport(new MongoImportRequest
        {
            Format = "json", Upload = """[ { "_id": {"$oid": "66f1a2b3c4d5e6f708192a3b"}, "at": {"$date": "2024-01-01T00:00:00Z"} }, { n: NumberLong(5) } ]""",
        }));
        Assert.Equal(2, arr.Docs.Count);
        Assert.Contains("$oid", arr.Docs[0]);
        Assert.Contains("$numberLong", arr.Docs[1]);
        Assert.Null(arr.Columns);
        var concat = ImportExportService.Preview(ImportExportService.ParseImport(new MongoImportRequest { Format = "json", Upload = "{a:1}\n{a:2}\n{a:3}" }));
        Assert.Equal(3, concat.Docs.Count);
    }

    [Fact]
    public void Json_syntax_error_stops_and_non_documents_are_errors()
    {
        var p = ImportExportService.Preview(ImportExportService.ParseImport(new MongoImportRequest { Format = "json", Upload = "[{a:1}, 5, {a:]" }));
        Assert.Single(p.Docs);
        Assert.Equal(2, p.Errors.Count);
        Assert.Contains("expected a document, found a int", p.Errors[0].Message);
        Assert.StartsWith("document 3:", p.Errors[1].Message);
    }

    [Fact]
    public void Jsonl_errors_are_per_line()
    {
        var p = ImportExportService.Preview(ImportExportService.ParseImport(new MongoImportRequest { Format = "jsonl", Upload = "{a:1}\n{oops\n\n{a:3}\n" }));
        Assert.Equal(2, p.Docs.Count);
        Assert.Equal(1, Assert.Single(p.Errors).Index);
        Assert.StartsWith("line 2:", p.Errors[0].Message);
    }

    [Fact]
    public void File_paths_are_read_and_validated()
    {
        var dir = T.TempDir();
        var file = Path.Combine(dir, "in.jsonl");
        File.WriteAllText(file, "{a:1}\n{a:2}\n");
        var p = ImportExportService.Preview(ImportExportService.ParseImport(new MongoImportRequest { Format = "jsonl", Path = file }));
        Assert.Equal(2, p.Docs.Count);
        var ex = Assert.Throws<EngineException>(() => ImportExportService.ParseImport(new MongoImportRequest { Format = "jsonl", Path = Path.Combine(dir, "x") }));
        Assert.Equal("path", MongoSettingsBuilderTests.Field(ex));
        Assert.Equal("batchSize", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() =>
            ImportExportService.ParseImport(new MongoImportRequest { Upload = "", BatchSize = 0 }))));
        Assert.Equal("mode", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() =>
            ImportExportService.ParseImport(new MongoImportRequest { Upload = "", Mode = "merge" }))));
    }
}

public sealed class ExportTests
{
    private static async Task<string> Export(MongoFake fake, MongoExportRequest req, string coll = "orders")
    {
        using var ms = new MemoryStream();
        await new ImportExportService().ExportAsync(T.Handle(fake), "shop", coll, ImportExportService.ParseExport(req), ms, null, default);
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    [Fact]
    public async Task Json_is_a_pretty_array_relaxed_by_default()
    {
        var text = await Export(T.Shop(), new MongoExportRequest { Format = "json", Filter = "{ status: 'paid' }", Limit = 2, Sort = "{ total: 1 }" });
        Assert.StartsWith("[\n  {", text);
        Assert.EndsWith("}\n]\n", text);
        var arr = BsonSerializerArray(text);
        Assert.Equal(2, arr.Count);
        Assert.Contains("\"$date\" : \"", text);
        var canonical = await Export(T.Shop(), new MongoExportRequest { Format = "json", Limit = 1, EjsonMode = "canonical" });
        Assert.Contains("$numberDouble", canonical);
        Assert.Equal("[]\n", await Export(T.Shop(), new MongoExportRequest { Format = "json", Filter = "{ status: 'nope' }" }));
    }

    private static BsonArray BsonSerializerArray(string text) => BsonDocument.Parse("{ \"a\": " + text + " }")["a"].AsBsonArray;

    [Fact]
    public async Task Jsonl_is_one_document_per_line()
    {
        var text = await Export(T.Shop(), new MongoExportRequest { Format = "jsonl", Filter = "{ status: 'paid' }" });
        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(25, lines.Length);
        Assert.All(lines, l => BsonDocument.Parse(l));
    }

    [Fact]
    public async Task Csv_flattens_paths_and_quotes()
    {
        var fake = new MongoFake();
        fake.Seed("shop", "people",
            """{ _id: ObjectId("66f1a2b3c4d5e6f708192a3b"), name: "Smith, \"Jr\"", at: ISODate("2024-01-02T03:04:05.006Z"), n: NumberLong(5), d: NumberDecimal("1.50"), address: { city: "Paris", zip: 75001 }, tags: ["a", "b"], bin: BinData(0, "AQID"), nil: null, ok: true, f: 1.25 }""",
            """{ _id: 2, extra: "line1\nline2" }""");
        var text = await Export(fake, new MongoExportRequest { Format = "csv" }, "people");
        var lines = text.Split("\r\n");
        Assert.Equal("_id,name,at,n,d,address.city,address.zip,tags,bin,nil,ok,f,extra", lines[0]);
        Assert.Equal("66f1a2b3c4d5e6f708192a3b,\"Smith, \"\"Jr\"\"\",2024-01-02T03:04:05.006Z,5,1.50,Paris,75001,\"[\"\"a\"\",\"\"b\"\"]\",AQID,,true,1.25,", lines[1]);
        Assert.Equal("2,,,,,,,,,,,,\"line1\nline2\"", lines[2]);
        var picked = await Export(fake, new MongoExportRequest { Format = "csv", Fields = ["name", "address"] }, "people");
        Assert.StartsWith("name,address\r\n\"Smith, \"\"Jr\"\"\",\"{\"\"city\"\":\"\"Paris\"\",\"\"zip\"\":75001}\"\r\n", picked);
    }

    [Fact]
    public void Export_requests_are_validated()
    {
        Assert.Equal("format", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => ImportExportService.ParseExport(new MongoExportRequest { Format = "xml" }))));
        Assert.Equal("path", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => ImportExportService.ParseExport(new MongoExportRequest { Path = "relative.json" }))));
        Assert.Equal("ejsonMode", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => ImportExportService.ParseExport(new MongoExportRequest { EjsonMode = "shell" }))));
        Assert.Equal("fields[0]", MongoSettingsBuilderTests.Field(Assert.Throws<EngineException>(() => ImportExportService.ParseExport(new MongoExportRequest { Fields = ["$x"] }))));
    }
}

public sealed class ChangeStreamTests
{
    private sealed class Sink : IStreamSink
    {
        public readonly System.Collections.Concurrent.ConcurrentQueue<System.Text.Json.JsonElement> Items = new();
        public string StreamId => "st_test";
        public bool Paused => false;
        public bool Push(System.Text.Json.JsonElement item)
        {
            Items.Enqueue(item);
            return true;
        }
    }

    private static async Task Until(Func<bool> cond)
    {
        var until = DateTime.UtcNow.AddSeconds(10);
        while (!cond())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException();
            await Task.Delay(10);
        }
    }

    [Fact]
    public async Task Items_from_writes()
    {
        var fake = T.Shop();
        var h = T.Handle(fake);
        var stream = new MongoChangeStream(h, "shop", "customers", updateLookup: true);
        var sink = new Sink();
        using var cts = new CancellationTokenSource();
        var run = stream.RunAsync(sink, cts.Token);
        await Until(() => fake.Watchers == 1);
        await fake.InsertManyAsync("shop", "customers", [T.Doc("""{ "_id": 500, "name": "New" }""")], true, default);
        fake.Update("shop", "customers", 500, new BsonDocument("name", "Newer"), "tags");
        await fake.InsertManyAsync("shop", "orders", [T.Doc("""{ "_id": 1 }""")], true, default); // other collection: not watched
        await fake.DeleteManyAsync("shop", "customers", new BsonDocument("_id", 500), default);
        await Until(() => sink.Items.Count == 3);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);

        var items = sink.Items.ToList();
        Assert.Equal(["insert", "update", "delete"], items.Select(i => i.GetProperty("operationType").GetString()));
        Assert.Equal("shop", items[0].GetProperty("ns").GetProperty("db").GetString());
        Assert.Equal("customers", items[0].GetProperty("ns").GetProperty("coll").GetString());
        Assert.Equal("{ \"_id\" : { \"$numberInt\" : \"500\" } }", items[0].GetProperty("documentKey").GetString());
        Assert.Contains("\"New\"", items[0].GetProperty("fullDocument").GetString());
        Assert.Contains("\"Newer\"", items[1].GetProperty("fullDocument").GetString()); // updateLookup
        Assert.Equal(["tags"], items[1].GetProperty("updateDescription").GetProperty("removedFields").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("Newer", items[1].GetProperty("updateDescription").GetProperty("updatedFields").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, items[2].GetProperty("fullDocument").ValueKind);
        Assert.EndsWith("Z", items[0].GetProperty("ts").GetString());
    }

    [Fact]
    public async Task Standalone_servers_end_the_stream_with_the_message()
    {
        var stream = new MongoChangeStream(T.Handle(new MongoFake { Standalone = true }), "shop", null, false);
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => stream.RunAsync(new Sink(), default));
        Assert.Contains("replica set", ex.Message);
    }

    [Fact]
    public void Item_shape_from_a_raw_event()
    {
        var item = MongoChangeStream.ToItem(T.Doc("""{ "operationType": "dropDatabase", "clusterTime": { "$timestamp": { "t": 1700000000, "i": 1 } }, "ns": { "db": "shop" } }"""));
        Assert.Equal("2023-11-14T22:13:20.000Z", item.Ts);
        Assert.Null(item.Ns.Coll);
        Assert.Null(item.DocumentKey);
        Assert.Null(item.UpdateDescription);
    }
}
