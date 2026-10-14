// Table data tab (PLAN-M1.5 A1): `SELECT * FROM t` + server filter + ORDER BY, paged with OFFSET/FETCH or
// LIMIT/OFFSET, lazy COUNT(*), in-place editing with the pending-changes preview, record view and FK navigation.
import {
  CircleX, Funnel, LoaderCircle, Lock, PencilLine, Plus, Redo2, RefreshCw, RotateCcw, Rows3, Search, Table2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { CellValue, ColumnInfo } from '../../api/types';
import { catalogDatabase } from '../../app/actions';
import { countSql, describeSql, distinctSql, selectPageSql, type SortSpec, type TableTarget } from '../../data/sqlgen';
import { buildPredicate, inlineParams } from '../../filter/sql';
import { appendAnd, columnSignature, countConditions, normalizeNode, type FilterGroup, type GridViewModel, type SortKey } from '../../filter/model';
import { ChunkedList } from '../../lib/chunked';
import { formatCount, formatDuration } from '../../lib/format';
import { useCatalog, useSnapshot } from '../../store/catalog';
import { useConnection, useDialect } from '../../store/connections';
import { hasPending, pendingCount, useEditBuffer, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { Splitter } from '../common/Splitter';
import { DistinctValuesPopover } from '../FilterBar/DistinctValues';
import { FilterBar } from '../FilterBar/FilterBar';
import { DataGrid, rowValue, type GridSelectionInfo, type RowRef } from '../Grid/DataGrid';
import { findTable, foreignKeys, referencingTables, tableEditability, type FkLink } from '../Grid/editability';
import { overlayRows } from '../Grid/overlay';
import { gridController } from '../Grid/controller';
import '../Grid/grid.css';
import { PendingChangesDialog } from '../PendingChanges/PendingChanges';
import type { EditContext } from '../PendingChanges/submit';
import { RecordView } from '../RecordView/RecordView';
import { countTabId, dataGridKey, openDataTab, type DataTabState } from './open';
import { getSqlRunner } from './runner';
import './datatab.css';

const DEFAULT_PAGE = 1000;

interface Loaded {
  columns: ColumnInfo[] | null;
  rows: ChunkedList<CellValue[]>;
  rev: number;
  hasMore: boolean;
  pageable: boolean;
  loading: boolean;
  error: string | null;
  elapsedMs: number | null;
  /** Server-side predicate in effect (for count and paging). */
  where: string | null;
  sql: string | null;
}

const EMPTY: Loaded = { columns: null, rows: new ChunkedList(), rev: 0, hasMore: false, pageable: true, loading: true, error: null, elapsedMs: null, where: null, sql: null };

export function DataTabView({ tab, theme, visible }: TabViewProps) {
  const state = (tab.state ?? {}) as DataTabState;
  const connectionId = tab.connectionId ?? '';
  const database = tab.database;
  const conn = useConnection(connectionId);
  const dialect = useDialect(connectionId);
  const catDb = useCatalog(() => catalogDatabase(connectionId, database));
  const snapshot = useSnapshot(connectionId, catDb);
  const { nullText, dateFormat } = useSettings((s) => s.settings.results);
  const pageSize = useSettings((s) => s.settings.grid?.pageSize) || DEFAULT_PAGE;
  const gridKey = dataGridKey(tab.id);
  const buffer = useEditBuffer(gridKey);
  const viewerWidth = useUi((s) => s.cellViewerWidth);
  const setLayout = useUi((s) => s.setLayout);

  const [data, setData] = useState<Loaded>(EMPTY);
  const [filter, setFilter] = useState<FilterGroup | null>(() => (state.filter ? (normalizeNode(state.filter) as FilterGroup) : null));
  const [quick, setQuick] = useState(state.quick ?? '');
  const [sort, setSort] = useState<SortKey[]>([]);
  const [barOpen, setBarOpen] = useState(true);
  const [focusReq, setFocusReq] = useState<{ column: string | null; nonce: number } | null>(null);
  const [count, setCount] = useState<{ value: number | null; loading: boolean; error: string | null }>({ value: null, loading: false, error: null });
  const [sel, setSel] = useState<GridSelectionInfo | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [dragStart, setDragStart] = useState(viewerWidth);
  const [showPending, setShowPending] = useState(false);
  const [distinct, setDistinct] = useState<{ col: number; x: number; y: number } | null>(null);
  const loadSeq = useRef(0);
  /** One statement at a time on the tab's session (page loads, distinct values). */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.current.then(fn, fn);
    chain.current = next.catch(() => undefined);
    return next;
  };
  const lastNonce = useRef(state.nonce);
  const session = useSessions((s) => s.sessions[s.byTab[tab.id]]);

  const found = useMemo(() => findTable(snapshot, state.schema, state.name), [snapshot, state.schema, state.name]);
  const isView = state.type === 'view' || found?.obj.t === 'view';
  const columns = data.columns ?? [];
  const keyColumns = useMemo(() => {
    if (found?.obj.pk?.length) return found.obj.pk;
    return columns.filter((c) => c.isKey).map((c) => c.name);
  }, [found, columns]);
  const target: TableTarget = useMemo(
    () => ({ schema: found?.schema ?? state.schema, name: found?.obj.n ?? state.name, keyColumns, defaultSchema: snapshot?.defaultSchema ?? null }),
    [found, state.schema, state.name, keyColumns, snapshot?.defaultSchema],
  );
  const editability = useMemo(
    () => (data.columns ? tableEditability(data.columns, state.schema, state.name, snapshot, conn, isView) : null),
    [data.columns, state.schema, state.name, snapshot, conn, isView],
  );
  const fks = useMemo<FkLink[]>(() => (data.columns ? foreignKeys(data.columns, target.schema, target.name, snapshot) : []), [data.columns, target, snapshot]);
  const refs = useMemo(() => referencingTables(target.schema, target.name, snapshot), [target, snapshot]);
  const overlay = useMemo(() => overlayRows(data.rows, buffer.committed), [data.rows, data.rev, buffer.committed]); // eslint-disable-line react-hooks/exhaustive-deps

  // External filter requests (FK navigation into an open tab).
  useEffect(() => {
    if (state.nonce !== lastNonce.current) {
      lastNonce.current = state.nonce;
      setFilter(state.filter ? (normalizeNode(state.filter) as FilterGroup) : null);
      setBarOpen(true);
    }
  }, [state.nonce, state.filter]);

  const ensureSession = useCallback(
    () => useSessions.getState().ensure(tab.id, connectionId, database, 'auto'),
    [tab.id, connectionId, database],
  );

  const predicate = useMemo(
    () => (data.columns ? buildPredicate(filter, data.columns, dialect, { alias: null, quick }) : null),
    [data.columns, filter, quick, dialect],
  );
  const sortSpec = useMemo<SortSpec[]>(() => sort.map((s) => ({ column: columns[s.column]?.name ?? '', dir: s.dir })).filter((s) => s.column), [sort, columns]);
  const predSig = predicate ? `${predicate.where ?? ''}|${JSON.stringify(predicate.params)}` : '';
  const sortSig = JSON.stringify(sortSpec);

  const runCount = useCallback(async (where: string | null, params: Parameters<ReturnType<typeof getSqlRunner>>[2]) => {
    const cid = countTabId(tab.id);
    setCount({ value: null, loading: true, error: null });
    try {
      const s = await useSessions.getState().ensure(cid, connectionId, database, 'auto');
      if (s.state === 'executing') await api.cancel(s.sessionId).catch(() => undefined);
      const res = await getSqlRunner()(s.sessionId, countSql(target, dialect, where), params, { label: 'data', maxRows: 1, source: { tabId: tab.id, title: `Count ${target.name}` } });
      if (res.status === 'cancelled') return setCount({ value: null, loading: false, error: null });
      const v = res.resultSets[0]?.rows[0]?.[0];
      setCount({ value: v === null || v === undefined ? null : Number(v), loading: false, error: res.error?.message ?? null });
    } catch (e) {
      setCount({ value: null, loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [tab.id, connectionId, database, target, dialect]);

  const cancelCount = useCallback(async () => {
    const s = useSessions.getState().forTab(countTabId(tab.id));
    if (s) await api.cancel(s.sessionId).catch(() => undefined);
    setCount((c) => ({ ...c, loading: false }));
  }, [tab.id]);

  /** Load a page. offset 0 replaces rows (and recounts); otherwise appends. */
  const load = useCallback((offset: number) => exclusive(() => loadNowRef.current(offset)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const loadNow = async (offset: number) => {
    const seq = ++loadSeq.current;
    setData((d) => ({ ...d, loading: true, error: null }));
    const run = getSqlRunner();
    try {
      const s = await ensureSession();
      let cols = data.columns;
      if (!cols) {
        const probe = await run(s.sessionId, describeSql(target, dialect), [], { label: 'data', maxRows: 1, source: { tabId: tab.id, title: tab.title } });
        if (probe.error || !probe.resultSets[0]) throw new Error(probe.error?.message ?? 'Could not read the columns');
        cols = probe.resultSets[0].columns;
      }
      const pred = buildPredicate(filter, cols, dialect, { alias: null, quick });
      const keys = found?.obj.pk?.length ? found.obj.pk : cols.filter((c) => c.isKey).map((c) => c.name);
      const t = { ...target, keyColumns: keys };
      const spec = sort.map((k) => ({ column: cols![k.column]?.name ?? '', dir: k.dir })).filter((k) => k.column);
      const page = selectPageSql(t, dialect, { where: pred.where, sort: spec, offset, limit: pageSize, serverVersion: s.serverInfo.productVersion });
      const res = await run(s.sessionId, page.sql, pred.params, { label: 'data', maxRows: pageSize, source: { tabId: tab.id, title: tab.title } });
      if (seq !== loadSeq.current) return;
      if (res.error || res.status !== 'ok') {
        setData((d) => ({ ...d, columns: cols, loading: false, error: res.error?.message ?? `Query ${res.status}` }));
        return;
      }
      const set = res.resultSets[0];
      const fetched = set?.rows ?? [];
      setData((d) => {
        const rows = offset === 0 ? new ChunkedList<CellValue[]>() : d.rows;
        rows.pushAll(fetched);
        return {
          columns: set?.columns ?? cols, rows, rev: d.rev + 1, hasMore: page.pageable && fetched.length >= pageSize, pageable: page.pageable,
          loading: false, error: null, elapsedMs: res.elapsedMs, where: pred.where, sql: inlineParams(page.sql, pred.params, dialect),
        };
      });
      if (offset === 0) {
        if (fetched.length < pageSize) setCount({ value: fetched.length, loading: false, error: null });
        else void runCount(pred.where, pred.params);
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setData((d) => ({ ...d, loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };
  // Latest closure for queued loads (filter/sort may change while one is waiting).
  const loadNowRef = useRef(loadNow);
  loadNowRef.current = loadNow;

  // (Re)load when the server-side query changes (debounced for typing in the filter bar).
  const loadedSig = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    const sig = [connectionId, predSig, sortSig].join("");
    if (sig === loadedSig.current) return; // StrictMode re-run / unrelated render
    if (loadedSig.current === null) {
      loadedSig.current = sig;
      void load(0);
      return;
    }
    const t = setTimeout(() => {
      loadedSig.current = sig;
      useEdits.getState().reset(gridKey);
      void load(0);
    }, 350);
    return () => clearTimeout(t);
  }, [predSig, sortSig, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (data.loading || !data.hasMore) return;
    const b = useEdits.getState().get(gridKey);
    if (b.committed.appended.length || Object.keys(b.committed.hidden).length) {
      // Rows inserted/deleted since the first page shift positions: start over to keep pages consistent.
      if (hasPending(b)) return;
      useEdits.getState().reset(gridKey);
      void load(0);
      return;
    }
    void load(data.rows.length);
  }, [data.loading, data.hasMore, data.rows.length, gridKey, load]);

  const refresh = useCallback(async () => {
    if (hasPending(useEdits.getState().get(gridKey))) {
      const ok = await useUi.getState().askConfirm({
        title: 'Discard pending changes?', message: 'Reloading the data discards the changes that are not submitted yet.', confirmLabel: 'Discard and reload', danger: true,
      });
      if (!ok) return;
    }
    useEdits.getState().reset(gridKey);
    void load(0);
  }, [gridKey, load]);

  // Guard filter/sort changes while edits are pending.
  const guarded = async (fn: () => void) => {
    if (hasPending(useEdits.getState().get(gridKey))) {
      const ok = await useUi.getState().askConfirm({
        title: 'Discard pending changes?', message: 'Changing the filter or sort reloads the rows and discards the changes that are not submitted yet.',
        confirmLabel: 'Discard changes', danger: true,
      });
      if (!ok) return;
    }
    fn();
  };

  // Release sessions and buffers with the tab.
  useEffect(() => () => {
    useEdits.getState().reset(gridKey);
  }, [gridKey]);

  const view: GridViewModel = useMemo(() => ({ quickFilter: quick, filter, sort: [] }), [quick, filter]);
  const n = countConditions(filter);
  const pending = pendingCount(buffer.pending);
  const signature = useMemo(() => columnSignature(columns), [columns]);
  const editCtx: EditContext | null = editability?.editable && editability.target ? {
    gridKey, tabId: tab.id, connectionId, database: session?.database ?? database, dialect, target: editability.target, columns,
    rowAt: (i) => overlay.get(i), sourceLength: overlay.length, sqliteVersion: session?.serverInfo.productVersion ?? null, tabTitle: tab.title, exclusive,
  } : null;

  const navigateFk = (fk: FkLink, values: CellValue[]) =>
    openDataTab({ connectionId, database, schema: fk.refSchema, name: fk.refTable, filter: fk.refColumns.map((c, i) => ({ column: c, value: values[i] ?? null })) });

  const selRef: RowRef | null = sel ? (sel.sourceRow !== null ? { src: sel.sourceRow } : (() => {
    const ins = buffer.pending.inserts.find((i) => i.id === sel.insertId);
    return ins ? { ins } : null;
  })()) : null;
  const recordValues = selRef ? columns.map((_, c) => rowValue(overlay, buffer.pending.updates, selRef, c)) : null;
  const delta = buffer.committed.appended.length - Object.keys(buffer.committed.hidden).length;
  const total = count.value !== null ? count.value + delta : null;
  const loaded = overlay.length - Object.keys(buffer.committed.hidden).length;
  const title = `${target.schema && target.schema !== (snapshot?.defaultSchema ?? 'main') ? `${target.schema}.` : ''}${target.name}`;

  useEffect(() => {
    if (tab.title !== title) useTabs.getState().updateView(tab.id, { title });
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connectionId) {
    return <div className="dt" style={{ display: visible ? undefined : 'none' }}><div className="results-empty">This data tab has no connection.</div></div>;
  }

  return (
    <div className="dt" style={{ display: visible ? undefined : 'none' }} data-command-scope="dataTab">
      <div className="dt-toolbar">
        <Table2 size={15} className="dt-icon" />
        <span className="dt-title" title={title}>{title}</span>
        <span className="dt-conn muted">{conn?.name}</span>
        <button className="icon-btn sm" title="Reload (F5)" aria-label="Reload" onClick={() => void refresh()} disabled={data.loading}>
          <RefreshCw size={14} className={data.loading ? 'spin' : undefined} />
        </button>
        <div className="rs-quick">
          <Search size={13} />
          <input
            className="input xs borderless"
            placeholder="Search text columns"
            aria-label="Search text columns"
            value={quick}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value;
              void guarded(() => setQuick(v));
            }}
            onKeyDown={(e) => e.key === 'Escape' && setQuick('')}
          />
          {quick && <button className="icon-btn xs" aria-label="Clear search" onClick={() => setQuick('')}><X size={12} /></button>}
        </div>
        <button className={`btn btn-xs${barOpen || n ? ' on' : ''}`} onClick={() => setBarOpen(!barOpen)} aria-pressed={barOpen} title="Filter (Ctrl+F)">
          <Funnel size={12} /> Filter{n ? ` (${n})` : ''}
        </button>
        {sort.length > 0 && (
          <button className="btn btn-xs" onClick={() => void guarded(() => setSort([]))} title="Clear sorting">
            Sorted by {sort.map((s) => `${columns[s.column]?.name} ${s.dir}`).join(', ')} <X size={11} />
          </button>
        )}
        <div className="flex-1" />
        {editability && (editability.editable ? (
          <span className="rs-badge editable" title={`Key: ${editability.target?.keyColumns.join(', ')}`}><PencilLine size={11} /> Editable</span>
        ) : (
          <span className="rs-badge" title={editability.reason ?? undefined}><Lock size={11} /> {editability.reason}</span>
        ))}
        {editability?.editable && (
          <span className="rs-pending">
            <button className="icon-btn sm" title="Insert row (Insert)" aria-label="Insert row" onClick={() => { const g = gridController(gridKey); if (g?.insertRow) g.insertRow(); else useEdits.getState().addInsert(gridKey, columns.length); }}><Plus size={14} /></button>
            <button className="icon-btn sm" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!buffer.undo.length} onClick={() => useEdits.getState().undo(gridKey)}><Undo2 size={14} /></button>
            <button className="icon-btn sm" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!buffer.redo.length} onClick={() => useEdits.getState().redo(gridKey)}><Redo2 size={14} /></button>
            {pending > 0 && (
              <>
                <button className="btn btn-xs" onClick={() => useEdits.getState().revertAll(gridKey)}><RotateCcw size={12} /> Revert</button>
                <button className="btn btn-xs btn-primary" onClick={() => setShowPending(true)} title="Preview and submit (Ctrl+S)">Submit ({pending})</button>
              </>
            )}
          </span>
        )}
        <span className="rs-sep" />
        <button className={`icon-btn sm${recordOpen ? ' on' : ''}`} title="Record view (F7)" aria-label="Record view" aria-pressed={recordOpen} onClick={() => setRecordOpen(!recordOpen)}>
          <Rows3 size={14} />
        </button>
      </div>
      {barOpen && data.columns && (
        <FilterBar
          columns={columns}
          filter={filter}
          quick={quick}
          onChange={(f) => void guarded(() => setFilter(f))}
          onQuickChange={(q) => setQuick(q)}
          onClose={() => setBarOpen(false)}
          dialect={dialect}
          focusRequest={focusReq}
          saved={{ connectionId, signature }}
          serverAlways
          server={{ available: true, active: true, busy: data.loading, onApply: () => void load(0) }}
          status={predicate?.where ? `Server · ${total !== null ? formatCount(total) : '…'} row${total === 1 ? '' : 's'}` : null}
        />
      )}
      {data.error && (
        <div className="rs-error" role="alert">
          <CircleX size={14} />
          <div className="flex-1">{data.error}</div>
          <button className="btn btn-xs" onClick={() => void load(0)}>Retry</button>
        </div>
      )}
      <div className="resultset-body">
        <div className="resultset-grid">
          {data.columns ? (
            <>
              <DataGrid
                gridKey={gridKey}
                columns={columns}
                rows={data.rows}
                rev={data.rev}
                done={!data.loading}
                view={view}
                serverFiltered
                extraFilter={predicate?.clientOnly ?? null}
                onViewChange={(v) => {
                  if (v.filter !== undefined) void guarded(() => setFilter(v.filter ?? null));
                  if (v.quickFilter !== undefined) setQuick(v.quickFilter);
                }}
                serverSort={{ sort, onSortChange: (s) => void guarded(() => setSort(s)) }}
                editability={editability}
                fks={fks}
                onNavigateFk={navigateFk}
                dialect={dialect}
                theme={theme}
                nullText={nullText}
                dateFormat={dateFormat}
                onSelectCell={setSel}
                onOpenViewer={(s) => {
                  setSel(s);
                  setRecordOpen(true);
                }}
                onOpenFilter={(column) => {
                  setBarOpen(true);
                  setFocusReq({ column: column ?? null, nonce: Date.now() });
                }}
                onReachEnd={loadMore}
                onSubmit={() => editCtx && setShowPending(true)}
                onToggleRecord={() => setRecordOpen((o) => !o)}
                onShowDistinct={(col, pos) => setDistinct({ col, x: pos.clientX, y: pos.clientY })}
                controllerExtras={{ refresh: () => void refresh(), loadMore }}
              />
              {!data.loading && loaded === 0 && (
                <div className="rs-empty-filter">
                  <Funnel size={20} />
                  <div>{n || quick ? 'No rows match' : 'The table is empty'}</div>
                  {(n > 0 || quick) && <button className="btn btn-xs" onClick={() => void guarded(() => { setFilter(null); setQuick(''); })}>Clear filter</button>}
                </div>
              )}
            </>
          ) : (
            <div className="results-empty">
              {data.loading ? <><LoaderCircle size={18} className="spin" /> Loading {title}…</> : 'No data'}
            </div>
          )}
        </div>
        {recordOpen && (
          <>
            <Splitter direction="vertical" onDragStart={() => setDragStart(viewerWidth)} onDrag={(d) => setLayout({ cellViewerWidth: Math.max(220, Math.min(900, dragStart - d)) })} />
            <div className="resultset-viewer" style={{ width: viewerWidth }}>
              <RecordView
                columns={columns}
                values={recordValues}
                edited={selRef?.src !== undefined ? new Set(Object.keys(buffer.pending.updates[selRef.src] ?? {}).map(Number)) : undefined}
                editableColumns={editability?.editable ? editability.editableColumns : null}
                rowLabel={sel ? (sel.sourceRow !== null ? `Row ${sel.row + 1}` : 'New row') : 'Record'}
                nullText={nullText}
                dialect={dialect}
                fks={fks}
                referencing={refs}
                onSet={editability?.editable && selRef ? (col, value) => {
                  if (selRef.ins) useEdits.getState().setInsertCell(gridKey, selRef.ins.id, col, value);
                  else useEdits.getState().setCell(gridKey, selRef.src, col, value, overlay.get(selRef.src)?.[col] ?? null);
                } : undefined}
                onNavigateFk={navigateFk}
                onOpenReferencing={(r, vals) => openDataTab({ connectionId, database, schema: r.schema, name: r.table, filter: r.columns.map((c, i) => ({ column: c, value: vals[i] ?? null })) })}
                onClose={() => setRecordOpen(false)}
              />
            </div>
          </>
        )}
      </div>
      <div className="resultset-status">
        <span>
          {formatCount(loaded)} {total !== null && total !== loaded ? `of ${formatCount(total)} ` : ''}row{loaded === 1 ? '' : 's'}
        </span>
        {count.loading && (
          <span className="muted">
            <LoaderCircle size={11} className="spin" /> counting…
            <button className="link-btn" onClick={() => void cancelCount()} title="Cancel the count">cancel</button>
          </span>
        )}
        {count.error && <span className="rs-limit-note" title={count.error}><TriangleAlert size={12} /> count failed</span>}
        {data.hasMore && (
          <button className="link-btn" onClick={loadMore} disabled={data.loading} title="Fetch the next page (Ctrl+End)">
            {data.loading ? <LoaderCircle size={11} className="spin" /> : null} Load {formatCount(pageSize)} more
          </button>
        )}
        {!data.pageable && <span className="rs-limit-note"><TriangleAlert size={12} /> This server version cannot page: first {formatCount(pageSize)} rows only</span>}
        {data.elapsedMs !== null && <span className="muted">{formatDuration(data.elapsedMs)}</span>}
        {pending > 0 && <span className="muted">{pending} pending change{pending === 1 ? '' : 's'}</span>}
        <div className="flex-1" />
        {data.sql && <span className="muted mono dt-sql" title={data.sql}>{data.sql.replace(/\s+/g, ' ')}</span>}
      </div>
      {showPending && editCtx && <PendingChangesDialog ctx={editCtx} onClose={() => setShowPending(false)} />}
      {distinct && columns[distinct.col] && (
        <DistinctValuesPopover
          column={columns[distinct.col]}
          ordinal={distinct.col}
          at={{ x: distinct.x, y: distinct.y }}
          nullText={nullText}
          load={async () => {
            const s = await ensureSession();
            const res = await getSqlRunner()(s.sessionId, distinctSql(target, dialect, columns[distinct.col].name, predicate?.where ?? null), predicate?.params ?? [], { label: 'data', maxRows: 501 });
            if (res.error) throw new Error(res.error.message);
            const rows = res.resultSets[0]?.rows ?? [];
            return { items: rows.slice(0, 500).map((r) => ({ value: r[0] ?? null, count: Number(r[1] ?? 0) })), more: rows.length > 500 };
          }}
          onApply={(node) => {
            void guarded(() => setFilter(appendAnd(filter, node)));
            setBarOpen(true);
          }}
          onClose={() => setDistinct(null)}
        />
      )}
    </div>
  );
}
