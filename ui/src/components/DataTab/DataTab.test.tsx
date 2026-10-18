import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { newCondition, newGroup } from '../../filter/model';
import type { ExecParam } from '../../filter/wire';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useTabs, type ViewTab } from '../../store/tabs';
import type { DataGridProps } from '../Grid/DataGrid';
import { DataTabView } from './DataTabView';
import type { DataTabState } from './open';
import { setSqlRunner, type QueryOutcome, type RunOptions } from './runner';

// The canvas grid is replaced by a probe that exposes the props the data tab drives.
let gridProps: DataGridProps | null = null;
vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => {
    gridProps = p;
    return <div data-testid="grid" data-rows={p.rows.length} />;
  },
  rowValue: () => null,
}));

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number, isKey = false): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey,
});
const COLUMNS = [col('id', 'int', 0, true), col('name', 'string', 1), col('total', 'decimal', 2)];
const TOTAL = 2500;
const calls: { sql: string; params: ExecParam[]; sid: string; opts: RunOptions }[] = [];

function outcome(columns: ColumnInfo[], rows: CellValue[][]): QueryOutcome {
  return { executionId: 'x', status: 'ok', resultSets: [{ columns, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 3, txOpen: false };
}

const TAB: ViewTab = { kind: 'view', id: 'dt1', title: 'customers', view: 'data', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'customers', type: 'table' } };

describe('Data tab: paging, server filter, sort and count', () => {
  beforeAll(async () => {
    await useConnections.getState().load();
    setSqlRunner(async (sid, sql, params, opts = {}) => {
      calls.push({ sql, params, sid, opts });
      if (sql.includes('WHERE 1 = 0')) return outcome(COLUMNS, []);
      if (sql.startsWith('SELECT COUNT(*)')) return outcome([col('row_count', 'int', 0)], [[params.length ? 40 : TOTAL]]);
      const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql)!;
      const [limit, offset] = [Number(m[1]), Number(m[2])];
      const max = params.length ? 40 : TOTAL;
      const rows: CellValue[][] = [];
      for (let i = offset; i < Math.min(max, offset + limit); i++) rows.push([i + 1, `name ${i + 1}`, `${i}.50`]);
      return outcome(COLUMNS, rows);
    });
  });
  afterAll(() => setSqlRunner(null));
  beforeEach(() => {
    calls.length = 0;
    gridProps = null;
    useSessions.setState({ sessions: {}, byTab: {} });
  });

  it('loads the first page ordered by key, counts lazily, and loads more', async () => {
    render(<DataTabView tab={TAB} theme="light" visible />);
    await until(() => !!gridProps && gridProps.rows.length === 1000);
    expect(calls[0].sql).toBe('SELECT *\nFROM customers\nWHERE 1 = 0');
    expect(calls[1].sql).toBe('SELECT *\nFROM customers\nORDER BY id\nLIMIT 1000 OFFSET 0');
    await screen.findByText(/1,000 of 2,500 rows/);
    expect(calls.some((c) => c.sql === 'SELECT COUNT(*) AS row_count\nFROM customers')).toBe(true);
    await act(async () => {
      gridProps!.onReachEnd!();
    });
    await until(() => gridProps!.rows.length === 2000);
    expect(calls.at(-1)!.sql).toBe('SELECT *\nFROM customers\nORDER BY id\nLIMIT 1000 OFFSET 1000');
    expect(screen.getByText(/Load 1,000 more/)).toBeInTheDocument();
  });

  it('header sort pushes ORDER BY to the server and restarts paging', async () => {
    render(<DataTabView tab={TAB} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    calls.length = 0;
    await act(async () => {
      gridProps!.serverSort!.onSortChange([{ column: 1, dir: 'desc' }]);
    });
    await until(() => calls.some((c) => c.sql.includes('ORDER BY name DESC, id')), 3000);
    expect(calls.find((c) => c.sql.includes('ORDER BY'))!.sql).toBe('SELECT *\nFROM customers\nORDER BY name DESC, id\nLIMIT 1000 OFFSET 0');
  });

  it('filters always run on the server with parameters, and the count uses the same predicate', async () => {
    render(<DataTabView tab={TAB} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    calls.length = 0;
    await act(async () => {
      gridProps!.onViewChange({ filter: newGroup('and', [newCondition('name', 'contains', ['a'])]) });
    });
    await until(() => gridProps?.rows.length === 40, 3000);
    const page = calls.find((c) => c.sql.includes('LIMIT'))!;
    expect(page.sql).toBe("SELECT *\nFROM customers\nWHERE name LIKE '%' || @fp1 || '%' ESCAPE '\\'\nORDER BY id\nLIMIT 1000 OFFSET 0");
    expect(page.params).toEqual([{ name: 'fp1', kind: 'string', value: 'a' }]);
    expect(screen.getAllByText(/40 rows/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Server · 40 rows/)).toBeInTheDocument();
    expect(gridProps!.serverFiltered).toBe(true);
  });

  it('FK navigation state opens with an equality filter on the key', async () => {
    const tab: ViewTab = { ...TAB, id: 'dt2', state: { schema: 'main', name: 'customers', filter: newGroup('and', [newCondition('id', 'eq', [7])]), nonce: 1 } };
    render(<DataTabView tab={tab} theme="light" visible />);
    await until(() => calls.some((c) => c.sql.includes('LIMIT')));
    const page = calls.find((c) => c.sql.includes('LIMIT'))!;
    expect(page.sql).toContain('WHERE id = @fp1');
    expect(page.params).toEqual([{ name: 'fp1', kind: 'int', value: 7 }]);
    fireEvent.click(await screen.findByRole('button', { name: /Filter \(1\)/ }));
  });

  it('StrictMode: page 0 and COUNT run once, pages follow OFFSET 0, 1000, 2000 without duplicate rows (logic-13)', async () => {
    render(<StrictMode><DataTabView tab={{ ...TAB, id: 'dt3' }} theme="light" visible /></StrictMode>);
    await screen.findByText(/1,000 of 2,500 rows/);
    // Long enough for the (former) reload when the columns arrive to fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        gridProps!.onReachEnd!();
      });
      await until(() => gridProps!.rows.length === 2000 + i * 500);
    }
    const pages = calls.filter((c) => c.sql.includes('LIMIT')).map((c) => Number(/OFFSET (\d+)/.exec(c.sql)![1]));
    expect(pages).toEqual([0, 1000, 2000]);
    expect(calls.filter((c) => c.sql.startsWith('SELECT COUNT(*)'))).toHaveLength(1);
    expect(calls.filter((c) => c.sql.includes('WHERE 1 = 0'))).toHaveLength(1);
    const rows = gridProps!.rows as unknown as { get(i: number): CellValue[] | undefined };
    const ids = Array.from({ length: gridProps!.rows.length }, (_, i) => rows.get(i)![0]);
    expect(new Set(ids).size).toBe(2500);
    expect(screen.getByText(/^2,500 rows$/)).toBeInTheDocument();
  });

  it("COUNT runs on the tab's own session; probe, COUNT and later pages stay out of the history (logic-09, logic-19)", async () => {
    render(<DataTabView tab={{ ...TAB, id: 'dt4' }} theme="light" visible />);
    await screen.findByText(/1,000 of 2,500 rows/);
    await act(async () => {
      gridProps!.onReachEnd!();
    });
    await until(() => gridProps!.rows.length === 2000);
    expect(new Set(calls.map((c) => c.sid)).size).toBe(1);
    expect(Object.keys(useSessions.getState().byTab)).toEqual(['dt4']);
    const flags = (pred: (sql: string) => boolean) => calls.filter((c) => pred(c.sql)).map((c) => !!c.opts.skipHistory);
    expect(flags((q) => q.includes('WHERE 1 = 0'))).toEqual([true]);
    expect(flags((q) => q.startsWith('SELECT COUNT(*)'))).toEqual([true]);
    expect(flags((q) => q.includes('LIMIT'))).toEqual([false, true]); // one history entry per page-0 load
  });

  it('persists filter, search and sort into the tab state (restored after a restart, features-20)', async () => {
    const id = useTabs.getState().openView({ view: 'data', title: 'customers', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'customers', type: 'table' } });
    const tabOf = () => useTabs.getState().tabs.find((t) => t.id === id) as ViewTab;
    render(<DataTabView tab={tabOf()} theme="light" visible />);
    await until(() => gridProps?.rows.length === 1000);
    await act(async () => {
      gridProps!.onViewChange({ filter: newGroup('and', [newCondition('name', 'contains', ['a'])]), quickFilter: 'zz' });
      gridProps!.serverSort!.onSortChange([{ column: 2, dir: 'desc' }]);
    });
    await until(() => !!(tabOf().state as DataTabState | null)?.sort?.length, 3000);
    const st = tabOf().state as DataTabState;
    expect(st.quick).toBe('zz');
    expect(st.sort).toEqual([{ column: 'total', dir: 'desc' }]);
    expect(st.filter?.items).toHaveLength(1);
    expect(st.name).toBe('customers');
  });
});
