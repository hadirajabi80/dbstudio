// Documents of an index (plan-batch3 WP-ES): Lucene query box, sortable grid (columns = flattened _source) or JSON cards,
// paging, and a record panel with the document tree, edit (Monaco JSON, optimistic concurrency with if_seq_no /
// if_primary_term: a stale edit shows a conflict with "Reload" / "Overwrite"), clone, new and delete.
import { displayShortcut } from '../../commands/keys';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, CopyPlus, LayoutList, Pencil, Plus, Table2, TextSearch, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { EsField, EsHit, EsSearchResponse } from '../../api/types.es';
import { DEFAULT_GRID_QUERY, flattenSource, gridBody, gridColumns, sortFieldFor, type GridQuery } from '../../es/docs';
import { formatMs } from '../../es/format';
import { parseLenient, pretty } from '../../es/json';
import { toast } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { CodeEditor } from './CodeEditor';
import { CellValue, JsonTree } from './JsonTree';
import { patchTab } from './open';
import { Banner, esErrorText, isVersionConflict, readOnlyReason } from './parts';
import { indicesChanged, loadFields } from './store';

interface EditState {
  mode: 'edit' | 'new' | 'clone';
  hit: EsHit | null;
  text: string;
  id: string;
  conflict: boolean;
  error: string | null;
  busy: boolean;
}

const PAGE_SIZES = [25, 50, 100, 200];

