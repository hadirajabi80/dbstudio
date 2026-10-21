import type { CellValue, ColumnInfo, QueryParam, RunLabel, ServerDiagnostic, SqlBatch, WsEvent } from '../api/types';
import { ChunkedList } from '../lib/chunked';

/**
 * Streaming reducer for one execution. Rows are appended into a ChunkedList (no copying of existing rows);
 * each applied batch of events produces a new ExecutionState / ResultSetState wrapper so React sees a change.
 */
export type ExecStatus = 'starting' | 'running' | 'ok' | 'error' | 'cancelled';

export interface ResultSetState {
  id: number;
  batchIndex: number;
  columns: ColumnInfo[];
  rows: ChunkedList<CellValue[]>;
  /** Rows received so far (final engine count once done). */
  rowCount: number;
  truncated: boolean;
  elapsedMs: number | null;
  done: boolean;
  /** Bumped on every append; lets memoized views recompute. */
  rev: number;
}

export type MessageSource = 'server' | 'dbmsOutput' | 'engine' | 'client';

export interface ExecMessage {
  seq: number;
  ts: number;
  severity: 'info' | 'warning' | 'error';
  text: string;
  /** Absolute document line, when known (click-to-line). */
  line: number | null;
  col: number | null;
  code: string | null;
  source: MessageSource;
  batchIndex: number | null;
}

export interface BatchState {
  index: number;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  elapsedMs: number | null;
}

export interface ExecutionState {
  localId: string;
  executionId: string | null;
  tabId: string;
  connectionId: string;
  sessionId: string | null;
  label: RunLabel;
  batches: SqlBatch[];
  /** Bind values the batches ran with (A2); re-runs (server filter, Clear) must send them again. */
  params: QueryParam[];
  /** The batches are not the console's editor text (Execute routine): error lines are not marked in the editor. */
  detached?: boolean;
  maxRows: number;
  confirmedDestructive: boolean;
  status: ExecStatus;
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number | null;
  batchCount: number;
  batchStates: BatchState[];
  resultSets: ResultSetState[];
  messages: ExecMessage[];
  rowsAffected: number;
  errorCount: number;
  diagnostics: ServerDiagnostic[];
  txOpen: boolean | null;
}

export function createExecution(init: {
  localId: string; tabId: string; connectionId: string; sessionId: string | null; label: RunLabel; batches: SqlBatch[];
  maxRows: number; confirmedDestructive?: boolean; now?: number; params?: QueryParam[] | null; detached?: boolean;
}): ExecutionState {
  return {
    localId: init.localId,
    executionId: null,
    tabId: init.tabId,
    connectionId: init.connectionId,
    sessionId: init.sessionId,
    label: init.label,
    batches: init.batches,
    params: init.params ?? [],
    ...(init.detached ? { detached: true } : {}),
    maxRows: init.maxRows,
    confirmedDestructive: init.confirmedDestructive ?? false,
    status: 'starting',
    startedAt: init.now ?? Date.now(),
    endedAt: null,
    elapsedMs: null,
    batchCount: init.batches.length,
    batchStates: [],
    resultSets: [],
    messages: [],
    rowsAffected: 0,
    errorCount: 0,
    diagnostics: [],
    txOpen: null,
  };
}

