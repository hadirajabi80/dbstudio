import {
  ChevronDown, CloudUpload, Code2, Copy, Download, Funnel, LoaderCircle, Lock, Maximize2, Minimize2, PanelRight, PencilLine, Plus, Redo2, RotateCcw,
  Rows3, Search, Table2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CellValue, Dialect, ExportFormat } from '../../api/types';
import { catalogDatabase, exportResultSet, rerun } from '../../app/actions';
import { displayShortcut } from '../../commands/keys';
import { runCommand } from '../../commands/registry';
import { commandView, useCommandContext } from '../../commands/useCommands';
import { appendAnd, columnSignature, EMPTY_VIEW, type GridViewModel } from '../../filter/model';
import { countActiveConditions } from '../../filter/values';
import { formatCount, formatDuration } from '../../lib/format';
import type { CellLocator } from '../../lib/serialize';
import { dbKey, useCatalog, useSnapshot } from '../../store/catalog';
import { useConnection } from '../../store/connections';
import { pendingCount, useEditBuffer, useEdits } from '../../store/edits';
import { useFilters } from '../../store/filters';
import { useResults, useTabExecution, viewKey } from '../../store/results';
import { isRunning, type ExecutionState, type ResultSetState } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { showMenuBelow } from '../common/Menu';
import { pluralize } from '../common/text';
import { commandMenuItems } from '../layout/commandMenu';
import { Splitter } from '../common/Splitter';
import { openDataTab } from '../DataTab/open';
import { describeNode } from '../FilterBar/describe';
import { DistinctValuesPopover, distinctValues } from '../FilterBar/DistinctValues';
import { FilterBar, type FilterBarCloseReason } from '../FilterBar/FilterBar';
import type { SelectionAggregates } from '../Grid/aggregate';
import { AggregateStrip } from '../Grid/AggregateStrip';
import { CellViewer } from '../Grid/CellViewer';
import { DataGrid, rowValue, type GridSelectionInfo, type RowRef } from '../Grid/DataGrid';
import { foreignKeys, referencingTables, resultEditability, type FkLink } from '../Grid/editability';
import { overlayRows } from '../Grid/overlay';
import { focusGrid, gridController } from '../Grid/controller';
import '../Grid/grid.css';
import { MessagesPane } from '../MessagesPane/MessagesPane';
import { PendingBar } from '../PendingChanges/PendingBar';
import { usePendingChanges } from '../PendingChanges/usePendingChanges';
import type { EditContext } from '../PendingChanges/submit';
import { RecordView } from '../RecordView/RecordView';
import { analyzeSelect } from '../../filter/rewrite';
import type { QueryCodegenArgs } from '../CodegenPanel/commands';
import { OverflowToolbar, type OverflowItem } from '../layout/OverflowToolbar';
import type { ObjectTarget } from '../../commands/types';
import { ExecutedQueryLine } from './ExecutedQueryLine';
import { resultStatement, type ExecutedQuery } from './executedQuery';
import { applyServerFilter, originalBatch, originatingSelect, previewServerSql, serverFilterAvailability } from './serverFilter';
import { GRID_EXPORT_MENU, RESULTS_CODE_ENTRY } from './toolbarModel';
import './results.css';

interface Props {
  tabId: string;
  dialect: Dialect;
  theme: EffectiveTheme;
  onClose?: () => void;
}

