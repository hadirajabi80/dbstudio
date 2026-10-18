// logic-r2-01: one rule for "this window is connected". Sessions another live window uses (isForeignSession) never
// trigger the open-transaction prompt of Disconnect / Disconnect all, never enable those commands, are never closed
// from here and are not counted in the toast. The Delete connection confirm names them as another window's.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../api/types';
import { initCommands } from '../commands';
import { isEnabled, runCommand } from '../commands/registry';
import { useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { resetOwnSessionsForTests, useSessions } from '../store/sessions';
import { useTabs, type ConsoleTab } from '../store/tabs';
import { useUi } from '../store/ui';
import { installMockEngine } from '../test/mockServer';
import { disconnectAll, disconnectConnection, ownSessions } from './actions';

const mock = installMockEngine({ frameDelay: 0 });
beforeAll(() => initCommands(), 60_000);

function info(sessionId: string, o: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId, connectionId: 'c_shop', serverInfo: { product: 'SQLite', productVersion: '3', serverName: 'local', user: null, database: null } as unknown as SessionInfo['serverInfo'], database: null,
    txMode: 'auto', txOpen: false, state: 'idle', dialect: 'sqlite', tabId: null, label: null, ...o,
  };
}

function consoleTab(id: string): ConsoleTab {
  return { kind: 'console', id, title: id, connectionId: 'c_shop', database: null, text: '', savedText: '', filePath: null, txMode: 'auto', maxRows: null };
}

let confirm: ReturnType<typeof vi.fn>;

/** The other window's session: the engine reports its owner connected and this window never owned it. */
const foreignTx = () => info('liveTx', { orphan: false, txOpen: true, txMode: 'manual', label: 'Live window console' });

describe('disconnect ignores another window\'s sessions (logic-r2-01)', () => {
  beforeEach(async () => {
    mock.ctx.engine.sessions.clear();
    resetOwnSessionsForTests();
    await useConnections.getState().load();
    useCatalog.setState({ conns: {} });
    useTabs.setState({ tabs: [consoleTab('t_a')], activeId: 't_a', mru: [], closed: [] });
    useSessions.setState({ sessions: { liveTx: foreignTx() }, byTab: {} });
    useUi.setState({ toasts: [] });
    confirm = vi.fn(async () => true);
    useUi.setState({ askConfirm: confirm as never });
  });

  it('a foreign session alone enables neither Disconnect nor Disconnect all, and Disconnect all does nothing', async () => {
    expect(ownSessions()).toEqual([]);
    expect(isEnabled('connections.disconnectAll')).toBe(false);
    expect(isEnabled('connections.disconnect', { kind: 'connection', connectionId: 'c_shop' })).toBe(false);
    await disconnectAll();
    expect(confirm).not.toHaveBeenCalled();
    expect(useUi.getState().toasts).toEqual([]);
    expect(useSessions.getState().sessions.liveTx).toBeDefined();
  });

  it('Disconnect all: a foreign transaction does not prompt, and the toast counts only what this window closed', async () => {
    useSessions.getState().upsert(info('mine', { tabId: 't_a' }), 't_a');
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, other: info('other', { orphan: false, connectionId: 'c_prod' }) } });
    expect(isEnabled('connections.disconnectAll')).toBe(true);
    await disconnectAll();
    expect(confirm).not.toHaveBeenCalled();
    expect(Object.keys(useSessions.getState().sessions).sort()).toEqual(['liveTx', 'other']);
    const t = useUi.getState().toasts.at(-1)!;
    expect(t.text).toBe('Disconnected 1 connection');
    expect(t.detail).toBe('1 session closed');
  });

  it('Disconnect: a foreign transaction does not prompt; this window\'s own one does', async () => {
    useSessions.getState().upsert(info('mine', { tabId: 't_a' }), 't_a');
    expect(isEnabled('connections.disconnect', { kind: 'connection', connectionId: 'c_shop' })).toBe(true);
    await disconnectConnection('c_shop');
    expect(confirm).not.toHaveBeenCalled();
    expect(Object.keys(useSessions.getState().sessions)).toEqual(['liveTx']);

    useSessions.getState().upsert(info('mine2', { tabId: 't_a', txOpen: true, txMode: 'manual' }), 't_a');
    confirm.mockResolvedValueOnce(false);
    await disconnectConnection('c_shop');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].message).toMatch(/^1 console has an uncommitted transaction on “.+”\. Disconnecting rolls it back\.$/);
    // cancelled: nothing closed
    expect(useSessions.getState().sessions.mine2).toBeDefined();
  });

  it('Disconnect all prompts for this window\'s unused session with a transaction, named as a session', async () => {
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, goneTx: info('goneTx', { orphan: true, txOpen: true }) } });
    confirm.mockResolvedValueOnce(false);
    await disconnectAll();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].message).toBe('1 session has an uncommitted transaction. Disconnecting rolls it back.');
  });

  it('Delete connection names a stray session of another window and still rolls it back', async () => {
    const refreshAll = useSessions.getState().refreshAll;
    useSessions.setState({ refreshAll: async () => undefined });
    confirm.mockResolvedValueOnce(false);
    try {
      runCommand('connections.delete', { kind: 'connection', connectionId: 'c_shop' });
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    } finally {
      useSessions.setState({ refreshAll });
    }
    const req = confirm.mock.calls[0][0];
    expect(req.items).toContain('Session Live window console in another window — its uncommitted transaction will be rolled back');
    expect(req.message).toContain('1 console uses it and stays open without a connection.');
    expect(req.message).toContain('1 open transaction will be rolled back.');
    expect(req.confirmLabel).toBe('Roll back and delete');
  });
});