export function DocumentsPanel({ cid, index, theme, visible, tabId, initialQ, initialSize }: {
  cid: string; index: string; theme: EffectiveTheme; visible: boolean; tabId: string; initialQ: string; initialSize: number;
}) {
  const [q, setQ] = useState(initialQ);
  const [grid, setGrid] = useState<GridQuery>({ ...DEFAULT_GRID_QUERY, q: initialQ, size: PAGE_SIZES.includes(initialSize) ? initialSize : 50 });
  const [res, setRes] = useState<EsSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<'table' | 'json'>('table');
  const [fields, setFields] = useState<EsField[]>([]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const seq = useRef(0);
  const ro = readOnlyReason(cid);

  useEffect(() => {
    void loadFields(cid, index).then(setFields);
  }, [cid, index]);

  const run = useCallback(async (g: GridQuery): Promise<EsSearchResponse | null> => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.es.search(cid, { index, body: gridBody(g), from: g.from, size: g.size, trackTotalHits: true });
      if (my !== seq.current) return null;
      setRes(r);
      setError(null);
      setSelected((s) => Math.min(s, Math.max(0, r.hits.length - 1)));
      return r;
    } catch (e) {
      if (my !== seq.current) return null;
      setError(esErrorText(e));
      setRes(null);
      return null;
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [cid, index]);

  useEffect(() => {
    void run(grid);
  }, [grid, run]);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ cid: string; index: string }>).detail;
      if (d.cid === cid && d.index === index) void run(grid);
    };
    window.addEventListener('dbstudio:es-index-changed', on);
    return () => window.removeEventListener('dbstudio:es-index-changed', on);
  }, [cid, index, grid, run]);

  const apply = (patch: Partial<GridQuery>) => setGrid((g) => ({ ...g, ...patch }));
  const submitQuery = () => {
    apply({ q, from: 0 });
    patchTab(tabId, { q });
  };
  const hits = useMemo(() => res?.hits ?? [], [res]);
  const cols = useMemo(() => gridColumns(hits), [hits]);
  const total = res?.total ?? 0;
  const hit = hits[selected] ?? null;
  const maxFrom = Math.min(total, 10_000);

  const sortBy = (col: string) => {
    const f = col === '_id' ? null : sortFieldFor(col, fields);
    if (!f) return toast('info', `${col} is not sortable`, 'Text fields need a keyword sub-field to sort.');
    apply({ sortField: f, sortDir: grid.sortField === f && grid.sortDir === 'asc' ? 'desc' : 'asc', from: 0 });
  };

  // ---- editing

  const startEdit = (m: EditState['mode'], h: EsHit | null) => {
    const src = h ? h.source : {};
    setEdit({ mode: m, hit: h, text: pretty(src ?? {}), id: m === 'edit' && h ? h.id : '', conflict: false, error: null, busy: false });
  };

  const save = async (force = false) => {
    if (!edit) return;
    const parsed = parseLenient(edit.text);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      setEdit({ ...edit, error: parsed.ok ? 'The document must be a JSON object.' : `Invalid JSON: ${parsed.error}` });
      return;
    }
    setEdit({ ...edit, busy: true, error: null });
    try {
      let id: string;
      if (edit.mode === 'edit' && edit.hit) {
        const h = edit.hit;
        const r = await api.es.putDoc(cid, h.index, h.id, {
          source: parsed.value, routing: h.routing, ...(force ? {} : { ifSeqNo: h.seqNo, ifPrimaryTerm: h.primaryTerm }),
        });
        id = r.id;
        toast('success', `Saved ${h.id}`, r.result === 'noop' ? 'No change' : `version ${r.version ?? '?'} · seq_no ${r.seqNo ?? '?'}`);
      } else if (edit.id.trim()) {
        const r = await api.es.putDoc(cid, index, edit.id.trim(), { source: parsed.value, create: true });
        id = r.id;
        toast('success', `Created ${r.id}`);
      } else {
        const r = await api.es.createDoc(cid, index, { source: parsed.value });
        id = r.id;
        toast('success', `Created ${r.id}`);
      }
      setEdit(null);
      if (edit.mode !== 'edit') indicesChanged(cid);
      const fresh = await run(grid);
      const at = fresh?.hits.findIndex((x) => x.id === id) ?? -1;
      if (at >= 0) setSelected(at);
    } catch (e) {
      if (isVersionConflict(e) && edit.mode === 'edit') setEdit({ ...edit, busy: false, conflict: true, error: null });
      else setEdit({ ...edit, busy: false, error: esErrorText(e) });
    }
  };

  const reloadLatest = async () => {
    if (!edit?.hit) return;
    try {
      const d = await api.es.doc(cid, edit.hit.index, edit.hit.id, edit.hit.routing);
      if (!d.found) {
        setEdit({ ...edit, conflict: false, error: 'The document was deleted meanwhile.' });
        return;
      }
      const fresh: EsHit = { ...edit.hit, seqNo: d.seqNo, primaryTerm: d.primaryTerm, version: d.version, source: d.source };
      setEdit({ ...edit, hit: fresh, text: pretty(d.source), conflict: false, error: null });
    } catch (e) {
      setEdit({ ...edit, error: esErrorText(e) });
    }
  };

  const remove = async (h: EsHit) => {
    const { ConfirmDialog } = await import('./dialogs');
    const { showEsDialog } = await import('./dialogHost');
    const { createElement } = await import('react');
    showEsDialog((close) => createElement(ConfirmDialog, {
      title: 'Delete document', action: 'Delete', danger: true, onClose: close,
      message: `Delete the document ${h.id} from ${h.index}? This cannot be undone.`,
      onConfirm: async () => {
        const r = await api.es.deleteDoc(cid, h.index, h.id, { ifSeqNo: h.seqNo, ifPrimaryTerm: h.primaryTerm, routing: h.routing });
        toast('success', r.result === 'not_found' ? `${h.id} was already gone` : `Deleted ${h.id}`);
        indicesChanged(cid);
        await run(grid);
      },
    }));
  };

  const copy = (h: EsHit) => {
    void navigator.clipboard?.writeText(pretty(h.source)).then(() => toast('success', 'Copied the document JSON'), () => undefined);
  };

  void visible;
  return (
    <div className="es-docs">
      <div className="es-toolbar">
        <form className="es-query-box" onSubmit={(e) => { e.preventDefault(); submitQuery(); }}>
          <TextSearch size={14} aria-hidden className="muted" />
          <input className="input mono" placeholder='Lucene query: status:paid AND total:>100   (empty = all documents)' aria-label="Query string" value={q}
            onChange={(e) => setQ(e.target.value)} data-primary-focus />
          <button type="submit" className="btn btn-xs btn-primary">Apply</button>
        </form>
        <div className="es-seg" role="group" aria-label="View">
          <button type="button" className={mode === 'table' ? 'on' : undefined} onClick={() => setMode('table')} title="Table"><Table2 size={13} aria-hidden /> Table</button>
          <button type="button" className={mode === 'json' ? 'on' : undefined} onClick={() => setMode('json')} title="JSON"><LayoutList size={13} aria-hidden /> JSON</button>
        </div>
        <button type="button" className="btn btn-xs" disabled={!!ro} title={ro ?? 'New document'} onClick={() => startEdit('new', null)}><Plus size={13} aria-hidden /> Document</button>
      </div>
      {error && <Banner actions={<button type="button" className="btn btn-xs" onClick={() => void run(grid)}>Retry</button>}>{error}</Banner>}
      <div className="es-docs-body">
        <div className="es-docs-main">
          {mode === 'table' ? (
            <div className="es-grid-scroll">
              <table className="es-grid" role="grid" aria-label="Documents" aria-rowcount={total}>
                <thead>
                  <tr>
                    <th className="es-grid-n">#</th>
                    <th>_id</th>
                    {cols.map((c) => {
                      const f = sortFieldFor(c, fields);
                      const active = f && grid.sortField === f;
                      return (
                        <th key={c} title={c} aria-sort={active ? (grid.sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                          <button type="button" className="es-th-btn" onClick={() => sortBy(c)} dir="auto">
                            {c}{active && (grid.sortDir === 'asc' ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />)}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {hits.map((h, i) => {
                    const flat = flattenSource(h.source);
                    return (
                      <tr key={`${h.index}/${h.id}`} className={i === selected ? 'selected' : undefined} aria-selected={i === selected} onClick={() => setSelected(i)}
                        onDoubleClick={() => !ro && startEdit('edit', h)} data-doc-id={h.id}>
                        <td className="es-grid-n">{grid.from + i + 1}</td>
                        <td className="mono es-grid-id" title={h.index !== index ? `${h.index}/${h.id}` : h.id}>{h.id}</td>
                        {cols.map((c) => <td key={c}><CellValue v={flat[c]} /></td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {res && !hits.length && <div className="es-empty">No documents{grid.q ? ' match the query' : ''}.</div>}
              {!res && loading && <div className="es-empty">Loading documents…</div>}
            </div>
          ) : (
            <div className="es-cards">
              {hits.map((h, i) => (
                <div key={`${h.index}/${h.id}`} className={`es-card${i === selected ? ' selected' : ''}`} onClick={() => setSelected(i)} role="article" aria-label={`Document ${h.id}`}>
                  <div className="es-card-head"><span className="mono">{h.id}</span>{h.index !== index && <span className="es-chip es-chip-muted">{h.index}</span>}</div>
                  <JsonTree value={h.source} openDepth={1} label={`Document ${h.id}`} />
                </div>
              ))}
              {res && !hits.length && <div className="es-empty">No documents.</div>}
            </div>
          )}
          <div className="es-pager">
            <span className="muted">
              {res ? (total ? `${(grid.from + 1).toLocaleString('en-US')}–${(grid.from + hits.length).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}${res.totalRelation === 'gte' ? '+' : ''}` : '0 documents') : ''}
              {res && ` · ${formatMs(res.took)}`}
              {grid.sortField && ` · sorted by ${grid.sortField} ${grid.sortDir}`}
            </span>
            <span className="flex-1" />
            <label className="es-inline">
              <span className="muted">Rows</span>
              <select className="input input-sm" aria-label="Page size" value={grid.size} onChange={(e) => { apply({ size: Number(e.target.value), from: 0 }); patchTab(tabId, { size: Number(e.target.value) }); }}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="icon-btn xs" aria-label="Previous page" disabled={grid.from === 0 || loading} onClick={() => apply({ from: Math.max(0, grid.from - grid.size) })}><ChevronLeft size={14} /></button>
            <button type="button" className="icon-btn xs" aria-label="Next page" disabled={grid.from + grid.size >= maxFrom || loading} onClick={() => apply({ from: grid.from + grid.size })}
              title={grid.from + grid.size >= 10_000 ? 'Paging stops at 10,000 hits (index.max_result_window); use Search or Export for more.' : undefined}><ChevronRight size={14} /></button>
          </div>
        </div>
        <aside className="es-record" aria-label="Document">
          {edit ? (
            <div className="es-record-edit">
              <div className="es-record-head">
                <strong>{edit.mode === 'edit' ? `Edit ${edit.hit?.id}` : edit.mode === 'clone' ? 'New document (copy)' : 'New document'}</strong>
                <span className="flex-1" />
                <button type="button" className="icon-btn xs" aria-label="Close editor" onClick={() => setEdit(null)}><X size={14} /></button>
              </div>
              {edit.mode !== 'edit' && (
                <label className="es-inline es-record-id">
                  <span className="muted">_id</span>
                  <input className="input input-sm mono" placeholder="generated" aria-label="Document id" value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
                </label>
              )}
              {edit.mode === 'edit' && edit.hit && (
                <div className="es-record-meta muted">seq_no {edit.hit.seqNo ?? '—'} · primary_term {edit.hit.primaryTerm ?? '—'} · version {edit.hit.version ?? '—'}</div>
              )}
              {edit.conflict && (
                <Banner tone="warn" actions={<>
                  <button type="button" className="btn btn-xs" onClick={() => void reloadLatest()}>Reload latest</button>
                  <button type="button" className="btn btn-xs btn-danger" onClick={() => void save(true)}>Overwrite</button>
                </>}>
                  Someone changed this document after you opened it (its seq_no moved on). Reload the latest version or overwrite it with yours.
                </Banner>
              )}
              {edit.error && <Banner>{edit.error}</Banner>}
              <CodeEditor value={edit.text} onChange={(text) => setEdit((x) => (x ? { ...x, text } : x))} language="json" ariaLabel="Document JSON" theme={theme}
                onRun={() => void save()} className="es-record-editor" autoFocus />
              <div className="es-record-actions">
                <span className="muted es-hint">{displayShortcut('Mod+Enter')} saves</span>
                <span className="flex-1" />
                <button type="button" className="btn btn-xs" onClick={() => setEdit(null)}>Cancel</button>
                <button type="button" className="btn btn-xs btn-primary" disabled={edit.busy} onClick={() => void save()}>{edit.busy ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          ) : hit ? (
            <>
              <div className="es-record-head">
                <span className="mono es-record-title" title={hit.id}>{hit.id}</span>
                <span className="flex-1" />
                <button type="button" className="icon-btn xs" aria-label="Edit document" title={ro ?? 'Edit'} disabled={!!ro} onClick={() => startEdit('edit', hit)}><Pencil size={13} /></button>
                <button type="button" className="icon-btn xs" aria-label="Clone document" title={ro ?? 'Clone'} disabled={!!ro} onClick={() => startEdit('clone', hit)}><CopyPlus size={13} /></button>
                <button type="button" className="icon-btn xs" aria-label="Copy document JSON" title="Copy JSON" onClick={() => copy(hit)}><Copy size={13} /></button>
                <button type="button" className="icon-btn xs danger" aria-label="Delete document" title={ro ?? 'Delete'} disabled={!!ro} onClick={() => void remove(hit)}><Trash2 size={13} /></button>
              </div>
              <dl className="es-record-meta">
                <dt>_index</dt><dd className="mono">{hit.index}</dd>
                <dt>_seq_no</dt><dd className="mono">{hit.seqNo ?? '—'}</dd>
                <dt>_primary_term</dt><dd className="mono">{hit.primaryTerm ?? '—'}</dd>
                {hit.version != null && <><dt>_version</dt><dd className="mono">{hit.version}</dd></>}
                {hit.routing && <><dt>_routing</dt><dd className="mono">{hit.routing}</dd></>}
              </dl>
              <div className="es-record-tree"><JsonTree value={hit.source} openDepth={2} label="Document source" /></div>
            </>
          ) : <div className="es-empty">Select a document</div>}
        </aside>
      </div>
    </div>
  );
}
