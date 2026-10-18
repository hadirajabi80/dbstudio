// Closing the filter bar from inside it (Esc / ✕) gives focus back to the grid of the same view, for both hosts:
// the Data tab and a console result set (design-r1-01, PLAN-M1.5 5.3 "focus never gets lost").
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { installGridMockEngine, until } from '../../mocks/m15/testServer';
import { ChunkedList } from '../../lib/chunked';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { createExecution, type ExecutionState } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import type { ViewTab } from '../../store/tabs';
import { DataTabView } from '../DataTab/DataTabView';
import { setSqlRunner, type QueryOutcome } from '../DataTab/runner';
import type { DataGridProps } from '../Grid/DataGrid';
import { ResultsPane } from '../ResultsPane/ResultsPane';

// The canvas grid is replaced by a probe: a focusable canvas plus a controller whose focus() focuses it.
vi.mock('../Grid/DataGrid', async () => {
  const React = await import('react');
  const { registerGridController } = await import('../Grid/controller');
  return {
    DataGrid: (p: DataGridProps) => {
      const ref = React.useRef<HTMLCanvasElement>(null);
      React.useEffect(
        () =>
          registerGridController({
            key: p.gridKey, editable: false, openFilter: (c?: string) => p.onOpenFilter?.(c), quickFilterCell: () => undefined, clearFilter: () => undefined,
            focus: () => {
              ref.current?.focus();
              return document.activeElement === ref.current;
            },
          }),
        [p.gridKey], // eslint-disable-line react-hooks/exhaustive-deps
      );
      return React.createElement('div', { className: 'grid-host', 'data-command-scope': 'grid' },
        React.createElement('canvas', { 'data-testid': 'data-grid-canvas', tabIndex: 0, ref }));
    },
    rowValue: () => null,
  };
});

installGridMockEngine();

const col = (name: string, kind: ColumnKind, ordinal: number, isKey = false): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey,
});
const COLUMNS = [col('id', 'int', 0, true), col('name', 'string', 1)];
const ROWS: CellValue[][] = [[1, 'Ada'], [2, 'Grace']];
const outcome = (rows: CellValue[][]): QueryOutcome => ({
  executionId: 'x', status: 'ok', resultSets: [{ columns: COLUMNS, rows, truncated: false }], affected: 0, affectedReported: false, error: null, messages: [], outParams: [], elapsedMs: 1, txOpen: false,
});

const canvas = () => screen.getByTestId('data-grid-canvas');

/** Add a condition (focus moves into its value field), then close the bar the given way. */
async function openConditionThenClose(how: 'escape' | 'button') {
  fireEvent.click(await screen.findByRole('button', { name: /^Add condition/ }));
  const bar = screen.getByRole('search', { name: 'Filter rows' });
  await until(() => bar.contains(document.activeElement));
  if (how === 'escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: 'Close filter bar' }));
  expect(screen.queryByRole('search', { name: 'Filter rows' })).toBeNull();
}

describe('filter bar close returns focus to the grid', () => {
  beforeAll(async () => {
    await useConnections.getState().load();
    setSqlRunner(async (_sid, sql) => (sql.includes('WHERE 1 = 0') ? outcome([]) : sql.startsWith('SELECT COUNT') ? { ...outcome([[2]]), resultSets: [{ columns: [col('row_count', 'int', 0)], rows: [[2]], truncated: false }] } : outcome(ROWS)));
  });
  afterAll(() => setSqlRunner(null));
  beforeEach(() => useSessions.setState({ sessions: {}, byTab: {} }));

  for (const how of ['escape', 'button'] as const) {
    it(`Data tab: ${how === 'escape' ? 'Esc' : '✕'} focuses the grid canvas`, async () => {
      const tab: ViewTab = { kind: 'view', id: `fbf-${how}`, title: 'customers', view: 'data', connectionId: 'c_shop', database: null, state: { schema: 'main', name: 'customers', type: 'table' } };
      render(<DataTabView tab={tab} theme="light" visible />);
      await screen.findByTestId('data-grid-canvas');
      await openConditionThenClose(how);
      expect(document.activeElement).toBe(canvas());
    });
  }

  it('console result set: Esc focuses the grid canvas', async () => {
    const exec: ExecutionState = {
      ...createExecution({ localId: 'L1', tabId: 'console-1', connectionId: 'c_shop', sessionId: null, label: 'statement', batches: [{ sql: 'SELECT * FROM customers', line: 1, col: 1 }], maxRows: 1000 }),
      executionId: 'x1', status: 'ok', endedAt: Date.now(), elapsedMs: 3,
      resultSets: [{ id: 0, batchIndex: 0, columns: COLUMNS, rows: ChunkedList.from(ROWS), rowCount: 2, truncated: false, elapsedMs: 3, done: true, rev: 1 }],
    };
    act(() => useResults.setState({ executions: { L1: exec }, byTab: { 'console-1': 'L1' }, activeView: { 'console-1': 0 } }));
    render(<ResultsPane tabId="console-1" dialect="sqlite" theme="light" />);
    fireEvent.click(await screen.findByRole('button', { name: /^Filter/ }));
    await openConditionThenClose('escape');
    expect(document.activeElement).toBe(canvas());
  });
});
