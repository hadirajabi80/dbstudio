// Database analysis (`redis.analysis`, docs/PLAN-M2.md 5.5): a job (progress, Cancel) that samples up to N keys and
// returns memory by namespace, the top keys by MEMORY USAGE, per-type totals and TTL buckets. Namespace tree sortable
// by memory or keys, bars in --accent, the type split as one stacked bar (no chart library), top keys open in the
// browser, Re-run, export JSON / CSV.
import { ChevronDown, ChevronRight, Download, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { engineSocket } from '../../api/ws';
import type { RedisAnalysisNamespace, RedisAnalysisResult, RedisKeyType } from '../../api/types';
import { getPlatform } from '../../platform';
import { formatBytes, formatCount, formatTtl, TYPE_LABEL } from '../../redis/format';
import { toast } from '../../store/ui';
import { useTabs } from '../../store/tabs';
import { Select } from '../common/Select';
import type { TabViewProps } from '../layout/tabViews';
import { openKey, type AnalysisState } from './open';
import { errorText, loadServer, useRedis } from './store';
import { typeIcon, TYPE_COLOR } from './tree';

interface NsNode { ns: RedisAnalysisNamespace; children: RedisAnalysisNamespace[] }

/** Second-level namespaces under their first-level parent. */
export function namespaceTree(list: RedisAnalysisNamespace[], delimiter: string): NsNode[] {
  const top = list.filter((n) => n.prefix === '' || n.prefix.indexOf(delimiter) === n.prefix.length - delimiter.length);
  return top.map((ns) => ({ ns, children: ns.prefix ? list.filter((c) => c !== ns && c.prefix.startsWith(ns.prefix)) : [] }));
}

export function analysisCsv(r: RedisAnalysisResult): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['section,name,keys,memory,avg_ttl,type'];
  for (const n of r.namespaces) lines.push(['namespace', esc(n.prefix || '(no namespace)'), n.keys, n.memory, n.avgTtl ?? '', ''].join(','));
  for (const k of r.topKeys) lines.push(['top_key', esc(k.key), 1, k.memory, k.ttl, k.type].join(','));
  for (const [t, v] of Object.entries(r.byType)) lines.push(['type', t, v?.keys ?? 0, v?.memory ?? 0, '', t].join(','));
  return lines.join('\n');
}

function Bar({ value, max }: { value: number; max: number }) {
  return <span className="redis-bar" aria-hidden><span style={{ width: `${max ? Math.max(1, (value / max) * 100) : 0}%` }} /></span>;
}

