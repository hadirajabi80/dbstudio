using System.Net;
using System.Text.Json.Nodes;
using Cassandra;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Providers.Cassandra.Endpoints;

public sealed record CqlNode(string Address, string? DataCenter, string? Rack, string? ReleaseVersion, string? HostId, bool IsUp, bool IsLocal,
    int Tokens, string? SchemaVersion);

public sealed record CqlDataCenter(string Name, int Nodes, int Up, IReadOnlyList<string> Racks);

public sealed record CqlClusterInfo(string? ClusterName, string? Partitioner, string? CqlVersion, string? ReleaseVersion, int? ProtocolVersion,
    string Product, IReadOnlyList<CqlDataCenter> DataCenters, IReadOnlyList<CqlNode> Nodes, bool SchemaInAgreement);

public sealed record CqlClientConnection(string Address, int? Port, string? Hostname, string? Username, string? ConnectionStage, int? ProtocolVersion,
    string? DriverName, string? DriverVersion, long? RequestCount, bool? SslEnabled, string? Keyspace);

public sealed record CqlColumnDef(string Name, string Type, string Kind, int Position, string? Order);

public sealed record CqlIndexDef(string Name, string Kind, string? Target, string? ClassName);

public sealed record CqlClusteringDef(string Name, string Order);

public sealed record CqlTableInfo(string Keyspace, string Name, string Type, string? BaseTable, string? WhereClause, IReadOnlyList<CqlColumnDef> Columns,
    IReadOnlyList<string> PartitionKey, IReadOnlyList<CqlClusteringDef> Clustering, string PrimaryKey, IReadOnlyDictionary<string, string> Options,
    bool IsCounter, IReadOnlyList<CqlIndexDef> Indexes, IReadOnlyList<string> Views, long? EstimatedPartitions, long? MeanPartitionSizeBytes, string Ddl);

/// <summary>
/// Cassandra module endpoints (plan-batch3 WP-CS) under <c>/api/v1/cassandra</c>: console settings and traces of a tab
/// session, request traces, the cluster (nodes, datacenters), connected clients and the key/storage info of a table.
/// Types mirror ui/src/api/types.cassandra.ts.
/// </summary>
public static class CassandraEndpoints
{
    public static RouteGroupBuilder MapCassandra(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/cassandra");

        g.MapGet("/sessions/{sid}/settings", (string sid, SessionManager sessions) => Session(sessions, sid).SettingsInfo());

        g.MapPut("/sessions/{sid}/settings", (string sid, JsonObject? body, SessionManager sessions) =>
        {
            var s = Session(sessions, sid);
            if (body is null) return s.SettingsInfo();
            try
            {
                if (body["consistency"] is JsonValue c)
                    s.Settings.Consistency = CqlConnectionSettings.TryParseConsistency(c.ToString(), out var level)
                        ? level : throw EngineException.Validation($"Unknown consistency level '{c}'.", new { field = "consistency" });
                if (body["serialConsistency"] is JsonValue sc)
                    s.Settings.SerialConsistency = CqlConnectionSettings.TryParseConsistency(sc.ToString(), out var serial)
                        ? serial : throw EngineException.Validation($"Unknown serial consistency '{sc}'.", new { field = "serialConsistency" });
                if (body["tracing"] is JsonValue t) s.Settings.Tracing = t.GetValue<bool>();
                if (body["pageSize"] is JsonValue p) s.Settings.PageSize = p.GetValue<int>();
                if (body.ContainsKey("insertTtl")) s.Settings.InsertTtl = body["insertTtl"] is JsonValue ttl ? ttl.GetValue<int>() : null;
            }
            catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidOperationException)
            {
                throw EngineException.Validation(ex.Message);
            }
            sessions.PublishChanged(sessions.Get(sid));
            return s.SettingsInfo();
        });

        g.MapGet("/sessions/{sid}/traces", (string sid, SessionManager sessions) => Session(sessions, sid).Traces());

