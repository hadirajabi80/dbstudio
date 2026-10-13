import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../api/ws';
import { FakeSocket } from '../mocks/fakeSocket';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { isRunning } from '../store/resultsReducer';
import { useSessions } from '../store/sessions';
import { useTabs } from '../store/tabs';
import { useUi } from '../store/ui';
import { TEST_ENGINE_URL, useMockEngine } from '../test/mockServer';
import { cancelTab, commitTab, runInTab, setTxMode } from './actions';
import { wireSocket } from './boot';

const mock = useMockEngine({ frameDelay: 0, frameRows: 500 });

async function until(pred: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
    useResults.getState().flush();
  }
}

const execOf = (tabId: string) => useResults.getState().executions[useResults.getState().byTab[tabId]];

describe('run pipeline (REST + WS + stores) against the mock engine', () => {
  beforeAll(async () => {
    wireSocket();
    engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
    engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
    await until(() => engineSocket.status === 'open');
  });

  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0 });
    useSessions.setState({ sessions: {}, byTab: {} });
    await useConnections.getState().load();
  });

  it('streams a 150k-row result into chunked storage, honouring maxRows = unlimited', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    await runInTab(tab, 'statement', [{ sql: 'SELECT * FROM events', line: 1, col: 1 }], { maxRows: 0 });
    await until(() => execOf(tab)?.status === 'ok', 20000);
    const e = execOf(tab);
    expect(e.resultSets).toHaveLength(1);
    expect(e.resultSets[0].rows.length).toBe(150_000);
    expect(e.resultSets[0].truncated).toBe(false);
    expect(useResults.getState().activeView[tab]).toBe(0);
  });

  it('marks truncation at maxRows and keeps sessions per tab and per connection', async () => {
    const a = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    const b = useTabs.getState().newConsole({ connectionId: 'c_prod' });
    await Promise.all([
      runInTab(a, 'statement', [{ sql: 'SELECT * FROM orders', line: 1, col: 1 }], { maxRows: 1000 }),
      runInTab(b, 'statement', [{ sql: 'SELECT TOP 10 * FROM dbo.customers', line: 1, col: 1 }]),
    ]);
    await until(() => !isRunning(execOf(a)) && !isRunning(execOf(b)));
    expect(execOf(a).resultSets[0].rows.length).toBe(1000);
    expect(execOf(a).resultSets[0].truncated).toBe(true);
    expect(execOf(b).resultSets[0].rows.length).toBe(10);
    const sa = useSessions.getState().forTab(a)!;
    const sb = useSessions.getState().forTab(b)!;
    expect(sa.sessionId).not.toBe(sb.sessionId);
    expect(sa.connectionId).toBe('c_shop');
    expect(sb.connectionId).toBe('c_prod');
  });

  it('reports errors with document lines and multiple result sets per script', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    await runInTab(tab, 'script', [
      { sql: 'SELECT * FROM countries', line: 1, col: 1 },
      { sql: 'SELECT id, name FROM products LIMIT 5', line: 3, col: 1 },
      { sql: 'SELECT * FROM nope', line: 5, col: 1 },
    ]);
    await until(() => !isRunning(execOf(tab)));
    const e = execOf(tab);
    expect(e.status).toBe('error');
    expect(e.resultSets.map((r) => r.rows.length)).toEqual([20, 5]);
    expect(e.resultSets[1].columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(e.messages.find((m) => m.severity === 'error')).toMatchObject({ text: 'no such table: nope', line: 5 });
  });

  it('asks before running a destructive statement and sends confirmedDestructive', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    const p = runInTab(tab, 'statement', [{ sql: 'DELETE FROM orders', line: 1, col: 1 }]);
    await until(() => !!useUi.getState().confirm);
    expect(useUi.getState().confirm!.items).toEqual(['Line 1: DELETE without WHERE on orders']);
    useUi.getState().resolveConfirm(true);
    await p;
    await until(() => execOf(tab)?.status === 'ok');
    expect(execOf(tab).confirmedDestructive).toBe(true);
    expect(execOf(tab).rowsAffected).toBe(5000);
  });

  it('does nothing when the destructive confirmation is declined', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    const p = runInTab(tab, 'statement', [{ sql: 'DROP TABLE orders', line: 1, col: 1 }]);
    await until(() => !!useUi.getState().confirm);
    useUi.getState().resolveConfirm(false);
    await p;
    expect(execOf(tab)).toBeUndefined();
    expect(mock.hits('/execute', 'POST')).toHaveLength(0);
  });

  it('tracks manual transactions: pending after DML, cleared by commit', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    await runInTab(tab, 'statement', [{ sql: 'SELECT 1', line: 1, col: 1 }]);
    await until(() => execOf(tab)?.status === 'ok');
    await setTxMode(tab, 'manual');
    await runInTab(tab, 'statement', [{ sql: "UPDATE customers SET name = 'x' WHERE id = 1", line: 1, col: 1 }]);
    await until(() => execOf(tab)?.status === 'ok' && !!useSessions.getState().forTab(tab)?.txOpen);
    expect(useSessions.getState().forTab(tab)?.txMode).toBe('manual');
    await commitTab(tab);
    expect(useSessions.getState().forTab(tab)?.txOpen).toBe(false);
  });

  it('cancels a running query', async () => {
    const tab = useTabs.getState().newConsole({ connectionId: 'c_shop' });
    await runInTab(tab, 'statement', [{ sql: 'SELECT sleep(10)', line: 1, col: 1 }]);
    await until(() => execOf(tab)?.status === 'running' && !!useSessions.getState().forTab(tab));
    await cancelTab(tab);
    await until(() => execOf(tab)?.status === 'cancelled');
    expect(execOf(tab).messages.some((m) => /cancelled/i.test(m.text))).toBe(true);
  });
});
