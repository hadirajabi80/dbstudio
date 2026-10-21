// The executed-query line under a result grid (Data tab page, console result set): the copied text is the statement
// that ran, with its binds inlined; "Copy with parameters" keeps the placeholders; Open in console creates a console tab.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind, QueryParam, SqlBatch } from '../../api/types';
import { getCommand, isEnabled, runCommand } from '../../commands/registry';
import { newCondition, newGroup } from '../../filter/model';
import type { ExecParam } from '../../filter/wire';
import { ChunkedList } from '../../lib/chunked';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution, type ExecutionState } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs, type ConsoleTab, type ViewTab } from '../../store/tabs';
import { MenuHost } from '../common/Menu';
import { DataTabView } from '../DataTab/DataTabView';
import { setSqlRunner, type QueryOutcome } from '../DataTab/runner';
import type { DataGridProps } from '../Grid/DataGrid';
import { registerResultsQueryCommands } from './commands';
import { ResultsPane } from './ResultsPane';

vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => <div data-testid="grid" data-rows={p.rows.length} />,
  rowValue: () => null,
}));

installGridMockEngine();

let clipboard: string[] = [];
const col = (name: string, kind: ColumnKind, ordinal: number, isKey = false): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey,
});
const COLUMNS = [col('id', 'int', 0, true), col('name', 'string', 1)];
const ROWS: CellValue[][] = [[1, 'Ada'], [2, "O'Brien"]];
const calls: { sql: string; params: ExecParam[] }[] = [];

const consoles = () => useTabs.getState().tabs.filter((t): t is ConsoleTab => t.kind === 'console');
const line = () => screen.getByRole('group', { name: 'Executed query' });

beforeAll(async () => {
  registerResultsQueryCommands();
  await useConnections.getState().load();
});
beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { clipboard.push(t); } }, configurable: true });
  useTabs.setState({ tabs: [], activeId: null });
});

describe('results.* commands', () => {
  it('are registered without a shortcut and disabled without a query', () => {
    for (const id of ['results.copyQuery', 'results.copyQueryWithParams', 'results.openQueryInConsole']) {
      expect(getCommand(id), id).toBeDefined();
      expect(getCommand(id)?.shortcut).toBeUndefined();
      expect(isEnabled(id, { gridKey: 'nope' })).toBe(false);
    }
  });
});

describe('Data tab query line', () => {
  const TAB: ViewTab = {
    kind: 'view', id: 'dtq', title: 'customers', view: 'data', connectionId: 'c_shop', database: null,
    state: { schema: 'main', name: 'customers', type: 'table', filter: newGroup('and', [newCondition('name', 'eq', ["O'Brien"])]), nonce: 1 },
  };
  const outcome = (columns: ColumnInfo[], rows: CellValue[][]): QueryOutcome => ({
    executionId: 'x', status: 'ok', resultSets: [{ columns, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 3, txOpen: false,
  });

  beforeAll(() => {
    setSqlRunner(async (_sid, sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('WHERE 1 = 0')) return outcome(COLUMNS, []);
      return outcome(COLUMNS, [ROWS[1]]);
    });
  });
  afterAll(() => setSqlRunner(null));
  beforeEach(() => {
    calls.length = 0;
    useSessions.setState({ sessions: {}, byTab: {} });
  });

  it('shows the page statement with the filter value inlined; Copy puts exactly that on the clipboard', async () => {
    render(<><DataTabView tab={TAB} theme="light" visible /><MenuHost /></>);
    await until(() => calls.some((c) => c.sql.includes('LIMIT')));
    const page = calls.find((c) => c.sql.includes('LIMIT'))!;
    expect(page.params).toEqual([{ name: 'fp1', kind: 'string', value: "O'Brien" }]);
    const runnable = page.sql.replace('@fp1', "'O''Brien'");
    expect(runnable).toContain('LIMIT 1000 OFFSET 0');

    const group = await screen.findByRole('group', { name: 'Executed query' });
    const text = group.querySelector('.rs-query-text')!;
    expect(text).toHaveAttribute('dir', 'auto');
    expect(text).toHaveAttribute('title', runnable);
    expect(text.textContent).toBe(runnable.replace(/\s+/g, ' '));

    const copy = within(group).getByRole('button', { name: 'Copy query' });
    expect(copy).toHaveAttribute('title', 'Copy query (values inlined)');
    await act(async () => {
      fireEvent.click(copy);
    });
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toBe(runnable);
    expect(within(group).getByRole('button', { name: 'Copied' })).toHaveAttribute('title', 'Copied');

    fireEvent.click(within(group).getByRole('button', { name: 'More query actions' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('menu')).getByText('Copy with parameters'));
    });
    await until(() => clipboard.length > 1);
    expect(clipboard[1]).toBe(`${page.sql}\n-- Parameters:\n--   @fp1 (string) = 'O''Brien'`);
  });

  it('Open in console creates a console on the same connection with the runnable statement', async () => {
    render(<DataTabView tab={{ ...TAB, id: 'dtq2' }} theme="light" visible />);
    await screen.findByRole('group', { name: 'Executed query' });
    const page = calls.find((c) => c.sql.includes('LIMIT'))!;
    act(() => {
      fireEvent.click(within(line()).getByRole('button', { name: 'Open in console' }));
    });
    const c = consoles();
    expect(c).toHaveLength(1);
    expect(c[0].connectionId).toBe('c_shop');
    expect(c[0].database).toBe('main'); // the database the tab's session ran in
    expect(c[0].text).toBe(`${page.sql.replace('@fp1', "'O''Brien'")}\n`);
    expect(useTabs.getState().activeId).toBe(c[0].id);
  });
});