/** Apply several events at once; copies the wrapper arrays at most once per call. */
export function applyEvents(prev: ExecutionState, events: readonly WsEvent[], now: number = Date.now()): ExecutionState {
  if (events.length === 0) return prev;
  const s: ExecutionState = { ...prev };
  let resultSets: ResultSetState[] | null = null;
  let messages: ExecMessage[] | null = null;
  let batchStates: BatchState[] | null = null;
  const touched = new Set<number>();
  let seq = prev.messages.length ? prev.messages[prev.messages.length - 1].seq : 0;

  const rsList = () => (resultSets ??= [...prev.resultSets]);
  const msgList = () => (messages ??= [...prev.messages]);
  const bList = () => (batchStates ??= [...prev.batchStates]);
  const addMsg = (m: Omit<ExecMessage, 'seq' | 'ts'>) => msgList().push({ ...m, seq: ++seq, ts: now });
  const rsIndex = (id: number) => rsList().findIndex((r) => r.id === id);
  const editRs = (id: number): ResultSetState | null => {
    const list = rsList();
    const i = rsIndex(id);
    if (i < 0) return null;
    if (!touched.has(id)) {
      list[i] = { ...list[i] };
      touched.add(id);
    }
    return list[i];
  };
  const setBatch = (index: number, p: Partial<BatchState>) => {
    const list = bList();
    const i = list.findIndex((b) => b.index === index);
    if (i < 0) list.push({ index, status: 'running', elapsedMs: null, ...p });
    else list[i] = { ...list[i], ...p };
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'exec.started':
        s.status = 'running';
        s.batchCount = ev.batchCount;
        s.sessionId = ev.sessionId;
        if (!s.executionId) s.executionId = ev.executionId;
        break;
      case 'exec.batch.started':
        if (s.status === 'starting') s.status = 'running';
        setBatch(ev.batchIndex, { status: 'running' });
        break;
      case 'exec.resultset': {
        if (s.status === 'starting') s.status = 'running';
        const list = rsList();
        const rs: ResultSetState = {
          id: ev.resultSetId, batchIndex: ev.batchIndex, columns: ev.columns, rows: new ChunkedList(), rowCount: 0,
          truncated: false, elapsedMs: null, done: false, rev: 0,
        };
        const i = rsIndex(ev.resultSetId);
        if (i >= 0) list[i] = rs;
        else list.push(rs);
        touched.add(ev.resultSetId);
        break;
      }
      case 'exec.rows': {
        const rs = editRs(ev.resultSetId);
        if (!rs) break;
        rs.rows.pushAll(ev.rows);
        rs.rowCount = rs.rows.length;
        rs.rev++;
        break;
      }
      case 'exec.resultset.end': {
        const rs = editRs(ev.resultSetId);
        if (!rs) break;
        rs.done = true;
        rs.truncated = ev.truncated;
        rs.elapsedMs = ev.elapsedMs;
        rs.rowCount = Math.max(rs.rows.length, ev.rowCount);
        rs.rev++;
        break;
      }
      case 'exec.affected':
        s.rowsAffected += ev.count;
        addMsg({
          severity: 'info', text: `${ev.statementKind ? `${ev.statementKind}: ` : ''}${ev.count} row${ev.count === 1 ? '' : 's'} affected`,
          line: s.batches[ev.batchIndex]?.line ?? null, col: null, code: null, source: 'engine', batchIndex: ev.batchIndex,
        });
        break;
      case 'exec.message':
        addMsg({
          severity: ev.severity, text: ev.text, line: ev.line, col: null, code: ev.code === null ? null : String(ev.code),
          source: ev.source, batchIndex: ev.batchIndex,
        });
        if (ev.severity === 'error') s.errorCount++;
        break;
      case 'exec.error':
        s.errorCount++;
        addMsg({
          severity: 'error', text: ev.message + (ev.detail ? `\n${ev.detail}` : ''), line: ev.line ?? s.batches[ev.batchIndex]?.line ?? null,
          col: ev.col, code: ev.code, source: 'server', batchIndex: ev.batchIndex,
        });
        break;
      case 'exec.batch.ended':
        setBatch(ev.batchIndex, { status: ev.status, elapsedMs: ev.elapsedMs });
        break;
      case 'exec.diagnostics':
        s.diagnostics = [...s.diagnostics, ...ev.diagnostics];
        break;
      case 'exec.done': {
        s.status = ev.status;
        s.elapsedMs = ev.elapsedMs;
        s.endedAt = now;
        s.txOpen = ev.txOpen;
        if (ev.rowsAffected > s.rowsAffected) s.rowsAffected = ev.rowsAffected;
        // Result sets that never got an explicit end (cancel) are closed now.
        for (const r of rsList()) {
          if (!r.done) {
            const e = editRs(r.id)!;
            e.done = true;
            e.rev++;
          }
        }
        // Values of out / in-out binds (Oracle OUT parameters, Execute routine): one more result set with one row,
        // a column per parameter, after the ones the statements returned.
        const outs = Array.isArray(ev.outParams) ? ev.outParams : [];
        if (outs.length) {
          const list = rsList();
          const id = list.reduce((m, r) => Math.max(m, r.id), -1) + 1;
          const columns: ColumnInfo[] = outs.map((o, i) => ({
            name: o.name, ordinal: i, dbType: 'out parameter', kind: outKind(o.value), nullable: true, size: null, precision: null, scale: null,
            table: null, schema: null, isKey: false,
          }));
          list.push({
            id, batchIndex: Math.max(0, s.batchCount - 1), columns, rows: ChunkedList.from([outs.map((o) => o.value)]), rowCount: 1,
            truncated: false, elapsedMs: null, done: true, rev: 1,
          });
          addMsg({
            severity: 'info', text: `Output parameters: ${outs.map((o) => `${o.name} = ${o.value === null ? 'NULL' : String(o.value)}`).join(', ')}`,
            line: null, col: null, code: null, source: 'client', batchIndex: null,
          });
        }
        const verb = ev.status === 'ok' ? 'Completed' : ev.status === 'cancelled' ? 'Cancelled' : 'Finished with errors';
        const parts = [`${verb} in ${ev.elapsedMs} ms`];
        if (ev.resultSets) parts.push(`${ev.resultSets} result set${ev.resultSets === 1 ? '' : 's'}`);
        if (s.rowsAffected) parts.push(`${s.rowsAffected} row${s.rowsAffected === 1 ? '' : 's'} affected`);
        if (ev.txOpen) parts.push('transaction open');
        addMsg({
          severity: ev.status === 'error' ? 'error' : ev.status === 'cancelled' ? 'warning' : 'info', text: parts.join(' · '),
          line: null, col: null, code: null, source: 'client', batchIndex: null,
        });
        break;
      }
      default:
        break;
    }
  }
  if (resultSets) s.resultSets = resultSets;
  if (messages) s.messages = messages;
  if (batchStates) s.batchStates = batchStates;
  return s;
}

export function reduceExecution(prev: ExecutionState, ev: WsEvent, now?: number): ExecutionState {
  return applyEvents(prev, [ev], now);
}

/** Client-side failure before/while starting (e.g. POST /execute rejected). */
export function failExecution(prev: ExecutionState, text: string, code: string | null = null, now: number = Date.now()): ExecutionState {
  const seq = prev.messages.length ? prev.messages[prev.messages.length - 1].seq : 0;
  return {
    ...prev,
    status: 'error',
    endedAt: now,
    elapsedMs: now - prev.startedAt,
    errorCount: prev.errorCount + 1,
    messages: [...prev.messages, { seq: seq + 1, ts: now, severity: 'error', text, line: null, col: null, code, source: 'client', batchIndex: null }],
  };
}

export function isRunning(e: ExecutionState | undefined | null): boolean {
  return !!e && (e.status === 'starting' || e.status === 'running');
}

/** Grid kind of an out-parameter value (the wire carries no type for them). */
function outKind(v: CellValue): ColumnInfo['kind'] {
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'boolean') return 'bool';
  return 'string';
}
