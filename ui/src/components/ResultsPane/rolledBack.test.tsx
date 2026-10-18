// features-r2-01: rows a console grid saved into a manual transaction are flagged when that transaction is rolled back
// ("Rolled back: N saved rows … [Re-run]"), and forgotten when it commits. No automatic refetch.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind, SqlBatch } from '../../api/types';
import { ChunkedList } from '../../lib/chunked';
import { installGridMockEngine } from '../../mocks/m15/testServer';
import { useConnections } from '../../store/connections';
import { useEdits } from '../../store/edits';
import { useResults, viewKey } from '../../store/results';
import { createExecution, type ExecutionState } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import type { DataGridProps } from '../Grid/DataGrid';
import { ResultsPane } from './ResultsPane';

const rerun = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../app/actions', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/actions')>()), rerun }));
vi.mock('../Grid/DataGrid', () => ({
  DataGrid: (p: DataGridProps) => <div data-testid="grid" data-key={p.gridKey} />,
  rowValue: () => null,
}));

installGridMockEngine();

const TAB = 'console-rb';
const col = (name: string, kind: ColumnKind, ordinal: number): ColumnInfo => ({
  name, ordinal, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: 'main', isKey: ordinal === 0,
});
const COLUMNS = [col('id', 'int', 0), col('name', 'string', 1)];
const ROWS: CellValue[][] = [[1, 'Ada'], [2, 'Grace']];
const batch = (sql: string): SqlBatch => ({ sql, line: 1, col: 1 });

function execOf(localId: string): ExecutionState {
  return {
    ...createExecution({ localId, tabId: TAB, connectionId: 'c_shop', sessionId: null, label: 'statement', batches: [batch('SELECT id, name FROM customers')], maxRows: 1000 }),
    executionId: `x-${localId}`, status: 'ok', endedAt: Date.now(), elapsedMs: 3,
    resultSets: [{ id: 0, batchIndex: 0, columns: COLUMNS, rows: ChunkedList.from(ROWS), rowCount: 2, truncated: false, elapsedMs: 3, done: true, rev: 1 }],
  };
}

function show(localId = 'L1') {
  act(() => useResults.setState({ executions: { [localId]: execOf(localId) }, byTab: { [TAB]: localId }, activeView: { [TAB]: 0 }, views: {} }));
}

const banner = () => screen.queryByRole('status');

/** A manual-mode console session with an open transaction, as after a grid save that left its rows uncommitted. */
async function manualSession() {
  const s = await useSessions.getState().ensure(TAB, 'c_shop', null, 'manual');
  useSessions.getState().upsert({ ...s, txOpen: true }, TAB);
  return s.sessionId;
}

describe('result grid after the transaction of its saved rows ends (features-r2-01)', () => {
  beforeAll(async () => {
    await useConnections.getState().load();
  });
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeId: null });
    useSessions.setState({ sessions: {}, byTab: {}, lastTxEnd: null });
    rerun.mockClear();
  });
  afterEach(() => {
    useEdits.setState({ buffers: {} });
  });

  it('Rollback flags the grid with the number of saved rows and offers Re-run; no refetch runs', async () => {
    const sid = await manualSession();
    show();
    render(<ResultsPane tabId={TAB} dialect="sqlite" theme="light" />);
    const key = viewKey('L1', 0);
    act(() => useEdits.getState().noteSavedInTx(key, sid, 2));
    expect(banner()).toBeNull();

    await act(() => useSessions.getState().rollback(TAB));
    expect(banner()).toHaveTextContent('Rolled back: 2 saved rows in this grid no longer match the database.');
    expect(useEdits.getState().get(key)).toMatchObject({ savedInTx: null, rolledBack: { rows: 2 } });
    expect(rerun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Re-run/ }));
    expect(rerun).toHaveBeenCalledWith(TAB);
  });

  it('one saved row reads in the singular; Dismiss hides the notice', async () => {
    const sid = await manualSession();
    show();
    render(<ResultsPane tabId={TAB} dialect="sqlite" theme="light" />);
    act(() => useEdits.getState().noteSavedInTx(viewKey('L1', 0), sid, 1));
    await act(() => useSessions.getState().rollback(TAB));
    expect(banner()).toHaveTextContent('Rolled back: 1 saved row in this grid no longer matches the database.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(banner()).toBeNull();
  });

  it('Commit makes the saved rows permanent: no notice, and a later rollback does not flag them', async () => {
    const sid = await manualSession();
    show();
    render(<ResultsPane tabId={TAB} dialect="sqlite" theme="light" />);
    const key = viewKey('L1', 0);
    act(() => useEdits.getState().noteSavedInTx(key, sid, 3));
    await act(() => useSessions.getState().commit(TAB));
    expect(useEdits.getState().get(key).savedInTx).toBeNull();
    useSessions.getState().upsert({ ...useSessions.getState().forTab(TAB)!, txOpen: true }, TAB);
    await act(() => useSessions.getState().rollback(TAB));
    expect(banner()).toBeNull();
  });

  it('a rollback of another session leaves the grid alone', async () => {
    const sid = await manualSession();
    show();
    render(<ResultsPane tabId={TAB} dialect="sqlite" theme="light" />);
    const key = viewKey('L1', 0);
    act(() => useEdits.getState().noteSavedInTx(key, sid, 2));
    act(() => useSessions.setState({ lastTxEnd: { sessionId: 'other-session', kind: 'rollback', seq: 999 } }));
    expect(banner()).toBeNull();
    expect(useEdits.getState().get(key).savedInTx).toEqual({ sessionId: sid, rows: 2 });
  });

  it('the notice goes away with the grid when the query is re-run (a new result replaces it)', async () => {
    const sid = await manualSession();
    show('L1');
    render(<ResultsPane tabId={TAB} dialect="sqlite" theme="light" />);
    act(() => useEdits.getState().noteSavedInTx(viewKey('L1', 0), sid, 2));
    await act(() => useSessions.getState().rollback(TAB));
    expect(banner()).not.toBeNull();
    show('L2');
    expect(screen.getByTestId('grid')).toHaveAttribute('data-key', viewKey('L2', 0));
    expect(banner()).toBeNull();
  });
});
