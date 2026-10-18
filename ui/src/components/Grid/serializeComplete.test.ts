// logic-12: copy / client-side export never writes a truncated wire value as if it were complete.
import { describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { partialCells, resolvePartialValues, serializeComplete, truncationWarning, type CellFetcher } from '../../lib/serialize';

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 't', schema: null, isKey: false,
});
const COLS = [col('Id', 'int', 0), col('Doc', 'string', 1), col('Pic', 'binary', 2)];
const LONG = 'abc'.repeat(15_000);
const rows = (): CellValue[][] => [
  [1, { $trunc: 'abc', len: LONG.length }, { $bin: 'AAAA', len: 9000 }],
  [2, 'short', null],
];
const locate = (row: number, c: number) => ({ executionId: 'x1', resultSetId: 0, row, col: c });

describe('truncated values in copy / export (logic-12)', () => {
  it('finds partial cells (string prefix and binary prefix)', () => {
    expect(partialCells(rows())).toEqual([{ row: 0, col: 1 }, { row: 0, col: 2 }]);
    expect(partialCells([[{ $bin: 'AAAA', len: 3 }]])).toEqual([]); // complete binary (len = payload)
  });

  it('fetches the full values from the result store before serializing', async () => {
    const fetch = vi.fn<CellFetcher>(async (l) => (l.col === 1 ? { kind: 'string', value: LONG, len: LONG.length } : { kind: 'binary', value: 'AQID', len: 3 }));
    const out = await serializeComplete('sql-insert', COLS, rows(), { dialect: 'sqlite', locate, fetch });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.warning).toBeNull();
    expect(out.text).toContain(LONG);
    expect(out.text).toContain("X'010203'");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith({ executionId: 'x1', resultSetId: 0, row: 0, col: 1 });
  });

  it('refuses SQL INSERT when the values cannot be fetched, and warns for the other formats', async () => {
    const ins = await serializeComplete('sql-insert', COLS, rows(), { dialect: 'tsql' });
    expect(ins).toEqual({ ok: false, message: '2 values are truncated; use Export instead' });
    const csv = await serializeComplete('csv', COLS, rows(), {});
    expect(csv.ok && csv.warning).toBe(truncationWarning(2));
  });

  it('a failed fetch leaves the value unresolved (never silently wrong)', async () => {
    const fetch: CellFetcher = async () => {
      throw new Error('expired');
    };
    const r = await resolvePartialValues(rows(), { locate, fetch });
    expect(r.unresolved).toBe(2);
    const out = await serializeComplete('sql-insert', COLS, rows(), { locate, fetch });
    expect(out.ok).toBe(false);
  });

  it('rows without partial values pass through untouched', async () => {
    const plain: CellValue[][] = [[1, 'a', null]];
    const r = await resolvePartialValues(plain, {});
    expect(r).toEqual({ rows: plain, unresolved: 0 });
    expect(truncationWarning(1)).toBe('1 value is truncated; use Export instead');
  });
});
