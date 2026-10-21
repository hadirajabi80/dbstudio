using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Services;
using DbStudio.Sources.Mongo.Endpoints;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo.Services;

/// <summary>A validated export request.</summary>
public sealed record ExportPlan(string Format, FindSpec Spec, IReadOnlyList<string>? Fields, bool Canonical, string? Path)
{
    public string Extension => Format;
}

/// <summary>A validated import request.</summary>
public sealed record ImportPlan(string Format, string? Path, string? Upload, string Mode, string UpsertKey, int BatchSize, bool StopOnError,
    bool Header, char Delimiter, bool TypeInference, IReadOnlyDictionary<string, string> Types);

/// <summary>One parsed input record: a document or an error.</summary>
public sealed record ImportRecord(int Index, BsonDocument? Doc, string? Error);

/// <summary>
/// Import / export (docs/PLAN-M2.md 6.5). Export: JSON (pretty array), JSONL, CSV (flattened dotted paths, RFC 4180).
/// Import: JSON (array or concatenated documents, parsed with <see cref="ShellJson"/>), JSONL, CSV (RFC 4180, optional
/// header, type inference over the first 20 rows, per-column overrides, dotted names build subdocuments).
/// </summary>
public sealed partial class ImportExportService
{
    public const int PreviewRows = 20, MaxErrors = 100;

    // ---------------------------------------------------------------- export

