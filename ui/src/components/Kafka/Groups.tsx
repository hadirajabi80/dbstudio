// Consumer groups (docs/PLAN-M2.md 7.5): grid with lag heat colouring (thresholds configurable), group tab with member
// and partition grids, refresh / auto-refresh, Reset offsets… and Delete group….
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { KafkaGroupDetail } from '../../api/types';
import { runCommand } from '../../commands/registry';
import type { SourceTarget } from '../../commands/types';
import { getConnection } from '../../store/connections';
import { formatCount, lagClass } from './format';
import { openGroup, openTopic } from './open';
import { Banner, Empty, RefreshButton, Tile, ViewHeader } from './parts';
import { isReadOnly, loadGroups, useKafka } from './store';

const THRESHOLD_KEY = 'dbstudio.kafka.lagThresholds';

/** Lag heat thresholds (per viewer, browser storage; defaults 1,000 / 10,000). */
export function useLagThresholds(): [{ warn: number; danger: number }, (t: { warn: number; danger: number }) => void] {
  const [t, setT] = useState(() => {
    try {
      const raw = localStorage.getItem(THRESHOLD_KEY);
      const p = raw ? (JSON.parse(raw) as { warn?: number; danger?: number }) : {};
      return { warn: Number(p.warn) || 1000, danger: Number(p.danger) || 10_000 };
    } catch {
      return { warn: 1000, danger: 10_000 };
    }
  });
  const save = (v: { warn: number; danger: number }) => {
    setT(v);
    try {
      localStorage.setItem(THRESHOLD_KEY, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  };
  return [t, save];
}

export const groupTarget = (cid: string, groupId: string): SourceTarget =>
  ({ kind: 'source', connectionId: cid, providerId: 'kafka', nodeType: 'group', path: ['groups', groupId] });

export function GroupsView({ cid }: { cid: string }) {
  const groups = useKafka((s) => s.conns[cid]?.groups);
  const [q, setQ] = useState('');
  const [t, setT] = useLagThresholds();
  useEffect(() => void loadGroups(cid), [cid]);
  const rows = useMemo(() => (groups?.data ?? []).filter((g) => !q.trim() || g.groupId.toLowerCase().includes(q.trim().toLowerCase())), [groups?.data, q]);
  return (
    <div className="kafka-view" data-testid="kafka-groups">
      <ViewHeader title="Consumer groups" subtitle={getConnection(cid)?.name} readOnly={isReadOnly(cid)}>
        <RefreshButton onClick={() => void loadGroups(cid, true)} busy={groups?.loading} />
      </ViewHeader>
      <div className="kafka-toolbar">
        <input className="input kafka-search" type="search" placeholder="Search groups" aria-label="Search groups" value={q} onChange={(e) => setQ(e.target.value)} data-primary-focus />
        <span className="flex-1" />
        <span className="tb-label">Lag warning ≥</span>
        <input className="input kafka-num" aria-label="Lag warning threshold" inputMode="numeric" value={t.warn} onChange={(e) => setT({ ...t, warn: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
        <span className="tb-label">danger ≥</span>
        <input className="input kafka-num" aria-label="Lag danger threshold" inputMode="numeric" value={t.danger} onChange={(e) => setT({ ...t, danger: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
      </div>
      {groups?.error && <Banner>{groups.error}</Banner>}
      {!groups?.data && !groups?.error && <Empty>Loading groups…</Empty>}
      {groups?.data && !rows.length && <Empty>{groups.data.length ? 'No group matches.' : 'No consumer groups.'}</Empty>}
      {rows.length > 0 && (
        <div className="kafka-table-wrap kafka-scroll">
          <table className="kafka-table kafka-clickable" aria-label="Consumer groups">
            <thead><tr><th>Group</th><th>State</th><th className="num">Members</th><th>Topics</th><th className="num">Lag</th><th>Coordinator</th></tr></thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.groupId} tabIndex={0} onDoubleClick={() => openGroup(cid, g.groupId)} onKeyDown={(e) => e.key === 'Enter' && openGroup(cid, g.groupId)}>
                  <td className="mono">{g.groupId}</td>
                  <td><StateBadge state={g.state} /></td>
                  <td className="num">{g.members}</td>
                  <td className="kafka-topics-cell">{g.topics.join(', ') || <span className="muted">—</span>}</td>
                  <td className={`num ${lagClass(g.lagTotal, t.warn, t.danger)}`}>{g.lagTotal === null ? <span className="muted" title="Lag could not be computed within 10 s">—</span> : formatCount(g.lagTotal)}</td>
                  <td className="mono muted">{g.coordinator ? `#${g.coordinator.id} ${g.coordinator.host}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StateBadge({ state }: { state: string }) {
  const tone = state === 'Stable' ? 'kafka-state-stable' : state === 'Empty' ? 'kafka-state-empty' : state === 'Dead' ? 'kafka-state-dead' : 'kafka-state-rebalance';
  return <span className={`pill ${tone}`}>{state}</span>;
}

export function GroupView({ cid, groupId, visible }: { cid: string; groupId: string; visible: boolean }) {
  const [d, setD] = useState<KafkaGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(false);
  const [t] = useLagThresholds();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setD(await api.kafka.group(cid, groupId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [cid, groupId]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!auto || !visible) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [auto, visible, load]);
  useEffect(() => {
    const on = (e: Event) => {
      const x = (e as CustomEvent<{ cid: string; groupId: string }>).detail;
      if (x.cid === cid && x.groupId === groupId) void load();
    };
    window.addEventListener('dbstudio:kafka-group-changed', on);
    return () => window.removeEventListener('dbstudio:kafka-group-changed', on);
  }, [cid, groupId, load]);

  const ro = isReadOnly(cid);
  const lag = d?.partitions.reduce((s, p) => s + (p.lag ?? 0), 0) ?? 0;
  return (
    <div className="kafka-view" data-testid="kafka-group">
      <ViewHeader title={groupId} subtitle="consumer group" readOnly={ro}>
        <button type="button" className="btn btn-xs" onClick={() => runCommand('kafka.resetOffsets', groupTarget(cid, groupId))}>Reset offsets…</button>
        <button type="button" className="btn btn-xs btn-danger" disabled={ro} onClick={() => runCommand('kafka.deleteGroup', groupTarget(cid, groupId))}>Delete group…</button>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh 5 s</label>
        <RefreshButton onClick={() => void load()} busy={loading} />
      </ViewHeader>
      {error && <Banner actions={<button type="button" className="btn btn-xs" onClick={() => void load()}>Retry</button>}>{error}</Banner>}
      {!d && !error && <Empty>Loading group…</Empty>}
      {d && (
        <div className="kafka-scroll">
          <div className="kafka-tiles">
            <Tile label="State" value={<StateBadge state={d.state} />} />
            <Tile label="Members" value={d.members.length} />
            <Tile label="Partitions" value={d.partitions.length} />
            <Tile label="Total lag" value={formatCount(lag)} tone={lag >= t.danger ? 'danger' : lag >= t.warn ? 'warn' : 'ok'} />
            <Tile label="Coordinator" value={d.coordinator ? `#${d.coordinator.id}` : '—'} />
            <Tile label="Assignor" value={d.protocol ?? '—'} />
          </div>
          <h3 className="kafka-section-title">Members</h3>
          {d.members.length === 0 ? <Empty>No active members: offsets can be reset.</Empty> : (
            <div className="kafka-table-wrap">
              <table className="kafka-table" aria-label="Members">
                <thead><tr><th>Member</th><th>Client id</th><th>Host</th><th>Assignment</th></tr></thead>
                <tbody>
                  {d.members.map((m) => (
                    <tr key={m.memberId}>
                      <td className="mono kafka-ellipsis" title={m.memberId}>{m.memberId}</td>
                      <td className="mono">{m.clientId}</td>
                      <td className="mono">{m.host}</td>
                      <td>{m.assignments.map((a) => `${a.topic} [${a.partitions.join(', ')}]`).join('; ') || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="kafka-section-title">Partitions</h3>
          <div className="kafka-table-wrap">
            <table className="kafka-table" aria-label="Group partitions">
              <thead><tr><th>Topic</th><th className="num">Partition</th><th className="num">Committed</th><th className="num">Low</th><th className="num">High</th><th className="num">Lag</th><th>Member</th></tr></thead>
              <tbody>
                {d.partitions.map((p) => (
                  <tr key={`${p.topic}:${p.partition}`}>
                    <td><button type="button" className="link-btn mono" onClick={() => openTopic(cid, p.topic)}>{p.topic}</button></td>
                    <td className="num">{p.partition}</td>
                    <td className="num">{p.committed ?? <span className="muted">—</span>}</td>
                    <td className="num">{p.low}</td>
                    <td className="num">{p.high}</td>
                    <td className={`num ${lagClass(p.lag, t.warn, t.danger)}`}>{p.lag === null ? '—' : formatCount(p.lag)}</td>
                    <td className="mono muted kafka-ellipsis" title={p.memberId ?? undefined}>{p.memberId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
