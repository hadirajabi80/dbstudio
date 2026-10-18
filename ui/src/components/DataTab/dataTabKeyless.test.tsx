// features-r2-02: a keyless object (no primary key, no unique index) is counted BEFORE its first page, so its paging
// order is decided once: a small object is ordered from page 1, and "Load more" only appends (the rows on screen are
// never re-read or re-ordered). A large object, or one whose count is unknown, pages unordered and says so.
// The canvas grid is replaced by a probe.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { NO_KEY_ORDER_MAX_ROWS } from '../../data/sqlgen';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import type { ViewTab } from '../../store/tabs';
import type { DataGridProps } from '../Grid/DataGrid';
import { DataTabView, PRE_COUNT_TIMEOUT_MS } from './DataTabView';
import { setSqlRunner, type QueryOutcome } from './runner';

let gridProps: DataGridProps | null = null;
vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => {
    gridProps = p;
    return <div data-testid="grid" data-rows={p.rows.length} />;
  },
  rowValue: () => null,
}));

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'vbig', schema: 'main', isKey: false,
});
const COLUMNS = [col('a', 'int', 0), col('b', 'string', 1)];
const UNORDERED_HINT = 'No key column: rows beyond the first page may repeat or be skipped';

let total = 1500;
/** How the COUNT answers: a number, an error, or a slow count that only ends when cancelled. */
let countMode: 'ok' | 'error' | 'slow' = 'ok';
let releaseCount: (() => void) | null = null;
const calls: string[] = [];

function outcome(cols: ColumnInfo[], rows: CellValue[][], extra: Partial<QueryOutcome> = {}): QueryOutcome {
  return { executionId: 'x', status: 'ok', resultSets: [{ columns: cols, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 1, txOpen: false, ...extra };
}

/** Row i of the "storage order" (what an unordered read returns): a = total - 1 - i, so ORDER BY a reverses it. */
const storageRow = (i: number): CellValue[] => [total - 1 - i, `r${i + 1}`];

beforeAll(async () => {
  await useConnections.getState().load();
  setSqlRunner(async (_sid, sql) => {
    calls.push(sql);
    if (sql.includes('WHERE 1 = 0')) return outcome(COLUMNS, []);
    if (sql.startsWith('SELECT COUNT(*)')) {
      if (countMode === 'error') return outcome([], [], { status: 'error', resultSets: [], error: { message: 'count failed', code: null, line: null } });
      if (countMode === 'slow') {
        await new Promise<void>((r) => (releaseCount = r));
        return outcome([], [], { status: 'cancelled', resultSets: [] });
      }
      return outcome([col('row_count', 'int', 0)], [[total]]);
    }
    const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
    const [limit, offset] = [Number(m[1]), Number(m[2])];
    const ordered = /ORDER BY a, b/.test(sql);
    const rows: CellValue[][] = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) rows.push(ordered ? [i, `r${total - i}`] : storageRow(i));
    return outcome(COLUMNS, rows);
  });
});
afterAll(() => setSqlRunner(null));
beforeEach(() => {
  cleanup();
  calls.length = 0;
  gridProps = null;
  total = 1500;
  countMode = 'ok';
  releaseCount = null;
  useSessions.setState({ sessions: {}, byTab: {} });
});
afterEach(() => vi.restoreAllMocks());

const tab = (id: string, type: 'table' | 'view' = 'view'): ViewTab => ({
  kind: 'view', id, title: 'vbig', view: 'data', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'vbig', type },
});
const pages = () => calls.filter((c) => c.includes('LIMIT'));
const counts = () => calls.filter((c) => c.startsWith('SELECT COUNT(*)'));
const loadMore = () => act(async () => {
  gridProps!.onReachEnd!();
});

