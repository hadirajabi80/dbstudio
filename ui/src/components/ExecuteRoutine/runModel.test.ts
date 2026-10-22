// Routine result page model: which result set becomes the outputs card, per dialect and routine kind.
import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo } from '../../api/types';
import { ChunkedList } from '../../lib/chunked';
import { createExecution, type ExecutionState, type ResultSetState } from '../../store/resultsReducer';
import { argumentSummary } from './RoutineForm';
import { routineRunKey, splitOutputs, totalRows } from './runModel';
import type { RoutineSpec } from './routineSql';

const col = (name: string, dbType = 'int'): ColumnInfo => ({
  name, ordinal: 0, dbType, kind: 'int', nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false,
});

function rs(id: number, columns: ColumnInfo[], rows: CellValue[][], done = true): ResultSetState {
  return { id, batchIndex: 0, columns, rows: ChunkedList.from(rows), rowCount: rows.length, truncated: false, elapsedMs: 1, done, rev: 1 };
}

function exec(sets: ResultSetState[], status: ExecutionState['status'] = 'ok'): ExecutionState {
  return { ...createExecution({ localId: 'l1', tabId: 'v1', connectionId: 'c', sessionId: null, label: 'script', batches: [], maxRows: 100 }), status, resultSets: sets };
}

const spec = (p: Partial<RoutineSpec>): RoutineSpec => ({ dialect: 'tsql', kind: 'proc', schema: 'dbo', name: 'P', params: [], returnType: null, ...p });

describe('splitOutputs', () => {
  it('SQL Server procedure: the final "Return value" row is the outputs card, the other sets stay tabs', () => {
    const data = rs(0, [col('Id'), col('Name', 'nvarchar')], [[1, 'a'], [2, 'b']]);
    const outs = rs(1, [col('Return value'), col('Total', 'money')], [[0, '12.50']]);
    const s = splitOutputs(exec([data, outs]), spec({ params: [{ name: '@Total', type: 'money', direction: 'out', hasDefault: false }] }));
    expect(s.outputSetId).toBe(1);
    expect(s.outputs?.map((o) => [o.name, o.value])).toEqual([['Return value', 0], ['Total', '12.50']]);
    expect(s.resultSets.map((r) => r.id)).toEqual([0]);
    expect(totalRows(s.resultSets)).toBe(2);
  });

  it('engine "out parameter" set (Oracle): function result is shown as the return value', () => {
    const outs = rs(3, [col('p_out', 'out parameter'), col('result', 'out parameter')], [[7, 42]]);
    const s = splitOutputs(exec([rs(0, [col('X')], [[1]]), outs]), spec({ dialect: 'plsql', kind: 'func' }));
    expect(s.outputs?.map((o) => [o.name, o.value])).toEqual([['p_out', 7], ['Return value', 42]]);
    expect(s.resultSets.map((r) => r.id)).toEqual([0]);
  });

  it('scalar function (SQL Server, PostgreSQL): the single 1×1 result is the return value', () => {
    const s = splitOutputs(exec([rs(0, [col('Result', 'decimal')], [['1.90']])]), spec({ kind: 'func' }));
    expect(s.outputs).toEqual([{ name: 'Return value', value: '1.90', column: expect.objectContaining({ name: 'Result' }) }]);
    expect(s.resultSets).toEqual([]);
    const pg = splitOutputs(exec([rs(0, [col('fn_tax', 'numeric')], [['1.90']])]), spec({ dialect: 'pgsql', kind: 'func' }));
    expect(pg.outputs?.[0].name).toBe('Return value');
  });

  it('PostgreSQL procedure with IN OUT arguments: CALL returns them as one row', () => {
    const s = splitOutputs(exec([rs(0, [col('p_line_no')], [[3]])]), spec({ dialect: 'pgsql', params: [{ name: 'p_line_no', type: 'integer', direction: 'inout', hasDefault: true }] }));
    expect(s.outputs?.[0]).toMatchObject({ name: 'p_line_no', value: 3 });
  });

  it('table functions and ordinary result sets are never taken as outputs; nothing while running', () => {
    expect(splitOutputs(exec([rs(0, [col('id')], [[1]])]), spec({ kind: 'tablefunc' })).outputs).toBeNull();
    expect(splitOutputs(exec([rs(0, [col('Return value')], [[0]])], 'running'), spec({})).outputs).toBeNull();
    expect(splitOutputs(undefined, spec({})).resultSets).toEqual([]);
  });
});

describe('result page helpers', () => {
  it('argument summary quotes strings and names NULL / default / output', () => {
    const s = spec({
      params: [
        { name: '@Id', type: 'int', direction: 'in', hasDefault: false }, { name: '@Name', type: 'nvarchar(50)', direction: 'in', hasDefault: false },
        { name: '@Flag', type: 'bit', direction: 'in', hasDefault: true }, { name: '@Out', type: 'int', direction: 'out', hasDefault: false },
        { name: '@Note', type: 'nvarchar(10)', direction: 'in', hasDefault: false },
      ],
    });
    const args = argumentSummary(s, [{ mode: 'value', value: '5' }, { mode: 'value', value: 'Ann' }, { mode: 'default', value: '' }, { mode: 'value', value: '' }, { mode: 'null', value: '' }]);
    expect(args.map((a) => `${a.name}=${a.text}`)).toEqual(['Id=5', "Name='Ann'", 'Flag=default', 'Out=output', 'Note=NULL']);
  });

  it('one result page per routine and signature', () => {
    const req = { connectionId: 'c1', database: 'Shop', ref: { database: null, schema: 'dbo', name: 'P', type: 'proc' as const } };
    expect(routineRunKey(req, spec({}))).toBe('routine.run:c1:Shop:dbo..P()');
    expect(routineRunKey(req, spec({ params: [{ name: '@a', type: 'int', direction: 'in', hasDefault: false }] }))).not.toBe(routineRunKey(req, spec({})));
  });
});