export function ResultsPane({ tabId, dialect, theme, onClose }: Props) {
  const exec = useTabExecution(tabId);
  const active = useResults((s) => s.activeView[tabId]) ?? 'messages';
  const setActive = useResults((s) => s.setActiveView);

  if (!exec) {
    return (
      <div className="results empty">
        <div className="results-empty">
          <Table2 size={26} />
          <div>
            Run a statement with <kbd>{displayShortcut('Mod+Enter')}</kbd>, or the whole script with <kbd>{displayShortcut('F5')}</kbd>.
          </div>
        </div>
      </div>
    );
  }
  const rs = typeof active === 'number' ? exec.resultSets.find((r) => r.id === active) : undefined;
  const view = rs ?? null;
  const errors = exec.errorCount;

  return (
    <div className="results">
      <div className="results-tabs" role="tablist" aria-label="Results">
        {exec.resultSets.map((r, i) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={active === r.id}
            className={`results-tab${active === r.id ? ' active' : ''}`}
            onClick={() => setActive(tabId, r.id)}
            title={`Batch ${r.batchIndex + 1}`}
          >
            <Table2 size={13} />
            Result {i + 1}
            <span className="results-tab-count">{formatCount(r.rowCount)}</span>
            {!r.done && <LoaderCircle size={11} className="spin" />}
          </button>
        ))}
        <button
          role="tab"
          aria-selected={active === 'messages' || !view}
          className={`results-tab${active === 'messages' || !view ? ' active' : ''}`}
          onClick={() => setActive(tabId, 'messages')}
        >
          Messages
          {errors > 0 ? <span className="badge badge-error">{errors}</span> : exec.messages.length > 0 && <span className="results-tab-count">{exec.messages.length}</span>}
        </button>
        <div className="flex-1" />
        <ExecStatus exec={exec} />
        {onClose && <MaximizeToggle />}
        {onClose && (
          <button className="icon-btn sm" title={commandView('view.toggleResults', undefined, 'Hide results').tooltip} aria-label="Hide results" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      {view ? <ResultSetView key={viewKey(exec.localId, view.id)} exec={exec} rs={view} dialect={dialect} theme={theme} /> : <MessagesPane exec={exec} />}
    </div>
  );
}

/**
 * Base name of the generated code for a result of `table`: "Customers" (the generators add their own suffixes:
 * CustomersRow, CustomersQuery, GetCustomersAsync), "Result" when the result has no source table (design-r2-03).
 */
function queryNameFor(table: string | null | undefined): string {
  const words = (table ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') : 'Result';
}

function ExecStatus({ exec }: { exec: ExecutionState }) {
  const running = isRunning(exec);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  if (running) {
    return (
      <span className="exec-status running">
        <LoaderCircle size={12} className="spin" /> Running {formatDuration(now - exec.startedAt)}
      </span>
    );
  }
  const cls = exec.status === 'ok' ? 'ok' : exec.status === 'cancelled' ? 'warn' : 'error';
  return (
    <span className={`exec-status ${cls}`}>
      {exec.status === 'ok' ? 'Done' : exec.status === 'cancelled' ? 'Cancelled' : 'Failed'} · {formatDuration(exec.elapsedMs ?? (exec.endedAt ?? now) - exec.startedAt)}
    </span>
  );
}

/** Maximize / restore the results pane of a console (view.maximizeResults, Mod+Shift+R). */
function MaximizeToggle() {
  const maximized = useUi((s) => s.resultsMaximized);
  const label = maximized ? 'Restore results' : 'Maximize results';
  return (
    <button
      className={`icon-btn sm${maximized ? ' on' : ''}`}
      title={commandView('view.maximizeResults', undefined, label).tooltip}
      aria-label={label}
      aria-pressed={maximized}
      onClick={() => runCommand('view.maximizeResults')}
    >
      {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}

type SidePanel = 'viewer' | 'record' | null;

/** One result set: toolbar, grid, side viewers and status line (also used by the routine result page). */
export function ResultSetView({ exec, rs, dialect, theme }: { exec: ExecutionState; rs: ResultSetState; dialect: Dialect; theme: EffectiveTheme }) {
  const key = viewKey(exec.localId, rs.id);
  const view = useResults((s) => s.views[key]) ?? EMPTY_VIEW;
  const setGridView = useResults((s) => s.setGridView);
  const { nullText, dateFormat } = useSettings((s) => s.settings.results);
  const viewerWidth = useUi((s) => s.cellViewerWidth);
  const setLayout = useUi((s) => s.setLayout);
  const conn = useConnection(exec.connectionId);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === exec.tabId));
  const tabDb = tab && 'database' in tab ? tab.database : null;
  const catDb = useCatalog(() => catalogDatabase(exec.connectionId, tabDb));
  const snapshot = useSnapshot(exec.connectionId, catDb);
  const serverFilter = useFilters((s) => s.serverFilters[exec.tabId]);
  const buffer = useEditBuffer(key);
  const [barOpen, setBarOpen] = useState(() => !!view.filter);
  const [focusReq, setFocusReq] = useState<{ column: string | null; nonce: number } | null>(null);
  const [sel, setSel] = useState<GridSelectionInfo | null>(null);
  const [side, setSide] = useState<SidePanel>(null);
  const [dragStart, setDragStart] = useState(viewerWidth);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const [distinct, setDistinct] = useState<{ col: number; x: number; y: number } | null>(null);
  const [agg, setAgg] = useState<SelectionAggregates | null>(null);
  const setView = useCallback((v: Partial<GridViewModel>) => setGridView(key, v), [setGridView, key]);
  useCommandContext();

  // Reset the edit buffer when this result goes away (re-run, tab closed).
  useEffect(() => () => useEdits.getState().reset(key), [key]);
  // The console's transaction ended: a Commit keeps rows this grid saved into it, a Rollback undid them, and the grid
  // says so instead of showing them as real (features-r2-01). Every buffer of the session is updated at once.
  useEffect(
    () => useSessions.subscribe((s, prev) => {
      if (s.lastTxEnd && s.lastTxEnd !== prev.lastTxEnd) useEdits.getState().applyTxEnd(s.lastTxEnd);
    }),
    [],
  );

  const columns = rs.columns;
  const orig = originalBatch(exec);
  const singleSelect = !!orig && exec.resultSets.length === 1 && analyzeSelect(orig.sql, dialect).ok;
  const session = useSessions((s) => s.sessions[s.byTab[exec.tabId]]);
  /** Oracle: the console's CURRENT_SCHEMA, where the unqualified table of the query lives. */
  const currentSchema = dialect === 'plsql' ? (session?.database ?? tabDb ?? null) : null;
  const editability = useMemo(
    () => (rs.done ? resultEditability(columns, { singleSelect, snapshot, conn, dialect, currentSchema }) : null),
    [rs.done, columns, singleSelect, snapshot, conn, dialect, currentSchema],
  );
  const table = editability?.target ?? null;
  const tableCol = columns.find((c) => c.table);
  // A result from a table of a schema the catalog has not loaded (Oracle `SELECT * FROM other.t`): load it, its primary
  // key decides whether the rows can be edited.
  const tableSchema = tableCol?.schema ?? null;
  const schemasKnown = useCatalog((s) => !!s.dbs[dbKey(exec.connectionId, catDb)]?.schemasResp);
  useEffect(() => {
    if (!rs.done || !tableSchema || !schemasKnown) return;
    const d = useCatalog.getState().dbs[dbKey(exec.connectionId, catDb)];
    if (!d?.schemasResp || d.schemaStatus[tableSchema]) return;
    if (!d.schemasResp.schemas.some((s) => s.name === tableSchema)) return;
    void useCatalog.getState().loadSchema(exec.connectionId, catDb, tableSchema).catch(() => undefined);
  }, [rs.done, tableSchema, schemasKnown, exec.connectionId, catDb]);
  const fks = useMemo<FkLink[]>(() => foreignKeys(columns, tableCol?.schema ?? null, tableCol?.table ?? null, snapshot), [columns, tableCol, snapshot]);
  const refs = useMemo(() => (table ? referencingTables(table.schema, table.name, snapshot) : []), [table, snapshot]);
  const overlay = useMemo(() => overlayRows(rs.rows, buffer.committed), [rs.rows, rs.rev, buffer.committed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only complete, enabled conditions count (an empty "Id equals ..." draft does not filter anything).
  const n = countActiveConditions(view.filter, columns);
  const hasFilter = n > 0 || !!view.quickFilter;
  const shown = viewCount ?? overlay.length;
  const filtered = hasFilter && shown !== overlay.length;
  const pending = pendingCount(buffer.pending);
  const signature = useMemo(() => columnSignature(columns), [columns]);
  const sfActive = !!serverFilter && exec.batches[0]?.sql === serverFilter.sql;
  const avail = useMemo(() => serverFilterAvailability(exec, columns, dialect), [exec, columns, dialect]);

  const editCtx: EditContext | null = editability?.editable && editability.target ? {
    gridKey: key, tabId: exec.tabId, connectionId: exec.connectionId, database: session?.database ?? tabDb, dialect, target: editability.target,
    columns, rowAt: (i) => overlay.get(i), sourceLength: overlay.length, sqliteVersion: session?.serverInfo.productVersion ?? null,
    tabTitle: tab?.title,
  } : null;

  const openFilter = (column?: string) => {
    setBarOpen(true);
    setFocusReq({ column: column ?? null, nonce: Date.now() });
  };
  /** Esc or ✕ inside the filter bar: focus goes back to the grid, on the selected cell (design-r1-01). */
  const closeBar = (reason?: FilterBarCloseReason) => {
    setBarOpen(false);
    if (reason === 'escape' || reason === 'button') focusGrid(key);
  };

  const navigateFk = (fk: FkLink, values: CellValue[]) => {
    openDataTab({
      connectionId: exec.connectionId, database: tabDb, schema: fk.refSchema, name: fk.refTable,
      filter: fk.refColumns.map((c, i) => ({ column: c, value: values[i] ?? null })),
    });
  };

  const selRef: RowRef | null = sel ? (sel.sourceRow !== null ? { src: sel.sourceRow } : buffer.pending.inserts.find((i) => i.id === sel.insertId) ? { ins: buffer.pending.inserts.find((i) => i.id === sel.insertId)! } : null) : null;
  const recordValues = selRef ? columns.map((_, c) => rowValue(overlay, buffer.pending.updates, selRef, c)) : null;
  const viewerValue = side === 'viewer' && sel && selRef ? rowValue(overlay, buffer.pending.updates, selRef, sel.col) : undefined;

  /** Engine cell of a source row (full values of truncated cells for copy / client-side export). */
  const xid = exec.executionId;
  const stored = rs.rows.length;
  const cellSource = useCallback(
    (sourceRow: number, col: number): CellLocator | null => (xid && sourceRow < stored ? { executionId: xid, resultSetId: rs.id, row: sourceRow, col } : null),
    [xid, stored, rs.id],
  );

  /**
   * Whole result straight from the engine's result store (full values, every row) when the grid shows it unchanged;
   * otherwise the visible rows (filter / sort / submitted edits) are exported client-side with full values fetched.
   */
  const exportAs = (format: ExportFormat) => {
    const v = useResults.getState().views[key];
    const hasView = !!v && (!!v.quickFilter || !!v.filter || v.sort.length > 0);
    const c = useEdits.getState().get(key).committed;
    const edited = c.appended.length > 0 || Object.keys(c.patched).length > 0 || Object.keys(c.hidden).length > 0;
    const g = gridController(key);
    if ((xid && !hasView && !edited) || !g?.exportVisible) return void exportResultSet(exec, rs, format);
    void g.exportVisible(format, { baseName: rs.columns.find((x) => x.table)?.table ?? `result_${rs.id + 1}` });
  };
  const gridArgs = { gridKey: key };
  const cv = (id: string) => commandView(id, gridArgs);
  const exportMenu = (el: HTMLElement) => showMenuBelow(el, commandMenuItems(GRID_EXPORT_MENU, { ...gridArgs, all: true }));

  const serverApply = () => void applyServerFilter(exec, columns, dialect, view.filter, view.quickFilter, view.sort);
  const serverClear = () => void applyServerFilter(exec, columns, dialect, null, '', view.sort, true);
  // Ctrl+S / Save write the pending edits directly; the SQL preview is opt-in (user-02).
  const pendingActions = usePendingChanges(editCtx);
  const toggleViewer = () => setSide((s) => (s === 'viewer' ? null : 'viewer'));
  const toggleRecord = () => setSide((s) => (s === 'record' ? null : 'record'));
  const clearAll = () => {
    if (sfActive) serverClear();
    setView({ filter: null, quickFilter: '' });
  };
  const noMatch = hasFilter && shown === 0 && rs.done;
  const rolledBack = buffer.rolledBack?.rows ?? 0;
  const rolledBackText = rolledBack
    ? `Rolled back: ${pluralize(rolledBack, 'saved row')} in this grid no longer match${rolledBack === 1 ? 'es' : ''} the database.`
    : '';

  // "Code ▾" (design-09): code for the SELECT that produced this result, with its columns.
  const codeSql = useMemo(() => originatingSelect(exec, rs, dialect), [exec.batches, exec.resultSets.length, rs.batchIndex, dialect, serverFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  const codeArgs: QueryCodegenArgs | null = codeSql
    ? { connectionId: exec.connectionId, database: session?.database ?? tabDb, sql: codeSql, columns, name: queryNameFor(tableCol?.table) }
    : null;
  const codeEntries = [{ ...RESULTS_CODE_ENTRY, label: 'Generate code for this query…' }];
  const codeMenu = (el: HTMLElement) => {
    if (!codeArgs) return;
    const items = commandMenuItems(codeEntries, codeArgs);
    if (table) {
      const target: ObjectTarget = { kind: 'object', connectionId: exec.connectionId, database: tabDb, ref: { database: tabDb, schema: table.schema, name: table.name, type: 'table' } };
      items.push(...commandMenuItems([{ command: 'codegen.open', optional: true, hideDisabled: true, label: `Generate code for table ${table.name}…` }], target));
    }
    if (items.length) showMenuBelow(el, items);
  };
  const codeCmd = codeArgs ? commandView(RESULTS_CODE_ENTRY.command, codeArgs) : null;
  // The statement that produced this result set, as it ran (server filter included), for the line under the grid.
  const stmt = useMemo(() => resultStatement(exec, rs, dialect), [exec.batches, exec.resultSets.length, rs.id, rs.batchIndex, dialect]); // eslint-disable-line react-hooks/exhaustive-deps
  const queryDb = session?.database ?? tabDb ?? null;
  const executed = useMemo<ExecutedQuery | null>(
    () => (stmt ? { sql: stmt, params: exec.params ?? [], dialect, connectionId: exec.connectionId, database: queryDb } : null),
    [stmt, exec.params, dialect, exec.connectionId, queryDb],
  );
  const showCode = !!codeArgs && !!codeCmd?.enabled;
  const insertRow = () => {
    const g = gridController(key);
    if (g?.insertRow) g.insertRow();
    else useEdits.getState().addInsert(key, columns.length);
  };

  // Never wraps or scrolls (styles-03): low-priority items collapse into "…". Search, Filter, Save and Export stay.
  const toolbarItems: OverflowItem[] = [
    {
      id: 'search',
      node: (
        <div className="rs-quick">
          <Search size={13} />
          <input
            className="input xs borderless"
            placeholder="Search in results"
            aria-label="Search in results"
            dir="auto"
            value={view.quickFilter}
            spellCheck={false}
            onChange={(e) => setView({ quickFilter: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setView({ quickFilter: '' })}
          />
          {view.quickFilter && (
            <button className="icon-btn xs" aria-label="Clear search" onClick={() => setView({ quickFilter: '' })}>
              <X size={12} />
            </button>
          )}
        </div>
      ),
    },
    {
      id: 'filter',
      node: (
        <button className={`btn btn-xs${barOpen || n ? ' on' : ''}`} onClick={() => (barOpen ? setBarOpen(false) : openFilter())} title={cv('grid.filter').tooltip} aria-pressed={barOpen}>
          <Funnel size={12} /> Filter{n ? ` (${n})` : ''}
        </button>
      ),
    },
  ];
  if (view.sort.length > 0) {
    toolbarItems.push({
      id: 'sort', priority: 3, menu: () => commandMenuItems([{ command: 'grid.clearSort' }], gridArgs),
      node: (
        <button className="btn btn-xs" onClick={() => runCommand('grid.clearSort', gridArgs)} title={cv('grid.clearSort').tooltip}>
          Sorted by {view.sort.map((s) => `${columns[s.column]?.name} ${s.dir}`).join(', ')} <X size={11} />
        </button>
      ),
    });
  }
  if (sfActive) {
    toolbarItems.push({
      id: 'server', priority: 2,
      node: (
        <span className="rs-badge server" title={serverFilter?.sql}>
          <CloudUpload size={11} /> Server filter
        </span>
      ),
    });
  }
  toolbarItems.push({ id: 'spacer', spacer: true });
  if (editability) {
    toolbarItems.push({
      id: 'editability', priority: 1,
      node: editability.editable ? (
        <span className="rs-badge editable" title={`Edits go to ${editability.target?.name} (key: ${editability.target?.keyColumns.join(', ')})`}>
          <PencilLine size={11} /> Editable
        </span>
      ) : (
        <span className="rs-badge" title={editability.reason ?? undefined}>
          <Lock size={11} /> {editability.reason}
        </span>
      ),
    });
  }
  if (editability?.editable) {
    toolbarItems.push({
      id: 'edit', priority: 5, menu: () => commandMenuItems([{ command: 'grid.insertRow' }, { command: 'grid.undo' }, { command: 'grid.redo' }], gridArgs),
      node: (
        <span className="rs-pending">
          <button className="icon-btn sm" title={cv('grid.insertRow').tooltip} aria-label="Insert row" onClick={insertRow}>
            <Plus size={14} />
          </button>
          <button className="icon-btn sm" title={cv('grid.undo').tooltip} aria-label="Undo" disabled={!buffer.undo.length} onClick={() => useEdits.getState().undo(key)}>
            <Undo2 size={14} />
          </button>
          <button className="icon-btn sm" title={cv('grid.redo').tooltip} aria-label="Redo" disabled={!buffer.redo.length} onClick={() => useEdits.getState().redo(key)}>
            <Redo2 size={14} />
          </button>
        </span>
      ),
    });
    if (pending > 0) {
      toolbarItems.push({
        id: 'save',
        node: (
          <span className="rs-pending">
            <PendingBar gridKey={key} count={pending} actions={pendingActions} />
          </span>
        ),
      });
    }
  }
  toolbarItems.push({ id: 'sep-export', separator: true });
  if (showCode) {
    toolbarItems.push({
      id: 'code', priority: 4, menu: () => commandMenuItems(codeEntries, codeArgs),
      node: (
        <button className="btn btn-xs" aria-haspopup="menu" title={codeCmd?.tooltip || 'Generate code for this query'} onClick={(e) => codeMenu(e.currentTarget)}>
          <Code2 size={12} /> Code <ChevronDown size={11} />
        </button>
      ),
    });
  }
  toolbarItems.push(
    {
      id: 'export',
      node: (
        <button className="btn btn-xs" aria-haspopup="menu" onClick={(e) => exportMenu(e.currentTarget)} title="Export or copy the result set">
          <Download size={12} /> Export <ChevronDown size={11} />
        </button>
      ),
    },
    {
      id: 'record', priority: 2, menu: () => commandMenuItems([{ command: 'grid.toggleRecordView' }], gridArgs),
      node: (
        <button className={`icon-btn sm${side === 'record' ? ' on' : ''}`} title={cv('grid.toggleRecordView').tooltip} aria-label="Record view" aria-pressed={side === 'record'} onClick={toggleRecord}>
          <Rows3 size={14} />
        </button>
      ),
    },
    {
      id: 'viewer', priority: 2, menu: () => commandMenuItems([{ command: 'grid.toggleValueViewer' }], gridArgs),
      node: (
        <button className={`icon-btn sm${side === 'viewer' ? ' on' : ''}`} title={cv('grid.toggleValueViewer').tooltip} aria-label="Value viewer" aria-pressed={side === 'viewer'} onClick={toggleViewer}>
          <PanelRight size={14} />
        </button>
      ),
    },
    {
      id: 'columns', priority: 1, menu: () => commandMenuItems([{ command: 'grid.copyColumnNames' }], gridArgs),
      node: (
        <button className="icon-btn sm" title={cv('grid.copyColumnNames').tooltip} aria-label="Copy column names" onClick={() => runCommand('grid.copyColumnNames', gridArgs)}>
          <Copy size={13} />
        </button>
      ),
    },
  );
  const statusText = sfActive
    ? `Server · ${formatCount(rs.rows.length)} rows${filtered ? ` · ${formatCount(shown)} shown` : ''}`
    : filtered ? `Filtered ${formatCount(shown)} of ${formatCount(overlay.length)}` : null;

  return (
    <div className="resultset">
      <OverflowToolbar className="resultset-toolbar" ariaLabel="Result set toolbar" items={toolbarItems} />
      {barOpen && (
        <FilterBar
          columns={columns}
          filter={view.filter}
          quick={view.quickFilter}
          onChange={(f) => setView({ filter: f })}
          onQuickChange={(q) => setView({ quickFilter: q })}
          onClose={closeBar}
          dialect={dialect}
          focusRequest={focusReq}
          focusedColumn={sel ? columns[sel.col]?.name ?? null : null}
          saved={{ connectionId: exec.connectionId, signature }}
          status={statusText}
          server={{
            available: avail.available, reason: avail.reason, active: sfActive, busy: isRunning(exec),
            previewSql: avail.available ? previewServerSql(exec, columns, dialect, view.filter, view.quickFilter) : null,
            onApply: serverApply, onClear: serverClear,
          }}
        />
      )}
      {rolledBack > 0 && (
        <div className="rs-rolledback" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          <span className="rs-rolledback-text" title={rolledBackText}>
            {rolledBackText}
          </span>
          <button className="link-btn" onClick={() => void rerun(exec.tabId)} disabled={isRunning(exec)} title="Run the query again to show what the database holds now">
            <RotateCcw size={11} /> Re-run
          </button>
          <button className="icon-btn xs" aria-label="Dismiss" title="Dismiss" onClick={() => useEdits.getState().dismissRolledBack(key)}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="resultset-body">
        <div className="resultset-grid">
          {rs.columns.length === 0 ? (
            <div className="results-empty">Statement returned no columns.</div>
          ) : (
            <>
              <DataGrid
                gridKey={key}
                columns={columns}
                rows={rs.rows}
                rev={rs.rev}
                done={rs.done}
                view={view}
                onViewChange={setView}
                editability={editability}
                fks={fks}
                onNavigateFk={navigateFk}
                dialect={dialect}
                theme={theme}
                nullText={nullText}
                dateFormat={dateFormat}
                onSelectCell={setSel}
                onRowCount={setViewCount}
                onOpenViewer={(s) => {
                  setSel(s);
                  setSide('viewer');
                }}
                onOpenFilter={openFilter}
                onSubmit={pendingActions.save}
                onToggleRecord={toggleRecord}
                onShowDistinct={(col, pos) => setDistinct({ col, x: pos.clientX, y: pos.clientY })}
                cellSource={cellSource}
                onAggregates={setAgg}
                hideTrailingRow={noMatch}
                controllerExtras={{ applyServerFilter: avail.available ? serverApply : undefined, exportAs, toggleValueViewer: toggleViewer, ...(editCtx ? pendingActions.controller : {}) }}
              />
              {noMatch && (
                <div className="rs-empty-filter">
                  <Funnel size={20} />
                  <div>No rows match</div>
                  <button className="btn btn-xs" onClick={clearAll}>
                    Clear filter
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {side && (
          <>
            <Splitter direction="vertical" onDragStart={() => setDragStart(viewerWidth)} onDrag={(d) => setLayout({ cellViewerWidth: Math.max(220, Math.min(900, dragStart - d)) })} />
            <div className="resultset-viewer" style={{ width: viewerWidth }}>
              {side === 'record' ? (
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
                    if (selRef.ins) useEdits.getState().setInsertCell(key, selRef.ins.id, col, value);
                    else useEdits.getState().setCell(key, selRef.src, col, value, overlay.get(selRef.src)?.[col] ?? null);
                  } : undefined}
                  onNavigateFk={navigateFk}
                  onOpenReferencing={(r, vals) => openDataTab({
                    connectionId: exec.connectionId, database: tabDb, schema: r.schema, name: r.table,
                    filter: r.columns.map((c, i) => ({ column: c, value: vals[i] ?? null })),
                  })}
                  onClose={() => setSide(null)}
                />
              ) : sel && sel.sourceRow !== null && viewerValue !== undefined ? (
                <CellViewer
                  executionId={exec.executionId}
                  resultSetId={rs.id}
                  sourceRow={sel.sourceRow}
                  col={sel.col}
                  column={rs.columns[sel.col]}
                  value={viewerValue}
                  onClose={() => setSide(null)}
                />
              ) : (
                <div className="cell-viewer-empty">
                  Select a cell to see its value.
                  <button className="icon-btn sm" onClick={() => setSide(null)} aria-label="Close viewer">
                    <X size={13} />
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="resultset-status">
        <span>
          {filtered ? `${formatCount(shown)} of ${formatCount(overlay.length)} rows` : `${formatCount(overlay.length)} row${overlay.length === 1 ? '' : 's'}`}
        </span>
        {!barOpen && hasFilter && (
          // Two sibling buttons (a button inside a button is invalid and unreachable for assistive tech).
          <span className="rs-chip" role="group" aria-label="Active filter">
            <button className="fb-chip" onClick={() => openFilter()} title={`${view.filter ? describeNode(view.filter) : ''}${view.quickFilter ? ` “${view.quickFilter}”` : ''}`}>
              <Funnel size={10} /> {sfActive ? 'Server filter' : `Filtered ${formatCount(shown)} of ${formatCount(overlay.length)}`}
            </button>
            <button className="fb-chip" onClick={clearAll} aria-label="Clear filter" title="Clear filter">
              <X size={10} /> Clear
            </button>
          </span>
        )}
        {sfActive && serverFilter?.limited && (
          <span className="rs-limit-note">
            <TriangleAlert size={12} /> Filtered within the first rows of the query — remove its row limit to filter everything
          </span>
        )}
        {!rs.done && (
          <span className="muted">
            <LoaderCircle size={11} className="spin" /> fetching…
          </span>
        )}
        {rs.elapsedMs !== null && <span className="muted">{formatDuration(rs.elapsedMs)}</span>}
        <span className="muted">{rs.columns.length} columns</span>
        {pending > 0 && <span className="muted">{pending} pending change{pending === 1 ? '' : 's'}</span>}
        <AggregateStrip agg={agg} partial={rs.truncated || !rs.done} />
        {rs.truncated && (
          <span className="truncated">
            <TriangleAlert size={12} /> Limited to {formatCount(exec.maxRows)} rows
            <button className="link-btn" onClick={() => void rerun(exec.tabId, { maxRows: 0 })} disabled={isRunning(exec)}>
              <RotateCcw size={11} /> Re-run without limit
            </button>
          </span>
        )}
        <div className="flex-1" />
        <ExecutedQueryLine gridKey={key} query={executed} />
        {sel && rs.columns[sel.col] && (
          <span className="muted mono">
            {rs.columns[sel.col].name}: {rs.columns[sel.col].dbType}
          </span>
        )}
      </div>
      {pendingActions.dialog}
      {distinct && columns[distinct.col] && (
        <DistinctValuesPopover
          column={columns[distinct.col]}
          ordinal={distinct.col}
          at={{ x: distinct.x, y: distinct.y }}
          nullText={nullText}
          load={async () => distinctValues(overlay, distinct.col)}
          onApply={(node) => {
            setView({ filter: appendAnd(view.filter, node) });
            setBarOpen(true);
          }}
          onClose={() => setDistinct(null)}
        />
      )}
    </div>
  );
}
