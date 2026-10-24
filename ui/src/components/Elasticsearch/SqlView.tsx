// SQL tab (plan-batch3 WP-ES): Elasticsearch SQL (`_sql`) or the OpenSearch SQL plugin (`_plugins/_sql`), normalised by
// the engine. Results table with "More rows" (cursor), "Translate to DSL" (opens the query DSL), table/field
// completion. Identifiers with dashes need quotes: "shop-orders" on Elasticsearch, `shop-orders` on OpenSearch.
import { displayShortcut } from '../../commands/keys';
import { Languages, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { EsSqlResponse } from '../../api/types.es';
import { formatMs } from '../../es/format';
import { pretty } from '../../es/json';
import { getConnection } from '../../store/connections';
import type { TabViewProps } from '../layout/tabViews';
import { CodeEditor } from './CodeEditor';
import { CellValue, JsonTree } from './JsonTree';
import { patchTab, type SqlTabState } from './open';
import { Banner, Empty, esErrorText, ViewHeader } from './parts';
import { flavorOf, loadCluster, loadIndices } from './store';

const defaultQuery = (q: string) => `SELECT status, COUNT(*) AS orders, ROUND(SUM(total), 2) AS revenue\nFROM ${q}shop-orders${q}\nGROUP BY status\nORDER BY revenue DESC`;

export function SqlView({ tab, theme, cid }: TabViewProps & { cid: string }) {
  const st = (tab.state ?? {}) as SqlTabState;
  const os = flavorOf(cid) === 'opensearch';
  const [query, setQuery] = useState(st.query ?? defaultQuery(os ? '`' : '"'));
  const [res, setRes] = useState<EsSqlResponse | null>(null);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dsl, setDsl] = useState<unknown>(undefined);
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    void loadCluster(cid);
    void loadIndices(cid);
  }, [cid]);

  useEffect(() => {
    const t = setTimeout(() => patchTab(tab.id, { query }), 400);
    return () => clearTimeout(t);
  }, [tab.id, query]);

  const run = async (more = false) => {
    setBusy(true);
    setError(null);
    try {
      if (!more && cursor.current) void api.es.sqlClose(cid, cursor.current).catch(() => undefined);
      const r = await api.es.sql(cid, more && cursor.current ? { query: '', cursor: cursor.current } : { query: query.trim().replace(/;\s*$/, ''), fetchSize: 200 });
      cursor.current = r.cursor;
      setRes(more && res ? { ...r, columns: res.columns } : r);
      setRows((prev) => (more ? [...prev, ...r.rows] : r.rows));
      setDsl(undefined);
    } catch (e) {
      setError(esErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const translate = async () => {
    setError(null);
    try {
      setDsl((await api.es.sqlTranslate(cid, query.trim().replace(/;\s*$/, ''))).dsl);
    } catch (e) {
      setError(esErrorText(e));
    }
  };

  return (
    <div className="es-view" data-testid="es-sql">
      <ViewHeader title="SQL" subtitle={`${getConnection(cid)?.name ?? ''} · ${os ? 'OpenSearch SQL plugin' : 'Elasticsearch SQL'}`}>
        <button type="button" className="btn btn-xs" onClick={() => void translate()} title="Show the query DSL of this statement"><Languages size={13} aria-hidden /> Translate to DSL</button>
        <button type="button" className="btn btn-xs btn-primary" onClick={() => void run()} disabled={busy} title={`Run (${displayShortcut('Mod+Enter')})`}><Play size={13} aria-hidden /> {busy ? 'Running…' : 'Run'}</button>
      </ViewHeader>
      <div className="es-sql-editor">
        <CodeEditor value={query} onChange={setQuery} language="sql" ariaLabel="SQL query" theme={theme} onRun={() => void run()} completion={{ cid }} height={150} primary />
        <div className="es-hint muted">Quote index names with dashes: {os ? <code>`shop-orders`</code> : <code>"shop-orders"</code>}. {displayShortcut('Mod+Enter')} runs.</div>
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="es-scroll">
        {dsl !== undefined ? (
          <div className="es-pad">
            <div className="es-section-head"><h3 className="es-section-title">Query DSL</h3><button type="button" className="link-btn" onClick={() => setDsl(undefined)}>Back to results</button></div>
            <pre className="es-pre mono">{pretty(dsl)}</pre>
          </div>
        ) : !res ? <Empty>Write a SELECT and press Run.</Empty> : (
          <>
            <table className="es-grid" aria-label="SQL results">
              <thead><tr><th className="es-grid-n">#</th>{res.columns.map((c, i) => <th key={i} title={c.type}>{c.name} <span className="muted es-col-type">{c.type}</span></th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="es-grid-n">{i + 1}</td>
                    {r.map((v, j) => <td key={j}>{v !== null && typeof v === 'object' ? <JsonTree value={v} openDepth={0} /> : <CellValue v={v} />}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="es-pager">
              <span className="muted">{rows.length.toLocaleString('en-US')} row{rows.length === 1 ? '' : 's'} · {formatMs(res.elapsedMs)}</span>
              <span className="flex-1" />
              {cursor.current && <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void run(true)}>More rows</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
