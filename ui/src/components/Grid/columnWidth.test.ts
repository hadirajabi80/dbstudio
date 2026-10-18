import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { distributeSpare, ellipsize, estimateMeasure, naturalWidths } from './columnWidth';

const col = (name: string, kind: ColumnKind): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false,
});
const list = (rows: CellValue[][]) => ({ length: rows.length, get: (i: number) => rows[i] });
const OPTS = { font: '13px mono', headerFont: '600 12px mono', measure: estimateMeasure, padding: 8 };

describe('auto column widths (styles-15)', () => {
  it('date/time columns always fit their full formatted value', () => {
    const rows = list([['2024-08-17 01:38:42.123']]);
    const [w] = naturalWidths([col('CreatedAt', 'datetime')], rows, (v) => String(v), OPTS);
    const text = estimateMeasure('2024-08-17 01:38:42.123', OPTS.font);
    expect(w.width).toBeGreaterThanOrEqual(Math.ceil(text + 18));
  });

  it('text columns are capped initially but remember what they need', () => {
    const long = 'x'.repeat(200);
    const [w] = naturalWidths([col('Email', 'string')], list([[long]]), (v) => String(v), { ...OPTS, maxText: 300 });
    expect(w.width).toBe(300);
    expect(w.desired).toBeGreaterThan(1000);
  });

  it('the header is never cut', () => {
    const [w] = naturalWidths([col('AVeryLongColumnHeaderName', 'int')], list([[1]]), (v) => String(v), OPTS);
    expect(w.width).toBeGreaterThan(estimateMeasure('AVeryLongColumnHeaderName', OPTS.headerFont));
  });

  it('spare width goes to truncated columns, up to the cap; fitting columns keep their width', () => {
    const cols = [{ width: 100, desired: 100 }, { width: 300, desired: 700 }, { width: 300, desired: 2000 }];
    expect(distributeSpare(cols, 600)).toEqual([100, 300, 300]); // no spare
    const w = distributeSpare(cols, 1400);
    expect(w[0]).toBe(100);
    expect(w[1]).toBeGreaterThan(300);
    expect(w[2]).toBeLessThanOrEqual(800);
    expect(w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1400);
    expect(distributeSpare(cols, 10_000)).toEqual([100, 700, 800]);
  });

  it('ellipsizes overflowing text instead of clipping mid-glyph', () => {
    const font = '10px mono'; // 5.5 px per char in the estimate
    expect(ellipsize('short', 100, font, estimateMeasure)).toBe('short');
    const e = ellipsize('sophia.muller@example.com', 60, font, estimateMeasure);
    expect(e.endsWith('…')).toBe(true);
    expect(estimateMeasure(e, font)).toBeLessThanOrEqual(60);
    expect(ellipsize('line one\nline two', 1000, font, estimateMeasure)).toBe('line one…');
  });
});
