// One topic (docs/PLAN-M2.md 7.3): Overview (partition grid with watermarks and ISR health) · Messages · Configs
// (editable; non-default highlighted; sensitive masked) · Consumers (groups consuming this topic, with lag).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { KafkaGroupDetail, KafkaTopicDetail } from '../../api/types';
import { runCommand } from '../../commands/registry';
import type { SourceTarget } from '../../commands/types';
import { toast } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { formatCount, lagClass } from './format';
import { MessageBrowser } from './MessageBrowser';
import { openGroup, openProduce, patchTab, topicTabState, TOPIC_SUBS, type TopicSub } from './open';
import { Banner, Empty, RefreshButton, Tile, ViewHeader } from './parts';
import { isReadOnly, loadGroups, useKafka } from './store';

const SUB_LABEL: Record<TopicSub, string> = { overview: 'Overview', messages: 'Messages', configs: 'Configs', consumers: 'Consumers' };

export function topicTarget(cid: string, topic: string): SourceTarget {
  return { kind: 'source', connectionId: cid, providerId: 'kafka', nodeType: 'topic', path: ['topics', topic] };
}

export function TopicView({ tab, theme, visible }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = topicTabState(tab);
  const [detail, setDetail] = useState<KafkaTopicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await api.kafka.topic(cid, st.topic));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [cid, st.topic]);
  useEffect(() => void load(), [load]);
  // reload after a command changed the topic (configs, partitions, purge)
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ cid: string; topic: string }>).detail;
      if (d.cid === cid && d.topic === st.topic) void load();
    };
    window.addEventListener('dbstudio:kafka-topic-changed', on);
    return () => window.removeEventListener('dbstudio:kafka-topic-changed', on);
  }, [cid, st.topic, load]);

  const ro = isReadOnly(cid);
  const target = topicTarget(cid, st.topic);
  return (
    <div className="kafka-view" data-testid="kafka-topic">
      <ViewHeader title={st.topic} subtitle={detail ? `${detail.partitions.length} partitions` : undefined} readOnly={ro}>
        <button type="button" className="btn btn-xs" disabled={ro} onClick={() => openProduce(cid, st.topic)}>Produce…</button>
        <button type="button" className="btn btn-xs" disabled={ro} onClick={() => runCommand('kafka.addPartitions', target)}>Add partitions…</button>
        <button type="button" className="btn btn-xs" disabled={ro} onClick={() => runCommand('kafka.purgeTopic', target)}>Purge…</button>
        <button type="button" className="btn btn-xs btn-danger" disabled={ro} onClick={() => runCommand('kafka.deleteTopic', target)}>Delete…</button>
        <RefreshButton onClick={() => void load()} busy={loading} />
      </ViewHeader>
      <div className="kafka-subtabs" role="tablist" aria-label="Topic views">
        {TOPIC_SUBS.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={st.sub === s} className={`kafka-subtab${st.sub === s ? ' on' : ''}`} onClick={() => patchTab(tab.id, { sub: s })}>
            {SUB_LABEL[s]}
          </button>
        ))}
      </div>
      {error && <Banner actions={<button type="button" className="btn btn-xs" onClick={() => void load()}>Retry</button>}>{error}</Banner>}
      {st.sub === 'overview' && detail && <PartitionsPane detail={detail} />}
      {st.sub === 'messages' && <MessageBrowser tab={tab} cid={cid} topic={st.topic} partitions={detail?.partitions.length ?? null} theme={theme} visible={visible} />}
      {st.sub === 'configs' && detail && <ConfigsPane cid={cid} detail={detail} readOnly={ro} onSaved={() => void load()} />}
      {st.sub === 'consumers' && <ConsumersPane cid={cid} topic={st.topic} />}
      {!detail && !error && st.sub !== 'messages' && <Empty>Loading topic…</Empty>}
    </div>
  );
}

