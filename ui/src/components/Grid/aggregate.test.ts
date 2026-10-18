import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnKind } from '../../api/types';
import { aggregateCells, groupDigits } from './aggregate';

const cells = (kind: ColumnKind, values: CellValue[]) => values.map((value) => ({ value, kind }));

describe('selection aggregates (prop-01)', () => {
  it('Count / Sum / Avg / Min / Max over numeric cells, NULLs counted as cells only', () => {
    const a = aggregateCells(cells('decimal', ['12.00', '980.00', null, '3520.30']));
    expect(a).toMatchObject({ cells: 4, count: 3, numeric: 3, sum: '4512.30', min: '12.00', max: '3520.30', distinct: null });
  });

  it('max/min compare numerically, not as text', () => {
    const a = aggregateCells(cells('decimal', ['12.00', '980.00', '3520.30']));
    expect(a.max).toBe('3520.30');
    expect(a.min).toBe('12.00');
    expect(a.avg).toBe('1504.1');
  });

  it('sums decimals exactly (no float drift)', () => {
    const a = aggregateCells(cells('decimal', ['0.1', '0.2', '0.3']));
    expect(a.sum).toBe('0.6');
    expect(aggregateCells(cells('decimal', ['-1.50', '1.25'])).sum).toBe('-0.25');
    expect(aggregateCells(cells('int', ['9007199254740993', '1'])).sum).toBe('9007199254740994');
  });

  it('ints from the wire as numbers; non-finite values fall back to text', () => {
    const a = aggregateCells(cells('int', [1, 2, 3, 4]));
    expect(a).toMatchObject({ sum: '10', avg: '2.5', min: '1', max: '4' });
  });

  it('text selections report distinct values; mixed selections aggregate the numbers and count distinct text', () => {
    expect(aggregateCells(cells('string', ['a', 'b', 'a', null]))).toMatchObject({ cells: 4, count: 3, numeric: 0, sum: null, distinct: 2 });
    const mixed = aggregateCells([...cells('int', [5, 7]), ...cells('string', ['x', 'x'])]);
    expect(mixed).toMatchObject({ numeric: 2, sum: '12', distinct: 1 });
  });

  it('numeric-looking strings in a text column are not summed', () => {
    expect(aggregateCells(cells('string', ['1', '2'])).sum).toBeNull();
  });

  it('groups digits for display', () => {
    expect(groupDigits('4512.3')).toBe('4,512.3');
    expect(groupDigits('-1234567')).toBe('-1,234,567');
    expect(groupDigits('n/a')).toBe('n/a');
  });
});
