// Collection workspace (docs/PLAN-M2.md 6.3–6.5), Compass-style: a namespace header with the collection's
// statistics and sub-tabs Documents · Aggregations · Schema · Indexes · Explain · Validation. Visited sub-views stay
// mounted (their results survive switching); their persistent state (query, pipeline, view) lives in the tab state.
import { Eye, Lock, RefreshCw } from 'lucide-react';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { lazy, Suspense, useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { MongoCollectionStats } from '../../api/types';
import { useConnection } from '../../store/connections';
import type { TabViewProps } from '../layout/tabViews';
import { patchTab, SUBS, tabState, type CollectionTabState, type MongoSub } from './open';
import { collectionInfo, loadCollections, useMongo } from './store';
import { formatBytes } from './tree';
import { DocumentsView } from './DocumentsView';
import { errorText, plural } from './util';
import './mongo.css';

const AggregationView = lazy(() => import('./AggregationView'));
const SchemaView = lazy(() => import('./SchemaView'));
const IndexesView = lazy(() => import('./IndexesView'));
const ExplainView = lazy(() => import('./ExplainView'));
const ValidationView = lazy(() => import('./ValidationView'));

const LABEL: Record<MongoSub, string> = {
  documents: 'Documents', aggregate: 'Aggregations', schema: 'Schema', indexes: 'Indexes', explain: 'Explain plan', validation: 'Validation',
};

export interface SubViewProps {
  tabId: string;
  cid: string;
  db: string;
  coll: string;
  state: CollectionTabState;
  patch: (p: Partial<CollectionTabState>) => void;
  theme: TabViewProps['theme'];
  visible: boolean;
  readOnly: boolean;
  isView: boolean;
  /** Collection stats changed (insert/delete/import/index): reload the header. */
  statsChanged: () => void;
}

export default function CollectionView({ tab, theme, visible }: TabViewProps) {
  const st = tabState(tab);
  const cid = tab.connectionId ?? '';
  const conn = useConnection(cid);
  const readOnly = !!conn?.readOnly;
  const { db, coll, sub } = st;
  const info = useMongo((s) => s.conns[cid]?.collections[db]?.data?.find((c) => c.name === coll));
  const isView = info?.type === 'view';
  const [stats, setStats] = useState<MongoCollectionStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<MongoSub>>(() => new Set([sub]));
  const [statsSeq, setStatsSeq] = useState(0);

  if (!visited.has(sub)) setVisited(new Set([...visited, sub]));

  useEffect(() => {
    if (!collectionInfo(cid, db, coll)) void loadCollections(cid, db);
  }, [cid, db, coll]);

  useEffect(() => {
    let live = true;
    api.mongo.stats(cid, db, coll).then(
      (s) => live && (setStats(s), setStatsError(null)),
      (e) => live && setStatsError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [cid, db, coll, statsSeq]);

  const patch = useCallback((p: Partial<CollectionTabState>) => patchTab(tab.id, p), [tab.id]);
  const statsChanged = useCallback(() => setStatsSeq((n) => n + 1), []);
  const select = (s: MongoSub) => patch({ sub: s });

  // palette / shortcut actions that switch the sub-view
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; action: string }>).detail;
      if (d.tabId !== tab.id) return;
      if (d.action.startsWith('view:')) patch({ sub: 'documents', view: d.action.slice(5) as CollectionTabState['view'] });
      else if (['addStage', 'runPipeline'].includes(d.action) && sub !== 'aggregate') patch({ sub: 'aggregate' });
    };
    window.addEventListener('dbstudio:mongo', on);
    return () => window.removeEventListener('dbstudio:mongo', on);
  }, [tab.id, sub, patch]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const avail = SUBS.filter((s) => !(isView && (s === 'indexes' || s === 'validation')));
    const i = avail.indexOf(sub);
    let next: MongoSub | null = null;
    if (e.key === 'ArrowRight') next = avail[(i + 1) % avail.length];
    else if (e.key === 'ArrowLeft') next = avail[(i - 1 + avail.length) % avail.length];
    else if (e.key === 'Home') next = avail[0];
    else if (e.key === 'End') next = avail[avail.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next);
    requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector(`[data-sub="${next}"]`) as HTMLElement | null)?.focus());
  };

  const props: Omit<SubViewProps, 'visible'> = { tabId: tab.id, cid, db, coll, state: st, patch, theme, readOnly, isView, statsChanged };
  const subVisible = (s: MongoSub) => visible && sub === s;

  return (
    <div className="mg" data-command-scope="mongo">
      <header className="mg-head">
        <span className="mg-head-icon" aria-hidden>{isView ? <Eye size={16} strokeWidth={1.5} /> : <ProviderLogo providerId="mongodb" size={16} />}</span>
        <h2 className="mg-ns" title={`${db}.${coll}`}><span className="mg-ns-db">{db}.</span>{coll}</h2>
        {isView && <span className="pill pill-muted" title={info?.viewOn ? `View on ${info.viewOn}` : undefined}>view{info?.viewOn ? ` on ${info.viewOn}` : ''}</span>}
        {info?.type === 'timeseries' && <span className="pill pill-muted">time series</span>}
        {stats && (
          <span className="mg-head-stats">
            <span title="Documents">{plural(stats.count, 'document')}</span>
            {stats.size > 0 && <span title={`Data size${stats.avgObjSize ? ` · average ${formatBytes(stats.avgObjSize)} per document` : ''}`}>{formatBytes(stats.size)}</span>}
            {!isView && <span title={stats.totalIndexSize ? `Total index size ${formatBytes(stats.totalIndexSize)}` : undefined}>{plural(stats.indexes, 'index', 'indexes')}</span>}
          </span>
        )}
        {statsError && <span className="mg-head-stats muted" title={statsError}>statistics unavailable</span>}
        <span className="flex-1" />
        {readOnly && <span className="pill pill-warning" title="Writes are blocked for this connection"><Lock size={12} aria-hidden /> read-only</span>}
        <button className="icon-btn sm" title="Reload statistics" aria-label="Reload statistics" onClick={statsChanged}><RefreshCw size={14} /></button>
      </header>
      <nav className="mg-subtabs" role="tablist" aria-label="Collection views">
        {SUBS.map((s) => {
          const disabled = isView && (s === 'indexes' || s === 'validation');
          return (
            <button key={s} role="tab" data-sub={s} aria-selected={sub === s} tabIndex={sub === s ? 0 : -1} disabled={disabled}
              title={disabled ? 'Views have no indexes or validation rules' : undefined}
              className={`mg-subtab ${sub === s ? 'on' : ''}`} onClick={() => select(s)} onKeyDown={onTabKey}>
              {LABEL[s]}
              {s === 'indexes' && stats && !isView && <span className="mg-subtab-count">{stats.indexes}</span>}
            </button>
          );
        })}
      </nav>
      <div className="mg-body">
        {visited.has('documents') && <div className="mg-pane" hidden={sub !== 'documents'}><DocumentsView {...props} visible={subVisible('documents')} /></div>}
        <Suspense fallback={<div className="mg-loading">Loading…</div>}>
          {visited.has('aggregate') && <div className="mg-pane" hidden={sub !== 'aggregate'}><AggregationView {...props} visible={subVisible('aggregate')} /></div>}
          {visited.has('schema') && <div className="mg-pane" hidden={sub !== 'schema'}><SchemaView {...props} visible={subVisible('schema')} /></div>}
          {visited.has('indexes') && !isView && <div className="mg-pane" hidden={sub !== 'indexes'}><IndexesView {...props} visible={subVisible('indexes')} /></div>}
          {visited.has('explain') && <div className="mg-pane" hidden={sub !== 'explain'}><ExplainView {...props} visible={subVisible('explain')} /></div>}
          {visited.has('validation') && !isView && <div className="mg-pane" hidden={sub !== 'validation'}><ValidationView {...props} visible={subVisible('validation')} /></div>}
        </Suspense>
      </div>
    </div>
  );
}