describe('keyless paging order is decided before the first page (features-r2-02)', () => {
  it('a 1,500-row keyless view is ordered from page 1, and Load more appends without replacing rows', async () => {
    render(<DataTabView tab={tab('kl-small')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    // probe, COUNT, then the first page already in column order
    expect(calls[0]).toBe('SELECT *\nFROM vbig\nWHERE 1 = 0');
    expect(calls[1]).toBe('SELECT COUNT(*) AS row_count\nFROM vbig');
    expect(pages()).toEqual(['SELECT *\nFROM vbig\nORDER BY a, b\nLIMIT 1000 OFFSET 0']);
    await screen.findByText(/1,000 of 1,500 rows/);
    expect(screen.queryByText(UNORDERED_HINT)).toBeNull();
    const rows = gridProps!.rows;
    const first = rows.get(0);
    const head = Array.from({ length: 1000 }, (_, i) => rows.get(i));
    expect(first).toEqual([0, 'r1500']);

    await loadMore();
    await until(() => gridProps!.rows.length === 1500);
    // Only the remainder is read, in the same order; the loaded rows are neither re-read nor replaced.
    expect(pages()).toEqual(['SELECT *\nFROM vbig\nORDER BY a, b\nLIMIT 1000 OFFSET 0', 'SELECT *\nFROM vbig\nORDER BY a, b\nLIMIT 1000 OFFSET 1000']);
    expect(gridProps!.rows.get(0)).toBe(first);
    for (let i = 0; i < 1000; i++) expect(gridProps!.rows.get(i)).toBe(head[i]);
    expect(gridProps!.rows.get(1000)).toEqual([1000, 'r500']);
    expect(counts()).toHaveLength(1);
    expect(screen.queryByText(UNORDERED_HINT)).toBeNull();
    expect(screen.getByText(/^1,500 rows/)).toBeInTheDocument();
  });

  it('a keyless object above the sort limit stays unordered on every page, with the hint', async () => {
    total = NO_KEY_ORDER_MAX_ROWS + 1;
    render(<DataTabView tab={tab('kl-big')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    expect(calls[1]).toBe('SELECT COUNT(*) AS row_count\nFROM vbig');
    expect(pages()).toEqual(['SELECT *\nFROM vbig\nLIMIT 1000 OFFSET 0']);
    await screen.findByText(/1,000 of 500,001 rows/);
    expect(screen.getByText(UNORDERED_HINT)).toBeInTheDocument();
    const first = gridProps!.rows.get(0);
    await loadMore();
    await until(() => gridProps!.rows.length === 2000);
    expect(pages().at(-1)).toBe('SELECT *\nFROM vbig\nLIMIT 1000 OFFSET 1000');
    expect(gridProps!.rows.get(0)).toBe(first);
    expect(counts()).toHaveLength(1);
    expect(screen.getByText(UNORDERED_HINT)).toBeInTheDocument();
  });

  it('a failed count leaves the order unknown: pages unordered, the count is not repeated', async () => {
    countMode = 'error';
    render(<DataTabView tab={tab('kl-err')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    expect(pages()).toEqual(['SELECT *\nFROM vbig\nLIMIT 1000 OFFSET 0']);
    await screen.findByText('count failed');
    expect(screen.getByText(UNORDERED_HINT)).toBeInTheDocument();
    expect(counts()).toHaveLength(1);
  });

  it('a count slower than the limit is cancelled before the page, which is then read unordered', async () => {
    countMode = 'slow';
    const cancel = vi.spyOn(api, 'cancel').mockImplementation(async () => {
      countMode = 'ok'; // the COUNT after the page answers
      releaseCount?.();
      return undefined as never;
    });
    render(<DataTabView tab={tab('kl-slow')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000, PRE_COUNT_TIMEOUT_MS + 3000);
    expect(cancel).toHaveBeenCalled();
    // The page starts only after the cancelled COUNT ended (never cancelled itself), and is not ordered.
    expect(calls.indexOf(pages()[0])).toBeGreaterThan(calls.indexOf(counts()[0]));
    expect(pages()).toEqual(['SELECT *\nFROM vbig\nLIMIT 1000 OFFSET 0']);
    expect(screen.getByText(UNORDERED_HINT)).toBeInTheDocument();
    // The count runs again after the page (for the status bar); the order stays as the first page was read.
    await until(() => counts().length === 2);
    await screen.findByText(/1,000 of 1,500 rows/);
    await loadMore();
    await until(() => gridProps!.rows.length === 1500);
    expect(pages().at(-1)).toBe('SELECT *\nFROM vbig\nLIMIT 1000 OFFSET 1000');
  }, PRE_COUNT_TIMEOUT_MS + 10_000);

  it('a SQLite table without a key pages by rowid without counting first', async () => {
    vi.spyOn(api, 'objectDetails').mockResolvedValue({ indexes: [] } as never);
    render(<DataTabView tab={tab('kl-rowid', 'table')} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    expect(pages()[0]).toBe('SELECT *\nFROM vbig\nORDER BY rowid\nLIMIT 1000 OFFSET 0');
    expect(calls.indexOf(pages()[0])).toBeLessThan(calls.findIndex((c) => c.startsWith('SELECT COUNT(*)')));
    await screen.findByText(/1,000 of 1,500 rows/);
    expect(screen.queryByText(UNORDERED_HINT)).toBeNull();
  });
});
