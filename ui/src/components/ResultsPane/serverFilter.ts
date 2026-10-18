// "Apply on server" for console result sets (PLAN-M1.5 1.1.1): rewrite the originating SELECT with the filter
// as a parameterized WHERE and run it as a new execution of the tab, replacing the current result.
import { api, errorMessage, isApiError } from '../../api/client';
import type { ColumnInfo, Dialect, ExecuteRequest, SqlBatch } from '../../api/types';
import { analyzeSelect, isSingleSelect, rewriteWithPredicate } from '../../filter/rewrite';
import { buildPredicate, inlineParams } from '../../filter/sql';
import type { FilterGroup, SortKey } from '../../filter/model';
import type { ExecParam } from '../../filter/wire';
import { getConnection } from '../../store/connections';
import { useFilters, type ServerFilterState } from '../../store/filters';
import { useResults, viewKey } from '../../store/results';
import { createExecution, isRunning, type ExecutionState, type ResultSetState } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { detectParams } from '../ParamsDialog/detect';

let seq = 0;

/** The statement the user wrote (unwrapped when the current result already comes from a server filter). */
export function originalBatch(exec: ExecutionState): SqlBatch | null {
  if (exec.batches.length !== 1) return null;
  const sf = useFilters.getState().serverFilters[exec.tabId];
  if (sf && exec.batches[0].sql === sf.sql) return sf.original;
  return exec.batches[0];
}

/**
 * The SELECT that produced `rs` (result-set "Code ▾" → codegen.query), or null: a script batch, a procedure call, or
 * a batch that returned several result sets (which statement made which cannot be told apart).
 */
export function originatingSelect(exec: ExecutionState, rs: Pick<ResultSetState, 'batchIndex'>, dialect: Dialect): string | null {
  if (exec.resultSets.filter((r) => r.batchIndex === rs.batchIndex).length > 1) return null;
  const batch = exec.batches.length === 1 ? originalBatch(exec) : exec.batches[rs.batchIndex];
  const sql = batch?.sql.trim().replace(/;\s*$/, '');
  return sql && isSingleSelect(sql, dialect) ? sql : null;
}

/**
 * Bind values of the statement the user ran: the execution's params without the server filter's own fp* binds
 * (a server-filtered execution carries both).
 */
export function originalParams(exec: ExecutionState): ExecParam[] {
  const params = exec.params ?? [];
  const sf = useFilters.getState().serverFilters[exec.tabId];
  if (sf && exec.batches.length === 1 && exec.batches[0].sql === sf.sql) {
    const fp = new Set(sf.params.map((p) => p.name));
    return params.filter((p) => !fp.has(p.name));
  }
  return params;
}

/** Why the original's bind parameters prevent a re-run, or null when they can be sent again. */
function paramsProblem(exec: ExecutionState, orig: SqlBatch, dialect: Dialect): string | null {
  const detected = detectParams([orig], dialect);
  if (detected.length === 0) return null;
  const stored = originalParams(exec);
  if (stored.length === 0) return 'The statement has bind parameters whose values were not kept; run it again to filter on the server';
  if (detected.some((d) => d.positional) || stored.some((p) => /^\d+$/.test(p.name))) {
    return 'Positional (?) parameters cannot be combined with the filter; use named parameters to filter on the server';
  }
  if (stored.some((p) => /^fp\d+$/i.test(p.name.replace(/^[@:$]/, '')))) return 'A parameter named fp1, fp2, … clashes with the filter parameters';
  return null;
}

export interface ServerAvailability {
  available: boolean;
  reason: string | null;
}

export function serverFilterAvailability(exec: ExecutionState, columns: readonly ColumnInfo[], dialect: Dialect): ServerAvailability {
  const orig = originalBatch(exec);
  if (!orig || exec.resultSets.length !== 1) return { available: false, reason: 'Server filtering needs a single SELECT (not a script or procedure)' };
  const a = analyzeSelect(orig.sql, dialect);
  if (!a.ok) return { available: false, reason: a.reason };
  const names = new Set<string>();
  for (const c of columns) {
    const n = c.name.toLowerCase();
    if (!n) return { available: false, reason: 'Server filtering needs a name for every column' };
    if (names.has(n)) return { available: false, reason: `Column “${c.name}” appears twice; alias it to filter on the server` };
    names.add(n);
  }
  const pp = paramsProblem(exec, orig, dialect);
  if (pp) return { available: false, reason: pp };
  if (isRunning(exec)) return { available: false, reason: 'Wait for the statement to finish' };
  return { available: true, reason: null };
}

