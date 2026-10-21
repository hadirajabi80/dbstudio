// Activity sub-view against the MSW mock engine + fake WebSocket: activity.poll snapshots, summary tiles, blocking
// chain, Only active, locks, Kill with typed confirmation (READ_ONLY, PostgreSQL cancel vs terminate), commands.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../api/client';
import type { LogKillRequest } from '../../api/types';
import { installKeyDispatcher } from '../../commands/dispatcher';
import { getCommand, runCommand } from '../../commands/registry';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { installLogsEngine, LogsHost, resetTabs, until } from './__tests__/kit';
import { LOGS_COMMANDS, registerLogsCommands } from './commands';
import { openLogs } from './open';

const env = installLogsEngine();

beforeAll(() => {
  registerLogsCommands();
  installKeyDispatcher();
});
beforeEach(() => {
  resetTabs();
  useUi.setState({ toasts: [] } as never);
});
afterEach(() => env.server.resetHandlers());

function showActivity(cid: string) {
  const id = openLogs(cid, { sub: 'activity' });
  render(<LogsHost tabId={id} />);
  return id;
}

const grid = () => screen.getByRole('grid');
const rowOf = (id: string) => within(grid()).getAllByRole('row').find((r) => within(r).queryAllByRole('gridcell')[0]?.textContent?.startsWith(id));
async function waitRows() {
  await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBeGreaterThan(1), { timeout: 4000 });
}
const tile = (label: string) => screen.getByRole('group', { name: label });
const kills = () => env.hits('/kill');

describe('activity polling', () => {
  it('opens an activity.poll stream at 2 s and renders the snapshot', async () => {
    showActivity('c_prod');
    await waitRows();
    const open = env.requests.find((r) => r.method === 'POST' && r.path === '/streams' && (r.body as { kind?: string } | null)?.kind === 'activity.poll');
    expect((open?.body as { params: { intervalMs: number } }).params.intervalMs).toBe(2000);
    expect(rowOf('57')).toBeTruthy();
    expect(screen.getByText(/polling every 2 s/)).toBeInTheDocument();
  });

  it('summarises sessions, running, blocked and the head blocker', async () => {
    showActivity('c_prod');
    await waitRows();
    expect(within(tile('Sessions')).getByText('7')).toBeInTheDocument();
    expect(within(tile('Blocked')).getByText('3')).toBeInTheDocument();
    expect(within(tile('Blocked')).getByText(/head blocker 57/)).toBeInTheDocument();
  });

  it('shows the blocking chain indicator and the blocker count', async () => {
    showActivity('c_prod');
    await waitRows();
    expect(within(rowOf('61')!).getByText(/blocked by/)).toBeInTheDocument();
    expect(within(rowOf('57')!).getByText('blocks 2')).toBeInTheDocument();
    expect(rowOf('57')!.className).toContain('is-head-blocker');
  });

  it('Only active hides idle sessions but keeps idle blockers', async () => {
    showActivity('c_pg');
    await waitRows();
    expect(rowOf('4410')).toBeTruthy();
    act(() => void runCommand('logs.activity.onlyActive'));
    await waitFor(() => expect(rowOf('4410')).toBeUndefined());
    expect(rowOf('4321')).toBeTruthy(); // idle in transaction, but it blocks 4390
  });

  it('switches to the lock summary rows', async () => {
    showActivity('c_prod');
    await waitRows();
    fireEvent.click(screen.getByRole('button', { name: /Locks/ }));
    await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBe(3));
    expect(within(grid()).getByText(/WAIT/)).toBeInTheDocument();
  });

  it('filters by text', async () => {
    showActivity('c_prod');
    await waitRows();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sessions' }), { target: { value: 'Power BI' } });
    await waitFor(() => expect(within(grid()).getAllByRole('row').length).toBe(2));
    expect(rowOf('64')).toBeTruthy();
  });

  it('closes the stream when the tab unmounts', async () => {
    const { unmount } = render(<LogsHost tabId={openLogs('c_redis', { sub: 'activity' })} />);
    await waitRows();
    await until(() => env.requests.some((r) => r.method === 'POST' && r.path === '/streams'));
    unmount();
    await waitFor(async () => expect((await api.listStreams()).filter((s) => s.kind === 'activity.poll')).toHaveLength(0));
  });
});