        g.MapGet("/{cid}/traces/{traceId}", async (string cid, string traceId, ConnectionStore connections, CassandraProvider provider, CancellationToken ct) =>
        {
            if (!Guid.TryParse(traceId, out var id)) throw EngineException.Validation("traceId must be a uuid.", new { field = "traceId" });
            await using var catalog = await Catalog(connections, provider, cid, ct);
            return await CqlTracing.ReadAsync(catalog.Session, id, ct) ?? throw EngineException.NotFound($"Trace {traceId}");
        });

        g.MapGet("/{cid}/cluster", async (string cid, ConnectionStore connections, CassandraProvider provider, CancellationToken ct) =>
        {
            await using var catalog = await Catalog(connections, provider, cid, ct);
            return await ClusterAsync(catalog, ct);
        });

        g.MapGet("/{cid}/clients", async (string cid, ConnectionStore connections, CassandraProvider provider, CancellationToken ct) =>
        {
            await using var catalog = await Catalog(connections, provider, cid, ct);
            RowSet rs;
            try
            {
                rs = await catalog.Session.ExecuteAsync(new SimpleStatement("SELECT * FROM system_views.clients").SetPageSize(1000)).WaitAsync(ct);
            }
            catch (InvalidQueryException)
            {
                throw new EngineException(400, ErrorCodes.NotSupported, "Connected clients are listed by system_views.clients, which needs Cassandra 4.0 or later.");
            }
            return rs.ToList().Select(r => new CqlClientConnection(
                CqlSchemaReader.Str(r, "address") ?? "", CqlSchemaReader.Int(r, "port"), CqlSchemaReader.Str(r, "hostname"), CqlSchemaReader.Str(r, "username"),
                CqlSchemaReader.Str(r, "connection_stage"), CqlSchemaReader.Int(r, "protocol_version"), CqlSchemaReader.Str(r, "driver_name"),
                CqlSchemaReader.Str(r, "driver_version"), CqlSchemaReader.Long(r, "request_count"), CqlSchemaReader.Bool(r, "ssl_enabled"),
                CqlSchemaReader.Str(r, "keyspace_name"))).ToList();
        });

        g.MapGet("/{cid}/keyspaces/{ks}/tables/{name}", async (string cid, string ks, string name, ConnectionStore connections, CassandraProvider provider, CancellationToken ct) =>
        {
            await using var catalog = await Catalog(connections, provider, cid, ct);
            var meta = await catalog.RequireKeyspaceAsync(ks, ct);
            var t = meta.Table(name) ?? throw EngineException.NotFound($"Table '{ks}.{name}'");
            long? partitions = null, mean = null;
            try
            {
                var sizes = await catalog.Schema.SizeEstimatesAsync(meta.Name).WaitAsync(ct);
                if (sizes.TryGetValue(t.Name, out var s)) { partitions = s.Partitions; mean = s.MeanSize; }
            }
            catch (DriverException) { /* optional */ }
            return new CqlTableInfo(meta.Name, t.Name, t.IsView ? ObjectTypes.MView : ObjectTypes.Table, t.BaseTable, t.WhereClause,
                t.OrderedColumns.Select(c => new CqlColumnDef(c.Name, c.Type, c.Kind, c.Position, c.IsClustering ? (c.Desc ? "desc" : "asc") : null)).ToList(),
                t.PartitionKey.Select(c => c.Name).ToList(),
                t.Clustering.Select(c => new CqlClusteringDef(c.Name, c.Desc ? "desc" : "asc")).ToList(),
                CqlDdl.PrimaryKeyText(t),
                t.Options.ToDictionary(o => o.Key, o => o.Value, StringComparer.Ordinal),
                t.IsCounter,
                meta.Indexes.Where(i => i.Table == t.Name).Select(i => new CqlIndexDef(i.Name, i.Kind, i.Target, i.ClassName)).ToList(),
                meta.Views.Where(v => v.BaseTable == t.Name).Select(v => v.Name).ToList(),
                partitions, mean,
                CqlDdl.TableWithDependents(meta, t));
        });