export function previewServerSql(exec: ExecutionState, columns: readonly ColumnInfo[], dialect: Dialect, filter: FilterGroup | null, quick: string): string | null {
  const orig = originalBatch(exec);
  if (!orig) return null;
  const p = buildPredicate(filter, columns, dialect, { alias: 'q', quick });
  if (!p.where) return null;
  try {
    return inlineParams(rewriteWithPredicate(orig.sql, dialect, p.where).sql, p.params, dialect);
  } catch {
    return null;
  }
}

/** Run the rewritten statement (or the original when the filter is empty / cleared). */
export async function applyServerFilter(exec: ExecutionState, columns: ColumnInfo[], dialect: Dialect, filter: FilterGroup | null, quick: string, sort: SortKey[], clear = false): Promise<void> {
  const orig = originalBatch(exec);
  if (!orig) return;
  const pred = clear ? null : buildPredicate(filter, columns, dialect, { alias: 'q', quick });
  const problem = paramsProblem(exec, orig, dialect);
  if (problem) {
    toast('warning', 'Cannot filter on the server', problem);
    return;
  }
  // The user's own binds travel with every re-run (the filter adds fp1, fp2, … next to them).
  const userParams = originalParams(exec);
  let sql = orig.sql;
  let params: ExecParam[] = userParams;
  let filterParams: ExecParam[] = [];
  let limited = false;
  if (pred?.where) {
    try {
      const r = rewriteWithPredicate(orig.sql, dialect, pred.where);
      sql = r.sql;
      filterParams = pred.params;
      params = [...userParams, ...pred.params];
      limited = r.limited;
    } catch (e) {
      toast('warning', 'Cannot filter on the server', errorMessage(e));
      return;
    }
  } else if (!clear) {
    toast('info', 'Nothing to push to the server', 'Add a complete condition first (regular expressions only run in the grid).');
    return;
  }
  const tabId = exec.tabId;
  const conn = getConnection(exec.connectionId);
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!conn) return;
  const localId = `sf${++seq}`;
  const batches: SqlBatch[] = [{ sql, line: orig.line, col: orig.col }];
  useResults.getState().begin(createExecution({
    localId, tabId, connectionId: conn.id, sessionId: exec.sessionId, label: exec.label, batches, maxRows: exec.maxRows, params,
  }));
  const state: ServerFilterState | null = pred?.where
    ? { original: orig, sql, params: filterParams, filter, quick, clientOnly: pred.clientOnly, limited, maxRows: exec.maxRows }
    : null;
  useFilters.getState().setServerFilter(tabId, state);
  // Keep the filter visible (and applied client-side, which is idempotent) on the new result.
  useResults.getState().setGridView(viewKey(localId, 0), { filter: clear ? null : filter, quickFilter: clear ? '' : quick, sort });
  try {
    const session = useSessions.getState().forTab(tabId)
      ?? await useSessions.getState().ensure(tabId, conn.id, tab?.database ?? null, tab?.kind === 'console' ? tab.txMode : 'auto');
    const req: ExecuteRequest = {
      batches, maxRows: exec.maxRows, stopOnError: true, label: pred?.where ? 'filter' : exec.label,
      source: { tabId, title: tab?.title ?? 'Console' }, ...(params.length ? { params } : {}),
    };
    const res = await api.execute(session.sessionId, req);
    useResults.getState().attach(localId, res.executionId);
    if (pred?.where) {
      // Messages tab: the statement as sent, with its bind parameters listed separately (values are never inlined).
      const binds = filterParams.map((p) => `  ${dialect === 'plsql' ? ':' : '@'}${p.name} (${p.kind}) = ${JSON.stringify(p.value)}`).join('\n');
      useResults.getState().ingest({
        type: 'exec.message', ts: new Date().toISOString(), executionId: res.executionId, batchIndex: 0, severity: 'info',
        text: `Server filter:\n${sql}\nParameters:\n${binds}`,
        line: null, code: null, source: 'engine',
      });
    }
  } catch (e) {
    useResults.getState().fail(localId, errorMessage(e), isApiError(e) ? e.code : null);
  }
}