export function AnalysisView({ tab }: TabViewProps) {
  const cid = tab.connectionId ?? '';
  const st = tab.state as AnalysisState & { result?: RedisAnalysisResult | null };
  const server = useRedis((s) => s.conns[cid]?.server.data);
  useEffect(() => {
    void loadServer(cid);
  }, [cid]);
  const [db, setDb] = useState(st.db ?? 0);
  const [limit, setLimit] = useState(100_000);
  const [delimiter, setDelimiter] = useState('');
  const [job, setJob] = useState<{ id: string; done: number; total: number | null; message: string | null } | null>(null);
  const [result, setResult] = useState<RedisAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<'memory' | 'keys'>('memory');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const off = useRef<(() => void) | null>(null);
  useEffect(() => () => off.current?.(), []);
  const delim = delimiter || server?.delimiter || ':';

  const run = async () => {
    setError(null);
    try {
      const { jobId } = await api.redis.analysis(cid, { db, sampleLimit: limit, delimiter: delim });
      setJob({ id: jobId, done: 0, total: null, message: 'Starting…' });
      off.current = engineSocket.onJob(jobId, (ev) => {
        if (ev.type === 'job.progress') setJob((j) => (j ? { ...j, done: ev.done, total: ev.total, message: ev.message } : j));
        else {
          off.current?.();
          setJob(null);
          if (ev.status === 'ok') {
            setResult(ev.result as RedisAnalysisResult);
            const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
            if (cur?.kind === 'view') useTabs.getState().updateView(tab.id, { state: { ...(cur.state as object), db } });
          } else if (ev.status === 'cancelled') toast('info', 'Analysis cancelled');
          else setError(ev.error ?? 'The analysis failed.');
        }
      });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async (kind: 'json' | 'csv') => {
    if (!result) return;
    const name = `redis-analysis-db${db}.${kind}`;
    const content = kind === 'json' ? JSON.stringify(result, null, 2) : analysisCsv(result);
    const saved = await getPlatform().saveFile({ suggestedName: name, content, mime: kind === 'json' ? 'application/json' : 'text/csv' });
    if (saved) toast('success', 'Analysis exported', saved);
  };

  const tree = useMemo(() => {
    if (!result) return [];
    const t = namespaceTree(result.namespaces, delim);
    const by = (a: RedisAnalysisNamespace, b: RedisAnalysisNamespace) => (sort === 'memory' ? b.memory - a.memory : b.keys - a.keys);
    t.sort((a, b) => by(a.ns, b.ns));
    for (const n of t) n.children.sort(by);
    return t;
  }, [result, sort, delim]);
  const maxNs = tree.reduce((m, n) => Math.max(m, sort === 'memory' ? n.ns.memory : n.ns.keys), 0);
  const totalMem = result ? Object.values(result.byType).reduce((s, v) => s + (v?.memory ?? 0), 0) : 0;
  const pct = job?.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="redis-view redis-analysis" data-command-scope="redisAnalysis">
      <div className="redis-toolbar" role="toolbar" aria-label="Analysis">
        {server?.mode !== 'cluster' && (
          <Select size="sm" aria-label="Database" mono value={db} onChange={(v) => setDb(Number(v))}
            options={Array.from({ length: server?.databases ?? 16 }, (_, i) => ({ value: i, label: `db${i}`, hint: formatCount(server?.keyspace.find((k) => k.db === i)?.keys) || undefined }))} />
        )}
        <Select size="sm" aria-label="Sample size" value={limit} onChange={(v) => setLimit(Number(v))}
          options={[10_000, 100_000, 1_000_000, 5_000_000].map((n) => ({ value: n, label: `up to ${formatCount(n)} keys` }))} />
        <label className="tb-label" htmlFor={`an-delim-${tab.id}`}>Delimiter</label>
        <input id={`an-delim-${tab.id}`} className="input redis-narrow mono" value={delimiter} placeholder={server?.delimiter || ':'} onChange={(e) => setDelimiter(e.target.value)} />
        {!job
          ? <button className="btn btn-xs btn-primary" onClick={() => void run()}><Play size={13} /> {result ? 'Re-run' : 'Analyze'}</button>
          : <button className="btn btn-xs" onClick={() => void api.cancelJob(job.id)}><Square size={13} /> Cancel</button>}
        <span className="flex-1" />
        <button className="btn btn-xs" disabled={!result} onClick={() => void save('json')}><Download size={13} /> JSON</button>
        <button className="btn btn-xs" disabled={!result} onClick={() => void save('csv')}><Download size={13} /> CSV</button>
      </div>
      {job && (
        <div className="redis-progress" role="progressbar" aria-label="Analysis progress" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <div className="redis-progress-bar" style={{ width: `${pct ?? 3}%` }} />
          <span className="muted">{job.message}</span>
        </div>
      )}
      {error && <div className="message sev-error redis-banner" role="alert">{error}</div>}
      {!result && !job && (
        <div className="redis-empty-detail muted">
          <p>Analysis samples the keys of a database (SCAN + TYPE + TTL + MEMORY USAGE) and shows where the memory goes.</p>
          <p>It reads every sampled key once: run it off-peak on large production databases.</p>
        </div>
      )}
      {result && (
        <div className="redis-analysis-body">
          <div className="redis-tiles">
            <div className="redis-tile"><div className="redis-tile-title">Keys analysed</div><div className="redis-tile-value tabular">{formatCount(result.scanned)}</div>
              <div className="redis-tile-sub muted">{result.sampled ? `sample of ${formatCount(result.totalKeys)}` : `all ${formatCount(result.totalKeys)} keys`}</div></div>
            <div className="redis-tile"><div className="redis-tile-title">Memory</div><div className="redis-tile-value tabular">{formatBytes(totalMem)}</div>
              <div className="redis-tile-sub muted">{result.sampled ? 'in the sample' : 'MEMORY USAGE total'}</div></div>
            <div className="redis-tile"><div className="redis-tile-title">With TTL</div><div className="redis-tile-value tabular">{result.scanned ? Math.round((result.expiring / result.scanned) * 100) : 0} %</div>
              <div className="redis-tile-sub muted">{formatCount(result.expiring)} keys expire</div></div>
            {result.elapsedMs !== undefined && <div className="redis-tile"><div className="redis-tile-title">Duration</div><div className="redis-tile-value tabular">{(result.elapsedMs / 1000).toFixed(1)} s</div></div>}
          </div>
          <section className="redis-panel">
            <h3>By type</h3>
            <div className="redis-stack" role="img" aria-label="Memory by type">
              {Object.entries(result.byType).map(([t, v]) => (
                <span key={t} style={{ width: `${totalMem ? ((v?.memory ?? 0) / totalMem) * 100 : 0}%`, background: TYPE_COLOR[t as RedisKeyType] }} title={`${TYPE_LABEL[t as RedisKeyType]}: ${formatBytes(v?.memory ?? 0)}`} />
              ))}
            </div>
            <ul className="redis-legend">
              {Object.entries(result.byType).sort((a, b) => (b[1]?.memory ?? 0) - (a[1]?.memory ?? 0)).map(([t, v]) => (
                <li key={t}>{typeIcon(t as RedisKeyType, 12)} {TYPE_LABEL[t as RedisKeyType]} <span className="tabular">{formatCount(v?.keys ?? 0)} keys · {formatBytes(v?.memory ?? 0)}</span></li>
              ))}
            </ul>
          </section>
          <div className="redis-analysis-grid">
            <section className="redis-panel">
              <h3>
                Namespaces
                <span className="segmented" role="group" aria-label="Sort namespaces">
                  <button className={sort === 'memory' ? 'on' : ''} aria-pressed={sort === 'memory'} onClick={() => setSort('memory')}>Memory</button>
                  <button className={sort === 'keys' ? 'on' : ''} aria-pressed={sort === 'keys'} onClick={() => setSort('keys')}>Keys</button>
                </span>
              </h3>
              <table className="redis-table compact" aria-label="Namespaces">
                <thead><tr><th>Prefix</th><th style={{ width: '30%' }} /><th>Keys</th><th>Memory</th><th>Avg TTL</th></tr></thead>
                <tbody>
                  {tree.slice(0, 300).map(({ ns, children }) => {
                    const isOpen = open.has(ns.prefix);
                    return [
                      <tr key={ns.prefix || '(none)'}>
                        <td>
                          {children.length ? (
                            <button className="link-btn mono" aria-expanded={isOpen} onClick={() => { const n = new Set(open); if (isOpen) n.delete(ns.prefix); else n.add(ns.prefix); setOpen(n); }}>
                              {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {ns.prefix}
                            </button>
                          ) : <span className="mono">{ns.prefix || <span className="muted">(no namespace)</span>}</span>}
                        </td>
                        <td><Bar value={sort === 'memory' ? ns.memory : ns.keys} max={maxNs} /></td>
                        <td className="tabular">{formatCount(ns.keys)}</td><td className="tabular">{formatBytes(ns.memory)}</td><td className="tabular">{ns.avgTtl === null ? '–' : formatTtl(ns.avgTtl)}</td>
                      </tr>,
                      ...(isOpen ? children.slice(0, 50).map((c) => (
                        <tr key={c.prefix} className="redis-sub-row">
                          <td className="mono">{c.prefix.slice(ns.prefix.length)}</td><td><Bar value={sort === 'memory' ? c.memory : c.keys} max={maxNs} /></td>
                          <td className="tabular">{formatCount(c.keys)}</td><td className="tabular">{formatBytes(c.memory)}</td><td className="tabular">{c.avgTtl === null ? '–' : formatTtl(c.avgTtl)}</td>
                        </tr>
                      )) : []),
                    ];
                  })}
                </tbody>
              </table>
            </section>
            <section className="redis-panel">
              <h3>Top keys by memory</h3>
              <table className="redis-table compact" aria-label="Top keys">
                <thead><tr><th>Key</th><th>Type</th><th>Memory</th><th>TTL</th></tr></thead>
                <tbody>
                  {result.topKeys.slice(0, 100).map((k) => (
                    <tr key={k.key}>
                      <td><button className="link-btn mono redis-cell-clip" title={`Open ${k.key}`} onClick={() => openKey(cid, db, k.key)}>{k.key}</button></td>
                      <td>{typeIcon(k.type, 12)} {TYPE_LABEL[k.type]}</td><td className="tabular">{formatBytes(k.memory)}</td><td className="tabular">{k.ttl >= 0 ? formatTtl(k.ttl) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>TTL</h3>
              <ul className="redis-ttl-buckets">
                <li><span>No TTL</span><Bar value={result.ttl.noTtl} max={result.scanned} /><span className="tabular">{formatCount(result.ttl.noTtl)}</span></li>
                {result.ttl.buckets.map((b) => <li key={b.label}><span>{b.label}</span><Bar value={b.keys} max={result.scanned} /><span className="tabular">{formatCount(b.keys)}</span></li>)}
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
