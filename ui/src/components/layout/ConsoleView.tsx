import { Plug } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { ObjectRef, RunLabel, ServerDiagnostic, SqlBatch } from '../../api/types';
import { cancelTab, catalogDatabase, openObject, runInTab } from '../../app/actions';
import { interceptRoutineRun } from '../ExecuteRoutine/intercept';
import { registerEditor } from '../../app/editors';
import { SqlEditor } from '../../editor/SqlEditor';
import type { SqlEditorHandle } from '../../editor/SqlEditor.types';
import { useCatalog, useSnapshot } from '../../store/catalog';
import { getConnection, useConnection, useDialect } from '../../store/connections';
import { useTabExecution } from '../../store/results';
import { useSettings } from '../../store/settings';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import { TipStrip } from '../Onboarding/TipStrip';
import { Kbd } from '../Shortcuts/Kbd';
import { runCommand } from '../../commands/registry';
import type { EffectiveTheme } from '../../theme/useTheme';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Splitter } from '../common/Splitter';
import { ResultsPane } from '../ResultsPane/ResultsPane';
import { Toolbar } from '../Toolbar/Toolbar';

const EMPTY_USAGE: Record<string, number> = {};

/** Rows of the results grid that stay visible however small the split (styles-03), capped at this share of the console. */
const MIN_RESULT_ROWS = 5;
const MIN_RESULTS_SHARE = 0.68;
const MAX_RESULTS_SHARE = 0.88;
const GRID_HEADER_H = 28;
/** The grid's horizontal scrollbar sits over the last row: keep room for it. */
const GRID_SCROLLBAR_H = 12;
/** The editor keeps at least this much (its CSS min-height) plus the splitter. */
const EDITOR_MIN_H = 60 + 1;

/** Heights of the results chrome (tabs, toolbar, filter bar, status row), measured; defaults before the first paint. */
interface ResultsChrome {
  header: number;
  status: number;
}
const DEFAULT_CHROME: ResultsChrome = { header: 30 + 32, status: 24 };

function measureChrome(host: HTMLElement | null): ResultsChrome | null {
  if (!host) return null;
  const h = (sel: string) => host.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0;
  const tabs = h('.results-tabs');
  if (!tabs) return null; // hidden tab (display: none) or nothing rendered yet
  const toolbar = h('.resultset-toolbar');
  const bar = h('.resultset > .fb');
  const status = h('.resultset-status');
  return { header: tabs + (toolbar || DEFAULT_CHROME.header - 30) + bar, status: status || DEFAULT_CHROME.status };
}

/**
 * Minimum height of the open results pane in px: its header (results tabs + toolbar [+ filter bar]), the grid header
 * and MIN_RESULT_ROWS rows at the current density, and the status row; never more than MIN_RESULTS_SHARE of the
 * console's height, and never so much that the editor drops below its own minimum (exported for tests).
 */
export function minResultsHeight(consoleHeight: number, splitHeight: number, chrome: ResultsChrome, rowHeight: number): number {
  const want = chrome.header + GRID_HEADER_H + MIN_RESULT_ROWS * rowHeight + GRID_SCROLLBAR_H + chrome.status;
  return Math.max(0, Math.round(Math.min(want, consoleHeight * MIN_RESULTS_SHARE, splitHeight - EDITOR_MIN_H)));
}
let usageTimer: ReturnType<typeof setTimeout> | null = null;

