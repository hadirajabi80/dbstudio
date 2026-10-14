// Explain plan flow (PLAN-M1.5 A5): Ctrl+L / Ctrl+Shift+L on the statement at the cursor → POST
// /sessions/{sid}/explain on the console's session → a "Plan" tab that fills in when `exec.plan` arrives.
// Actual mode runs the statement: its result sets go to the console's results pane as a normal execution.
import type { ExecPlanPayload, ExplainMode, WsEvent } from '../../api/types';
import { api, errorMessage } from '../../api/client';
import { engineSocket } from '../../api/ws';
import { effectiveDatabase, effectiveMaxRows } from '../../app/actions';
import { getConnection } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import type { ExplainTarget } from '../../editor/config';

export const PLAN_VIEW = 'plan';

export interface PlanTabState {
  status: 'running' | 'done' | 'error';
  mode: ExplainMode;
  sql: string;
  line: number;
  col: number;
  sourceTabId: string;
  executionId?: string | null;
  plan?: ExecPlanPayload | null;
  error?: string | null;
}

let seq = 0;

function consoleTab(id: string): ConsoleTab | undefined {
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  return t?.kind === 'console' ? t : undefined;
}

function looksReadOnly(sql: string): boolean {
  return /^\s*(\(|with\b|select\b|values\b)/i.test(sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ''));
}

/** Run explain for an editor target; opens (or reuses) the plan tab of that console. */
export async function explainInTab(t: ExplainTarget): Promise<void> {
  const tab = consoleTab(t.tabId) ?? consoleTab(useTabs.getState().activeId ?? '');
  if (!tab) { toast('info', 'Explain works in a query console'); return; }
  if (!tab.connectionId) { toast('warning', 'Choose a connection for this console first'); return; }
  const conn = getConnection(tab.connectionId);
  if (!conn) { toast('error', 'The connection of this console no longer exists'); return; }
  const sql = t.batch.sql;
  if (t.mode === 'actual' && !looksReadOnly(sql)) {
    const ok = await useUi.getState().askConfirm({
      title: 'Run the statement to get the actual plan?',
      message: `The actual plan executes the statement on “${conn.name}”.`,
      items: [sql.length > 200 ? sql.slice(0, 200) + '…' : sql],
      confirmLabel: 'Run and explain',
      danger: true,
    });
    if (!ok) return;
  }

  const state: PlanTabState = { status: 'running', mode: t.mode, sql, line: t.batch.line, col: t.batch.col, sourceTabId: tab.id, plan: null, error: null };
  const planTabId = useTabs.getState().openView({
    view: PLAN_VIEW, title: `Plan: ${tab.title}`, connectionId: tab.connectionId, database: tab.database, state, key: `plan:${tab.id}`,
  });
  const update = (patch: Partial<PlanTabState>) => {
    const cur = useTabs.getState().tabs.find((x) => x.id === planTabId);
    if (cur?.kind !== 'view') return;
    useTabs.getState().updateView(planTabId, { state: { ...(cur.state as PlanTabState), ...patch } });
  };
  const run = ++seq;
  // events can beat the POST response: collect them until the execution id is known
  let xid: string | null = null;
  const early: WsEvent[] = [];
  let off: (() => void) | null = null;
  const handle = (ev: WsEvent) => {
    if (ev.type === 'exec.plan') update({ status: 'done', plan: ev, error: null });
    else if (ev.type === 'exec.error') update({ error: ev.message });
    else if (ev.type === 'exec.done') {
      const cur = useTabs.getState().tabs.find((x) => x.id === planTabId);
      const st = cur?.kind === 'view' ? (cur.state as PlanTabState) : null;
      if (st && !st.plan) update({ status: 'error', error: st.error ?? (ev.status === 'cancelled' ? 'Cancelled' : 'The engine returned no plan') });
      off?.();
    }
  };
  off = engineSocket.onAny((ev) => {
    const id = (ev as { executionId?: string }).executionId;
    if (!id) return;
    if (xid === null) early.push(ev);
    else if (id === xid) handle(ev);
  });

  const localId = `plan${run}`;
  try {
    const session = await useSessions.getState().ensure(tab.id, conn.id, effectiveDatabase(conn.id, tab.database), tab.txMode);
    if (t.mode === 'actual') {
      useResults.getState().begin(createExecution({
        localId, tabId: tab.id, connectionId: conn.id, sessionId: session.sessionId, label: 'statement', batches: [t.batch],
        maxRows: effectiveMaxRows(tab), confirmedDestructive: true,
      }));
    }
    const res = await api.explain(session.sessionId, {
      sql, mode: t.mode, line: t.batch.line, col: t.batch.col, maxRows: effectiveMaxRows(tab),
      source: { tabId: tab.id, title: tab.title }, confirmedDestructive: t.mode === 'actual' ? true : undefined,
    });
    xid = res.executionId;
    update({ executionId: xid });
    if (t.mode === 'actual') useResults.getState().attach(localId, xid);
    for (const ev of early.splice(0)) if ((ev as { executionId?: string }).executionId === xid) handle(ev);
  } catch (e) {
    off?.();
    if (t.mode === 'actual') useResults.getState().fail(localId, errorMessage(e));
    update({ status: 'error', error: errorMessage(e) });
  }
}