describe('kill', () => {
  it('requires typing the session id and shows the exact statement', async () => {
    showActivity('c_prod');
    await waitRows();
    fireEvent.mouseDown(rowOf('57')!);
    act(() => void runCommand('logs.activity.kill'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kill-statement').textContent).toBe('KILL 57');
    const button = within(dialog).getByRole('button', { name: /Kill/ });
    expect(button).toBeDisabled();
    const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: '5' } });
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: '57' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await until(() => kills().length > 0 && kills()[0].body != null);
    expect(kills()[0].body).toEqual({ id: '57', kind: 'session' } satisfies LogKillRequest);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(rowOf('57')).toBeUndefined(), { timeout: 5000 });
  });

  it('Cancel in the dialog sends nothing', async () => {
    showActivity('c_prod');
    await waitRows();
    fireEvent.mouseDown(rowOf('61')!);
    act(() => void runCommand('logs.activity.kill'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(kills()).toHaveLength(0);
  });

  it('is disabled on a read-only connection', async () => {
    showActivity('c_ora');
    await waitRows();
    fireEvent.mouseDown(rowOf('140,22')!);
    await waitFor(() => expect(getCommand('logs.activity.kill')!.when!()).toBe(false));
    expect(screen.getByRole('button', { name: /Kill/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /Kill/ }).getAttribute('title')).toMatch(/read-only/);
  });

  it('PostgreSQL: cancel sends mode cancel with pg_cancel_backend; kill terminates', async () => {
    showActivity('c_pg');
    await waitRows();
    fireEvent.mouseDown(rowOf('4390')!);
    act(() => void runCommand('logs.activity.cancel'));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kill-statement').textContent).toBe('SELECT pg_cancel_backend(4390)');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '4390' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Cancel query/ }));
    await until(() => kills().length === 1 && kills()[0].body != null);
    expect(kills()[0].body).toMatchObject({ id: '4390', mode: 'cancel' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.mouseDown(rowOf('4402')!);
    act(() => void runCommand('logs.activity.kill'));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kill-statement').textContent).toBe('SELECT pg_terminate_backend(4402)');
  });

  it('Redis: kills a client with CLIENT KILL ID', async () => {
    showActivity('c_redis');
    await waitRows();
    fireEvent.mouseDown(rowOf('15')!);
    act(() => void runCommand('logs.activity.kill'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kill-statement').textContent).toBe('CLIENT KILL ID 15');
    expect(within(dialog).getByText(/Kill client 15/)).toBeInTheDocument();
  });

  it('MongoDB: kills an operation with db.killOp', async () => {
    showActivity('c_mongo');
    await waitRows();
    fireEvent.mouseDown(rowOf('12345')!);
    act(() => void runCommand('logs.activity.kill'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('kill-statement').textContent).toBe('db.killOp(12345)');
  });
});

describe('open statement and commands', () => {
  it('opens the selected statement in a new console on the same connection', async () => {
    showActivity('c_prod');
    await waitRows();
    fireEvent.mouseDown(rowOf('75')!);
    await waitFor(() => expect(getCommand('logs.activity.openStatement')!.when!()).toBe(true));
    act(() => void runCommand('logs.activity.openStatement'));
    await waitFor(() => expect(useTabs.getState().tabs.some((t) => t.kind === 'console' && t.connectionId === 'c_prod')).toBe(true));
  });

  it('registers every logs command with a unique id; in-view keys are scoped', () => {
    const ids = LOGS_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id === 'view.logs' || id.startsWith('logs.'))).toBe(true);
    for (const c of LOGS_COMMANDS) if (c.shortcut && c.id !== 'view.logs') expect(c.scope, c.id).toBeDefined();
    expect(getCommand('view.logs')!.shortcut).toBe('Mod+Alt+Shift+L');
    expect(getCommand('logs.activity.kill')!.danger).toBe(true);
  });

  it('view.logs opens the active connection and re-activates the same tab', () => {
    act(() => void runCommand('view.logs', { kind: 'connection', connectionId: 'c_pg' } as never));
    const first = useTabs.getState().activeId;
    act(() => void runCommand('view.logs', { connectionId: 'c_pg', sub: 'activity' } as never));
    expect(useTabs.getState().activeId).toBe(first);
    expect(useTabs.getState().tabs.filter((t) => t.kind === 'view')).toHaveLength(1);
  });
});
