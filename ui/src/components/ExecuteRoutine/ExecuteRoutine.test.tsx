// Execute routine: the dialog (empty inputs, NULL / Default toggles, last values, live preview), the run through the
// mock engine (bind values, results in a console), and Run in an "Edit:" console of a procedure.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest } from '../../api/types';
import { wireSocket } from '../../app/boot';
import { registerEditor } from '../../app/editors';
import { engineSocket } from '../../api/ws';
import { initCommands } from '../../commands';
import { runCommand } from '../../commands/registry';
import { useDesignerUi } from '../../designer/store';
import type { SqlEditorHandle } from '../../editor/SqlEditor.types';
import { FakeSocket } from '../../mocks/fakeSocket';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { useSessions } from '../../store/sessions';
import { useSettings } from '../../store/settings';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { installMockEngine, TEST_ENGINE_URL } from '../../test/mockServer';
import { ExecuteRoutineHost } from './ExecuteRoutineDialog';
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

const preview = () => screen.getByLabelText('Generated SQL').textContent ?? '';

describe('Execute routine dialog', () => {
  it('starts with empty inputs (defaults on their default), toggles NULL / Default, previews the call live', async () => {
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const year = (await screen.findByLabelText('Value of Year')) as HTMLInputElement;
    const month = screen.getByLabelText('Value of Month') as HTMLInputElement;
    expect(year.value).toBe('');
    expect(month.value).toBe('');
    expect(month.placeholder).toBe('default');
    expect(screen.getByRole('button', { name: 'Default', pressed: true })).toBeInTheDocument();
    expect(preview()).toBe('DECLARE @return_value int;\nEXEC @return_value = [dbo].[MonthlyReport] @Year = @Year;\nSELECT @return_value AS [Return value];');
    expect(screen.getByLabelText('Bind values').textContent).toBe('@Year= ?'); // still to be filled in

    // NULL for Year; Month back to a value
    fireEvent.click(screen.getAllByRole('button', { name: 'NULL' })[0]);
    expect(preview()).toContain('@Year = NULL');
    fireEvent.change(month, { target: { value: '3' } });
    expect(screen.queryByRole('button', { name: 'Default', pressed: true })).toBeNull();
    expect(preview()).toContain('@Year = NULL, @Month = @Month;');
    // typing into a NULL field passes the value again; the bind values are listed under the SQL
    fireEvent.change(year, { target: { value: '2024' } });
    expect(preview()).toContain('@Year = @Year, @Month = @Month;');
    expect(screen.getByLabelText('Bind values').textContent).toBe('@Year= 2024@Month= 3');
    act(() => useExecuteRoutine.getState().close());
  });

  it('Execute refuses empty required values and says why', async () => {
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const year = await screen.findByLabelText('Value of Year');
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    fireEvent.keyDown(year, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText('Enter a value, or choose NULL')).toBeInTheDocument();
    expect(useExecuteRoutine.getState().request).not.toBeNull();
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
    act(() => useExecuteRoutine.getState().close());
  });

  it('runs with bind values in a new console holding the call, shows the outputs, and remembers the values', async () => {
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const year = await screen.findByLabelText('Value of Year');
    fireEvent.change(year, { target: { value: '2024' } });
    await act(async () => {
      fireEvent.keyDown(year, { key: 'Enter', ctrlKey: true });
    });
    await until(() => execute.mock.calls.length > 0);
    const req = execute.mock.calls[0][1] as ExecuteRequest;
    expect(req.batches[0].sql).toContain('EXEC @return_value = [dbo].[MonthlyReport] @Year = @Year;');
    expect(req.params).toEqual([{ name: 'Year', kind: 'int', value: 2024 }]);
    // a new console on the connection, with the call text to re-run or edit
    const tab = useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)!;
    expect(tab.kind === 'console' && tab.connectionId).toBe('c_prod');
    expect(tab.kind === 'console' && tab.text).toBe(req.batches[0].sql);
    await until(() => useResults.getState().executions[useResults.getState().byTab[tab.id]]?.status === 'ok');
    const exec = useResults.getState().executions[useResults.getState().byTab[tab.id]];
    expect(exec.resultSets.at(-1)?.columns.map((c) => c.name)).toEqual(['Return value']);
    execute.mockRestore();

    // Next time the inputs start empty again; "Last values" fills them in.
    act(() => useExecuteRoutine.getState().open(MONTHLY));
    const again = (await screen.findByLabelText('Value of Year')) as HTMLInputElement;
    expect(again.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /Last values/ }));
    expect(again.value).toBe('2024');
    act(() => useExecuteRoutine.getState().close());
  });

  it('Oracle package member: picks the member, OUT values come back as an "output parameters" result', async () => {
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    render(<ExecuteRoutineHost />);
    act(() => useExecuteRoutine.getState().open({ connectionId: 'c_ora', database: null, ref: { database: null, schema: 'SHOP', name: 'ORDER_API', type: 'package' } }));
    await screen.findByLabelText('Value of P_CUST');
    expect(preview()).toBe('BEGIN\n  SHOP.ORDER_API.CREATE_ORDER(P_CUST => :p_cust, P_TOTAL => :p_total);\nEND;');
    const { chooseOption } = await import('../../test/select');
    chooseOption(screen.getByLabelText('Package member'), 'GET_TOTAL');
    const id = await screen.findByLabelText('Value of P_ID');
    expect(preview()).toBe('BEGIN\n  :result := SHOP.ORDER_API.GET_TOTAL(P_ID => :p_id);\nEND;');
    fireEvent.change(id, { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Execute/ }));
    });
    await until(() => execute.mock.calls.length > 0);
    expect((execute.mock.calls[0][1] as ExecuteRequest).params).toEqual([
      { name: 'p_id', kind: 'decimal', value: '5' }, { name: 'result', kind: 'decimal', value: null, direction: 'out' },
    ]);
    const tabId = useTabs.getState().activeId!;
    await until(() => useResults.getState().executions[useResults.getState().byTab[tabId]]?.status === 'ok');
    const exec = useResults.getState().executions[useResults.getState().byTab[tabId]];
    const outs = exec.resultSets.at(-1)!;
    expect(outs.columns.map((c) => c.name)).toEqual(['result']);
    expect(outs.rows.get(0)).toEqual([42]);
    expect(exec.messages.some((m) => m.text === 'Output parameters: result = 42')).toBe(true);
    execute.mockRestore();
  });
});

