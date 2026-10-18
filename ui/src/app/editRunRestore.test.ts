// features-01 regression path: the F4 "Edit:" registration is persisted in the console tab, so a tab restored with
// the workspace (the in-memory designer store is empty after a reload) still applies a SQLite trigger/view edit
// atomically through POST /designer/apply, still offers "Compare with server", and its Stop button explains why the
// apply cannot be cancelled (features-r1-06).
import { beforeEach, describe, expect, it } from 'vitest';
import { activeEditSession, peekEditSession, restorePersistedEdits } from '../designer/editSession';
import { openEditScript } from '../designer/open';
import { EDIT_RUN_STOP_REASON, useDesignerUi } from '../designer/store';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useTabs, type ConsoleTab, type WorkspaceData } from '../store/tabs';
import { useUi } from '../store/ui';
import { installMockEngine } from '../test/mockServer';
import { cancelBlockedReason, cancelTab, runInTab } from './actions';

const mock = installMockEngine({ frameDelay: 0 });

const ref = { database: null, schema: 'main', name: 'trg_orders_audit', type: 'trigger' as const };

/** Opens the trigger with F4 → "Edit:" console, then simulates a reload: workspace round trip, empty designer store. */
async function editTabAfterReload(): Promise<string> {
  const id = await openEditScript('c_shop', null, ref);
  expect(id).toBeTruthy();
  const saved = JSON.parse(JSON.stringify(useTabs.getState().serialize())) as WorkspaceData;
  useDesignerUi.setState({ edits: {}, editRunInFlight: {}, compareTabId: null });
  useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
  useTabs.getState().restore(saved);
  return id!;
}

function consoleTab(id: string): ConsoleTab {
  const t = useTabs.getState().tabs.find((x) => x.id === id);
  if (t?.kind !== 'console') throw new Error('not a console');
  return t;
}

describe('restored "Edit:" consoles (features-01)', () => {
  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ confirm: null, toasts: [] });
    useDesignerUi.setState({ edits: {}, editRunInFlight: {}, compareTabId: null });
    await useConnections.getState().load();
  });

  it('persists the edit registration in the tab', async () => {
    const id = await openEditScript('c_shop', null, ref);
    const t = consoleTab(id!);
    expect(t.edit).toMatchObject({ connectionId: 'c_shop', database: null, ref, dialect: 'sqlite' });
    expect(t.edit?.serverDdl).toMatch(/^CREATE TRIGGER trg_orders_audit/);
    expect(useDesignerUi.getState().edits[id!]).toEqual(t.edit);
  });

  it('F5 with a broken CREATE after a reload: one transactional apply, nothing executed, the trigger is kept', async () => {
    const applies: { statements: string[]; transactional: boolean }[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && request.url.endsWith('/designer/apply')) void request.clone().json().then((b) => applies.push(b as never));
    };
    mock.server.events.on('request:start', listener);
    try {
      const id = await editTabAfterReload();
      expect(useDesignerUi.getState().edits[id]).toBeUndefined(); // the in-memory registration is gone
      const broken = consoleTab(id).text.replace(/\bBEGIN\b/, 'BEGINX');
      expect(broken).toMatch(/^DROP TRIGGER IF EXISTS/);
      useTabs.getState().updateText(id, broken);

      await runInTab(id, 'script', [{ sql: broken, line: 1, col: 1 }]);

      expect(applies).toHaveLength(1);
      expect(applies[0].transactional).toBe(true);
      expect(applies[0].statements[0]).toMatch(/^DROP TRIGGER IF EXISTS/);
      expect(mock.hits('/execute', 'POST')).toHaveLength(0);
      // no "Run destructive statement?" dialog: the atomic path was taken
      expect(useUi.getState().confirm).toBeNull();
      const exec = useResults.getState().executions[useResults.getState().byTab[id]];
      expect(exec.status).toBe('error');
      expect(exec.messages.map((m) => m.text).join('\n')).toContain('keeps its previous definition');
      // re-registered on the way, so Compare is offered again
      expect(useDesignerUi.getState().edits[id]).toMatchObject({ connectionId: 'c_shop', ref });
    } finally {
      mock.server.events.removeListener('request:start', listener);
    }
  });

  it('restorePersistedEdits re-registers every restored edit tab (the Compare button reads the store)', async () => {
    const id = await editTabAfterReload();
    const plain = useTabs.getState().newConsole({ connectionId: 'c_shop', text: 'SELECT 1' });
    useTabs.getState().activate(id);
    expect(activeEditSession()).toMatchObject({ ref }); // the command `when` sees it without side effects
    expect(useDesignerUi.getState().edits[id]).toBeUndefined();
    restorePersistedEdits();
    expect(useDesignerUi.getState().edits[id]).toMatchObject({ connectionId: 'c_shop', ref, dialect: 'sqlite' });
    expect(useDesignerUi.getState().edits[plain]).toBeUndefined();
    expect(peekEditSession(plain)).toBeUndefined();
  });

  it('Stop is blocked with a reason while the atomic apply is in flight, and works again afterwards', async () => {
    const id = await editTabAfterReload();
    const run = runInTab(id, 'script', [{ sql: consoleTab(id).text, line: 1, col: 1 }]);
    expect(useDesignerUi.getState().editRunInFlight[id]).toBe(true);
    expect(cancelBlockedReason(id)).toBe(EDIT_RUN_STOP_REASON);
    expect(await cancelTab(id)).toBe(EDIT_RUN_STOP_REASON);
    expect(mock.hits('/cancel', 'POST')).toHaveLength(0);
    await run;
    expect(useDesignerUi.getState().editRunInFlight[id]).toBeUndefined();
    expect(cancelBlockedReason(id)).toBeNull();
    // the result text of the apply is unchanged
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec.status).toBe('ok');
    expect(exec.messages.some((m) => /in one transaction/.test(m.text))).toBe(true);
  });
});
