// Routine result page (WP3): Run in the Execute dialog opens a `routine.run` tab that executes on its own session
// (runInView), shows the outputs as a key/value card instead of a result tab, re-runs, and releases everything on close.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest } from '../../api/types';
import { closeTab } from '../../app/actions';
import { wireSocket } from '../../app/boot';
import { engineSocket } from '../../api/ws';
import { initCommands } from '../../commands';
import { FakeSocket } from '../../mocks/fakeSocket';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { installMockEngine, TEST_ENGINE_URL } from '../../test/mockServer';
import { ExecuteRoutineHost } from './ExecuteRoutineDialog';
import { RoutineRunView } from './RoutineRunView';
import { runInView } from './runInView';
import { ROUTINE_RUN_VIEW, type RoutineRunState } from './runModel';
import { useExecuteRoutine } from './store';

const mock = installMockEngine({ frameDelay: 0 });

async function until(pred: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
    useResults.getState().flush();
  }
}

beforeAll(async () => {
  await initCommands();
  wireSocket();
  engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
  engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
  await until(() => engineSocket.status === 'open');
}, 60_000);

const MONTHLY = { connectionId: 'c_prod', database: null, ref: { database: null, schema: 'dbo', name: 'MonthlyReport', type: 'proc' as const } };

beforeEach(async () => {
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  useSessions.setState({ sessions: {}, byTab: {} });
  useUi.setState({ confirm: null, toasts: [] });
  useExecuteRoutine.setState({ request: null });
  mock.ctx.engine.settings = { ...mock.ctx.engine.settings, ui: { ...mock.ctx.engine.settings.ui, routineParams: {}, paramHistory: {} } };
  await useSettings.getState().load();
  await useConnections.getState().load();
});

const viewTab = () => useTabs.getState().tabs.find((t): t is ViewTab => t.kind === 'view' && t.view === ROUTINE_RUN_VIEW);
const execOf = (tabId: string) => useResults.getState().executions[useResults.getState().byTab[tabId]];

describe('Execute routine → result page', () => {
  it('Run (Ctrl+Enter) opens the result page, runs on its own session, shows the return value as a card; closing releases it', async () => {
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const year = await screen.findByLabelText('Value of Year');
    fireEvent.change(year, { target: { value: '2024' } });
    await act(async () => {
      fireEvent.keyDown(year, { key: 'Enter', ctrlKey: true });
    });
    expect(useExecuteRoutine.getState().request).toBeNull();
    const tab = viewTab()!;
    expect(tab).toBeTruthy();
    expect(useTabs.getState().activeId).toBe(tab.id);
    expect(tab.title).toBe('Run: dbo.MonthlyReport');
    expect(useTabs.getState().tabs.some((t) => t.kind === 'console')).toBe(false); // no console was opened
    await until(() => execOf(tab.id)?.status === 'ok');
    const req = execute.mock.calls[0][1] as ExecuteRequest;
    expect(req.params).toEqual([{ name: 'Year', kind: 'int', value: 2024 }]);
    expect(req.source?.tabId).toBe(tab.id);
    expect(useSessions.getState().byTab[tab.id]).toBeTruthy();

    const st = tab.state as RoutineRunState;
    expect(st.inputs[0]).toEqual({ mode: 'value', value: '2024' });
    expect(st.sql).toContain('[dbo].[MonthlyReport] @Year = @Year');
    render(<RoutineRunView tab={tab} theme="light" visible />);
    const card = screen.getByRole('region', { name: 'Return value' });
    expect(card.textContent).toContain('Return value');
    expect(screen.getByRole('status').textContent).toMatch(/Completed/);
    // the outputs set is the card, not a result tab
    expect(screen.queryByRole('tab', { name: /Result 1/ })).toBeNull();
    expect(screen.getByLabelText('Arguments').textContent).toBe('Year2024Monthdefault');

    // Run again re-uses the page and its session.
    const session = useSessions.getState().byTab[tab.id];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run again/ }));
    });
    await until(() => execute.mock.calls.length === 2 && execOf(tab.id)?.status === 'ok');
    expect(useSessions.getState().byTab[tab.id]).toBe(session);
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'view')).toHaveLength(1);

    await act(async () => {
      await closeTab(tab.id);
    });
    expect(useResults.getState().byTab[tab.id]).toBeUndefined();
    expect(useSessions.getState().byTab[tab.id]).toBeUndefined();
    execute.mockRestore();
  });

  it('Enter in a field moves to the next one; on the last field it runs', async () => {
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const year = await screen.findByLabelText('Value of Year');
    const month = screen.getByLabelText('Value of Month');
    fireEvent.change(year, { target: { value: '2025' } });
    fireEvent.keyDown(year, { key: 'Enter' });
    expect(document.activeElement).toBe(month);
    fireEvent.change(month, { target: { value: '4' } });
    await act(async () => {
      fireEvent.keyDown(month, { key: 'Enter' });
    });
    const tab = viewTab()!;
    await until(() => execOf(tab.id)?.status === 'ok');
    expect((tab.state as RoutineRunState).params).toEqual([{ name: 'Year', kind: 'int', value: 2025 }, { name: 'Month', kind: 'int', value: 4 }]);
  });

  it('runInView reports engine errors in the page (no console involved)', async () => {
    const id = useTabs.getState().openView({ view: ROUTINE_RUN_VIEW, title: 'Run: x', connectionId: 'c_prod', state: null });
    await runInView(id, { connectionId: 'c_prod', database: null, sql: 'SELECT * FROM dbo.nope', params: [], title: 'Run: x' });
    await until(() => !!execOf(id) && execOf(id).status !== 'starting' && execOf(id).status !== 'running');
    expect(execOf(id).errorCount).toBeGreaterThan(0);
    expect(execOf(id).tabId).toBe(id);
  });
});
