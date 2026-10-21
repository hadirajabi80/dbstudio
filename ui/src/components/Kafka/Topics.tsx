// Topics grid (docs/PLAN-M2.md 7.3): search, filter chips (internal, under-replicated), sort, create.
import { useEffect, useMemo, useState } from 'react';
import { runCommand } from '../../commands/registry';
import { getConnection } from '../../store/connections';
import { formatCount } from './format';
import { openTopic } from './open';
import { Banner, Empty, RefreshButton, ViewHeader } from './parts';
import { isReadOnly, loadTopics, setShowInternal, useKafka } from './store';

type SortKey = 'name' | 'partitions' | 'messages';

export function TopicsView({ cid }: { cid: string }) {
  const conn = useKafka((s) => s.conns[cid]);
  const topics = conn?.topics;
  const [q, setQ] = useState('');
  const [underOnly, setUnderOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  useEffect(() => void loadTopics(cid), [cid]);

  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    const list = (topics?.data ?? []).filter((t) => (!f || t.name.toLowerCase().includes(f)) && (!underOnly || t.underReplicated > 0));
    const val = (t: (typeof list)[number]) => (sort.key === 'name' ? t.name : sort.key === 'partitions' ? t.partitions : t.messages ?? -1);
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [topics?.data, q, underOnly, sort]);

  const th = (key: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : undefined} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="kafka-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  const ro = isReadOnly(cid);
  return (
    <div className="kafka-view" data-testid="kafka-topics">
      <ViewHeader title="Topics" subtitle={getConnection(cid)?.name} readOnly={ro}>
        <button type="button" className="btn btn-xs btn-primary" disabled={ro} title={ro ? 'The connection is read-only' : undefined}
          onClick={() => runCommand('kafka.createTopic', { kind: 'source', connectionId: cid, providerId: 'kafka', nodeType: 'topics', path: ['topics'] })}>
          New topic…
        </button>
        <RefreshButton onClick={() => void loadTopics(cid, true)} busy={topics?.loading} />
      </ViewHeader>
      <div className="kafka-toolbar">
        <input className="input kafka-search" type="search" placeholder="Search topics" aria-label="Search topics" value={q} onChange={(e) => setQ(e.target.value)} data-primary-focus />
        <button type="button" className={`chip${conn?.showInternal ? ' on' : ''}`} aria-pressed={!!conn?.showInternal} onClick={() => setShowInternal(cid, !conn?.showInternal)}>
          Internal topics
        </button>
        <button type="button" className={`chip${underOnly ? ' on' : ''}`} aria-pressed={underOnly} onClick={() => setUnderOnly((v) => !v)}>Under-replicated</button>
        <span className="muted kafka-count">{rows.length} of {topics?.data?.length ?? 0}</span>
      </div>
      {topics?.error && <Banner>{topics.error}</Banner>}
      {!topics?.data && !topics?.error && <Empty>Loading topics…</Empty>}
      {topics?.data && !rows.length && <Empty>{topics.data.length ? 'No topic matches.' : 'This cluster has no topics yet.'}</Empty>}
      {rows.length > 0 && (
        <div className="kafka-table-wrap kafka-scroll">
          <table className="kafka-table kafka-clickable" aria-label="Topics">
            <thead><tr>{th('name', 'Name')}{th('partitions', 'Partitions', true)}<th className="num">Replication</th>{th('messages', 'Messages (est.)', true)}<th>Health</th><th /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.name} tabIndex={0} onDoubleClick={() => openTopic(cid, t.name)} onKeyDown={(e) => e.key === 'Enter' && openTopic(cid, t.name)}>
                  <td className="mono">{t.name}{t.internal && <span className="pill pill-muted kafka-inline-pill">internal</span>}</td>
                  <td className="num">{t.partitions}</td>
                  <td className="num">{t.replicationFactor}</td>
                  <td className="num">{t.messages == null ? <span className="muted">—</span> : formatCount(t.messages)}</td>
                  <td>{t.underReplicated ? <span className="pill pill-warning">{t.underReplicated} under-replicated</span> : <span className="kafka-ok">healthy</span>}</td>
                  <td className="kafka-cell-actions">
                    <button type="button" className="btn btn-xs" onClick={() => openTopic(cid, t.name, 'messages', { fetchSeq: Date.now() })}>Browse</button>
                    <button type="button" className="btn btn-xs" onClick={() => openTopic(cid, t.name)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
