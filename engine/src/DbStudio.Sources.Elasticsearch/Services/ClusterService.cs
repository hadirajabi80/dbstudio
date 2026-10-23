using System.Text.Json;

namespace DbStudio.Sources.Elasticsearch.Services;

/// <summary>Cluster overview (<c>GET /</c> + health + stats) and the node list (<c>_cat/nodes</c>).</summary>
public sealed class ClusterService
{
    public async Task<EsCluster> ClusterAsync(EsClient c, CancellationToken ct)
    {
        var t = c.Transport;
        var rootTask = t.GetAsync("", ct);
        var healthTask = t.GetAsync("_cluster/health", ct);
        var statsTask = t.TryGetAsync("_cluster/stats?filter_path=indices.count,indices.docs.count,indices.store.size_in_bytes,nodes.jvm.mem,nodes.fs", ct);
        var root = await rootTask.ConfigureAwait(false);
        var h = await healthTask.ConfigureAwait(false);
        var stats = await statsTask.ConfigureAwait(false);
        var s = stats ?? default;
        long? L(string path) => stats is null ? null : s.Path(path) is { } v ? EsJson.AsLong(v) : null;
        return new EsCluster(
            ClusterName: root.Str("cluster_name") ?? h.Str("cluster_name") ?? "",
            ClusterUuid: root.Str("cluster_uuid"),
            Flavor: c.Flavor,
            Version: root.Path("version.number") is { } v ? EsJson.AsString(v) ?? c.Version : c.Version,
            LuceneVersion: root.Path("version.lucene_version") is { } lv ? EsJson.AsString(lv) : null,
            Status: (h.Str("status") ?? "red").ToLowerInvariant(),
            TimedOut: h.Bool("timed_out") ?? false,
            Nodes: h.Int("number_of_nodes"),
            DataNodes: h.Int("number_of_data_nodes"),
            ActivePrimaryShards: h.Int("active_primary_shards"),
            ActiveShards: h.Int("active_shards"),
            RelocatingShards: h.Int("relocating_shards"),
            InitializingShards: h.Int("initializing_shards"),
            UnassignedShards: h.Int("unassigned_shards"),
            ActiveShardsPercent: h.Double("active_shards_percent_as_number") ?? 0,
            PendingTasks: h.Int("number_of_pending_tasks"),
            Indices: L("indices.count"),
            Docs: L("indices.docs.count"),
            StoreBytes: L("indices.store.size_in_bytes"),
            JvmHeapUsedBytes: L("nodes.jvm.mem.heap_used_in_bytes"),
            JvmHeapMaxBytes: L("nodes.jvm.mem.heap_max_in_bytes"),
            FsTotalBytes: L("nodes.fs.total_in_bytes"),
            FsAvailableBytes: L("nodes.fs.available_in_bytes"));
    }

    private static readonly Dictionary<char, string> RoleLetters = new()
    {
        ['c'] = "data_cold", ['d'] = "data", ['f'] = "data_frozen", ['h'] = "data_hot", ['i'] = "ingest", ['l'] = "ml", ['m'] = "master",
        ['r'] = "remote_cluster_client", ['s'] = "data_content", ['t'] = "transform", ['v'] = "voting_only", ['w'] = "data_warm",
    };

    public async Task<IReadOnlyList<EsNode>> NodesAsync(EsClient c, CancellationToken ct)
    {
        const string cols = "id,name,ip,node.role,master,version,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,disk.used,disk.total,uptime";
        var res = await c.Transport.SendAsync(HttpMethod.Get, $"_cat/nodes?format=json&full_id=true&bytes=b&h={cols}", null, null, ct).ConfigureAwait(false);
        JsonElement rows;
        if (res.Ok) rows = res.Json();
        else
        {
            // OpenSearch 2 renamed "master" to "cluster_manager"; fall back to the default columns.
            rows = await c.Transport.GetAsync("_cat/nodes?format=json&full_id=true&bytes=b", ct).ConfigureAwait(false);
        }
        return rows.Items().Select(MapNode).OrderByDescending(n => n.Master).ThenBy(n => n.Name, StringComparer.Ordinal).ToList();
    }

    internal static EsNode MapNode(JsonElement n)
    {
        var letters = n.Str("node.role") ?? n.Str("node.roles") ?? "";
        var roles = letters.Contains(',', StringComparison.Ordinal)
            ? letters.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).ToList()
            : letters.Where(ch => ch != '-').Select(ch => RoleLetters.GetValueOrDefault(ch, ch.ToString())).ToList();
        var master = (n.Str("master") ?? n.Str("cluster_manager") ?? n.Str("m")) == "*";
        return new EsNode(
            Id: n.Str("id") ?? n.Str("name") ?? "",
            Name: n.Str("name") ?? "",
            Ip: n.Str("ip"),
            Roles: roles,
            Master: master,
            Version: n.Str("version"),
            HeapPercent: n.Double("heap.percent"),
            RamPercent: n.Double("ram.percent"),
            Cpu: n.Double("cpu"),
            Load1m: n.Double("load_1m"),
            DiskUsedPercent: n.Double("disk.used_percent"),
            DiskUsedBytes: n.Long("disk.used"),
            DiskTotalBytes: n.Long("disk.total"),
            Uptime: n.Str("uptime"));
    }
}
