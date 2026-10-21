// Documents view (docs/PLAN-M2.md 6.3): query bar, count badge (exact or estimated), pagination, List / JSON / Table
// views that share one selection, Insert / Edit / Clone / Delete, Import / Export, Explain and a Watch toggle that
// counts change-stream events ("+3 changes, click to refresh").
import { displayShortcut } from '../../commands/keys';
import {
  Braces, ChevronLeft, Code, ChevronRight, Copy, CopyPlus, Download, Import, LayoutList, Pencil, Plus, Radio, RefreshCw, Table2, Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { api } from '../../api/client';
import type { MongoFieldPath } from '../../api/types';
import { runCommand } from '../../commands/registry';
import { getField, hasTrunc, parseEjsonDoc, toEjsonText, toShell, type BsonDoc } from '../../mongo/bson';
import { toast } from '../../store/ui';
import type { SubViewProps } from './CollectionView';
import { DocTree } from './BsonView';
import { DocumentEditor, type EditorMode } from './DocumentEditor';
import { DocumentTable } from './DocumentTable';
import { JsonPage } from './JsonPage';
import { showMongoDialog } from './dialogHost';
import type { ExportInput } from './exportCode';
import { DEFAULT_QUERY, type DocView, type QueryState } from './open';
import { parseShellDoc } from '../../mongo/shellJson';
import { QueryBar } from './QueryBar';
import { cachedFields, loadFields, setCollectionCount } from './store';
import { useChangeStream } from './useChangeStream';
import { errorText, plural } from './util';

interface Result {
  docs: BsonDoc[];
  count: number;
  exact: boolean;
  ms: number;
}

const histories = new Map<string, QueryState[]>();

function remember(key: string, q: QueryState) {
  if (!q.filter.trim() && !q.sort.trim() && !q.projection.trim()) return;
  const list = (histories.get(key) ?? []).filter((x) => JSON.stringify(x) !== JSON.stringify(q));
  histories.set(key, [q, ...list].slice(0, 10));
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast('success', 'Copied to the clipboard'), () => undefined);
}

