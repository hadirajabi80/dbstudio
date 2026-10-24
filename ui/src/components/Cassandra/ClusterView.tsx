// "Cluster" (cassandra.cluster): cluster name, product/version, partitioner, schema agreement, datacenters and nodes
// (GET /cassandra/{cid}/cluster), plus the connected clients (GET /cassandra/{cid}/clients, Cassandra 4.0+).
import { CircleCheck, CircleX } from 'lucide-react';
import { api } from '../../api/client';
import type { CqlClientConnection, CqlClusterInfo } from '../../api/types.cassandra';
import { getConnection } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import type { TabViewProps } from '../layout/tabViews';
import { formatCount, shortClass } from './format';
import type { ClusterViewState } from './open';
import { Banner, Dash, Empty, RefreshButton, SubTabs, Tile, ViewHeader } from './parts';
import { useLoad } from './useLoad';

const PRODUCT: Record<string, string> = { cassandra: 'Apache Cassandra', scylla: 'ScyllaDB', dse: 'DataStax Enterprise' };

export function ClusterView({ tab }: TabViewProps) {
  const cid = tab.connectionId;
  const st = (tab.state ?? {}) as ClusterViewState;
  const sub = st.tab ?? 'nodes';
  const cluster = useLoad(cid, () => api.cassandra.cluster(cid!));
  const clients = useLoad(cid && sub === 'clients' ? cid : null, () => api.cassandra.clients(cid!));
  const setSub = (t: 'nodes' | 'clients') => useTabs.getState().updateView(tab.id, { state: { ...st, tab: t } });
  const refresh = () => {
    cluster.reload();
    if (sub === 'clients') clients.reload();
  };
  if (!cid) return <div className="cs-view"><Empty>This cluster tab has no connection.</Empty></div>;
  const c = cluster.data;
  return (
    <div className="cs-view" data-testid="cassandra-cluster">
      <ViewHeader title={c?.clusterName ? `Cluster ${c.clusterName}` : 'Cluster'} subtitle={getConnection(cid)?.name}>
        <RefreshButton onClick={refresh} busy={cluster.loading || clients.loading} />
      </ViewHeader>
      {cluster.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={cluster.reload}>Retry</button>}>{cluster.error}</Banner>}
      {!c && !cluster.error && <Empty>Loading cluster…</Empty>}
      {c && (
        <>
          <Summary c={c} />
          <SubTabs label="Cluster details" value={sub} onChange={setSub} tabs={[{ key: 'nodes', label: `Nodes (${c.nodes.length})` }, { key: 'clients', label: 'Clients' }]} />
          <div className="cs-scroll" role="tabpanel">
            {sub === 'nodes' ? <Nodes c={c} /> : <Clients rows={clients.data} error={clients.error} code={clients.errorCode} retry={clients.reload} />}
          </div>
        </>
      )}
    </div>
  );
}

function Summary({ c }: { c: CqlClusterInfo }) {
  const up = c.nodes.filter((n) => n.isUp).length;
  const product = PRODUCT[c.product] ?? c.product;
  return (
    <div className="cs-tiles" role="list" aria-label="Cluster summary">
      <Tile label="Product" value={c.releaseVersion ? `${product} ${c.releaseVersion}` : product} />
      <Tile label="Nodes up" value={`${up} / ${c.nodes.length}`} tone={up === c.nodes.length ? 'ok' : up === 0 ? 'danger' : 'warn'} />
      <Tile label="Datacenters" value={c.dataCenters.length} />
      <Tile label="Schema" value={c.schemaInAgreement ? 'in agreement' : 'disagreement'} tone={c.schemaInAgreement ? 'ok' : 'warn'}
        title={c.schemaInAgreement ? 'Every reachable node reports the same schema version.' : 'The nodes report different schema versions (a schema change is still propagating, or a node is stuck).'} />
      <Tile label="Partitioner" value={shortClass(c.partitioner) || '—'} title={c.partitioner ?? undefined} />
      <Tile label="CQL" value={c.cqlVersion ?? '—'} />
      <Tile label="Protocol" value={c.protocolVersion !== null ? `v${c.protocolVersion}` : '—'} />
    </div>
  );
}

