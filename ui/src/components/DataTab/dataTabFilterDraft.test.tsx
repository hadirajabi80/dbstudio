// design-r2-01: with pending edits, a filter / search / sort change that would reload the rows is kept as typed but
// deferred: no discard prompt per keystroke, focus stays in the Value input, an inline notice offers Save / Discard,
// and the query runs on its own once nothing is pending. Reload (and the empty-result "Clear filter") still ask.
// The canvas grid is replaced by a probe.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import type { ExecParam } from '../../filter/wire';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { pendingCount, useEdits } from '../../store/edits';
import { useSessions } from '../../store/sessions';
import { useUi } from '../../store/ui';
import type { ViewTab } from '../../store/tabs';
import type { DataGridProps } from '../Grid/DataGrid';
import { DataTabView } from './DataTabView';
import { dataGridKey } from './open';
import { setSqlRunner, type QueryOutcome } from './runner';

let gridProps: DataGridProps | null = null;
vi.mock('../Grid/DataGrid', async () => {
  const React = await import('react');
  return {
    DataGrid: (p: DataGridProps) => {
      gridProps = p;
      return React.createElement('canvas', { 'data-testid': 'data-grid-canvas', tabIndex: 0 });
    },
    rowValue: () => null,
  };
});

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number, isKey = false): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey,
});
// The text column first: "Add condition" (no focused cell) starts on it.
const COLUMNS = [col('name', 'string', 0), col('id', 'int', 1, true)];
const TOTAL = 50;
const calls: { sql: string; params: ExecParam[] }[] = [];

function outcome(cols: ColumnInfo[], rows: CellValue[][], extra: Partial<QueryOutcome> = {}): QueryOutcome {
  return { executionId: 'x', status: 'ok', resultSets: [{ columns: cols, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 1, txOpen: false, ...extra };
}

const TAB: ViewTab = { kind: 'view', id: 'dt-draft', title: 'customers', view: 'data', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'customers', type: 'table' } };
const KEY = dataGridKey(TAB.id);

/** Page reads (SELECT … LIMIT), in order. */
const pages = () => calls.filter((c) => /\bLIMIT \d+ OFFSET \d+/.test(c.sql));
const filteredPages = () => pages().filter((c) => /\nWHERE /.test(c.sql) && JSON.stringify(c.params).includes('Wang'));
const pause = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeAll(async () => {
  await useConnections.getState().load();
  setSqlRunner(async (_sid, sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('WHERE 1 = 0')) return outcome(COLUMNS, []);
    const filtered = JSON.stringify(params).includes('Wang');
    if (sql.startsWith('SELECT COUNT(*)')) return outcome([col('row_count', 'int', 0)], [[filtered ? 1 : TOTAL]]);
    if (sql.startsWith('UPDATE')) return outcome([], [], { resultSets: [], affected: 1, affectedReported: true });
    const m = /LIMIT (\d+) OFFSET (\d+)/.exec(sql);
    if (!m) return outcome(COLUMNS, [['Wang', 1]]); // refetch of the saved row by key
    if (filtered) return outcome(COLUMNS, [['Wang', 7]]);
    const [limit, offset] = [Number(m[1]), Number(m[2])];
    const rows: CellValue[][] = [];
    for (let i = offset; i < Math.min(TOTAL, offset + limit); i++) rows.push([`name ${i + 1}`, i + 1]);
    return outcome(COLUMNS, rows);
  });
});
afterAll(() => setSqlRunner(null));

let ask: ReturnType<typeof vi.fn>;
let origAsk: ReturnType<typeof useUi.getState>['askConfirm'];
beforeEach(() => {
  cleanup();
  calls.length = 0;
  gridProps = null;
  useEdits.getState().reset(KEY);
  useSessions.setState({ sessions: {}, byTab: {} });
  origAsk = useUi.getState().askConfirm;
  ask = vi.fn(async () => false);
  useUi.setState({ askConfirm: ask as unknown as typeof origAsk });
});
afterEach(() => {
  useUi.setState({ askConfirm: origAsk });
  vi.restoreAllMocks();
});

