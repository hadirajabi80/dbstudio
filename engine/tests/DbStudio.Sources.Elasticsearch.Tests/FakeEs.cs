using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace DbStudio.Sources.Elasticsearch.Tests;

/// <summary>
/// A tiny in-memory Elasticsearch behind an HttpMessageHandler: root/health/stats, _cat indices/aliases/nodes/shards,
/// index create/delete/mapping, documents with seq_no/primary_term concurrency, _bulk, match_all search with
/// from/size and scroll, _reindex as a task, _tasks, _sql (both flavors). <see cref="On"/> overrides any route.
/// </summary>
public sealed class FakeEs : HttpMessageHandler
{
    public sealed record Request(string Method, Uri Uri, string PathAndQuery, string? Body, string? ContentType, string? Authorization);

    public sealed class Doc
    {
        public required JsonObject Source { get; set; }
        public long SeqNo { get; set; }
        public long Version { get; set; } = 1;
    }

    public sealed class Index
    {
        public JsonObject Mappings { get; set; } = new() { ["properties"] = new JsonObject() };
        public Dictionary<string, Doc> Docs { get; } = new(StringComparer.Ordinal);
        public List<string> Aliases { get; } = [];
        public long NextSeq;
    }

    public string Flavor { get; set; } = "elasticsearch";
    public string Version { get; set; } = "8.15.3";
    public string ClusterName { get; set; } = "fake-cluster";
    public ConcurrentQueue<Request> Requests { get; } = new();
    /// <summary>Authorities ("host:port") that refuse connections.</summary>
    public HashSet<string> Down { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, Index> Indices { get; } = new(StringComparer.Ordinal);
    private readonly List<(string Method, Regex Path, Func<Request, (int, object?)> Respond)> _overrides = [];
    private readonly Dictionary<string, (string Index, int Offset, int Size)> _scrolls = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> _tasks = new(StringComparer.Ordinal);
    private int _nextTask = 1;
    private int _nextScroll = 1;
    private int _autoId = 1;

    /// <summary>Overrides a route: method + regex over the path (without query). The responder returns (status, body object or raw string).</summary>
    public FakeEs On(string method, string pathRegex, Func<Request, (int Status, object? Body)> respond)
    {
        lock (_overrides) _overrides.Insert(0, (method, new Regex($"^{pathRegex}$"), respond));
        return this;
    }

    public Index Add(string name, params (string Id, object Source)[] docs)
    {
        var idx = new Index();
        Indices[name] = idx;
        foreach (var (id, src) in docs) Put(idx, id, JsonSerializer.SerializeToNode(src)!.AsObject());
        return idx;
    }

    private static Doc Put(Index idx, string id, JsonObject source)
    {
        var seq = idx.NextSeq++;
        if (idx.Docs.TryGetValue(id, out var d))
        {
            d.Source = source;
            d.SeqNo = seq;
            d.Version++;
            return d;
        }
        d = new Doc { Source = source, SeqNo = seq };
        idx.Docs[id] = d;
        return d;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        var uri = request.RequestUri!;
        var req = new Request(request.Method.Method, uri, uri.PathAndQuery, body, request.Content?.Headers.ContentType?.MediaType, request.Headers.Authorization?.ToString());
        Requests.Enqueue(req);
        if (Down.Contains(uri.Authority)) throw new HttpRequestException($"No connection could be made because the target machine actively refused it. ({uri.Authority})");
        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        lock (_overrides)
        {
            foreach (var (m, rx, respond) in _overrides)
            {
                if (m == req.Method && rx.IsMatch(path))
                {
                    var (status, b) = respond(req);
                    return Respond(status, b);
                }
            }
        }
        lock (Indices)
        {
            var (s, o) = Route(req, path, Query(uri));
            return Respond(s, o);
        }
    }

    private static Dictionary<string, string> Query(Uri uri) =>
        uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(p => p.Split('=', 2)).ToDictionary(p => Uri.UnescapeDataString(p[0]), p => p.Length > 1 ? Uri.UnescapeDataString(p[1]) : "");

    private static HttpResponseMessage Respond(int status, object? body)
    {
        var res = new HttpResponseMessage((HttpStatusCode)status);
        if (body is string text) res.Content = new StringContent(text, Encoding.UTF8, "text/plain");
        else if (body is not null) res.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        else res.Content = new ByteArrayContent([]);
        return res;
    }

    public static object Error(int status, string type, string reason, string? rootType = null, string? rootReason = null) => new
    {
        error = new { root_cause = new[] { new { type = rootType ?? type, reason = rootReason ?? reason } }, type, reason },
        status,
    };

    private (int, object?) Route(Request req, string path, Dictionary<string, string> q)
    {
        var segs = req.Uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();
        var m = req.Method;
        switch (segs)
        {
            case [] when m == "GET":
                return (200, Flavor == "opensearch"
                    ? (object)new { name = "n1", cluster_name = ClusterName, cluster_uuid = "uuid-1", version = new { distribution = "opensearch", number = Version, lucene_version = "9.11.1" }, tagline = "The OpenSearch Project: https://opensearch.org/" }
                    : new { name = "n1", cluster_name = ClusterName, cluster_uuid = "uuid-1", version = new { number = Version, build_flavor = "default", lucene_version = "9.11.1" }, tagline = "You Know, for Search" });
            case ["_cluster", "health"]:
                return (200, new { cluster_name = ClusterName, status = "green", timed_out = false, number_of_nodes = 1, number_of_data_nodes = 1, active_primary_shards = Indices.Count,
                    active_shards = Indices.Count, relocating_shards = 0, initializing_shards = 0, unassigned_shards = 0, number_of_pending_tasks = 0, active_shards_percent_as_number = 100.0 });
            case ["_cluster", "stats"]:
                return (200, new { indices = new { count = Indices.Count, docs = new { count = Indices.Values.Sum(i => i.Docs.Count) }, store = new { size_in_bytes = 12345 } },
                    nodes = new { jvm = new { mem = new { heap_used_in_bytes = 100, heap_max_in_bytes = 1000 } }, fs = new { total_in_bytes = 5000, available_in_bytes = 4000 } } });
            case ["_cat", "nodes"]:
                return (200, new[] { new Dictionary<string, string> { ["id"] = "node-1-full", ["name"] = "n1", ["ip"] = "127.0.0.1", ["node.role"] = "cdfhilmrstw", ["master"] = "*",
                    ["version"] = Version, ["heap.percent"] = "41", ["ram.percent"] = "80", ["cpu"] = "3", ["load_1m"] = "0.52", ["disk.used_percent"] = "12.5", ["disk.used"] = "1000", ["disk.total"] = "8000", ["uptime"] = "1.2h" } });
            case ["_cat", "indices", ..]:
                return (200, Indices.Where(kv => segs.Length < 3 || kv.Key == segs[2]).OrderBy(kv => kv.Key).Select(kv => new Dictionary<string, string>
                {
                    ["health"] = "green", ["status"] = "open", ["index"] = kv.Key, ["uuid"] = $"u-{kv.Key}", ["pri"] = "1", ["rep"] = "0",
                    ["docs.count"] = kv.Value.Docs.Count.ToString(), ["docs.deleted"] = "0", ["store.size"] = "2048", ["pri.store.size"] = "2048",
                }).ToList());
            case ["_cat", "aliases", ..]:
                return (200, Indices.SelectMany(kv => kv.Value.Aliases.Select(a => new Dictionary<string, string>
                {
                    ["alias"] = a, ["index"] = kv.Key, ["filter"] = "-", ["routing.index"] = "-", ["routing.search"] = "-", ["is_write_index"] = "-",
                })).ToList());
            case ["_cat", "shards", var idx]:
                return (200, new[] { new Dictionary<string, string?> { ["index"] = idx, ["shard"] = "0", ["prirep"] = "p", ["state"] = "STARTED", ["docs"] = "3", ["store"] = "2048", ["ip"] = "127.0.0.1", ["node"] = "n1", ["unassigned.reason"] = null } });
            case ["_data_stream"]:
                return (200, new { data_streams = Array.Empty<object>() });
            case [_, "_settings", ..] when m == "GET":
                return (200, Indices.ToDictionary(kv => kv.Key, kv => (object)new { settings = new Dictionary<string, string> { ["index.creation_date"] = "1735689600000" } }));
            case ["_aliases"] when m == "POST":
                return Aliases(req);
            case ["_msearch"] when m == "POST":
            {
                var lines = (req.Body ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
                var responses = new List<object>();
                for (var i = 0; i + 1 < lines.Length; i += 2)
                {
                    var name = JsonNode.Parse(lines[i])!["index"]!.GetValue<string>();
                    // Pretend Lucene counted nested docs in _cat: the msearch answer is the real count.
                    responses.Add(Indices.TryGetValue(name, out var mi)
                        ? new { hits = new { total = new { value = mi.Docs.Count, relation = "eq" }, hits = Array.Empty<object>() }, status = 200 }
                        : (object)new { error = new { type = "index_not_found_exception", reason = name }, status = 404 });
                }
                return (200, new { took = 1, responses });
            }
            case ["_bulk"] when m == "POST":
                return Bulk(null, req, q);
            case ["_search", "scroll"] when m == "POST":
                return Scroll(req);
            case ["_search", "scroll"] when m == "DELETE":
                return (200, new { succeeded = true, num_freed = 1 });
            case ["_reindex"] when m == "POST":
                return Reindex(req);
            case ["_tasks"] when m == "GET":
                return (200, new { tasks = _tasks.Select(kv => kv.Value).ToList() });
            case ["_tasks", var id] when m == "GET":
                return _tasks.TryGetValue(id, out var t)
                    ? (200, new { completed = true, task = t, response = t["status"] })
                    : (404, Error(404, "resource_not_found_exception", $"task [{id}] isn't running and hasn't stored its results"));
            case ["_tasks", _, "_cancel"] when m == "POST":
                return (200, new { nodes = new { } });
            case ["_sql"] when m == "POST":
                return (200, new { columns = new[] { new { name = "status", type = "keyword" }, new { name = "n", type = "long" } }, rows = new object[][] { ["paid", 2], ["shipped", 1] }, cursor = "c1" });
            case ["_plugins", "_sql"] when m == "POST":
                return (200, new { schema = new object[] { new { name = "status", type = "keyword" }, new { name = "COUNT(*)", alias = "n", type = "long" } },
                    datarows = new object[][] { ["paid", 2] }, total = 1, size = 1, status = 200 });
            case ["_sql", "close"] or ["_plugins", "_sql", "close"] when m == "POST":
                return (200, new { succeeded = true });
            case ["_sql", "translate"] when m == "POST":
                return (200, new { size = 1000, query = new { match_all = new { } } });
            case [var idx] when m == "PUT":
                if (Indices.ContainsKey(idx)) return (400, Error(400, "resource_already_exists_exception", $"index [{idx}/x] already exists"));
                var created = new Index();
                if (req.Body is { Length: > 0 } && JsonNode.Parse(req.Body)?["mappings"] is JsonObject mp) created.Mappings = (JsonObject)mp.DeepClone();
                Indices[idx] = created;
                return (200, new { acknowledged = true, shards_acknowledged = true, index = idx });
            case [var idx] when m == "DELETE":
                return Indices.Remove(idx) ? (200, new { acknowledged = true }) : (404, IndexNotFound(idx));
            case [var idx] when m == "GET":
                return Find(idx) is { } found
                    ? (200, found.ToDictionary(kv => kv.Key, kv => (object)new { aliases = kv.Value.Aliases.ToDictionary(a => a, _ => new { }), mappings = kv.Value.Mappings, settings = new { index = new { number_of_shards = "1", number_of_replicas = "0", creation_date = "1735689600000" } } }))
                    : (404, IndexNotFound(idx));
            case [var idx, "_mapping"] when m == "GET":
                return Find(idx) is { } fm ? (200, fm.ToDictionary(kv => kv.Key, kv => (object)new { mappings = kv.Value.Mappings })) : (404, IndexNotFound(idx));
            case [var idx, "_stats"]:
                return (200, new { _all = new { primaries = new { docs = new { count = 3 } }, total = new { docs = new { count = 3 } } }, indices = new Dictionary<string, object> { [idx] = new { primaries = new { docs = new { count = 3 } }, total = new { docs = new { count = 3 } } } } });
            case [var idx, "_refresh" or "_flush" or "_open" or "_close" or "_forcemerge"]:
                return Indices.ContainsKey(idx) ? (200, new { _shards = new { total = 1, successful = 1, failed = 0 } }) : (404, IndexNotFound(idx));
            case [var idx, "_bulk"] when m == "POST":
                return Bulk(idx, req, q);
            case [var idx, "_search"] when m == "POST":
                return Search(idx, req, q);
            case [var idx, "_doc"] when m == "POST":
                return Write(idx, $"auto-{_autoId++}", req, q, isNew: true);
            case [var idx, "_doc", var id] when m == "GET":
                if (!Indices.TryGetValue(idx, out var gi)) return (404, IndexNotFound(idx));
                return gi.Docs.TryGetValue(id, out var gd)
                    ? (200, new { _index = idx, _id = id, _version = gd.Version, _seq_no = gd.SeqNo, _primary_term = 1, found = true, _source = gd.Source })
                    : (404, new { _index = idx, _id = id, found = false });
            case [var idx, "_doc", var id] when m == "PUT":
                return Write(idx, id, req, q, isNew: false);
            case [var idx, "_doc", var id] when m == "DELETE":
                if (!Indices.TryGetValue(idx, out var di)) return (404, IndexNotFound(idx));
                if (!di.Docs.TryGetValue(id, out var dd)) return (404, new { _index = idx, _id = id, result = "not_found", _version = 1 });
                if (q.TryGetValue("if_seq_no", out var dsq) && long.Parse(dsq) != dd.SeqNo) return (409, Conflict(idx, id, dd));
                di.Docs.Remove(id);
                return (200, new { _index = idx, _id = id, result = "deleted", _seq_no = di.NextSeq++, _primary_term = 1, _version = dd.Version + 1 });
        }
        return (400, Error(400, "illegal_argument_exception", $"no handler found for uri [{path}] and method [{m}]"));
    }

    private List<KeyValuePair<string, Index>>? Find(string target)
    {
        var parts = target.Split(',');
        var hits = Indices.Where(kv => parts.Any(p => p == kv.Key || kv.Value.Aliases.Contains(p) || (p.EndsWith('*') && kv.Key.StartsWith(p.TrimEnd('*'), StringComparison.Ordinal))))
            .OrderBy(kv => kv.Key).ToList();
        return hits.Count == 0 ? null : hits;
    }

    private static object IndexNotFound(string idx) => Error(404, "index_not_found_exception", $"no such index [{idx}]");

    private static object Conflict(string idx, string id, Doc d) =>
        Error(409, "version_conflict_engine_exception", $"[{id}]: version conflict, required seqNo [x], primary term [1]. current document has seqNo [{d.SeqNo}] and primary term [1]");

    private (int, object?) Write(string idx, string id, Request req, Dictionary<string, string> q, bool isNew)
    {
        if (!Indices.TryGetValue(idx, out var index)) Indices[idx] = index = new Index();
        var src = JsonNode.Parse(req.Body!)!.AsObject();
        var exists = index.Docs.TryGetValue(id, out var cur);
        if (q.GetValueOrDefault("op_type") == "create" && exists) return (409, Conflict(idx, id, cur!));
        if (q.TryGetValue("if_seq_no", out var sq) && (!exists || long.Parse(sq) != cur!.SeqNo)) return (409, exists ? Conflict(idx, id, cur!) : Error(409, "version_conflict_engine_exception", $"[{id}]: version conflict, document does not exist"));
        var d = Put(index, id, src);
        return (exists ? 200 : 201, new { _index = idx, _id = id, _version = d.Version, result = exists ? "updated" : "created", _seq_no = d.SeqNo, _primary_term = 1 });
    }

    private (int, object?) Bulk(string? defaultIndex, Request req, Dictionary<string, string> q)
    {
        var lines = (req.Body ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var items = new List<object>();
        var errors = false;
        for (var i = 0; i + 1 < lines.Length; i += 2)
        {
            var action = JsonNode.Parse(lines[i])!.AsObject();
            var op = action.First().Key;
            var meta = action[op]!.AsObject();
            var idx = meta["_index"]?.GetValue<string>() ?? defaultIndex!;
            var id = meta["_id"]?.GetValue<string>() ?? $"auto-{_autoId++}";
            JsonObject src;
            try { src = JsonNode.Parse(lines[i + 1])!.AsObject(); }
            catch (Exception) { errors = true; items.Add(new Dictionary<string, object> { [op] = new { _index = idx, _id = id, status = 400, error = new { type = "document_parsing_exception", reason = "failed to parse" } } }); continue; }
            if (src.ContainsKey("bad"))
            {
                errors = true;
                items.Add(new Dictionary<string, object> { [op] = new { _index = idx, _id = id, status = 400, error = new { type = "document_parsing_exception", reason = "field [bad] rejected" } } });
                continue;
            }
            if (!Indices.TryGetValue(idx, out var index)) Indices[idx] = index = new Index();
            Put(index, id, src);
            items.Add(new Dictionary<string, object> { [op] = new { _index = idx, _id = id, status = 201, result = "created" } });
        }
        return (200, new { took = 1, errors, items });
    }

    private (int, object?) Search(string target, Request req, Dictionary<string, string> q)
    {
        var found = Find(target);
        if (found is null) return (404, IndexNotFound(target));
        var body = req.Body is { Length: > 0 } ? JsonNode.Parse(req.Body)!.AsObject() : new JsonObject();
        if (body["query"] is JsonObject query && query.ContainsKey("bogus")) return (400, Error(400, "parsing_exception", "unknown query [bogus]", "parsing_exception", "[bogus] query malformed, no start_object after query name"));
        var size = body["size"]?.GetValue<int>() ?? 10;
        var from = body["from"]?.GetValue<int>() ?? 0;
        var all = found.SelectMany(kv => kv.Value.Docs.Select(d => (Index: kv.Key, d.Key, d.Value))).OrderBy(x => x.Key, StringComparer.Ordinal).ToList();
        string? scrollId = null;
        if (q.ContainsKey("scroll"))
        {
            scrollId = $"scroll-{_nextScroll++}";
            _scrolls[scrollId] = (target, size, size);
        }
        return (200, Page(all, from, size, scrollId, body["seq_no_primary_term"]?.GetValue<bool>() == true, body["aggs"] is not null));
    }

    private static object Page(List<(string Index, string Key, Doc Value)> all, int from, int size, string? scrollId, bool seq, bool aggs)
    {
        var hits = all.Skip(from).Take(size).Select(x => new Dictionary<string, object?>
        {
            ["_index"] = x.Index, ["_id"] = x.Key, ["_score"] = 1.0, ["_source"] = x.Value.Source,
            ["_seq_no"] = seq ? x.Value.SeqNo : null, ["_primary_term"] = seq ? 1 : null,
        }.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value)).ToList();
        var result = new Dictionary<string, object?>
        {
            ["took"] = 2, ["timed_out"] = false, ["_shards"] = new { total = 1, successful = 1, skipped = 0, failed = 0 },
            ["hits"] = new { total = new { value = all.Count, relation = "eq" }, max_score = 1.0, hits },
        };
        if (scrollId is not null) result["_scroll_id"] = scrollId;
        if (aggs) result["aggregations"] = new { by_status = new { buckets = new[] { new { key = "paid", doc_count = 2 } } } };
        return result;
    }

    private (int, object?) Scroll(Request req)
    {
        var id = JsonNode.Parse(req.Body!)!["scroll_id"]!.GetValue<string>();
        if (!_scrolls.TryGetValue(id, out var s)) return (404, Error(404, "search_context_missing_exception", "No search context found"));
        var found = Find(s.Index)!;
        var all = found.SelectMany(kv => kv.Value.Docs.Select(d => (Index: kv.Key, d.Key, d.Value))).OrderBy(x => x.Key, StringComparer.Ordinal).ToList();
        _scrolls[id] = (s.Index, s.Offset + s.Size, s.Size);
        return (200, Page(all, s.Offset, s.Size, id, false, false));
    }

    private (int, object?) Aliases(Request req)
    {
        foreach (var a in JsonNode.Parse(req.Body!)!["actions"]!.AsArray())
        {
            if (a!["add"] is JsonObject add && Indices.TryGetValue(add["index"]!.GetValue<string>(), out var ai)) ai.Aliases.Add(add["alias"]!.GetValue<string>());
            if (a["remove"] is JsonObject rem && Indices.TryGetValue(rem["index"]!.GetValue<string>(), out var ri)) ri.Aliases.Remove(rem["alias"]!.GetValue<string>());
        }
        return (200, new { acknowledged = true });
    }

    private (int, object?) Reindex(Request req)
    {
        var body = JsonNode.Parse(req.Body!)!;
        var src = body["source"]!["index"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        var dest = body["dest"]!["index"]!.GetValue<string>();
        if (!Indices.TryGetValue(dest, out var d)) Indices[dest] = d = new Index();
        var n = 0;
        foreach (var s in src)
        {
            if (!Indices.TryGetValue(s, out var si)) return (404, IndexNotFound(s));
            foreach (var (id, doc) in si.Docs.ToList()) { Put(d, id, (JsonObject)doc.Source.DeepClone()); n++; }
        }
        var taskId = $"node1:{_nextTask++}";
        _tasks[taskId] = new JsonObject
        {
            ["node"] = "node1", ["id"] = _nextTask - 1, ["type"] = "transport", ["action"] = "indices:data/write/reindex", ["description"] = $"reindex from {string.Join(',', src)} to {dest}",
            ["start_time_in_millis"] = 1735689600000, ["running_time_in_nanos"] = 5_000_000, ["cancellable"] = true, ["cancelled"] = false,
            ["status"] = new JsonObject { ["total"] = n, ["created"] = n, ["updated"] = 0, ["deleted"] = 0, ["version_conflicts"] = 0, ["batches"] = 1, ["took"] = 12, ["failures"] = new JsonArray() },
        };
        return (200, new { task = taskId });
    }
}
