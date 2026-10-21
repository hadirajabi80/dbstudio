// Routine result page model (WP3): the state of a `routine.run` tab and the split of an execution into "outputs"
// (OUT / IN OUT parameters and the return value, shown as a key/value card) and the ordinary result sets (tabs).
// Pure and unit-tested.
import type { CellValue, ColumnInfo, QueryParam } from '../../api/types';
import { isRunning, type ExecutionState, type ResultSetState } from '../../store/resultsReducer';
import type { ParamInput, RoutineSpec } from './routineSql';
import type { ExecuteRoutineRequest } from './store';

export const ROUTINE_RUN_VIEW = 'routine.run';

export interface RoutineRunState {
  /** The routine (no `fromTabId`: the page runs on its own session). */
  request: Omit<ExecuteRoutineRequest, 'fromTabId'>;
  spec: RoutineSpec;
  inputs: ParamInput[];
  /** The call as it last ran (re-run uses it when the form was not changed). */
  sql: string;
  params: QueryParam[];
  /** Number of runs started from this page (title of "Run again"). */
  runs: number;
}

export function routineRunKey(req: Pick<ExecuteRoutineRequest, 'connectionId' | 'database' | 'ref'>, spec: RoutineSpec): string {
  const sig = spec.params.map((p) => p.type).join(',');
  return `routine.run:${req.connectionId}:${req.database ?? req.ref.database ?? ''}:${spec.schema ?? ''}.${spec.packageName ?? ''}.${spec.name}(${sig})`;
}

export interface OutputEntry {
  name: string;
  value: CellValue;
  column: ColumnInfo;
}

export interface SplitResult {
  /** OUT / IN OUT values and the return value; null when the run returned none. */
  outputs: OutputEntry[] | null;
  /** Result set that holds the outputs (excluded from the tabs). */
  outputSetId: number | null;
  /** The result sets to show as tabs. */
  resultSets: ResultSetState[];
}

const OUT_DB_TYPE = 'out parameter';

function rowOf(rs: ResultSetState): CellValue[] | undefined {
  return rs.rows.get(0);
}

function asOutputs(rs: ResultSetState, rename?: (c: ColumnInfo, i: number) => string): OutputEntry[] {
  const row = rowOf(rs) ?? [];
  return rs.columns.map((c, i) => ({ name: rename ? rename(c, i) : c.name, value: row[i] ?? null, column: c }));
}

/**
 * Which result set carries the outputs:
 * - the engine's trailing "out parameter" set (Oracle OUT binds, function results; resultsReducer.ts);
 * - SQL Server procedures: the final `SELECT @return_value AS [Return value], @x AS [x]` of the generated call;
 * - PostgreSQL procedures with OUT / IN OUT arguments: CALL returns them as one row;
 * - scalar functions (SQL Server, PostgreSQL): the single one-row, one-column result is the return value.
 */
export function splitOutputs(exec: ExecutionState | undefined, spec: RoutineSpec): SplitResult {
  const sets = exec?.resultSets ?? [];
  if (!exec || !sets.length) return { outputs: null, outputSetId: null, resultSets: sets };
  const done = !isRunning(exec);
  const last = sets[sets.length - 1];
  const pick = (rs: ResultSetState, rename?: (c: ColumnInfo, i: number) => string): SplitResult => ({
    outputs: asOutputs(rs, rename), outputSetId: rs.id, resultSets: sets.filter((r) => r.id !== rs.id),
  });

  const engineOuts = sets.find((r) => r.columns.length > 0 && r.columns.every((c) => c.dbType === OUT_DB_TYPE));
  if (engineOuts) {
    const isResult = (c: ColumnInfo) => spec.kind === 'func' && spec.dialect === 'plsql' && /^result_*$/.test(c.name);
    return pick(engineOuts, (c) => (isResult(c) ? 'Return value' : c.name));
  }
  if (!done || !last.done || last.rowCount !== 1) return { outputs: null, outputSetId: null, resultSets: sets };

  if (spec.dialect === 'tsql' && spec.kind === 'proc' && last.columns[0]?.name === 'Return value') return pick(last);
  if (spec.dialect === 'pgsql' && spec.kind === 'proc' && spec.params.some((p) => p.direction !== 'in') && sets.length === 1) return pick(last);
  if (spec.kind === 'func' && spec.dialect !== 'plsql' && sets.length === 1 && last.columns.length === 1) return pick(last, () => 'Return value');
  return { outputs: null, outputSetId: null, resultSets: sets };
}

/** Rows of every shown result set (header line). */
export function totalRows(sets: readonly ResultSetState[]): number {
  return sets.reduce((n, r) => n + r.rowCount, 0);
}
