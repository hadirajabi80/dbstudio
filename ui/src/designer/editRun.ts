// F4 "Edit:" consoles on SQLite (views, triggers): SQLite has no CREATE OR ALTER, so the edit script is
// "DROP … IF EXISTS; CREATE …". Run statement by statement in auto-commit, a failing CREATE would leave the object
// dropped. Running such a tab therefore applies the whole editor text through POST /designer/apply with
// transactional:true: either every statement succeeds, or the engine rolls back and the server object is unchanged.
// The edit registration is persisted in the tab (store/tabs.ts `edit`), so a tab restored with the workspace still
// takes this path. The apply cannot be cancelled; while it waits for locks (up to 30 s) the Stop button is disabled.
import { api, errorMessage, isApiError } from '../api/client';
import type { DdlFailedDetail, SqlBatch, WsEvent } from '../api/types';
import { getEditor } from '../app/editors';
import { useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { applyEvents, createExecution, isRunning, type ExecutionState } from '../store/resultsReducer';
import { useTabs } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { pluralize } from '../components/common/text';
import { splitForApply } from './ddl';
import { editSessionOf, rememberEdit } from './editSession';
import { useDesignerUi } from './store';

let seq = 0;

/** Object types whose SQLite edit script is DROP + CREATE (and therefore needs the atomic apply). */
const ATOMIC_TYPES = new Set(['view', 'trigger']);

function event(e: Record<string, unknown>): WsEvent {
  return { ts: new Date().toISOString(), ...e } as unknown as WsEvent;
}

function store(exec: ExecutionState): void {
  useResults.setState((s) => ({ executions: { ...s.executions, [exec.localId]: exec } }));
}

/**
 * Runs an "Edit:" console atomically when it edits a SQLite view or trigger. Returns false when the tab is not such
 * an edit (the caller runs it normally), true when it was handled (applied, failed and rolled back, or nothing to do).
 */
export async function runEditTab(tabId: string): Promise<boolean> {
  const edit = editSessionOf(tabId);
  if (!edit || edit.dialect !== 'sqlite' || !ATOMIC_TYPES.has(edit.ref.type)) return false;
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  // The user pointed the console at another connection: it is an ordinary script now.
  if (tab?.kind !== 'console' || tab.connectionId !== edit.connectionId) return false;
  const r = useResults.getState();
  if (isRunning(r.executions[r.byTab[tabId]])) {
    toast('warning', 'A query is already running in this console');
    return true;
  }

  const text = getEditor(tabId)?.getValue() ?? tab.text;
  const statements = splitForApply(text, 'sqlite');
  if (!statements.length) {
    toast('info', 'Nothing to run');
    return true;
  }
  const batches: SqlBatch[] = statements.map((s) => ({ sql: s.sql, line: s.line, col: 1 }));
  const localId = `edit${++seq}`;
  const base = createExecution({ localId, tabId, connectionId: edit.connectionId, sessionId: null, label: 'script', batches, maxRows: 0 });
  useResults.getState().begin(base);
  if (!useUi.getState().resultsVisible) useUi.getState().toggle('resultsVisible');
  const name = edit.ref.name;
  const started = Date.now();
  useDesignerUi.getState().setEditRunInFlight(tabId, true);

  try {
    const res = await api.applyDdl(edit.connectionId, { database: edit.database, statements: batches.map((b) => b.sql), transactional: true, schema: edit.ref.schema });
    const elapsed = res?.elapsedMs ?? Date.now() - started;
    store(applyEvents(base, [
      event({ type: 'exec.message', executionId: localId, batchIndex: 0, severity: 'info', line: null, code: null, source: 'engine',
        text: `Applied ${pluralize(batches.length, 'statement')} to ${edit.ref.type} ${name} in one transaction.` }),
      event({ type: 'exec.done', executionId: localId, sessionId: '', status: 'ok', elapsedMs: elapsed, resultSets: 0, rowsAffected: 0, txOpen: false }),
    ]));
    toast('success', `Saved ${edit.ref.type} ${name}`, 'The script ran in one transaction.');
    useConnections.getState().touch(edit.connectionId);
    // The stored definition changed: revalidate the object's schema in place (explorer/IntelliSense, no full refresh
    // and no flash) and the "Compare with server" baseline.
    void useCatalog.getState().revalidate(edit.connectionId, edit.database ?? edit.ref.database ?? null, [edit.ref.schema]);
    void api.ddl(edit.connectionId, edit.database, edit.ref)
      .then((d) => { if (useDesignerUi.getState().edits[tabId]) rememberEdit(tabId, { ...edit, serverDdl: d.ddl }); })
      .catch(() => undefined);
  } catch (e) {
    const detail = isApiError(e, 'DDL_FAILED') ? (e.detail as DdlFailedDetail | undefined) : undefined;
    const idx = detail?.failedIndex ?? -1;
    const failed = batches[idx];
    const why = detail?.providerError?.message ?? errorMessage(e);
    store(applyEvents(base, [
      event({ type: 'exec.error', executionId: localId, batchIndex: Math.max(0, idx), code: detail?.providerError?.code ?? (isApiError(e) ? e.code : 'ERROR'),
        message: failed ? `Statement ${idx + 1} failed: ${why}` : why, line: failed?.line ?? null, col: null, detail: null }),
      event({ type: 'exec.message', executionId: localId, batchIndex: 0, severity: 'info', line: null, code: null, source: 'engine',
        text: `Nothing was changed: the script ran in one transaction and was rolled back. ${name} keeps its previous definition.` }),
      event({ type: 'exec.done', executionId: localId, sessionId: '', status: 'error', elapsedMs: Date.now() - started, resultSets: 0, rowsAffected: 0, txOpen: false }),
    ]));
    toast('error', `${name} was not changed`, failed ? `Statement ${idx + 1} failed: ${why}` : why);
  } finally {
    useDesignerUi.getState().setEditRunInFlight(tabId, false);
  }
  return true;
}