        return api;
    }

    private static CqlSession Session(SessionManager sessions, string sid) =>
        sessions.Get(sid).Session as CqlSession
        ?? throw EngineException.Validation($"Session '{sid}' is not a Cassandra session.", new { field = "sessionId" });

    private static async Task<CqlCatalogReader> Catalog(ConnectionStore connections, CassandraProvider provider, string cid, CancellationToken ct)
    {
        var profile = connections.Get(cid);
        if (!string.Equals(profile.ProviderId, CassandraProvider.ProviderId, StringComparison.OrdinalIgnoreCase))
            throw EngineException.Validation($"Connection '{profile.Name}' is not a Cassandra connection.", new { field = "connectionId" });
        return await provider.OpenCqlCatalogAsync(profile, connections.GetPassword(cid), ct).ConfigureAwait(false);
    }

    /// <summary>Nodes from system.local + system.peers_v2 (peers before 4.0), with the driver's up/down view.</summary>
    public static async Task<CqlClusterInfo> ClusterAsync(CqlCatalogReader catalog, CancellationToken ct)
    {
        var session = catalog.Session;
        var local = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system.local").SetConsistencyLevel(ConsistencyLevel.One)).WaitAsync(ct).ConfigureAwait(false)).FirstOrDefault();
        List<Row> peers;
        try
        {
            peers = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system.peers_v2")).WaitAsync(ct).ConfigureAwait(false)).ToList();
        }
        catch (InvalidQueryException)
        {
            peers = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system.peers")).WaitAsync(ct).ConfigureAwait(false)).ToList();
        }
        var hosts = catalog.Cluster.AllHosts().ToList();
        bool Up(string? address, string? hostId) =>
            hosts.Any(h => (hostId is not null && h.HostId.ToString() == hostId) || (address is not null && h.Address.Address.ToString() == address))
                ? hosts.First(h => (hostId is not null && h.HostId.ToString() == hostId) || (address is not null && h.Address.Address.ToString() == address)).IsUp
                : false;

        var nodes = new List<CqlNode>();
        if (local is not null)
        {
            var address = CqlSchemaReader.Str(local, "broadcast_address") ?? CqlSchemaReader.Str(local, "listen_address") ?? CqlSchemaReader.Str(local, "rpc_address") ?? "";
            var hostId = CqlSchemaReader.Str(local, "host_id");
            nodes.Add(new CqlNode(address, CqlSchemaReader.Str(local, "data_center"), CqlSchemaReader.Str(local, "rack"), CqlSchemaReader.Str(local, "release_version"),
                hostId, Up(address, hostId) || hosts.Count == 0, true, CqlSchemaReader.List(local, "tokens").Count, CqlSchemaReader.Str(local, "schema_version")));
        }
        foreach (var p in peers)
        {
            var address = CqlSchemaReader.Str(p, "peer") ?? CqlSchemaReader.Str(p, "native_address") ?? "";
            var hostId = CqlSchemaReader.Str(p, "host_id");
            nodes.Add(new CqlNode(address, CqlSchemaReader.Str(p, "data_center"), CqlSchemaReader.Str(p, "rack"), CqlSchemaReader.Str(p, "release_version"),
                hostId, Up(address, hostId), false, CqlSchemaReader.List(p, "tokens").Count, CqlSchemaReader.Str(p, "schema_version")));
        }
        var dcs = nodes.GroupBy(n => n.DataCenter ?? "").OrderBy(g => g.Key, StringComparer.Ordinal)
            .Select(g => new CqlDataCenter(g.Key, g.Count(), g.Count(n => n.IsUp), g.Select(n => n.Rack ?? "").Distinct().OrderBy(r => r, StringComparer.Ordinal).ToList())).ToList();
        var info = await CassandraProvider.ReadServerInfoAsync(session, catalog.Settings, null, ct).ConfigureAwait(false);
        return new CqlClusterInfo(
            local is null ? catalog.Cluster.Metadata.ClusterName : CqlSchemaReader.Str(local, "cluster_name"),
            local is null ? null : CqlSchemaReader.Str(local, "partitioner"),
            local is null ? null : CqlSchemaReader.Str(local, "cql_version"),
            local is null ? null : CqlSchemaReader.Str(local, "release_version"),
            session.BinaryProtocolVersion,
            CassandraProvider.ProductOf(info),
            dcs, nodes,
            nodes.Select(n => n.SchemaVersion).Where(v => v is not null).Distinct().Count() <= 1);
    }
}
