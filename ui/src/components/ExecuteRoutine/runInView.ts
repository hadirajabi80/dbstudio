// Runs a routine call in its result page (WP3): the `routine.run` view tab executes itself, like runInTab does for a
// console. Executions are keyed by tab id, so the page's own session (useSessions.ensure(viewTab.id, …)) and its
// results (useResults.begin({ tabId: viewTab.id, … })) belong to the tab; closing it releases both.
import { api, errorMessage, isApiError } from '../../api/client';
import type { QueryParam } from '../../api/types';
import { askReadOnlyOverride, effectiveDatabase, offerCloseIdle } from '../../app/actions';
import { getConnection, useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution, isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs, type ViewTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import { rememberParams } from '../../store/params';
import { routineLabel, type ParamInput, type RoutineCall, type RoutineSpec } from './routineSql';
import { ROUTINE_RUN_VIEW, routineRunKey, type RoutineRunState } from './runModel';
import type { ExecuteRoutineRequest } from './store';

let seq = 0;

export interface RunInViewOptions {
  connectionId: string;
  database: string | null;
  sql: string;
  params: QueryParam[];
  title: string;
  confirmedDestructive?: boolean;
}

/** Starts the call on the tab's session; errors end up in the tab's messages. */
export async function runInView(tabId: string, opts: RunInViewOptions): Promise<void> {
  const conn = getConnection(opts.connectionId);
  if (!conn) {
    toast('error', 'The connection no longer exists');
    return;
  }
  const r = useResults.getState();
  if (isRunning(r.executions[r.byTab[tabId]])) {
    toast('warning', 'The routine is still running', 'Cancel it first or wait for it to finish.');
    return;
  }
  const batches = [{ sql: opts.sql, line: 1, col: 1 }];
  const maxRows = useSettings.getState().settings.results.maxRows;
  const confirmed = opts.confirmedDestructive ?? false;
  const localId = `rv${++seq}`;
  useResults.getState().begin(createExecution({
    localId, tabId, connectionId: conn.id, sessionId: useSessions.getState().byTab[tabId] ?? null, label: 'script', batches, maxRows,
    confirmedDestructive: confirmed, params: opts.params,
  }));
  try {
    const session = await useSessions.getState().ensure(tabId, conn.id, effectiveDatabase(conn.id, opts.database), 'auto');
    useConnections.getState().touch(conn.id);
    const res = await api.execute(session.sessionId, {
      batches, maxRows, stopOnError: true, label: 'script', source: { tabId, title: opts.title },
      ...(confirmed ? { confirmedDestructive: true } : {}),
      ...(opts.params.length ? { params: opts.params } : {}),
    });
    useResults.getState().attach(localId, res.executionId);
  } catch (e) {
    if (isApiError(e, 'READ_ONLY') && !confirmed) {
      useResults.getState().fail(localId, errorMessage(e), 'READ_ONLY');
      if (await askReadOnlyOverride(conn.name, errorMessage(e), 'call')) await runInView(tabId, { ...opts, confirmedDestructive: true });
      return;
    }
    if (isApiError(e, 'SESSION_LIMIT')) {
      useResults.getState().fail(localId, errorMessage(e), 'SESSION_LIMIT');
      offerCloseIdle(conn.id, () => void runInView(tabId, opts));
      return;
    }
    useResults.getState().fail(localId, errorMessage(e), isApiError(e) ? e.code : null);
  }
}

/** Cancels the running call of a result page. */
export async function cancelInView(tabId: string): Promise<void> {
  const s = useSessions.getState().forTab(tabId);
  const exec = useResults.getState().executions[useResults.getState().byTab[tabId]];
  if (!s || !isRunning(exec)) return;
  try {
    await api.cancel(s.sessionId);
  } catch (e) {
    toast('error', 'Cancel failed', errorMessage(e));
  }
}

/** Closing the page releases its session and results. */
export function disposeRunView(tab: ViewTab): void {
  useResults.getState().clearTab(tab.id);
  void useSessions.getState().close(tab.id, true).catch(() => undefined);
}

/**
 * Opens (or reuses: one page per routine and signature) the result page of a routine and runs the call there. The
 * named binds are remembered for the Parameters dialog too, like the console path does.
 */
export async function openRoutineRun(req: ExecuteRoutineRequest, spec: RoutineSpec, inputs: ParamInput[], call: RoutineCall): Promise<string | null> {
  const conn = getConnection(req.connectionId);
  if (!conn) {
    toast('error', 'The connection no longer exists');
    return null;
  }
  const named = call.params.filter((p) => !/^\d+$/.test(p.name) && p.direction !== 'out');
  if (named.length) {
    rememberParams(req.connectionId, named.map((p) => ({
      name: p.name, display: p.name, positional: false, kind: p.kind, value: p.value === null ? '' : String(p.value),
    })));
  }
  const database = req.database ?? req.ref.database;
  const key = routineRunKey(req, spec);
  const tabs = useTabs.getState();
  const prev = tabs.tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === ROUTINE_RUN_VIEW && t.key === key);
  const state: RoutineRunState = {
    request: { connectionId: req.connectionId, database, ref: req.ref, member: req.member ?? (spec.packageName ? spec.name : null) },
    spec, inputs, sql: call.sql, params: call.params, runs: ((prev?.state as RoutineRunState | undefined)?.runs ?? 0) + 1,
  };
  const title = `Run: ${routineLabel(spec)}`;
  let id: string;
  if (prev) {
    tabs.updateView(prev.id, { state });
    tabs.activate(prev.id);
    id = prev.id;
  } else {
    id = tabs.openView({ view: ROUTINE_RUN_VIEW, title, connectionId: req.connectionId, database, state, key });
  }
  await runInView(id, { connectionId: req.connectionId, database, sql: call.sql, params: call.params, title });
  return id;
}