function PartitionsPane({ detail }: { detail: KafkaTopicDetail }) {
  const ps = detail.partitions;
  const total = ps.reduce((s, p) => s + p.messages, 0);
  const under = ps.filter((p) => p.isr.length < p.replicas.length).length;
  const offline = ps.filter((p) => p.leader === null).length;
  return (
    <div className="kafka-scroll">
      <div className="kafka-tiles">
        <Tile label="Partitions" value={ps.length} />
        <Tile label="Messages" value={formatCount(total)} />
        <Tile label="Replication" value={Math.max(0, ...ps.map((p) => p.replicas.length))} />
        <Tile label="Under-replicated" value={under} tone={under ? 'warn' : 'ok'} />
        <Tile label="Offline" value={offline} tone={offline ? 'danger' : 'ok'} />
      </div>
      <div className="kafka-table-wrap">
        <table className="kafka-table" aria-label="Partitions">
          <thead><tr><th className="num">Partition</th><th className="num">Leader</th><th>Replicas</th><th>ISR</th><th className="num">Low</th><th className="num">High</th><th className="num">Messages</th><th>Health</th></tr></thead>
          <tbody>
            {ps.map((p) => {
              const health = p.leader === null ? ['danger', 'offline'] : p.isr.length < p.replicas.length ? ['warning', 'under-replicated'] : null;
              return (
                <tr key={p.id}>
                  <td className="num">{p.id}</td>
                  <td className="num">{p.leader ?? '—'}</td>
                  <td className="mono">{p.replicas.join(', ')}</td>
                  <td className="mono">{p.isr.join(', ')}</td>
                  <td className="num">{p.lowOffset}</td>
                  <td className="num">{p.highOffset}</td>
                  <td className="num">{formatCount(p.messages)}</td>
                  <td>{health ? <span className={`pill pill-${health[0]}`}>{health[1]}</span> : <span className="kafka-ok">in sync</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfigsPane({ cid, detail, readOnly, onSaved }: { cid: string; detail: KafkaTopicDetail; readOnly: boolean; onSaved(): void }) {
  const [filter, setFilter] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [resets, setResets] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => detail.configs.filter((c) => (!onlyChanged || !c.isDefault || c.name in edits) && c.name.includes(filter.trim().toLowerCase())),
    [detail.configs, filter, onlyChanged, edits]);
  const dirty = Object.keys(edits).length + resets.size;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.kafka.alterTopicConfigs(cid, detail.name, { set: edits, delete: [...resets] });
      toast('success', `Saved ${dirty} config change${dirty === 1 ? '' : 's'} on ${detail.name}`);
      setEdits({});
      setResets(new Set());
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kafka-pane">
      <div className="kafka-toolbar">
        <input className="input kafka-search" type="search" placeholder="Filter configs" aria-label="Filter configs" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Non-default only</label>
        <span className="flex-1" />
        {dirty > 0 && <span className="muted">{dirty} pending</span>}
        <button type="button" className="btn btn-xs" disabled={!dirty || busy} onClick={() => { setEdits({}); setResets(new Set()); }}>Discard</button>
        <button type="button" className="btn btn-xs btn-primary" disabled={!dirty || busy || readOnly} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="kafka-table-wrap kafka-scroll">
        <table className="kafka-table" aria-label="Topic configs">
          <thead><tr><th>Name</th><th>Value</th><th>Source</th><th /></tr></thead>
          <tbody>
            {rows.map((c) => {
              const editing = c.name in edits;
              const reset = resets.has(c.name);
              return (
                <tr key={c.name} className={editing || reset ? 'kafka-pending' : c.isDefault ? undefined : 'kafka-changed'}>
                  <td className="mono">{c.name}</td>
                  <td className="mono kafka-config-value">
                    {c.isSensitive ? <span className="muted">•••••• (sensitive)</span>
                      : editing ? (
                        <input className="input kafka-config-input" aria-label={`Value of ${c.name}`} value={edits[c.name]} autoFocus
                          onChange={(e) => setEdits((x) => ({ ...x, [c.name]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEdits((x) => omit(x, c.name));
                          }} />
                      ) : reset ? <span className="muted">(reset to default)</span> : c.value ?? <span className="muted">null</span>}
                  </td>
                  <td className="muted">{c.source.replace(/_/g, ' ')}</td>
                  <td className="kafka-cell-actions">
                    {!c.isReadOnly && !c.isSensitive && !readOnly && !editing && (
                      <button type="button" className="btn btn-xs" onClick={() => setEdits((x) => ({ ...x, [c.name]: c.value ?? '' }))}>Edit</button>
                    )}
                    {!c.isDefault && !readOnly && !reset && !editing && (
                      <button type="button" className="btn btn-xs" onClick={() => setResets((s) => new Set(s).add(c.name))}>Reset</button>
                    )}
                    {(editing || reset) && (
                      <button type="button" className="btn btn-xs" onClick={() => {
                        setEdits((x) => omit(x, c.name));
                        setResets((s) => {
                          const n = new Set(s);
                          n.delete(c.name);
                          return n;
                        });
                      }}>Undo</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConsumersPane({ cid, topic }: { cid: string; topic: string }) {
  const groups = useKafka((s) => s.conns[cid]?.groups);
  const [details, setDetails] = useState<Record<string, KafkaGroupDetail | string>>({});
  useEffect(() => void loadGroups(cid), [cid]);
  const consuming = useMemo(() => (groups?.data ?? []).filter((g) => g.topics.includes(topic)), [groups?.data, topic]);
  useEffect(() => {
    let alive = true;
    for (const g of consuming.slice(0, 25)) {
      api.kafka.group(cid, g.groupId).then(
        (d) => alive && setDetails((x) => ({ ...x, [g.groupId]: d })),
        (e) => alive && setDetails((x) => ({ ...x, [g.groupId]: errorMessage(e) })),
      );
    }
    return () => {
      alive = false;
    };
  }, [cid, consuming]);
  return (
    <div className="kafka-pane">
      <div className="kafka-toolbar">
        <span className="muted">{consuming.length} group{consuming.length === 1 ? '' : 's'} consuming {topic}</span>
        <span className="flex-1" />
        <RefreshButton onClick={() => { setDetails({}); void loadGroups(cid, true); }} busy={groups?.loading} />
      </div>
      {groups?.error && <Banner>{groups.error}</Banner>}
      {groups?.data && !consuming.length && <Empty>No consumer group has offsets on this topic.</Empty>}
      {consuming.length > 0 && (
        <div className="kafka-table-wrap kafka-scroll">
          <table className="kafka-table kafka-clickable" aria-label="Consumer groups of this topic">
            <thead><tr><th>Group</th><th>State</th><th className="num">Members</th><th className="num">Lag on {topic}</th></tr></thead>
            <tbody>
              {consuming.map((g) => {
                const d = details[g.groupId];
                const lag = typeof d === 'object' ? d.partitions.filter((p) => p.topic === topic).reduce((s, p) => s + (p.lag ?? 0), 0) : null;
                return (
                  <tr key={g.groupId} tabIndex={0} onDoubleClick={() => openGroup(cid, g.groupId)} onKeyDown={(e) => e.key === 'Enter' && openGroup(cid, g.groupId)}>
                    <td className="mono">{g.groupId}</td>
                    <td>{g.state}</td>
                    <td className="num">{g.members}</td>
                    <td className={`num ${lagClass(lag, 1000, 10000)}`}>{typeof d === 'string' ? <span className="muted" title={d}>error</span> : lag === null ? '…' : formatCount(lag)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function omit(o: Record<string, string>, key: string): Record<string, string> {
  const next = { ...o };
  delete next[key];
  return next;
}
