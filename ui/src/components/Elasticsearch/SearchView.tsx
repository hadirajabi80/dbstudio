// Search (plan-batch3 WP-ES): a query DSL editor (completion of DSL keys and the target's field names, examples built
// from the mapping), Run (Ctrl+Enter), Explain, and the response as Hits (score, highlights, explanation),
// Aggregations (bucket tables with bars, metric tiles) and the raw JSON.
import { displayShortcut } from '../../commands/keys';
import { ChevronDown, ChevronRight, Copy, Play, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { EsHit, EsSearchResponse } from '../../api/types.es';
import { aggViews } from '../../es/aggs';
import { formatRequest } from '../../es/console';
import { exampleBodies, gridColumns, flattenSource } from '../../es/docs';
import { formatMs } from '../../es/format';
import { isPlainObject, parseLenient, pretty } from '../../es/json';
import { toast } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { AggsViewer } from './AggsView';
import { CodeEditor } from './CodeEditor';
import { CellValue, Fragment, JsonTree } from './JsonTree';
import { openConsole, patchTab, type SearchTabState } from './open';
import { Banner, Empty, esErrorText, ViewHeader } from './parts';
import { knownTargets, loadFields, useEs } from './store';

type ResultTab = 'hits' | 'aggs' | 'raw';

export function SearchView({ tab, theme, visible, cid }: TabViewProps & { cid: string }) {
  const st = (tab.state ?? {}) as Partial<SearchTabState>;
  const [index, setIndex] = useState(st.index ?? '');
  const [body, setBody] = useState(st.body ?? '{\n  "query": { "match_all": {} }\n}');
  const [res, setRes] = useState<EsSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ResultTab>('hits');
  const [explain, setExplain] = useState(false);
  const fieldsEntry = useEs((s) => s.fields[`${cid}\n${index}`]);
  const fields = useMemo(() => fieldsEntry?.data ?? [], [fieldsEntry]);
  const connData = useEs((x) => x.conns[cid]);
  const targets = useMemo(() => (connData ? knownTargets(cid) : []), [connData, cid]);
  const indexRef = useRef(index);
  indexRef.current = index;
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (index.trim()) void loadFields(cid, index.trim());
  }, [cid, index]);

  // persist editor text / target in the tab (debounced)
  useEffect(() => {
    const t = setTimeout(() => patchTab(tab.id, { body, index }), 400);
    return () => clearTimeout(t);
  }, [tab.id, body, index]);

  const run = useCallback(async () => {
    const parsed = parseLenient(body);
    if (!parsed.ok) {
      setError(`The query is not valid JSON: ${parsed.error}`);
      return;
    }
    const value = parsed.value === undefined ? {} : parsed.value;
    if (!isPlainObject(value)) {
      setError('The search body must be a JSON object.');
      return;
    }
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setError(null);
    try {
      const r = await api.es.search(cid, { index: index.trim() || '_all', body: explain ? { ...value, explain: true } : value }, c.signal);
      setRes(r);
      setView((v) => (v === 'aggs' && !r.aggregations ? 'hits' : r.aggregations && r.hits.length === 0 ? 'aggs' : v));
    } catch (e) {
      if (!c.signal.aborted) setError(esErrorText(e));
    } finally {
      if (ctl.current === c) setBusy(false);
    }
  }, [body, cid, index, explain]);

  // opened with runSeq: run once
  const ranSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!visible || !st.runSeq || ranSeq.current === st.runSeq) return;
    ranSeq.current = st.runSeq;
    void run();
  }, [visible, st.runSeq, run]);

  useEffect(() => () => ctl.current?.abort(), []);

  const examples = useMemo(() => exampleBodies(fields), [fields]);
  const consoleText = () => {
    const parsed = parseLenient(body);
    return formatRequest('GET', `/${index.trim() || '_all'}/_search`, parsed.ok && parsed.value !== undefined ? parsed.value : body);
  };
  const aggs = useMemo(() => aggViews(res?.aggregations), [res]);

  return (
    <div className="es-view" data-testid="es-search">
      <ViewHeader title="Search" subtitle={index || 'all indices'}>
        <button type="button" className="btn btn-xs" onClick={() => openConsole(cid, consoleText())}><SquareTerminal size={13} aria-hidden /> Open in Dev Tools</button>
        <button type="button" className="btn btn-xs" onClick={() => void navigator.clipboard?.writeText(consoleText()).then(() => toast('success', 'Copied as console request'), () => undefined)}>
          <Copy size={13} aria-hidden /> Copy as console
        </button>
      </ViewHeader>
      <div className="es-toolbar">
        <label className="es-inline">
          <span className="muted">Index</span>
          <input className="input input-sm mono es-target" list={`es-targets-${tab.id}`} aria-label="Index, alias or pattern" value={index} placeholder="shop-*"
            onChange={(e) => setIndex(e.target.value)} />
          <datalist id={`es-targets-${tab.id}`}>{targets.map((t) => <option key={t} value={t} />)}</datalist>
        </label>
        <select className="input input-sm es-examples" aria-label="Examples" value="" onChange={(e) => {
          const ex = examples[Number(e.target.value)];
          if (ex) setBody(pretty(ex.body));
        }}>
          <option value="">Examples…</option>
          {examples.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
        </select>
        <label className="check" title="Adds explain: true; every hit carries its score explanation"><input type="checkbox" checked={explain} onChange={(e) => setExplain(e.target.checked)} /> Explain</label>
        <span className="flex-1" />
        {res && <span className="muted es-count">{res.total?.toLocaleString('en-US') ?? '?'}{res.totalRelation === 'gte' ? '+' : ''} hits · took {formatMs(res.took)} · {res.shards.successful}/{res.shards.total} shards{res.shards.failed ? ` · ${res.shards.failed} failed` : ''}{res.timedOut ? ' · timed out' : ''}</span>}
        <button type="button" className="btn btn-xs btn-primary" onClick={() => void run()} disabled={busy} title={`Run (${displayShortcut('Mod+Enter')})`}><Play size={13} aria-hidden /> {busy ? 'Running…' : 'Run'}</button>
      </div>
      <div className="es-split">
        <div className="es-split-left">
          <CodeEditor value={body} onChange={setBody} language="json" ariaLabel="Query DSL" theme={theme} onRun={() => void run()} primary
            completion={{ cid, dsl: true, index: () => indexRef.current.trim() || null }} className="es-fill-editor" />
        </div>
        <div className="es-split-right">
          <div className="es-subtabs" role="tablist" aria-label="Result views">
            <button type="button" role="tab" aria-selected={view === 'hits'} className={`es-subtab${view === 'hits' ? ' on' : ''}`} onClick={() => setView('hits')}>
              Hits{res ? ` (${res.hits.length})` : ''}
            </button>
            <button type="button" role="tab" aria-selected={view === 'aggs'} className={`es-subtab${view === 'aggs' ? ' on' : ''}`} onClick={() => setView('aggs')}>
              Aggregations{aggs.length ? ` (${aggs.length})` : ''}
            </button>
            <button type="button" role="tab" aria-selected={view === 'raw'} className={`es-subtab${view === 'raw' ? ' on' : ''}`} onClick={() => setView('raw')}>Response</button>
          </div>
          {error && <Banner>{error}</Banner>}
          {res?.capped && <Banner tone="warn">size was lowered to 10,000 (index.max_result_window); use search_after or Export for more.</Banner>}
          <div className="es-scroll">
            {!res && !error && <Empty>Write a query and press Run ({displayShortcut('Mod+Enter')}).</Empty>}
            {res && view === 'hits' && <HitList hits={res.hits} />}
            {res && view === 'aggs' && (aggs.length ? <AggsViewer views={aggs} /> : <Empty>No aggregations in this response. Add an "aggs" object to the query.</Empty>)}
            {res && view === 'raw' && <div className="es-pad"><JsonTree value={{ took: res.took, timed_out: res.timedOut, _shards: res.shards, hits: { total: { value: res.total, relation: res.totalRelation }, max_score: res.maxScore, hits: res.hits }, aggregations: res.aggregations ?? undefined, profile: res.profile ?? undefined }} openDepth={2} label="Response" /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function HitList({ hits }: { hits: EsHit[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set([0]));
  const cols = useMemo(() => gridColumns(hits, 6), [hits]);
  if (!hits.length) return <Empty>No hits.</Empty>;
  const toggle = (i: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  return (
    <div className="es-hits" role="list" aria-label="Hits">
      {hits.map((h, i) => {
        const flat = flattenSource(h.source);
        const isOpen = open.has(i);
        return (
          <div key={`${h.index}/${h.id}/${i}`} className="es-hit" role="listitem">
            <button type="button" className="es-hit-head" onClick={() => toggle(i)} aria-expanded={isOpen}>
              {isOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
              <span className="es-hit-score" title="_score">{h.score != null ? h.score.toFixed(3) : '—'}</span>
              <span className="mono es-hit-id">{h.id}</span>
              <span className="es-chip es-chip-muted">{h.index}</span>
              <span className="es-hit-preview">
                {cols.map((c) => flat[c] !== undefined && <span key={c} className="es-hit-field"><span className="muted">{c}:</span> <CellValue v={flat[c]} /></span>)}
              </span>
            </button>
            {isOpen && (
              <div className="es-hit-body">
                {h.highlight && (
                  <div className="es-hl-list">
                    {Object.entries(h.highlight).map(([f, frags]) => (
                      <div key={f} className="es-hl-row"><span className="muted mono">{f}</span> {frags.map((x, k) => <Fragment key={k} html={x} />)}</div>
                    ))}
                  </div>
                )}
                {h.sort && <div className="muted es-hit-sort">sort: <span className="mono">{JSON.stringify(h.sort)}</span></div>}
                <JsonTree value={h.source} openDepth={2} label={`Hit ${h.id}`} />
                {h.explanation != null && (
                  <details className="es-explain">
                    <summary>Score explanation</summary>
                    <Explanation node={h.explanation} />
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Explanation({ node, depth = 0 }: { node: unknown; depth?: number }) {
  if (!isPlainObject(node)) return null;
  const details = Array.isArray(node.details) ? node.details : [];
  return (
    <div className="es-explain-node" style={{ paddingLeft: depth ? 14 : 0 }}>
      <span className="es-explain-value">{typeof node.value === 'number' ? node.value.toFixed(4) : String(node.value)}</span> <span>{String(node.description ?? '')}</span>
      {details.map((d, i) => <Explanation key={i} node={d} depth={depth + 1} />)}
    </div>
  );
}
