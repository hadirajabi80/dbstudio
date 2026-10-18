import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { ChunkedList } from '../../lib/chunked';
import { computeView } from '../evaluate';
import { newCondition, newGroup } from '../model';

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: null, schema: null, isKey: false,
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Median wall time of `runs` calls (after one warm-up call for the JIT). */
function time(fn: () => void, runs = 5): number {
  fn();
  const out: number[] = [];
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return median(out);
}

// The suite runs test files in parallel on shared (and sometimes busy) machines, so a fixed wall-clock budget
// measures the machine rather than the filter (logic-23). The filter is compared with a calibration loop that
// does the minimum per-row work on the same data in the same process and moment (a scan reading the three cells
// and doing one case-insensitive contains): a slowdown in the evaluator shows up as a higher ratio whatever the
// load. The absolute PLAN budget (< 300 ms for 1M rows × 3 conditions) is checked only on request
// (DBSTUDIO_PERF=1, e.g. `DBSTUDIO_PERF=1 npx vitest run src/filter/__tests__/perf.test.ts`) on an idle machine.
describe('filter performance', () => {
  it('1M rows × 3 conditions: within a calibrated multiple of a plain scan', { timeout: 120_000 }, () => {
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

    let idx: Uint32Array = new Uint32Array();
    let hits = 0;
    const baseline = time(() => {
      hits = 0;
      for (let i = 0; i < N; i++) {
        const r = rows.get(i)!;
        if (String(r[1]).toLowerCase().includes('acme') && Number(r[2]) > 100 && String(r[3]) > '2026-03-01') hits++;
      }
    });
    const ms = time(() => {
      idx = computeView(rows, columns, view)!;
    });

    expect(idx.length).toBeGreaterThan(0);
    expect(idx.length).toBeLessThan(N / 8);
    expect(idx.length).toBe(hits);
    // Generous: the evaluator compiles operands once, so it should stay within a small multiple of the bare scan.
    expect(ms / Math.max(baseline, 1)).toBeLessThan(8);
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (env?.DBSTUDIO_PERF) expect(ms).toBeLessThan(300);
  });
});