describe('console result set query line', () => {
  const batch = (sql: string, ln = 1): SqlBatch => ({ sql, line: ln, col: 1 });
  function execOf(batches: SqlBatch[], resultBatches: number[], params: QueryParam[] = []): ExecutionState {
    return {
      ...createExecution({ localId: 'L1', tabId: 'console-1', connectionId: 'c_shop', sessionId: null, label: 'script', batches, maxRows: 1000, params }),
      executionId: 'x1', status: 'ok', endedAt: Date.now(), elapsedMs: 3,
      resultSets: resultBatches.map((b, id) => ({ id, batchIndex: b, columns: COLUMNS, rows: ChunkedList.from(ROWS), rowCount: 2, truncated: false, elapsedMs: 3, done: true, rev: 1 })),
    };
  }
  function show(exec: ExecutionState, active = 0) {
    act(() => useResults.setState({ executions: { L1: exec }, byTab: { 'console-1': 'L1' }, activeView: { 'console-1': active }, views: {} }));
    return render(<><ResultsPane tabId="console-1" dialect="sqlite" theme="light" /><MenuHost /></>);
  }

  it('shows and copies the statement of the selected result set, binds inlined', async () => {
    const exec = execOf(
      [batch('SELECT * FROM orders'), batch('SELECT * FROM customers\nWHERE id = @id AND name = @name', 2)], [0, 1],
      [{ name: 'id', kind: 'int', value: 2 }, { name: 'name', kind: 'string', value: "O'Brien" }],
    );
    show(exec, 1);
    const want = "SELECT * FROM customers\nWHERE id = 2 AND name = 'O''Brien'";
    const text = line().querySelector('.rs-query-text')!;
    expect(text.textContent).toBe(want.replace(/\s+/g, ' '));
    expect(text).toHaveAttribute('title', want);
    expect(text).toHaveClass('mono', 'muted');
    await act(async () => {
      fireEvent.click(within(line()).getByRole('button', { name: 'Copy query' }));
    });
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toBe(want);
    // The palette / menu path acts on the same grid.
    await act(async () => {
      runCommand('results.copyQueryWithParams', { gridKey: 'L1:1' });
    });
    await until(() => clipboard.length > 1);
    expect(clipboard[1]).toBe("SELECT * FROM customers\nWHERE id = @id AND name = @name\n-- Parameters:\n--   @id (int) = 2\n--   @name (string) = 'O''Brien'");
  });

  it('without binds: plain "Copy query", no overflow; Open in console opens the statement', () => {
    show(execOf([batch('SELECT * FROM customers;')], [0]));
    expect(within(line()).getByRole('button', { name: 'Copy query' })).toHaveAttribute('title', 'Copy query');
    expect(within(line()).queryByRole('button', { name: 'More query actions' })).toBeNull();
    act(() => {
      fireEvent.click(within(line()).getByRole('button', { name: 'Open in console' }));
    });
    const c = consoles();
    expect(c).toHaveLength(1);
    expect(c[0].connectionId).toBe('c_shop');
    expect(c[0].text).toBe('SELECT * FROM customers;\n');
  });
});
