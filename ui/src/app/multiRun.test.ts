// A6: run the same statement on two SQLite connections concurrently; results grouped by connection.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../api/ws';
import { FakeSocket } from '../mocks/fakeSocket';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { useTabs, type ViewTab } from '../store/tabs';
import { TEST_ENGINE_URL, useMockEngine } from '../test/mockServer';
import { wireSocket } from './boot';
import { disposeMulti, MULTIRUN_VIEW, runMulti, targetTabId, type MultiRunState } from './multiRun';

const mock = useMockEngine({ frameDelay: 0, frameRows: 500 });

async function until(pred: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
    useResults.getState().flush();
  }
}

describe('multi-connection run', () => {
  beforeAll(async () => {
    wireSocket();
    engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
    engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
    await until(() => engineSocket.status === 'open');
  });

  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useSessions.setState({ sessions: {}, byTab: {} });
    if (!mock.ctx.engine.connections.some((c) => c.name === 'Shop copy')) {
      mock.ctx.engine.createConnection({ name: 'Shop copy', providerId: 'sqlite', color: null, folder: null, readOnly: false, props: { path: 'C:\\data\\shop2.db' }, savePassword: false, password: null });
    }
    await useConnections.getState().load();
  });

  it('runs on both connections, each with its own session, grouped in one tab', async () => {
    const copy = useConnections.getState().connections.find((c) => c.name === 'Shop copy')!;
    const id = await runMulti({
      sourceTabId: null, title: 'orders', label: 'statement', batches: [{ sql: 'SELECT * FROM orders', line: 1, col: 1 }],
      targets: [{ connectionId: 'c_shop', database: null }, { connectionId: copy.id, database: null }],
    });
    expect(id).toBeTruthy();
    const tab = useTabs.getState().tabs.find((t) => t.id === id) as ViewTab;
    expect(tab.view).toBe(MULTIRUN_VIEW);
    const state = tab.state as MultiRunState;
    expect(state.targets.map((t) => t.connectionId)).toEqual(['c_shop', copy.id]);

    const execOf = (cid: string) => useResults.getState().executions[useResults.getState().byTab[targetTabId(id!, cid)]];
    await until(() => !!execOf('c_shop') && !!execOf(copy.id) && !isRunning(execOf('c_shop')) && !isRunning(execOf(copy.id)));
    expect(execOf('c_shop').status).toBe('ok');
    expect(execOf(copy.id).status).toBe('ok');
    expect(execOf('c_shop').resultSets[0].rowCount).toBeGreaterThan(0);

    const s1 = useSessions.getState().forTab(targetTabId(id!, 'c_shop'));
    const s2 = useSessions.getState().forTab(targetTabId(id!, copy.id));
    expect(s1 && s2 && s1.sessionId !== s2.sessionId).toBe(true);
    expect(s1!.connectionId).toBe('c_shop');
    expect(s2!.connectionId).toBe(copy.id);

    // History gets one entry per connection, labelled "multi".
    await until(() => mock.ctx.engine.history.filter((x) => x.label === 'multi').length >= 2);

    disposeMulti(tab);
    await until(() => !useSessions.getState().forTab(targetTabId(id!, 'c_shop')));
  });
});