function fakeEditor(text: string, selection = false): SqlEditorHandle {
  return {
    focus: () => undefined, insertText: () => undefined, revealLine: () => undefined, getValue: () => text,
    getRunTarget: (label) => ({ text, batches: [{ sql: text, line: 1, col: 1 }], label: selection ? 'selection' : label }),
  };
}

describe('Run in an "Edit:" console of a procedure', () => {
  const ref = { database: null, schema: 'dbo', name: 'GetCustomer', type: 'proc' as const };
  const SCRIPT = 'CREATE OR ALTER PROCEDURE dbo.GetCustomer @Id int AS SELECT 1';
  function editTab(selection = false): string {
    const id = useTabs.getState().newConsole({ connectionId: 'c_prod', text: SCRIPT, title: 'Edit: GetCustomer' });
    useDesignerUi.getState().registerEdit(id, { connectionId: 'c_prod', database: null, ref, serverDdl: SCRIPT, dialect: 'tsql', savedText: SCRIPT });
    registerEditor(id, fakeEditor(SCRIPT, selection));
    useTabs.getState().activate(id);
    return id;
  }

  it('Run (Ctrl+Enter, F5) opens Execute instead of re-running the CREATE; results go to that console', async () => {
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    const id = editTab();
    await runCommand('run.statement');
    expect(useExecuteRoutine.getState().request).toMatchObject({ connectionId: 'c_prod', ref, fromTabId: id });
    act(() => useExecuteRoutine.getState().close());
    await runCommand('run.script');
    expect(useExecuteRoutine.getState().request?.fromTabId).toBe(id);
    expect(execute).not.toHaveBeenCalled();

    render(<ExecuteRoutineHost />);
    const v = await screen.findByLabelText('Value of Id');
    fireEvent.change(v, { target: { value: '1' } });
    await act(async () => {
      fireEvent.keyDown(v, { key: 'Enter', ctrlKey: true });
    });
    await until(() => execute.mock.calls.length > 0);
    // ran in the edit console itself; its editor text (the CREATE) is untouched
    expect(useTabs.getState().tabs).toHaveLength(1);
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec.batches[0].sql).toMatch(/^DECLARE @return_value int;\nEXEC @return_value = \[dbo\]\.\[GetCustomer\] @Id = @Id;/);
    expect(exec.detached).toBe(true);
    const only = useTabs.getState().tabs[0];
    expect(only.kind === 'console' ? only.text : null).toBe(SCRIPT);
    await until(() => useResults.getState().executions[useResults.getState().byTab[id]]?.status === 'ok');
    execute.mockRestore();
  });

  it('a selection still runs as typed; "Run the edit script as SQL" runs the whole text', async () => {
    const execute = vi.spyOn(mock.ctx.engine, 'execute');
    editTab(true);
    await runCommand('run.statement');
    expect(useExecuteRoutine.getState().request).toBeNull();
    await until(() => execute.mock.calls.length === 1);
    await until(() => !useResults.getState().executions[useResults.getState().byTab[useTabs.getState().activeId!]]?.status.match(/starting|running/));

    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    editTab(false);
    await runCommand('routine.runEditScript');
    expect(useExecuteRoutine.getState().request).toBeNull();
    await until(() => execute.mock.calls.length === 2);
    expect((execute.mock.calls[1][1] as ExecuteRequest).batches[0].sql).toBe(SCRIPT);
    execute.mockRestore();
  });

  it('routine.execute from the explorer menu args; hidden for SQLite and triggers', async () => {
    const { isEnabled } = await import('../../commands/registry');
    expect(isEnabled('routine.execute', { kind: 'object', connectionId: 'c_prod', database: null, ref })).toBe(true);
    expect(isEnabled('routine.execute', { kind: 'object', connectionId: 'c_shop', database: null, ref: { ...ref, schema: 'main' } })).toBe(false);
    expect(isEnabled('routine.execute', { kind: 'object', connectionId: 'c_prod', database: null, ref: { ...ref, type: 'trigger' } })).toBe(false);
  });
});
