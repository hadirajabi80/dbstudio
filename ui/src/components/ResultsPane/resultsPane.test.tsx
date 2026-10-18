// Console result-set toolbar: command coverage incl. "Code ▾" → codegen.query (design-09), the overflow toolbar
// (styles-03) and the results-pane minimum height of the console split.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind, SqlBatch } from '../../api/types';
import type { ContextEntry } from '../../commands/menuModel';
import { getCommand } from '../../commands/registry';
import { ChunkedList } from '../../lib/chunked';
import { installGridMockEngine } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution, type ExecutionState } from '../../store/resultsReducer';
import { useTabs, type ViewTab } from '../../store/tabs';
import { registerCodegenCommands } from '../CodegenPanel/commands';
import type { CodegenTabState } from '../CodegenPanel/open';
import { MenuHost } from '../common/Menu';
import { registerGridCommands } from '../DataTab/commands';
import type { DataGridProps } from '../Grid/DataGrid';
import { minResultsHeight } from '../layout/ConsoleView';
import { ResultsPane } from './ResultsPane';
import { originatingSelect } from './serverFilter';
import { RESULTS_TOOLBAR } from './toolbarModel';

vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => <div data-testid="grid" data-rows={p.rows.length} />,
  rowValue: () => null,
}));

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey: ordinal === 0,
});
const COLUMNS = [col('id', 'int', 0), col('name', 'string', 1)];
const ROWS: CellValue[][] = [[1, 'Ada'], [2, 'Grace']];
const batch = (sql: string, line = 1): SqlBatch => ({ sql, line, col: 1 });

function execOf(batches: SqlBatch[], resultBatches: number[] = [0]): ExecutionState {
  return {
    ...createExecution({ localId: 'L1', tabId: 'console-1', connectionId: 'c_shop', sessionId: null, label: 'statement', batches, maxRows: 1000 }),
    executionId: 'x1', status: 'ok', endedAt: Date.now(), elapsedMs: 3,
    resultSets: resultBatches.map((b, id) => ({ id, batchIndex: b, columns: COLUMNS, rows: ChunkedList.from(ROWS), rowCount: 2, truncated: false, elapsedMs: 3, done: true, rev: 1 })),
  };
}

function show(exec: ExecutionState) {
  act(() => useResults.setState({ executions: { L1: exec }, byTab: { 'console-1': 'L1' }, activeView: { 'console-1': 0 }, views: {} }));
  return render(<><ResultsPane tabId="console-1" dialect="sqlite" theme="light" /><MenuHost /></>);
}

const commandsOf = (entries: readonly ContextEntry[]) => entries.flatMap((e) => (e !== 'separator' && 'command' in e ? [e.command] : []));

describe('result-set toolbar', () => {
  beforeAll(async () => {
    registerGridCommands();
    registerCodegenCommands();
    await useConnections.getState().load();
  });
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null }));

  it('every toolbar item is a registered command, with Code ▾ (codegen.query) before Export', () => {
    const ids = commandsOf(RESULTS_TOOLBAR);
    for (const id of ids) expect(getCommand(id), id).toBeDefined();
    expect(ids).toContain('codegen.query');
    expect(ids.indexOf('codegen.query')).toBeLessThan(ids.indexOf('grid.export.csv'));
  });

  it('is one overflow toolbar row with Filter, Code and Export', () => {
    show(execOf([batch('SELECT * FROM customers')]));
    const bar = screen.getByRole('toolbar', { name: 'Result set toolbar' });
    expect(bar).toHaveClass('overflow-toolbar');
    for (const name of [/^Filter/, /^Code/, /^Export/, 'Record view', 'Value viewer', 'Copy column names']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('Code ▾ → "Generate code for this query" opens codegen with the SELECT and the result columns', () => {
    show(execOf([batch('SELECT * FROM customers;')]));
    fireEvent.click(screen.getByRole('button', { name: /^Code/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByText('Generate code for this query…'));
    const tab = useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === 'codegen') as ViewTab | undefined;
    expect(tab).toBeDefined();
    const st = tab!.state as CodegenTabState;
    expect(st.connectionId).toBe('c_shop');
    expect(st.targets).toEqual([{ kind: 'query', name: 'Customers', sql: 'SELECT * FROM customers', columns: COLUMNS }]);
  });

  it('Code ▾ is hidden when the result has no originating SELECT', () => {
    show(execOf([batch('EXEC dbo.report')]));
    expect(screen.queryByRole('button', { name: /^Code/ })).toBeNull();
  });

  it('originatingSelect: the batch of the result set, unless it is not one SELECT or made several results', () => {
    expect(originatingSelect(execOf([batch('WITH a AS (SELECT 1 x) SELECT * FROM a')]), { batchIndex: 0 }, 'sqlite')).toBe('WITH a AS (SELECT 1 x) SELECT * FROM a');
    const script = execOf([batch('UPDATE t SET a = 1 WHERE b = 2'), batch('SELECT * FROM customers', 2)], [1]);
    expect(originatingSelect(script, { batchIndex: 1 }, 'sqlite')).toBe('SELECT * FROM customers');
    expect(originatingSelect(execOf([batch('SELECT 1; SELECT 2')], [0, 0]), { batchIndex: 0 }, 'sqlite')).toBeNull();
    expect(originatingSelect(execOf([batch('DELETE FROM t WHERE id = 1')]), { batchIndex: 0 }, 'sqlite')).toBeNull();
  });
});

describe('results pane minimum height (styles-03)', () => {
  const chrome = { header: 30 + 31, status: 24 };
  it('header + grid header + 5 rows + scrollbar + status row, by density', () => {
    expect(minResultsHeight(2000, 1800, chrome, 28)).toBe(61 + 28 + 5 * 28 + 12 + 24);
    expect(minResultsHeight(2000, 1800, chrome, 24)).toBe(61 + 28 + 5 * 24 + 12 + 24);
  });
  it('capped at 68 % of the console, and the editor keeps its 60 px', () => {
    // 1280x800 at 150 %: a 435 px console and a 362 px split hold the whole minimum.
    expect(minResultsHeight(435, 362, chrome, 28)).toBe(265);
    expect(minResultsHeight(300, 290, chrome, 28)).toBe(204); // 68 % of the console
    expect(minResultsHeight(355, 283, chrome, 28)).toBe(283 - 61); // the editor's minimum wins
  });
});