/** Opens the tab, makes one pending edit, adds a condition and types "Wang" key by key into its value. */
async function typeWangWithPendingEdit() {
  const user = userEvent.setup();
  render(<DataTabView tab={TAB} theme="light" visible />);
  await until(() => gridProps?.rows.length === TOTAL);
  await screen.findByText(/^50 rows/);
  act(() => useEdits.getState().setCell(KEY, 1, 0, 'Changed', 'name 2'));
  expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
  await user.click(screen.getByRole('button', { name: /^Add condition/ }));
  const row = await screen.findByRole('group', { name: 'Condition on name' });
  const value = within(row).getByRole('textbox', { name: 'Value' });
  // A truly incomplete draft keeps its "incomplete" badge.
  expect(within(row).getByText('incomplete')).toBeInTheDocument();
  expect(document.activeElement).toBe(value);
  const before = calls.length;
  await user.type(value, 'Wang');
  await pause(700); // past the value commit and the reload debounce
  return { user, row, value, before };
}

describe('filter changes with pending edits are deferred, not guarded (design-r2-01)', () => {
  it('typing a value with one pending edit shows the notice, keeps focus and sends no query', async () => {
    const { row, value, before } = await typeWangWithPendingEdit();
    expect(ask).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(value);
    expect(value).toHaveValue('Wang');
    // Complete but deferred: no "incomplete" badge; the notice says why it does not filter.
    expect(within(row).queryByText('incomplete')).toBeNull();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Not applied: 1 unsaved change.');
    expect(within(notice).getByRole('button', { name: 'Save and filter' })).toBeEnabled();
    expect(within(notice).getByRole('button', { name: 'Discard and filter' })).toBeEnabled();
    expect(calls.slice(before)).toEqual([]);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
    expect(gridProps!.rows.length).toBe(TOTAL);
  });

  it('undoing the edit (nothing pending) applies the deferred WHERE on its own', async () => {
    const { value } = await typeWangWithPendingEdit();
    expect(filteredPages()).toHaveLength(0);
    act(() => useEdits.getState().undo(KEY));
    await until(() => gridProps?.rows.length === 1);
    expect(filteredPages()).toHaveLength(1);
    expect(filteredPages()[0].sql).toMatch(/^SELECT \*\nFROM customers\nWHERE .*name.*\nORDER BY id\nLIMIT 1000 OFFSET 0$/s);
    expect(screen.queryByRole('status')).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(value);
  });

  it('"Save and filter" saves the pending change, then applies the filter', async () => {
    const { user } = await typeWangWithPendingEdit();
    await user.click(screen.getByRole('button', { name: 'Save and filter' }));
    await until(() => gridProps?.rows.length === 1, 5000);
    const update = calls.findIndex((c) => c.sql.startsWith('UPDATE'));
    const page = calls.findIndex((c) => filteredPages().includes(c));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(page).toBeGreaterThan(update);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('"Discard and filter" drops the pending change, then applies the filter', async () => {
    const { user } = await typeWangWithPendingEdit();
    await user.click(screen.getByRole('button', { name: 'Discard and filter' }));
    await until(() => gridProps?.rows.length === 1);
    expect(calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);
    expect(filteredPages()).toHaveLength(1);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a search or sort change is deferred the same way', async () => {
    render(<DataTabView tab={TAB} theme="light" visible />);
    await until(() => gridProps?.rows.length === TOTAL);
    act(() => useEdits.getState().setCell(KEY, 1, 0, 'Changed', 'name 2'));
    const before = calls.length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Search text columns' }), { target: { value: 'Wang' } });
    act(() => gridProps!.serverSort!.onSortChange([{ column: 0, dir: 'desc' }]));
    await pause(500);
    expect(ask).not.toHaveBeenCalled();
    expect(calls.slice(before)).toEqual([]);
    expect(screen.getByRole('status')).toHaveTextContent('Not applied: 1 unsaved change.');
    act(() => useEdits.getState().revertAll(KEY));
    await until(() => pages().length === 2);
    expect(pages()[1].sql).toContain('ORDER BY name DESC');
    expect(JSON.stringify(pages()[1].params)).toContain('Wang');
  });

  it('Reload still asks before discarding pending edits', async () => {
    render(<DataTabView tab={TAB} theme="light" visible />);
    await until(() => gridProps?.rows.length === TOTAL);
    await screen.findByText(/^50 rows/);
    act(() => useEdits.getState().setCell(KEY, 1, 0, 'Changed', 'name 2'));
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await until(() => ask.mock.calls.length === 1);
    await pause(400);
    expect(calls.slice(before)).toEqual([]);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(1);
    // Confirmed: the edits are dropped and the rows reloaded.
    ask.mockImplementation(async () => true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await until(() => pages().length === 2);
    expect(pendingCount(useEdits.getState().get(KEY).pending)).toBe(0);
  });
});
