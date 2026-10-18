// Table data tab (PLAN-M1.5 A1): `SELECT * FROM t` + server filter + ORDER BY, paged with OFFSET/FETCH or
// LIMIT/OFFSET, lazy COUNT(*), in-place editing with the pending-changes preview, record view and FK navigation.
//
// One session per tab: the describe probe, every page, the COUNT, distinct values and submits run one at a time
// through `exclusive`. The session is released after a few idle minutes (auto mode, nothing pending) and
// re-created on the next load.
import {
  ChevronDown, CircleX, Code2, Download, Funnel, LoaderCircle, Lock, PencilLine, PencilRuler, Plus, Redo2, RefreshCw, Rows3,
  Search, Table2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isApiError } from '../../api/client';
import type { CellValue, ColumnInfo } from '../../api/types';
import { catalogDatabase, idleSessionTabs, offerCloseIdle } from '../../app/actions';
import { runCommand } from '../../commands/registry';
import { commandView, useCommandContext } from '../../commands/useCommands';
import { countSql, describeSql, distinctSql, keylessOrder, selectPageSql, uniqueOrderKey, type SortSpec, type TableTarget } from '../../data/sqlgen';
import { buildPredicate, inlineParams, type PredicateResult } from '../../filter/sql';
import { appendAnd, columnSignature, normalizeNode, type FilterGroup, type GridViewModel, type SortKey } from '../../filter/model';
import { countActiveConditions } from '../../filter/values';
import type { ExecParam } from '../../filter/wire';
import { ChunkedList } from '../../lib/chunked';
import { formatCount, formatDuration } from '../../lib/format';
import type { CellLocator } from '../../lib/serialize';
import { useCatalog, useSnapshot } from '../../store/catalog';
import { useConnection, useDialect } from '../../store/connections';
import { hasPending, pendingCount, useEditBuffer, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import type { TabViewProps } from '../layout/tabViews';
import { commandMenuItems } from '../layout/commandMenu';
import { showMenuBelow } from '../common/Menu';
import { Splitter } from '../common/Splitter';
import { DistinctValuesPopover } from '../FilterBar/DistinctValues';
import { FilterBar, type FilterBarCloseReason } from '../FilterBar/FilterBar';
import type { SelectionAggregates } from '../Grid/aggregate';
import { AggregateStrip } from '../Grid/AggregateStrip';
import { DataGrid, rowValue, type GridSelectionInfo, type RowRef } from '../Grid/DataGrid';
import { findTable, foreignKeys, referencingTables, tableEditability, type FkLink } from '../Grid/editability';
import { overlayRows } from '../Grid/overlay';
import { focusGrid, gridController } from '../Grid/controller';
import '../Grid/grid.css';
import { PendingBar } from '../PendingChanges/PendingBar';
import { usePendingChanges } from '../PendingChanges/usePendingChanges';
import type { EditContext } from '../PendingChanges/submit';
import { RecordView } from '../RecordView/RecordView';
import { GRID_EXPORT_MENU } from '../ResultsPane/toolbarModel';
import { consumeGridFocus, dataGridKey, hasPendingGridFocus, openDataTab, type DataTabState, type SortByName } from './open';
import { getSqlRunner } from './runner';
import './datatab.css';

const DEFAULT_PAGE = 1000;
/** Release the tab's session after this long without a statement (auto mode, no pending edits). */
export const DATA_TAB_IDLE_MS = 5 * 60_000;
const PERSIST_MS = 500;

interface Loaded {
  columns: ColumnInfo[] | null;
  rows: ChunkedList<CellValue[]>;
  rev: number;
  hasMore: boolean;
  pageable: boolean;
  loading: boolean;
  error: string | null;
  /** Engine error code of the last failure (SESSION_LIMIT offers to release idle sessions). */
  errorCode: string | null;
  elapsedMs: number | null;
  /** Server-side predicate in effect (for count and paging). */
  where: string | null;
  sql: string | null;
  /** Keyless object paged without ORDER BY (large or not counted yet): later pages may repeat or skip rows. */
  unordered: boolean;
}

const EMPTY: Loaded = {
  columns: null, rows: new ChunkedList(), rev: 0, hasMore: false, pageable: true, loading: true, error: null, errorCode: null, elapsedMs: null, where: null, sql: null, unordered: false,
};

/** Re-reading the loaded rows in key order (keyless paging switching to ORDER BY) is done up to this many rows. */
const REORDER_MAX_ROWS = 20_000;

/** Rows of one page and the execution that holds their full values. */
interface PageRef {
  executionId: string | null;
  start: number;
  count: number;
}

const sameOrder = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

const specFor = (sort: readonly SortByName[], cols: readonly ColumnInfo[]): SortSpec[] =>
  sort.filter((s) => cols.some((c) => c.name === s.column)).map((s) => ({ column: s.column, dir: s.dir }));

/** Identity of the server query (predicate + binds + order): a change reloads page 0. */
const querySig = (connectionId: string, pred: PredicateResult, spec: SortSpec[]) =>
  `${connectionId}\u0001${pred.where ?? ''}\u0001${JSON.stringify(pred.params)}\u0001${JSON.stringify(spec)}`;

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
  useCommandContext();

  const [data, setData] = useState<Loaded>(EMPTY);
  const [filter, setFilter] = useState<FilterGroup | null>(() => (state.filter ? (normalizeNode(state.filter) as FilterGroup) : null));
  const [quick, setQuick] = useState(state.quick ?? '');
  const [sortNames, setSortNames] = useState<SortByName[]>(() => (Array.isArray(state.sort) ? state.sort : []));
  const [barOpen, setBarOpen] = useState(true);
  const [focusReq, setFocusReq] = useState<{ column: string | null; nonce: number } | null>(null);
  const [count, setCount] = useState<{ value: number | null; loading: boolean; error: string | null }>({ value: null, loading: false, error: null });
  const [sel, setSel] = useState<GridSelectionInfo | null>(null);
  const [agg, setAgg] = useState<SelectionAggregates | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [dragStart, setDragStart] = useState(viewerWidth);
  const [distinct, setDistinct] = useState<{ col: number; x: number; y: number } | null>(null);
  const loadSeq = useRef(0);
  /** Source of truth for the loaded rows (appended outside React updaters, so StrictMode cannot duplicate pages). */
  const rowsRef = useRef(new ChunkedList<CellValue[]>());
  const colsRef = useRef<ColumnInfo[] | null>(null);
  const hasMoreRef = useRef(false);
  const pagesRef = useRef<PageRef[]>([]);
  /** A "next page" load is already queued (two quick clicks load one page, not the same offset twice). */
  const moreQueued = useRef(false);
  const countRunning = useRef(false);
  /** One statement at a time on the tab's session (probe, pages, COUNT, distinct values, submit). */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const busy = useRef(0);
  const lastUse = useRef(Date.now());
  const exclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = async () => {
      busy.current++;
      try {
        return await fn();
      } finally {
        busy.current--;
        lastUse.current = Date.now();
      }
    };
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => undefined);
    return next;
  }, []);
  const lastNonce = useRef(state.nonce);
  const session = useSessions((s) => s.sessions[s.byTab[tab.id]]);

  const found = useMemo(() => findTable(snapshot, state.schema, state.name), [snapshot, state.schema, state.name]);
  const isView = state.type === 'view' || found?.obj.t === 'view';
  const columns = useMemo(() => data.columns ?? [], [data.columns]);
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

  // Persist filter / search / sort with the workspace (restored after a restart), debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      const t0 = useTabs.getState().tabs.find((x) => x.id === tab.id);
      if (t0?.kind !== 'view') return;
      const cur = (t0.state ?? {}) as DataTabState;
      const same = JSON.stringify([cur.filter ?? null, cur.quick ?? '', cur.sort ?? []]) === JSON.stringify([filter, quick, sortNames]);
      if (!same) useTabs.getState().updateView(tab.id, { state: { ...cur, filter, quick, sort: sortNames } });
    }, PERSIST_MS);
    return () => clearTimeout(t);
  }, [filter, quick, sortNames, tab.id]);

  const ensureSession = useCallback(
    () => useSessions.getState().ensure(tab.id, connectionId, database, 'auto'),
    [tab.id, connectionId, database],
  );

  const predicate = useMemo(
    () => (data.columns ? buildPredicate(filter, data.columns, dialect, { alias: null, quick }) : null),
    [data.columns, filter, quick, dialect],
  );
  const sortKeys = useMemo<SortKey[]>(
    () => sortNames.map((s) => ({ column: columns.findIndex((c) => c.name === s.column), dir: s.dir })).filter((k) => k.column >= 0),
    [sortNames, columns],
  );
  // Null until the columns are known: the first load computes the same signature itself (no double page 0 / COUNT).
  const sigNow = data.columns && predicate ? querySig(connectionId, predicate, specFor(sortNames, data.columns)) : null;
  const loadedSig = useRef<string | null>(null);
  /** COUNT(*) of a query signature (decides whether a keyless object may be sorted for paging). */
  const knownCount = useRef<{ sig: string; value: number } | null>(null);
  /** Unique index/constraint of a table without a primary key (undefined = not looked up yet). */
  const uniqueKey = useRef<string[] | null | undefined>(undefined);
  /** ORDER BY fallback the loaded rows were read with (keyless objects; null = no ORDER BY). */
  const loadedFallback = useRef<string[] | null>(null);

  /** COUNT(*) on the tab's own session, queued behind the page that asked for it. */
  const runCountNow = async (where: string | null, params: ExecParam[], seq: number, t: TableTarget) => {
    if (seq !== loadSeq.current) return; // a newer load replaced the rows
    setCount({ value: null, loading: true, error: null });
    countRunning.current = true;
    try {
      const s = await ensureSession();
      const res = await getSqlRunner()(s.sessionId, countSql(t, dialect, where), params, {
        label: 'data', maxRows: 1, source: { tabId: tab.id, title: tab.title }, skipHistory: true,
      });
      if (seq !== loadSeq.current) return;
      if (res.status === 'cancelled') return setCount({ value: null, loading: false, error: null });
      const v = res.resultSets[0]?.rows[0]?.[0];
      const value = v === null || v === undefined ? null : Number(v);
      if (value !== null && Number.isFinite(value) && loadedSig.current) knownCount.current = { sig: loadedSig.current, value };
      setCount({ value, loading: false, error: res.error?.message ?? null });
    } catch (e) {
      if (seq === loadSeq.current) setCount({ value: null, loading: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      countRunning.current = false;
    }
  };

  const cancelCount = useCallback(async () => {
    const s = useSessions.getState().forTab(tab.id);
    if (s && countRunning.current) await api.cancel(s.sessionId).catch(() => undefined);
    setCount((c) => ({ ...c, loading: false }));
  }, [tab.id]);

  /** Load page 0 (replaces rows and recounts) or the next page. */
  const load = useCallback((req: 0 | 'next') => {
    if (req === 'next') {
      if (moreQueued.current) return Promise.resolve();
      moreQueued.current = true;
    } else if (countRunning.current) {
      // The running COUNT belongs to the old query: stop it so the new page does not wait behind it.
      const s = useSessions.getState().forTab(tab.id);
      if (s) void api.cancel(s.sessionId).catch(() => undefined);
    }
    return exclusive(async () => {
      if (req === 'next') moreQueued.current = false;
      await loadNowRef.current(req);
    });
  }, [exclusive, tab.id]);

  /** Columns of a unique index or constraint of a table without a primary key (looked up once, from the engine). */
  const uniqueKeyFor = async (cols: ColumnInfo[]): Promise<string[] | null> => {
    if (isView) return null;
    if (uniqueKey.current === undefined) {
      try {
        const d = await api.objectDetails(connectionId, database, { database, schema: target.schema, name: target.name, type: 'table' });
        uniqueKey.current = uniqueOrderKey(d.indexes, cols);
      } catch {
        uniqueKey.current = null;
      }
    }
    return uniqueKey.current;
  };

  const loadNow = async (req: 0 | 'next') => {
    if (req === 'next' && !hasMoreRef.current) return;
    let offset = req === 'next' ? rowsRef.current.length : 0;
    let limit = pageSize;
    const seq = ++loadSeq.current;
    setData((d) => ({ ...d, loading: true, error: null, errorCode: null }));
    const run = getSqlRunner();
    const source = { tabId: tab.id, title: tab.title };
    try {
      const s = await ensureSession();
      let cols = colsRef.current;
      if (!cols) {
        const probe = await run(s.sessionId, describeSql(target, dialect), [], { label: 'data', maxRows: 1, source, skipHistory: true });
        if (probe.error || !probe.resultSets[0]) throw Object.assign(new Error(probe.error?.message ?? 'Could not read the columns'), { code: probe.error?.code ?? null });
        cols = probe.resultSets[0].columns;
      }
      const pred = buildPredicate(filter, cols, dialect, { alias: null, quick });
      const spec = specFor(sortNames, cols);
      const sig = querySig(connectionId, pred, spec);
      loadedSig.current = sig;
      // Paging order (features-r1-04): the primary key, else a unique index/constraint (tables), else a fallback that
      // is only worth its full sort while the object is known to be small; above that, pages are read unordered.
      let keys = found?.obj.pk?.length ? found.obj.pk : cols.filter((c) => c.isKey).map((c) => c.name);
      if (!keys.length) keys = (await uniqueKeyFor(cols)) ?? [];
      let fallback: string[] | null = null;
      if (!keys.length) {
        const rowCount = knownCount.current?.sig === sig ? knownCount.current.value : null;
        fallback = keylessOrder(dialect, cols, isView, rowCount);
        if (req === 'next' && !sameOrder(fallback, loadedFallback.current)) {
          // The loaded rows were read in another order: re-read them in the new one, or keep the old order.
          if (fallback && offset + pageSize <= REORDER_MAX_ROWS) {
            limit = offset + pageSize;
            offset = 0;
          } else fallback = loadedFallback.current;
        }
      }
      const replace = offset === 0;
      const t: TableTarget = { ...target, keyColumns: keys, ...(fallback ? { orderFallback: fallback } : {}) };
      const page = selectPageSql(t, dialect, { where: pred.where, sort: spec, offset, limit, serverVersion: s.serverInfo.productVersion });
      // One history entry per (re)load of the table; later pages are internal.
      const res = await run(s.sessionId, page.sql, pred.params, { label: 'data', maxRows: limit, source, ...(req === 'next' ? { skipHistory: true } : {}) });
      if (seq !== loadSeq.current) return;
      if (res.error || res.status !== 'ok') {
        colsRef.current = cols;
        setData((d) => ({ ...d, columns: cols, loading: false, error: res.error?.message ?? `Query ${res.status}`, errorCode: res.error?.code ?? null }));
        return;
      }
      const set = res.resultSets[0];
      const fetched = set?.rows ?? [];
      // Rows are built here, never inside the setData updater (React may call an updater twice).
      if (replace) {
        rowsRef.current = ChunkedList.from(fetched);
        pagesRef.current = [];
      } else rowsRef.current.pushAll(fetched);
      pagesRef.current.push({ executionId: res.executionId, start: offset, count: fetched.length });
      colsRef.current = set?.columns ?? cols;
      hasMoreRef.current = page.pageable && fetched.length >= limit;
      loadedFallback.current = fallback;
      const unordered = !keys.length && !fallback && (hasMoreRef.current || offset > 0);
      const next: Omit<Loaded, 'rev'> = {
        columns: colsRef.current, rows: rowsRef.current, hasMore: hasMoreRef.current, pageable: page.pageable, loading: false, error: null, errorCode: null,
        elapsedMs: res.elapsedMs, where: pred.where, sql: inlineParams(page.sql, pred.params, dialect), unordered,
      };
      setData((d) => ({ ...next, rev: d.rev + 1 }));
      if (req === 0) {
        if (fetched.length < limit) {
          knownCount.current = { sig, value: fetched.length };
          setCount({ value: fetched.length, loading: false, error: null });
        } else void exclusive(() => runCountNow(pred.where, pred.params, seq, t));
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const code = isApiError(e) ? e.code : ((e as { code?: string | null }).code ?? null);
      if (code === 'SESSION_LIMIT') offerCloseIdle(connectionId, () => void load(0));
      setData((d) => ({ ...d, loading: false, error: e instanceof Error ? e.message : String(e), errorCode: code }));
    }
  };
  // Latest closure for queued loads (filter/sort may change while one is waiting).
  const loadNowRef = useRef(loadNow);
  loadNowRef.current = loadNow;

  // First load once; afterwards reload when the server-side query changes (debounced for typing in the filter bar).
  const started = useRef(false);
  useEffect(() => {
    if (!connectionId) return;
    if (!started.current) {
      started.current = true; // refs survive StrictMode's effect re-run: page 0 and COUNT run once
      void load(0);
      return;
    }
    if (sigNow === null || sigNow === loadedSig.current) return;
    const t = setTimeout(() => {
      useEdits.getState().reset(gridKey);
      void load(0);
    }, 350);
    return () => clearTimeout(t);
  }, [sigNow, connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release the session when idle (auto mode, nothing pending); the next load opens a new one.
  useEffect(() => {
    const t = setInterval(() => {
      if (busy.current > 0 || Date.now() - lastUse.current < DATA_TAB_IDLE_MS) return;
      const s = useSessions.getState().forTab(tab.id);
      if (!s || s.txMode !== 'auto' || s.txOpen || s.state === 'executing') return;
      if (hasPending(useEdits.getState().get(gridKey))) return;
      void useSessions.getState().close(tab.id).catch(() => undefined);
    }, Math.min(60_000, DATA_TAB_IDLE_MS));
    return () => clearInterval(t);
  }, [tab.id, gridKey]);

  const loadMore = useCallback(() => {
    if (!hasMoreRef.current) return;
    const b = useEdits.getState().get(gridKey);
    if (b.committed.appended.length || Object.keys(b.committed.hidden).length) {
      // Rows inserted/deleted since the first page shift positions: start over to keep pages consistent.
      if (hasPending(b)) return;
      useEdits.getState().reset(gridKey);
      void load(0);
      return;
    }
    void load('next');
  }, [gridKey, load]);

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

  /**
   * Would this filter / search / sort reload the rows? Only complete, enabled conditions reach the server (an empty
   * draft condition or a switched-off one does not), so the server query signature is the normalised applied filter.
   */
  const wouldReload = (f: FilterGroup | null, q: string, sort: readonly SortByName[]): boolean => {
    const cols = data.columns;
    if (!cols) return true;
    const pred = buildPredicate(f, cols, dialect, { alias: null, quick: q });
    return querySig(connectionId, pred, specFor(sort, cols)) !== (loadedSig.current ?? sigNow);
  };
  /** Edits that do not change the query (drafts, disabled conditions, client-only parts) never ask (design-r1-02). */
  const changeFilter = (f: FilterGroup | null) => {
    if (wouldReload(f, quick, sortNames)) void guarded(() => setFilter(f));
    else setFilter(f);
  };
  const changeSort = (next: SortByName[]) => {
    if (wouldReload(filter, quick, next)) void guarded(() => setSortNames(next));
    else setSortNames(next);
  };
  const changeQuick = (q: string) => {
    if (wouldReload(filter, q, sortNames)) void guarded(() => setQuick(q));
    else setQuick(q);
  };

  /** The filter bar closed from Esc or its ✕ (focus was inside it): give focus back to the grid (design-r1-01). */
  const closeBar = (reason?: FilterBarCloseReason) => {
    setBarOpen(false);
    if (reason === 'escape' || reason === 'button') focusGrid(gridKey);
  };

  // Release buffers with the tab (the session is closed by the tab view's onClosed).
  useEffect(() => () => {
    useEdits.getState().reset(gridKey);
  }, [gridKey]);

  /** Engine cell of a source row (full values of truncated cells): the page it came from. */
  const cellSource = useCallback((sourceRow: number, col: number): CellLocator | null => {
    const pg = pagesRef.current.find((x) => sourceRow >= x.start && sourceRow < x.start + x.count);
    return pg?.executionId ? { executionId: pg.executionId, resultSetId: 0, row: sourceRow - pg.start, col } : null;
  }, []);

  /** Export the loaded rows as the grid shows them (client-only filters, committed edits); full values are fetched. */
  const exportAs = async (format: 'csv' | 'json' | 'sql-insert') => {
    const g = gridController(gridKey);
    if (!g?.exportVisible) return;
    await g.exportVisible(format, {
      baseName: target.name,
      note: hasMoreRef.current ? `Only the ${formatCount(rowsRef.current.length)} loaded rows were exported; load more rows to include the rest.` : null,
    });
  };

  const view: GridViewModel = useMemo(() => ({ quickFilter: quick, filter, sort: [] }), [quick, filter]);
  const n = countActiveConditions(filter, columns);
  const pending = pendingCount(buffer.pending);
  const signature = useMemo(() => columnSignature(columns), [columns]);
  const editCtx: EditContext | null = editability?.editable && editability.target ? {
    gridKey, tabId: tab.id, connectionId, database: session?.database ?? database, dialect, target: editability.target, columns,
    rowAt: (i) => overlay.get(i), sourceLength: overlay.length, sqliteVersion: session?.serverInfo.productVersion ?? null, tabTitle: tab.title, exclusive,
  } : null;
  // Ctrl+S / Save write the pending edits directly; the SQL preview is opt-in (user-02).
  const pendingActions = usePendingChanges(editCtx);

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
  const noMatch = !data.loading && loaded === 0 && (n > 0 || !!quick);

  // Opened from a command before the first page arrived: focus the grid once it is rendered (design-15).
  const gridShown = !!data.columns && visible;
  useEffect(() => {
    if (!gridShown || !hasPendingGridFocus(tab.id)) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (consumeGridFocus(tab.id) || !hasPendingGridFocus(tab.id) || ++tries > 20) return;
      t = setTimeout(attempt, 50);
    };
    attempt();
    return () => clearTimeout(t);
  }, [gridShown, data.rev, tab.id]);

  useEffect(() => {
    if (tab.title !== title) useTabs.getState().updateView(tab.id, { title });
  }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connectionId) {
    return <div className="dt" style={{ display: visible ? undefined : 'none' }}><div className="results-empty">This data tab has no connection.</div></div>;
  }

  const gridArgs = { gridKey };
  const tabArgs = { tabId: tab.id };
  const cv = (id: string, args: unknown = gridArgs) => commandView(id, args);
  const reloadCmd = cv('dataTab.reload', tabArgs);
  const codeCmd = cv('dataTab.codegen', tabArgs);
  const designCmd = cv('dataTab.design', tabArgs);
  const filterTip = cv('grid.filter').tooltip;
  const idle = data.errorCode === 'SESSION_LIMIT' ? idleSessionTabs(connectionId).filter((t) => t !== tab.id) : [];

  return (
    <div className="dt" style={{ display: visible ? undefined : 'none' }} data-command-scope="dataTab">
      <div className="dt-toolbar">
        <Table2 size={15} className="dt-icon" />
        <span className="dt-title" title={title}>{title}</span>
        <span className="dt-conn muted">{conn?.name}</span>
        <button className="icon-btn sm" title={reloadCmd.tooltip} aria-label="Reload" onClick={() => void refresh()} disabled={data.loading}>
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
            onChange={(e) => changeQuick(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && quick && changeQuick('')}
          />
          {quick && <button className="icon-btn xs" aria-label="Clear search" onClick={() => changeQuick('')}><X size={12} /></button>}
        </div>
        <button className={`btn btn-xs${barOpen || n ? ' on' : ''}`} onClick={() => setBarOpen(!barOpen)} aria-pressed={barOpen} title={filterTip}>
          <Funnel size={12} /> Filter{n ? ` (${n})` : ''}
        </button>
        {sortKeys.length > 0 && (
          <button className="btn btn-xs" onClick={() => changeSort([])} title={cv('grid.clearSort').title}>
            Sorted by {sortKeys.map((s) => `${columns[s.column]?.name} ${s.dir}`).join(', ')} <X size={11} />
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
            <button className="icon-btn sm" title={cv('grid.insertRow').tooltip} aria-label="Insert row" onClick={() => { const g = gridController(gridKey); if (g?.insertRow) g.insertRow(); else useEdits.getState().addInsert(gridKey, columns.length); }}><Plus size={14} /></button>
            <button className="icon-btn sm" title={cv('grid.undo').tooltip} aria-label="Undo" disabled={!buffer.undo.length} onClick={() => useEdits.getState().undo(gridKey)}><Undo2 size={14} /></button>
            <button className="icon-btn sm" title={cv('grid.redo').tooltip} aria-label="Redo" disabled={!buffer.redo.length} onClick={() => useEdits.getState().redo(gridKey)}><Redo2 size={14} /></button>
            {pending > 0 && (
              <>
                <PendingBar gridKey={gridKey} count={pending} actions={pendingActions} />
              </>
            )}
          </span>
        )}
        <span className="rs-sep" />
        <button
          className="btn btn-xs"
          aria-haspopup="menu"
          disabled={!data.columns}
          title="Export or copy the loaded rows"
          aria-label="Export"
          onClick={(e) => showMenuBelow(e.currentTarget, commandMenuItems(GRID_EXPORT_MENU, { gridKey, all: true }))}
        >
          <Download size={12} /> <span className="dt-btn-label">Export</span> <ChevronDown size={11} />
        </button>
        <button className="btn btn-xs" aria-label="Generate code" title={codeCmd.tooltip} disabled={!codeCmd.enabled} onClick={() => runCommand('dataTab.codegen', tabArgs)}>
          <Code2 size={12} /> <span className="dt-btn-label">Code</span>
        </button>
        <button className="btn btn-xs" aria-label="Design table" title={designCmd.tooltip} disabled={!designCmd.enabled} onClick={() => runCommand('dataTab.design', tabArgs)}>
          <PencilRuler size={12} /> <span className="dt-btn-label">Design</span>
        </button>
        <button className={`icon-btn sm${recordOpen ? ' on' : ''}`} title={cv('grid.toggleRecordView').tooltip} aria-label="Record view" aria-pressed={recordOpen} onClick={() => setRecordOpen(!recordOpen)}>
          <Rows3 size={14} />
        </button>
      </div>
      {barOpen && data.columns && (
        <FilterBar
          columns={columns}
          filter={filter}
          quick={quick}
          onChange={changeFilter}
          onQuickChange={changeQuick}
          onClose={closeBar}
          dialect={dialect}
          focusRequest={focusReq}
          focusedColumn={sel ? columns[sel.col]?.name ?? null : null}
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
          {data.errorCode === 'SESSION_LIMIT' && idle.length > 0 && (
            <button
              className="btn btn-xs"
              title="Close the sessions of idle tabs on this connection"
              onClick={() => {
                void Promise.all(idle.map((t) => useSessions.getState().close(t, true).catch(() => undefined))).then(() => {
                  toast('success', `Released ${idle.length} idle session${idle.length === 1 ? '' : 's'}`);
                  void load(0);
                });
              }}
            >
              Release {idle.length} idle
            </button>
          )}
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
                  if (v.filter !== undefined) changeFilter(v.filter ?? null);
                  if (v.quickFilter !== undefined) changeQuick(v.quickFilter);
                }}
                serverSort={{
                  sort: sortKeys,
                  onSortChange: (s) => changeSort(s.map((k) => ({ column: columns[k.column]?.name ?? '', dir: k.dir })).filter((k) => k.column)),
                }}
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
                onSubmit={pendingActions.save}
                onToggleRecord={() => setRecordOpen((o) => !o)}
                onShowDistinct={(col, pos) => setDistinct({ col, x: pos.clientX, y: pos.clientY })}
                cellSource={cellSource}
                onAggregates={setAgg}
                hideTrailingRow={noMatch}
                controllerExtras={{ refresh: () => void refresh(), loadMore, exportAs: (f) => void exportAs(f), ...(editCtx ? pendingActions.controller : {}) }}
              />
              {noMatch && (
                <div className="rs-empty-filter">
                  <Funnel size={20} />
                  <div>No rows match</div>
                  <button className="btn btn-xs" onClick={() => void guarded(() => { setFilter(null); setQuick(''); })}>Clear filter</button>
                </div>
              )}
              {!data.loading && loaded === 0 && !noMatch && (
                <div className="rs-empty-filter">
                  <Funnel size={20} />
                  <div>The table is empty</div>
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
          <button className="link-btn" onClick={loadMore} disabled={data.loading} title={cv('grid.loadMore').tooltip}>
            {data.loading ? <LoaderCircle size={11} className="spin" /> : null} Load {formatCount(pageSize)} more
          </button>
        )}
        {!data.pageable && <span className="rs-limit-note"><TriangleAlert size={12} /> This server version cannot page: first {formatCount(pageSize)} rows only</span>}
        {data.unordered && (
          <span className="muted dt-unordered" title="The table has no primary key or unique index; it is too large (or not counted yet) to sort every page">
            No key column: rows beyond the first page may repeat or be skipped
          </span>
        )}
        {data.elapsedMs !== null && <span className="muted">{formatDuration(data.elapsedMs)}</span>}
        {pending > 0 && <span className="muted">{pending} pending change{pending === 1 ? '' : 's'}</span>}
        <AggregateStrip agg={agg} partial={data.hasMore} />
        <div className="flex-1" />
        {data.sql && <span className="muted mono dt-sql" title={data.sql}>{data.sql.replace(/\s+/g, ' ')}</span>}
      </div>
      {pendingActions.dialog}
      {distinct && columns[distinct.col] && (
        <DistinctValuesPopover
          column={columns[distinct.col]}
          ordinal={distinct.col}
          at={{ x: distinct.x, y: distinct.y }}
          nullText={nullText}
          load={() => exclusive(async () => {
            const s = await ensureSession();
            const res = await getSqlRunner()(
              s.sessionId, distinctSql(target, dialect, columns[distinct.col].name, predicate?.where ?? null, 500, s.serverInfo.productVersion), predicate?.params ?? [],
              { label: 'data', maxRows: 501, skipHistory: true },
            );
            if (res.error) throw new Error(res.error.message);
            const rows = res.resultSets[0]?.rows ?? [];
            return { items: rows.slice(0, 500).map((r) => ({ value: r[0] ?? null, count: Number(r[1] ?? 0) })), more: rows.length > 500 };
          })}
          onApply={(node) => {
            changeFilter(appendAnd(filter, node));
            setBarOpen(true);
          }}
          onClose={() => setDistinct(null)}
        />
      )}
    </div>
  );
}
