// Explain plan (docs/PLAN-M2.md 6.3 "Explain"): Compass-style query performance summary (documents returned and
// examined, keys examined, time, index used, in-memory sort), warnings (COLLSCAN, poor selectivity, in-memory sort,
// rejected plans) and the winning plan as a visual stage tree; Raw shows the server's explain output.
import { AlertTriangle, ChevronDown, ChevronRight, Gauge, KeyRound, ListTree, Play, ScanSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { MongoExplainResponse, MongoExplainVerbosity, PlanNode } from '../../api/types';
import { Select } from '../common/Select';
import { stageText } from './AggregationView';
import type { SubViewProps } from './CollectionView';
import { DEFAULT_QUERY } from './open';
import { errorText } from './util';

const VERBOSITY: { value: MongoExplainVerbosity; label: string }[] = [
  { value: 'queryPlanner', label: 'Query planner (no execution)' },
  { value: 'executionStats', label: 'Execution stats' },
  { value: 'allPlansExecution', label: 'All plans execution' },
];

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
}

function StageBox({ node, depth }: { node: PlanNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const props = Object.entries(node.props ?? {});
  const collscan = node.op === 'COLLSCAN';
  const ixscan = /IXSCAN|IDHACK|COUNT_SCAN|DISTINCT_SCAN/.test(node.op);
  return (
    <div className="mg-xnode-wrap">
      <div className={`mg-xnode ${collscan ? 'collscan' : ''} ${node.warnings.length ? 'warn' : ''}`} role="treeitem" aria-level={depth + 1} aria-expanded={props.length ? open : undefined}>
        <div className="mg-xnode-head">
          {ixscan ? <KeyRound size={14} aria-hidden className="mg-xnode-icon" /> : collscan ? <ScanSearch size={14} aria-hidden className="mg-xnode-icon" /> : <ListTree size={14} aria-hidden className="mg-xnode-icon" />}
          <span className="mg-xnode-op">{node.op}</span>
          {node.object && <span className="mg-xnode-obj" title={node.object}>{node.object}</span>}
          <span className="flex-1" />
          {node.actualRows !== null && <span className="mg-xnode-rows" title="Documents returned by this stage">{num(node.actualRows)} returned</span>}
        </div>
        <div className="mg-xnode-stats">
          {node.props?.docsExamined && <span>{num(Number(node.props.docsExamined))} docs examined</span>}
          {node.props?.keysExamined && <span>{num(Number(node.props.keysExamined))} keys examined</span>}
          {node.props?.executionTimeMillisEstimate && <span>{node.props.executionTimeMillisEstimate} ms</span>}
        </div>
        {node.predicate && <code className="mg-xnode-pred" title={node.predicate}>{node.predicate}</code>}
        {node.warnings.map((w) => <div key={w} className="mg-xnode-warn"><AlertTriangle size={12} aria-hidden /> {w}</div>)}
        {props.length > 0 && (
          <button className="link-btn mg-xnode-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />} Details
          </button>
        )}
        {open && (
          <dl className="mg-xnode-props">
            {props.map(([k, v]) => <div key={k}><dt>{k}</dt><dd><code>{v}</code></dd></div>)}
          </dl>
        )}
      </div>
      {node.children.length > 0 && (
        <div className={`mg-xchildren ${node.children.length > 1 ? 'many' : ''}`} role="group">
          {node.children.map((c) => <StageBox key={c.id} node={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}

export default function ExplainView({ cid, db, coll, state, visible }: SubViewProps) {
  const of = state.explainOf ?? 'find';
  const [verbosity, setVerbosity] = useState<MongoExplainVerbosity>('executionStats');
  const [res, setRes] = useState<MongoExplainResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'tree' | 'raw'>('tree');
  const lastSeq = useRef<number | undefined>(undefined);
  const q = { ...DEFAULT_QUERY, ...state.query };
  const pipeline = (state.pipeline ?? []).filter((s) => s.enabled);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = of === 'aggregate'
        ? await api.mongo.explain(cid, db, coll, { kind: 'aggregate', verbosity, pipeline: pipeline.map(stageText).filter((s) => !/^\{ \$(out|merge):/.test(s)), limit: 20, skip: 0, allowDiskUse: true, maxTimeMs: 60000 })
        : await api.mongo.explain(cid, db, coll, { kind: 'find', verbosity, filter: q.filter, projection: q.projection || null, sort: q.sort || null, collation: q.collation || null, skip: q.skip, limit: q.limit, maxTimeMs: q.maxTimeMs });
      setRes(r);
    } catch (e) {
      setError(errorText(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  // run on open and whenever the documents view / pipeline asks again
  useEffect(() => {
    if (!visible || lastSeq.current === (state.runSeq ?? 0)) return;
    lastSeq.current = state.runSeq ?? 0;
    void run();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const s = res?.summary;
  const source = of === 'aggregate' ? `Pipeline: ${pipeline.length} stage${pipeline.length === 1 ? '' : 's'}` : `Filter: ${q.filter.trim() || '{}'}${q.sort.trim() ? ` · sort ${q.sort.trim()}` : ''}`;

  return (
    <div className="mg-explain">
      <div className="mg-toolbar" role="toolbar" aria-label="Explain">
        <Gauge size={16} strokeWidth={1.5} className="pv-icon" aria-hidden />
        <code className="mg-explain-src" title={source}>{source}</code>
        <span className="flex-1" />
        <Select aria-label="Verbosity" size="sm" value={verbosity} onChange={setVerbosity} options={VERBOSITY} menuMinWidth={240} />
        <div className="segmented" role="tablist" aria-label="Explain view">
          <button role="tab" aria-selected={tab === 'tree'} className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')}>Visual tree</button>
          <button role="tab" aria-selected={tab === 'raw'} className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>Raw output</button>
        </div>
        <button className="btn btn-xs btn-primary" onClick={() => void run()} disabled={busy}><Play size={14} aria-hidden /> Explain</button>
      </div>
      {error && <div className="mg-error" role="alert"><strong>Explain failed.</strong> {error}</div>}
      {busy && !res && <div className="mg-loading">Explaining…</div>}
      {res && (
        <div className="mg-explain-body">
          <section className="mg-perf" aria-label="Query performance summary">
            <h3>Query performance summary</h3>
            <div className="mg-perf-grid">
              <div className="mg-perf-item"><span className="mg-perf-n">{num(s?.nReturned)}</span><span>documents returned</span></div>
              <div className={`mg-perf-item ${s && s.docsExamined !== null && s.nReturned !== null && s.docsExamined > 10 * Math.max(1, s.nReturned) ? 'bad' : ''}`}>
                <span className="mg-perf-n">{num(s?.docsExamined)}</span><span>documents examined</span>
              </div>
              <div className="mg-perf-item"><span className="mg-perf-n">{num(s?.keysExamined)}</span><span>index keys examined</span></div>
              <div className="mg-perf-item"><span className="mg-perf-n">{s?.executionTimeMs === null || s?.executionTimeMs === undefined ? '—' : `${s.executionTimeMs} ms`}</span><span>execution time</span></div>
              <div className={`mg-perf-item ${s?.collscan ? 'bad' : 'good'}`}>
                <span className="mg-perf-n mg-perf-idx">{s?.collscan ? 'No index' : s?.indexes.length ? s.indexes.join(', ') : '—'}</span>
                <span>{s?.collscan ? 'collection scan (COLLSCAN)' : 'index used'}</span>
              </div>
              <div className={`mg-perf-item ${s?.sortInMemory ? 'bad' : ''}`}><span className="mg-perf-n">{s ? (s.sortInMemory ? 'Yes' : 'No') : '—'}</span><span>sorted in memory</span></div>
            </div>
            {verbosity === 'queryPlanner' && <p className="muted mg-perf-note">Query planner mode does not run the query: counts and time need execution stats.</p>}
          </section>
          {res.warnings.length > 0 && (
            <ul className="pv-plan-warnings mg-explain-warn" aria-label="Warnings">
              {res.warnings.map((w) => <li key={w}><AlertTriangle size={14} aria-hidden /> {w}</li>)}
            </ul>
          )}
          {tab === 'tree' ? (
            <div className="mg-xtree" role="tree" aria-label="Winning plan">
              <StageBox node={res.root} depth={0} />
            </div>
          ) : (
            <pre className="mg-raw" aria-label="Raw explain output">{res.raw}</pre>
          )}
        </div>
      )}
    </div>
  );
}
