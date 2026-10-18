// logic-r1-03: a session counts as unused (closable, adoptable, releasable) only when the engine reports its window
// gone (`orphan: true`) or this window owned it before a reload. Sessions of another live window (`orphan: false`)
// are listed read-only: never adopted, closed in bulk, released on SESSION_LIMIT or announced as unused.
import { render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../api/types';
import { releasableOrphans } from '../app/actions';
import { reattachSessions } from '../app/boot';
import { initCommands } from '../commands';
import { isEnabled } from '../commands/registry';
import { ConnectionsPanel } from '../components/ConnectionsPanel/ConnectionsPanel';
import { installMockEngine } from '../test/mockServer';
import { useConnections } from './connections';
import { activityCounts, connectionActivity, isForeignSession, resetOwnSessionsForTests, useSessions } from './sessions';
import { useTabs, type ConsoleTab } from './tabs';
import { useUi } from './ui';

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

const ids = (list: SessionInfo[]) => list.map((s) => s.sessionId).sort();

describe('session ownership (logic-r1-03)', () => {
  beforeEach(async () => {
    mock.ctx.engine.sessions.clear();
    resetOwnSessionsForTests();
    useUi.setState({ toasts: [] });
    await useConnections.getState().load();
    useTabs.setState({ tabs: [consoleTab('t_a'), consoleTab('t_b')], activeId: 't_a', mru: [], closed: [] });
    useSessions.setState({
      sessions: {
        gone: info('gone', { orphan: true, label: 'Old console' }),
        goneTx: info('goneTx', { orphan: true, txOpen: true }),
        live: info('live', { orphan: false, tabId: 't_b', label: 'Live window console' }),
        liveTx: info('liveTx', { orphan: false, txOpen: true }),
      },
      byTab: {},
    });
    // created by this window's tab (ensure → upsert), so it is remembered as ours
    useSessions.getState().upsert(info('mine', { tabId: 't_a' }), 't_a');
  });

  it('orphans() lists only sessions whose window is gone; foreign() the ones another window uses', () => {
    const s = useSessions.getState();
    expect(ids(s.orphans())).toEqual(['gone', 'goneTx']);
    expect(ids(s.foreign())).toEqual(['live', 'liveTx']);
    expect(isForeignSession(s.sessions.live)).toBe(true);
    expect(isForeignSession(s.sessions.gone)).toBe(false);
    // an engine that does not report the flag keeps the single-window behaviour
    expect(isForeignSession(info('legacy'))).toBe(false);
  });

  it('adopt() never takes over a live window\'s session, even when its tabId matches a local tab', () => {
    const adopted = useSessions.getState().adopt((x) => (x.tabId === 't_b' ? 't_b' : null));
    expect(adopted).toEqual([]);
    expect(useSessions.getState().byTab.t_b).toBeUndefined();
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, gone: info('gone', { orphan: true, tabId: 't_b' }) } });
    expect(useSessions.getState().adopt((x) => (x.tabId === 't_b' ? 't_b' : null))).toEqual(['gone']);
  });

  it('keeps its own sessions after a reload although the engine reports them live (same client id)', () => {
    // t_a owned "mine"; after a reload byTab is empty and the engine says orphan: false (this window is connected)
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, mine: info('mine', { tabId: 't_a', orphan: false }) }, byTab: {} });
    expect(isForeignSession(useSessions.getState().sessions.mine)).toBe(false);
    expect(useSessions.getState().adopt((x) => (x.tabId === 't_a' ? 't_a' : null))).toEqual(['mine']);
    // remembered per browser tab, so it survives the reload
    expect(JSON.parse(sessionStorage.getItem('dbstudio.ownSessions') ?? '[]')).toContain('mine');
  });

  it('SESSION_LIMIT releases only idle orphans; Close unused sessions ignores live windows', () => {
    expect(releasableOrphans('c_shop')).toEqual(['gone']);

    expect(isEnabled('sessions.closeOrphans')).toBe(true);
    useSessions.setState({ sessions: { live: info('live', { orphan: false }) }, byTab: {} });
    expect(isEnabled('sessions.closeOrphans')).toBe(false);
    expect(releasableOrphans('c_shop')).toEqual([]);
    // and no per-session command acts on it
    expect(isEnabled('sessions.disconnect', { sessionId: 'live' })).toBe(false);
  });

  it('disconnecting a connection leaves another window\'s sessions open', async () => {
    const n = await useSessions.getState().closeConnection('c_shop');
    expect(n).toBe(3);
    expect(Object.keys(useSessions.getState().sessions).sort()).toEqual(['live', 'liveTx']);
  });

  it('the boot toast counts only orphans', async () => {
    const live = mock.ctx.engine.createSession('c_shop', null, 'auto')!;
    useSessions.setState({ sessions: {}, byTab: {} });
    // the mock engine does not report `orphan`; mark its session live in another window once listed
    const orig = useSessions.getState().refreshAll;
    useSessions.setState({
      refreshAll: async () => {
        await orig();
        const s = useSessions.getState().sessions;
        useSessions.setState({ sessions: { ...s, [live.sessionId]: { ...s[live.sessionId], orphan: false }, extra: info('extra', { orphan: true }) } });
      },
    });
    try {
      await reattachSessions(true);
    } finally {
      useSessions.setState({ refreshAll: orig });
    }
    const t = useUi.getState().toasts.find((x) => /unused session/.test(x.text));
    expect(t?.text).toMatch(/^1 unused session /);
  });

  it('the Connections panel lists another window\'s sessions read-only', () => {

    render(createElement(ConnectionsPanel));
    const unused = screen.getByRole('region', { name: 'Unused sessions' });
    expect(within(unused).getByText('Old console')).toBeInTheDocument();
    expect(within(unused).queryByText('Live window console')).not.toBeInTheDocument();
    const foreign = screen.getByRole('region', { name: 'In use by another window' });
    expect(within(foreign).getByText('Live window console')).toBeInTheDocument();
    expect(within(foreign).queryAllByRole('button')).toEqual([]);
    // the header counts this window's sessions only (logic-r2-01): mine + 2 unused, not the 2 of the other window
    expect(document.querySelector('.connections-panel .panel-count')).toHaveTextContent('1 · 3 sessions');
  });
});

