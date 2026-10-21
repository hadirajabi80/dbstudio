// Ctrl+S in an F4 "Edit:" console saves the object to the database (SSMS / Navicat / DataGrip), not to a .sql file.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initCommands } from '../commands';
import { runCommand } from '../commands/registry';
import { useDesignerUi } from '../designer/store';
import type { SqlEditorHandle } from '../editor/SqlEditor.types';
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

function fakeEditor(text: string): SqlEditorHandle {
  return {
    focus: () => undefined,
    insertText: () => undefined,
    revealLine: () => undefined,
    getValue: () => text,
    getRunTarget: () => ({ text, batches: [{ sql: text, line: 1, col: 1 }] }),
  };
}

function editTab(connectionId = 'c_shop'): string {
  const id = useTabs.getState().newConsole({ connectionId, text: SCRIPT, title: 'Edit: refresh_totals' });
  useDesignerUi.getState().registerEdit(id, { connectionId: 'c_shop', database: null, ref, serverDdl: SCRIPT, dialect: 'sqlite' });
  registerEditor(id, fakeEditor(SCRIPT));
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

  it('refuses when the console was pointed at another connection, and says how to save a file instead', async () => {
    const id = editTab();
    useTabs.getState().setConnection(id, 'c_other');

    await runCommand('file.save');

    expect(useResults.getState().byTab[id]).toBeUndefined();
    expect(useUi.getState().toasts.at(-1)?.detail ?? '').toMatch(/Save as/);
  });
});
