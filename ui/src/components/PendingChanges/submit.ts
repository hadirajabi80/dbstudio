// Turns a grid's pending edits into statements, runs them in one transaction on the tab's session, and refetches
// the affected rows so identities, defaults and trigger effects show up (PLAN-M1.5 A1).
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import {
  generateChanges, refetchSql, releaseSavepointSql, rollbackToSavepointSql, savepointSql, type ColumnValue, type GenStatement, type RowChange,
  type TableTarget,
} from '../../data/sqlgen';
import { useEdits, type Pending, type RowIssue } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { getSqlRunner, type SqlRunner } from '../DataTab/runner';

export interface EditContext {
  gridKey: string;
  /** Tab owning the session the changes run on. */
  tabId: string;
  connectionId: string;
  database: string | null;
  dialect: Dialect;
  target: TableTarget;
  columns: ColumnInfo[];
  /** Committed row values by source index (base rows overlaid with earlier submits). */
  rowAt(sourceRow: number): readonly CellValue[] | undefined;
  /** Number of source rows (base + appended), so refetched inserts get stable indices. */
  sourceLength: number;
  sqliteVersion?: string | null;
  tabTitle?: string;
  /** Serializes with other statements on the same session (Data tab page loads). */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const keyIndex = (ctx: EditContext) =>
  ctx.target.keyColumns.map((k) => ctx.columns.findIndex((c) => c.name.toLowerCase() === k.toLowerCase()));

/** Pending buffer → row changes (UPDATE only lists changed columns; INSERT only touched ones). */
export function buildRowChanges(ctx: EditContext, p: Pending): RowChange[] {
  const keys = keyIndex(ctx);
  const out: RowChange[] = [];
  const keyOf = (row: readonly CellValue[]): ColumnValue[] => keys.map((i) => ({ column: ctx.columns[i], value: row[i] ?? null }));
  for (const r of Object.keys(p.deletes).map(Number)) {
    const row = ctx.rowAt(r);
    if (!row) continue;
    out.push({ kind: 'delete', ref: String(r), key: keyOf(row), original: ctx.columns.map((c, i) => ({ column: c, value: row[i] ?? null })) });
  }
  for (const [rs, cols] of Object.entries(p.updates)) {
    const r = Number(rs);
    if (p.deletes[r]) continue;
    const row = ctx.rowAt(r);
    if (!row) continue;
    const set = Object.entries(cols).map(([cs, value]) => {
      const c = Number(cs);
      return { column: ctx.columns[c], value, old: row[c] ?? null };
    });
    if (set.length) out.push({ kind: 'update', ref: rs, key: keyOf(row), set });
  }
  for (const ins of p.inserts) {
    const values = Object.keys(ins.touched).map(Number).sort((a, b) => a - b).map((c) => ({ column: ctx.columns[c], value: ins.values[c] ?? null }));
    out.push({ kind: 'insert', ref: ins.id, values });
  }
  return out;
}

export function buildStatements(ctx: EditContext, p: Pending, verifyUnchanged: boolean): GenStatement[] {
  return generateChanges(buildRowChanges(ctx, p), ctx.target, ctx.dialect, { verifyUnchanged, sqliteVersion: ctx.sqliteVersion, columns: ctx.columns });
}

export interface SubmitResult {
  ok: boolean;
  /** Statements executed successfully before a failure (all undone: full rollback, or back to the savepoint). */
  executed: number;
  error: string | null;
  issues: RowIssue[];
  /** The saved changes wait in an open transaction (manual mode), as the engine reported it after this submit's
   *  statements; never assumed from the transaction mode alone. */
  leftOpen: boolean;
}

/**
 * Run every statement in one transaction; on any error or conflict undo them and keep the buffer.
 *
 * - Session in auto mode: switch to manual for the submit, COMMIT on success, full ROLLBACK on failure, back to auto.
 * - Session in manual mode with an open transaction: the user may have uncommitted work in that transaction, so a
 *   savepoint is set first and a failure rolls back only to it; the transaction stays open.
 * - Session in manual mode with nothing open (fresh console, or just after Commit): this submit's statements open the
 *   transaction, so it owns it as the auto path does (no savepoint, full ROLLBACK on failure), but it stays in manual
 *   mode and does not commit: the saved changes wait for the user's Commit (code-r1-01).
 */
export function submitChanges(ctx: EditContext, opts: { verifyUnchanged: boolean }): Promise<SubmitResult> {
  return ctx.exclusive ? ctx.exclusive(() => submitNow(ctx, opts)) : submitNow(ctx, opts);
}

async function submitNow(ctx: EditContext, opts: { verifyUnchanged: boolean }): Promise<SubmitResult> {
  const edits = useEdits.getState();
  const buf = edits.get(ctx.gridKey);
  const stmts = buildStatements(ctx, buf.pending, opts.verifyUnchanged);
  if (stmts.length === 0) return { ok: true, executed: 0, error: null, issues: [], leftOpen: false };
  edits.setStatus(ctx.gridKey, 'submitting');
  const sessions = useSessions.getState();
  const runner = getSqlRunner();
  let executed = 0;
  let wasAuto = true;
  /** This submit opened the transaction (auto mode, or manual mode with nothing open): a failure is a full ROLLBACK. */
  let ownsTx = true;
  let sid: string | null = null;
  /** A savepoint protects the user's own uncommitted work (manual mode with an open transaction). */
  let savepoint = false;
  /** Transaction state the engine reported after the latest statement of this submit (null = not reported yet). */
  let txOpen: boolean | null = null;
  const source = { tabId: ctx.tabId, title: ctx.tabTitle ?? `Edit ${ctx.target.name}` };
  const run: SqlRunner = async (...args) => {
    const res = await runner(...args);
    if (typeof res.txOpen === 'boolean') txOpen = res.txOpen;
    return res;
  };
  /** Undo this submit: back to the savepoint (user's open transaction) or a full rollback (the submit opened it). */
  const undo = async (): Promise<string> => {
    if (ownsTx) {
      await rollbackQuietly(ctx.tabId);
      if (wasAuto) await restoreAuto(ctx.tabId);
      return 'Nothing was saved.';
    }
    if (!savepoint || !sid) return 'Nothing was saved.';
    const note = await rollbackToSavepoint(run, sid, ctx, source);
    return note ?? 'Nothing was saved; the open transaction keeps your earlier uncommitted changes.';
  };
  try {
    const session = await sessions.ensure(ctx.tabId, ctx.connectionId, ctx.database, 'auto');
    wasAuto = session.txMode === 'auto';
    // The store follows the engine's session.changed events. With nothing open a savepoint protects nothing (SQL Server
    // even refuses SAVE TRANSACTION outside a transaction): the submit owns the transaction its statements open.
    ownsTx = wasAuto || !session.txOpen;
    sid = session.sessionId;
    if (wasAuto) await sessions.setTxMode(ctx.tabId, 'manual');
    else if (!ownsTx) {
      const sp = await run(sid, savepointSql(ctx.dialect), [], { label: 'data', source, confirmedDestructive: true, skipHistory: true });
      if (sp.status !== 'ok' || sp.error) {
        const message = `Could not set a savepoint in the open transaction: ${sp.error?.message ?? sp.status}. Nothing was run.`;
        useEdits.getState().setStatus(ctx.gridKey, 'idle', message, []);
        return { ok: false, executed: 0, error: message, issues: [], leftOpen: false };
      }
      savepoint = true;
    }
    const inserted = new Map<string, ColumnValue[]>();
    const fail = async (message: string, issue: RowIssue | null): Promise<SubmitResult> => {
      const tail = await undo();
      const issues = issue ? [issue] : [];
      const full = `${message} ${tail}`;
      useEdits.getState().setStatus(ctx.gridKey, 'idle', full, issues);
      return { ok: false, executed, error: full, issues, leftOpen: false };
    };

    for (const st of stmts) {
      const res = await run(sid, st.sql, st.params, { label: 'data', maxRows: 100, source, confirmedDestructive: true });
      if (res.status !== 'ok' || res.error) {
        return fail(`${describe(st)} failed: ${res.error?.message ?? res.status}.`, { ref: st.ref, kind: 'error', message: res.error?.message ?? 'Failed' });
      }
      if (st.expectOne && res.affectedReported && res.affected === 0) {
        return fail(
          `${describe(st)} affected 0 rows: the row was changed or deleted by someone else.`,
          { ref: st.ref, kind: 'conflict', message: 'Changed by someone else (0 rows affected)' },
        );
      }
      if (st.kind === 'insert') {
        let key = keyFromInsert(ctx, st, res.resultSets[0]?.columns, res.resultSets[0]?.rows[0], res.outParams);
        if (!key && st.followUp) {
          const f = await run(sid, st.followUp, [], { label: 'data', maxRows: 1, source });
          key = keyFromInsert(ctx, st, f.resultSets[0]?.columns, f.resultSets[0]?.rows[0], []);
        }
        if (key) inserted.set(st.ref, key);
      }
      executed++;
    }

    if (wasAuto) {
      await sessions.commit(ctx.tabId);
      await restoreAuto(ctx.tabId);
    } else if (savepoint) {
      const release = releaseSavepointSql(ctx.dialect);
      if (release) await run(sid, release, [], { label: 'data', source, skipHistory: true });
    }
    // Whether the changes wait for a Commit: what the engine reported after this submit's statements (the refetch
    // below only reads). Unknown (no report) falls back to the session's state.
    const leftOpen = !wasAuto && (txOpen ?? useSessions.getState().forTab(ctx.tabId)?.txOpen ?? false);

    // Refetch updated + inserted rows by key.
    const p = buf.pending;
    const keys = keyIndex(ctx);
    const updatedRows = Object.keys(p.updates).map(Number).filter((r) => !p.deletes[r]);
    const keyFor = (r: number): ColumnValue[] | null => {
      const row = ctx.rowAt(r);
      if (!row) return null;
      return keys.map((i) => ({ column: ctx.columns[i], value: (p.updates[r] && i in p.updates[r] ? p.updates[r][i] : row[i]) ?? null }));
    };
    const fetchKeys: { ref: string; key: ColumnValue[] }[] = [];
    for (const r of updatedRows) {
      const k = keyFor(r);
      if (k) fetchKeys.push({ ref: String(r), key: k });
    }
    for (const ins of p.inserts) {
      const k = inserted.get(ins.id) ?? userKey(ctx, ins.values, ins.touched);
      if (k) fetchKeys.push({ ref: ins.id, key: k });
    }
    const patched: Record<number, CellValue[]> = {};
    const appended: CellValue[][] = [];
    const fetched = new Map<string, CellValue[]>();
    if (fetchKeys.length) {
      for (let i = 0; i < fetchKeys.length; i += 200) {
        const chunk = fetchKeys.slice(i, i + 200);
        const q = refetchSql(ctx.target, ctx.dialect, chunk.map((k) => k.key));
        const res = await run(sid, q.sql, q.params, { label: 'data', maxRows: 0, source });
        const set = res.resultSets[0];
        if (!set) continue;
        const map = reorder(set.columns, ctx.columns);
        for (const row of set.rows) {
          const r = map(row);
          const sig = keySig(keys.map((k) => r[k] ?? null));
          fetched.set(sig, r);
        }
      }
    }
    for (const { ref, key } of fetchKeys) {
      const got = fetched.get(keySig(key.map((k) => k.value)));
      if (/^\d+$/.test(ref)) {
        if (got) patched[Number(ref)] = got;
        else {
          // Not found by key any more (key edited or filtered out by a trigger): show what we wrote.
          const row = ctx.rowAt(Number(ref));
          if (row) patched[Number(ref)] = row.map((v, c) => (p.updates[Number(ref)] && c in p.updates[Number(ref)] ? p.updates[Number(ref)][c] : v));
        }
      } else {
        const ins = p.inserts.find((x) => x.id === ref);
        appended.push(got ?? ins?.values ?? []);
      }
    }
    // Inserts we could not identify are still saved; show them as typed.
    for (const ins of p.inserts) if (!fetchKeys.some((k) => k.ref === ins.id)) appended.push(ins.values);
    useEdits.getState().commit(ctx.gridKey, { patched, hidden: Object.keys(p.deletes).map(Number), appended });
    return { ok: true, executed, error: null, issues: [], leftOpen };
  } catch (e) {
    const tail = await undo().catch(() => '');
    const message = `${e instanceof Error ? e.message : String(e)}${tail ? ` ${tail}` : ''}`;
    useEdits.getState().setStatus(ctx.gridKey, 'idle', message);
    return { ok: false, executed, error: message, issues: [], leftOpen: false };
  }
}

/** ROLLBACK TO the edit savepoint; returns a warning when it could not be restored (null = restored). */
async function rollbackToSavepoint(run: SqlRunner, sid: string, ctx: EditContext, source: { tabId: string; title: string }): Promise<string | null> {
  try {
    const r = await run(sid, rollbackToSavepointSql(ctx.dialect), [], { label: 'data', source, confirmedDestructive: true, skipHistory: true });
    if (r.status === 'ok' && !r.error) return null;
    // e.g. SQL Server ended the whole transaction on a severe error (XACT_ABORT, deadlock): there is nothing to restore.
    if (r.txOpen === false) return 'The server rolled back the whole open transaction, including earlier uncommitted changes.';
    return `Could not roll back to the savepoint (${r.error?.message ?? r.status}): check the open transaction before committing.`;
  } catch (e) {
    return `Could not roll back to the savepoint (${e instanceof Error ? e.message : String(e)}): check the open transaction before committing.`;
  }
}

function describe(st: GenStatement): string {
  return st.kind === 'update' ? 'UPDATE' : st.kind === 'insert' ? 'INSERT' : 'DELETE';
}

async function rollbackQuietly(tabId: string) {
  try {
    await useSessions.getState().rollback(tabId);
  } catch {
    /* session may be broken; nothing more to do */
  }
}

async function restoreAuto(tabId: string) {
  try {
    await useSessions.getState().setTxMode(tabId, 'auto');
  } catch {
    /* ignore */
  }
}

function keySig(values: readonly CellValue[]): string {
  return values.map((v) => (v === null ? '\u0000' : typeof v === 'object' ? JSON.stringify(v) : String(v).toLowerCase())).join('\u0001');
}

/** Map a refetched row (its own column order) to the grid's column order by name. */
function reorder(from: readonly ColumnInfo[], to: readonly ColumnInfo[]): (row: CellValue[]) => CellValue[] {
  const idx = to.map((c) => from.findIndex((f) => f.name.toLowerCase() === c.name.toLowerCase()));
  if (idx.every((v, i) => v === i) && from.length === to.length) return (r) => r;
  return (r) => idx.map((i) => (i >= 0 ? r[i] ?? null : null));
}

function userKey(ctx: EditContext, values: CellValue[], touched: Record<number, true>): ColumnValue[] | null {
  const keys = keyIndex(ctx);
  if (keys.some((i) => i < 0 || !touched[i] || values[i] === null)) return null;
  return keys.map((i) => ({ column: ctx.columns[i], value: values[i] }));
}

function keyFromInsert(
  ctx: EditContext, st: GenStatement, cols: ColumnInfo[] | undefined, row: CellValue[] | undefined, outParams: { name: string; value: CellValue }[],
): ColumnValue[] | null {
  if (!st.returning.length) return null;
  const ins = useEdits.getState().get(ctx.gridKey).pending.inserts.find((i) => i.id === st.ref);
  const keys = keyIndex(ctx);
  const out: ColumnValue[] = [];
  for (const i of keys) {
    const name = ctx.columns[i].name;
    const r = st.returning.findIndex((k) => k.toLowerCase() === name.toLowerCase());
    let v: CellValue | undefined;
    if (r >= 0) {
      if (row && cols) {
        const ci = cols.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        v = row[ci >= 0 ? ci : r];
      } else if (outParams.length) v = outParams.find((o) => o.name === `out${r + 1}`)?.value;
    } else v = ins?.values[i];
    if (v === undefined || v === null) return null;
    out.push({ column: ctx.columns[i], value: v });
  }
  return out;
}
