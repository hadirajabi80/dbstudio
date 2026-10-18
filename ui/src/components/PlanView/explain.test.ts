// logic-04 / logic-11 / design-02: Explain never sends confirmedDestructive implicitly, a read-only connection needs
// the armed override, SQLite "actual" is the estimated plan plus a normal run, and bind parameters are collected
// once and sent with the explain request.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineSocket } from '../../api/ws';
import { wireSocket } from '../../app/boot';
import { FakeSocket } from '../../mocks/fakeSocket';
import { useConnections } from '../../store/connections';
import { useParams } from '../../store/params';
import { useResults } from '../../store/results';
import { useSessions } from '../../store/sessions';
import { useTabs, type ViewTab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { TEST_ENGINE_URL, installMockEngine } from '../../test/mockServer';
import { explainInTab, isQueryStatement, PLAN_VIEW, type PlanTabState } from './explain';

const mock = installMockEngine({ frameDelay: 0, frameRows: 500 });

async function until(pred: () => boolean, ms = 8000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
    useResults.getState().flush();
  }
}

type Body = { mode?: string; confirmedDestructive?: boolean; params?: unknown[]; sql?: string };
const posts: { path: string; body: Body }[] = [];

function consoleOn(connectionId: string): string {
  return useTabs.getState().newConsole({ connectionId, text: '' });
}

const planTab = () => useTabs.getState().tabs.find((t) => t.kind === 'view' && t.view === PLAN_VIEW) as ViewTab | undefined;

describe('explain safety', () => {
  beforeAll(async () => {
    wireSocket();
    engineSocket.setSocketFactory(() => new FakeSocket(mock.ctx.engine, 'test-token'));
    engineSocket.connect({ baseUrl: TEST_ENGINE_URL, token: 'test-token' });
    await until(() => engineSocket.status === 'open');
    mock.server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && /\/(explain|execute)$/.test(path)) void request.clone().json().then((body) => posts.push({ path, body: body as Body }));
    });
  });

  beforeEach(async () => {
    posts.length = 0;
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ confirm: null });
    await useConnections.getState().load();
  });

  it('classifies WITH … DELETE as a change, not a query', () => {
    expect(isQueryStatement('WITH x AS (SELECT 1 AS id) DELETE FROM Products WHERE Id IN (SELECT id FROM x)', 'sqlite')).toBe(false);
    expect(isQueryStatement('WITH x AS (SELECT 1 AS id) SELECT * FROM x', 'sqlite')).toBe(true);
  });

  it('read-only connection: no implicit flag; the engine refuses and the override must be armed', async () => {
    const tabId = consoleOn('c_ora');
    const sql = 'DELETE FROM orders WHERE id = 1';
    const p = explainInTab({ tabId, dialect: 'plsql', mode: 'actual', batch: { sql, line: 1, col: 1 } });
    await until(() => !!useUi.getState().confirm);
    const c = useUi.getState().confirm!;
    // The first request went out without confirmedDestructive.
    expect(posts.filter((x) => x.path.endsWith('/explain')).map((x) => x.body.confirmedDestructive)).toEqual([undefined]);
    expect(c.title).toBe('Read-only connection');
    expect(c.ack?.required).toBe(true);
    expect(c.ack?.label).toMatch(/Allow this statement to write to “Oracle Shop”/);
    // Confirming without ticking the box does not write.
    useUi.getState().resolveConfirm(true, false);
    await p;
    expect(posts.filter((x) => x.path.endsWith('/explain'))).toHaveLength(1);
    expect((planTab()?.state as PlanTabState | undefined)?.status).toBe('error');
  });

  it('read-only connection: ticking the override sends one explicit confirmation', async () => {
    const tabId = consoleOn('c_ora');
    const p = explainInTab({ tabId, dialect: 'plsql', mode: 'actual', batch: { sql: 'DELETE FROM orders WHERE id = 1', line: 1, col: 1 } });
    await until(() => !!useUi.getState().confirm);
    useUi.getState().resolveConfirm(true, true);
    await p;
    await until(() => posts.filter((x) => x.path.endsWith('/explain')).length >= 2);
    expect(posts.filter((x) => x.path.endsWith('/explain')).map((x) => x.body.confirmedDestructive)).toEqual([undefined, true]);
  });

  it('SQLite actual = estimated plan + a normal run (the run keeps its own confirmations)', async () => {
    const tabId = consoleOn('c_shop');
    await explainInTab({ tabId, dialect: 'sqlite', mode: 'actual', batch: { sql: 'SELECT * FROM orders', line: 1, col: 1 } });
    await until(() => posts.some((x) => x.path.endsWith('/execute')));
    const explains = posts.filter((x) => x.path.endsWith('/explain'));
    expect(explains.map((x) => x.body.mode)).toEqual(['estimated']);
    expect(posts.find((x) => x.path.endsWith('/execute'))!.body.confirmedDestructive).toBeUndefined();
    await until(() => (planTab()?.state as PlanTabState | undefined)?.status === 'done');
  });

  it('collects bind parameters and sends them with the explain request', async () => {
    const tabId = consoleOn('c_prod');
    const p = explainInTab({ tabId, dialect: 'tsql', mode: 'estimated', batch: { sql: 'SELECT * FROM orders WHERE id = @id', line: 1, col: 1 } });
    await until(() => !!useParams.getState().request);
    const rows = useParams.getState().request!.rows;
    expect(rows).toHaveLength(1);
    useParams.getState().close([{ name: rows[0].name, kind: 'int', value: 7 }]);
    await p;
    await until(() => posts.some((x) => x.path.endsWith('/explain')));
    expect(posts.find((x) => x.path.endsWith('/explain'))!.body.params).toEqual([{ name: 'id', kind: 'int', value: 7 }]);
  });
});