// logic-r2-01: one rule for "this window is connected": another window's sessions never count here (status bar,
// dock badge, explorer dot); the Connections panel lists them apart.
describe('connected indicators leave out other windows (logic-r2-01)', () => {
  beforeEach(() => {
    resetOwnSessionsForTests();
    useSessions.setState({ sessions: { live: info('live', { orphan: false }), liveTx: info('liveTx', { orphan: false, txOpen: true }) }, byTab: {} });
  });

  it('a connection used only by another window is not connected in this one', () => {
    const { sessions } = useSessions.getState();
    expect(connectionActivity('c_shop', sessions, () => undefined)).toBeNull();
    expect(connectionActivity('c_shop', sessions, () => 'ready')).toEqual({ kind: 'catalog' });
    expect(activityCounts(sessions, {})).toEqual({ connections: 0, sessions: 0 });
  });

  it('counts this window\'s own and unused sessions', () => {
    useSessions.getState().upsert(info('mine', { tabId: 't_a' }), 't_a');
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, gone: info('gone', { orphan: true, connectionId: 'c_prod' }) } });
    const { sessions } = useSessions.getState();
    expect(connectionActivity('c_shop', sessions, () => undefined)).toEqual({ kind: 'session', sessions: 1 });
    expect(activityCounts(sessions, { c_ora: { status: 'ready' } })).toEqual({ connections: 3, sessions: 2 });
  });
});

// Cross-batch contract (B3): lastTxEnd records every transaction this window ends.
describe('lastTxEnd', () => {
  beforeEach(async () => {
    mock.ctx.engine.sessions.clear();
    resetOwnSessionsForTests();
    await useConnections.getState().load();
    useSessions.setState({ sessions: {}, byTab: {}, lastTxEnd: null });
  });

  async function manualSession(tabId: string): Promise<SessionInfo> {
    const s = await useSessions.getState().ensure(tabId, 'c_shop', null, 'manual');
    // as if a statement had opened a transaction
    useSessions.setState({ sessions: { ...useSessions.getState().sessions, [s.sessionId]: { ...s, txOpen: true } } });
    return s;
  }

  it('is set by Commit and Roll back, with an increasing seq', async () => {
    const s = await manualSession('t_a');
    await useSessions.getState().commit('t_a');
    const first = useSessions.getState().lastTxEnd!;
    expect(first).toMatchObject({ sessionId: s.sessionId, kind: 'commit' });
    await useSessions.getState().rollback('t_a');
    const second = useSessions.getState().lastTxEnd!;
    expect(second).toMatchObject({ sessionId: s.sessionId, kind: 'rollback' });
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  it('closing a session with an open transaction records a rollback; one without does not', async () => {
    const s = await manualSession('t_a');
    await useSessions.getState().close('t_a', true);
    expect(useSessions.getState().lastTxEnd).toMatchObject({ sessionId: s.sessionId, kind: 'rollback' });

    const before = useSessions.getState().lastTxEnd;
    const idle = await useSessions.getState().ensure('t_b', 'c_shop', null, 'manual');
    await useSessions.getState().closeSession(idle.sessionId, true);
    expect(useSessions.getState().lastTxEnd).toBe(before);

    const viaDisconnect = await manualSession('t_b');
    await useSessions.getState().closeConnection('c_shop', true);
    expect(useSessions.getState().lastTxEnd).toMatchObject({ sessionId: viaDisconnect.sessionId, kind: 'rollback' });
  });

  it('another window\'s transaction is never recorded (Disconnect leaves it open)', async () => {
    useSessions.setState({ sessions: { liveTx: info('liveTx', { orphan: false, txOpen: true }) } });
    await useSessions.getState().closeConnection('c_shop', true);
    expect(useSessions.getState().lastTxEnd).toBeNull();
  });
});
