import { Plug } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { ObjectRef, RunLabel, ServerDiagnostic, SqlBatch } from '../../api/types';
import { cancelTab, catalogDatabase, openObject, runInTab } from '../../app/actions';
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
import { Splitter } from '../common/Splitter';
import { ResultsPane } from '../ResultsPane/ResultsPane';
import { Toolbar } from '../Toolbar/Toolbar';

const EMPTY_USAGE: Record<string, number> = {};
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
  const fraction = useUi((s) => s.resultsFraction);
  const setLayout = useUi((s) => s.setLayout);
  const setCursor = useUi((s) => s.setCursor);
  const exec = useTabExecution(tab.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState(fraction);

  const tabId = tab.id;
  const connectionId = tab.connectionId;

  const editorRef = useCallback((h: SqlEditorHandle | null) => registerEditor(tabId, h), [tabId]);
  const onChange = useCallback((v: string) => updateText(tabId, v), [tabId, updateText]);
  const onRun = useCallback((label: RunLabel, batches: SqlBatch[]) => void runInTab(tabId, label, batches), [tabId]);
  const onCancel = useCallback(() => void cancelTab(tabId), [tabId]);
  const onOpenObject = useCallback(
    (ref: ObjectRef) => connectionId && openObject(connectionId, ref.database ?? catDb, ref),
    [connectionId, catDb],
  );
  const requestServerDiagnostics = useMemo(() => {
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
  const onCursorChange = useCallback((line: number, col: number) => setCursor({ line, col }), [setCursor]);

  // Errors and Oracle compile errors of the last run become editor markers.
  const externalDiagnostics = useMemo<ServerDiagnostic[] | undefined>(() => {
    if (!exec) return undefined;
    const out: ServerDiagnostic[] = [...exec.diagnostics];
    for (const m of exec.messages) {
      if (m.severity !== 'error' || m.line === null || m.source === 'client') continue;
      out.push({ line: m.line, col: m.col ?? 1, endLine: m.line, endCol: m.col ? m.col + 1 : 1000, severity: 'error', code: m.code, message: m.text });
    }
    return out;
  }, [exec?.diagnostics, exec?.messages]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="console" style={{ display: visible ? undefined : 'none' }} data-tab={tab.id}>
      <Toolbar tab={tab} />
      <TipStrip />
      <div className={`console-split${maximized && resultsVisible ? ' results-maximized' : ''}`} ref={containerRef}>
        <div
          className="editor-host"
          style={{ flexBasis: resultsVisible ? `${(1 - fraction) * 100}%` : '100%' }}
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
              onDragStart={() => setDragStart(fraction)}
              onDrag={(d) => {
                const h = containerRef.current?.clientHeight ?? 600;
                setLayout({ resultsFraction: Math.max(0.12, Math.min(0.88, dragStart - d / h)) });
              }}
              onDoubleClick={() => setLayout({ resultsFraction: 0.45 })}
            />
            <div className="results-host" style={{ flexBasis: `${fraction * 100}%` }}>
              <ResultsPane tabId={tab.id} dialect={dialect} theme={theme} onClose={() => useUi.getState().toggle('resultsVisible')} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
