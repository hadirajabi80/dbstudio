import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { ChunkedList } from '../../lib/chunked';
import { computeView } from '../evaluate';
import { newCondition, newGroup } from '../model';

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false,
});

describe('filter performance', () => {
  it('1M rows × 3 conditions evaluate in < 300 ms', { retry: 2, timeout: 120_000 }, () => {
    const N = 1_000_000;
    const rows = new ChunkedList<CellValue[]>();
    const names = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka'];
    for (let i = 0; i < N; i++) {
      rows.push([i, `${names[i & 7]} ${i % 997}`, `${(i % 5000) / 4}.25`, `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00`]);
    }
    const columns = [col('id', 'int', 0), col('name', 'string', 1), col('total', 'decimal', 2), col('created', 'datetime', 3)];
    const filter = newGroup('and', [
      newCondition('name', 'contains', ['acme']),
      newCondition('total', 'gt', ['100']),
      newCondition('created', 'after', ['2026-03-01']),
    ]);
    const view = { quickFilter: '', filter, sort: [] };
    computeView(rows, columns, view); // warm-up (JIT)
    // Best of 7 (+ retries): the suite runs files in parallel, so a single sample measures the machine, not the filter.
    let ms = Infinity;
    let idx: Uint32Array = new Uint32Array();
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      idx = computeView(rows, columns, view)!;
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThan(N / 8);
    expect(ms).toBeLessThan(300);
  });
});