function UpDown({ up }: { up: boolean }) {
  return up
    ? <span className="cs-up"><CircleCheck size={13} aria-hidden /> up</span>
    : <span className="cs-down"><CircleX size={13} aria-hidden /> down</span>;
}

function Nodes({ c }: { c: CqlClusterInfo }) {
  const versions = new Set(c.nodes.map((n) => n.schemaVersion).filter((v): v is string => !!v));
  return (
    <>
      <h3 className="cs-section-title">Datacenters</h3>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Datacenters">
          <thead><tr><th>Datacenter</th><th className="num">Nodes</th><th className="num">Up</th><th>Racks</th></tr></thead>
          <tbody>
            {c.dataCenters.map((d) => (
              <tr key={d.name}>
                <td className="mono">{d.name || <Dash />}</td>
                <td className="num">{d.nodes}</td>
                <td className={`num${d.up < d.nodes ? ' cs-warn-text' : ''}`}>{d.up}</td>
                <td>{d.racks.join(', ') || <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="cs-section-title">Nodes</h3>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Nodes">
          <thead>
            <tr><th>Address</th><th>Datacenter</th><th>Rack</th><th>Version</th><th>Status</th><th className="num">Tokens</th><th>Host id</th><th>Schema version</th></tr>
          </thead>
          <tbody>
            {c.nodes.map((n) => (
              <tr key={n.address} className={n.isUp ? undefined : 'cs-row-down'}>
                <td className="mono">
                  {n.address}
                  {n.isLocal && <span className="pill cs-inline-pill" title="The node answering this connection's control queries (system.local)">local</span>}
                </td>
                <td>{n.dataCenter ?? <Dash />}</td>
                <td>{n.rack ?? <Dash />}</td>
                <td>{n.releaseVersion ?? <Dash />}</td>
                <td><UpDown up={n.isUp} /></td>
                <td className="num">{n.tokens}</td>
                <td className="mono cs-ellipsis" title={n.hostId ?? undefined}>{n.hostId ?? <Dash />}</td>
                <td className={`mono cs-ellipsis${versions.size > 1 ? ' cs-warn-text' : ''}`} title={n.schemaVersion ?? undefined}>{n.schemaVersion ?? <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Clients({ rows, error, code, retry }: { rows: CqlClientConnection[] | null; error: string | null; code: string | null; retry(): void }) {
  if (error && code === 'NOT_SUPPORTED') return <Banner tone="info">{error}</Banner>;
  if (error) return <Banner actions={<button type="button" className="btn btn-xs" onClick={retry}>Retry</button>}>{error}</Banner>;
  if (!rows) return <Empty>Loading clients…</Empty>;
  if (rows.length === 0) return <Empty>No client connections.</Empty>;
  return (
    <>
      <p className="cs-note">Connections to the node this connection talks to (system_views.clients).</p>
      <div className="cs-table-wrap">
        <table className="cs-table" aria-label="Clients">
          <thead>
            <tr><th>Address</th><th>Host name</th><th>User</th><th>Driver</th><th className="num">Protocol</th><th className="num">Requests</th><th>SSL</th><th>Keyspace</th><th>Stage</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.address}:${r.port ?? ''}`}>
                <td className="mono">{r.port !== null ? `${r.address}:${r.port}` : r.address}</td>
                <td>{r.hostname ?? <Dash />}</td>
                <td>{r.username ?? <Dash />}</td>
                <td className="cs-ellipsis" title={r.driverName ?? undefined}>{r.driverName ? `${r.driverName} ${r.driverVersion ?? ''}`.trim() : <Dash />}</td>
                <td className="num">{r.protocolVersion !== null ? `v${r.protocolVersion}` : <Dash />}</td>
                <td className="num">{formatCount(r.requestCount)}</td>
                <td>{r.sslEnabled === null ? <Dash /> : r.sslEnabled ? 'yes' : 'no'}</td>
                <td className="mono">{r.keyspace ?? <Dash />}</td>
                <td>{r.connectionStage ?? <Dash />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
