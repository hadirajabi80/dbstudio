// Cluster overview (plan-batch3 WP-ES): health banner and tiles (nodes, indices, documents, store, shards, JVM heap,
// disk), the nodes table and the largest indices; quick links to Dev Tools, SQL, Tasks and index creation.
import { Crown, FileSpreadsheet, Plus, SquareTerminal } from 'lucide-react';
import { useEffect } from 'react';
import { formatBytes, formatCount, percent } from '../../es/format';
import { getConnection } from '../../store/connections';
import { openConsole, openIndex, openIndices, openSql, openTasks } from './open';
import { Banner, FlavorBadge, HealthDot, Meter, RefreshButton, Tile, ViewHeader } from './parts';
import { isReadOnly, loadCluster, loadIndices, loadNodes, useEs } from './store';
import { runCommand } from '../../commands/registry';

export function OverviewView({ cid }: { cid: string }) {
  const conn = useEs((s) => s.conns[cid]);
  const cluster = conn?.cluster;
  const nodes = conn?.nodes;
  const indices = conn?.indices;

  useEffect(() => {
    void loadCluster(cid);
    void loadNodes(cid);
    void loadIndices(cid);
  }, [cid]);

  const refresh = () => {
    void loadCluster(cid, true);
    void loadNodes(cid, true);
    void loadIndices(cid, true);
  };
  const c = cluster?.data;
  const heap = percent(c?.jvmHeapUsedBytes, c?.jvmHeapMaxBytes);
  const disk = c?.fsTotalBytes != null && c.fsAvailableBytes != null ? percent(c.fsTotalBytes - c.fsAvailableBytes, c.fsTotalBytes) : null;
  const largest = [...(indices?.data ?? [])].filter((i) => !i.hidden).sort((a, b) => (b.storeBytes ?? 0) - (a.storeBytes ?? 0)).slice(0, 6);
  const maxStore = largest[0]?.storeBytes ?? 0;
  const ro = isReadOnly(cid);

  return (
    <div className="es-view" data-testid="es-overview">
      <ViewHeader title="Cluster overview" subtitle={getConnection(cid)?.name} readOnly={ro} badge={c ? <FlavorBadge flavor={c.flavor} version={c.version} /> : undefined}>
        <button type="button" className="btn btn-xs" onClick={() => openConsole(cid)}><SquareTerminal size={13} aria-hidden /> Dev Tools</button>
        <button type="button" className="btn btn-xs" onClick={() => openSql(cid)}><FileSpreadsheet size={13} aria-hidden /> SQL</button>
        <button type="button" className="btn btn-xs" onClick={() => openTasks(cid)}>Tasks</button>
        {!ro && <button type="button" className="btn btn-xs" onClick={() => runCommand('es.createIndex', { kind: 'connection', connectionId: cid })}><Plus size={13} aria-hidden /> Create index</button>}
        <RefreshButton onClick={refresh} busy={cluster?.loading} />
      </ViewHeader>
      {cluster?.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={refresh}>Retry</button>}>{cluster.error}</Banner>}
      {!c && !cluster?.error && <div className="es-empty">Loading cluster…</div>}
      {c && (
        <div className="es-scroll">
          <div className={`es-health-banner es-health-banner-${c.status}`} role="status">
            <HealthDot health={c.status} />
            <div>
              <div className="es-health-title"><strong>{c.clusterName}</strong> is <strong>{c.status}</strong></div>
              <div className="es-health-sub">
                {c.status === 'green' && 'All primary and replica shards are assigned.'}
                {c.status === 'yellow' && `All primaries are assigned; ${c.unassignedShards} replica shard${c.unassignedShards === 1 ? ' is' : 's are'} unassigned.`}
                {c.status === 'red' && `${c.unassignedShards} shard${c.unassignedShards === 1 ? ' is' : 's are'} unassigned, including primaries: some data is not searchable.`}
                {c.clusterUuid && <> · uuid <code className="mono">{c.clusterUuid}</code></>}
                {c.luceneVersion && <> · Lucene {c.luceneVersion}</>}
              </div>
            </div>
          </div>
          <div className="es-tiles" role="list" aria-label="Cluster summary">
            <Tile label="Nodes" value={c.nodes} sub={`${c.dataNodes} data`} />
            <Tile label="Indices" value={formatCount(c.indices)} />
            <Tile label="Documents" value={formatCount(c.docs)} />
            <Tile label="Store size" value={formatBytes(c.storeBytes)} />
            <Tile label="Primary shards" value={c.activePrimaryShards} sub={`${c.activeShards} active total`} />
            <Tile label="Unassigned shards" value={c.unassignedShards} tone={c.unassignedShards ? (c.status === 'red' ? 'danger' : 'warn') : 'ok'}
              sub={c.initializingShards || c.relocatingShards ? `${c.initializingShards} initializing · ${c.relocatingShards} relocating` : undefined} />
            <Tile label="JVM heap" value={heap == null ? '—' : `${Math.round(heap)}%`} tone={heap != null && heap > 85 ? 'warn' : undefined}
              sub={c.jvmHeapUsedBytes != null ? `${formatBytes(c.jvmHeapUsedBytes)} of ${formatBytes(c.jvmHeapMaxBytes)}` : undefined} />
            <Tile label="Disk used" value={disk == null ? '—' : `${Math.round(disk)}%`} tone={disk != null && disk > 85 ? 'warn' : undefined}
              sub={c.fsTotalBytes != null ? `${formatBytes(c.fsAvailableBytes)} free` : undefined} />
            <Tile label="Pending tasks" value={c.pendingTasks} />
          </div>

          <h3 className="es-section-title">Nodes</h3>
          {nodes?.error && <Banner tone="warn">{nodes.error}</Banner>}
          <div className="es-table-wrap">
            <table className="es-table" aria-label="Nodes">
              <thead><tr><th>Name</th><th>Address</th><th>Roles</th><th>Version</th><th className="num">Heap</th><th className="num">RAM</th><th className="num">CPU</th><th className="num">Load 1m</th><th className="num">Disk</th><th>Uptime</th></tr></thead>
              <tbody>
                {(nodes?.data ?? []).map((n) => (
                  <tr key={n.id}>
                    <td>
                      <span className="es-node-name">
                        {n.master && <Crown size={12} aria-label="Elected master" className="es-crown" />}
                        {n.name}
                      </span>
                    </td>
                    <td className="mono">{n.ip ?? '—'}</td>
                    <td><span className="es-roles">{n.roles.map((r) => <span key={r} className={`es-chip es-role-${r.replace(/_/g, '-')}`}>{r}</span>)}</span></td>
                    <td className="mono">{n.version ?? '—'}</td>
                    <td className="num"><Meter value={n.heapPercent} /></td>
                    <td className="num"><Meter value={n.ramPercent} /></td>
                    <td className="num">{n.cpu != null ? `${n.cpu}%` : '—'}</td>
                    <td className="num">{n.load1m ?? '—'}</td>
                    <td className="num"><Meter value={n.diskUsedPercent} label={n.diskTotalBytes ? `${formatBytes(n.diskUsedBytes)} of ${formatBytes(n.diskTotalBytes)}` : undefined} /></td>
                    <td className="muted">{n.uptime ?? '—'}</td>
                  </tr>
                ))}
                {!nodes?.data && !nodes?.error && <tr><td colSpan={10} className="muted">Loading nodes…</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="es-section-head">
            <h3 className="es-section-title">Largest indices</h3>
            <button type="button" className="link-btn" onClick={() => openIndices(cid)}>All indices</button>
          </div>
          <div className="es-bars" role="list" aria-label="Largest indices">
            {largest.map((i) => (
              <div key={i.name} role="listitem"><button type="button" className="es-bar-row" onClick={() => openIndex(cid, i.name)} title={`Open ${i.name}`} aria-label={`Open ${i.name}`}>
                <span className="es-bar-label"><HealthDot health={i.health} /> <span className="mono">{i.name}</span></span>
                <span className="es-bar-track"><span className="es-bar-fill" style={{ width: `${maxStore ? Math.max(2, ((i.storeBytes ?? 0) / maxStore) * 100) : 0}%` }} /></span>
                <span className="es-bar-value">{formatBytes(i.storeBytes)} · {formatCount(i.docsCount)} docs</span>
              </button></div>
            ))}
            {indices?.data && largest.length === 0 && <div className="es-empty">No indices yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
