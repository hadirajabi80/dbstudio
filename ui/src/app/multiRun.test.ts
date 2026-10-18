// A6: run the same statement on two SQLite connections concurrently; results grouped by connection.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../api/ws';
import { FakeSocket } from '../mocks/fakeSocket';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { useParams } from '../store/params';
import { useSessions } from '../store/sessions';
import { useTabs, type ViewTab } from '../store/tabs';
import { useUi } from '../store/ui';
import { TEST_ENGINE_URL, installMockEngine } from '../test/mockServer';
import { wireSocket } from './boot';
import { disposeMulti, MULTIRUN_VIEW, runMulti, targetTabId, type MultiRunState } from './multiRun';

const mock = installMockEngine({ frameDelay: 0, frameRows: 500 });

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

  describe('read-only targets (logic-05)', () => {
    const executes: { url: string; body: { confirmedDestructive?: boolean; params?: unknown[] } }[] = [];
    beforeAll(() => {
      mock.server.events.on('request:start', ({ request }) => {
        if (request.method === 'POST' && request.url.endsWith('/execute')) {
          void request.clone().json().then((body) => executes.push({ url: request.url, body: body as never }));
        }
      });
    });
    beforeEach(() => {
      executes.length = 0;
      useUi.setState({ confirm: null });
      if (!mock.ctx.engine.connections.some((c) => c.name === 'RO copy')) {
        mock.ctx.engine.createConnection({ name: 'RO copy', providerId: 'sqlite', color: null, folder: null, readOnly: true, props: { path: 'C:\\data\\ro.db' }, savePassword: false, password: null });
      }
    });

    const ids = async () => {
      await useConnections.getState().load();
      return useConnections.getState().connections.find((c) => c.name === 'RO copy')!.id;
    };
    const execOf = (id: string, cid: string) => useResults.getState().executions[useResults.getState().byTab[targetTabId(id, cid)]];

    it('lists read-only targets as skipped and never sends confirmedDestructive to them', async () => {
      const ro = await ids();
      const p = runMulti({
        sourceTabId: null, title: 'del', label: 'statement', batches: [{ sql: 'DELETE FROM order_lines', line: 1, col: 1 }],
        targets: [{ connectionId: 'c_shop', database: null }, { connectionId: ro, database: null }],
      });
      await until(() => !!useUi.getState().confirm);
      const c = useUi.getState().confirm!;
      expect(c.items).toContain('Target: RO copy — skipped (read-only)');
      expect(c.ack?.label).toBe('Allow writes on read-only targets: RO copy');
      useUi.getState().resolveConfirm(true, false);
      const id = (await p)!;
      await until(() => !!execOf(id, ro) && !!execOf(id, 'c_shop') && !isRunning(execOf(id, 'c_shop')));
      expect(execOf(id, ro).status).toBe('error');
      expect(execOf(id, ro).messages.at(-1)!.text).toMatch(/read-only/);
      // Nothing was sent for the read-only target; the writable one carries the explicit confirmation.
      await until(() => executes.length >= 1);
      expect(executes).toHaveLength(1);
      expect(executes[0].body.confirmedDestructive).toBe(true);
      expect(useSessions.getState().forTab(targetTabId(id, ro))).toBeUndefined();
      disposeMulti(useTabs.getState().tabs.find((t) => t.id === id) as ViewTab);
    });

    it('writes to a read-only target only when the override box is ticked', async () => {
      const ro = await ids();
      const p = runMulti({
        sourceTabId: null, title: 'del', label: 'statement', batches: [{ sql: 'DELETE FROM order_lines', line: 1, col: 1 }],
        targets: [{ connectionId: ro, database: null }],
      });
      await until(() => !!useUi.getState().confirm);
      useUi.getState().resolveConfirm(true, true);
      const id = (await p)!;
      await until(() => executes.length >= 1);
      expect(executes[0].body.confirmedDestructive).toBe(true);
      await until(() => !!execOf(id, ro) && !isRunning(execOf(id, ro)));
      expect(execOf(id, ro).status).toBe('ok');
      disposeMulti(useTabs.getState().tabs.find((t) => t.id === id) as ViewTab);
    });

    it('lets the engine refuse non-destructive writes on read-only targets (no implicit flag)', async () => {
      const ro = await ids();
      const id = (await runMulti({
        sourceTabId: null, title: 'upd', label: 'statement', batches: [{ sql: 'UPDATE orders SET total = 1 WHERE id = 1', line: 1, col: 1 }],
        targets: [{ connectionId: ro, database: null }],
      }))!;
      expect(useUi.getState().confirm).toBeNull();
      await until(() => !!execOf(id, ro) && !isRunning(execOf(id, ro)));
      expect(execOf(id, ro).status).toBe('error');
      expect(executes[0].body.confirmedDestructive).toBeUndefined();
      disposeMulti(useTabs.getState().tabs.find((t) => t.id === id) as ViewTab);
    });

    it('asks for bind parameters once and sends them to every target', async () => {
      const copy = useConnections.getState().connections.find((c) => c.name === 'Shop copy')!;
      const p = runMulti({
        sourceTabId: null, title: 'p', label: 'statement', batches: [{ sql: 'SELECT * FROM orders WHERE id = :id', line: 1, col: 1 }],
        targets: [{ connectionId: 'c_shop', database: null }, { connectionId: copy.id, database: null }],
      });
      await until(() => !!useParams.getState().request);
      expect(useParams.getState().request!.rows.map((r) => r.name)).toEqual(['id']);
      useParams.getState().close([{ name: 'id', kind: 'int', value: 7 }]);
      const id = (await p)!;
      await until(() => executes.length >= 2);
      expect(executes.map((e) => e.body.params)).toEqual([[{ name: 'id', kind: 'int', value: 7 }], [{ name: 'id', kind: 'int', value: 7 }]]);
      expect(useParams.getState().request).toBeNull();
      disposeMulti(useTabs.getState().tabs.find((t) => t.id === id) as ViewTab);
    });
  });
});
