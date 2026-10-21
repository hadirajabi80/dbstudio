// Ctrl+S in an F4 "Edit:" console saves the object to the database (SSMS / Navicat / DataGrip), not to a .sql file.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommands } from '../commands';
import { runCommand } from '../commands/registry';
import { useDesignerUi } from '../designer/store';
import type { SqlEditorHandle } from '../editor/SqlEditor.types';
import { dbKey, useCatalog } from '../store/catalog';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useTabs } from '../store/tabs';
import { useUi } from '../store/ui';
import { engineSocket } from '../api/ws';
import { FakeSocket } from '../mocks/fakeSocket';
import { TEST_ENGINE_URL, installMockEngine } from '../test/mockServer';
import { wireSocket } from './boot';
import { registerEditor } from './editors';

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

const ref = { database: null, schema: 'main', name: 'refresh_totals', type: 'proc' as const };
const SCRIPT = 'SELECT 1';

/** A fake editor whose run target follows the real resolution: a selection wins unless `ignoreSelection`. */
function fakeEditor(text: string, selection?: string): SqlEditorHandle {
  return {
    focus: () => undefined,
    insertText: () => undefined,
    revealLine: () => undefined,
    getValue: () => text,
    getRunTarget: (label, opts) => (selection && !opts?.ignoreSelection
      ? { text: selection, batches: [{ sql: selection, line: 1, col: 1 }], label: 'selection' }
      : { text, batches: [{ sql: text, line: 1, col: 1 }], label }),
  };
}

function editTab(connectionId = 'c_shop', text = SCRIPT, selection?: string): string {
  const id = useTabs.getState().newConsole({ connectionId, text, title: 'Edit: refresh_totals' });
  useDesignerUi.getState().registerEdit(id, { connectionId: 'c_shop', database: null, ref, serverDdl: text, dialect: 'sqlite' });
  registerEditor(id, fakeEditor(text, selection));
  useTabs.getState().activate(id);
  return id;
}

describe('Ctrl+S (file.save) in an object edit console', () => {
  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ confirm: null, toasts: [] });
    await useConnections.getState().load();
  });

  it('runs the edit script on the database and confirms the save', async () => {
    const executes: string[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && /\/sessions\/[^/]+\/execute$/.test(request.url)) executes.push(request.url);
    };
    mock.server.events.on('request:start', listener);
    const id = editTab();

    await runCommand('file.save');

    await until(() => useUi.getState().toasts.some((t) => t.text === 'Saved procedure refresh_totals'));
    expect(executes).toHaveLength(1);
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec?.status).toBe('ok');
    mock.server.events.removeListener('request:start', listener);
  });

  it('saves the whole CREATE / ALTER even when a statement is selected (no need to deselect)', async () => {
    const whole = 'SELECT 1;\nSELECT 2';
    const sent: string[][] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && /\/sessions\/[^/]+\/execute$/.test(request.url)) {
        void request.clone().json().then((b: { batches: { sql: string }[] }) => sent.push(b.batches.map((x) => x.sql)));
      }
    };
    mock.server.events.on('request:start', listener);
    const id = editTab('c_shop', whole, 'SELECT 2');

    await runCommand('file.save');

    await until(() => useUi.getState().toasts.some((t) => t.text === 'Saved procedure refresh_totals') && sent.length > 0);
    expect(sent).toEqual([[whole]]);
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec?.label).toBe('script');
    mock.server.events.removeListener('request:start', listener);
  });

  it('revalidates only the object\'s schema after the save: no full refresh, and the explorer never sees "loading"', async () => {
    const cat = useCatalog.getState();
    await cat.loadDatabases('c_shop');
    await cat.ensureDefault('c_shop', 'main');
    await cat.loadSchemas('c_shop', 'main');
    expect(useCatalog.getState().dbs[dbKey('c_shop', 'main')]?.loaded.main).toBeDefined();
    const realRefresh = useCatalog.getState().refresh;
    const refresh = vi.fn(async () => undefined);
    useCatalog.setState({ refresh });
    const transitions: string[] = [];
    const unsub = useCatalog.subscribe((s) => {
      const d = s.dbs[dbKey('c_shop', 'main')];
      if (s.conns.c_shop?.status === 'loading') transitions.push('databases');
      if (d?.schemasStatus === 'loading') transitions.push('schemas');
      for (const [name, st] of Object.entries(d?.schemaStatus ?? {})) if (st === 'loading') transitions.push(name);
    });
    const refreshBodies: unknown[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && request.url.endsWith('/catalog/refresh')) void request.clone().json().then((b) => refreshBodies.push(b));
    };
    mock.server.events.on('request:start', listener);
    try {
      editTab();
      mock.ctx.requests.length = 0;
      await runCommand('file.save');
      await until(() => useUi.getState().toasts.some((t) => t.text === 'Saved procedure refresh_totals'));
      // the schema is fetched again (revalidated) …
      await until(() => mock.hits('/catalog').some((r) => r.url.searchParams.get('schemas') === 'main'));
      await until(() => !useCatalog.getState().dbs[dbKey('c_shop', 'main')]?.revalidating?.main);
      expect(refreshBodies).toEqual([{ database: 'main', schemas: ['main'] }]);
      // … without the full refresh (database list, every schema) and without a single 'loading' state
      expect(refresh).not.toHaveBeenCalled();
      expect(mock.hits('/catalog/databases')).toHaveLength(0);
      expect(transitions).toEqual([]);
      expect(useCatalog.getState().dbs[dbKey('c_shop', 'main')]?.schemaStatus.main).toBe('ready');
    } finally {
      unsub();
      useCatalog.setState({ refresh: realRefresh });
      mock.server.events.removeListener('request:start', listener);
    }
  });

  it('refuses when the console was pointed at another connection, and says how to save a file instead', async () => {
    const id = editTab();
    useTabs.getState().setConnection(id, 'c_other');

    await runCommand('file.save');

    expect(useResults.getState().byTab[id]).toBeUndefined();
    expect(useUi.getState().toasts.at(-1)?.detail ?? '').toMatch(/Save as/);
  });
});
