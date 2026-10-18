// Run on multiple connections (A6): the same batches run concurrently on several connections. Each target gets its
// own session (synthetic tab id `<multiTab>::<connectionId>`), its own execution in the results store and its own
// history entry (label "multi"). Results are shown grouped by connection in a "multirun" view tab.
import { api, errorMessage, isApiError } from '../api/client';
import type { QueryParam, RunLabel, SqlBatch } from '../api/types';
import { pluralize } from '../components/common/text';
import { resolveParams } from '../components/ParamsDialog/ParamsDialog';
import { findDestructive } from '../lib/classify';
import { getConnection, dialectOf, useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { createExecution, isRunning } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { useSettings } from '../store/settings';
import { useTabs, type ViewTab } from '../store/tabs';
import { toast, useUi } from '../store/ui';
import { effectiveDatabase, offerCloseIdle } from './actions';

export const MULTIRUN_VIEW = 'multirun';

export interface MultiTarget {
  connectionId: string;
  database: string | null;
}

export interface MultiRunState {
  sourceTabId: string | null;
  title: string;
  label: RunLabel;
  batches: SqlBatch[];
  targets: MultiTarget[];
  /** Selected target in the strip. */
  active: string | null;
  startedAt: number;
}

export const targetTabId = (multiTabId: string, connectionId: string) => `${multiTabId}::${connectionId}`;

let seq = 0;

function maxRows(): number {
  return useSettings.getState().settings.results.maxRows;
}

/** How one target runs: `confirmed` only after an explicit confirmation; `skip` = do not send (read-only target). */
interface TargetPlan {
  confirmed: boolean;
  skip: string | null;
}

async function runOne(multiTabId: string, t: MultiTarget, label: RunLabel, batches: SqlBatch[], plan: TargetPlan, params: QueryParam[]): Promise<void> {
  const conn = getConnection(t.connectionId);
  if (!conn) return;
  const tabId = targetTabId(multiTabId, t.connectionId);
  const localId = `m${++seq}`;
  useResults.getState().clearTab(tabId);
  useResults.getState().begin(createExecution({
    localId, tabId, connectionId: conn.id, sessionId: useSessions.getState().byTab[tabId] ?? null, label, batches, maxRows: maxRows(),
    confirmedDestructive: plan.confirmed, params,
  }));
  if (plan.skip) {
    useResults.getState().fail(localId, plan.skip, 'READ_ONLY');
    return;
  }
  try {
    const session = await useSessions.getState().ensure(tabId, conn.id, t.database ?? effectiveDatabase(conn.id, null), 'auto');
    useConnections.getState().touch(conn.id);
    const res = await api.execute(session.sessionId, {
      batches, maxRows: maxRows(), stopOnError: true, label: 'multi', source: { tabId: multiTabId, title: `Multi-run · ${conn.name}` },
      ...(plan.confirmed ? { confirmedDestructive: true } : {}),
      ...(params.length ? { params } : {}),
    });
    useResults.getState().attach(localId, res.executionId);
  } catch (e) {
    if (isApiError(e, 'SESSION_LIMIT')) offerCloseIdle(conn.id);
    useResults.getState().fail(localId, errorMessage(e), isApiError(e) ? e.code : null);
  }
}

/**
 * Destructive guard: one confirmation listing every target. Read-only targets are never written implicitly: they
 * are listed as "skipped (read-only)" unless the user ticks "Allow writes on read-only targets: …".
 * Returns null when cancelled.
 */
async function planTargets(targets: MultiTarget[], batches: SqlBatch[]): Promise<Map<string, TargetPlan> | null> {
  const plans = new Map<string, TargetPlan>(targets.map((t) => [t.connectionId, { confirmed: false, skip: null }]));
  if (!useSettings.getState().settings.confirmDestructive) return plans;
  const findings = new Map<string, string[]>();
  for (const t of targets) {
    const f = findDestructive(batches, dialectOf(t.connectionId));
    if (f.length) findings.set(t.connectionId, f.map((x) => `Line ${x.line}: ${x.description}`));
  }
  if (!findings.size) return plans;
  const nameOf = (cid: string) => getConnection(cid)?.name ?? cid;
  const destructive = targets.filter((t) => findings.has(t.connectionId));
  const readOnly = destructive.filter((t) => getConnection(t.connectionId)?.readOnly);
  const writable = destructive.filter((t) => !getConnection(t.connectionId)?.readOnly);
  const roNames = readOnly.map((t) => nameOf(t.connectionId));
  const first = [...findings.values()][0];
  const r = await useUi.getState().askConfirmAck({
    title: `Run destructive statement on ${pluralize(targets.length, 'connection')}?`,
    message: writable.length
      ? `This modifies data on: ${writable.map((t) => nameOf(t.connectionId)).join(', ')}.${readOnly.length ? ' Read-only targets are skipped.' : ''}`
      : 'Every target that this statement would modify is read-only, so they are skipped.',
    items: [
      ...first,
      ...targets.map((t) => `Target: ${nameOf(t.connectionId)}${readOnly.includes(t) ? ' — skipped (read-only)' : ''}`),
    ],
    confirmLabel: `Run on ${targets.length}`,
    danger: true,
    ...(readOnly.length ? { ack: { label: `Allow writes on read-only targets: ${roNames.join(', ')}` } } : {}),
  });
  if (!r.ok) return null;
  for (const t of writable) plans.set(t.connectionId, { confirmed: true, skip: null });
  for (const t of readOnly) {
    plans.set(t.connectionId, r.ack
      ? { confirmed: true, skip: null }
      : { confirmed: false, skip: `Skipped: “${nameOf(t.connectionId)}” is read-only and the statement changes data.` });
  }
  return plans;
}

/** Opens (or reuses) the multi-run tab and runs `batches` on every target. */
export async function runMulti(opts: { sourceTabId: string | null; title: string; label: RunLabel; batches: SqlBatch[]; targets: MultiTarget[]; tabId?: string }): Promise<string | null> {
  const { targets, batches, label } = opts;
  if (!targets.length || !batches.some((b) => b.sql.trim())) return null;

  const plans = await planTargets(targets, batches);
  if (!plans) return null;

  // Bind parameters are asked once (for the source console's connection, else the first target) and sent to all.
  const source = opts.sourceTabId ? useTabs.getState().tabs.find((t) => t.id === opts.sourceTabId) : undefined;
  const paramsConn = targets.find((t) => t.connectionId === source?.connectionId)?.connectionId ?? targets[0].connectionId;
  const resolved = await resolveParams(opts.sourceTabId ?? opts.tabId ?? 'multirun', paramsConn, dialectOf(paramsConn), batches);
  if (resolved === null) return null;
  const params = resolved ?? [];

  const state: MultiRunState = {
    sourceTabId: opts.sourceTabId, title: opts.title, label, batches, targets, active: targets[0].connectionId, startedAt: Date.now(),
  };
  let id = opts.tabId;
  if (id && useTabs.getState().tabs.some((t) => t.id === id)) {
    const prev = useTabs.getState().tabs.find((t) => t.id === id) as ViewTab;
    const prevState = prev.state as MultiRunState;
    // Release sessions of targets that were dropped.
    for (const old of prevState.targets) {
      if (!targets.some((t) => t.connectionId === old.connectionId)) void useSessions.getState().close(targetTabId(id, old.connectionId), true).catch(() => undefined);
    }
    useTabs.getState().updateView(id, { state: { ...state, active: prevState.active && targets.some((t) => t.connectionId === prevState.active) ? prevState.active : state.active } });
    useTabs.getState().activate(id);
  } else {
    id = useTabs.getState().openView({ view: MULTIRUN_VIEW, title: `Multi-run: ${opts.title}`, state });
  }
  const multiId = id;
  await Promise.all(targets.map((t) => runOne(multiId, t, label, batches, plans.get(t.connectionId)!, params)));
  return multiId;
}

/** Re-run every target of a multi-run tab. */
export function rerunMulti(tab: ViewTab): void {
  const s = tab.state as MultiRunState;
  void runMulti({ sourceTabId: s.sourceTabId, title: s.title, label: s.label, batches: s.batches, targets: s.targets, tabId: tab.id });
}

export function cancelMulti(tab: ViewTab): void {
  const s = tab.state as MultiRunState;
  for (const t of s.targets) {
    const tid = targetTabId(tab.id, t.connectionId);
    const exec = useResults.getState().executions[useResults.getState().byTab[tid]];
    const ses = useSessions.getState().forTab(tid);
    if (ses && isRunning(exec)) void api.cancel(ses.sessionId).catch((e) => toast('error', 'Cancel failed', errorMessage(e)));
  }
}

/** Closing the tab releases every target session and its results. */
export function disposeMulti(tab: ViewTab): void {
  const s = tab.state as MultiRunState | null;
  for (const t of s?.targets ?? []) {
    const tid = targetTabId(tab.id, t.connectionId);
    useResults.getState().clearTab(tid);
    void useSessions.getState().close(tid, true).catch(() => undefined);
  }
}
