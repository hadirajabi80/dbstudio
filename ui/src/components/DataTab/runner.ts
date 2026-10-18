// Runs one statement on a session and collects the outcome from the WebSocket stream (for data tabs, edits,
// refetches and counts — anything that is not shown as a console execution).
import { api, errorMessage, isApiError } from '../../api/client';
import type { CellValue, ColumnInfo, ExecLabel, ExecuteRequest, WsEvent } from '../../api/types';
import { engineSocket } from '../../api/ws';
import type { ExecParam } from '../../filter/wire';

export interface QueryResultSet {
  columns: ColumnInfo[];
  rows: CellValue[][];
  truncated: boolean;
}

export interface QueryOutcome {
  executionId: string | null;
  status: 'ok' | 'error' | 'cancelled';
  resultSets: QueryResultSet[];
  /** Rows affected by DML (sum of exec.affected). */
  affected: number;
  /** null when the engine did not report a count for the statement. */
  affectedReported: boolean;
  error: { message: string; code: string | null; line: number | null } | null;
  messages: string[];
  outParams: { name: string; value: CellValue }[];
  elapsedMs: number;
  txOpen: boolean | null;
}

export interface RunOptions {
  maxRows?: number;
  /** History label (M1.5 adds "filter" | "data"). */
  label?: ExecLabel;
  source?: { tabId: string; title: string };
  confirmedDestructive?: boolean;
  signal?: AbortSignal;
  /** Internal statements (describe probes, COUNT, savepoints): not recorded in the query history. */
  skipHistory?: boolean;
  /** Safety net when exec.done never arrives (default 15 min; the socket-loss check normally fires first). */
  timeoutMs?: number;
}

/** Shown when the WebSocket drops while a statement is running: its outcome can no longer be observed. */
export const ENGINE_LOST_MESSAGE = 'Connection to the engine was lost — retry';
export const ENGINE_LOST_CODE = 'ENGINE_DISCONNECTED';
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export type SqlRunner = (sessionId: string, sql: string, params: ExecParam[], opts?: RunOptions) => Promise<QueryOutcome>;

export const runSql: SqlRunner = async (sessionId, sql, params, opts = {}) => {
  const started = Date.now();
  const out: QueryOutcome = {
    executionId: null, status: 'ok', resultSets: [], affected: 0, affectedReported: false, error: null, messages: [], outParams: [],
    elapsedMs: 0, txOpen: null,
  };
  const sets = new Map<number, QueryResultSet>();
  const early: WsEvent[] = [];
  let xid: string | null = null;
  let finish: (() => void) | null = null;
  let finished = false;
  const done = new Promise<void>((r) => (finish = () => {
    finished = true;
    r();
  }));
  /** Ends the wait with an error (socket lost / timeout) so callers and the tab's exclusive chain never hang. */
  const abandon = (message: string, code: string) => {
    if (finished) return;
    out.status = 'error';
    if (!out.error) out.error = { message, code, line: null };
    finish?.();
  };

  const apply = (ev: WsEvent) => {
    switch (ev.type) {
      case 'exec.resultset':
        sets.set(ev.resultSetId, { columns: ev.columns, rows: [], truncated: false });
        break;
      case 'exec.rows': {
        const s = sets.get(ev.resultSetId);
        if (s) for (const r of ev.rows) s.rows.push(r);
        break;
      }
      case 'exec.resultset.end': {
        const s = sets.get(ev.resultSetId);
        if (s) s.truncated = ev.truncated;
        break;
      }
      case 'exec.affected':
        out.affected += ev.count;
        out.affectedReported = true;
        break;
      case 'exec.message':
        out.messages.push(ev.text);
        break;
      case 'exec.error':
        if (!out.error) out.error = { message: ev.message + (ev.detail ? `\n${ev.detail}` : ''), code: ev.code, line: ev.line };
        break;
      case 'exec.done': {
        out.status = ev.status;
        out.txOpen = ev.txOpen;
        out.elapsedMs = ev.elapsedMs;
        if (Array.isArray(ev.outParams)) out.outParams = ev.outParams;
        finish?.();
        break;
      }
      default:
        break;
    }
  };

  const off = engineSocket.onAny((ev) => {
    const evx = (ev as { executionId?: string }).executionId;
    if (!evx || !ev.type.startsWith('exec.')) return;
    if (xid === null) early.push(ev);
    else if (evx === xid) apply(ev);
  });
  const onAbort = () => void api.cancel(sessionId).catch(() => undefined);
  opts.signal?.addEventListener('abort', onAbort);
  const lost = (s: string) => s === 'reconnecting' || s === 'closed' || s === 'unauthorized';
  const offStatus = engineSocket.onStatus((s) => {
    if (lost(s)) abandon(ENGINE_LOST_MESSAGE, ENGINE_LOST_CODE);
  });
  const timer = setTimeout(() => {
    void api.cancel(sessionId).catch(() => undefined);
    abandon('The engine did not finish the statement in time — retry', 'TIMEOUT');
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const req: ExecuteRequest & { skipHistory?: boolean } = {
      batches: [{ sql, line: 1, col: 1 }],
      maxRows: opts.maxRows ?? 0,
      stopOnError: true,
      label: opts.label ?? 'statement',
      ...(params.length ? { params } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.confirmedDestructive ? { confirmedDestructive: true } : {}),
      ...(opts.skipHistory ? { skipHistory: true } : {}),
    };
    const res = await api.execute(sessionId, req);
    xid = res.executionId;
    out.executionId = xid;
    for (const ev of early.splice(0)) if ((ev as { executionId?: string }).executionId === xid) apply(ev);
    // Already disconnected: exec.done can never reach us.
    if (lost(engineSocket.status)) abandon(ENGINE_LOST_MESSAGE, ENGINE_LOST_CODE);
    await done;
  } catch (e) {
    out.status = 'error';
    out.error = { message: errorMessage(e), code: isApiError(e) ? e.code : null, line: null };
  } finally {
    off();
    offStatus();
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  out.resultSets = [...sets.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  if (!out.elapsedMs) out.elapsedMs = Date.now() - started;
  if (out.status === 'error' && !out.error) out.error = { message: 'The statement failed', code: null, line: null };
  return out;
};

let current: SqlRunner = runSql;

/** Test seam: replace the runner (component tests without an engine). */
export function setSqlRunner(r: SqlRunner | null): void {
  current = r ?? runSql;
}

export function getSqlRunner(): SqlRunner {
  return current;
}