export function DocumentsView({ tabId, cid, db, coll, state, patch, theme, visible, readOnly, isView, statsChanged }: SubViewProps) {
  const applied = useMemo(() => ({ ...DEFAULT_QUERY, ...state.query }), [state.query]);
  const [draft, setDraft] = useState<QueryState>(applied);
  const view: DocView = state.view ?? 'list';
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const [selected, setSelected] = useState<number>(0);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [fields, setFields] = useState<readonly MongoFieldPath[]>(() => cachedFields(cid, db, coll));
  const [watchOn, setWatchOn] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const watch = useChangeStream(cid, db, coll, watchOn);
  const histKey = `${cid}:${db}.${coll}`;
  const canWrite = !readOnly && !isView;
  const writeReason = readOnly ? 'The connection is read-only' : isView ? 'Views are read-only' : undefined;

  useEffect(() => {
    void loadFields(cid, db, coll).then(setFields);
  }, [cid, db, coll]);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    api.mongo.find(cid, db, coll, {
      filter: applied.filter, projection: applied.projection || null, sort: applied.sort || null, collation: applied.collation || null,
      skip: applied.skip, limit: applied.limit, maxTimeMs: applied.maxTimeMs,
    }, ctl.signal).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setResult({ docs: r.docs.map(parseEjsonDoc), count: r.count.value, exact: r.count.exact, ms: Math.round(performance.now() - t0) });
        setSelected(0);
        setLoading(false);
        if (!applied.filter.trim() && r.count.exact) setCollectionCount(cid, db, coll, r.count.value);
      },
      (e) => {
        if (ctl.signal.aborted) return;
        setError(errorText(e));
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [cid, db, coll, applied, seq]);

  const run = useCallback((q: QueryState) => {
    remember(histKey, q);
    if (JSON.stringify(q) === JSON.stringify(applied)) setSeq((n) => n + 1);
    else patch({ query: q });
    watch.clear();
  }, [applied, patch, histKey, watch]);

  const refresh = useCallback(() => {
    setSeq((n) => n + 1);
    watch.clear();
  }, [watch]);

  const page = (dir: 1 | -1) => {
    const skip = Math.max(0, applied.skip + dir * applied.limit);
    const q = { ...applied, skip };
    setDraft((d) => ({ ...d, skip }));
    patch({ query: q });
  };

  const openEditor = useCallback(async (mode: EditorMode, index?: number) => {
    let doc: BsonDoc | null = null;
    if (index !== undefined && result) {
      doc = result.docs[index];
      if (hasTrunc(doc) || (applied.projection.trim() && mode !== 'clone')) {
        try {
          const full = await api.mongo.doc(cid, db, coll, toShell(getField(doc, '_id')!));
          if (full.doc) doc = parseEjsonDoc(full.doc);
        } catch (e) {
          toast('error', 'Could not load the full document', errorText(e));
          return;
        }
      }
    }
    showMongoDialog((close) => (
      <DocumentEditor mode={mode} cid={cid} db={db} coll={coll} doc={doc} fields={fields} theme={theme} onClose={close}
        onSaved={(n) => {
          toast('success', mode === 'edit' ? 'Document replaced' : `${plural(n, 'document')} inserted`);
          refresh();
          statsChanged();
        }} />
    ));
  }, [result, cid, db, coll, fields, theme, refresh, statsChanged, applied.projection]);

  const deleteDoc = async (index: number) => {
    const doc = result?.docs[index];
    const id = doc && getField(doc, '_id');
    if (!id) return;
    try {
      const r = await api.mongo.deleteDocs(cid, db, coll, { ids: [toShell(id)] });
      toast('success', r.deleted ? 'Document deleted' : 'The document was already gone');
      setConfirmDelete(null);
      refresh();
      statsChanged();
    } catch (e) {
      toast('error', 'Delete failed', errorText(e));
    }
  };

  // palette / shortcut actions
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ tabId: string; action: string }>).detail;
      if (d.tabId !== tabId || state.sub !== 'documents') return;
      if (d.action === 'find') run(draft);
      else if (d.action === 'refresh') refresh();
      else if (d.action === 'insert' && canWrite) void openEditor('insert');
      else if (d.action === 'watch') setWatchOn((w) => !w);
      else if (d.action === 'exportCode') exportQueryCode();
    };
    window.addEventListener('dbstudio:mongo', on);
    return () => window.removeEventListener('dbstudio:mongo', on);
  }, [tabId, state.sub, run, draft, refresh, canWrite, openEditor]);

  function exportQueryCode() {
    let input: ExportInput;
    try {
      input = { kind: 'find', db, coll, filter: parseShellDoc(draft.filter), projection: parseShellDoc(draft.projection), sort: parseShellDoc(draft.sort), collation: parseShellDoc(draft.collation), skip: draft.skip, limit: draft.limit };
    } catch (e) {
      toast('error', 'Fix the query first', errorText(e));
      return;
    }
    void import('./ExportCodeDialog').then(({ ExportCodeDialog }) => showMongoDialog((close) => <ExportCodeDialog input={input} theme={theme} onClose={close} />));
  }

  const explain = () => patch({ sub: 'explain', explainOf: 'find', query: draft, runSeq: (state.runSeq ?? 0) + 1 });

  const docs = result?.docs ?? [];
  const from = docs.length ? applied.skip + 1 : 0;
  const to = applied.skip + docs.length;
  const total = result?.count ?? 0;

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!docs.length || (e.target as HTMLElement).closest('textarea, input, .monaco-editor')) return;
    if (e.key === 'ArrowDown') setSelected((s) => Math.min(docs.length - 1, s + 1));
    else if (e.key === 'ArrowUp') setSelected((s) => Math.max(0, s - 1));
    else if (e.key === 'Enter' && canWrite) void openEditor('edit', selected);
    else if (e.key === 'Delete' && canWrite) setConfirmDelete(selected);
    else return;
    e.preventDefault();
  };

  useEffect(() => {
    if (!visible) return;
    document.querySelector<HTMLElement>(`[data-tab-host="${tabId}"] [data-doc-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, visible, tabId]);

  return (
    <div className="mg-docs">
      <QueryBar draft={draft} applied={applied} onDraft={setDraft} onFind={run} onReset={() => { setDraft(DEFAULT_QUERY); run(DEFAULT_QUERY); }}
        onExplain={explain} fields={fields} theme={theme} busy={loading} history={histories.get(histKey)} />
      <div className="mg-toolbar" role="toolbar" aria-label="Documents">
        <button className="btn btn-xs btn-primary" disabled={!canWrite} title={writeReason ?? `Insert a document (${displayShortcut('Mod+Shift+I')})`} onClick={() => void openEditor('insert')}>
          <Plus size={14} aria-hidden /> Insert
        </button>
        <button className="btn btn-xs" disabled={!canWrite} title={writeReason ?? 'Import JSON or CSV'} onClick={() => runCommand('mongo.import', { kind: 'source', connectionId: cid, providerId: 'mongodb', nodeType: 'collection', path: [db, coll] })}>
          <Import size={14} aria-hidden /> Import
        </button>
        <button className="btn btn-xs" title="Export the query result to JSON or CSV" onClick={() => runCommand('mongo.export', { kind: 'source', connectionId: cid, providerId: 'mongodb', nodeType: 'collection', path: [db, coll] })}>
          <Download size={14} aria-hidden /> Export
        </button>
        <button className="btn btn-xs" title="Export the query to mongosh, Node.js, C#, Python or Java" onClick={exportQueryCode}>
          <Code size={14} aria-hidden /> Code
        </button>
        <span className="tb-sep" />
        <div className="segmented mg-viewseg" role="radiogroup" aria-label="View">
          {([['list', LayoutList, 'List'], ['json', Braces, 'JSON'], ['table', Table2, 'Table']] as const).map(([v, Icon, label]) => (
            <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => patch({ view: v })} title={`${label} view`}>
              <Icon size={14} aria-hidden /> {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button className={`btn btn-xs ${watchOn ? 'on' : ''}`} aria-pressed={watchOn} onClick={() => setWatchOn(!watchOn)}
          title={watch.status === 'error' ? watch.error ?? 'Change stream failed' : 'Watch inserts, updates and deletes (change stream)'}>
          <Radio size={14} aria-hidden className={watch.status === 'live' ? 'mg-live' : undefined} /> {watchOn ? (watch.status === 'live' ? 'Watching' : watch.status === 'opening' ? 'Opening…' : watch.status === 'error' ? 'Watch failed' : 'Watch ended') : 'Watch'}
        </button>
        {watchOn && watch.pending > 0 && (
          <span className="mg-changes">
            <button className="mg-changes-badge" onClick={refresh} title="Refresh to see them">+{plural(watch.pending, 'change')}, click to refresh</button>
            <button className="icon-btn xs" aria-label="Show recent changes" aria-expanded={showChanges} onClick={() => setShowChanges(!showChanges)}><ChevronRight size={14} className={showChanges ? 'mg-rot90' : undefined} /></button>
            {showChanges && (
              <ul className="mg-changes-list" aria-label="Recent changes">
                {watch.recent.slice(0, 12).map((c, i) => (
                  <li key={i}><span className={`mg-op mg-op-${c.operationType}`}>{c.operationType}</span> <code>{c.documentKey ? toShell(getField(parseEjsonDoc(c.documentKey), '_id') ?? { t: 'null' }) : ''}</code> <span className="muted">{new Date(c.ts).toLocaleTimeString()}</span></li>
                ))}
              </ul>
            )}
          </span>
        )}
        <span className="mg-count" aria-live="polite">
          {result && (
            <>
              {from.toLocaleString()}–{to.toLocaleString()} of{' '}
              <span className={result.exact ? 'mg-count-n' : 'mg-count-n estimated'} title={result.exact ? 'Exact count' : 'Estimated: counting timed out, the number comes from collection metadata'}>
                {result.exact ? '' : '~'}{total.toLocaleString()}
              </span>
              {!result.exact && <span className="pill pill-warning">estimated</span>}
              {applied.filter.trim() && <span className="muted"> (filtered)</span>}
            </>
          )}
        </span>
        <button className="icon-btn sm" aria-label="Previous page" disabled={applied.skip === 0 || loading} onClick={() => page(-1)}><ChevronLeft size={16} /></button>
        <button className="icon-btn sm" aria-label="Next page" disabled={!result || to >= total || loading} onClick={() => page(1)}><ChevronRight size={16} /></button>
        <button className="icon-btn sm" aria-label="Refresh" title="Refresh" onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : undefined} /></button>
      </div>
      <div className="mg-docs-body" tabIndex={-1} onKeyDown={onListKey}>
        {error && <div className="mg-error" role="alert"><strong>Query failed.</strong> {error}</div>}
        {!error && result && !docs.length && (
          <div className="mg-empty">
            <p>{applied.filter.trim() ? 'No documents match this filter.' : 'This collection has no documents.'}</p>
            {canWrite && !applied.filter.trim() && <button className="btn" onClick={() => void openEditor('insert')}><Plus size={14} aria-hidden /> Insert a document</button>}
          </div>
        )}
        {!error && docs.length > 0 && view === 'list' && (
          <ul className="mg-cards" aria-label="Documents">
            {docs.map((d, i) => {
              const id = getField(d, '_id');
              return (
                <li key={id ? toShell(id) : i} className={`mg-card ${i === selected ? 'selected' : ''}`} data-doc-index={i} tabIndex={i === selected ? 0 : -1}
                  aria-selected={i === selected} onClick={() => setSelected(i)} onDoubleClick={() => canWrite && void openEditor('edit', i)}>
                  <DocTree doc={d} />
                  <div className="mg-card-actions" role="group" aria-label="Document actions">
                    <button className="icon-btn xs" title={writeReason ?? 'Edit document (Enter)'} aria-label="Edit document" disabled={!canWrite} onClick={() => void openEditor('edit', i)}><Pencil size={14} /></button>
                    <button className="icon-btn xs" title="Copy document (EJSON)" aria-label="Copy document" onClick={() => copy(toEjsonText(d, 'relaxed'))}><Copy size={14} /></button>
                    <button className="icon-btn xs" title={writeReason ?? 'Clone document'} aria-label="Clone document" disabled={!canWrite} onClick={() => void openEditor('clone', i)}><CopyPlus size={14} /></button>
                    <button className="icon-btn xs danger" title={writeReason ?? 'Delete document (Delete)'} aria-label="Delete document" disabled={!canWrite} onClick={() => setConfirmDelete(i)}><Trash2 size={14} /></button>
                  </div>
                  {confirmDelete === i && (
                    <div className="mg-card-confirm" role="alertdialog" aria-label="Delete document">
                      <span>Delete this document? This cannot be undone.</span>
                      <button className="btn btn-xs" autoFocus onClick={() => setConfirmDelete(null)}>Cancel</button>
                      <button className="btn btn-xs btn-danger" onClick={() => void deleteDoc(i)}>Delete</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!error && docs.length > 0 && view === 'json' && (
          <JsonPage docs={docs} cid={cid} db={db} coll={coll} theme={theme} canWrite={canWrite} writeReason={writeReason}
            onSaved={() => { refresh(); statsChanged(); }} />
        )}
        {!error && docs.length > 0 && view === 'table' && (
          <DocumentTable docs={docs} selected={selected} onSelect={setSelected} canWrite={canWrite}
            onEdit={(i) => void openEditor('edit', i)} onClone={(i) => void openEditor('clone', i)} onDelete={(i) => setConfirmDelete(i)} />
        )}
        {view === 'table' && confirmDelete !== null && (
          <div className="mg-card-confirm mg-table-confirm" role="alertdialog" aria-label="Delete document">
            <span>Delete document {confirmDelete + 1 + applied.skip}? This cannot be undone.</span>
            <button className="btn btn-xs" autoFocus onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn btn-xs btn-danger" onClick={() => void deleteDoc(confirmDelete)}>Delete</button>
          </div>
        )}
        {loading && !result && <div className="mg-loading">Loading documents…</div>}
      </div>
      {result && <div className="mg-foot muted">{plural(docs.length, 'document')} · {result.ms} ms</div>}
    </div>
  );
}
