import { Copy, Download, LoaderCircle, PanelRight, RotateCcw, Table2, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Dialect } from '../../api/types';
import { copyText, exportResultSet, rerun, visibleRows } from '../../app/actions';
import { EMPTY_VIEW } from '../../lib/filter';
import { formatCount, formatDuration } from '../../lib/format';
import { serializeRows } from '../../lib/serialize';
import { useResults, useTabExecution, viewKey } from '../../store/results';
import { isRunning, type ExecutionState, type ResultSetState } from '../../store/resultsReducer';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import type { EffectiveTheme } from '../../theme/useTheme';
import { showMenuBelow } from '../common/Menu';
import { Splitter } from '../common/Splitter';
import { CellViewer } from '../Grid/CellViewer';
import { FilterBar } from '../Grid/FilterBar';
import { ResultGrid, type GridSelectionInfo } from '../Grid/ResultGrid';
import { MessagesPane } from '../MessagesPane/MessagesPane';

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

function ResultSetView({ exec, rs, dialect, theme }: { exec: ExecutionState; rs: ResultSetState; dialect: Dialect; theme: EffectiveTheme }) {
  const key = viewKey(exec.localId, rs.id);
  const view = useResults((s) => s.views[key]) ?? EMPTY_VIEW;
  const setGridView = useResults((s) => s.setGridView);
  const { nullText, dateFormat } = useSettings((s) => s.settings.results);
  const viewerWidth = useUi((s) => s.cellViewerWidth);
  const setLayout = useUi((s) => s.setLayout);
  const [showBuilder, setShowBuilder] = useState(false);
  const [sel, setSel] = useState<GridSelectionInfo | null>(null);
  const [viewer, setViewer] = useState(false);
  const [dragStart, setDragStart] = useState(viewerWidth);

  const hasView = !!(view.quickFilter || view.filter || view.sort.length);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const shown = hasView && viewCount !== null ? viewCount : rs.rows.length;
  const filtered = !!(view.quickFilter || view.filter) && shown !== rs.rows.length;
  const viewerValue = viewer && sel ? rs.rows.get(sel.sourceRow)?.[sel.col] : undefined;

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

  return (
    <div className="resultset">
      <div className="resultset-toolbar">
        <FilterBar columns={rs.columns} view={view} onChange={(v) => setGridView(key, v)} showBuilder={showBuilder} onToggleBuilder={() => setShowBuilder(!showBuilder)} />
        <div className="flex-1" />
        <button className="btn btn-xs" onClick={(e) => exportMenu(e.currentTarget)} title="Export or copy the result set">
          <Download size={12} /> Export
        </button>
        <button className={`icon-btn sm${viewer ? ' on' : ''}`} title="Value viewer" aria-pressed={viewer} onClick={() => setViewer(!viewer)}>
          <PanelRight size={14} />
        </button>
      </div>
      <div className="resultset-body">
        <div className="resultset-grid">
          {rs.columns.length === 0 ? (
            <div className="results-empty">Statement returned no columns.</div>
          ) : (
            <ResultGrid
              exec={exec}
              rs={rs}
              dialect={dialect}
              theme={theme}
              nullText={nullText}
              dateFormat={dateFormat}
              onSelectCell={setSel}
              onRowCount={setViewCount}
              onOpenViewer={(s) => {
                setSel(s);
                setViewer(true);
              }}
            />
          )}
        </div>
        {viewer && (
          <>
            <Splitter direction="vertical" onDragStart={() => setDragStart(viewerWidth)} onDrag={(d) => setLayout({ cellViewerWidth: Math.max(220, Math.min(900, dragStart - d)) })} />
            <div className="resultset-viewer" style={{ width: viewerWidth }}>
              {sel && viewerValue !== undefined ? (
                <CellViewer
                  executionId={exec.executionId}
                  resultSetId={rs.id}
                  sourceRow={sel.sourceRow}
                  col={sel.col}
                  column={rs.columns[sel.col]}
                  value={viewerValue}
                  onClose={() => setViewer(false)}
                />
              ) : (
                <div className="cell-viewer-empty">
                  Select a cell to see its value.
                  <button className="icon-btn sm" onClick={() => setViewer(false)} aria-label="Close viewer">
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
          {filtered ? `${formatCount(shown)} of ${formatCount(rs.rows.length)} rows` : `${formatCount(rs.rows.length)} row${rs.rows.length === 1 ? '' : 's'}`}
        </span>
        {!rs.done && (
          <span className="muted">
            <LoaderCircle size={11} className="spin" /> fetching…
          </span>
        )}
        {rs.elapsedMs !== null && <span className="muted">{formatDuration(rs.elapsedMs)}</span>}
        <span className="muted">{rs.columns.length} columns</span>
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
    </div>
  );
}