export function ConsoleView({ tab, theme, visible }: { tab: ConsoleTab; theme: EffectiveTheme; visible: boolean }) {
  const conn = useConnection(tab.connectionId);
  const dialect = useDialect(tab.connectionId);
  const catDb = useCatalog(() => catalogDatabase(tab.connectionId, tab.database));
  const snapshot = useSnapshot(tab.connectionId, catDb);
  const editorSettings = useSettings((s) => s.settings.editor);
  const usageAll = useSettings((s) => s.settings.ui?.completionUsage as Record<string, Record<string, number>> | undefined);
  const usage = (tab.connectionId && usageAll?.[tab.connectionId]) || EMPTY_USAGE;
  const updateText = useTabs((s) => s.updateText);
  const resultsVisible = useUi((s) => s.resultsVisible);
  const maximized = useUi((s) => s.resultsMaximized);
  const globalFraction = useUi((s) => s.resultsFraction);
  // The user's split is remembered per tab; short windows get 60 % results after the first run (actions.ts).
  const tabFraction = useUi((s) => s.tabSplits[tab.id]);
  const fraction = tabFraction ?? globalFraction;
  const setTabSplit = useUi((s) => s.setTabSplit);
  const setCursor = useUi((s) => s.setCursor);
  const exec = useTabExecution(tab.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState(fraction);
  const density = useSettings((s) => s.settings.grid?.density ?? 'comfortable');
  const rowHeight = density === 'compact' ? 24 : 28;
  const [size, setSize] = useState({ console: 0, split: 0 });
  const splitH = size.split;
  const [chrome, setChrome] = useState<ResultsChrome>(DEFAULT_CHROME);

  // Track the split height (window, zoom, tip strip) and the measured results chrome (toolbar, open filter bar).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const host = el.parentElement ?? el; // the console: toolbar + tip strip + split
    const measure = () => setSize((s) => (s.console === host.clientHeight && s.split === el.clientHeight ? s : { console: host.clientHeight, split: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(host);
    measure();
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const m = measureChrome(resultsRef.current);
    if (m && (m.header !== chrome.header || m.status !== chrome.status)) setChrome(m);
  });
  // Only once there is something to show: the empty "Run a statement" pane keeps the plain 12 % minimum.
  const hasResults = !!exec;
  const minPx = resultsVisible && hasResults && splitH > 0 ? minResultsHeight(size.console, splitH, chrome, rowHeight) : 0;
  const minFraction = splitH > 0 ? Math.max(0.12, minPx / splitH) : 0.12;
  const shown = Math.max(minFraction, Math.min(MAX_RESULTS_SHARE, fraction));

  const tabId = tab.id;
  const connectionId = tab.connectionId;

  const editorRef = useCallback((h: SqlEditorHandle | null) => registerEditor(tabId, h), [tabId]);
  const onChange = useCallback((v: string) => updateText(tabId, v), [tabId, updateText]);
  // An "Edit:" console of a procedure or function executes the routine (Execute routine) instead of re-running its CREATE.
  const onRun = useCallback((label: RunLabel, batches: SqlBatch[]) => {
    if (!interceptRoutineRun(tabId, label)) void runInTab(tabId, label, batches);
  }, [tabId]);
  const onCancel = useCallback(() => void cancelTab(tabId), [tabId]);
  const onOpenObject = useCallback(
    (ref: ObjectRef) => connectionId && openObject(connectionId, ref.database ?? catDb, ref),
    [connectionId, catDb],
  );
  const requestServerDiagnostics = useMemo(() => {
    // Server diagnostics for every dialect but Oracle; PostgreSQL's ("pg-prepare") PREPAREs each statement inside a
    // read-only transaction that is always rolled back, so nothing runs.
    if (!connectionId || dialect === 'plsql') return undefined;
    return (sql: string) =>
      api.diagnostics({ dialect, sql, connectionId }).then((r) => r.diagnostics).catch(() => [] as ServerDiagnostic[]);
  }, [connectionId, dialect]);
  const requestSchema = useCallback(
    (schema: string) => {
      if (!connectionId) return;
      const d = useCatalog.getState().dbs[`${connectionId}\u0001${catDb ?? ''}`];
      const known = d?.schemasResp?.schemas.find((s) => s.name.toLowerCase() === schema.toLowerCase());
      if (known) void useCatalog.getState().loadSchema(connectionId, catDb, known.name);
      else if (!d?.schemasResp) void useCatalog.getState().loadSchemas(connectionId, catDb);
    },
    [connectionId, catDb],
  );
  const onUsageChange = useCallback(
    (u: Record<string, number>) => {
      if (!connectionId) return;
      if (usageTimer) clearTimeout(usageTimer);
      usageTimer = setTimeout(() => {
        const all = (useSettings.getState().settings.ui?.completionUsage as Record<string, Record<string, number>> | undefined) ?? {};
        useSettings.getState().update({ ui: { completionUsage: { ...all, [connectionId]: u } } });
      }, 1500);
    },
    [connectionId],
  );
  const onCursorChange = useCallback((line: number, col: number) => setCursor(tabId, { line, col }), [setCursor, tabId]);

  // Errors and Oracle compile errors of the last run become editor markers.
  const externalDiagnostics = useMemo<ServerDiagnostic[] | undefined>(() => {
    if (!exec || exec.detached) return undefined;
    const out: ServerDiagnostic[] = [...exec.diagnostics];
    for (const m of exec.messages) {
      if (m.severity !== 'error' || m.line === null || m.source === 'client') continue;
      out.push({ line: m.line, col: m.col ?? 1, endLine: m.line, endCol: m.col ? m.col + 1 : 1000, severity: 'error', code: m.code, message: m.text });
    }
    return out;
  }, [exec?.diagnostics, exec?.messages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="console" style={{ display: visible ? undefined : 'none' }} data-tab={tab.id} data-command-scope="console">
      <Toolbar tab={tab} />
      <TipStrip />
      <div className={`console-split${maximized && resultsVisible ? ' results-maximized' : ''}`} ref={containerRef}>
        <div
          className="editor-host"
          data-region="editor"
          style={{ flexBasis: resultsVisible ? `${(1 - shown) * 100}%` : '100%' }}
          onDropCapture={(e) => {
            const raw = e.dataTransfer.getData('application/x-dbstudio-object');
            if (!raw) return;
            try {
              const o = JSON.parse(raw) as { connectionId: string; name: string };
              if (o.connectionId && o.connectionId !== tab.connectionId) {
                const from = getConnection(o.connectionId)?.name ?? 'another connection';
                toast('info', `Inserted ${o.name} from ${from}`, conn ? `This console runs on ${conn.name}.` : 'This console has no connection yet.');
              }
            } catch {
              /* ignore */
            }
          }}
        >
          <SqlEditor
            ref={editorRef}
            tabId={tab.id}
            dialect={dialect}
            catalog={snapshot}
            value={tab.text}
            onChange={onChange}
            onRun={onRun}
            onCancel={onCancel}
            onOpenObject={onOpenObject}
            requestServerDiagnostics={requestServerDiagnostics}
            requestSchema={requestSchema}
            externalDiagnostics={externalDiagnostics}
            theme={theme}
            settings={editorSettings}
            usage={usage}
            onUsageChange={onUsageChange}
            onCursorChange={onCursorChange}
          />
          {!conn && (
            <div className="editor-hint">
              <Plug size={16} strokeWidth={1.5} /> This console has no connection.
              <button className="btn btn-xs btn-primary" onClick={() => runCommand('connections.change')}>
                Choose connection <Kbd shortcut="Mod+Shift+K" className="on-accent" />
              </button>
            </div>
          )}
        </div>
        {resultsVisible && (
          <>
            <Splitter
              direction="horizontal"
              ariaLabel="Resize results"
              onDragStart={() => setDragStart(shown)}
              onDrag={(d) => {
                const h = containerRef.current?.clientHeight ?? 600;
                // Clamped from the results minimum (header + 5 rows), not a fixed share (styles-03).
                const consoleH = containerRef.current?.parentElement?.clientHeight ?? h;
                const min = h > 0 && hasResults ? Math.max(0.12, minResultsHeight(consoleH, h, chrome, rowHeight) / h) : 0.12;
                setTabSplit(tab.id, Math.max(min, Math.min(MAX_RESULTS_SHARE, dragStart - d / h)));
              }}
              onDoubleClick={() => setTabSplit(tab.id, null)}
            />
            <div className="results-host" data-region="results" ref={resultsRef} style={{ flexBasis: `${shown * 100}%`, ...(minPx ? { minHeight: minPx } : {}) }}>
              <ErrorBoundary area="the results" variant="panel">
                <ResultsPane tabId={tab.id} dialect={dialect} theme={theme} onClose={() => useUi.getState().toggle('resultsVisible')} />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
