// Cluster overview (docs/PLAN-M2.md 7.2): tiles, broker grid with the controller, "Broker configs" drawer.
import { Crown, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { KafkaConfigEntry } from '../../api/types';
import { getConnection } from '../../store/connections';
import { openGroups, openTopics } from './open';
import { Banner, RefreshButton, Tile, ViewHeader } from './parts';
import { formatCount } from './format';
import { isReadOnly, loadCluster, loadGroups, loadTopics, useKafka } from './store';

function retentionText(configs: KafkaConfigEntry[] | null): string {
  if (!configs) return '…';
  const get = (n: string) => configs.find((c) => c.name === n)?.value ?? null;
  const ms = get('log.retention.ms');
  const hours = get('log.retention.hours');
  if (ms && ms !== '-1') return `${Math.round(Number(ms) / 3_600_000)} h`;
  if (ms === '-1') return 'forever';
  return hours ? `${hours} h` : '—';
}

export function OverviewView({ cid }: { cid: string }) {
  const conn = useKafka((s) => s.conns[cid]);
  const cluster = conn?.cluster;
  const [drawer, setDrawer] = useState<number | null>(null);
  const [ctlConfigs, setCtlConfigs] = useState<KafkaConfigEntry[] | null>(null);

  useEffect(() => {
    void loadCluster(cid);
    void loadTopics(cid);
    void loadGroups(cid);
  }, [cid]);

  const controllerId = cluster?.data?.controller?.id ?? cluster?.data?.brokers[0]?.id;
  useEffect(() => {
    if (controllerId === undefined) return;
    api.kafka.brokerConfigs(cid, controllerId).then(setCtlConfigs, () => setCtlConfigs([]));
  }, [cid, controllerId]);

  const c = cluster?.data;
  const refresh = () => {
    void loadCluster(cid, true);
    void loadTopics(cid, true);
    void loadGroups(cid, true);
  };
  return (
    <div className="kafka-view" data-testid="kafka-overview">
      <ViewHeader title="Cluster overview" subtitle={getConnection(cid)?.name} readOnly={isReadOnly(cid)}>
        <button type="button" className="btn btn-xs" onClick={() => openTopics(cid)}>Topics</button>
        <button type="button" className="btn btn-xs" onClick={() => openGroups(cid)}>Consumer groups</button>
        <RefreshButton onClick={refresh} busy={cluster?.loading} />
      </ViewHeader>
      {cluster?.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={refresh}>Retry</button>}>{cluster.error}</Banner>}
      {!c && !cluster?.error && <div className="kafka-empty">Loading cluster…</div>}
      {c && (
        <div className="kafka-scroll">
          <div className="kafka-tiles" role="list" aria-label="Cluster summary">
            <Tile label="Brokers" value={c.brokers.length} />
            <Tile label="Controller" value={c.controller ? `#${c.controller.id}` : '—'} />
            <Tile label="Topics" value={formatCount(c.topicCount)} />
            <Tile label="Partitions" value={formatCount(c.partitionCount)} />
            <Tile label="Under-replicated" value={c.underReplicated} tone={c.underReplicated ? 'warn' : 'ok'} />
            <Tile label="Offline partitions" value={c.offlinePartitions} tone={c.offlinePartitions ? 'danger' : 'ok'} />
            <Tile label="Consumer groups" value={conn?.groups.data ? conn.groups.data.length : '…'} />
            <Tile label="Log retention" value={retentionText(ctlConfigs)} />
            <Tile label="Version" value={c.version ? `Kafka ${c.version}` : '—'} />
          </div>
          {c.clusterId && <div className="kafka-meta">Cluster id <code className="mono">{c.clusterId}</code></div>}
          <h3 className="kafka-section-title">Brokers</h3>
          <div className="kafka-table-wrap">
            <table className="kafka-table" aria-label="Brokers">
              <thead><tr><th className="num">Id</th><th>Host</th><th className="num">Port</th><th>Rack</th><th>Role</th><th /></tr></thead>
              <tbody>
                {c.brokers.map((b) => (
                  <tr key={b.id}>
                    <td className="num">{b.id}</td>
                    <td className="mono">{b.host}</td>
                    <td className="num">{b.port}</td>
                    <td>{b.rack ?? <span className="muted">—</span>}</td>
                    <td>{b.isController ? <span className="pill"><Crown size={12} aria-hidden /> controller</span> : <span className="muted">broker</span>}</td>
                    <td className="kafka-cell-actions">
                      <button type="button" className="btn btn-xs" disabled={!b.configsAvailable} onClick={() => setDrawer(b.id)}>Broker configs</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {drawer !== null && <BrokerConfigsDrawer cid={cid} brokerId={drawer} onClose={() => setDrawer(null)} />}
    </div>
  );
}

function BrokerConfigsDrawer({ cid, brokerId, onClose }: { cid: string; brokerId: number; onClose(): void }) {
  const [configs, setConfigs] = useState<KafkaConfigEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  useEffect(() => {
    setConfigs(null);
    api.kafka.brokerConfigs(cid, brokerId).then(setConfigs, (e) => setError(errorMessage(e)));
  }, [cid, brokerId]);
  const rows = useMemo(() => (configs ?? []).filter((c) => (!onlyChanged || !c.isDefault) && c.name.includes(filter.trim().toLowerCase())), [configs, filter, onlyChanged]);
  return (
    <aside className="kafka-drawer" aria-label={`Broker ${brokerId} configs`} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="kafka-drawer-head">
        <strong>Broker {brokerId} configs</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close broker configs"><X size={16} /></button>
      </div>
      <div className="kafka-toolbar">
        <input className="input" placeholder="Filter configs" aria-label="Filter configs" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Non-default only</label>
      </div>
      {error && <Banner>{error}</Banner>}
      {!configs && !error && <div className="kafka-empty">Loading…</div>}
      {configs && <ConfigTable rows={rows} />}
    </aside>
  );
}

export function ConfigTable({ rows }: { rows: KafkaConfigEntry[] }) {
  return (
    <div className="kafka-table-wrap">
      <table className="kafka-table" aria-label="Configs">
        <thead><tr><th>Name</th><th>Value</th><th>Source</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.name} className={c.isDefault ? undefined : 'kafka-changed'}>
              <td className="mono">{c.name}</td>
              <td className="mono kafka-config-value">{c.isSensitive ? <span className="muted">•••••• (sensitive)</span> : c.value ?? <span className="muted">null</span>}</td>
              <td className="muted">{c.source.replace(/_/g, ' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
