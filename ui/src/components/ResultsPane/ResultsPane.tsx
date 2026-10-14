import {
  CloudUpload, Copy, Download, Funnel, LoaderCircle, Lock, PanelRight, PencilLine, Plus, Redo2, RotateCcw, Rows3, Search,
  Table2, TriangleAlert, Undo2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CellValue, Dialect } from '../../api/types';
import { catalogDatabase, copyText, exportResultSet, rerun, visibleRows } from '../../app/actions';
import { appendAnd, columnSignature, countConditions, EMPTY_VIEW, type GridViewModel } from '../../filter/model';
import { formatCount, formatDuration } from '../../lib/format';
import { serializeRows } from '../../lib/serialize';
import { useCatalog, useSnapshot } from '../../store/catalog';
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
import { Splitter } from '../common/Splitter';
import { openDataTab } from '../DataTab/open';
import { describeNode } from '../FilterBar/describe';
import { DistinctValuesPopover, distinctValues } from '../FilterBar/DistinctValues';
import { FilterBar } from '../FilterBar/FilterBar';
import { CellViewer } from '../Grid/CellViewer';
import { DataGrid, rowValue, type GridSelectionInfo, type RowRef } from '../Grid/DataGrid';
import { foreignKeys, referencingTables, resultEditability, type FkLink } from '../Grid/editability';
import { overlayRows } from '../Grid/overlay';
import { gridController } from '../Grid/controller';
import '../Grid/grid.css';
import { MessagesPane } from '../MessagesPane/MessagesPane';
import { PendingChangesDialog } from '../PendingChanges/PendingChanges';
import type { EditContext } from '../PendingChanges/submit';
import { RecordView } from '../RecordView/RecordView';
import { analyzeSelect } from '../../filter/rewrite';
import { applyServerFilter, originalBatch, previewServerSql, serverFilterAvailability } from './serverFilter';

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
            Run a statement with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, or the whole script with <kbd>F5</kbd>.
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
        {onClose && (
          <button className="icon-btn sm" title="Hide results (Ctrl+R)" aria-label="Hide results" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      {view ? <ResultSetView key={viewKey(exec.localId, view.id)} exec={exec} rs={view} dialect={dialect} theme={theme} /> : <MessagesPane exec={exec} />}
    </div>
  );
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

type SidePanel = 'viewer' | 'record' | null;

function ResultSetView({ exec, rs, dialect, theme }: { exec: ExecutionState; rs: ResultSetState; dialect: Dialect; theme: EffectiveTheme }) {
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
  const [showPending, setShowPending] = useState(false);
  const [distinct, setDistinct] = useState<{ col: number; x: number; y: number } | null>(null);
  const setView = useCallback((v: Partial<GridViewModel>) => setGridView(key, v), [setGridView, key]);

  // Reset the edit buffer when this result goes away (re-run, tab closed).
  useEffect(() => () => useEdits.getState().reset(key), [key]);

  const columns = rs.columns;
  const orig = originalBatch(exec);
  const singleSelect = !!orig && exec.resultSets.length === 1 && analyzeSelect(orig.sql, dialect).ok;
  const editability = useMemo(
    () => (rs.done ? resultEditability(columns, { singleSelect, snapshot, conn }) : null),
    [rs.done, columns, singleSelect, snapshot, conn],
  );
  const table = editability?.target ?? null;
  const tableCol = columns.find((c) => c.table);
  const fks = useMemo<FkLink[]>(() => foreignKeys(columns, tableCol?.schema ?? null, tableCol?.table ?? null, snapshot), [columns, tableCol, snapshot]);
  const refs = useMemo(() => (table ? referencingTables(table.schema, table.name, snapshot) : []), [table, snapshot]);
  const overlay = useMemo(() => overlayRows(rs.rows, buffer.committed), [rs.rows, rs.rev, buffer.committed]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = countConditions(view.filter);
  const hasFilter = n > 0 || !!view.quickFilter;
  const shown = viewCount ?? overlay.length;
  const filtered = hasFilter && shown !== overlay.length;
  const pending = pendingCount(buffer.pending);
  const signature = useMemo(() => columnSignature(columns), [columns]);
  const sfActive = !!serverFilter && exec.batches[0]?.sql === serverFilter.sql;
  const avail = useMemo(() => serverFilterAvailability(exec, columns, dialect), [exec, columns, dialect]);

  const session = useSessions((s) => s.sessions[s.byTab[exec.tabId]]);
  const editCtx: EditContext | null = editability?.editable && editability.target ? {
    gridKey: key, tabId: exec.tabId, connectionId: exec.connectionId, database: session?.database ?? tabDb, dialect, target: editability.target,
    columns, rowAt: (i) => overlay.get(i), sourceLength: overlay.length, sqliteVersion: session?.serverInfo.productVersion ?? null,
    tabTitle: tab?.title,
  } : null;

  const openFilter = (column?: string) => {
    setBarOpen(true);
    setFocusReq({ column: column ?? null, nonce: Date.now() });
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

  const exportMenu = (el: HTMLElement) =>
    showMenuBelow(el, [
      { label: 'Export CSV…', onClick: () => void exportResultSet(exec, rs, 'csv') },
      { label: 'Export JSON…', onClick: () => void exportResultSet(exec, rs, 'json') },
      { label: 'Export SQL INSERT…', onClick: () => void exportResultSet(exec, rs, 'sql-insert') },
      { separator: true },
      { label: 'Copy all as TSV', onClick: () => void copyText(serializeRows('tsv', rs.columns, visibleRows(exec, rs)), `Copied ${shown} rows`) },
      { label: 'Copy all as CSV', onClick: () => void copyText(serializeRows('csv', rs.columns, visibleRows(exec, rs)), `Copied ${shown} rows`) },
      { label: 'Copy all as JSON', onClick: () => void copyText(serializeRows('json', rs.columns, visibleRows(exec, rs)), `Copied ${shown} rows`) },
      { label: 'Copy all as Markdown', onClick: () => void copyText(serializeRows('markdown', rs.columns, visibleRows(exec, rs)), `Copied ${shown} rows`) },
      { label: 'Copy all as SQL INSERT', onClick: () => void copyText(serializeRows('sql-insert', rs.columns, visibleRows(exec, rs), { dialect }), `Copied ${shown} rows`) },
    ]);

  const serverApply = () => void applyServerFilter(exec, columns, dialect, view.filter, view.quickFilter, view.sort);
  const serverClear = () => void applyServerFilter(exec, columns, dialect, null, '', view.sort, true);
  const submit = () => editCtx && setShowPending(true);
  const toggleRecord = () => setSide((s) => (s === 'record' ? null : 'record'));
  const statusText = sfActive
    ? `Server · ${formatCount(rs.rows.length)} rows${filtered ? ` · ${formatCount(shown)} shown` : ''}`
    : filtered ? `Filtered ${formatCount(shown)} of ${formatCount(overlay.length)}` : null;

  return (
    <div className="resultset">
      <div className="resultset-toolbar wpg">
        <div className="rs-quick">
          <Search size={13} />
          <input
            className="input xs borderless"
            placeholder="Search in results"
            aria-label="Search in results"
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
        <button className={`btn btn-xs${barOpen || n ? ' on' : ''}`} onClick={() => (barOpen ? setBarOpen(false) : openFilter())} title="Filter rows (Ctrl+F in the grid)" aria-pressed={barOpen}>
          <Funnel size={12} /> Filter{n ? ` (${n})` : ''}
        </button>
        {view.sort.length > 0 && (
          <button className="btn btn-xs" onClick={() => setView({ sort: [] })} title="Clear sorting">
            Sorted by {view.sort.map((s) => `${columns[s.column]?.name} ${s.dir}`).join(', ')} <X size={11} />
          </button>
        )}
        {sfActive && (
          <span className="rs-badge server" title={serverFilter?.sql}>
            <CloudUpload size={11} /> Server filter
          </span>
        )}
        <div className="flex-1" />
        {editability && (
          editability.editable ? (
            <span className="rs-badge editable" title={`Edits go to ${editability.target?.name} (key: ${editability.target?.keyColumns.join(', ')})`}>
              <PencilLine size={11} /> Editable
            </span>
          ) : (
            <span className="rs-badge" title={editability.reason ?? undefined}>
              <Lock size={11} /> {editability.reason}
            </span>
          )
        )}
        {editability?.editable && (
          <span className="rs-pending">
            <button className="icon-btn sm" title="Insert row (Insert)" aria-label="Insert row" onClick={() => { const g = gridController(key); if (g?.insertRow) g.insertRow(); else useEdits.getState().addInsert(key, columns.length); }}>
              <Plus size={14} />
            </button>
            <button className="icon-btn sm" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!buffer.undo.length} onClick={() => useEdits.getState().undo(key)}>
              <Undo2 size={14} />
            </button>
            <button className="icon-btn sm" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!buffer.redo.length} onClick={() => useEdits.getState().redo(key)}>
              <Redo2 size={14} />
            </button>
            {pending > 0 && (
              <>
                <button className="btn btn-xs" onClick={() => useEdits.getState().revertAll(key)} title="Discard all pending changes">
                  <RotateCcw size={12} /> Revert
                </button>
                <button className="btn btn-xs btn-primary" onClick={submit} title="Preview and submit (Ctrl+S)">
                  Submit ({pending})
                </button>
              </>
            )}
          </span>
        )}
        <span className="rs-sep" />
        <button className="btn btn-xs" onClick={(e) => exportMenu(e.currentTarget)} title="Export or copy the result set">
          <Download size={12} /> Export
        </button>
        <button className={`icon-btn sm${side === 'record' ? ' on' : ''}`} title="Record view (F7)" aria-label="Record view" aria-pressed={side === 'record'} onClick={toggleRecord}>
          <Rows3 size={14} />
        </button>
        <button className={`icon-btn sm${side === 'viewer' ? ' on' : ''}`} title="Value viewer" aria-label="Value viewer" aria-pressed={side === 'viewer'} onClick={() => setSide(side === 'viewer' ? null : 'viewer')}>
          <PanelRight size={14} />
        </button>
      </div>
      {barOpen && (
        <FilterBar
          columns={columns}
          filter={view.filter}
          quick={view.quickFilter}
          onChange={(f) => setView({ filter: f })}
          onQuickChange={(q) => setView({ quickFilter: q })}
          onClose={() => setBarOpen(false)}
          dialect={dialect}
          focusRequest={focusReq}
          saved={{ connectionId: exec.connectionId, signature }}
          status={statusText}
          server={{
            available: avail.available, reason: avail.reason, active: sfActive, busy: isRunning(exec),
            previewSql: avail.available ? previewServerSql(exec, columns, dialect, view.filter, view.quickFilter) : null,
            onApply: serverApply, onClear: serverClear,
          }}
        />
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
                onSubmit={submit}
                onToggleRecord={toggleRecord}
                onShowDistinct={(col, pos) => setDistinct({ col, x: pos.clientX, y: pos.clientY })}
                controllerExtras={{ applyServerFilter: avail.available ? serverApply : undefined }}
              />
              {hasFilter && shown === 0 && rs.done && (
                <div className="rs-empty-filter">
                  <Funnel size={20} />
                  <div>No rows match</div>
                  <button className="btn btn-xs" onClick={() => setView({ filter: null, quickFilter: '' })}>
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
          <button className="fb-chip" onClick={() => openFilter()} title={`${view.filter ? describeNode(view.filter) : ''}${view.quickFilter ? ` “${view.quickFilter}”` : ''}`}>
            <Funnel size={10} /> {sfActive ? 'Server filter' : `Filtered ${formatCount(shown)} of ${formatCount(overlay.length)}`}
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear filter"
              onClick={(e) => {
                e.stopPropagation();
                if (sfActive) serverClear();
                setView({ filter: null, quickFilter: '' });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), setView({ filter: null, quickFilter: '' }))}
            >
              · Clear
            </span>
          </button>
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
        {rs.truncated && (
          <span className="truncated">
            <TriangleAlert size={12} /> Limited to {formatCount(exec.maxRows)} rows
            <button className="link-btn" onClick={() => void rerun(exec.tabId, { maxRows: 0 })} disabled={isRunning(exec)}>
              <RotateCcw size={11} /> Re-run without limit
            </button>
          </span>
        )}
        <div className="flex-1" />
        {sel && rs.columns[sel.col] && (
          <span className="muted mono">
            {rs.columns[sel.col].name}: {rs.columns[sel.col].dbType}
          </span>
        )}
        <button
          className="icon-btn xs"
          title="Copy column names"
          onClick={() => void copyText(rs.columns.map((c) => c.name).join(', '), 'Copied column names')}
        >
          <Copy size={11} />
        </button>
      </div>
      {showPending && editCtx && <PendingChangesDialog ctx={editCtx} onClose={() => setShowPending(false)} />}
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
