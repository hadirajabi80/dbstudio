import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, WsEvent } from '../api/types';
import { applyEvents, createExecution, failExecution, reduceExecution, type ExecutionState } from './resultsReducer';

const ts = '2026-10-14T10:00:00Z';
const col = (name: string, kind: ColumnInfo['kind'] = 'int', ordinal = 0): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 't', schema: 'main', isKey: false,
});
const X = 'x_1';

function exec(): ExecutionState {
  return createExecution({
    localId: 'l1', tabId: 't1', connectionId: 'c1', sessionId: 's1', label: 'script', maxRows: 1000, now: 1000,
    batches: [{ sql: 'SELECT 1', line: 1, col: 1 }, { sql: 'UPDATE t SET a = 1 WHERE b = 2', line: 3, col: 1 }],
  });
}
const ev = (e: Record<string, unknown>) => ({ ts, executionId: X, ...e }) as unknown as WsEvent;

describe('results streaming reducer', () => {
  it('builds result sets, messages and final status from an event stream', () => {
    let s = exec();
    s = reduceExecution(s, ev({ type: 'exec.started', sessionId: 's1', batchCount: 2 }));
    expect(s.status).toBe('running');
    s = applyEvents(s, [
      ev({ type: 'exec.batch.started', batchIndex: 0 }),
      ev({ type: 'exec.resultset', resultSetId: 0, batchIndex: 0, columns: [col('a'), col('b', 'string', 1)] }),
      ev({ type: 'exec.rows', resultSetId: 0, rows: [[1, 'x'], [2, null]] }),
      ev({ type: 'exec.rows', resultSetId: 0, rows: [[3, 'z']] }),
      ev({ type: 'exec.resultset.end', resultSetId: 0, rowCount: 3, truncated: true, elapsedMs: 5 }),
      ev({ type: 'exec.batch.ended', batchIndex: 0, elapsedMs: 6, status: 'ok' }),
      ev({ type: 'exec.batch.started', batchIndex: 1 }),
      ev({ type: 'exec.message', batchIndex: 1, severity: 'info', text: 'hello', line: 4, code: null, source: 'dbmsOutput' }),
      ev({ type: 'exec.affected', batchIndex: 1, count: 3, statementKind: 'UPDATE' }),
      ev({ type: 'exec.error', batchIndex: 1, code: '207', message: "Invalid column name 'x'.", line: 3, col: 8, detail: null }),
      ev({ type: 'exec.batch.ended', batchIndex: 1, elapsedMs: 2, status: 'error' }),
      ev({ type: 'exec.done', sessionId: 's1', status: 'error', elapsedMs: 12, resultSets: 1, rowsAffected: 3, txOpen: true }),
    ], 2000);

    expect(s.resultSets).toHaveLength(1);
    const rs = s.resultSets[0];
    expect(rs.rows.length).toBe(3);
    expect(rs.rows.get(1)).toEqual([2, null]);
    expect(rs.truncated).toBe(true);
    expect(rs.done).toBe(true);
    expect(s.rowsAffected).toBe(3);
    expect(s.errorCount).toBe(1);
    expect(s.status).toBe('error');
    expect(s.txOpen).toBe(true);
    expect(s.elapsedMs).toBe(12);
    expect(s.batchStates.map((b) => b.status)).toEqual(['ok', 'error']);
    const texts = s.messages.map((m) => m.text);
    expect(texts[0]).toBe('hello');
    expect(texts[1]).toBe('UPDATE: 3 rows affected');
    expect(s.messages[2]).toMatchObject({ severity: 'error', line: 3, col: 8, code: '207' });
    expect(texts[3]).toMatch(/^Finished with errors in 12 ms/);
    // affected message points at the batch's first line for click-to-line
    expect(s.messages[1].line).toBe(3);
  });

  it('keeps previous state objects untouched except for the shared row storage', () => {
    let s = exec();
    s = applyEvents(s, [ev({ type: 'exec.resultset', resultSetId: 0, batchIndex: 0, columns: [col('a')] })]);
    const before = s;
    const rsBefore = s.resultSets[0];
    const after = applyEvents(s, [ev({ type: 'exec.rows', resultSetId: 0, rows: [[1]] })]);
    expect(after).not.toBe(before);
    expect(after.resultSets).not.toBe(before.resultSets);
    expect(after.resultSets[0]).not.toBe(rsBefore);
    expect(after.resultSets[0].rev).toBe(rsBefore.rev + 1);
    expect(rsBefore.rowCount).toBe(0); // wrapper of the old state is unchanged
    expect(after.resultSets[0].rows).toBe(rsBefore.rows); // rows are appended in place, never copied
  });

  it('handles multiple result sets and cancellation without explicit resultset.end', () => {
    let s = exec();
    s = applyEvents(s, [
      ev({ type: 'exec.resultset', resultSetId: 0, batchIndex: 0, columns: [col('a')] }),
      ev({ type: 'exec.resultset.end', resultSetId: 0, rowCount: 0, truncated: false, elapsedMs: 1 }),
      ev({ type: 'exec.resultset', resultSetId: 1, batchIndex: 0, columns: [col('b')] }),
      ev({ type: 'exec.rows', resultSetId: 1, rows: [[1], [2]] }),
      ev({ type: 'exec.done', sessionId: 's1', status: 'cancelled', elapsedMs: 40, resultSets: 2, rowsAffected: 0, txOpen: false }),
    ]);
    expect(s.resultSets.map((r) => r.id)).toEqual([0, 1]);
    expect(s.resultSets[1].done).toBe(true);
    expect(s.resultSets[1].rowCount).toBe(2);
    expect(s.status).toBe('cancelled');
    expect(s.messages.at(-1)?.severity).toBe('warning');
  });

  it('ignores rows for unknown result sets and records client-side failures', () => {
    let s = exec();
    s = applyEvents(s, [ev({ type: 'exec.rows', resultSetId: 9, rows: [[1]] })]);
    expect(s.resultSets).toHaveLength(0);
    s = failExecution(s, 'SESSION_BUSY', 'SESSION_BUSY', 1500);
    expect(s.status).toBe('error');
    expect(s.messages[0]).toMatchObject({ text: 'SESSION_BUSY', source: 'client' });
    expect(s.elapsedMs).toBe(500);
  });

  it('appends 100k+ rows in frames quickly and without copying', () => {
    const columns = [col('id'), col('name', 'string', 1), col('ts', 'datetime', 2), col('amount', 'decimal', 3), col('flag', 'bool', 4)];
    let s = applyEvents(exec(), [ev({ type: 'exec.resultset', resultSetId: 0, batchIndex: 0, columns })]);
    const FRAME = 200;
    const TOTAL = 120_000;
    // Pre-build frames so the measurement covers only the reducer.
    const frames: WsEvent[] = [];
    for (let i = 0; i < TOTAL; i += FRAME) {
      const rows: CellValue[][] = [];
      for (let j = i; j < i + FRAME; j++) rows.push([j, `name ${j}`, '2026-10-14T10:00:00', '12.50', j % 2 === 0]);
      frames.push(ev({ type: 'exec.rows', resultSetId: 0, rows }));
    }
    const storage = s.resultSets[0].rows;
    const t0 = performance.now();
    // Simulate one store flush per animation frame with ~10 WS frames each.
    for (let i = 0; i < frames.length; i += 10) s = applyEvents(s, frames.slice(i, i + 10));
    const elapsed = performance.now() - t0;

    const rs = s.resultSets[0];
    expect(rs.rows).toBe(storage);
    expect(rs.rows.length).toBe(TOTAL);
    expect(rs.rowCount).toBe(TOTAL);
    expect(rs.rows.get(TOTAL - 1)?.[0]).toBe(TOTAL - 1);
    expect(rs.rows.get(54321)?.[1]).toBe('name 54321');
    // Chunked storage: no single huge array is ever re-allocated.
    expect(rs.rows.chunks.length).toBeGreaterThan(50);
    // Generous bound for CI machines; typically ~10-30 ms.
    expect(elapsed).toBeLessThan(400);
  });
});
