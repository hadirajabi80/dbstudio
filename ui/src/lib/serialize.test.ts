import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../api/types';
import { toJson } from './serialize';

const col = (name: string, kind: ColumnKind): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false,
});
const json = (columns: ColumnInfo[], rows: CellValue[][]) => JSON.parse(toJson(columns, rows)) as Record<string, unknown>[];

describe('toJson: one JSON type per numeric column (logic-24 e)', () => {
  it('a column with a value that does not survive as a number stays strings throughout', () => {
    const out = json([col('Price', 'decimal')], [['12.50'], ['-0.1'], [null]]);
    expect(out.map((r) => r.Price)).toEqual(['12.50', '-0.1', null]);
  });

  it('a column whose every value converts losslessly becomes numbers', () => {
    const out = json([col('Price', 'decimal')], [['1.5'], ['-0.1'], [null]]);
    expect(out.map((r) => r.Price)).toEqual([1.5, -0.1, null]);
  });

  it('big integers beyond 2^53 keep the whole column as strings, numbers included', () => {
    const out = json([col('Big', 'int')], [[1], ['9007199254740993']]);
    expect(out.map((r) => r.Big)).toEqual(['1', '9007199254740993']);
  });

  it('columns are decided independently; text columns are untouched', () => {
    const out = json([col('A', 'decimal'), col('B', 'decimal'), col('T', 'string')], [['2.0', '3', '007'], ['1', '4', '8']]);
    expect(out).toEqual([{ A: '2.0', B: 3, T: '007' }, { A: '1', B: 4, T: '8' }]);
  });
});