    public static ExportPlan ParseExport(MongoExportRequest req)
    {
        var format = req.Format ?? "json";
        if (format is not ("json" or "jsonl" or "csv")) throw MongoValidate.Fail("format", "format is json, jsonl or csv.");
        if (req.Limit is { } l) MongoValidate.Range(l, 1, int.MaxValue, "limit");
        var mode = req.EjsonMode ?? "relaxed";
        if (mode is not ("relaxed" or "canonical")) throw MongoValidate.Fail("ejsonMode", "ejsonMode is relaxed or canonical.");
        var spec = new FindSpec(ShellJson.ParseDocument(req.Filter, "filter"),
            DocumentsService.NullIfEmpty(ShellJson.ParseDocument(req.Projection, "projection")),
            DocumentsService.NullIfEmpty(ShellJson.ParseDocument(req.Sort, "sort")), 0, req.Limit);
        List<string>? fields = null;
        if (req.Fields is { Count: > 0 })
            fields = req.Fields.Select((f, i) => MongoValidate.FieldPath(f, $"fields[{i}]")).Distinct(StringComparer.Ordinal).ToList();
        string? path = null;
        if (!string.IsNullOrWhiteSpace(req.Path))
        {
            path = req.Path.Trim();
            if (!System.IO.Path.IsPathFullyQualified(path)) throw MongoValidate.Fail("path", "The export path must be absolute.");
            var dir = System.IO.Path.GetDirectoryName(path);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) throw MongoValidate.Fail("path", $"The folder '{dir}' does not exist.");
        }
        return new ExportPlan(format, spec, fields, mode == "canonical", path);
    }

    /// <summary>Writes the export to <paramref name="output"/>; returns the number of documents written.</summary>
    public async Task<long> ExportAsync(MongoClientHandle h, string db, string coll, ExportPlan plan, Stream output, JobContext? job, CancellationToken ct)
    {
        await using var w = new StreamWriter(output, new UTF8Encoding(false), 64 * 1024, leaveOpen: true);
        long n = 0;
        switch (plan.Format)
        {
            case "json":
                await w.WriteAsync("[").ConfigureAwait(false);
                await foreach (var d in h.Gateway.FindStreamAsync(db, coll, plan.Spec, ct).ConfigureAwait(false))
                {
                    await w.WriteAsync(n == 0 ? "\n" : ",\n").ConfigureAwait(false);
                    var text = Ejson.Write(d, plan.Canonical, indent: true);
                    await w.WriteAsync("  " + text.ReplaceLineEndings("\n").Replace("\n", "\n  ", StringComparison.Ordinal)).ConfigureAwait(false);
                    Progress(job, ++n);
                }
                await w.WriteAsync(n == 0 ? "]\n" : "\n]\n").ConfigureAwait(false);
                break;
            case "jsonl":
                await foreach (var d in h.Gateway.FindStreamAsync(db, coll, plan.Spec, ct).ConfigureAwait(false))
                {
                    await w.WriteAsync(Ejson.Write(d, plan.Canonical, indent: false)).ConfigureAwait(false);
                    await w.WriteAsync('\n').ConfigureAwait(false);
                    Progress(job, ++n);
                }
                break;
            default:
            {
                var header = plan.Fields?.ToList();
                if (header is null)
                {
                    // First pass: the union of the flattened paths in first-seen order.
                    var seen = new HashSet<string>(StringComparer.Ordinal);
                    header = [];
                    await foreach (var d in h.Gateway.FindStreamAsync(db, coll, plan.Spec, ct).ConfigureAwait(false))
                        foreach (var p in Flatten(d).Keys)
                            if (seen.Add(p)) header.Add(p);
                }
                await w.WriteAsync(string.Join(',', header.Select(CsvQuote)) + "\r\n").ConfigureAwait(false);
                await foreach (var d in h.Gateway.FindStreamAsync(db, coll, plan.Spec, ct).ConfigureAwait(false))
                {
                    await w.WriteAsync(CsvRow(d, header) + "\r\n").ConfigureAwait(false);
                    Progress(job, ++n);
                }
                break;
            }
        }
        await w.FlushAsync(ct).ConfigureAwait(false);
        job?.Report(n, null, null, force: true);
        return n;
    }

    private static void Progress(JobContext? job, long n)
    {
        if (job is not null && n % 500 == 0) job.Report(n);
    }

    /// <summary>Dotted paths of the leaves; arrays and empty subdocuments are leaves.</summary>
    public static Dictionary<string, BsonValue> Flatten(BsonDocument doc)
    {
        var result = new Dictionary<string, BsonValue>(StringComparer.Ordinal);
        void Walk(BsonDocument d, string prefix)
        {
            foreach (var el in d)
            {
                var path = prefix.Length == 0 ? el.Name : prefix + "." + el.Name;
                if (el.Value is BsonDocument { ElementCount: > 0 } sub) Walk(sub, path);
                else result.TryAdd(path, el.Value);
            }
        }
        Walk(doc, "");
        return result;
    }

    public static string CsvRow(BsonDocument doc, IReadOnlyList<string> header)
    {
        var flat = Flatten(doc);
        return string.Join(',', header.Select(f =>
        {
            if (flat.TryGetValue(f, out var v)) return CsvQuote(CsvCell(v));
            var nested = Lookup(doc, f);
            return nested is null ? "" : CsvQuote(CsvCell(nested));
        }));
    }

    private static BsonValue? Lookup(BsonDocument doc, string path)
    {
        BsonValue current = doc;
        foreach (var part in path.Split('.'))
        {
            if (current is BsonDocument d && d.TryGetValue(part, out var v)) current = v;
            else return null;
        }
        return current;
    }

    /// <summary>CSV cell text: ObjectId hex, ISO dates, numbers invariant, binary base64, null empty, others compact JSON.</summary>
    public static string CsvCell(BsonValue v) => v.BsonType switch
    {
        BsonType.Null or BsonType.Undefined => "",
        BsonType.String => v.AsString,
        BsonType.ObjectId => v.AsObjectId.ToString(),
        BsonType.DateTime => IsoDate(v.AsBsonDateTime),
        BsonType.Int32 => v.AsInt32.ToString(CultureInfo.InvariantCulture),
        BsonType.Int64 => v.AsInt64.ToString(CultureInfo.InvariantCulture),
        BsonType.Decimal128 => v.AsDecimal128.ToString(),
        BsonType.Double => v.AsDouble.ToString("R", CultureInfo.InvariantCulture),
        BsonType.Boolean => v.AsBoolean ? "true" : "false",
        BsonType.Binary => Convert.ToBase64String(v.AsBsonBinaryData.Bytes),
        BsonType.Symbol => v.AsBsonSymbol.Name,
        _ => Ejson.Compact(v),
    };

    public static string IsoDate(BsonDateTime d)
    {
        var ms = d.MillisecondsSinceEpoch;
        if (ms < -62135596800000 || ms > 253402300799999) return ms.ToString(CultureInfo.InvariantCulture);
        return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
    }

    /// <summary>RFC 4180 quoting: fields with a comma, quote, CR or LF are quoted, quotes doubled.</summary>
    public static string CsvQuote(string s) =>
        s.AsSpan().IndexOfAny(",\"\r\n") >= 0 ? "\"" + s.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" : s;

    // ---------------------------------------------------------------- import

    public static ImportPlan ParseImport(MongoImportRequest req)
    {
        var format = req.Format ?? "json";
        if (format is not ("json" or "jsonl" or "csv")) throw MongoValidate.Fail("format", "format is json, jsonl or csv.");
        var mode = req.Mode ?? "insert";
        if (mode is not ("insert" or "upsert")) throw MongoValidate.Fail("mode", "mode is insert or upsert.");
        var key = string.IsNullOrWhiteSpace(req.UpsertKey) ? "_id" : MongoValidate.FieldPath(req.UpsertKey.Trim(), "upsertKey");
        var batch = MongoValidate.Range(req.BatchSize ?? 1000, 1, 10_000, "batchSize");
        string? path = null;
        if (req.Upload is null)
        {
            if (string.IsNullOrWhiteSpace(req.Path)) throw MongoValidate.Fail("path", "Give a file path or upload the file.");
            path = req.Path.Trim();
            if (!File.Exists(path)) throw MongoValidate.Fail("path", $"The file '{path}' does not exist.");
        }
        var csv = req.Csv ?? new MongoCsvOptions();
        var delimiter = (csv.Delimiter ?? ",") switch
        {
            "," => ',',
            ";" => ';',
            "\t" or "\\t" or "tab" => '\t',
            "|" => '|',
            _ => throw MongoValidate.Fail("csv.delimiter", "The delimiter is ',', ';', tab or '|'."),
        };
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (col, t) in csv.Types ?? [])
        {
            if (t is not ("string" or "number" or "boolean" or "date" or "objectId"))
                throw MongoValidate.Fail($"csv.types.{col}", "Column types are string, number, boolean, date or objectId.");
            types[col] = t;
        }
        return new ImportPlan(format, path, req.Upload, mode, key, batch, req.StopOnError, csv.Header, delimiter, csv.TypeInference, types);
    }

    private static TextReader Open(ImportPlan plan) =>
        plan.Upload is not null ? new StringReader(plan.Upload) : new StreamReader(plan.Path!, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

    /// <summary>Parsed records of the input; <paramref name="columns"/> is set for CSV (after inference over the first rows).</summary>
    public static IEnumerable<ImportRecord> ReadRecords(ImportPlan plan, out IReadOnlyList<MongoImportColumn>? columns)
    {
        if (plan.Format == "csv")
        {
            var reader = new CsvImport(plan, Open(plan));
            columns = reader.Columns;
            return reader.Records();
        }
        columns = null;
        return plan.Format == "jsonl" ? ReadJsonLines(plan) : ReadJson(plan);
    }

    private static IEnumerable<ImportRecord> ReadJson(ImportPlan plan)
    {
        string text;
        using (var r = Open(plan)) text = r.ReadToEnd();
        using var e = ShellJson.ParseMany(text, plan.Path is null ? "upload" : "path").GetEnumerator();
        var i = 0;
        while (true)
        {
            BsonValue? v = null;
            string? error = null;
            try
            {
                if (!e.MoveNext()) yield break;
                v = e.Current;
            }
            catch (ShellJsonException ex)
            {
                error = $"document {i + 1}: {ex.Message}";
            }
            if (v is null)
            {
                yield return new ImportRecord(i, null, error);
                yield break; // the rest of the text cannot be resynchronised
            }
            yield return v is BsonDocument d
                ? new ImportRecord(i, d, null)
                : new ImportRecord(i, null, $"document {i + 1}: expected a document, found {ShellJson.Describe(v)}.");
            i++;
        }
    }

    private static IEnumerable<ImportRecord> ReadJsonLines(ImportPlan plan)
    {
        using var r = Open(plan);
        var i = 0;
        var lineNo = 0;
        while (r.ReadLine() is { } line)
        {
            lineNo++;
            if (string.IsNullOrWhiteSpace(line)) continue;
            ImportRecord rec;
            try
            {
                rec = new ImportRecord(i, ShellJson.ParseDocument(line, $"line {lineNo}"), null);
            }
            catch (ShellJsonException ex)
            {
                rec = new ImportRecord(i, null, $"line {lineNo}: {ex.Message}");
            }
            yield return rec;
            i++;
        }
    }

    public static MongoImportPreview Preview(ImportPlan plan)
    {
        var docs = new List<string>();
        var errors = new List<MongoImportError>();
        var records = ReadRecords(plan, out var columns);
        foreach (var rec in records.Take(PreviewRows))
        {
            if (rec.Doc is not null) docs.Add(Ejson.Canonical(rec.Doc));
            else errors.Add(new MongoImportError(rec.Index, rec.Error!));
        }
        return new MongoImportPreview(docs, columns, errors);
    }

    public async Task<MongoImportResult> ImportAsync(MongoClientHandle h, string db, string coll, ImportPlan plan, JobContext? job, CancellationToken ct)
    {
        long inserted = 0, upserted = 0, failed = 0, done = 0;
        var errors = new List<MongoImportError>();
        var stop = false;

        void Fail(int index, string message)
        {
            failed++;
            if (errors.Count < MaxErrors) errors.Add(new MongoImportError(index, message));
            if (plan.StopOnError) stop = true;
        }

        var batch = new List<BsonDocument>();
        var indices = new List<int>();

        async Task FlushAsync()
        {
            if (batch.Count == 0) return;
            if (plan.Mode == "insert")
            {
                var r = await h.Gateway.InsertManyAsync(db, coll, batch, plan.StopOnError, ct).ConfigureAwait(false);
                inserted += r.Inserted;
                foreach (var e in r.Errors) Fail(indices[Math.Clamp(e.Index, 0, indices.Count - 1)], $"document {indices[Math.Clamp(e.Index, 0, indices.Count - 1)] + 1}: {e.Message}");
            }
            else
            {
                var r = await h.Gateway.BulkUpsertAsync(db, coll, batch, plan.UpsertKey, plan.StopOnError, ct).ConfigureAwait(false);
                inserted += r.Upserted;
                upserted += r.Matched;
                foreach (var e in r.Errors) Fail(indices[Math.Clamp(e.Index, 0, indices.Count - 1)], $"document {indices[Math.Clamp(e.Index, 0, indices.Count - 1)] + 1}: {e.Message}");
            }
            done += batch.Count;
            batch.Clear();
            indices.Clear();
            job?.Report(done + failed, null, $"{inserted + upserted:N0} written", force: true);
        }

        foreach (var rec in ReadRecords(plan, out _))
        {
            ct.ThrowIfCancellationRequested();
            if (rec.Doc is null)
            {
                Fail(rec.Index, rec.Error!);
            }
            else if (plan.Mode == "upsert" && BsonKit.GetPath(rec.Doc, plan.UpsertKey) is null)
            {
                Fail(rec.Index, $"document {rec.Index + 1}: it has no '{plan.UpsertKey}' field to upsert by.");
            }
            else
            {
                batch.Add(rec.Doc);
                indices.Add(rec.Index);
            }
            if (batch.Count >= plan.BatchSize || stop) await FlushAsync().ConfigureAwait(false);
            if (stop) break;
        }
        if (!stop) await FlushAsync().ConfigureAwait(false);
        return new MongoImportResult(inserted, upserted, failed, errors);
    }

    // ---------------------------------------------------------------- CSV

    /// <summary>RFC 4180 records (quoted fields, doubled quotes, line breaks inside quotes); blank lines are skipped.</summary>
    public static IEnumerable<List<string>> ReadCsv(TextReader r, char delimiter)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;
        var quoted = false;
        var first = true;
        while (true)
        {
            var c = r.Read();
            if (first)
            {
                first = false;
                if (c == '﻿') continue;
            }
            if (c == -1)
            {
                if (sb.Length > 0 || fields.Count > 0 || quoted)
                {
                    fields.Add(sb.ToString());
                    yield return fields;
                }
                yield break;
            }
            var ch = (char)c;
            if (inQuotes)
            {
                if (ch == '"')
                {
                    if (r.Peek() == '"')
                    {
                        r.Read();
                        sb.Append('"');
                    }
                    else inQuotes = false;
                }
                else sb.Append(ch);
                continue;
            }
            if (ch == '"' && sb.Length == 0)
            {
                inQuotes = true;
                quoted = true;
            }
            else if (ch == delimiter)
            {
                fields.Add(sb.ToString());
                sb.Clear();
                quoted = false;
            }
            else if (ch is '\r' or '\n')
            {
                if (ch == '\r' && r.Peek() == '\n') r.Read();
                fields.Add(sb.ToString());
                sb.Clear();
                var blank = fields.Count == 1 && fields[0].Length == 0 && !quoted;
                quoted = false;
                if (!blank) yield return fields;
                fields = [];
            }
            else sb.Append(ch);
        }
    }

    private sealed partial class CsvImport
    {
        private readonly ImportPlan _plan;
        private readonly TextReader _reader;
        private readonly IEnumerator<List<string>> _rows;
        private readonly List<List<string>> _buffer = [];
        private readonly List<string> _names = [];
        private readonly List<(string Type, bool IntegerOnly)> _types = [];

        public IReadOnlyList<MongoImportColumn> Columns { get; }

        public CsvImport(ImportPlan plan, TextReader reader)
        {
            _plan = plan;
            _reader = reader;
            _rows = ReadCsv(reader, plan.Delimiter).GetEnumerator();
            if (plan.Header && _rows.MoveNext())
            {
                var i = 0;
                foreach (var name in _rows.Current)
                {
                    i++;
                    var n = name.Trim();
                    _names.Add(n.Length == 0 || _names.Contains(n) ? $"field{i}" : n);
                }
            }
            while (_buffer.Count < PreviewRows && _rows.MoveNext()) _buffer.Add(_rows.Current);
            var width = _buffer.Count == 0 ? 0 : _buffer.Max(r => r.Count);
            for (var i = _names.Count; i < width; i++) _names.Add($"field{i + 1}");
            for (var c = 0; c < _names.Count; c++) _types.Add(TypeOf(c));
            Columns = _names.Select((n, c) => new MongoImportColumn(n, _types[c].Type)).ToList();
        }

        private (string, bool) TypeOf(int column)
        {
            var cells = _buffer.Where(r => column < r.Count && r[column].Length > 0).Select(r => r[column]).ToList();
            var integerOnly = cells.Count > 0 && cells.All(IsInteger);
            if (_plan.Types.TryGetValue(_names[column], out var forced)) return (forced, integerOnly);
            if (!_plan.TypeInference || cells.Count == 0) return ("string", false);
            if (cells.All(c => c.Equals("true", StringComparison.OrdinalIgnoreCase) || c.Equals("false", StringComparison.OrdinalIgnoreCase)))
                return ("boolean", false);
            if (integerOnly) return ("number", true);
            if (cells.All(IsNumber)) return ("number", false);
            if (cells.All(c => IsoDate().IsMatch(c) && ShellJson.TryParseIsoDate(c, out _))) return ("date", false);
            if (cells.All(c => c.Length == 24 && c.All(Uri.IsHexDigit))) return ("objectId", false);
            return ("string", false);
        }

        private static bool IsInteger(string s) => long.TryParse(s.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _);

        private static bool IsNumber(string s) =>
            NumberText().IsMatch(s.Trim()) && double.TryParse(s.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out _);

        [GeneratedRegex(@"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")]
        private static partial Regex NumberText();

        [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")]
        private static partial Regex IsoDate();

        public IEnumerable<ImportRecord> Records()
        {
            try
            {
                var index = 0;
                foreach (var row in _buffer) yield return Convert(index++, row);
                while (_rows.MoveNext()) yield return Convert(index++, _rows.Current);
            }
            finally
            {
                _rows.Dispose();
                _reader.Dispose();
            }
        }

        private ImportRecord Convert(int index, List<string> row)
        {
            var doc = new BsonDocument();
            for (var c = 0; c < row.Count; c++)
            {
                var cell = row[c];
                if (cell.Length == 0) continue;
                var name = c < _names.Count ? _names[c] : $"field{c + 1}";
                var (type, integerOnly) = c < _types.Count ? _types[c] : ("string", false);
                var value = ToValue(cell, type, integerOnly);
                if (value is null) return new ImportRecord(index, null, $"row {index + 1}: '{Short(cell)}' is not a {type} for column {name}");
                if (name.Contains('.')) BsonKit.SetPath(doc, name, value);
                else doc[name] = value;
            }
            return new ImportRecord(index, doc, null);
        }

        private static string Short(string s) => s.Length > 40 ? s[..40] + "…" : s;

        private static BsonValue? ToValue(string cell, string type, bool integerOnly)
        {
            var t = cell.Trim();
            switch (type)
            {
                case "number":
                    if (integerOnly && long.TryParse(t, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var l))
                        return l is >= int.MinValue and <= int.MaxValue ? new BsonInt32((int)l) : new BsonInt64(l);
                    return IsNumber(t) && double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? new BsonDouble(d) : null;
                case "boolean":
                    return t.Equals("true", StringComparison.OrdinalIgnoreCase) ? BsonBoolean.True
                        : t.Equals("false", StringComparison.OrdinalIgnoreCase) ? BsonBoolean.False : null;
                case "date":
                    return ShellJson.TryParseIsoDate(t, out var ms) ? new BsonDateTime(ms) : null;
                case "objectId":
                    return ObjectId.TryParse(t, out var oid) ? oid : null;
                default:
                    return new BsonString(cell);
            }
        }
    }
}
