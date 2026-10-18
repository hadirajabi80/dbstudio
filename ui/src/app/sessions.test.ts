// logic-08 / logic-p2: after a reload, engine sessions are re-attached to their tabs by tabId; the rest are listed as
// unused (orphans), announced once, and offered for release when the session limit is reached.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnections } from '../store/connections';
import { activityCounts, connectionActivity, useSessions } from '../store/sessions';
import { useTabs, type ConsoleTab } from '../store/tabs';
import { useUi } from '../store/ui';
import { installMockEngine } from '../test/mockServer';
import { offerCloseIdle } from './actions';
import { reattachSessions, sessionTabKey } from './boot';

const mock = installMockEngine({ frameDelay: 0 });

function consoleTab(id: string, connectionId: string): ConsoleTab {
  return { kind: 'console', id, title: id, connectionId, database: null, text: '', savedText: '', filePath: null, txMode: 'auto', maxRows: null };
}

function engineSession(connectionId: string, tabId: string | null, txOpen = false) {
  const info = mock.ctx.engine.createSession(connectionId, null, txOpen ? 'manual' : 'auto')!;
  const s = mock.ctx.engine.sessions.get(info.sessionId)!;
  s.tabId = tabId;
  s.txOpen = txOpen;
  return info.sessionId;
}

describe('session re-attach after reload', () => {
  beforeEach(async () => {
    mock.ctx.engine.sessions.clear();
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ toasts: [] });
    await useConnections.getState().load();
    useTabs.setState({ tabs: [consoleTab('t_a', 'c_shop'), consoleTab('t_b', 'c_prod')], activeId: 't_a', mru: [], closed: [] });
  });

  it('adopts sessions whose tabId matches an open tab and lists the rest as orphans', async () => {
    const mine = engineSession('c_shop', 't_a', true);
    const gone = engineSession('c_shop', 't_closed');
    const wrongConn = engineSession('c_shop', 't_b'); // t_b is on another connection now
    await reattachSessions(true);
    const s = useSessions.getState();
    expect(s.byTab.t_a).toBe(mine);
    expect(s.byTab.t_b).toBeUndefined();
    expect(s.orphans().map((x) => x.sessionId).sort()).toEqual([gone, wrongConn].sort());
    // The adopted session's manual transaction is reflected on the tab.
    expect((useTabs.getState().tabs[0] as ConsoleTab).txMode).toBe('manual');
    // One-time toast that points to the Connections panel.
    const t = useUi.getState().toasts.find((x) => /unused session/.test(x.text));
    expect(t?.action?.label).toBe('Show');
    useUi.setState({ toasts: [] });
    await reattachSessions(true);
    expect(useUi.getState().toasts.some((x) => /unused session/.test(x.text))).toBe(false);
  });

  it('maps multi-run sessions to their target key', () => {
    useTabs.setState({
      tabs: [{ kind: 'view', id: 'v_m', title: 'Multi-run', view: 'multirun', connectionId: null, database: null, key: null,
        state: { targets: [{ connectionId: 'c_shop', database: null }], batches: [], label: 'statement', title: 'x', sourceTabId: null, active: null, startedAt: 0 } }],
    });
    expect(sessionTabKey({ sessionId: 's', connectionId: 'c_shop', tabId: 'v_m' } as never)).toBe('v_m::c_shop');
    expect(sessionTabKey({ sessionId: 's', connectionId: 'c_prod', tabId: 'v_m' } as never)).toBeNull();
  });

  it('SESSION_LIMIT offers to release unused sessions and runs again', async () => {
    const orphan = engineSession('c_shop', null);
    const txOrphan = engineSession('c_shop', null, true);
    await reattachSessions(false);
    const rerun = vi.fn();
    offerCloseIdle('c_shop', rerun);
    const t = useUi.getState().toasts.at(-1)!;
    expect(t.action?.label).toBe('Release 1 unused session and run again');
    t.action!.run();
    await vi.waitFor(() => expect(rerun).toHaveBeenCalledTimes(1));
    expect(mock.ctx.engine.sessions.has(orphan)).toBe(false);
    // An orphan with an open transaction is never released implicitly.
    expect(mock.ctx.engine.sessions.has(txOrphan)).toBe(true);
  });

  it('counts engine-wide sessions and one definition of "connected"', async () => {
    engineSession('c_shop', 't_a');
    engineSession('c_shop', null);
    await reattachSessions(false);
    const { sessions } = useSessions.getState();
    expect(activityCounts(sessions, { c_ora: { status: 'ready' } })).toEqual({ connections: 2, sessions: 2 });
    expect(connectionActivity('c_shop', sessions, () => undefined)).toEqual({ kind: 'session', sessions: 2 });
    expect(connectionActivity('c_ora', sessions, () => 'ready')).toEqual({ kind: 'catalog' });
    expect(connectionActivity('c_prod', sessions, () => 'loading')).toBeNull();
  });
});
